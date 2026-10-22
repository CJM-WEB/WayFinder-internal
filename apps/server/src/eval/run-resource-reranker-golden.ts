/**
 * 模块职责：串行执行 WAY-53 Resource Reranker Golden Cases，并把质量、延迟、
 * Token 与人工审核材料写入被 Git 忽略的本地目录。
 *
 * 安全边界：
 * - 缺少唯一 `--live` 参数时，在读取 Secret 或发起网络前立即拒绝；
 * - 只使用仓库内固定的脱敏 `.example` Candidate/Page Fixture，不调用 Search/Extract；
 * - 报告不保存 Secret、Provider 原始响应、请求标识或错误堆栈。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type {
  ExtractedPage,
  GraphNodeCore,
  RankingProfile,
  ResourceCandidate,
} from "@wayfinder/contracts";
import { z } from "zod";

import { RESOURCE_RERANKER_PROMPT_VERSION } from "../ai/prompts/resource-reranker.v1.js";
import {
  DEEPSEEK_LLM_MODEL,
  DEEPSEEK_LLM_PROVIDER_ID,
  DeepSeekLLMProvider,
  type DeepSeekTokenUsage,
} from "../ai/providers/deepseek-llm-provider.js";
import {
  rerankResources,
  ResourceRerankError,
  type ResourceRerankDecision,
} from "../ai/resource-reranker.js";
import type { LLMProvider } from "../ai/llm-provider.js";

const execFileAsync = promisify(execFile);
const EXPECTED_CASE_COUNT = 6;
const REPOSITORY_ROOT = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
const GOLDEN_QUERY_FILE = resolve(REPOSITORY_ROOT, "tests/eval-queries.json");
const GOLDEN_CASE_FILE = resolve(
  REPOSITORY_ROOT,
  "tests/reranker-golden-cases.json",
);
const RESULT_ROOT = resolve(
  REPOSITORY_ROOT,
  "data/eval-results/way-53",
);
const GOLDEN_RUN_DEADLINE_MS = 20_000;

const GoldenCandidateSchema = z.strictObject({
  candidateId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  title: z.string().trim().min(1).max(500),
  canonicalUrl: z.url().refine(url => url.startsWith("https://")),
  domain: z.string().trim().min(1).max(253),
  snippet: z.string().trim().min(1).max(1_000),
  publishedAt: z.iso.datetime({ offset: true }).optional(),
  content: z.string().trim().min(1).max(8_000),
});

const GoldenCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.string().trim().min(1),
  rankingProfile: z.enum([
    "knowledge",
    "news",
    "shopping",
    "software",
    "general",
  ]),
  nodeTitle: z.string().trim().min(1).max(200),
  nodeDescription: z.string().trim().min(1).max(500),
  query: z.string().trim().min(1).max(200),
  expectedTopCandidateId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  rationale: z.string().trim().min(1).max(500),
  candidates: z.array(GoldenCandidateSchema).min(2).max(6),
});

const GoldenQuerySchema = z.strictObject({
  id: z.string().regex(/^wfq-\d{3}$/),
  query: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1),
  rationale: z.string().trim().min(1).max(500),
});

const GoldenQueryFileSchema = z
  .array(GoldenQuerySchema)
  .length(EXPECTED_CASE_COUNT);

const GoldenCaseFileSchema = z
  .array(GoldenCaseSchema)
  .length(EXPECTED_CASE_COUNT)
  .superRefine((cases, context) => {
    const caseIds = cases.map(goldenCase => goldenCase.id);
    if (new Set(caseIds).size !== caseIds.length) {
      context.addIssue({ code: "custom", message: "Golden Case ID 必须唯一" });
    }

    for (const [caseIndex, goldenCase] of cases.entries()) {
      const candidateIds = goldenCase.candidates.map(
        candidate => candidate.candidateId,
      );
      const canonicalUrls = goldenCase.candidates.map(
        candidate => candidate.canonicalUrl,
      );
      if (
        new Set(candidateIds).size !== candidateIds.length ||
        !candidateIds.includes(goldenCase.expectedTopCandidateId)
      ) {
        context.addIssue({
          code: "custom",
          path: [caseIndex, "candidates"],
          message: "Candidate ID 必须唯一且包含 expectedTopCandidateId",
        });
      }
      if (new Set(canonicalUrls).size !== canonicalUrls.length) {
        context.addIssue({
          code: "custom",
          path: [caseIndex, "candidates"],
          message: "Candidate canonicalUrl 必须唯一",
        });
      }
    }
  });

const GoldenEnvironmentSchema = z.object({
  LLM_PROVIDER: z.literal("deepseek"),
  LLM_MODEL: z.literal("deepseek-flash"),
  LLM_API_KEY: z.string().trim().min(1),
  RERANK_TIMEOUT_MS: z
    .string()
    .regex(/^[1-9]\d*$/)
    .default("12000")
    .transform(value => Number.parseInt(value, 10))
    .pipe(z.number().int().min(1).max(15_000)),
});

export type ResourceRerankerGoldenCase = z.infer<
  typeof GoldenCaseSchema
>;

export type ResourceRerankerGoldenQuery = z.infer<typeof GoldenQuerySchema>;

export type ResourceRerankerGoldenResult = Readonly<{
  id: string;
  category: string;
  rankingProfile: RankingProfile;
  expectedTopCandidateId: string;
  rationale: string;
  status: "completed" | "failed";
  elapsedMs: number;
  actualOrder: readonly string[];
  topCandidateMatched: boolean;
  decisions: readonly ResourceRerankDecision[];
  tokenUsage: DeepSeekTokenUsage | "unavailable";
  failureKind?: string;
}>;

type GitBaseline = Readonly<{
  commit: string;
  worktreeClean: true;
}>;

export function assertResourceRerankerGoldenLiveMode(
  args: readonly string[],
): void {
  const direct = args.length === 1 && args[0] === "--live";
  const forwarded =
    args.length === 2 && args[0] === "--" && args[1] === "--live";
  if (!direct && !forwarded) {
    throw new Error(
      "Reranker Golden Eval 默认禁止真实调用；仅在人员明确授权后使用 --live",
    );
  }
}

/** 只加载项目约定且被 Git 忽略的 `.env.local`，不存在时继续使用进程环境。 */
function loadLocalEnvironmentIfPresent(): void {
  try {
    process.loadEnvFile(resolve(REPOSITORY_ROOT, ".env.local"));
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : undefined;
    if (code !== "ENOENT") {
      // 原始文件错误可能携带个人绝对路径，安全边界要求重新投影且不能附加 cause。
      // eslint-disable-next-line preserve-caught-error
      throw new Error("无法加载 Golden Eval 本地环境配置");
    }
  }
}

export async function readResourceRerankerGoldenQueries(): Promise<
  readonly ResourceRerankerGoldenQuery[]
> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(GOLDEN_QUERY_FILE, "utf8"));
  } catch {
    throw new Error("无法读取固定 Golden Query 文件");
  }

  const parsed = GoldenQueryFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("固定 Golden Query 文件结构无效");
  }
  return parsed.data;
}

export async function readResourceRerankerGoldenCases(): Promise<
  readonly ResourceRerankerGoldenCase[]
> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(GOLDEN_CASE_FILE, "utf8"));
  } catch {
    throw new Error("无法读取 Reranker Golden Case 文件");
  }

  const parsed = GoldenCaseFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Reranker Golden Case 文件结构无效");
  }

  // 技术架构把 tests/eval-queries.json 定义为固定 Query 单一事实来源；
  // Reranker Fixture 只补充候选证据，不得另造一套看似通过的 Query 集合。
  const queries = await readResourceRerankerGoldenQueries();
  for (const [index, goldenCase] of parsed.data.entries()) {
    const query = queries[index];
    if (
      query === undefined ||
      goldenCase.id !== query.id ||
      goldenCase.query !== query.query ||
      goldenCase.category !== query.category ||
      goldenCase.rationale !== query.rationale
    ) {
      throw new Error("Reranker Golden Case 与固定 Golden Query 不一致");
    }
  }
  return parsed.data;
}

function createRuntimeInput(goldenCase: ResourceRerankerGoldenCase): {
  node: GraphNodeCore;
  candidates: ResourceCandidate[];
  pages: ExtractedPage[];
} {
  const node: GraphNodeCore = {
    id: goldenCase.id,
    title: goldenCase.nodeTitle,
    description: goldenCase.nodeDescription,
    nodeType: "primary",
    layer: 0,
    searchPlan: {
      queries: [goldenCase.query],
      maxResults: 20,
      rankingProfile: goldenCase.rankingProfile,
      providerHints: ["general"],
    },
  };
  const candidates = goldenCase.candidates.map((candidate, index) => ({
    candidateId: candidate.candidateId,
    hit: {
      provider: "golden-fixture",
      query: goldenCase.query,
      title: candidate.title,
      url: candidate.canonicalUrl,
      canonicalUrl: candidate.canonicalUrl,
      domain: candidate.domain,
      snippet: candidate.snippet,
      providerRank: index + 1,
      ...(candidate.publishedAt === undefined
        ? {}
        : { publishedAt: candidate.publishedAt }),
    },
    heuristicScore: 0,
    heuristicSignals: {},
  }));
  const pages = goldenCase.candidates.map(candidate => ({
    canonicalUrl: candidate.canonicalUrl,
    content: candidate.content,
  }));
  return { node, candidates, pages };
}

function summarizeTokenUsage(
  usages: readonly DeepSeekTokenUsage[],
): DeepSeekTokenUsage | "unavailable" {
  if (usages.length === 0) {
    return "unavailable";
  }
  return usages.reduce(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      totalTokens: total.totalTokens + usage.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

export async function evaluateResourceRerankerGoldenCase(input: {
  goldenCase: ResourceRerankerGoldenCase;
  provider: LLMProvider;
  timeoutMs: number;
  readTokenUsages?: () => readonly DeepSeekTokenUsage[];
  now?: () => number;
}): Promise<ResourceRerankerGoldenResult> {
  const startedAt = performance.now();
  const runtime = createRuntimeInput(input.goldenCase);
  const signal = AbortSignal.timeout(GOLDEN_RUN_DEADLINE_MS);

  try {
    const decisions = await rerankResources({
      ...runtime,
      provider: input.provider,
      signal,
      timeoutMs: input.timeoutMs,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    const actualOrder = decisions.map(decision => decision.candidateId);
    return {
      id: input.goldenCase.id,
      category: input.goldenCase.category,
      rankingProfile: input.goldenCase.rankingProfile,
      expectedTopCandidateId: input.goldenCase.expectedTopCandidateId,
      rationale: input.goldenCase.rationale,
      status: "completed",
      elapsedMs: Math.round(performance.now() - startedAt),
      actualOrder,
      topCandidateMatched:
        actualOrder[0] === input.goldenCase.expectedTopCandidateId,
      decisions,
      tokenUsage: summarizeTokenUsage(input.readTokenUsages?.() ?? []),
    };
  } catch (error: unknown) {
    return {
      id: input.goldenCase.id,
      category: input.goldenCase.category,
      rankingProfile: input.goldenCase.rankingProfile,
      expectedTopCandidateId: input.goldenCase.expectedTopCandidateId,
      rationale: input.goldenCase.rationale,
      status: "failed",
      elapsedMs: Math.round(performance.now() - startedAt),
      actualOrder: [],
      topCandidateMatched: false,
      decisions: [],
      tokenUsage: summarizeTokenUsage(input.readTokenUsages?.() ?? []),
      failureKind:
        error instanceof ResourceRerankError
          ? error.kind
          : signal.aborted
            ? "run_interrupted"
            : "unexpected_internal_error",
    };
  }
}

/**
 * 运行结果必须可定位到完整工作区快照；未跟踪源码同样可能改变人工结论，
 * 因此不能像普通只读检查一样只验证 tracked 文件。
 */
export function assertResourceRerankerGoldenGitStatus(status: string): void {
  if (status.trim().length > 0) {
    throw new Error("Golden Eval 需要已提交且工作区干净的代码");
  }
}

async function readGitBaseline(): Promise<GitBaseline> {
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
    assertResourceRerankerGoldenGitStatus(status);
    return { commit: commit.trim(), worktreeClean: true };
  } catch {
    throw new Error("Golden Eval 需要已提交且工作区干净的代码");
  }
}

function createRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function createOutputDirectory(outputDirectory: string): Promise<void> {
  await mkdir(RESULT_ROOT, { recursive: true, mode: 0o700 });
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(RESULT_ROOT, 0o700);
    await chmod(outputDirectory, 0o700);
  }
}

function renderHumanReview(results: readonly ResourceRerankerGoldenResult[]): string {
  const sections = results.map(result => `## ${result.id}

- Profile：${result.rankingProfile}
- 预期 Top：${result.expectedTopCandidateId}
- 实际顺序：${result.actualOrder.join(" → ") || "未完成"}
- 自动 Top 匹配：${result.topCandidateMatched ? "是" : "否"}
- 人工评分（1～5）：待填写
- 人工结论（pass / targetedIterate / fail / inconclusive）：待填写
- 审核说明：待填写

### Rerank Decisions

\`\`\`json
${JSON.stringify(result.decisions, null, 2)}
\`\`\``);

  return `# WAY-53 Resource Reranker Golden 人工审核

> 仅评估固定脱敏 Fixture 的排序、summary 与 whySelected。不得把本文件提交到 Git。

${sections.join("\n\n")}
`;
}

async function runResourceRerankerGolden(): Promise<string> {
  const [git, cases] = await Promise.all([
    readGitBaseline(),
    readResourceRerankerGoldenCases(),
  ]);
  const environment = GoldenEnvironmentSchema.parse(process.env);
  const runId = createRunId();
  const outputDirectory = resolve(RESULT_ROOT, runId);
  await createOutputDirectory(outputDirectory);
  await writeJson(resolve(outputDirectory, "run-state.json"), {
    issue: "WAY-53",
    runId,
    status: "incomplete",
  });

  try {
    const results: ResourceRerankerGoldenResult[] = [];
    for (const goldenCase of cases) {
      const tokenUsages: DeepSeekTokenUsage[] = [];
      const provider = new DeepSeekLLMProvider({
        apiKey: environment.LLM_API_KEY,
        onTokenUsage: usage => tokenUsages.push(usage),
      });
      results.push(
        await evaluateResourceRerankerGoldenCase({
          goldenCase,
          provider,
          timeoutMs: environment.RERANK_TIMEOUT_MS,
          readTokenUsages: () => tokenUsages,
        }),
      );
    }

    const completed = results.filter(result => result.status === "completed");
    const report = {
      schemaVersion: 1,
      issue: "WAY-53",
      runId,
      completedAt: new Date().toISOString(),
      source: {
        git,
        caseFile: "tests/reranker-golden-cases.json",
        promptVersion: RESOURCE_RERANKER_PROMPT_VERSION,
        llmProvider: DEEPSEEK_LLM_PROVIDER_ID,
        llmModel: DEEPSEEK_LLM_MODEL,
      },
      runPolicy: {
        execution: "sequential",
        repetitionsPerCase: 1,
        maximumLlmCalls: EXPECTED_CASE_COUNT,
        searchCalls: 0,
        extractCalls: 0,
        estimatedCost: "unavailable",
      },
      automatedSummary: {
        caseCount: results.length,
        completedCount: completed.length,
        topCandidateMatchCount: completed.filter(
          result => result.topCandidateMatched,
        ).length,
        totalLatencyMs: results.reduce(
          (sum, result) => sum + result.elapsedMs,
          0,
        ),
        actualLlmCalls: results.length,
        engineeringDisposition:
          completed.length === results.length
            ? "awaitingHumanReview"
            : "executionIncomplete",
      },
      humanReview: {
        status: "pending",
        scoreScale: "1-5",
        automaticPassThreshold: null,
      },
      results,
    };

    await writeJson(resolve(outputDirectory, "report.json"), report);
    await writeFile(
      resolve(outputDirectory, "human-review.md"),
      renderHumanReview(results),
      { encoding: "utf8", mode: 0o600 },
    );
    await writeJson(resolve(outputDirectory, "run-state.json"), {
      issue: "WAY-53",
      runId,
      status: "completed",
    });
    return `data/eval-results/way-53/${runId}`;
  } catch {
    try {
      await writeJson(resolve(outputDirectory, "run-state.json"), {
        issue: "WAY-53",
        runId,
        status: "failed",
        failureKind: "unexpected_internal_error",
      });
    } catch {
      // 状态写入失败时也不得把绝对路径或原始错误带到终端。
    }
    throw new Error("Reranker Golden Eval 执行失败；已保留脱敏失败状态");
  }
}

async function main(): Promise<void> {
  try {
    assertResourceRerankerGoldenLiveMode(process.argv.slice(2));
    loadLocalEnvironmentIfPresent();
    const outputDirectory = await runResourceRerankerGolden();
    process.stdout.write(`WAY-53 Reranker Golden Eval 已完成：${outputDirectory}\n`);
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Reranker Golden Eval 发生未知程序错误";
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
