/**
 * 模块职责：为昵称、小组及组图路由复用同源、预期账号、会话复核和取消边界。
 * 解析前检查身份，处理前复核同一会话；成员资格仍由具体事务按最新小组状态校验。
 * 仅在本注册域使用物理 Buffer 上界，避免框架默认正文额度暗中限制完整图和历史。
 */
import { constants as bufferConstants } from "node:buffer";
import { CLOUD_ACCOUNT_HEADER, GROUP_CONNECTION_HEADER, GroupErrorResponseSchema, UserIdSchema } from "@wayfinder/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";
import type { AccountAuth, AccountIdentity } from "../accounts/auth.js";
import { databaseOperation, type DatabaseOperation } from "../accounts/database.js";
import { GroupAccessError } from "../groups/errors.js";
import { isSameOriginRequest } from "../settings/request-origin.js";
import { accountRequestHeaders } from "./account.js";
import type { GroupSyncRuntime } from "../groups/sync.js";

type SessionOptions = Readonly<{ auth: Pick<AccountAuth, "getIdentity"> | null; publicOrigin: string | null }>;
type GroupRequestHandler = (request: FastifyRequest, reply: FastifyReply, identity: AccountIdentity, operation: DatabaseOperation) => Promise<unknown>;
type Guard = (handler: GroupRequestHandler) => RouteHandlerMethod;

/** 既有组写操作统一绑定已就绪实时连接；创建／加入尚无组连接是明确例外，收据只读也不需要。 */
export function authorizeGroupConnection(request: FastifyRequest, identity: AccountIdentity, groupId: string,
  operation: DatabaseOperation, sync: GroupSyncRuntime | null | undefined): DatabaseOperation {
  const connectionId = request.headers[GROUP_CONNECTION_HEADER];
  const duplicates = request.raw.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === GROUP_CONNECTION_HEADER).length;
  if (typeof connectionId !== "string" || duplicates > 1 || sync === null || sync === undefined) throw new GroupAccessError("GROUP_OFFLINE");
  return sync.authorize(identity, groupId, connectionId, operation);
}

/** 搜索prepare与组路由共用同一固定错误投影；不会把权限／版本拒绝改成无正文500。 */
export function sendGroupAccessError(reply: FastifyReply, error: GroupAccessError): FastifyReply {
  const code = error.code;
  reply.header("Cache-Control", "no-store");
  const status = code === "ACCOUNT_REQUIRED" ? 401 : code === "GROUP_FORBIDDEN" ? 403 : code === "GROUP_NOT_FOUND" ? 404
    : code === "GROUP_CONFLICT" || code === "GROUP_DEPENDENCY" || code === "GROUP_CONSTRAINT" ? 409
      : code === "GROUP_INVALID" || code === "NICKNAME_REQUIRED" ? 400 : 503;
  return reply.code(status).send(GroupErrorResponseSchema.parse({ code }));
}

export function registerGroupSessionRoutes(server: FastifyInstance, options: SessionOptions,
  setup: (routes: FastifyInstance, guard: Guard) => void): void {
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
    const parser = routes.getDefaultJsonParser("error", "error");
    routes.removeContentTypeParser("application/json");
    routes.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: bufferConstants.MAX_LENGTH }, (request, body, done) => {
      try { parser(request, body.toString("utf8"), done); }
      catch { done(new GroupAccessError("GROUP_INVALID")); }
    });
    routes.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!isSameOriginRequest(request, options.publicOrigin)) throw new GroupAccessError("GROUP_FORBIDDEN");
      if (options.auth === null) throw new GroupAccessError("ACCOUNT_REQUIRED");
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
      return sendGroupAccessError(reply, new GroupAccessError(code));
    });
    setup(routes, handler => async (request, reply) => withOperation(request, reply, async operation => {
      const initial = admitted.get(request);
      const identity = await options.auth?.getIdentity(accountRequestHeaders(request), operation);
      if (identity === null || identity === undefined || initial === undefined || identity.userId !== initial.userId
        || identity.sessionId !== initial.sessionId) throw new GroupAccessError("ACCOUNT_REQUIRED");
      return handler(request, reply, identity, operation);
    }));
  });
}
