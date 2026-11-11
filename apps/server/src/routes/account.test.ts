/** 账号路由使用假认证接缝验证同源、输入、公共投影和固定错误，无数据库或发信副作用。 */
import { describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";
import { buildServer } from "../app.js";
import { AccountAccessError, type AccountAuth } from "../accounts/auth.js";
import { registerAccountRoutes } from "./account.js";

const origin = "https://accounts.example";
const identity = { userId: "user_a", sessionId: "private-session", email: "fixture@example.com" };
function fixtureAuth(): AccountAuth {
  return { initialize: async () => {}, migrate: async () => {}, getIdentity: async () => identity,
    handle: async () => ({ body: { accepted: true }, cookies: [] }) };
}

describe("账号同源路由", () => {
  it("请求体收完后断开响应连接仍中止正在执行的认证操作", async () => {
    let markEntered!: () => void, markCancelled!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const cancelled = new Promise<void>(resolve => { markCancelled = resolve; });
    const auth = fixtureAuth(), server = buildServer();
    registerAccountRoutes(server, { publicOrigin: null, auth: { ...auth, handle: async (_input, _headers, operation) => {
      markEntered();
      return new Promise((_, reject) => operation.signal.addEventListener("abort", () => {
        markCancelled(); reject(new Error("fixture cancelled"));
      }, { once: true }));
    } } });
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    const client = httpRequest(`${origin}/api/account`, { method: "POST", headers: {
      origin, "content-type": "application/json",
    } });
    client.on("error", () => {});
    try {
      client.end(JSON.stringify({ action: "logout" }));
      await entered;
      client.destroy();
      await cancelled;
    } finally { client.destroy(); await server.close(); }
  });
  it("只返回账号投影，不泄漏内部会话；无配置时保留访客", async () => {
    const server = buildServer(); registerAccountRoutes(server, { auth: fixtureAuth(), publicOrigin: origin });
    try {
      const response = await server.inject({ url: "/api/account", headers: { host: "accounts.example" } });
      expect(response.json()).toEqual({ account: { userId: "user_a", email: identity.email } });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain(identity.sessionId);
      expect((await server.inject({ url: "/internal-account/get-session" })).statusCode).toBe(404);
    } finally { await server.close(); }
    const guest = buildServer(); registerAccountRoutes(guest, { auth: null, publicOrigin: origin });
    try { expect((await guest.inject({ url: "/api/account", headers: { host: "accounts.example" } })).json()).toEqual({ account: null }); }
    finally { await guest.close(); }
  });
  it("缺来源、跨源和额外身份字段均在认证前拒绝", async () => {
    const handle = vi.fn(fixtureAuth().handle);
    const server = buildServer(); registerAccountRoutes(server, { auth: { ...fixtureAuth(), handle }, publicOrigin: origin });
    try {
      for (const supplied of [undefined, "https://other.example"]) {
        expect((await server.inject({ method: "POST", url: "/api/account", headers: {
          host: "accounts.example", ...(supplied === undefined ? {} : { origin: supplied }),
        }, payload: { action: "logout" } })).statusCode).toBe(403);
      }
      expect((await server.inject({ method: "POST", url: "/api/account", headers: { host: "accounts.example", origin },
        payload: { action: "logout", userId: "other" } })).statusCode).toBe(400);
      expect(handle).not.toHaveBeenCalled();
      const malformed = await server.inject({ method: "POST", url: "/api/account", headers: {
        host: "accounts.example", origin, "content-type": "application/json",
      }, payload: "{" });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({ code: "ACCOUNT_INVALID" });
    } finally { await server.close(); }
  });
  it("Cookie分条转发，内部IP头由服务端覆盖；库错误不回显", async () => {
    const handle = vi.fn<AccountAuth["handle"]>(async (_action, headers) => {
      expect(headers.get("x-wayfinder-client-ip")).not.toBe("attacker");
      return { body: { accepted: true }, cookies: ["a=1; Secure; HttpOnly", "b=2; Secure; HttpOnly"] };
    });
    const server = buildServer(); registerAccountRoutes(server, { auth: { ...fixtureAuth(), handle }, publicOrigin: origin });
    const request = { method: "POST" as const, url: "/api/account", headers: { host: "accounts.example", origin,
      "x-wayfinder-client-ip": "attacker" }, payload: { action: "logout" } };
    try {
      expect((await server.inject(request)).headers["set-cookie"]).toEqual(["a=1; Secure; HttpOnly", "b=2; Secure; HttpOnly"]);
      handle.mockRejectedValueOnce(new Error("mysql://private:secret@host"));
      expect((await server.inject(request)).json()).toEqual({ code: "ACCOUNT_UNAVAILABLE" });
      handle.mockRejectedValueOnce(new AccountAccessError("ACCOUNT_RATE_LIMITED"));
      expect((await server.inject(request)).statusCode).toBe(429);
    } finally { await server.close(); }
  });
});
