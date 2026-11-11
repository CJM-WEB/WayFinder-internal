/**
 * 路由职责：云Key只接受当前会话归属及显式保存／删除，普通GET仅返回认证过的掩码状态。
 * 安全边界：同源及预期账号先于正文解析；上传后再查同一会话，错误只投影固定code/service。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AccountKeyActionSchema, AccountKeysErrorResponseSchema, AccountKeysResponseSchema, CLOUD_ACCOUNT_HEADER, UserIdSchema } from "@wayfinder/contracts";
import type { AccountAuth, AccountIdentity } from "../accounts/auth.js";
import { AccountKeyAccessError, type AccountKeyStorage } from "../accounts/key-storage.js";
import { databaseOperation, type DatabaseOperation } from "../accounts/database.js";
import { isSameOriginRequest } from "../settings/request-origin.js";
import { accountRequestHeaders } from "./account.js";

export function registerAccountKeyRoutes(server: FastifyInstance, options: Readonly<{
  auth: Pick<AccountAuth, "getIdentity"> | null; storage: AccountKeyStorage | null; publicOrigin: string | null;
}>): void {
  void server.register(async routes => {
    type Admission = { identity: AccountIdentity; operation: DatabaseOperation; dispose: () => void };
    const admitted = new WeakMap<FastifyRequest, Admission>();
    const dispose = (request: FastifyRequest): void => admitted.get(request)?.dispose();
    const expected = (request: FastifyRequest): string => {
      const result = UserIdSchema.safeParse(request.headers[CLOUD_ACCOUNT_HEADER]);
      const duplicates = request.raw.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === CLOUD_ACCOUNT_HEADER).length;
      if (!result.success || duplicates > 1) throw new AccountKeyAccessError("KEY_INVALID");
      return result.data;
    };
    routes.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!isSameOriginRequest(request, options.publicOrigin)) return reply.code(403).send(AccountKeysErrorResponseSchema.parse({ code: "KEY_INVALID" }));
      if (options.auth === null) throw new AccountKeyAccessError("ACCOUNT_REQUIRED");
      const owner = expected(request), controller = new AbortController(), operation = databaseOperation(controller.signal);
      const cleanup = (): void => { request.raw.removeListener("aborted", abort); reply.raw.removeListener("close", disconnected); admitted.delete(request); };
      const abort = (): void => { controller.abort(); cleanup(); };
      const disconnected = (): void => { if (!reply.raw.writableFinished) abort(); };
      request.raw.once("aborted", abort); reply.raw.once("close", disconnected);
      try {
        const identity = await options.auth.getIdentity(accountRequestHeaders(request), operation);
        controller.signal.throwIfAborted();
        if (identity === null || identity.userId !== owner) throw new AccountKeyAccessError("ACCOUNT_REQUIRED");
        if (options.storage === null) throw new AccountKeyAccessError("KEY_UNAVAILABLE");
        admitted.set(request, { identity, operation, dispose: cleanup });
      } catch (error: unknown) { cleanup(); throw error; }
    });
    routes.addHook("onResponse", async request => { dispose(request); });
    routes.setErrorHandler((error, request, reply) => {
      dispose(request);
      const status = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
      const failure = error instanceof AccountKeyAccessError ? error : new AccountKeyAccessError(typeof status === "number" && status >= 400 && status < 500 ? "KEY_INVALID" : "KEY_UNAVAILABLE");
      return reply.code(failure.code === "ACCOUNT_REQUIRED" ? 401 : failure.code === "KEY_CONFLICT" ? 409 : failure.code === "KEY_INVALID" ? 400 : 503)
        .send(AccountKeysErrorResponseSchema.parse({ code: failure.code, ...(failure.service === undefined ? {} : { service: failure.service }) }));
    });
    const handle = async (request: FastifyRequest, write: boolean) => {
      const admission = admitted.get(request);
      if (admission === undefined || options.auth === null) throw new AccountKeyAccessError("ACCOUNT_REQUIRED");
      if (options.storage === null) throw new AccountKeyAccessError("KEY_UNAVAILABLE");
      try {
        const identity = await options.auth.getIdentity(accountRequestHeaders(request), admission.operation);
        if (identity === null || identity.userId !== expected(request) || identity.userId !== admission.identity.userId || identity.sessionId !== admission.identity.sessionId) throw new AccountKeyAccessError("ACCOUNT_REQUIRED");
        if (!write) return AccountKeysResponseSchema.parse(await options.storage.read(identity.userId, admission.operation));
        if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new AccountKeyAccessError("KEY_INVALID");
        const input = AccountKeyActionSchema.safeParse(request.body);
        if (!input.success) throw new AccountKeyAccessError("KEY_INVALID");
        return AccountKeysResponseSchema.parse(await options.storage.write(identity.userId, input.data, admission.operation));
      } finally { dispose(request); }
    };
    routes.get("/api/account/keys", async request => handle(request, false));
    routes.post("/api/account/keys", async request => handle(request, true));
  });
}
