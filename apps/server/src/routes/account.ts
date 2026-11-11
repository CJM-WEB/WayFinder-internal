/**
 * 路由职责：提供同源账号动作和最小当前账号投影；不公开认证库默认路由。
 * 失败边界：请求体、来源及取消先校验，错误只返回固定码，禁止缓存账号响应。
 */
import { AccountActionSchema, AccountErrorResponseSchema, AccountResponseSchema } from "@wayfinder/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { AccountAccessError, type AccountAuth } from "../accounts/auth.js";
import { databaseOperation } from "../accounts/database.js";
import { isSameOriginRequest } from "../settings/request-origin.js";

/** 只转交所需请求头；客户端伪造的内部 IP 头不会进入认证库限速键。 */
export function accountRequestHeaders(request: FastifyRequest): Headers {
  const headers = new Headers({ "content-type": "application/json", "x-wayfinder-client-ip": request.ip });
  if (typeof request.headers.cookie === "string") headers.set("cookie", request.headers.cookie);
  if (typeof request.headers.origin === "string") headers.set("origin", request.headers.origin);
  if (typeof request.headers["sec-fetch-site"] === "string") headers.set("sec-fetch-site", request.headers["sec-fetch-site"]);
  return headers;
}

export function registerAccountRoutes(server: FastifyInstance, options: Readonly<{
  auth: AccountAuth | null; publicOrigin: string | null;
}>): void {
  void server.register(async routes => {
    routes.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!isSameOriginRequest(request, options.publicOrigin)) {
        return reply.code(403).send(AccountErrorResponseSchema.parse({ code: "ACCOUNT_INVALID" }));
      }
    });
    routes.setErrorHandler((error, _request, reply) => {
      const status = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
      const code = error instanceof AccountAccessError ? error.code
        : typeof status === "number" && status >= 400 && status < 500 ? "ACCOUNT_INVALID" : "ACCOUNT_UNAVAILABLE";
      return reply.code(code === "ACCOUNT_RATE_LIMITED" ? 429 : code === "ACCOUNT_INVALID" ? 400 : 503)
        .send(AccountErrorResponseSchema.parse({ code }));
    });
    routes.get("/api/account", async (request, reply) => {
      if (options.auth === null) return reply.send(AccountResponseSchema.parse({ account: null }));
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      const disconnected = (): void => { if (!reply.raw.writableFinished) abort(); };
      request.raw.once("aborted", abort);
      reply.raw.once("close", disconnected);
      try {
        const identity = await options.auth.getIdentity(accountRequestHeaders(request), databaseOperation(controller.signal));
        return reply.send(AccountResponseSchema.parse({ account: identity === null ? null
          : { userId: identity.userId, email: identity.email } }));
      } finally { request.raw.removeListener("aborted", abort); reply.raw.removeListener("close", disconnected); }
    });
    routes.post("/api/account", { bodyLimit: 16 * 1024 }, async (request, reply) => {
      if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        return reply.code(415).send(AccountErrorResponseSchema.parse({ code: "ACCOUNT_INVALID" }));
      }
      const parsed = AccountActionSchema.safeParse(request.body);
      if (!parsed.success) throw new AccountAccessError("ACCOUNT_INVALID");
      if (options.auth === null) throw new AccountAccessError("ACCOUNT_UNAVAILABLE");
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      const disconnected = (): void => { if (!reply.raw.writableFinished) abort(); };
      request.raw.once("aborted", abort);
      reply.raw.once("close", disconnected);
      try {
        const result = await options.auth.handle(parsed.data, accountRequestHeaders(request), databaseOperation(controller.signal));
        if (result.cookies.length) reply.header("Set-Cookie", result.cookies);
        return reply.send(AccountResponseSchema.parse(result.body));
      } finally { request.raw.removeListener("aborted", abort); reply.raw.removeListener("close", disconnected); }
    });
  });
}
