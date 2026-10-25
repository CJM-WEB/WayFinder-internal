/**
 * 模块职责：把已经通过内部白名单 Schema 的 Run Log 写入仓库固定的 `data/runs`。
 *
 * 安全边界：
 * - 调用方只能提供仓库根目录，不能选择任意输出目录或文件名；
 * - 文件名只使用 Recorder 生成并经 Schema 校验的 UUID，绝不使用客户端 runId；
 * - 关闭时不创建目录、不读取文件，也不产生任何文件系统副作用；
 * - POSIX 使用私有目录/文件权限；Windows 继续由宿主 ACL（访问控制列表）约束。
 */
import {
  chmod,
  lstat,
  mkdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  RunLogRecordSchema,
  type RunLogRecord,
  type RunLogSink,
} from "./run-log.js";

export type CreateLocalRunLogSinkInput = Readonly<{
  repositoryRoot: string;
  enabled: boolean;
}>;

/** 固定子目录是实现级硬边界，不能由环境变量或用户输入覆盖。 */
export const RUN_LOG_RELATIVE_DIRECTORY = join("data", "runs");

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

/**
 * 逐层创建并复核真实目录，避免 recursive mkdir 或后续 chmod 跟随目录符号链接。
 * EEXIST 只表示并发创建可能成功，仍必须经过 lstat 的类型与 Symlink（符号链接）门禁。
 */
async function ensureRealDirectory(
  directory: string,
  mode: 0o700 | 0o755,
): Promise<void> {
  try {
    await mkdir(directory, { recursive: false, mode });
  } catch (error: unknown) {
    if (!isAlreadyExistsError(error)) throw error;
  }

  const information = await lstat(directory);
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new TypeError("Run Log 路径必须是仓库内真实目录");
  }
  // 父级 data 可能承载其他用途；只收紧本功能专属的 data/runs。
  if (process.platform !== "win32" && mode === 0o700) {
    await chmod(directory, 0o700);
  }
}

export function createLocalRunLogSink(
  input: CreateLocalRunLogSinkInput,
): RunLogSink {
  const repositoryRoot = resolve(input.repositoryRoot);
  const dataDirectory = join(repositoryRoot, "data");
  const runLogDirectory = resolve(
    repositoryRoot,
    RUN_LOG_RELATIVE_DIRECTORY,
  );
  const expectedDirectory = join(
    repositoryRoot,
    RUN_LOG_RELATIVE_DIRECTORY,
  );
  if (runLogDirectory !== expectedDirectory) {
    throw new TypeError("Run Log 目录必须固定为仓库 data/runs");
  }

  return {
    write: async (record: RunLogRecord): Promise<void> => {
      if (!input.enabled) return;

      // 再次解析会移除“信任 TypeScript 调用方”的隐含假设，并拒绝任何额外敏感字段。
      const validated = RunLogRecordSchema.parse(record);
      const realRepositoryRoot = await realpath(repositoryRoot);
      await ensureRealDirectory(dataDirectory, 0o755);
      await ensureRealDirectory(runLogDirectory, 0o700);
      const realRunLogDirectory = await realpath(runLogDirectory);
      if (
        realRunLogDirectory !==
        join(realRepositoryRoot, RUN_LOG_RELATIVE_DIRECTORY)
      ) {
        throw new TypeError("Run Log 真实目录必须位于仓库 data/runs");
      }
      const filePath = join(
        runLogDirectory,
        `${validated.identifiers.logId}.json`,
      );
      await writeFile(filePath, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    },
  };
}
