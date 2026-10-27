/**
 * Runner 职责：从三个固定 Golden Case 中选择一个，受控生成 WAY-107 SerpAPI H2 本地工件。
 *
 * 安全边界：
 * - 只有同时提供 `--live`、固定 Case 与条件顺序才允许真实 Provider 调用；
 * - Secret 只在 Git 干净基线通过后读取，输出固定在已忽略的私有目录；
 * - 工件只包含公共 H2 Contract，不保存正文、Prompt、原始响应、错误对象或 Token；
 * - 运行只生成实验材料，不代表 H2 质量结论或人员评估已经完成。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import process from "node:process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { H2EvaluationArtifactSchema } from "@wayfinder/contracts";

import {
  DeepSeekLLMProvider,
  type DeepSeekTokenUsage,
} from "../ai/providers/deepseek-llm-provider.js";
import { parseServerConfig } from "../config.js";
import {
  SerpApiBingSearchProvider,
  type SerpApiBingAttemptObservation,
} from "../search/providers/serpapi-bing.js";
import {
  evaluateH2RetrievalBaseline,
  type H2ConditionOrder,
} from "./h2-retrieval-baseline.js";
import {
  assertSingleNodeSmokeArtifactSafety,
  assertSingleNodeSmokeGitStatus,
  createBoundedSearchAttemptRecorder,
  getSingleNodeSmokeCases,
  writeSingleNodeSmokePrivateJson,
  type SingleNodeSmokeCase,
} from "./run-single-node-smoke.js";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
const H2_RESULT_RELATIVE_DIRECTORY = join(
  "data",
  "eval-results",
  "way-107",
  "h2",
);
const H2_RUN_ID_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type H2BaselineCliOptions = Readonly<{
  caseId: SingleNodeSmokeCase["id"];
  conditionOrder: H2ConditionOrder;
}>;

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

/** 创建后立即 lstat，禁止 mkdir/chmod 跟随既有 Symlink（符号链接）。 */
async function ensureRealDirectory(
  directory: string,
  mode: 0o700 | 0o755,
  mustCreate = false,
): Promise<void> {
  try {
    await mkdir(directory, { recursive: false, mode });
  } catch (error: unknown) {
    if (mustCreate || !isAlreadyExistsError(error)) throw error;
  }

  const information = await lstat(directory);
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new TypeError("H2 Baseline 路径必须是仓库内真实目录");
  }
  if (process.platform !== "win32" && mode === 0o700) {
    await chmod(directory, 0o700);
  }
}

/**
 * 逐层验证 WAY-107/H2 目录，并只新建由内部 UUID 组成的私有 Run 目录。
 * realpath 复核同时防止仓库父路径别名造成固定目录判断失真。
 */
export async function createH2PrivateOutputDirectory(
  repositoryRoot: string,
  runId: string,
): Promise<string> {
  if (!H2_RUN_ID_PATTERN.test(runId)) {
    throw new TypeError("H2 Baseline Run ID 格式无效");
  }

  const root = resolve(repositoryRoot);
  const dataDirectory = join(root, "data");
  const evalDirectory = join(dataDirectory, "eval-results");
  const way107Directory = join(evalDirectory, "way-107");
  const resultRoot = join(root, H2_RESULT_RELATIVE_DIRECTORY);
  const outputDirectory = join(resultRoot, runId);
  const realRepositoryRoot = await realpath(root);

  await ensureRealDirectory(dataDirectory, 0o755);
  await ensureRealDirectory(evalDirectory, 0o755);
  await ensureRealDirectory(way107Directory, 0o700);
  await ensureRealDirectory(resultRoot, 0o700);
  await ensureRealDirectory(outputDirectory, 0o700, true);

  if (
    (await realpath(outputDirectory)) !==
    join(realRepositoryRoot, H2_RESULT_RELATIVE_DIRECTORY, runId)
  ) {
    throw new TypeError("H2 Baseline 真实目录必须位于仓库内");
  }
  return outputDirectory;
}

/** 参数必须完整且无重复；显式条件顺序支持实验方交叉安排，而不是在代码中暗中随机。 */
export function parseH2BaselineCliArgs(
  args: readonly string[],
): H2BaselineCliOptions {
  const normalized = args[0] === "--" ? args.slice(1) : [...args];
  if (normalized.length !== 3 || !normalized.includes("--live")) {
    throw new Error(
      "H2 Baseline 仅接受 --live、--case=<固定ID> 与 --first=<node-specific|raw-query>",
    );
  }

  const caseArgument = normalized.find(argument =>
    argument.startsWith("--case="),
  );
  const firstArgument = normalized.find(argument =>
    argument.startsWith("--first="),
  );
  const caseId = caseArgument?.slice("--case=".length);
  const first = firstArgument?.slice("--first=".length);
  const validCase = getSingleNodeSmokeCases().find(
    smokeCase => smokeCase.id === caseId,
  );
  if (validCase === undefined) {
    throw new Error("H2 Baseline Case 必须是固定 Golden Case");
  }
  if (first !== "node-specific" && first !== "raw-query") {
    throw new Error("H2 Baseline first 条件无效");
  }

  return {
    caseId: validCase.id,
    conditionOrder:
      first === "node-specific"
        ? ["node_specific", "raw_query"]
        : ["raw_query", "node_specific"],
  };
}

function loadLocalEnvironmentIfPresent(): void {
  try {
    process.loadEnvFile(resolve(REPOSITORY_ROOT, ".env.local"));
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : undefined;
    if (code !== "ENOENT") {
      // 原始文件错误可能携带个人绝对路径，不能附加 cause。
      // eslint-disable-next-line preserve-caught-error
      throw new Error("无法加载 H2 Baseline 本地环境配置");
    }
  }
}

async function readCleanGitCommit(): Promise<string> {
  try {
    const [{ stdout: commit }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
      }),
      execFileAsync(
        "git",
        ["status", "--porcelain", "--untracked-files=normal"],
        { cwd: REPOSITORY_ROOT, encoding: "utf8" },
      ),
    ]);
    assertSingleNodeSmokeGitStatus(status);
    return commit.trim();
  } catch {
    throw new Error("H2 Baseline 需要已提交且工作区干净的代码");
  }
}

function createRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
}

async function runH2Baseline(options: H2BaselineCliOptions): Promise<string> {
  const commit = await readCleanGitCommit();
  // Git 基线通过后才允许加载 Secret 与创建外部调用 Adapter。
  loadLocalEnvironmentIfPresent();
  const config = parseServerConfig(process.env);
  const smokeCase = getSingleNodeSmokeCases().find(
    candidate => candidate.id === options.caseId,
  );
  if (smokeCase === undefined) {
    throw new Error("H2 Baseline 固定 Case 缺失");
  }

  const runId = createRunId();
  let outputDirectory: string;
  try {
    outputDirectory = await createH2PrivateOutputDirectory(
      REPOSITORY_ROOT,
      runId,
    );
  } catch {
    throw new Error("无法初始化 H2 Baseline 私有输出目录");
  }
  const writeState = (value: unknown) =>
    writeSingleNodeSmokePrivateJson(
      resolve(outputDirectory, "run-state.json"),
      value,
    );
  try {
    await writeState({
      issue: "WAY-107",
      searchProvider: "serpapi_bing",
      runId,
      status: "incomplete",
      caseId: options.caseId,
      commit,
      conditionOrder: options.conditionOrder,
    });
  } catch {
    throw new Error("无法初始化 H2 Baseline 私有输出目录");
  }

  try {
    const attemptRecorder = createBoundedSearchAttemptRecorder({
      maximumSearchAttempts:
        (smokeCase.node.searchPlan.queries.length + 1) * 2,
    });
    const tokenUsages: DeepSeekTokenUsage[] = [];
    const searchProvider = new SerpApiBingSearchProvider({
      apiKey: config.serpApiKey,
      searchTimeoutMs: config.timeouts.searchMs,
      onAttempt: attemptRecorder.record,
    });
    const rerankProvider = new DeepSeekLLMProvider({
      apiKey: config.llmApiKey,
      onTokenUsage: usage => tokenUsages.push(usage),
    });
    const artifact = H2EvaluationArtifactSchema.parse(
      await evaluateH2RetrievalBaseline({
        smokeCase,
        searchProvider,
        rerankProvider,
        rerankTimeoutMs: config.timeouts.rerankMs,
        conditionOrder: options.conditionOrder,
        readAttemptObservations: (): readonly SerpApiBingAttemptObservation[] =>
          attemptRecorder.read(),
        readTokenUsages: () => tokenUsages,
      }),
    );
    assertSingleNodeSmokeArtifactSafety(artifact, [
      config.llmApiKey,
      config.serpApiKey,
    ]);
    await writeSingleNodeSmokePrivateJson(
      resolve(outputDirectory, "h2-evaluation-artifact.json"),
      artifact,
    );
    await writeState({
      issue: "WAY-107",
      searchProvider: "serpapi_bing",
      runId,
      status: "completed",
      caseId: options.caseId,
      commit,
      conditionOrder: options.conditionOrder,
    });
    return `data/eval-results/way-107/h2/${runId}`;
  } catch {
    try {
      await writeState({
        issue: "WAY-107",
        searchProvider: "serpapi_bing",
        runId,
        status: "failed",
        caseId: options.caseId,
        commit,
        conditionOrder: options.conditionOrder,
        failureKind: "evaluation_not_comparable",
      });
    } catch {
      // 二次写入失败也不能把路径、Secret 或原始 Provider 错误带到终端。
    }
    throw new Error("H2 Baseline 未生成可比较工件；已保留脱敏失败状态");
  }
}

async function main(): Promise<void> {
  try {
    const options = parseH2BaselineCliArgs(process.argv.slice(2));
    const outputDirectory = await runH2Baseline(options);
    process.stdout.write(`WAY-107 SerpAPI H2 Baseline 已完成：${outputDirectory}\n`);
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "H2 Baseline 发生未知程序错误";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

const entryFile = process.argv[1];
const isDirectExecution =
  entryFile !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(entryFile);

if (isDirectExecution) {
  await main();
}
