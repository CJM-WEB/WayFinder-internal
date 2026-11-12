/**
 * 路由职责：复用既有会话和预期账号头，提供本人统一昵称的读取与修改。
 * 失败路径：解析前拒绝匿名／错号请求，写入前再次检查同一会话；取消与期限贯穿存储。
 */
import {
  AccountProfileActionSchema, AccountProfileResponseSchema, CLOUD_ACCOUNT_HEADER,
  GroupErrorResponseSchema, UserIdSchema,
} from "@wayfinder/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AccountAuth, AccountIdentity } from "../accounts/auth.js";
import type { AccountProfileStorage } from "../accounts/profile-storage.js";
import { databaseOperation, type DatabaseOperation } from "../accounts/database.js";
import { GroupAccessError } from "../groups/errors.js";
import { isSameOriginRequest } from "../settings/request-origin.js";
import { accountRequestHeaders } from "./account.js";

export function registerProfileRoutes(server: FastifyInstance, options: Readonly<{
  auth: Pick<AccountAuth, "getIdentity"> | null; storage: AccountProfileStorage | null; publicOrigin: string | null;
}>): void {
  void server.register(async routes => {
    const admitted = new WeakMap<FastifyRequest, AccountIdentity>();
    const withOperation = async <T>(request: FastifyRequest, reply: FastifyReply, action: (operation: DatabaseOperation) => Promise<T>): Promise<T> => {
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      const disconnected = (): void => { if (!reply.raw.writableFinished) abort(); };
      request.raw.once("aborted", abort); reply.raw.once("close", disconnected);
      try { return await action(databaseOperation(controller.signal)); }
      finally { request.raw.removeListener("aborted", abort); reply.raw.removeListener("close", disconnected); }
    };
    routes.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!isSameOriginRequest(request, options.publicOrigin)) throw new GroupAccessError("GROUP_FORBIDDEN");
      const expected = UserIdSchema.safeParse(request.headers[CLOUD_ACCOUNT_HEADER]);
      const duplicates = request.raw.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === CLOUD_ACCOUNT_HEADER).length;
      if (!expected.success || duplicates > 1) throw new GroupAccessError("GROUP_INVALID");
      const identity = await withOperation(request, reply, operation => options.auth?.getIdentity(accountRequestHeaders(request), operation) ?? Promise.resolve(null));
      if (identity === null || identity.userId !== expected.data) throw new GroupAccessError("ACCOUNT_REQUIRED");
      admitted.set(request, identity);
    });
    routes.setErrorHandler((error, _request, reply) => {
      const status = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
      const code = error instanceof GroupAccessError ? error.code
        : typeof status === "number" && status >= 400 && status < 500 ? "GROUP_INVALID" : "GROUP_UNAVAILABLE";
      return reply.code(code === "ACCOUNT_REQUIRED" ? 401 : code === "GROUP_FORBIDDEN" ? 403 : code === "GROUP_INVALID" ? 400 : 503)
        .send(GroupErrorResponseSchema.parse({ code }));
    });
    const handle = async (request: FastifyRequest, reply: FastifyReply, write: boolean) => withOperation(request, reply, async operation => {
      const initial = admitted.get(request);
      const identity = await options.auth?.getIdentity(accountRequestHeaders(request), operation);
      if (identity === null || identity === undefined || initial === undefined || identity.userId !== initial.userId
        || identity.sessionId !== initial.sessionId) throw new GroupAccessError("ACCOUNT_REQUIRED");
      if (options.storage === null) throw new GroupAccessError("GROUP_UNAVAILABLE");
      if (!write) return reply.send(AccountProfileResponseSchema.parse({ profile: await options.storage.read(identity.userId, operation) }));
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new GroupAccessError("GROUP_INVALID");
      const input = AccountProfileActionSchema.safeParse(request.body);
      if (!input.success) throw new GroupAccessError("GROUP_INVALID");
      return reply.send(AccountProfileResponseSchema.parse({ profile: await options.storage.write(identity.userId, input.data.nickname, operation) }));
    });
    routes.get("/api/profile", async (request, reply) => handle(request, reply, false));
    routes.post("/api/profile", async (request, reply) => handle(request, reply, true));
  });
}
