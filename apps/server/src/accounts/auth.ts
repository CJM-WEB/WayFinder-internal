/**
 * 模块职责：将 Better Auth 的邮箱密码、验证码和数据库会话映射为项目最小账号接口。
 * 安全边界：不公开库默认端点，不回传令牌，不记录原始库日志；初始化和迁移均显式执行。
 * 邮件 accepted 仅表示处理请求；投递失败单独发出固定脱敏事件，不冒充已投递。
 */
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { emailOTP } from "better-auth/plugins";
import { z } from "zod";
import {
  AccountActionSchema, AccountResponseSchema, UserIdSchema,
  type AccountAction, type AccountErrorResponse, type AccountResponse,
} from "@wayfinder/contracts";

import { createAuthDatabase } from "./auth-database.js";
import { AccountDatabase, type DatabaseOperation } from "./database.js";

export type AccountIdentity = Readonly<{ userId: string; sessionId: string; email: string }>;
export type AccountMailer = Readonly<{
  sendOTP: (message: Readonly<{ email: string; otp: string; purpose: "verify" | "reset" }>, signal: AbortSignal) => Promise<void>;
}>;
export class AccountAccessError extends Error {
  constructor(readonly code: AccountErrorResponse["code"]) { super(code); this.name = "AccountAccessError"; }
}
export type AccountAuth = Readonly<{
  initialize: (operation: DatabaseOperation) => Promise<void>;
  migrate: (operation: DatabaseOperation) => Promise<void>;
  handle: (input: AccountAction, headers: Headers, operation: DatabaseOperation) => Promise<Readonly<{ body: AccountResponse; cookies: string[] }>>;
  getIdentity: (headers: Headers, operation: DatabaseOperation) => Promise<AccountIdentity | null>;
}>;

const libraryIdentitySchema = z.object({
  user: z.object({ id: UserIdSchema, email: z.email(), emailVerified: z.literal(true) }),
  session: z.object({ id: z.string().min(1) }),
});

/** 只允许固定内部路径，调用者不能提交库路径、回调网址、第三方身份或协议扩展字段。 */
function libraryRequest(input: AccountAction): Readonly<{ path: string; body: object }> {
  switch (input.action) {
    case "register": return { path: "/sign-up/email", body: { email: input.email, password: input.password, name: input.email } };
    case "login": return { path: "/sign-in/email", body: { email: input.email, password: input.password } };
    case "logout": return { path: "/sign-out", body: {} };
    case "verify": return { path: "/email-otp/verify-email", body: { email: input.email, otp: input.otp } };
    case "reset": return { path: "/email-otp/reset-password", body: { email: input.email, otp: input.otp, password: input.password } };
    case "recover": return { path: "/email-otp/request-password-reset", body: { email: input.email } };
    case "resend": return { path: "/email-otp/send-verification-otp", body: { email: input.email, type: "email-verification" } };
  }
}

export function createAccountAuth(input: Readonly<{
  database: AccountDatabase; origin: string; secret: string; mailer: AccountMailer;
  onDeliveryFailure?: () => void;
}>): AccountAuth {
  const origin = new URL(input.origin).origin;
  if (origin !== input.origin || input.secret.length < 32) throw new AccountAccessError("ACCOUNT_UNAVAILABLE");
  const database = createAuthDatabase(input.database);
  const options = {
    appName: "WayFinder", baseURL: origin, basePath: "/internal-account", secret: input.secret,
    database: database.pool, trustedOrigins: [origin], logger: { disabled: true }, telemetry: { enabled: false },
    emailAndPassword: { enabled: true, requireEmailVerification: true, autoSignIn: false, revokeSessionsOnPasswordReset: true },
    emailVerification: { expiresIn: 3600, autoSignInAfterVerification: false },
    session: { expiresIn: 7 * 24 * 60 * 60, disableSessionRefresh: true, cookieCache: { enabled: false } },
    advanced: {
      useSecureCookies: true, defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: "strict" as const },
      ipAddress: { ipAddressHeaders: ["x-wayfinder-client-ip"] },
      disableCSRFCheck: false, disableOriginCheck: false,
    },
    rateLimit: { enabled: true },
    plugins: [emailOTP({
      expiresIn: 3600, storeOTP: "hashed", disableSignUp: true, overrideDefaultEmailVerification: true,
      async sendVerificationOTP(message) {
        if (message.type !== "email-verification" && message.type !== "forget-password") throw new AccountAccessError("ACCOUNT_INVALID");
        try {
          await input.mailer.sendOTP({ email: message.email, otp: message.otp,
            purpose: message.type === "email-verification" ? "verify" : "reset" }, database.signal());
        } catch {
          // 库会吞掉回调异常；项目必须保留投递失败事件，但不暴露地址、验证码或 SMTP 细节。
          try { input.onDeliveryFailure?.(); } catch { /* 诊断接收器异常不能改变账号错误语义。 */ }
        }
      },
    })],
  } satisfies Parameters<typeof betterAuth>[0];
  let auth: ReturnType<typeof betterAuth<typeof options>> | undefined;
  let initializing: Promise<void> | undefined;
  const initialize = async (operation: DatabaseOperation): Promise<void> => database.run(operation, async () => {
    if (initializing === undefined) initializing = (async () => {
      auth = betterAuth(options);
      const context = await auth.$context;
      await context.checkSchema?.();
    })();
    try { await initializing; }
    catch { initializing = undefined; auth = undefined; throw new AccountAccessError("ACCOUNT_UNAVAILABLE"); }
  });
  const getAuth = async (operation: DatabaseOperation) => {
    await initialize(operation);
    if (auth === undefined) throw new AccountAccessError("ACCOUNT_UNAVAILABLE");
    return auth;
  };

  return {
    initialize,
    migrate: operation => database.run(operation, async () => {
      const plan = await getMigrations(options);
      if (plan.unsafeChanges.length || plan.schemaProblems.length) throw new AccountAccessError("ACCOUNT_UNAVAILABLE");
      await plan.runMigrations();
      initializing = undefined; auth = undefined;
    }),
    handle: async (raw, headers, operation) => {
      const selected = libraryRequest(AccountActionSchema.parse(raw));
      const response = await database.run(operation, async () => {
        const current = await getAuth(operation);
        const response = await current.handler(new Request(`${origin}/internal-account${selected.path}`, {
          method: "POST", headers, body: JSON.stringify(selected.body), signal: database.signal(),
        }));
        // 新会话成功后撤销传入的旧会话；新 Cookie 单独保留，失败登录不能误退出原账号。
        if (raw.action === "login" && response.ok && headers.has("cookie")) {
          await current.api.signOut({ headers });
        }
        return response;
      });
      if (!response.ok) throw new AccountAccessError(response.status === 429 ? "ACCOUNT_RATE_LIMITED"
        : response.status >= 500 ? "ACCOUNT_UNAVAILABLE" : "ACCOUNT_INVALID");
      let body: AccountResponse = { accepted: true };
      if (raw.action === "login") {
        const result = z.object({ user: z.object({ id: UserIdSchema, email: z.email() }) }).parse(await response.json());
        body = { account: { userId: result.user.id, email: result.user.email } };
      }
      return { body: AccountResponseSchema.parse(body), cookies: response.headers.getSetCookie() };
    },
    getIdentity: async (headers, operation) => {
      const result = await database.run(operation, async () => {
        const current = await getAuth(operation);
        return current.api.getSession({ headers, query: { disableCookieCache: true } });
      });
      if (result === null) return null;
      const checked = libraryIdentitySchema.parse(result);
      return { userId: checked.user.id, sessionId: checked.session.id, email: checked.user.email };
    },
  };
}
