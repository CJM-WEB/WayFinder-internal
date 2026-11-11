/** 普通CI只用内存假传输：验证TLS配置、邮件内容和取消／失败脱敏，不发真实邮件。 */
import { describe, expect, it, vi } from "vitest";
import { createSmtpAccountMailer } from "./mail.js";

const config = { host: "smtp.example.test", port: 465 as const, user: "fixture", password: "fixture-password", from: "sender@example.test" };
const message = { email: "recipient@example.test", otp: "123456", purpose: "verify" as const };

describe("验证码SMTP边界", () => {
  it("仅显式发送并强制TLS、不记录协议或访问附件网址", async () => {
    const transport = { sendMail: vi.fn(async () => ({})), close: vi.fn() };
    const factory = vi.fn(() => transport);
    const mailer = createSmtpAccountMailer(config, factory);
    expect(factory).not.toHaveBeenCalled();
    await mailer.sendOTP(message, new AbortController().signal);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      secure: true, requireTLS: true, tls: { rejectUnauthorized: true, servername: config.host },
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    }));
    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: { name: "WayFinder", address: config.from },
      to: message.email, text: expect.stringContaining(message.otp), signal: expect.any(AbortSignal),
    }));
    expect(transport.close).toHaveBeenCalled();
  });

  it("取消关闭本次连接，不回显SMTP原始错误或凭据", async () => {
    const controller = new AbortController();
    const transport = { sendMail: vi.fn(() => new Promise<never>(() => {})), close: vi.fn() };
    const mailer = createSmtpAccountMailer(config, () => transport);
    const pending = mailer.sendOTP(message, controller.signal);
    controller.abort(new Error("private-address-and-secret"));
    await expect(pending).rejects.toThrow("MAIL_DELIVERY_FAILED");
    expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) }));
    expect(transport.close).toHaveBeenCalled();
    const broken = createSmtpAccountMailer(config, () => ({ close: vi.fn(), sendMail: async () => { throw new Error(config.password); } }));
    await expect(broken.sendOTP(message, new AbortController().signal)).rejects.toThrow(/^MAIL_DELIVERY_FAILED$/);
  });

  it("已取消时不创建传输，587仍必须升级TLS", async () => {
    const factory = vi.fn(() => ({ sendMail: vi.fn(async () => ({})), close: vi.fn() }));
    const mailer = createSmtpAccountMailer({ ...config, port: 587 }, factory);
    const controller = new AbortController(); controller.abort();
    await expect(mailer.sendOTP(message, controller.signal)).rejects.toThrow("MAIL_DELIVERY_FAILED");
    expect(factory).not.toHaveBeenCalled();
    await mailer.sendOTP({ ...message, purpose: "reset" }, new AbortController().signal);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: true }));
    expect(factory.mock.results[0]?.value.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: { name: "WayFinder", address: config.from },
    }));
  });
});
