/**
 * 模块职责：读取受保护的作者体验配置，并提供唯一的原子更新入口。
 *
 * 安全边界：每次授权检查重新读取文件，不缓存陈旧资格；写锁内重读旧配置，
 * 避免并发公告更新回写旧邀请码。代际与签名材料落在同一文件，正常重启不撤销授权。
 * 本模块不访问 Provider，不记录文件内容、路径、邀请码或底层异常。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

import { ExperienceInviteRequestSchema } from "@wayfinder/contracts";
import { z } from "zod";

const MAX_CONFIG_BYTES = 64 * 1_024;
const ExperienceConfigSchema = z.strictObject({
  announcement: z.string(),
  inviteCode: ExperienceInviteRequestSchema.shape.inviteCode,
  generation: z.uuid(),
  signingSecret: z.string().regex(/^[a-f0-9]{64}$/),
});
const ExperienceConfigUpdateSchema = z.strictObject({
  announcement: z.string().optional(),
  inviteCode: ExperienceInviteRequestSchema.shape.inviteCode.optional(),
});

export type ExperienceConfig = Readonly<z.infer<typeof ExperienceConfigSchema>>;
export type ExperienceConfigUpdate = z.infer<typeof ExperienceConfigUpdateSchema>;

/** 固定文案不携带底层 cause，避免文件路径或解析失败值泄露到 HTTP / 日志。 */
export class ExperienceConfigError extends Error {
  constructor() {
    super("作者体验配置不可用，请检查受保护配置或正在进行的更新");
    this.name = "ExperienceConfigError";
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * 只读普通文件；POSIX 拒绝其他用户可读的权限，Windows 由部署账户 ACL 保护。
 * 先检查链接、再以 O_NOFOLLOW 打开并复核文件身份；固定缓冲上限避免文件增长绕过预算。
 */
export async function readProtectedJson(filePath: string): Promise<unknown> {
  try {
    const before = await fs.lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink()) throw new ExperienceConfigError();
    const file = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev ||
        stat.size > MAX_CONFIG_BYTES ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
        throw new ExperienceConfigError();
      }
      const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_CONFIG_BYTES) throw new ExperienceConfigError();
      // 原子发布可能发生在旧句柄读取期间；不让跨越撤销点的旧文件读取继续授权。
      const current = await fs.lstat(filePath);
      if (!current.isFile() || current.isSymbolicLink() || current.ino !== stat.ino ||
        current.dev !== stat.dev || current.mtimeMs !== stat.mtimeMs || current.size !== stat.size) {
        throw new ExperienceConfigError();
      }
      return JSON.parse(buffer.toString("utf8", 0, length)) as unknown;
    } finally {
      await file.close();
    }
  } catch {
    throw new ExperienceConfigError();
  }
}

/** null 表示部署未开放体验；存在路径却读取失败时拒绝，绝不回退到旧配置。 */
export async function readExperienceConfig(filePath: string | null): Promise<ExperienceConfig | null> {
  if (filePath === null) return null;
  const result = ExperienceConfigSchema.safeParse(await readProtectedJson(filePath));
  if (!result.success) throw new ExperienceConfigError();
  return Object.freeze(result.data);
}

/**
 * 受支持的更新入口：调用者不能指定代际或签名秘密。首次生成高熵邀请码；
 * 显式更新邀请码总是生成新代际（即使输入相同），因此改回曾用值也不会复活旧授权。
 */
export async function updateExperienceConfig(filePath: string, input: unknown): Promise<void> {
  const parsed = ExperienceConfigUpdateSchema.safeParse(input);
  if (!parsed.success) throw new ExperienceConfigError();
  const target = path.resolve(filePath);
  const directory = path.dirname(target);
  const lockPath = `${target}.lock`;
  let locked = false;
  let temporary: string | undefined;
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new ExperienceConfigError();
    const lock = await fs.open(lockPath, "wx", 0o600);
    locked = true;
    await lock.close();
    let previous: ExperienceConfig | null = null;
    try {
      await fs.lstat(target);
      previous = await readExperienceConfig(target);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
    const config: ExperienceConfig = {
      announcement: parsed.data.announcement ?? previous?.announcement ?? "",
      inviteCode: parsed.data.inviteCode ?? previous?.inviteCode ?? randomBytes(32).toString("base64url"),
      generation: previous === null || parsed.data.inviteCode !== undefined
        ? randomUUID() : previous.generation,
      signingSecret: previous?.signingSecret ?? randomBytes(32).toString("hex"),
    };
    const content = `${JSON.stringify(config, null, 2)}\n`;
    if (Buffer.byteLength(content) > MAX_CONFIG_BYTES) throw new ExperienceConfigError();
    temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporary, target);
    temporary = undefined;
  } catch {
    throw new ExperienceConfigError();
  } finally {
    if (temporary !== undefined) await fs.unlink(temporary).catch(() => undefined);
    if (locked) await fs.unlink(lockPath).catch(() => undefined);
  }
}
