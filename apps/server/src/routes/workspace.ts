/**
 * 路由职责：以可信会话归属提供云图读取和版本写入；预期账号头只防止换号迟到请求串存。
 * 失败边界：同源、请求协议、会话和预期账号均校验；错误固定脱敏，失败不截断图或历史。
 */
import { constants as bufferConstants } from "node:buffer";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CLOUD_ACCOUNT_HEADER, CloudGraphWriteRequestSchema, CloudGraphWriteResponseSchema,
  CloudWorkspaceErrorResponseSchema, CloudWorkspaceResponseSchema, UserIdSchema,
} from "@wayfinder/contracts";

import type { AccountAuth, AccountIdentity } from "../accounts/auth.js";
import { databaseOperation, type DatabaseOperation } from "../accounts/database.js";
import { WorkspaceAccessError, type WorkspaceStorage } from "../accounts/workspace-storage.js";
import { isSameOriginRequest } from "../settings/request-origin.js";
import { accountRequestHeaders } from "./account.js";

export function registerWorkspaceRoutes(server: FastifyInstance, options: Readonly<{
  auth: Pick<AccountAuth, "getIdentity"> | null; storage: WorkspaceStorage | null; publicOrigin: string | null;
}>): void {
  void server.register(async routes => {
    const admitted = new WeakMap<FastifyRequest, AccountIdentity>();
    const expectedAccount = (request: FastifyRequest): string => {
      const expected = UserIdSchema.safeParse(request.headers[CLOUD_ACCOUNT_HEADER]);
      const duplicates = request.raw.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === CLOUD_ACCOUNT_HEADER).length;
      if (!expected.success || duplicates > 1) throw new WorkspaceAccessError("WORKSPACE_INVALID");
      return expected.data;
    };
    const withOperation = async <T>(request: FastifyRequest, reply: FastifyReply,
      action: (operation: DatabaseOperation) => Promise<T>): Promise<T> => {
      const controller = new AbortController(), operation = databaseOperation(controller.signal);
      const abort = (): void => controller.abort();
      const disconnected = (): void => { if (!reply.raw.writableFinished) abort(); };
      request.raw.once("aborted", abort); reply.raw.once("close", disconnected);
      try { return await action(operation); }
      finally { request.raw.removeListener("aborted", abort); reply.raw.removeListener("close", disconnected); }
    };
    // 仅此封装域取消框架默认1MiB额度；上界来自Node物理Buffer能力，不另设产品字节额度。
    // 先接收Buffer，再在受控try内转换字符串，避免底层字符串物理上界异常逃出解析器。
    const jsonParser = routes.getDefaultJsonParser("error", "error");
    routes.removeContentTypeParser("application/json");
    routes.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: bufferConstants.MAX_LENGTH }, (request, body, done) => {
      try { jsonParser(request, body.toString("utf8"), done); }
      catch { done(new WorkspaceAccessError("WORKSPACE_INVALID")); }
    });
    routes.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!isSameOriginRequest(request, options.publicOrigin)) {
        return reply.code(403).send(CloudWorkspaceErrorResponseSchema.parse({ code: "WORKSPACE_INVALID" }));
      }
      // 身份预检先于JSON缓冲和解析，匿名或错账号请求不能借大正文消耗解析资源。
      if (options.auth === null) throw new WorkspaceAccessError("ACCOUNT_REQUIRED");
      const expected = expectedAccount(request);
      const identity = await withOperation(request, reply, operation => options.auth?.getIdentity(accountRequestHeaders(request), operation) ?? Promise.resolve(null));
      if (identity === null || identity.userId !== expected) throw new WorkspaceAccessError("ACCOUNT_REQUIRED");
      if (options.storage === null) throw new WorkspaceAccessError("WORKSPACE_UNAVAILABLE");
      admitted.set(request, identity);
    });
    routes.addHook("onResponse", async request => { admitted.delete(request); });
    routes.setErrorHandler((error, _request, reply) => {
      const status = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
      const code = error instanceof WorkspaceAccessError ? error.code
        : typeof status === "number" && status >= 400 && status < 500 ? "WORKSPACE_INVALID" : "WORKSPACE_UNAVAILABLE";
      const httpStatus = code === "ACCOUNT_REQUIRED" ? 401 : code === "WORKSPACE_CONFLICT" ? 409
        : code === "WORKSPACE_NOT_FOUND" ? 404 : code === "WORKSPACE_INVALID" ? 400 : 503;
      return reply.code(httpStatus).send(CloudWorkspaceErrorResponseSchema.parse({ code }));
    });

    const handle = async (request: FastifyRequest, reply: FastifyReply, write: boolean) => {
      if (options.auth === null) throw new WorkspaceAccessError("ACCOUNT_REQUIRED");
      const expected = expectedAccount(request), initial = admitted.get(request);
      if (options.storage === null) throw new WorkspaceAccessError("WORKSPACE_UNAVAILABLE");
      return withOperation(request, reply, async operation => {
        // 解析或上传期间退出、重登和换号后必须拒绝；预检结果不能替代写前的当前会话。
        const identity = await options.auth?.getIdentity(accountRequestHeaders(request), operation);
        if (identity === null || identity === undefined || initial === undefined || identity.userId !== expected
          || identity.userId !== initial.userId || identity.sessionId !== initial.sessionId) throw new WorkspaceAccessError("ACCOUNT_REQUIRED");
        if (options.storage === null) throw new WorkspaceAccessError("WORKSPACE_UNAVAILABLE");
        if (!write) return reply.send(CloudWorkspaceResponseSchema.parse(await options.storage.read(identity.userId, operation)));
        const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
        if (contentType !== "application/json") throw new WorkspaceAccessError("WORKSPACE_INVALID");
        const input = CloudGraphWriteRequestSchema.safeParse(request.body);
        if (!input.success) throw new WorkspaceAccessError("WORKSPACE_INVALID");
        return reply.send(CloudGraphWriteResponseSchema.parse(await options.storage.write(identity.userId, input.data, operation)));
      });
    };
    routes.get("/api/workspace", async (request, reply) => handle(request, reply, false));
    routes.post("/api/workspace", { bodyLimit: bufferConstants.MAX_LENGTH }, async (request, reply) => handle(request, reply, true));
  });
}
