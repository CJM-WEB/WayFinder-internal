/**
 * Runner 职责：通过一个受控 CLI 串行运行 Golden 6 条或 Full 20 条固定 Query，
 * 复用完整生产 Pipeline，并把版本化脱敏报告、运行摘要与人工评审表写入本地私有目录。
 *
 * 安全边界：
 * - CLI Guard（闸门）先于 Git、文件、环境、Provider 与网络副作用；
 * - 正式 Eval 只允许基于已提交且干净的工作树，不进入普通无 Secret CI；
 * - 每个 Query 复用生产 20 秒绝对 Deadline，但 Suite 不共享一个 20 秒 Deadline；
 * - 不启用跨 Query Cache，避免前序 Query 污染后序延迟、调用量与成本证据；
 * - 写入前执行严格 Schema 和递归敏感值扫描，错误只输出固定脱敏文案。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { z } from "zod";

import { GRAPH_PLANNER_PROMPT_VERSION } from "../ai/prompts/graph-planner.v1.js";
import { GRAPH_REVISER_PROMPT_VERSION } from "../ai/prompts/graph-reviser.v1.js";
import { RESOURCE_RERANKER_PROMPT_VERSION } from "../ai/prompts/resource-reranker.v1.js";
import {
  DEEPSEEK_LLM_MODEL,
  DEEPSEEK_LLM_PROVIDER_ID,
  DeepSeekLLMProvider,
} from "../ai/providers/deepseek-llm-provider.js";
import { RUN_DEADLINE_MS, parseServerConfig } from "../config.js";
import type { RunLogRecord } from "../observability/run-log.js";
import { createConcurrencyLimitedProviders } from "../orchestrator/provider-concurrency.js";
import { createRunSearchHandler } from "../orchestrator/run-search.js";
import { SerpApiBingSearchProvider } from "../search/providers/serpapi-bing.js";
import { RANK_FUSION_VERSION } from "../pipeline/rank-fusion.js";
import {
  QUALITY_EVAL_DATASET_VERSION,
  QualityEvalQueryResultSchema,
  evaluateQualityEvalDataset,
  evaluateQualityEvalQuery,
  fingerprintQualityEvalDataset,
  parseQualityEvalDatasets,
  type QualityEvalDatasetKind,
  type QualityEvalDatasets,
} from "./quality-eval.js";
import { createQualityEvalOperatingSummary } from "./quality-eval-operating-summary.js";
import { renderQualityEvalHumanReview } from "./quality-review.js";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
const GOLDEN_QUERY_FILE = resolve(REPOSITORY_ROOT, "tests/eval-queries.json");
const FULL_QUERY_FILE = resolve(
  REPOSITORY_ROOT,
  "tests/eval-full-queries.json",
);
const RESULT_ROOT = resolve(REPOSITORY_ROOT, "data/eval-results/way-86");
const RUN_ID_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Provider 与运行策略已迁移到 Search-only，不能复用旧 Tavily + Extract 报告版本。 */
export const QUALITY_EVAL_REPORT_SCHEMA_VERSION = "quality-eval.v6" as const;

export type QualityEvalCliOptions = Readonly<{
  dataset: QualityEvalDatasetKind;
}>;

const GitBaselineSchema = z.strictObject({
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
  worktreeClean: z.literal(true),
});

export const QualityEvalReportSchema = z.strictObject({
  schemaVersion: z.literal(QUALITY_EVAL_REPORT_SCHEMA_VERSION),
  issue: z.literal("WAY-86"),
  evaluationRunId: z.string().regex(RUN_ID_PATTERN),
  completedAt: z.iso.datetime({ offset: true }),
  dataset: z.strictObject({
    kind: z.enum(["golden", "full"]),
    version: z.literal(QUALITY_EVAL_DATASET_VERSION),
    queryCount: z.number().int().min(1).max(20),
    queryFiles: z.array(z.string().min(1)).length(2),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  source: z.strictObject({
    git: GitBaselineSchema,
    contracts: z.strictObject({
      protocol: z.literal("0.1"),
      resultGraph: z.literal("0.1"),
    }),
    prompts: z.strictObject({
      planner: z.literal(GRAPH_PLANNER_PROMPT_VERSION),
      reviser: z.literal(GRAPH_REVISER_PROMPT_VERSION),
      reranker: z.literal(RESOURCE_RERANKER_PROMPT_VERSION),
    }),
    ranking: z.literal(RANK_FUSION_VERSION),
    providers: z.strictObject({
      search: z.literal("serpapi_bing"),
      llm: z.literal(DEEPSEEK_LLM_PROVIDER_ID),
      llmModel: z.literal(DEEPSEEK_LLM_MODEL),
    }),
  }),
  runPolicy: z.strictObject({
    execution: z.literal("sequential"),
    repetitionsPerQuery: z.literal(1),
    cache: z.literal("cold_disabled"),
    runDeadlineMs: z.literal(RUN_DEADLINE_MS),
    language: z.literal("und"),
    queryNormalization: z.literal("nfkc_trim_lowercase"),
    riskyDownloadDomainPolicy: z.literal("not_frozen_empty"),
    timeoutsMs: z.strictObject({
      search: z.number().int().min(1).max(RUN_DEADLINE_MS),
      planner: z.number().int().min(1).max(RUN_DEADLINE_MS),
      rerank: z.number().int().min(1).max(RUN_DEADLINE_MS),
    }),
    concurrency: z.strictObject({
      search: z.number().int().min(1),
      llm: z.number().int().min(1),
    }),
  }),
  artifactPolicy: z.strictObject({
    localOnly: z.literal(true),
    automaticUpload: z.literal(false),
    automaticDeletion: z.literal(false),
    retention: z.literal(
      "until_human_review_and_controlled_sync_decision",
    ),
  }),
  results: z.array(QualityEvalQueryResultSchema).min(1).max(20),
});

export type QualityEvalReport = Readonly<
  z.infer<typeof QualityEvalReportSchema>
>;

export function parseQualityEvalCliArgs(
  args: readonly string[],
): QualityEvalCliOptions {
  const normalized = args[0] === "--" ? args.slice(1) : [...args];
  if (normalized.length !== 2 || !normalized.includes("--live")) {
    throw new Error(
      "Quality Eval 仅接受 --live 与 --dataset=golden|full",
    );
  }
  const datasetArgs = normalized.filter(argument =>
    argument.startsWith("--dataset="),
  );
  if (
    datasetArgs.length !== 1 ||
    normalized.some(
      argument => argument !== "--live" && !argument.startsWith("--dataset="),
    )
  ) {
    throw new Error(
      "Quality Eval 仅接受 --live 与 --dataset=golden|full",
    );
  }
  const dataset = datasetArgs[0]?.slice("--dataset=".length);
  if (dataset !== "golden" && dataset !== "full") {
    throw new Error(
      "Quality Eval 仅接受 --live 与 --dataset=golden|full",
    );
  }
  return { dataset };
}

/** 报告通过正向白名单构造后，再拒绝高风险字段名与实际 Secret 作为第二道防线。 */
export function assertQualityEvalArtifactSafety(
  value: unknown,
  secrets: readonly string[],
): void {
  const forbiddenKeys = new Set([
    "apikey",
    "authorization",
    "cause",
    "content",
    "cookie",
    "extractedcontent",
    "prompt",
    "rawcontent",
    "rawerror",
    "rawmetadata",
    "rawresponse",
    "requestid",
    "response",
    "stack",
  ]);
  const sensitiveUrlKeys = new Set([
    "access_token",
    "api_key",
    "apikey",
    "authorization",
    "cookie",
    "password",
    "passwd",
    "secret",
    "token",
  ]);

  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      for (const secret of secrets) {
        if (secret.length > 0 && candidate.includes(secret)) {
          throw new Error("Quality Eval 工件包含敏感值");
        }
      }
      if (
        /\b(?:authorization|cookie)\s*[:=]/iu.test(candidate) ||
        /\bbearer\s+[a-z0-9._~+/=-]+/iu.test(candidate) ||
        /\b(?:access[_-]?token|api[_-]?key|password|passwd|secret|token)\s*[:=]/iu
          .test(candidate)
      ) {
        throw new Error("Quality Eval 工件包含凭据形态文本");
      }
      try {
        const parsedUrl = new URL(candidate);
        if (
          (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") &&
          (parsedUrl.username.length > 0 || parsedUrl.password.length > 0)
        ) {
          throw new Error("Quality Eval 工件 URL 包含 userinfo");
        }
        for (const key of parsedUrl.searchParams.keys()) {
          if (sensitiveUrlKeys.has(key.toLowerCase())) {
            throw new Error("Quality Eval 工件 URL 包含敏感 Query 参数");
          }
        }
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          error.message.startsWith("Quality Eval 工件 URL")
        ) {
          throw error;
        }
        // 普通文本与非 URL 文本继续按其他规则检查，不将 URL 解析失败视为风险。
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;

    for (const [key, nested] of Object.entries(candidate)) {
      const normalizedKey = key.replace(/[_-]/gu, "").toLowerCase();
      if (forbiddenKeys.has(normalizedKey)) {
        throw new Error("Quality Eval 工件包含禁止字段");
      }
      visit(nested);
    }
  };

  visit(value);
}

export async function createQualityEvalPrivateOutputDirectory(
  resultRoot: string,
  runId: string,
  trustedRoot: string,
): Promise<string> {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new TypeError("Quality Eval Run ID 格式无效");
  }
  const outputDirectory = resolve(resultRoot, runId);

  await assertPathHasNoSymbolicLinks(trustedRoot, resultRoot);
  await mkdir(resultRoot, { recursive: true, mode: 0o700 });
  // mkdir 前后各检查一次，既拒绝已有逃逸路径，也覆盖本次递归创建的每一级目录。
  await assertPathHasNoSymbolicLinks(trustedRoot, resultRoot);
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  const [realTrustedRoot, realOutputDirectory] = await Promise.all([
    realpath(trustedRoot),
    realpath(outputDirectory),
  ]);
  const realRelative = relative(realTrustedRoot, realOutputDirectory);
  if (
    realRelative === ".." ||
    realRelative.startsWith(`..${sep}`) ||
    isAbsolute(realRelative)
  ) {
    throw new TypeError("Quality Eval 真实输出路径超出可信根目录");
  }
  if (process.platform !== "win32") {
    await chmod(resultRoot, 0o700);
    await chmod(outputDirectory, 0o700);
  }
  return outputDirectory;
}

async function assertPathHasNoSymbolicLinks(
  trustedRoot: string,
  target: string,
): Promise<void> {
  const absoluteRoot = resolve(trustedRoot);
  const relativeTarget = relative(absoluteRoot, resolve(target));
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new TypeError("Quality Eval 输出路径超出可信根目录");
  }

  let current = absoluteRoot;
  for (const segment of relativeTarget.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new TypeError("Quality Eval 输出路径不得包含符号链接");
      }
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null
          ? Reflect.get(error, "code")
          : undefined;
      if (code !== "ENOENT") throw error;
    }
  }
}

export async function writeQualityEvalPrivateJson(
  path: string,
  value: unknown,
): Promise<void> {
  await writeQualityEvalPrivateText(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

/** JSON 与人工评审表共用同一私有文件权限实现，避免新增 Sidecar 弱化边界。 */
export async function writeQualityEvalPrivateText(
  path: string,
  value: string,
): Promise<void> {
  await writeFile(path, value, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.platform !== "win32") await chmod(path, 0o600);
}

type QualityEvalFinalArtifactWriters = Readonly<{
  writeReport: () => Promise<void>;
  writeOperatingSummary: () => Promise<void>;
  writeHumanReview: () => Promise<void>;
  writeCompletedState: () => Promise<void>;
}>;

function assertQualityEvalNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Quality Eval 已取消");
}

/**
 * 最终工件必须按报告、运行摘要、人工表、完成状态的顺序写入；任一工件失败或期间取消，
 * 调用方都会进入统一失败路径，不能留下与真实状态不符的 completed 标记。
 */
export async function writeQualityEvalFinalArtifacts(
  writers: QualityEvalFinalArtifactWriters,
  signal: AbortSignal,
): Promise<void> {
  assertQualityEvalNotCancelled(signal);
  await writers.writeReport();
  assertQualityEvalNotCancelled(signal);
  await writers.writeOperatingSummary();
  assertQualityEvalNotCancelled(signal);
  await writers.writeHumanReview();
  assertQualityEvalNotCancelled(signal);
  await writers.writeCompletedState();
  // 覆盖 completed 文件写入期间到达的取消，由外层 catch 改写为 cancelled。
  assertQualityEvalNotCancelled(signal);
}

/** 初始化失败只暴露固定文案，禁止底层文件错误携带个人绝对路径。 */
export async function initializeQualityEvalPrivateOutput(
  createDirectory: () => Promise<string>,
  writeInitialState: (outputDirectory: string) => Promise<void>,
): Promise<string> {
  try {
    const outputDirectory = await createDirectory();
    await writeInitialState(outputDirectory);
    return outputDirectory;
  } catch {
    throw new Error("无法创建 Quality Eval 私有输出目录");
  }
}

export function assertQualityEvalGitStatus(status: string): void {
  if (status.trim().length > 0) {
    throw new Error("Quality Eval 需要已提交且工作区干净的代码");
  }
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
      // 原始文件错误可能包含个人绝对路径，不能附加 cause。
      // eslint-disable-next-line preserve-caught-error
      throw new Error("无法加载 Quality Eval 本地环境配置");
    }
  }
}

async function readCleanGitBaseline(): Promise<z.infer<typeof GitBaselineSchema>> {
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
    assertQualityEvalGitStatus(status);
    return GitBaselineSchema.parse({
      commit: commit.trim(),
      worktreeClean: true,
    });
  } catch {
    throw new Error("Quality Eval 需要已提交且工作区干净的代码");
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("无法读取 Quality Eval 固定 Query 文件");
  }
}

async function readDatasets(): Promise<QualityEvalDatasets> {
  const [golden, full] = await Promise.all([
    readJson(GOLDEN_QUERY_FILE),
    readJson(FULL_QUERY_FILE),
  ]);
  try {
    return parseQualityEvalDatasets(golden, full);
  } catch {
    throw new Error("Quality Eval 固定 Query 文件结构或对应关系无效");
  }
}

function createRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
}

async function runQualityEval(
  options: QualityEvalCliOptions,
  signal: AbortSignal,
): Promise<string> {
  // 正式基线在读取 Secret 前先证明来源 Commit 与数据集合法。
  const [git, datasets] = await Promise.all([
    readCleanGitBaseline(),
    readDatasets(),
  ]);
  const dataset = datasets[options.dataset];
  if (signal.aborted) throw new Error("Quality Eval 已取消");
  loadLocalEnvironmentIfPresent();
  const config = parseServerConfig(process.env);
  const evaluationRunId = createRunId();
  const outputDirectory = await initializeQualityEvalPrivateOutput(
    () => createQualityEvalPrivateOutputDirectory(
      RESULT_ROOT,
      evaluationRunId,
      REPOSITORY_ROOT,
    ),
    directory => writeQualityEvalPrivateJson(
      resolve(directory, "run-state.json"),
      {
        issue: "WAY-86",
        evaluationRunId,
        dataset: dataset.kind,
        status: "incomplete",
      },
    ),
  );

  try {
    const providers = createConcurrencyLimitedProviders({
      // 不包 Memory Cache，明确保持跨 Query 冷执行。
      searchProvider: new SerpApiBingSearchProvider({
        apiKey: config.serpApiKey,
        searchTimeoutMs: config.timeouts.searchMs,
      }),
      llmProvider: new DeepSeekLLMProvider({ apiKey: config.llmApiKey }),
      concurrency: config.concurrency,
    });
    const results = await evaluateQualityEvalDataset({
      dataset,
      signal,
      evaluate: async (query, querySignal) => {
        let runLog: RunLogRecord | undefined;
        const handler = createRunSearchHandler({
          providers,
          officialSourcePolicy: { knownRiskyDownloadDomains: [] },
          llmStageTimeoutMs: config.timeouts.plannerMs,
          rerankTimeoutMs: config.timeouts.rerankMs,
          language: "und",
          normalizeQuery: value =>
            value.normalize("NFKC").trim().toLowerCase(),
          onPlannerValidationDiagnostic: () => undefined,
          onRevisionValidationDiagnostic: () => undefined,
          runLogSink: {
            write: record => {
              // Handler 的 finish 不等待日志落盘；同步赋值保证返回后可立即读取唯一记录。
              if (runLog === undefined) runLog = structuredClone(record);
              return Promise.resolve();
            },
          },
        });
        return evaluateQualityEvalQuery({
          query,
          runId: randomUUID(),
          signal: querySignal,
          runDeadlineMs: RUN_DEADLINE_MS,
          expectedOfficialDomains:
            dataset.officialDomainsByQueryId[query.id] ?? [],
          handleSearch: handler,
          readRunLog: () => runLog,
        });
      },
    });
    if (
      signal.aborted ||
      results.at(-1)?.executionStatus === "cancelled"
    ) {
      throw new Error("Quality Eval 已取消");
    }

    const report: QualityEvalReport = QualityEvalReportSchema.parse({
      schemaVersion: QUALITY_EVAL_REPORT_SCHEMA_VERSION,
      issue: "WAY-86",
      evaluationRunId,
      completedAt: new Date().toISOString(),
      dataset: {
        kind: dataset.kind,
        version: dataset.version,
        queryCount: dataset.queries.length,
        queryFiles: [
          "tests/eval-queries.json",
          "tests/eval-full-queries.json",
        ],
        fingerprint: fingerprintQualityEvalDataset(dataset),
      },
      source: {
        git,
        contracts: {
          protocol: "0.1",
          resultGraph: "0.1",
        },
        prompts: {
          planner: GRAPH_PLANNER_PROMPT_VERSION,
          reviser: GRAPH_REVISER_PROMPT_VERSION,
          reranker: RESOURCE_RERANKER_PROMPT_VERSION,
        },
        ranking: RANK_FUSION_VERSION,
        providers: {
          search: "serpapi_bing",
          llm: DEEPSEEK_LLM_PROVIDER_ID,
          llmModel: DEEPSEEK_LLM_MODEL,
        },
      },
      runPolicy: {
        execution: "sequential",
        repetitionsPerQuery: 1,
        cache: "cold_disabled",
        runDeadlineMs: RUN_DEADLINE_MS,
        language: "und",
        queryNormalization: "nfkc_trim_lowercase",
        riskyDownloadDomainPolicy: "not_frozen_empty",
        timeoutsMs: {
          search: config.timeouts.searchMs,
          planner: config.timeouts.plannerMs,
          rerank: config.timeouts.rerankMs,
        },
        concurrency: config.concurrency,
      },
      artifactPolicy: {
        localOnly: true,
        automaticUpload: false,
        automaticDeletion: false,
        retention: "until_human_review_and_controlled_sync_decision",
      },
      results,
    });
    assertQualityEvalArtifactSafety(report, [
      config.llmApiKey,
      config.serpApiKey,
    ]);
    const operatingSummary = createQualityEvalOperatingSummary(report);
    assertQualityEvalArtifactSafety(operatingSummary, [
      config.llmApiKey,
      config.serpApiKey,
    ]);
    const humanReview = renderQualityEvalHumanReview({
      evaluationRunId,
      gitCommit: report.source.git.commit,
      dataset: {
        kind: report.dataset.kind,
        version: report.dataset.version,
        fingerprint: report.dataset.fingerprint,
      },
      results: report.results,
    });
    assertQualityEvalArtifactSafety(humanReview, [
      config.llmApiKey,
      config.serpApiKey,
    ]);
    await writeQualityEvalFinalArtifacts(
      {
        writeReport: () =>
          writeQualityEvalPrivateJson(
            resolve(outputDirectory, "report.json"),
            report,
          ),
        writeOperatingSummary: () =>
          writeQualityEvalPrivateJson(
            resolve(outputDirectory, "operating-summary.json"),
            operatingSummary,
          ),
        writeHumanReview: () =>
          writeQualityEvalPrivateText(
            resolve(outputDirectory, "human-review.md"),
            humanReview,
          ),
        writeCompletedState: () =>
          writeQualityEvalPrivateJson(
            resolve(outputDirectory, "run-state.json"),
            {
              issue: "WAY-86",
              evaluationRunId,
              dataset: dataset.kind,
              status: "completed",
            },
          ),
      },
      signal,
    );
    return `data/eval-results/way-86/${evaluationRunId}`;
  } catch {
    const cancelled = signal.aborted;
    try {
      await writeQualityEvalPrivateJson(
        resolve(outputDirectory, "run-state.json"),
        {
          issue: "WAY-86",
          evaluationRunId,
          dataset: dataset.kind,
          status: cancelled ? "cancelled" : "failed",
          ...(cancelled
            ? {}
            : { failureKind: "unexpected_internal_error" }),
        },
      );
    } catch {
      // 状态写入失败不能把文件路径或底层错误带到终端。
    }
    throw new Error(
      cancelled
        ? "Quality Eval 已取消；已保留脱敏取消状态"
        : "Quality Eval 执行失败；已保留脱敏失败状态",
    );
  }
}

async function main(): Promise<void> {
  try {
    const options = parseQualityEvalCliArgs(process.argv.slice(2));
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      const outputDirectory = await runQualityEval(options, controller.signal);
      process.stdout.write(`WAY-86 Quality Eval 已完成：${outputDirectory}\n`);
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Quality Eval 发生未知程序错误";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

const entryFile = process.argv[1];
const isDirectExecution =
  entryFile !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(entryFile);

if (isDirectExecution) await main();
