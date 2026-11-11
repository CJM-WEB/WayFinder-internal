/** 路由回归使用假会话与假存储，验证同源／错号／写前会话复查及固定脱敏，不连接数据库。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { CLOUD_ACCOUNT_HEADER, type AccountKeysResponse } from "@wayfinder/contracts";
import { buildServer } from "../app.js";
import { AccountKeyAccessError, type AccountKeyStorage } from "../accounts/key-storage.js";
import type { AccountAuth } from "../accounts/auth.js";
import { registerAccountKeyRoutes } from "./account-keys.js";

const user = { userId: "owner_A", sessionId: "session_A", email: "fixture@example.test" };
const headers = { host: "fixture.test", origin: "https://fixture.test", [CLOUD_ACCOUNT_HEADER]: user.userId };
const response: AccountKeysResponse = { userId: user.userId, deepseek: { configured: true, mask: "••••tail", revision: "revision_A" }, serpapi: { configured: false, mask: null, revision: null } };
const input = { action: "save", service: "deepseek", expectedRevision: "revision_A", mutationId: "fixture_mutation", apiKey: "fixture-private-key-value" };
const servers: FastifyInstance[] = [];
function fixture(available = true) {
  const server = buildServer(); servers.push(server);
  const auth = { getIdentity: vi.fn<AccountAuth["getIdentity"]>().mockResolvedValue(user) };
  const storage = { read: vi.fn<AccountKeyStorage["read"]>().mockResolvedValue(response), write: vi.fn<AccountKeyStorage["write"]>().mockResolvedValue(response),
    resolve: vi.fn<AccountKeyStorage["resolve"]>(), assertCurrent: vi.fn<AccountKeyStorage["assertCurrent"]>() };
  registerAccountKeyRoutes(server, { auth, storage: available ? storage : null, publicOrigin: headers.origin });
  return { server, auth, storage };
}
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
describe("账号云Key路由", () => {
  it("GET仅返回状态且no-store，POST只把可信会话归属交给存储，共用请求期限", async () => {
    const { server, auth, storage } = fixture();
    const get = await server.inject({ method: "GET", url: "/api/account/keys", headers });
    expect(get.statusCode).toBe(200); expect(get.json()).toEqual(response); expect(get.headers["cache-control"]).toBe("no-store");
    expect(auth.getIdentity).toHaveBeenCalledTimes(2);
    expect(auth.getIdentity.mock.calls[0]?.[1]).toBe(auth.getIdentity.mock.calls[1]?.[1]);
    const post = await server.inject({ method: "POST", url: "/api/account/keys", headers, payload: input });
    expect(post.statusCode).toBe(200); expect(post.body).not.toContain(input.apiKey);
    expect(storage.write).toHaveBeenCalledWith(user.userId, input, expect.objectContaining({ signal: expect.any(AbortSignal), deadline: expect.any(Number) }));
  });
  it("同源和预期账号先于正文解析，匿名／错号坏JSON不能进入存储", async () => {
    const { server, auth, storage } = fixture();
    const cross = await server.inject({ method: "POST", url: "/api/account/keys", headers: { ...headers, origin: "https://other.test" }, payload: input });
    expect(cross.statusCode).toBe(403); expect(auth.getIdentity).not.toHaveBeenCalled();
    for (const current of [null, { ...user, userId: "owner_B" }]) {
      auth.getIdentity.mockResolvedValue(current);
      const rejected = await server.inject({ method: "POST", url: "/api/account/keys", headers: { ...headers, "content-type": "application/json" }, payload: "{invalid-private-json" });
      expect(rejected.statusCode).toBe(401); expect(rejected.json()).toEqual({ code: "ACCOUNT_REQUIRED" });
    }
    expect(storage.write).not.toHaveBeenCalled(); expect(storage.read).not.toHaveBeenCalled();
  });
  it("解析后会话退出／重新登录则拒绝，换号待提交写入不能写B", async () => {
    for (const next of [null, { ...user, sessionId: "session_B" }, { ...user, userId: "owner_B" }]) {
      const { server, auth, storage } = fixture(); auth.getIdentity.mockResolvedValueOnce(user).mockResolvedValueOnce(next);
      const rejected = await server.inject({ method: "POST", url: "/api/account/keys", headers, payload: input });
      expect(rejected.statusCode).toBe(401); expect(storage.write).not.toHaveBeenCalled();
    }
  });
  it("重复／缺失预期头、坏协议、坏JSON和未知内部错误不泄漏Key", async () => {
    const { server, storage } = fixture();
    const missing = { ...headers }; delete (missing as Partial<typeof headers>)[CLOUD_ACCOUNT_HEADER];
    for (const extra of [missing, { ...headers, [CLOUD_ACCOUNT_HEADER]: [user.userId, user.userId] }]) {
      const rejected = await server.inject({ method: "POST", url: "/api/account/keys", headers: extra, payload: input });
      expect(rejected.statusCode).toBe(400); expect(rejected.body).not.toContain(input.apiKey);
    }
    const bad = await server.inject({ method: "POST", url: "/api/account/keys", headers, payload: { ...input, userId: "owner_B" } });
    expect(bad.statusCode).toBe(400); expect(storage.write).not.toHaveBeenCalled();
    const malformed = await server.inject({ method: "POST", url: "/api/account/keys", headers: { ...headers, "content-type": "application/json" }, payload: `{${input.apiKey}` });
    expect(malformed.statusCode).toBe(400); expect(malformed.body).not.toContain(input.apiKey);
    storage.write.mockRejectedValueOnce(new Error(input.apiKey));
    const unavailable = await server.inject({ method: "POST", url: "/api/account/keys", headers, payload: input });
    expect(unavailable.statusCode).toBe(503); expect(unavailable.json()).toEqual({ code: "KEY_UNAVAILABLE" });
    storage.write.mockRejectedValueOnce(new AccountKeyAccessError("KEY_CONFLICT", "deepseek"));
    expect((await server.inject({ method: "POST", url: "/api/account/keys", headers, payload: input })).json()).toEqual({ code: "KEY_CONFLICT", service: "deepseek" });
  });
  it("主密钥功能未启用固定503，不把已保存状态伪装成未配置", async () => {
    const { server, auth } = fixture(false);
    const result = await server.inject({ method: "GET", url: "/api/account/keys", headers });
    expect(result.statusCode).toBe(503); expect(result.json()).toEqual({ code: "KEY_UNAVAILABLE" }); expect(auth.getIdentity).toHaveBeenCalledTimes(1);
  });
});
