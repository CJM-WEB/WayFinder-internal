/** 昵称接口使用假会话和假存储，验证账号隔离与失败闭合，不触发邮件或真实数据库。 */
import { describe, expect, it, vi } from "vitest";
import { CLOUD_ACCOUNT_HEADER } from "@wayfinder/contracts";
import { buildServer } from "../app.js";
import { registerProfileRoutes } from "./profile.js";

const origin = "https://profile.example";
const identity = { userId: "fixture_user", sessionId: "fixture_session", email: "fixture@example.test" };
const headers = { origin, host: "profile.example", [CLOUD_ACCOUNT_HEADER]: identity.userId, "content-type": "application/json" };
function fixture() {
  const server = buildServer();
  const getIdentity = vi.fn(async () => identity as typeof identity | null);
  const read = vi.fn(async (userId: string) => ({ userId, nickname: null }));
  const write = vi.fn(async (userId: string, nickname: string) => ({ userId, nickname }));
  registerProfileRoutes(server, { auth: { getIdentity }, storage: { read, write }, publicOrigin: origin });
  return { server, getIdentity, read, write };
}

describe("账号统一昵称", () => {
  it("仅返回本人昵称，不公开邮箱；写入取可信会话账号并规范化昵称", async () => {
    const f = fixture();
    try {
      const initial = await f.server.inject({ url: "/api/profile", headers });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toEqual({ profile: { userId: identity.userId, nickname: null } });
      const saved = await f.server.inject({ method: "POST", url: "/api/profile", headers, payload: { nickname: "  小明  " } });
      expect(saved.json()).toEqual({ profile: { userId: identity.userId, nickname: "小明" } });
      expect(saved.headers["cache-control"]).toBe("no-store");
      expect(f.write.mock.calls[0]?.slice(0, 2)).toEqual([identity.userId, "小明"]);
    } finally { await f.server.close(); }
  });

  it("拒绝空昵称、伪造归属、跨站及错误账号头", async () => {
    const f = fixture();
    try {
      for (const payload of [{ nickname: " " }, { nickname: "小明", userId: "other" }]) {
        expect((await f.server.inject({ method: "POST", url: "/api/profile", headers, payload })).statusCode).toBe(400);
      }
      expect((await f.server.inject({ url: "/api/profile", headers: { ...headers, origin: "https://other.example" } })).statusCode).toBe(403);
      expect((await f.server.inject({ url: "/api/profile", headers: { ...headers, [CLOUD_ACCOUNT_HEADER]: "other_user" } })).statusCode).toBe(401);
      expect(f.write).not.toHaveBeenCalled();
    } finally { await f.server.close(); }
  });

  it("解析前拒绝匿名请求；上传期间换会话阻止写入，存储错误脱敏", async () => {
    const f = fixture();
    try {
      f.getIdentity.mockResolvedValue(null);
      expect((await f.server.inject({ method: "POST", url: "/api/profile", headers, payload: "{" })).statusCode).toBe(401);
      f.getIdentity.mockResolvedValueOnce(identity).mockResolvedValueOnce({ ...identity, sessionId: "new_session" });
      expect((await f.server.inject({ method: "POST", url: "/api/profile", headers, payload: { nickname: "小明" } })).statusCode).toBe(401);
      expect(f.write).not.toHaveBeenCalled();
      f.getIdentity.mockResolvedValue(identity);
      f.write.mockRejectedValueOnce(new Error("fixture private database detail"));
      const failed = await f.server.inject({ method: "POST", url: "/api/profile", headers, payload: { nickname: "小明" } });
      expect(failed.statusCode).toBe(503); expect(failed.json()).toEqual({ code: "GROUP_UNAVAILABLE" });
    } finally { await f.server.close(); }
  });
});
