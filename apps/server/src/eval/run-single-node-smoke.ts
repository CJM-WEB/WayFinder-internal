/**
 * 模块职责：以三个固定 Case（样例）受控运行真实单 Node Pipeline，并生成仅供本地
 * 人工审核的脱敏报告。
 *
 * 安全边界：
 * - 只有唯一 `--live` 参数可越过真实调用闸门，普通 CI 只导入并测试纯执行函数；
 * - 每个 Case 独占 40 秒安全截止信号并串行执行，不实现 D4 Orchestrator 语义；
 * - 报告只保存公共 Resource 投影与聚合指标，不保存正文、Prompt、原始响应或错误对象。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  GraphPlanNodeSchema,
  QueryAnalysisSchema,
  ResultGraphNodeSchema,
  StreamEventPayloadSchema,
  type GraphPlanNode,
  type NodeWarningCode,
  type ProviderSearchRequest,
  type QueryAnalysis,
  type Resource,
} from "@wayfinder/contracts";
import { z } from "zod";

import type {
  LLMCallOptions,
  LLMProvider,
  StructuredLLMInput,
} from "../ai/llm-provider.js";
import { RESOURCE_RERANKER_PROMPT_VERSION } from "../ai/prompts/resource-reranker.v2.js";
import {
  DEEPSEEK_LLM_MODEL,
  DEEPSEEK_LLM_PROVIDER_ID,
  DeepSeekLLMProvider,
  type DeepSeekTokenUsage,
} from "../ai/providers/deepseek-llm-provider.js";
import {
  RUN_DEADLINE_MS,
  parseServerConfig,
  type ServerConfig,
} from "../config.js";
import {
  NodeEventEmissionError,
  NodeJobError,
  processNode,
  type NodeStatusEventPayload,
} from "../pipeline/process-node.js";
import type { SearchProvider } from "../search/provider.js";
import {
  SerpApiBingSearchProvider,
  type SerpApiBingAttemptObservation,
} from "../search/providers/serpapi-bing.js";
import { encodeMarkdownArtifactText } from "./markdown-artifact.js";

const execFileAsync = promisify(execFile);
const EXPECTED_CASE_COUNT = 3;
const REPOSITORY_ROOT = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
const GOLDEN_QUERY_FILE = resolve(REPOSITORY_ROOT, "tests/eval-queries.json");
const RESULT_ROOT = resolve(REPOSITORY_ROOT, "data/eval-results/way-107");
const ALLOWED_OUTCOMES = [
  "pass",
  "targetedIterate",
  "fail",
  "inconclusive",
] as const;

type SmokeCategory = "knowledge" | "news" | "software_download";

export type SingleNodeSmokeCase = Readonly<{
  id: "wfq-001" | "wfq-009" | "wfq-013";
  category: SmokeCategory;
  originalQuery: string;
  analysis: QueryAnalysis;
  node: GraphPlanNode;
  expectedTopDomain?: string;
}>;

type CallTiming = Readonly<{ elapsedMs: number }>;

type ProviderTelemetry = Readonly<{
  logicalSearchCalls: number;
  logicalExtractCalls: number;
  extractUrlCount: number;
  logicalLlmCalls: number;
  searchHttpAttempts: number;
  extractHttpAttempts: number;
  searchTimings: readonly CallTiming[];
  extractTimings: readonly CallTiming[];
  rerankTimings: readonly CallTiming[];
  tokenUsage: DeepSeekTokenUsage | "unavailable";
  budgetWithinLimits: boolean;
}>;

type ResultQualityChecks = Readonly<{
  resultContractValid: boolean;
  resourceIdsUnique: boolean;
  canonicalUrlsUnique: boolean;
  ranksUniqueAndSequential: boolean;
  distinctDomainCount: number;
  resourcesWithPublishedAt: number;
  expectedTopDomainMatched: boolean | "notApplicable";
}>;

export type SingleNodeSmokeCaseResult = Readonly<{
  id: SingleNodeSmokeCase["id"];
  category: SmokeCategory;
  originalQuery: string;
  referenceTime: string;
  executionStatus:
    | "completed"
    | "node_failed"
    | "deadline_exceeded"
    | "cancelled"
    | "event_emission_failed"
    | "unexpected_internal_error";
  nodeStatus?: "ready" | "partial";
  terminalEventType?: "node.ready" | "node.partial" | "node.failed";
  terminalEventCount: number;
  elapsedMs: number;
  timeToTerminalMs?: number;
  warnings: readonly NodeWarningCode[];
  errorCode?: string;
  resources: readonly Resource[];
  qualityChecks: ResultQualityChecks;
  telemetry: ProviderTelemetry;
}>;

type MutableProviderTelemetry = {
  logicalSearchCalls: number;
  logicalExtractCalls: number;
  extractUrlCount: number;
  logicalLlmCalls: number;
  searchTimings: CallTiming[];
  extractTimings: CallTiming[];
  rerankTimings: CallTiming[];
  budgetViolation: boolean;
};

type EvaluateSingleNodeSmokeCaseInput = Readonly<{
  smokeCase: SingleNodeSmokeCase;
  searchProvider: SearchProvider;
  rerankProvider: LLMProvider;
  rerankTimeoutMs: number;
  readAttemptObservations?: () => readonly SerpApiBingAttemptObservation[];
  readTokenUsages?: () => readonly DeepSeekTokenUsage[];
  runDeadlineMs?: number;
  parentSignal?: AbortSignal;
  now?: () => number;
  /** 同一受控实验可注入稳定时间，避免条件间墙钟变化成为额外变量。 */
  referenceTime?: string;
}>;

const GoldenQueryFileSchema = z
  .array(
    z.strictObject({
      id: z.string().regex(/^wfq-\d{3}$/u),
      query: z.string().trim().min(1).max(200),
      category: z.string().trim().min(1),
      rationale: z.string().trim().min(1).max(500),
    }),
  )
  .length(6)
  .refine(queries => new Set(queries.map(query => query.id)).size === 6, {
    message: "Golden Query ID 必须唯一",
  });
export type SingleNodeSmokeGoldenQuery = z.infer<
  typeof GoldenQueryFileSchema
>[number];

const FIXED_CASES: readonly SingleNodeSmokeCase[] = [
  {
    id: "wfq-001",
    category: "knowledge",
    originalQuery: "Python",
    analysis: QueryAnalysisSchema.parse({
      intent: "learn",
      topic: "Python",
      freshnessSensitive: false,
      ambiguityLevel: "low",
      presentationMode: "graph",
      broadSearchQueries: [],
      strategy: "plan_first",
    }),
    node: GraphPlanNodeSchema.parse({
      id: "smoke-knowledge",
      title: "安装与开发环境",
      description: "Python 的官方安装方式和基础开发环境",
      nodeType: "primary",
      layer: 0,
      status: "planned",
      searchPlan: {
        queries: [
          "Python official installation guide",
          "Python install Windows macOS official",
        ],
        maxResults: 10,
        rankingProfile: "knowledge",
        providerHints: ["general"],
      },
    }),
  },
  {
    id: "wfq-013",
    category: "news",
    originalQuery: "latest AI news",
    analysis: QueryAnalysisSchema.parse({
      intent: "news",
      topic: "latest AI news",
      freshnessSensitive: true,
      ambiguityLevel: "low",
      presentationMode: "graph",
      broadSearchQueries: ["latest AI news"],
      strategy: "evidence_assisted",
    }),
    node: GraphPlanNodeSchema.parse({
      id: "smoke-news",
      title: "查看最新 AI 新闻",
      description: "优先选择新鲜的一手信息，并区分原创报道与转载。",
      nodeType: "primary",
      layer: 0,
      status: "planned",
      searchPlan: {
        queries: ["latest AI news", "latest AI research announcements"],
        maxResults: 10,
        rankingProfile: "news",
        providerHints: ["general"],
      },
    }),
  },
  {
    id: "wfq-009",
    category: "software_download",
    originalQuery: "VS Code download",
    analysis: QueryAnalysisSchema.parse({
      intent: "navigate",
      topic: "VS Code download",
      freshnessSensitive: false,
      ambiguityLevel: "low",
      presentationMode: "compact",
      broadSearchQueries: [],
      strategy: "plan_first",
    }),
    node: GraphPlanNodeSchema.parse({
      id: "smoke-software-download",
      title: "VS Code 官方下载",
      description: "找到适合当前系统的 Visual Studio Code 官方下载入口",
      nodeType: "primary",
      layer: 0,
      status: "planned",
      searchPlan: {
        queries: [
          "Visual Studio Code official download",
          "site:code.visualstudio.com download VS Code",
        ],
        maxResults: 10,
        rankingProfile: "software",
        providerHints: ["general"],
      },
    }),
    expectedTopDomain: "code.visualstudio.com",
  },
];

export function getSingleNodeSmokeCases(): readonly SingleNodeSmokeCase[] {
  return FIXED_CASES;
}

export function assertSingleNodeSmokeLiveMode(args: readonly string[]): void {
  const direct = args.length === 1 && args[0] === "--live";
  const forwarded =
    args.length === 2 && args[0] === "--" && args[1] === "--live";
  if (!direct && !forwarded) {
    throw new Error(
      "单 Node Smoke 默认禁止真实调用；仅在人员明确授权后使用 --live",
    );
  }
}

export function assertSingleNodeSmokeGitStatus(status: string): void {
  if (status.trim().length > 0) {
    throw new Error("单 Node Smoke 需要已提交且工作区干净的代码");
  }
}

/**
 * `onAttempt` 在 SerpAPI 真正调用 fetch 前执行；先登记再检查可让超额尝试进入报告，
 * 同时通过抛错阻止该次网络副作用。
 */
export function createBoundedSearchAttemptRecorder(input: {
  maximumSearchAttempts: number;
}): {
  record: (observation: SerpApiBingAttemptObservation) => void;
  read: () => readonly SerpApiBingAttemptObservation[];
} {
  const observations: SerpApiBingAttemptObservation[] = [];
  return {
    record: observation => {
      observations.push(observation);
      const operationCount = observations.filter(
        current => current.operation === observation.operation,
      ).length;
      if (operationCount > input.maximumSearchAttempts) {
        throw new Error("单 Node Smoke Search HTTP attempt 预算已耗尽");
      }
    },
    read: () => [...observations],
  };
}

/** 报告字段使用白名单构造；最后再拒绝高风险字段名和 Secret 精确值作为双重防线。 */
export function assertSingleNodeSmokeArtifactSafety(
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

  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      for (const secret of secrets) {
        if (secret.length > 0 && candidate.includes(secret)) {
          throw new Error("单 Node Smoke 工件包含敏感值");
        }
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (typeof candidate !== "object" || candidate === null) {
      return;
    }

    for (const [key, nested] of Object.entries(candidate)) {
      const normalizedKey = key.replace(/[_-]/gu, "").toLowerCase();
      if (forbiddenKeys.has(normalizedKey)) {
        throw new Error("单 Node Smoke 工件包含禁止字段");
      }
      visit(nested);
    }
  };

  visit(value);
}

function elapsedSince(startedAt: number, now: () => number): number {
  return Math.max(0, Math.round(now() - startedAt));
}

function createObservedSearchProvider(
  provider: SearchProvider,
  telemetry: MutableProviderTelemetry,
  now: () => number,
  maximumSearchCalls: number,
  readRemainingDeadlineMs: () => number,
): SearchProvider {
  return {
    id: provider.id,
    capabilities: [...provider.capabilities],
    async search(
      request: ProviderSearchRequest,
      signal: AbortSignal,
    ) {
      readRemainingDeadlineMs();
      if (telemetry.logicalSearchCalls >= maximumSearchCalls) {
        telemetry.budgetViolation = true;
        throw new Error("单 Node Smoke Search 调用预算已耗尽");
      }
      telemetry.logicalSearchCalls += 1;
      const startedAt = now();
      try {
        return await provider.search(request, signal);
      } finally {
        telemetry.searchTimings.push({
          elapsedMs: elapsedSince(startedAt, now),
        });
      }
    },
    ...(provider.extract === undefined
      ? {}
      : {
          async extract(canonicalUrls: string[], signal: AbortSignal) {
            readRemainingDeadlineMs();
            if (
              telemetry.logicalExtractCalls >= 1 ||
              canonicalUrls.length > 5
            ) {
              telemetry.budgetViolation = true;
              throw new Error("单 Node Smoke Extract 调用预算已耗尽");
            }
            telemetry.logicalExtractCalls += 1;
            telemetry.extractUrlCount += canonicalUrls.length;
            const startedAt = now();
            try {
              return await provider.extract!.call(
                provider,
                canonicalUrls,
                signal,
              );
            } finally {
              telemetry.extractTimings.push({
                elapsedMs: elapsedSince(startedAt, now),
              });
            }
          },
        }),
  };
}

function createObservedLlmProvider(
  provider: LLMProvider,
  telemetry: MutableProviderTelemetry,
  now: () => number,
  readRemainingDeadlineMs: () => number,
): LLMProvider {
  return {
    id: provider.id,
    async structured(
      input: StructuredLLMInput,
      options: LLMCallOptions,
    ) {
      const remainingMs = readRemainingDeadlineMs();
      if (telemetry.logicalLlmCalls >= 1) {
        telemetry.budgetViolation = true;
        throw new Error("单 Node Smoke LLM 调用预算已耗尽");
      }
      telemetry.logicalLlmCalls += 1;
      const startedAt = now();
      try {
        // Search/Extract 已消耗的时间必须在 LLM 真正开始时扣除，且共享 Signal 仍守住硬截止。
        return await provider.structured(input, {
          ...options,
          timeoutMs: Math.min(options.timeoutMs, remainingMs),
        });
      } finally {
        telemetry.rerankTimings.push({
          elapsedMs: elapsedSince(startedAt, now),
        });
      }
    },
  };
}

function summarizeTokenUsage(
  usages: readonly DeepSeekTokenUsage[],
  logicalLlmCalls: number,
): DeepSeekTokenUsage | "unavailable" {
  if (usages.length === 0 || usages.length !== logicalLlmCalls) {
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

function readProviderTelemetry(
  telemetry: MutableProviderTelemetry,
  observations: readonly SerpApiBingAttemptObservation[],
  usages: readonly DeepSeekTokenUsage[],
  maximumSearchCalls: number,
): ProviderTelemetry {
  const searchHttpAttempts = observations.filter(
    observation => observation.operation === "search",
  ).length;
  const extractHttpAttempts = 0;
  return {
    logicalSearchCalls: telemetry.logicalSearchCalls,
    logicalExtractCalls: telemetry.logicalExtractCalls,
    extractUrlCount: telemetry.extractUrlCount,
    logicalLlmCalls: telemetry.logicalLlmCalls,
    searchHttpAttempts,
    extractHttpAttempts,
    searchTimings: telemetry.searchTimings,
    extractTimings: telemetry.extractTimings,
    rerankTimings: telemetry.rerankTimings,
    tokenUsage: summarizeTokenUsage(usages, telemetry.logicalLlmCalls),
    budgetWithinLimits:
      !telemetry.budgetViolation &&
      telemetry.logicalSearchCalls <= maximumSearchCalls &&
      telemetry.logicalExtractCalls === 0 &&
      telemetry.extractUrlCount === 0 &&
      telemetry.logicalLlmCalls <= 1 &&
      searchHttpAttempts <= telemetry.logicalSearchCalls * 2 &&
      extractHttpAttempts <= telemetry.logicalExtractCalls * 2,
  };
}

function readQualityChecks(
  resources: readonly Resource[],
  expectedTopDomain: string | undefined,
  resultContractValid: boolean,
): ResultQualityChecks {
  const ids = resources.map(resource => resource.id);
  const canonicalUrls = resources.map(resource => resource.canonicalUrl);
  const ranks = resources.map(resource => resource.rank);
  return {
    resultContractValid,
    resourceIdsUnique: new Set(ids).size === ids.length,
    canonicalUrlsUnique:
      new Set(canonicalUrls).size === canonicalUrls.length,
    ranksUniqueAndSequential:
      new Set(ranks).size === ranks.length &&
      ranks.every((rank, index) => rank === index + 1),
    distinctDomainCount: new Set(
      resources.map(resource => resource.domain),
    ).size,
    resourcesWithPublishedAt: resources.filter(
      resource => resource.publishedAt != null,
    ).length,
    expectedTopDomainMatched:
      expectedTopDomain === undefined
        ? "notApplicable"
        : resources[0]?.domain === expectedTopDomain,
  };
}

function emptyQualityChecks(
  expectedTopDomain: string | undefined,
): ResultQualityChecks {
  return readQualityChecks([], expectedTopDomain, false);
}

function classifyInterruptedExecution(
  deadlineSignal: AbortSignal,
  parentSignal: AbortSignal | undefined,
): "deadline_exceeded" | "cancelled" {
  return deadlineSignal.aborted && parentSignal?.aborted !== true
    ? "deadline_exceeded"
    : "cancelled";
}

/**
 * 纯执行边界：Provider 由调用方注入，因此普通测试可以使用 Fake；真实 Runner 只负责
 * 创建 Adapter。返回对象已经删除所有调用参数、网页正文和原始错误。
 */
export async function evaluateSingleNodeSmokeCase(
  input: EvaluateSingleNodeSmokeCaseInput,
): Promise<SingleNodeSmokeCaseResult> {
  const now = input.now ?? (() => performance.now());
  const runDeadlineMs = input.runDeadlineMs ?? RUN_DEADLINE_MS;
  if (
    !Number.isInteger(runDeadlineMs) ||
    runDeadlineMs < 1 ||
    runDeadlineMs > RUN_DEADLINE_MS
  ) {
    throw new RangeError(`runDeadlineMs 必须是 1 到 ${RUN_DEADLINE_MS} 的整数`);
  }

  const referenceTime = z.iso.datetime({ offset: true }).parse(
    input.referenceTime ?? new Date().toISOString(),
  );
  const startedAt = now();
  const deadlineAt = startedAt + runDeadlineMs;
  const deadlineController = new AbortController();
  const timerSignal = AbortSignal.timeout(runDeadlineMs);
  timerSignal.addEventListener(
    "abort",
    () => deadlineController.abort(timerSignal.reason),
    { once: true },
  );
  const deadlineSignal = deadlineController.signal;
  const signal =
    input.parentSignal === undefined
      ? deadlineSignal
      : AbortSignal.any([input.parentSignal, deadlineSignal]);
  const readRemainingDeadlineMs = (): number => {
    const remainingMs = Math.ceil(deadlineAt - now());
    if (remainingMs <= 0 && !deadlineSignal.aborted) {
      deadlineController.abort(
        new DOMException("单 Node Smoke 已超过安全截止时间", "TimeoutError"),
      );
    }
    // 组合 Signal 同时承载人员取消与 Run Deadline；这里必须保留最先发生的原始 reason。
    signal.throwIfAborted();
    return remainingMs;
  };
  const telemetry: MutableProviderTelemetry = {
    logicalSearchCalls: 0,
    logicalExtractCalls: 0,
    extractUrlCount: 0,
    logicalLlmCalls: 0,
    searchTimings: [],
    extractTimings: [],
    rerankTimings: [],
    budgetViolation: false,
  };
  const attemptObservations = (): readonly SerpApiBingAttemptObservation[] =>
    input.readAttemptObservations?.() ?? [];
  const tokenUsages = (): readonly DeepSeekTokenUsage[] =>
    input.readTokenUsages?.() ?? [];
  const searchProvider = createObservedSearchProvider(
    input.searchProvider,
    telemetry,
    now,
    input.smokeCase.node.searchPlan.queries.length,
    readRemainingDeadlineMs,
  );
  const rerankProvider = createObservedLlmProvider(
    input.rerankProvider,
    telemetry,
    now,
    readRemainingDeadlineMs,
  );
  let terminalEventType:
    | "node.ready"
    | "node.partial"
    | "node.failed"
    | undefined;
  let terminalEventCount = 0;
  let timeToTerminalMs: number | undefined;

  const recordTerminal = (payload: unknown): void => {
    const parsed = StreamEventPayloadSchema.parse(payload);
    if (
      parsed.type === "node.ready" ||
      parsed.type === "node.partial" ||
      parsed.type === "node.failed"
    ) {
      terminalEventType = parsed.type;
      terminalEventCount += 1;
      timeToTerminalMs = elapsedSince(startedAt, now);
    }
  };
  /** Standalone Smoke 不装配 D4 协调器，只记录 processNode 进度并本地投影单 Node 终态。 */
  const emit: (payload: NodeStatusEventPayload) => Promise<void> = async () =>
    undefined;

  try {
    const result = ResultGraphNodeSchema.parse(
      await processNode(
        input.smokeCase.node,
        {
          analysis: input.smokeCase.analysis,
          searchProvider,
          rerankProvider,
          // 没有人员批准的真实风险域名清单时必须保持为空。
          officialSourcePolicy: { knownRiskyDownloadDomains: [] },
          nowMs: Date.parse(referenceTime),
          rerankTimeoutMs: input.rerankTimeoutMs,
          emit,
          language: "zh-CN",
        },
        {
          signal,
          requirePositiveRemainingMs: readRemainingDeadlineMs,
        },
      ),
    );
    if (result.status === "failed") {
      throw new Error("单 Node Smoke 计算结果不变量被破坏");
    }
    const successfulTerminalEventType =
      result.status === "ready" ? "node.ready" : "node.partial";
    recordTerminal({
      type: successfulTerminalEventType,
      nodeId: result.id,
      resources: result.resources,
      warnings: result.warnings,
    });

    const providerTelemetry = readProviderTelemetry(
      telemetry,
      attemptObservations(),
      tokenUsages(),
      input.smokeCase.node.searchPlan.queries.length,
    );
    if (
      providerTelemetry.logicalSearchCalls !==
        input.smokeCase.node.searchPlan.queries.length ||
      providerTelemetry.logicalExtractCalls !== 0 ||
      providerTelemetry.logicalLlmCalls > 1 ||
      !providerTelemetry.budgetWithinLimits
    ) {
      throw new Error("单 Node Smoke 调用预算不变量被破坏");
    }

    return {
      id: input.smokeCase.id,
      category: input.smokeCase.category,
      originalQuery: input.smokeCase.originalQuery,
      referenceTime,
      executionStatus: "completed",
      nodeStatus: result.status,
      terminalEventType: successfulTerminalEventType,
      terminalEventCount,
      elapsedMs: elapsedSince(startedAt, now),
      ...(timeToTerminalMs === undefined ? {} : { timeToTerminalMs }),
      warnings: result.warnings,
      resources: result.resources,
      qualityChecks: readQualityChecks(
        result.resources,
        input.smokeCase.expectedTopDomain,
        true,
      ),
      telemetry: providerTelemetry,
    };
  } catch (error: unknown) {
    if (error instanceof NodeJobError && terminalEventCount === 0) {
      recordTerminal({
        type: "node.failed",
        nodeId: input.smokeCase.node.id,
        error: { code: error.code, retryable: error.retryable },
      });
    }
    const providerTelemetry = readProviderTelemetry(
      telemetry,
      attemptObservations(),
      tokenUsages(),
      input.smokeCase.node.searchPlan.queries.length,
    );
    const common = {
      id: input.smokeCase.id,
      category: input.smokeCase.category,
      originalQuery: input.smokeCase.originalQuery,
      referenceTime,
      ...(terminalEventType === undefined ? {} : { terminalEventType }),
      terminalEventCount,
      elapsedMs: elapsedSince(startedAt, now),
      ...(timeToTerminalMs === undefined ? {} : { timeToTerminalMs }),
      warnings: [] as const,
      resources: [] as const,
      qualityChecks: emptyQualityChecks(input.smokeCase.expectedTopDomain),
      telemetry: providerTelemetry,
    };

    if (!providerTelemetry.budgetWithinLimits) {
      return { ...common, executionStatus: "unexpected_internal_error" };
    }
    if (signal.aborted) {
      return {
        ...common,
        executionStatus: classifyInterruptedExecution(
          deadlineSignal,
          input.parentSignal,
        ),
      };
    }
    if (error instanceof NodeJobError) {
      return {
        ...common,
        executionStatus: "node_failed",
        errorCode: error.code,
      };
    }
    if (error instanceof NodeEventEmissionError) {
      return { ...common, executionStatus: "event_emission_failed" };
    }
    return { ...common, executionStatus: "unexpected_internal_error" };
  }
}

async function readFixedGoldenQueries(): Promise<
  readonly SingleNodeSmokeGoldenQuery[]
> {
  try {
    const value: unknown = JSON.parse(
      await readFile(GOLDEN_QUERY_FILE, "utf8"),
    );
    return parseSingleNodeSmokeGoldenQueries(value);
  } catch {
    throw new Error("无法读取固定 Golden Query 文件");
  }
}

export function parseSingleNodeSmokeGoldenQueries(
  value: unknown,
): readonly SingleNodeSmokeGoldenQuery[] {
  return GoldenQueryFileSchema.parse(value);
}

export function assertSingleNodeSmokeCasesMatchGoldenQueries(
  goldenQueries: readonly SingleNodeSmokeGoldenQuery[],
): void {
  const queryById = new Map(goldenQueries.map(query => [query.id, query]));
  const expectedCategories: Record<SingleNodeSmokeCase["id"], string> = {
    "wfq-001": "knowledge",
    "wfq-009": "navigateDownload",
    "wfq-013": "news",
  };
  for (const smokeCase of FIXED_CASES) {
    const goldenQuery = queryById.get(smokeCase.id);
    if (
      goldenQuery === undefined ||
      goldenQuery.query !== smokeCase.originalQuery ||
      goldenQuery.category !== expectedCategories[smokeCase.id]
    ) {
      throw new Error("单 Node Smoke Case 与固定 Golden Query 不一致");
    }
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
      // 原始文件错误可能携带个人绝对路径，不能附加 cause。
      // eslint-disable-next-line preserve-caught-error
      throw new Error("无法加载单 Node Smoke 本地环境配置");
    }
  }
}

async function readCleanGitBaseline(): Promise<{
  commit: string;
  worktreeClean: true;
}> {
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
    return { commit: commit.trim(), worktreeClean: true };
  } catch {
    throw new Error("单 Node Smoke 需要已提交且工作区干净的代码");
  }
}

function createRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
}

export async function createSingleNodeSmokePrivateOutputDirectory(
  resultRoot: string,
  outputDirectory: string,
): Promise<void> {
  await mkdir(resultRoot, { recursive: true, mode: 0o700 });
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(resultRoot, 0o700);
    await chmod(outputDirectory, 0o700);
  }
}

export async function writeSingleNodeSmokePrivateJson(
  path: string,
  value: unknown,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

// 保留既有导出名，但删除与 Planner / Quality Review 重复的实现。
export const encodeSingleNodeSmokeReviewText = encodeMarkdownArtifactText;

function renderHumanReview(
  results: readonly SingleNodeSmokeCaseResult[],
): string {
  const sections = results.map(result => {
    const resources = result.resources
      .map(
        resource => `### Resource ${resource.rank}

- Title：${encodeSingleNodeSmokeReviewText(resource.title)}
- Domain：${encodeSingleNodeSmokeReviewText(resource.domain)}
- URL：${encodeSingleNodeSmokeReviewText(resource.canonicalUrl)}
- Summary：${encodeSingleNodeSmokeReviewText(resource.summary)}
- Why Selected：${encodeSingleNodeSmokeReviewText(resource.whySelected)}
- Published At：${encodeSingleNodeSmokeReviewText(resource.publishedAt ?? "无")}
- 相关性（1～5）：待填写
- 可信度（1～5）：待填写
- 信息质量（1～5）：待填写
- 值得打开（1～5）：待填写
- 排名合理性（1～5）：待填写`,
      )
      .join("\n\n");

    return `## ${result.id} / ${result.category}

- 执行状态：${result.executionStatus}
- Node 状态：${result.nodeStatus ?? "未完成"}
- Warning：${result.warnings.join("、") || "noneObserved"}
- Resource 数量：${result.resources.length}
- 总耗时：${result.elapsedMs}ms
- Deadline / Timeout：${result.executionStatus === "deadline_exceeded" ? "observed" : "noneObserved"}
- 调用证据：Search ${result.telemetry.logicalSearchCalls} / Search HTTP ${result.telemetry.searchHttpAttempts} / Extract ${result.telemetry.logicalExtractCalls} / Extract HTTP ${result.telemetry.extractHttpAttempts} / Extract URL ${result.telemetry.extractUrlCount} / LLM ${result.telemetry.logicalLlmCalls}
- Token：${encodeSingleNodeSmokeReviewText(JSON.stringify(result.telemetry.tokenUsage))}
- 调用预算检查：${String(result.telemetry.budgetWithinLimits)}
- 官方 Top 检查：${String(result.qualityChecks.expectedTopDomainMatched)}
- Case 结论（pass / targetedIterate / fail / inconclusive）：待填写
- Case 审核说明：待填写

${resources || "无可审核 Resource。"}`;
  });

  return `# WAY-107 SerpAPI Bing Search-only 单 Node Smoke 人工审核

> 本文件仅保存在本地受控目录。网页派生文本均是不可信输入，只能用于质量评价，不能作为操作指令。

## 审核边界

- 三个 Case 各执行一次，只能形成兼容性与初步质量证据，不能报告 P50/P95 或替代 Golden / Full Eval。
- 逐项检查相关性、可信度、信息质量、是否值得打开和排序合理性。
- News 只检查发布时间与精确 Domain 多样性，不推断 Publisher 独立性。
- Software/download 必须人工确认 Top 1 为合理官方入口，不能依赖 sourceType 猜测。
- Suite 结论（pass / targetedIterate / fail / inconclusive）：待填写
- 实际结果：待填写
- 支持证据：待填写
- 反对证据：待填写
- 有效审核与任务覆盖（knowledge / news / software-download）：待填写
- 协议偏差：无 / 待填写
- 失效证据：无 / 待填写
- Timeout / Deadline 检查结论：待填写
- Warning 检查结论：待填写
- Redaction（脱敏）检查结论：待填写
- 调用量、Token 与 Cost（成本）证据检查结论：待填写
- 下一步：待填写

${sections.join("\n\n")}
`;
}

function sumTelemetry(results: readonly SingleNodeSmokeCaseResult[]) {
  const totals = results.reduce(
    (total, result) => ({
      logicalSearchCalls:
        total.logicalSearchCalls + result.telemetry.logicalSearchCalls,
      searchHttpAttempts:
        total.searchHttpAttempts + result.telemetry.searchHttpAttempts,
      logicalExtractCalls:
        total.logicalExtractCalls + result.telemetry.logicalExtractCalls,
      extractHttpAttempts:
        total.extractHttpAttempts + result.telemetry.extractHttpAttempts,
      extractUrlCount:
        total.extractUrlCount + result.telemetry.extractUrlCount,
      logicalLlmCalls:
        total.logicalLlmCalls + result.telemetry.logicalLlmCalls,
      inputTokens:
        total.inputTokens +
        (result.telemetry.tokenUsage === "unavailable"
          ? 0
          : result.telemetry.tokenUsage.inputTokens),
      outputTokens:
        total.outputTokens +
        (result.telemetry.tokenUsage === "unavailable"
          ? 0
          : result.telemetry.tokenUsage.outputTokens),
      totalTokens:
        total.totalTokens +
        (result.telemetry.tokenUsage === "unavailable"
          ? 0
          : result.telemetry.tokenUsage.totalTokens),
      tokenUsageComplete:
        total.tokenUsageComplete &&
        result.telemetry.tokenUsage !== "unavailable",
    }),
    {
      logicalSearchCalls: 0,
      searchHttpAttempts: 0,
      logicalExtractCalls: 0,
      extractHttpAttempts: 0,
      extractUrlCount: 0,
      logicalLlmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      tokenUsageComplete: true,
    },
  );
  return totals;
}

async function runSingleNodeSmoke(input: {
  config: ServerConfig;
  git: { commit: string; worktreeClean: true };
  goldenQueries: readonly SingleNodeSmokeGoldenQuery[];
}): Promise<string> {
  const { config, git, goldenQueries } = input;
  assertSingleNodeSmokeCasesMatchGoldenQueries(goldenQueries);

  const runId = createRunId();
  const outputDirectory = resolve(RESULT_ROOT, runId);
  try {
    await createSingleNodeSmokePrivateOutputDirectory(
      RESULT_ROOT,
      outputDirectory,
    );
    await writeSingleNodeSmokePrivateJson(
      resolve(outputDirectory, "run-state.json"),
      {
        issue: "WAY-107",
        runId,
        status: "incomplete",
      },
    );
  } catch {
    throw new Error("无法初始化单 Node Smoke 私有输出目录");
  }

  try {
    const results: SingleNodeSmokeCaseResult[] = [];
    for (const smokeCase of FIXED_CASES) {
      const attemptRecorder = createBoundedSearchAttemptRecorder({
        maximumSearchAttempts:
          smokeCase.node.searchPlan.queries.length * 2,
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
      results.push(
        await evaluateSingleNodeSmokeCase({
          smokeCase,
          searchProvider,
          rerankProvider,
          rerankTimeoutMs: config.timeouts.rerankMs,
          readAttemptObservations: attemptRecorder.read,
          readTokenUsages: () => tokenUsages,
        }),
      );
    }

    const usage = sumTelemetry(results);
    const report = {
      schemaVersion: 2,
      issue: "WAY-107",
      runId,
      completedAt: new Date().toISOString(),
      testCharter: {
        decisionQuestion:
          "真实 SerpAPI Bing Search 与 DeepSeek Rerank 是否能让三类固定单 Node 返回可人工审核的规范化 Resource？",
        testType: "ai_provider_quality_validation",
        testedBuild: git.commit,
        startCondition:
          "Harness 离线检查通过、工作树为干净 Commit，且人员明确批准本次 live 调用",
        participantStrategy:
          "由具备项目审核权限的人员独立审核；不记录身份信息，人数不构成完成条件",
        stopRule: "三个固定 Case 各串行完成一次并形成四态人工结论",
        privacyRule:
          "不保存 Secret、Provider 原始响应、Extract 正文、Prompt、LLM 原始输出、原始错误或请求标识",
      },
      source: {
        git,
        queryFile: "tests/eval-queries.json",
        rerankerPromptVersion: RESOURCE_RERANKER_PROMPT_VERSION,
        searchProvider: "serpapi_bing",
        llmProvider: DEEPSEEK_LLM_PROVIDER_ID,
        llmModel: DEEPSEEK_LLM_MODEL,
      },
      runPolicy: {
        execution: "sequential",
        repetitionsPerCase: 1,
        caseCount: EXPECTED_CASE_COUNT,
        runDeadlineMs: RUN_DEADLINE_MS,
        searchTimeoutMs: config.timeouts.searchMs,
        rerankTimeoutMs: config.timeouts.rerankMs,
        cache: "disabled_not_implemented",
        liveCalls: true,
        maximumCalls: {
          logicalSearch: 6,
          searchHttpAttempts: 12,
          logicalExtract: 0,
          extractHttpAttempts: 0,
          logicalLlm: 3,
        },
      },
      automatedSummary: {
        completedCaseCount: results.filter(
          result => result.executionStatus === "completed",
        ).length,
        readyCaseCount: results.filter(result => result.nodeStatus === "ready")
          .length,
        partialCaseCount: results.filter(
          result => result.nodeStatus === "partial",
        ).length,
        deadlineExceededCaseCount: results.filter(
          result => result.executionStatus === "deadline_exceeded",
        ).length,
        warningCodes: [
          ...new Set(results.flatMap(result => result.warnings)),
        ],
        totalLatencyMs: results.reduce(
          (total, result) => total + result.elapsedMs,
          0,
        ),
        engineeringDisposition: results.every(
          result => result.executionStatus === "completed",
        )
          ? "awaitingHumanReview"
          : "executionIncomplete",
      },
      costEvidence: {
        estimatedCost: "unavailable",
        estimatedCostReason: "pricing_not_frozen",
        actualUsage: usage,
      },
      humanReview: {
        status: "pending",
        scoreScale: "1-5",
        allowedOutcomes: ALLOWED_OUTCOMES,
      },
      artifactPolicy: {
        localOnly: true,
        automaticUpload: false,
        automaticDeletion: false,
        retention: "until_human_review_and_controlled_sync_decision",
      },
      cases: FIXED_CASES.map(smokeCase => ({
        id: smokeCase.id,
        category: smokeCase.category,
        originalQuery: smokeCase.originalQuery,
        analysis: smokeCase.analysis,
        node: smokeCase.node,
        ...(smokeCase.expectedTopDomain === undefined
          ? {}
          : { expectedTopDomain: smokeCase.expectedTopDomain }),
      })),
      results,
    };
    const review = renderHumanReview(results);
    const secrets = [config.llmApiKey, config.serpApiKey];
    assertSingleNodeSmokeArtifactSafety(report, secrets);
    assertSingleNodeSmokeArtifactSafety(review, secrets);

    await writeSingleNodeSmokePrivateJson(
      resolve(outputDirectory, "report.json"),
      report,
    );
    await writeFile(
      resolve(outputDirectory, "human-review.md"),
      review,
      { encoding: "utf8", mode: 0o600 },
    );
    await writeSingleNodeSmokePrivateJson(
      resolve(outputDirectory, "run-state.json"),
      {
        issue: "WAY-107",
        runId,
        status: "completed",
        executionDisposition: report.automatedSummary.engineeringDisposition,
      },
    );
    return `data/eval-results/way-107/${runId}`;
  } catch {
    try {
      await writeSingleNodeSmokePrivateJson(
        resolve(outputDirectory, "run-state.json"),
        {
          issue: "WAY-107",
          runId,
          status: "failed",
          failureKind: "unexpected_internal_error",
        },
      );
    } catch {
      // 状态写入失败时同样不得把绝对路径或原始错误带到终端。
    }
    throw new Error("单 Node Smoke 执行失败；已保留脱敏失败状态");
  }
}

async function main(): Promise<void> {
  try {
    assertSingleNodeSmokeLiveMode(process.argv.slice(2));
    // Git 基线必须先通过，避免为不可复现的工作树读取 Secret 或产生真实调用。
    const [git, goldenQueries] = await Promise.all([
      readCleanGitBaseline(),
      readFixedGoldenQueries(),
    ]);
    assertSingleNodeSmokeCasesMatchGoldenQueries(goldenQueries);
    // Live Guard 与 Git 基线通过后才允许读取固定本地配置。
    loadLocalEnvironmentIfPresent();
    const config = parseServerConfig(process.env);
    const outputDirectory = await runSingleNodeSmoke({
      config,
      git,
      goldenQueries,
    });
    process.stdout.write(
      `WAY-107 单 Node Smoke 已完成：${outputDirectory}\n`,
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "单 Node Smoke 发生未知程序错误";
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
