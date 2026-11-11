/**
 * 模块职责：通过已批准的 Nodemailer 标准 SMTP 发送站内验证／找回验证码。
 * 生命周期：每封邮件独立连接，沿用调用方取消信号并设5秒上限；不重试、不打印邮件或凭据。
 * 失败边界：关闭本次连接并只抛固定错误，邮件已交给上游时不能承诺撤回。
 */
import { createTransport, type SendMailOptions, type SMTPTransportOptions } from "nodemailer";
import { z } from "zod";

import type { AccountMailer } from "./auth.js";

export const SmtpAccountConfigSchema = z.strictObject({
  host: z.string().min(1).regex(/^[A-Za-z0-9.-]+$/),
  port: z.union([z.literal(465), z.literal(587)]),
  user: z.string().min(1), password: z.string().min(1), from: z.email(),
});
export type SmtpAccountConfig = z.infer<typeof SmtpAccountConfigSchema>;
type MailTransport = Readonly<{
  sendMail: (message: SendMailOptions) => Promise<unknown>;
  close: () => void;
}>;
type MailTransportFactory = (options: SMTPTransportOptions) => MailTransport;

export class MailDeliveryError extends Error {
  constructor() { super("MAIL_DELIVERY_FAILED"); this.name = "MailDeliveryError"; }
}

/** 创建函数没有网络副作用；测试注入假传输，不创建任何外部测试邮箱。 */
export function createSmtpAccountMailer(
  input: SmtpAccountConfig,
  transportFactory: MailTransportFactory = options => createTransport(options),
): AccountMailer {
  let config: SmtpAccountConfig;
  try { config = SmtpAccountConfigSchema.parse(input); }
  catch { throw new MailDeliveryError(); }
  return { sendOTP: async (message, callerSignal) => {
    if (callerSignal.aborted) throw new MailDeliveryError();
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(5_000)]);
    let transport: MailTransport;
    try { transport = transportFactory({
      host: config.host, port: config.port, secure: config.port === 465,
      requireTLS: true, tls: { rejectUnauthorized: true, servername: config.host },
      auth: { user: config.user, pass: config.password },
      connectionTimeout: 5_000, greetingTimeout: 5_000, socketTimeout: 5_000,
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    }); } catch { throw new MailDeliveryError(); }
    let onAbort: (() => void) | undefined;
    try {
      const purpose = message.purpose === "verify" ? "验证邮箱 / Verify email" : "重置密码 / Reset password";
      await Promise.race([
        transport.sendMail({
          // Nodemailer原生中止本次SMTP连接；close()只作清理，不能代替传递取消信号。
          signal,
          // 仅补充品牌显示名；真实发件地址仍使用已验证的SMTP邮箱，不能伪装域名地址。
          from: { name: "WayFinder", address: config.from }, to: message.email, subject: `WayFinder ${purpose}`,
          text: `${purpose}\n\n${message.otp}\n\n验证码1小时有效且仅可使用一次。如非本人操作，请忽略。\nThis code expires in one hour and can be used once. Ignore it if you did not request it.`,
        }),
        new Promise<never>((_, reject) => {
          onAbort = () => { transport.close(); reject(new MailDeliveryError()); };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
      if (signal.aborted) throw new MailDeliveryError();
    } catch { throw new MailDeliveryError(); }
    finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      transport.close();
    }
  } };
}
