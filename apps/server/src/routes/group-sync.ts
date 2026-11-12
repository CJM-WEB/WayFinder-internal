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
      reply.hijack();
      reply.raw.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store",
        "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
      reply.raw.flushHeaders();
      const emit = (event: GroupSyncEvent, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true; clearTimeout(timer); reply.raw.removeListener("close", disconnected); signal.removeEventListener("abort", cancelled);
          if (error === undefined) resolve(); else reject(error);
        };
        const disconnected = (): void => finish(new GroupAccessError("GROUP_OFFLINE"));
        const cancelled = (): void => {
          // 数据帧已排入缓冲时无法撤回；失效立即终止剩余正文，不能等缓冲排空才停推送。
          if (!reply.raw.destroyed) reply.raw.destroy();
          disconnected();
        };
        const timer = setTimeout(cancelled, 5_000);
        reply.raw.once("close", disconnected);
        const terminal = event.type === "renew" || event.type === "revoked";
        if (!terminal) signal.addEventListener("abort", cancelled, { once: true });
        if (signal.aborted && !terminal) { cancelled(); return; }
        if (reply.raw.destroyed || reply.raw.writableEnded) { disconnected(); return; }
        try { reply.raw.write(`${JSON.stringify(event)}\n`, error => finish(error ?? undefined)); }
        catch { disconnected(); }
      });
      try { await subscription.run(emit); }
      catch { if (!reply.raw.destroyed) reply.raw.destroy(); }
      finally { subscription.close(); if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end(); }
      return reply;
    }));
  });
}
