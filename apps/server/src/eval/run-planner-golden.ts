/**
 * 模块职责：从唯一 Golden Query 数据源串行执行 WAY-43 Planner 基线，
 * 并把机器报告与中文人工审核表写入被 Git 忽略的受控结果目录。
 *
 * 安全边界：
 * - 缺少唯一 `--live` 参数时，在读取 Secret、创建 Provider 或发起网络前立即拒绝；
 * - 正式基线只允许在干净 Commit 上运行，确保报告可追溯；
 * - 输出不保存 Evidence、URL、网页正文、Provider 原始响应、错误堆栈或 Secret；
 * - 本入口不属于普通 CI，且绝不调用 Extract。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  GRAPH_PLANNER_PROMPT_VERSION,
} from "../ai/prompts/graph-planner.v1.js";
import {
  GRAPH_REVISER_PROMPT_VERSION,
} from "../ai/prompts/graph-reviser.v1.js";
import {
  DEEPSEEK_LLM_MODEL,
  DEEPSEEK_LLM_PROVIDER_ID,
  DeepSeekLLMProvider,
} from "../ai/providers/deepseek-llm-provider.js";
import type { DeepSeekTokenUsage } from "../ai/providers/deepseek-llm-provider.js";
import { parseServerConfig } from "../config.js";
import { SerpApiBingSearchProvider } from "../search/providers/serpapi-bing.js";
import {
  evaluatePlannerGoldenQuery,
  PLANNER_GOLDEN_RUN_DEADLINE_MS,
} from "./planner-golden.js";
import type {
  PlannerGoldenCompletedResult,
  PlannerGoldenQuery,
  PlannerGoldenQueryResult,
} from "./planner-golden.js";
import { encodeMarkdownArtifactText } from "./markdown-artifact.js";

const EXPECTED_GOLDEN_QUERY_COUNT = 6;
const REPOSITORY_ROOT = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
const GOLDEN_QUERY_FILE = resolve(REPOSITORY_ROOT, "tests/eval-queries.json");
const RESULT_ROOT = resolve(
  REPOSITORY_ROOT,
  "data/eval-results/way-43",
);

const GoldenQueryFileSchema = z
  .array(
    z.strictObject({
      id: z.string().trim().min(1),
      query: z.string().trim().min(1).max(2_000),
      category: z.string().trim().min(1),
      rationale: z.string().trim().min(1),
    }),
  )
  .length(EXPECTED_GOLDEN_QUERY_COUNT)
  .superRefine((queries, context) => {
    const ids = queries.map(query => query.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Golden Query ID 必须唯一",
      });
    }
  });

type GitBaseline = Readonly<{
  commit: string;
  worktreeClean: true;
}>;

type PlannerGoldenSuiteReport = Readonly<{
  schemaVersion: 1;
  issue: "WAY-43";
  runId: string;
  completedAt: string;
  testCharter: Readonly<{
    decisionQuestion: string;
    testType: "ai_provider_quality_validation";
    startCondition: string;
    testedBuild: string;
    participantStrategy: string;
    stopRule: string;
    privacyRule: string;
    queryPolicy: string;
    strategyPolicy: string;
    semanticReviewPolicy: string;
  }>;
  source: Readonly<{
    git: GitBaseline;
    queryFile: "tests/eval-queries.json";
    plannerPromptVersion: typeof GRAPH_PLANNER_PROMPT_VERSION;
    reviserPromptVersion: typeof GRAPH_REVISER_PROMPT_VERSION;
    llmProvider: typeof DEEPSEEK_LLM_PROVIDER_ID;
    llmModel: typeof DEEPSEEK_LLM_MODEL;
    searchProvider: "serpapi_bing";
  }>;
  runPolicy: Readonly<{
    repetitionsPerQuery: 1;
    execution: "sequential";
    runDeadlineMs: typeof PLANNER_GOLDEN_RUN_DEADLINE_MS;
    llmStageTimeoutMs: number;
    liveCalls: true;
    extract: "notApplicable";
    estimatedCost: "unavailable";
    maximumCalls: Readonly<{
      llm: 18;
      logicalSearch: 18;
      searchHttpAttempts: 36;
      extract: 0;
    }>;
  }>;
  automatedSummary: Readonly<{
    queryCount: number;
    completedCount: number;
    interruptedCount: number;
    schemaValidPlanCount: number;
    fallbackCount: number;
    observedStrategies: readonly ("evidence_assisted" | "plan_first")[];
    bothStrategiesObserved: boolean;
    engineeringDisposition:
      | "awaitingHumanReview"
      | "executionIncomplete"
      | "insufficientStrategyEvidence";
    actualCalls: Readonly<{
      llm: number;
      logicalSearch: number;
      searchHttpAttempts: number | "unavailable";
      extract: 0;
    }>;
  }>;
  humanReview: Readonly<{
    status: "pending";
    scoreScale: "1-5";
    automaticPassThreshold: null;
    allowedOutcomes: readonly [
      "pass",
      "targetedIterate",
      "fail",
      "inconclusive",
    ];
  }>;
  artifactPolicy: Readonly<{
    localOnly: true;
    automaticUpload: false;
    automaticDeletion: false;
    retention: "until_human_review_and_controlled_sync_decision";
  }>;
  results: readonly PlannerGoldenQueryResult[];
}>;

export function assertPlannerGoldenLiveMode(args: readonly string[]): void {
  const direct = args.length === 1 && args[0] === "--live";
  // 根 pnpm 脚本按文档使用 `-- --live` 时，会把第一个 `--` 继续传给子脚本。
  const forwarded =
    args.length === 2 && args[0] === "--" && args[1] === "--live";
  if (!direct && !forwarded) {
    throw new Error(
      "Golden Eval 默认禁止真实调用；仅在人员明确授权后使用 --live",
    );
  }
}

/** Node 原生加载器避免新增 dotenv；仅在 live guard 已通过后读取本地配置文件。 */
function loadLocalEnvironmentIfPresent(): void {
  try {
    process.loadEnvFile(resolve(REPOSITORY_ROOT, ".env.local"));
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : undefined;
    if (code !== "ENOENT") {
      // 原始文件错误可能携带个人目录；安全边界要求重新投影，不能附加 cause。
      // eslint-disable-next-line preserve-caught-error
      throw new Error("无法读取 Golden Eval 本地环境配置");
    }
  }
}

function runGit(args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      [...args],
      { cwd: REPOSITORY_ROOT, encoding: "utf8" },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(new Error("无法读取 Golden Eval 的 Git 基线"));
          return;
        }
        resolvePromise(stdout.trim());
      },
    );
  });
}

async function readCleanGitBaseline(): Promise<GitBaseline> {
  const [commit, status] = await Promise.all([
    runGit(["rev-parse", "HEAD"]),
    runGit(["status", "--porcelain", "--untracked-files=normal"]),
  ]);

  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("Golden Eval 无法确认 Git Commit");
  }
  if (status.length > 0) {
    throw new Error("Golden Eval 正式基线要求干净工作树");
  }
  return { commit, worktreeClean: true };
}

async function readGoldenQueries(): Promise<readonly PlannerGoldenQuery[]> {
  let serialized: string;
  try {
    serialized = await readFile(GOLDEN_QUERY_FILE, "utf8");
  } catch {
    throw new Error("无法读取 Golden Query 数据源");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(serialized);
  } catch {
    throw new Error("Golden Query 数据源不是合法 JSON");
  }
  const result = GoldenQueryFileSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error("Golden Query 数据源不满足冻结结构");
  }
  return result.data;
}

function createRunId(now = new Date()): string {
  const timestamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

// 保留既有导出名，共用第三个 Eval Markdown 消费者触发的单一编码实现。
export const encodeMarkdownText = encodeMarkdownArtifactText;

function formatFallback(result: PlannerGoldenCompletedResult): string {
  return result.fallback === null
    ? "无"
    : `${result.fallback.stage}:${result.fallback.reason}`;
}

export function renderCompletedReview(
  result: PlannerGoldenCompletedResult,
): string {
  const nodes = result.finalPlan.nodes
    .map((node, index) => `### Node ${index + 1}

- Node ID：${encodeMarkdownText(node.id)}
- 类型：\`${node.nodeType}\`
- 标题：${encodeMarkdownText(node.title)}
- 描述：${encodeMarkdownText(node.description)}
- SearchPlan Queries：${node.searchPlan.queries.map(encodeMarkdownText).join("；")}
- 必要性 1～5：
- 粒度 1～5：
- 与其他 Node 不重复 1～5：
- 推荐顺序合理性 1～5（不适用写 N/A）：
- Related 相关性 1～5（非 Related 写 N/A）：
- SearchPlan 质量 1～5：
- 备注：
`)
    .join("\n");
  const edges = result.finalPlan.edges.length === 0
    ? "| 无 | 无 | 无 |  |"
    : result.finalPlan.edges
        .map(edge =>
          `| ${encodeMarkdownText(edge.source)} | ${encodeMarkdownText(edge.target)} | ${edge.type} |  |`,
        )
        .join("\n");
  const strategy = result.strategy ?? "unavailable（Planner fallback）";
  const presentationMode =
    result.presentationMode ?? "unavailable（Planner fallback）";

  return `## ${encodeMarkdownText(result.query.id)}

- Query：${encodeMarkdownText(result.query.query)}
- 分类：${encodeMarkdownText(result.query.category)}
- 实际 Strategy：\`${strategy}\`
- Presentation Mode：\`${presentationMode}\`
- 回退：${formatFallback(result)}
- 自动指标：Schema ${result.metrics.schemaValid}，Validator ${result.metrics.validatorValid}，DAG ${result.metrics.dagValid}，Node ${result.metrics.nodeCount}，Edge ${result.metrics.edgeCount}，Edge Coverage ${result.metrics.edgeCoverage}
- 报告净化：Evidence ${result.reportSanitization.evidenceRedactionCount}，URL ${result.reportSanitization.urlRedactionCount}，截断字段 ${result.reportSanitization.truncatedFieldCount}

### Node 人工评分

${nodes}

### Edge 人工审核

| Source | Target | 类型 | 语义与推荐顺序备注 |
| --- | --- | --- | --- |
${edges}

- 语义重复 Node 对（填写 Node ID，并说明理由）：
- Strategy 质量 1～5：
- Strategy 判断说明：合适 / 不合适 / 不确定
- Overall Outcome：pass / targetedIterate / fail / inconclusive
- 审核备注：
`;
}

function renderInterruptedReview(result: Exclude<PlannerGoldenQueryResult, PlannerGoldenCompletedResult>): string {
  return `## ${encodeMarkdownText(result.query.id)}

- Query：${encodeMarkdownText(result.query.query)}
- 分类：${encodeMarkdownText(result.query.category)}
- 执行状态：\`${result.executionStatus}\`
- 自动 Outcome：无（由人员判断）
- 人工 Outcome：pass / targetedIterate / fail / inconclusive
- 审核备注：
`;
}

export function renderHumanReview(report: PlannerGoldenSuiteReport): string {
  const sections = report.results.map(result =>
    result.executionStatus === "completed"
      ? renderCompletedReview(result)
      : renderInterruptedReview(result),
  );

  return `# WAY-43 Planner Golden 人工审核表

- Run ID：\`${report.runId}\`
- Git Commit：\`${report.source.git.commit}\`
- Planner Prompt：\`${report.source.plannerPromptVersion}\`
Reviser Prompt：\`${report.source.reviserPromptVersion}\`

## Test Charter（测试章程）

- 决策问题：${report.testCharter.decisionQuestion}
- 测试类型：\`${report.testCharter.testType}\`
- 开始条件：${report.testCharter.startCondition}
- 被测构建：\`${report.testCharter.testedBuild}\`
- 参与者策略：${report.testCharter.participantStrategy}
- 停止规则：${report.testCharter.stopRule}
- 隐私规则：${report.testCharter.privacyRule}
- Query 政策：${report.testCharter.queryPolicy}
- Strategy 政策：${report.testCharter.strategyPolicy}
- 语义审核政策：${report.testCharter.semanticReviewPolicy}

## 汇总结论

- Outcome：pass / targetedIterate / fail / inconclusive
- Node 必要性总体观察：
- Node 粒度总体观察：
- 语义重复总体观察：
- Edge Coverage 与推荐顺序观察：
- Strategy 观察：
- SearchPlan 观察：
- 支持证据：
- 反对证据：
- 有效 Query / 任务覆盖：
- 协议偏差：
- 失效证据：
- 下一轮只允许调整的单一变量：
- 下一步：

${sections.join("\n")}
`;
}

export function summarizeResults(
  results: readonly PlannerGoldenQueryResult[],
): PlannerGoldenSuiteReport["automatedSummary"] {
  const completed = results.filter(
    (result): result is PlannerGoldenCompletedResult =>
      result.executionStatus === "completed",
  );
  const observedStrategies = ["plan_first", "evidence_assisted"].filter(
    (strategy): strategy is "evidence_assisted" | "plan_first" =>
      completed.some(result => result.strategy === strategy),
  );
  const fallbackCount = completed.filter(result => result.fallback !== null).length;
  const interruptedCount = results.length - completed.length;
  const bothStrategiesObserved = observedStrategies.length === 2;
  const engineeringDisposition = interruptedCount > 0
    ? "executionIncomplete"
    : !bothStrategiesObserved
      ? "insufficientStrategyEvidence"
      : "awaitingHumanReview";
  const httpAttemptCounts = results.map(
    result => result.calls.searchHttpAttempts,
  );
  const searchHttpAttempts = httpAttemptCounts.every(
    (count): count is number => typeof count === "number",
  )
    ? httpAttemptCounts.reduce((total, count) => total + count, 0)
    : "unavailable";

  return {
    queryCount: results.length,
    completedCount: completed.length,
    interruptedCount,
    schemaValidPlanCount: completed.filter(
      result => result.metrics.schemaValid && result.metrics.validatorValid,
    ).length,
    fallbackCount,
    observedStrategies,
    bothStrategiesObserved,
    engineeringDisposition,
    actualCalls: {
      llm: results.reduce((total, result) => total + result.calls.llm, 0),
      logicalSearch: results.reduce(
        (total, result) => total + result.calls.search,
        0,
      ),
      searchHttpAttempts,
      extract: 0,
    },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function createPrivateOutputDirectory(
  outputDirectory: string,
): Promise<void> {
  try {
    await mkdir(RESULT_ROOT, { recursive: true, mode: 0o700 });
    await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
    // Windows 使用宿主 ACL；POSIX 平台显式收紧已存在父目录的权限。
    if (process.platform !== "win32") {
      await chmod(RESULT_ROOT, 0o700);
      await chmod(outputDirectory, 0o700);
    }
  } catch {
    throw new Error("无法创建 Golden Eval 私有输出目录");
  }
}

async function runPlannerGolden(): Promise<string> {
  const [git, queries] = await Promise.all([
    readCleanGitBaseline(),
    readGoldenQueries(),
  ]);
  const config = parseServerConfig(process.env);
  const runId = createRunId();
  const outputDirectory = resolve(RESULT_ROOT, runId);
  await createPrivateOutputDirectory(outputDirectory);
  try {
    await writeJson(resolve(outputDirectory, "run-state.json"), {
      issue: "WAY-43",
      runId,
      status: "incomplete",
    });
  } catch {
    throw new Error("无法初始化 Golden Eval 脱敏状态文件");
  }

  try {
    const results: PlannerGoldenQueryResult[] = [];

    // 串行是 Test Charter 的一部分，避免并发限流与资源竞争扭曲首次基线。
    for (const query of queries) {
      const tokenUsages: DeepSeekTokenUsage[] = [];
      let searchHttpAttempts = 0;
      const llmProvider = new DeepSeekLLMProvider({
        apiKey: config.llmApiKey,
        onTokenUsage: usage => tokenUsages.push(usage),
      });
      const searchProvider = new SerpApiBingSearchProvider({
        apiKey: config.serpApiKey,
        searchTimeoutMs: config.timeouts.searchMs,
        onAttempt: () => {
          searchHttpAttempts += 1;
        },
      });
      results.push(
        await evaluatePlannerGoldenQuery({
          query,
          llmProvider,
          searchProvider,
          readTokenUsages: () => tokenUsages,
          readSearchHttpAttemptCount: () => searchHttpAttempts,
          llmStageTimeoutMs: config.timeouts.plannerMs,
        }),
      );
    }

    const report: PlannerGoldenSuiteReport = {
      schemaVersion: 1,
      issue: "WAY-43",
      runId,
      completedAt: new Date().toISOString(),
      testCharter: {
        decisionQuestion: "当前 Planner 是否具备进入 Node Retrieval 开发前的合法性与可人工评审产品形态证据？",
        testType: "ai_provider_quality_validation",
        startCondition: "Harness 确定性检查通过、工作树为干净 Commit，且人员明确批准本次 live 调用",
        testedBuild: git.commit,
        participantStrategy: "由具备项目审核权限的人员独立评分；不记录身份信息，人数不作为完成条件",
        stopRule: "六条固定 Query 各完成一次并记录人工四态结论；协议偏差或证据污染时以证据不足结束",
        privacyRule: "不保存 Secret、Provider 原始响应、Evidence/URL/网页正文、原始错误或可识别个人信息",
        queryPolicy: "六条固定 Query 各串行运行一次",
        strategyPolicy: "不硬编码预期 Strategy；记录实际选择并检查双策略覆盖",
        semanticReviewPolicy: "语义质量由人员按 1～5 分记录，不设置自动通过阈值",
      },
      source: {
        git,
        queryFile: "tests/eval-queries.json",
        plannerPromptVersion: GRAPH_PLANNER_PROMPT_VERSION,
        reviserPromptVersion: GRAPH_REVISER_PROMPT_VERSION,
        llmProvider: DEEPSEEK_LLM_PROVIDER_ID,
        llmModel: DEEPSEEK_LLM_MODEL,
        searchProvider: "serpapi_bing",
      },
      runPolicy: {
        repetitionsPerQuery: 1,
        execution: "sequential",
        runDeadlineMs: PLANNER_GOLDEN_RUN_DEADLINE_MS,
        llmStageTimeoutMs: config.timeouts.plannerMs,
        liveCalls: true,
        extract: "notApplicable",
        estimatedCost: "unavailable",
        maximumCalls: {
          llm: 18,
          logicalSearch: 18,
          searchHttpAttempts: 36,
          extract: 0,
        },
      },
      automatedSummary: summarizeResults(results),
      humanReview: {
        status: "pending",
        scoreScale: "1-5",
        automaticPassThreshold: null,
        allowedOutcomes: [
          "pass",
          "targetedIterate",
          "fail",
          "inconclusive",
        ],
      },
      artifactPolicy: {
        localOnly: true,
        automaticUpload: false,
        automaticDeletion: false,
        retention: "until_human_review_and_controlled_sync_decision",
      },
      results,
    };

    await writeJson(resolve(outputDirectory, "report.json"), report);
    await writeFile(
      resolve(outputDirectory, "human-review.md"),
      renderHumanReview(report),
      { encoding: "utf8", mode: 0o600 },
    );
    await writeJson(resolve(outputDirectory, "run-state.json"), {
      issue: "WAY-43",
      runId,
      status: "completed",
    });
    return `data/eval-results/way-43/${runId}`;
  } catch {
    try {
      await writeJson(resolve(outputDirectory, "run-state.json"), {
        issue: "WAY-43",
        runId,
        status: "failed",
        failureKind: "unexpected_internal_error",
      });
    } catch {
      // 状态写入失败不允许把原始文件系统错误或个人绝对路径带到终端。
    }
    throw new Error("Golden Eval 执行失败；已保留脱敏失败状态");
  }
}

async function main(): Promise<void> {
  try {
    assertPlannerGoldenLiveMode(process.argv.slice(2));
    loadLocalEnvironmentIfPresent();
    const outputDirectory = await runPlannerGolden();
    process.stdout.write(`WAY-43 Golden Eval 已完成：${outputDirectory}\n`);
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Golden Eval 发生未知程序错误";
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
