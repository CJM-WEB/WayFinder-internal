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

import { GRAPH_PLANNER_PROMPT_VERSION } from "../ai/prompts/graph-planner.v1.js";
import { GRAPH_REVISER_PROMPT_VERSION } from "../ai/prompts/graph-reviser.v2.js";
import { RESOURCE_RERANKER_PROMPT_VERSION } from "../ai/prompts/resource-reranker.v1.js";
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
 * 严格内部 Schema 是最终隐私白名单。即使调用方持有原始业务对象，文件 Sink 也只能接收
 * 这里列出的聚合字段；新增字段必须经过显式代码与测试审核。
 */
export const RunLogRecordSchema = z.strictObject({
  schemaVersion: z.literal("run-log.v1"),
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
  warningCodes: UniqueWarningCodesSchema,
  errorCodes: UniqueErrorCodesSchema,
  versions: z.strictObject({
    protocol: z.literal("0.1"),
    resultGraph: z.literal("0.1"),
    plannerPrompt: z.literal(GRAPH_PLANNER_PROMPT_VERSION),
    reviserPrompt: z.literal(GRAPH_REVISER_PROMPT_VERSION),
    rerankerPrompt: z.literal(RESOURCE_RERANKER_PROMPT_VERSION),
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
  tokens: z.strictObject({
    status: z.enum(["not_used", "complete", "partial", "unavailable"]),
    observations: NonNegativeIntegerSchema,
    inputTokens: NonNegativeIntegerSchema,
    outputTokens: NonNegativeIntegerSchema,
    totalTokens: NonNegativeIntegerSchema,
  }),
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

export type RunLogRecorder = Readonly<{
  observe: (observation: RunLogObservation) => void;
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
  recordEvent: (payload: StreamEventPayload) => void;
  recordInterrupted: (cancelled: boolean) => void;
  finish: () => Promise<void>;
}>;

type MutableCounts = z.infer<typeof RunLogRecordSchema>["counts"];
type MutableCacheMetrics = z.infer<typeof RunLogRecordSchema>["cache"];

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
  const warningCodes: NodeWarningCode[] = [];
  const errorCodes: AppErrorCode[] = [];
  const tokens = {
    observations: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

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
        schemaVersion: "run-log.v1",
        createdAt,
        identifiers: { logId, queryId, planId },
        outcome,
        timingsMs: {
          planning: planningMs,
          nodeProcessing: nodeProcessingMs,
          total: totalMs,
          provider: providerTimings,
        },
        counts,
        warningCodes,
        errorCodes,
        versions: {
          protocol: "0.1",
          resultGraph: "0.1",
          plannerPrompt: GRAPH_PLANNER_PROMPT_VERSION,
          reviserPrompt: GRAPH_REVISER_PROMPT_VERSION,
          rerankerPrompt: RESOURCE_RERANKER_PROMPT_VERSION,
        },
        providers: {
          search: input.searchProviderId,
          llm: input.llmProviderId,
        },
        cache,
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
    recordPlan,
    recordNodeProcessingStarted,
    recordProviderCallStarted,
    recordProviderCallFinished,
    recordEvent,
    recordInterrupted,
    finish,
  };
}
