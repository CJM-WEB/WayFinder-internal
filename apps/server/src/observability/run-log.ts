/**
 * 模块职责：构建不含原始 Query、Plan、URL、正文或 Provider 响应的每 Run 脱敏摘要。
 *
 * 关键边界：
 * - 这是 Server 内部日志模型，不扩张公共 Contract 或 StreamEvent；
 * - Recorder（记录器）只接受结构计数、稳定 Code 与聚合指标，不能接收任意日志对象；
 * - 费率尚未冻结，预计成本必须明确不可用，不能临时猜测金额；
 * - 记录和写入均为 fail-open，任何异常都不能改变搜索结果。
 */
import { randomUUID } from "node:crypto";

import {
  AppErrorCodeSchema,
  NodeWarningCodeSchema,
  type AppErrorCode,
  type GraphPlan,
  type NodeWarningCode,
  type ResultGraph,
  type StreamEventPayload,
} from "@wayfinder/contracts";
import { z } from "zod";

import { GRAPH_PLANNER_PROMPT_VERSION } from "../ai/prompts/graph-planner.v2.js";
import { GRAPH_REVISER_PROMPT_VERSION } from "../ai/prompts/graph-reviser.v3.js";
import { RESOURCE_RERANKER_PROMPT_VERSION } from "../ai/prompts/resource-reranker.v1.js";
import { SEARCH_PLAN_GENERATOR_PROMPT_VERSION } from "../ai/prompts/search-plan-generator.v2.js";
import { RANK_FUSION_VERSION } from "../pipeline/rank-fusion.js";
import type { RankingObservation } from "../pipeline/ranking-observation.js";
import type { RunLogObservation } from "./run-log-context.js";

const UniqueWarningCodesSchema = z
  .array(NodeWarningCodeSchema)
  .refine(values => new Set(values).size === values.length, {
    message: "Run Log warningCodes 必须唯一",
  });

const UniqueErrorCodesSchema = z
  .array(AppErrorCodeSchema)
  .refine(values => new Set(values).size === values.length, {
    message: "Run Log errorCodes 必须唯一",
  });

const NonNegativeIntegerSchema = z.number().int().min(0);
const NonNegativeFiniteSchema = z.number().finite().min(0);
const ProviderIdentifierSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

/**
 * run-log.v3 的字段结构未变；读取端显式兼容历史 v1 来源，生产 Recorder 仍只写现役 v2。
 * 这样不会把同一结构版本的既有私有工件因 Prompt 升级而变成不可读。
 */
const SearchPlanGeneratorPromptVersionSchema = z.enum([
  "search-plan-generator.v1",
  "search-plan-generator.v2",
]);

const RankingModeMetricsSchema = z
  .strictObject({
    nodeCount: NonNegativeIntegerSchema,
    finalCandidateCount: NonNegativeIntegerSchema,
    providerTop1OverrideCount: NonNegativeIntegerSchema,
    heuristicTop1OverrideCount: NonNegativeIntegerSchema,
    providerTop3FinalOverlapCount: NonNegativeIntegerSchema,
    heuristicTop3FinalOverlapCount: NonNegativeIntegerSchema,
    top3ComparisonSlots: NonNegativeIntegerSchema,
  })
  .superRefine((metrics, context) => {
    const invalid =
      metrics.providerTop1OverrideCount > metrics.nodeCount ||
      metrics.heuristicTop1OverrideCount > metrics.nodeCount ||
      metrics.providerTop3FinalOverlapCount > metrics.top3ComparisonSlots ||
      metrics.heuristicTop3FinalOverlapCount > metrics.top3ComparisonSlots ||
      metrics.top3ComparisonSlots > metrics.finalCandidateCount ||
      metrics.finalCandidateCount > metrics.nodeCount * 6 ||
      (metrics.nodeCount > 0 &&
        (metrics.finalCandidateCount < metrics.nodeCount ||
          metrics.top3ComparisonSlots < metrics.nodeCount));
    if (invalid) {
      context.addIssue({
        code: "custom",
        message: "Run Log 匿名排序聚合不变量无效",
      });
    }
  });

const RankingMetricsSchema = z.strictObject({
  llmSuccess: RankingModeMetricsSchema,
  fallback: RankingModeMetricsSchema,
});

const TokenMetricsSchema = z.strictObject({
  status: z.enum(["not_used", "complete", "partial", "unavailable"]),
  observations: NonNegativeIntegerSchema,
  inputTokens: NonNegativeIntegerSchema,
  outputTokens: NonNegativeIntegerSchema,
  totalTokens: NonNegativeIntegerSchema,
});

const PlanningStageMetricsSchema = z.strictObject({
  logicalLlmCalls: NonNegativeIntegerSchema,
  tokens: TokenMetricsSchema,
  failureCode: AppErrorCodeSchema.nullable(),
});

/**
 * 严格内部 Schema 是最终隐私白名单。即使调用方持有原始业务对象，文件 Sink 也只能接收
 * 这里列出的聚合字段；新增字段必须经过显式代码与测试审核。
 */
export const RunLogRecordSchema = z.strictObject({
  schemaVersion: z.literal("run-log.v3"),
  createdAt: z.iso.datetime({ offset: true }),
  identifiers: z.strictObject({
    logId: z.uuid(),
    queryId: z.uuid(),
    planId: z.uuid().nullable(),
  }),
  outcome: z.enum([
    "complete",
    "partial",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  timingsMs: z.strictObject({
    planning: NonNegativeFiniteSchema.nullable(),
    graphOutlinePlanning: NonNegativeFiniteSchema.nullable(),
    searchPlanPlanning: NonNegativeFiniteSchema.nullable(),
    nodeProcessing: NonNegativeFiniteSchema.nullable(),
    total: NonNegativeFiniteSchema,
    provider: z.strictObject({
      search: NonNegativeFiniteSchema,
      extract: NonNegativeFiniteSchema,
      llm: NonNegativeFiniteSchema,
    }),
  }),
  counts: z.strictObject({
    plannedNodes: NonNegativeIntegerSchema,
    edges: NonNegativeIntegerSchema,
    resources: NonNegativeIntegerSchema,
    readyNodes: NonNegativeIntegerSchema,
    partialNodes: NonNegativeIntegerSchema,
    failedNodes: NonNegativeIntegerSchema,
    logicalSearchCalls: NonNegativeIntegerSchema,
    logicalExtractCalls: NonNegativeIntegerSchema,
    extractUrlCount: NonNegativeIntegerSchema,
    logicalLlmCalls: NonNegativeIntegerSchema,
    searchResultCount: NonNegativeIntegerSchema,
    extractedPageCount: NonNegativeIntegerSchema,
    searchHttpAttempts: NonNegativeIntegerSchema,
    extractHttpAttempts: NonNegativeIntegerSchema,
  }),
  /** 只区分两个规划阶段；Node Reranker 仍仅进入全 Run 聚合。 */
  planningStages: z.strictObject({
    graphOutline: PlanningStageMetricsSchema,
    searchPlan: PlanningStageMetricsSchema,
  }),
  warningCodes: UniqueWarningCodesSchema,
  errorCodes: UniqueErrorCodesSchema,
  versions: z.strictObject({
    protocol: z.literal("0.1"),
    resultGraph: z.literal("0.1"),
    plannerPrompt: z.literal(GRAPH_PLANNER_PROMPT_VERSION),
    reviserPrompt: z.literal(GRAPH_REVISER_PROMPT_VERSION),
    searchPlanGeneratorPrompt: SearchPlanGeneratorPromptVersionSchema,
    rerankerPrompt: z.literal(RESOURCE_RERANKER_PROMPT_VERSION),
    rankFusion: z.literal(RANK_FUSION_VERSION),
  }),
  providers: z.strictObject({
    search: ProviderIdentifierSchema,
    llm: ProviderIdentifierSchema,
  }),
  cache: z.strictObject({
    search: z.strictObject({
      hitCount: NonNegativeIntegerSchema,
      missCount: NonNegativeIntegerSchema,
    }),
    extract: z.strictObject({
      hitCount: NonNegativeIntegerSchema,
      missCount: NonNegativeIntegerSchema,
    }),
  }),
  ranking: RankingMetricsSchema,
  tokens: TokenMetricsSchema,
  estimatedCost: z.strictObject({
    status: z.literal("unavailable"),
    reason: z.literal("pricing_not_frozen"),
  }),
});

export type RunLogRecord = Readonly<z.infer<typeof RunLogRecordSchema>>;

export type RunLogSink = Readonly<{
  write: (record: RunLogRecord) => Promise<void>;
}>;

export type CreateRunLogRecorderInput = Readonly<{
  sink: RunLogSink;
  searchProviderId: string;
  llmProviderId: string;
  startedAt: number;
  now?: () => number;
  createId?: () => string;
  /** 失败出口不得接收 Error，避免日志故障把路径或敏感正文带到其他日志。 */
  onWriteFailure?: () => void;
}>;

export type RunProviderOperation = "search" | "extract" | "llm";
export type RunPlanningStage = "graphOutline" | "searchPlan";

export type RunLogRecorder = Readonly<{
  observe: (observation: RunLogObservation) => void;
  recordGraphOutlinePlanningFinished: () => void;
  recordSearchPlanPlanningFinished: () => void;
  recordPlanningStageFailed: (
    stage: RunPlanningStage,
    code: AppErrorCode,
  ) => void;
  recordPlan: (plan: GraphPlan) => void;
  recordNodeProcessingStarted: () => void;
  recordProviderCallStarted: (
    operation: RunProviderOperation,
    extractUrlCount?: number,
  ) => void;
  recordProviderCallFinished: (
    operation: RunProviderOperation,
    durationMs: number,
    resultCount: number,
  ) => void;
  recordRanking: (observation: RankingObservation) => void;
  recordEvent: (payload: StreamEventPayload) => void;
  recordInterrupted: (cancelled: boolean) => void;
  finish: () => Promise<void>;
}>;

type MutableCounts = z.infer<typeof RunLogRecordSchema>["counts"];
type MutableCacheMetrics = z.infer<typeof RunLogRecordSchema>["cache"];
type MutableRankingMetrics = z.infer<typeof RunLogRecordSchema>["ranking"];
type MutablePlanningStageMetrics = {
  logicalLlmCalls: number;
  observations: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  failureCode: AppErrorCode | null;
};

function appendUnique<T>(target: T[], value: T): void {
  if (!target.includes(value)) target.push(value);
}

function readNonNegativeDuration(
  now: () => number,
  startedAt: number,
): number {
  const finishedAt = now();
  if (!Number.isFinite(finishedAt) || !Number.isFinite(startedAt)) return 0;
  return Math.max(0, finishedAt - startedAt);
}

function readTokenStatus(
  llmCalls: number,
  observations: number,
): "not_used" | "complete" | "partial" | "unavailable" {
  if (llmCalls === 0) return "not_used";
  if (observations === 0) return "unavailable";
  return observations === llmCalls ? "complete" : "partial";
}

/**
 * 创建单次 Run Recorder。调用者不得传入 Query 或完整 Plan；Plan/Result 只在同步方法内
 * 投影为数量与稳定 Code，原对象不会保存在闭包状态中。
 */
export function createRunLogRecorder(
  input: CreateRunLogRecorderInput,
): RunLogRecorder {
  const now = input.now ?? Date.now;
  const createId = input.createId ?? randomUUID;
  const createdAt = new Date(input.startedAt).toISOString();
  const logId = createId();
  const queryId = createId();
  let planId: string | null = null;
  let planningMs: number | null = null;
  let graphOutlinePlanningMs: number | null = null;
  let searchPlanPlanningStartedAt: number | null = null;
  let searchPlanPlanningMs: number | null = null;
  let nodeProcessingStartedAt: number | null = null;
  let outcome: RunLogRecord["outcome"] = "interrupted";
  let finished = false;

  const counts: MutableCounts = {
    plannedNodes: 0,
    edges: 0,
    resources: 0,
    readyNodes: 0,
    partialNodes: 0,
    failedNodes: 0,
    logicalSearchCalls: 0,
    logicalExtractCalls: 0,
    extractUrlCount: 0,
    logicalLlmCalls: 0,
    searchResultCount: 0,
    extractedPageCount: 0,
    searchHttpAttempts: 0,
    extractHttpAttempts: 0,
  };
  const providerTimings = { search: 0, extract: 0, llm: 0 };
  const cache: MutableCacheMetrics = {
    search: { hitCount: 0, missCount: 0 },
    extract: { hitCount: 0, missCount: 0 },
  };
  const emptyRankingMode = (): MutableRankingMetrics["llmSuccess"] => ({
    nodeCount: 0,
    finalCandidateCount: 0,
    providerTop1OverrideCount: 0,
    heuristicTop1OverrideCount: 0,
    providerTop3FinalOverlapCount: 0,
    heuristicTop3FinalOverlapCount: 0,
    top3ComparisonSlots: 0,
  });
  const ranking: MutableRankingMetrics = {
    llmSuccess: emptyRankingMode(),
    fallback: emptyRankingMode(),
  };
  const warningCodes: NodeWarningCode[] = [];
  const errorCodes: AppErrorCode[] = [];
  const tokens = {
    observations: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  const createPlanningStageMetrics = (): MutablePlanningStageMetrics => ({
    logicalLlmCalls: 0,
    observations: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    failureCode: null,
  });
  const planningStages = {
    graphOutline: createPlanningStageMetrics(),
    searchPlan: createPlanningStageMetrics(),
  };
  let activePlanningStage: keyof typeof planningStages | null =
    "graphOutline";

  const observe = (observation: RunLogObservation): void => {
    if (finished) return;
    if (observation.kind === "cache") {
      cache[observation.operation].hitCount += observation.hitCount;
      cache[observation.operation].missCount += observation.missCount;
      return;
    }
    if (observation.kind === "http_attempt") {
      if (observation.operation === "search") {
        counts.searchHttpAttempts += 1;
      } else {
        counts.extractHttpAttempts += 1;
      }
      return;
    }

    tokens.observations += 1;
    tokens.inputTokens += observation.inputTokens;
    tokens.outputTokens += observation.outputTokens;
    tokens.totalTokens += observation.totalTokens;
    if (activePlanningStage !== null) {
      const stage = planningStages[activePlanningStage];
      stage.observations += 1;
      stage.inputTokens += observation.inputTokens;
      stage.outputTokens += observation.outputTokens;
      stage.totalTokens += observation.totalTokens;
    }
  };

  /** Stage 1 结束同时成为 Stage 2 起点；只记录时间，不接收 Outline 内容。 */
  const recordGraphOutlinePlanningFinished = (): void => {
    if (finished || graphOutlinePlanningMs !== null) return;
    const value = now();
    const finishedAt = Number.isFinite(value) ? value : input.startedAt;
    graphOutlinePlanningMs = Math.max(0, finishedAt - input.startedAt);
    searchPlanPlanningStartedAt = finishedAt;
    activePlanningStage = "searchPlan";
  };

  /** Stage 2 包含 Bundle 生成、确定性装配与最终 GraphPlan 校验。 */
  const recordSearchPlanPlanningFinished = (): void => {
    if (
      finished ||
      searchPlanPlanningStartedAt === null ||
      searchPlanPlanningMs !== null
    ) {
      return;
    }
    searchPlanPlanningMs = readNonNegativeDuration(
      now,
      searchPlanPlanningStartedAt,
    );
    activePlanningStage = null;
  };

  /**
   * 只接受稳定 AppError Code，不保存 Error、Query 或阶段输入。
   * 失败是阶段的终态，因此必须在同一时刻冻结已消耗时间，
   * 否则失败 Run 会在观测上被误判为“阶段未开始”。
   */
  const recordPlanningStageFailed = (
    stage: RunPlanningStage,
    code: AppErrorCode,
  ): void => {
    if (finished || planningStages[stage].failureCode !== null) return;
    const parsed = AppErrorCodeSchema.safeParse(code);
    if (!parsed.success) return;
    planningStages[stage].failureCode = parsed.data;

    if (activePlanningStage !== stage) return;
    if (stage === "graphOutline" && graphOutlinePlanningMs === null) {
      graphOutlinePlanningMs = readNonNegativeDuration(now, input.startedAt);
    } else if (
      stage === "searchPlan" &&
      searchPlanPlanningStartedAt !== null &&
      searchPlanPlanningMs === null
    ) {
      searchPlanPlanningMs = readNonNegativeDuration(
        now,
        searchPlanPlanningStartedAt,
      );
    }
    activePlanningStage = null;
  };

  const recordPlan = (plan: GraphPlan): void => {
    if (finished || planId !== null) return;
    planId = createId();
    planningMs = readNonNegativeDuration(now, input.startedAt);
    counts.plannedNodes = plan.nodes.length;
    counts.edges = plan.edges.length;
  };

  const recordNodeProcessingStarted = (): void => {
    if (finished || nodeProcessingStartedAt !== null) return;
    const value = now();
    nodeProcessingStartedAt = Number.isFinite(value) ? value : input.startedAt;
  };

  const recordProviderCallStarted = (
    operation: RunProviderOperation,
    extractUrlCount = 0,
  ): void => {
    if (finished) return;
    if (operation === "search") {
      counts.logicalSearchCalls += 1;
      return;
    }
    if (operation === "extract") {
      counts.logicalExtractCalls += 1;
      if (Number.isSafeInteger(extractUrlCount) && extractUrlCount >= 0) {
        counts.extractUrlCount += extractUrlCount;
      }
      return;
    }
    counts.logicalLlmCalls += 1;
    if (activePlanningStage !== null) {
      planningStages[activePlanningStage].logicalLlmCalls += 1;
    }
  };

  const recordProviderCallFinished = (
    operation: RunProviderOperation,
    durationMs: number,
    resultCount: number,
  ): void => {
    if (finished) return;
    const safeDuration =
      Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    const safeResultCount =
      Number.isSafeInteger(resultCount) && resultCount >= 0 ? resultCount : 0;
    providerTimings[operation] += safeDuration;
    if (operation === "search") {
      counts.searchResultCount += safeResultCount;
    } else if (operation === "extract") {
      counts.extractedPageCount += safeResultCount;
    }
  };

  /** 输入类型不含候选身份；运行时再次核对计数，非法观测按旁路 fail-open 忽略。 */
  const recordRanking = (observation: RankingObservation): void => {
    if (finished) return;
    const integerValues = [
      observation.candidateCount,
      observation.providerTop3FinalOverlap,
      observation.heuristicTop3FinalOverlap,
      observation.top3ComparisonSlots,
    ];
    if (
      (observation.fusionMode !== "llm_success" &&
        observation.fusionMode !== "fallback") ||
      integerValues.some(value => !Number.isSafeInteger(value) || value < 0) ||
      observation.candidateCount < 1 ||
      observation.candidateCount > 6 ||
      observation.top3ComparisonSlots !==
        Math.min(3, observation.candidateCount) ||
      observation.providerTop3FinalOverlap > observation.top3ComparisonSlots ||
      observation.heuristicTop3FinalOverlap > observation.top3ComparisonSlots
    ) {
      return;
    }

    const mode =
      observation.fusionMode === "llm_success"
        ? ranking.llmSuccess
        : ranking.fallback;
    mode.nodeCount += 1;
    mode.finalCandidateCount += observation.candidateCount;
    mode.providerTop1OverrideCount += observation.providerTop1Overridden
      ? 1
      : 0;
    mode.heuristicTop1OverrideCount += observation.heuristicTop1Overridden
      ? 1
      : 0;
    mode.providerTop3FinalOverlapCount +=
      observation.providerTop3FinalOverlap;
    mode.heuristicTop3FinalOverlapCount +=
      observation.heuristicTop3FinalOverlap;
    mode.top3ComparisonSlots += observation.top3ComparisonSlots;
  };

  const recordResult = (result: ResultGraph): void => {
    counts.plannedNodes = result.graph.nodes.length;
    counts.edges = result.graph.edges.length;
    counts.resources = result.graph.nodes.reduce(
      (total, node) => total + node.resources.length,
      0,
    );
    counts.readyNodes = result.graph.nodes.filter(
      node => node.status === "ready",
    ).length;
    counts.partialNodes = result.graph.nodes.filter(
      node => node.status === "partial",
    ).length;
    counts.failedNodes = result.graph.nodes.filter(
      node => node.status === "failed",
    ).length;
    for (const node of result.graph.nodes) {
      for (const warning of node.warnings) appendUnique(warningCodes, warning);
      if (node.status === "failed") appendUnique(errorCodes, node.error.code);
    }
  };

  const recordEvent = (payload: StreamEventPayload): void => {
    if (finished) return;
    if (payload.type === "node.partial") {
      for (const warning of payload.warnings) {
        appendUnique(warningCodes, warning);
      }
      return;
    }
    if (payload.type === "node.failed") {
      appendUnique(errorCodes, payload.error.code);
      return;
    }
    if (payload.type === "run.failed") {
      outcome = "failed";
      appendUnique(errorCodes, payload.error.code);
      return;
    }
    if (payload.type === "complete") {
      outcome = payload.data.finalStatus;
      recordResult(payload.data.result);
    }
  };

  const recordInterrupted = (cancelled: boolean): void => {
    if (
      finished ||
      outcome === "complete" ||
      outcome === "partial" ||
      outcome === "failed"
    ) {
      return;
    }
    outcome = cancelled ? "cancelled" : "interrupted";
    appendUnique(errorCodes, cancelled ? "REQUEST_ABORTED" : "UNKNOWN");
  };

  const notifyWriteFailure = (): void => {
    try {
      input.onWriteFailure?.();
    } catch {
      // 二级诊断出口同样不能改变业务结果。
    }
  };

  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;

    try {
      const totalMs = readNonNegativeDuration(now, input.startedAt);
      const nodeProcessingMs =
        nodeProcessingStartedAt === null
          ? null
          : readNonNegativeDuration(now, nodeProcessingStartedAt);
      const record = RunLogRecordSchema.parse({
        schemaVersion: "run-log.v3",
        createdAt,
        identifiers: { logId, queryId, planId },
        outcome,
        timingsMs: {
          planning: planningMs,
          graphOutlinePlanning: graphOutlinePlanningMs,
          searchPlanPlanning: searchPlanPlanningMs,
          nodeProcessing: nodeProcessingMs,
          total: totalMs,
          provider: providerTimings,
        },
        counts,
        planningStages: {
          graphOutline: {
            logicalLlmCalls: planningStages.graphOutline.logicalLlmCalls,
            failureCode: planningStages.graphOutline.failureCode,
            tokens: {
              status: readTokenStatus(
                planningStages.graphOutline.logicalLlmCalls,
                planningStages.graphOutline.observations,
              ),
              observations: planningStages.graphOutline.observations,
              inputTokens: planningStages.graphOutline.inputTokens,
              outputTokens: planningStages.graphOutline.outputTokens,
              totalTokens: planningStages.graphOutline.totalTokens,
            },
          },
          searchPlan: {
            logicalLlmCalls: planningStages.searchPlan.logicalLlmCalls,
            failureCode: planningStages.searchPlan.failureCode,
            tokens: {
              status: readTokenStatus(
                planningStages.searchPlan.logicalLlmCalls,
                planningStages.searchPlan.observations,
              ),
              observations: planningStages.searchPlan.observations,
              inputTokens: planningStages.searchPlan.inputTokens,
              outputTokens: planningStages.searchPlan.outputTokens,
              totalTokens: planningStages.searchPlan.totalTokens,
            },
          },
        },
        warningCodes,
        errorCodes,
        versions: {
          protocol: "0.1",
          resultGraph: "0.1",
          plannerPrompt: GRAPH_PLANNER_PROMPT_VERSION,
          reviserPrompt: GRAPH_REVISER_PROMPT_VERSION,
          searchPlanGeneratorPrompt: SEARCH_PLAN_GENERATOR_PROMPT_VERSION,
          rerankerPrompt: RESOURCE_RERANKER_PROMPT_VERSION,
          rankFusion: RANK_FUSION_VERSION,
        },
        providers: {
          search: input.searchProviderId,
          llm: input.llmProviderId,
        },
        cache,
        ranking,
        tokens: {
          status: readTokenStatus(
            counts.logicalLlmCalls,
            tokens.observations,
          ),
          ...tokens,
        },
        estimatedCost: {
          status: "unavailable",
          reason: "pricing_not_frozen",
        },
      });
      await input.sink.write(record);
    } catch {
      notifyWriteFailure();
    }
  };

  return {
    observe,
    recordGraphOutlinePlanningFinished,
    recordSearchPlanPlanningFinished,
    recordPlanningStageFailed,
    recordPlan,
    recordNodeProcessingStarted,
    recordProviderCallStarted,
    recordProviderCallFinished,
    recordRanking,
    recordEvent,
    recordInterrupted,
    finish,
  };
}
