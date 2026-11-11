/**
 * 模块职责：在显式启动阶段读取账号私有配置，组合数据库、认证库与SMTP适配器。
 * 失败路径：配置不全不启动账号功能；初始化失败关闭池，错误不包含输入值。
 * 空数据库配置维持账号关闭；构建和模块导入不会创建实例或访问网络。
 */
import { z } from "zod";
import { createAccountAuth, type AccountAuth } from "./auth.js";
import { AccountDatabase, databaseOperation, loadDatabaseConfig } from "./database.js";
import { createSmtpAccountMailer, SmtpAccountConfigSchema } from "./mail.js";
import { normalizePublicOrigin } from "../settings/request-origin.js";
import { createWorkspaceStorage, type WorkspaceStorage } from "./workspace-storage.js";

export const ACCOUNT_ENVIRONMENT_VARIABLES = Object.freeze([
  "WAYFINDER_AUTH_SECRET", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM",
]);
const InputSchema = z.object({
  WAYFINDER_AUTH_SECRET: z.string().min(32),
  SMTP_HOST: z.string(), SMTP_PORT: z.enum(["465", "587"]).default("465"),
  SMTP_USER: z.string(), SMTP_PASSWORD: z.string(), SMTP_FROM: z.string(),
});
export class AccountConfigError extends Error {
  constructor() { super("ACCOUNT_CONFIG_INVALID"); this.name = "AccountConfigError"; }
}

/** 不依赖真实凭据的纯解析；只允许显式可信来源，不能用请求Host补全正式站点。 */
export function parseAccountEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  publicOrigin: string | null,
) {
  if (!environment.WAYFINDER_DATABASE_URL) return null;
  try {
    const input = InputSchema.parse(environment);
    const origin = publicOrigin === null ? null : normalizePublicOrigin(publicOrigin);
    if (origin === null) throw new AccountConfigError();
    return {
      secret: input.WAYFINDER_AUTH_SECRET, origin,
      smtp: SmtpAccountConfigSchema.parse({
        host: input.SMTP_HOST, port: Number(input.SMTP_PORT),
        user: input.SMTP_USER, password: input.SMTP_PASSWORD, from: input.SMTP_FROM,
      }),
    };
  } catch { throw new AccountConfigError(); }
}

export type AccountRuntime = Readonly<{ auth: AccountAuth; database: AccountDatabase; workspace: WorkspaceStorage }>;

export async function loadAccountRuntime(
  environment: Readonly<Record<string, string | undefined>>,
  publicOrigin: string | null,
  onDeliveryFailure: () => void,
): Promise<AccountRuntime | null> {
  const config = parseAccountEnvironment(environment, publicOrigin);
  if (config === null) return null;
  const database = new AccountDatabase(await loadDatabaseConfig(environment));
  try {
    const auth = createAccountAuth({
      database, origin: config.origin, secret: config.secret,
      mailer: createSmtpAccountMailer(config.smtp), onDeliveryFailure,
    });
    await auth.initialize(databaseOperation(new AbortController().signal));
    return { auth, database, workspace: createWorkspaceStorage(database) };
  } catch {
    await database.close();
    throw new AccountConfigError();
  }
}
