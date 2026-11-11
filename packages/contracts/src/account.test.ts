/** 验证账号公共边界拒绝身份注入、库默认动作、令牌回传和非密码登录。 */
import { describe, expect, it } from "vitest";
import { AccountActionSchema, AccountResponseSchema } from "./index.js";

describe("账号公共协议", () => {
  it("仅接受固定动作与必要输入，不接受客户端身份或回调网址", () => {
    const input = { action: "login", email: "fixture@example.com", password: "fixture-password" };
    expect(AccountActionSchema.safeParse(input).success).toBe(true);
    for (const extra of [{ userId: "other" }, { callbackURL: "https://evil.example" }, { token: "secret" }]) {
      expect(AccountActionSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
    expect(AccountActionSchema.safeParse({ action: "sign-in-otp", email: "fixture@example.com", otp: "123456" }).success).toBe(false);
  });
  it("验证码限定六位，密码沿用认证库长度范围", () => {
    const verify = { action: "verify", email: "fixture@example.com", otp: "123456" };
    expect(AccountActionSchema.safeParse(verify).success).toBe(true);
    expect(AccountActionSchema.safeParse({ ...verify, otp: "12 456" }).success).toBe(false);
    expect(AccountActionSchema.safeParse({ action: "register", email: "fixture@example.com", password: "short" }).success).toBe(false);
  });
  it("公共响应不允许令牌、会话编号和投递成功声明", () => {
    expect(AccountResponseSchema.safeParse({ accepted: true }).success).toBe(true);
    expect(AccountResponseSchema.safeParse({ account: { userId: "user_a", email: "fixture@example.com" } }).success).toBe(true);
    for (const value of [{ accepted: true, sent: true }, { account: null, token: "secret" },
      { account: { userId: "user_a", email: "fixture@example.com", sessionId: "secret" } }]) {
      expect(AccountResponseSchema.safeParse(value).success).toBe(false);
    }
  });
});
