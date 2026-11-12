/**
 * 路由职责：在已有同源／会话护栏内输出有限期NDJSON，初始权限失败仍返回普通JSON错误。
 * 网络边界：完整写入回调后才允许连接就绪；断线、写缓冲超时和服务关闭都会释放订阅。
 */
import { GroupWorkspaceQuerySchema, type GroupSyncEvent } from "@wayfinder/contracts";
import type { FastifyInstance } from "fastify";
import type { AccountAuth } from "../accounts/auth.js";
import { GroupAccessError } from "../groups/errors.js";
import type { GroupSyncRuntime } from "../groups/sync.js";
import { accountRequestHeaders } from "./account.js";
import { registerGroupSessionRoutes } from "./group-session.js";
import { acceptsGroupGzip, createGroupEventEncoder, finishGroupEncoding } from "./group-response-encoding.js";

export function registerGroupSyncRoutes(server: FastifyInstance, options: Readonly<{
  auth: Pick<AccountAuth, "getIdentity"> | null; sync: GroupSyncRuntime | null; publicOrigin: string | null;
}>): void {
  // Fastify等待活跃响应之前先取消长连接，不能等30秒租期结束才进入关闭数据库的钩子。
  server.addHook("preClose", async () => { options.sync?.close(); });
  registerGroupSessionRoutes(server, options, (routes, guard) => {
    routes.get("/api/group-sync", guard(async (request, reply, identity, operation) => {
      if (options.sync === null) throw new GroupAccessError("GROUP_UNAVAILABLE");
      const query = GroupWorkspaceQuerySchema.safeParse(request.query);
      if (!query.success) throw new GroupAccessError("GROUP_INVALID");
      const subscription = await options.sync.open(identity, accountRequestHeaders(request), query.data.groupId, operation.signal);
      const encoder = acceptsGroupGzip(request.headers["accept-encoding"]) ? createGroupEventEncoder() : null;
      let lastWriteDeadline = operation.deadline;
      const disconnectedEncoder = (): void => { encoder?.destroy(); };
      reply.raw.once("close", disconnectedEncoder);
      reply.hijack();
      reply.raw.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store",
        "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff", "Vary": "Accept-Encoding",
        ...(encoder === null ? {} : { "Content-Encoding": "gzip" }) });
      reply.raw.flushHeaders();
      const emit = (event: GroupSyncEvent, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
        lastWriteDeadline = Date.now() + 5_000;
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true; clearTimeout(timer); reply.raw.removeListener("close", disconnected); signal.removeEventListener("abort", cancelled);
          if (error === undefined) resolve(); else reject(error);
        };
        const disconnected = (): void => finish(new GroupAccessError("GROUP_OFFLINE"));
        const cancelled = (): void => {
          // 数据帧已排入缓冲时无法撤回；失效立即终止剩余正文，不能等缓冲排空才停推送。
          encoder?.destroy(new GroupAccessError("GROUP_OFFLINE"));
          if (!reply.raw.destroyed) reply.raw.destroy();
          disconnected();
        };
        const timer = setTimeout(cancelled, Math.max(0, lastWriteDeadline - Date.now()));
        reply.raw.once("close", disconnected);
        const terminal = event.type === "renew" || event.type === "revoked";
        if (!terminal) signal.addEventListener("abort", cancelled, { once: true });
        if (signal.aborted && !terminal) { cancelled(); return; }
        if (reply.raw.destroyed || reply.raw.writableEnded) { disconnected(); return; }
        try {
          const line = `${JSON.stringify(event)}\n`;
          const write = (body: string | Buffer): void => {
            if (settled || reply.raw.destroyed || reply.raw.writableEnded) { disconnected(); return; }
            if (Date.now() >= lastWriteDeadline) { cancelled(); return; }
            // flush只说明zlib已产出本事件；真正写回调完成前，不允许订阅将连接标记为ready。
            reply.raw.write(body, error => {
              if (Date.now() >= lastWriteDeadline) cancelled();
              else finish(error ?? undefined);
            });
          };
          if (encoder === null) write(line);
          else void encoder.encode(line).then(write).catch(() => cancelled());
        }
        catch { disconnected(); }
      });
      try { await subscription.run(emit); }
      catch { if (!reply.raw.destroyed) reply.raw.destroy(); }
      finally {
        subscription.close();
        try {
          // 正常结束补齐gzip尾部；取消或写入超时已经销毁流，不能补发迟到正文。
          if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end(encoder === null ? undefined
            : await finishGroupEncoding(encoder, { signal: operation.signal, deadline: lastWriteDeadline }));
        } catch { if (!reply.raw.destroyed) reply.raw.destroy(); }
        finally { reply.raw.removeListener("close", disconnectedEncoder); encoder?.destroy(); }
      }
      return reply;
    }));
  });
}
