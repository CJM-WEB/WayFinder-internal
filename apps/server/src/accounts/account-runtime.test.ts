/** 纯配置验证，不创建数据库、SMTP或外部测试账户。 */
import { describe, expect, it } from "vitest";
import { parseAccountEnvironment } from "./account-runtime.js";

const environment = {
  WAYFINDER_DATABASE_URL: "mysql://fixture:fake@127.0.0.1/wf_d11_test_config",
  WAYFINDER_AUTH_SECRET: "fixture-auth-secret-at-least-32-characters",
  SMTP_HOST: "smtp.example.test", SMTP_PORT: "465", SMTP_USER: "fixture",
  SMTP_PASSWORD: "fixture-password", SMTP_FROM: "sender@example.test",
};

describe("账号启动配置", () => {
  it("未配置数据库时关闭账号，不读取其他秘密", () => {
    expect(parseAccountEnvironment({}, null)).toBeNull();
  });
  it("要求完整秘密、显式来源及安全SMTP配置，失败只给固定错误", () => {
    expect(parseAccountEnvironment(environment, "https://example.test")).toMatchObject({
      origin: "https://example.test", smtp: { port: 465 },
    });
    for (const input of [{ ...environment, WAYFINDER_AUTH_SECRET: "private-too-short" },
      { ...environment, SMTP_PORT: "25" }, { ...environment, SMTP_PASSWORD: "" }]) {
      expect(() => parseAccountEnvironment(input, "https://example.test")).toThrow(/^ACCOUNT_CONFIG_INVALID$/);
    }
    expect(() => parseAccountEnvironment(environment, null)).toThrow(/^ACCOUNT_CONFIG_INVALID$/);
  });
});
