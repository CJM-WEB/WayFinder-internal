/**
 * 模块职责：组合单个 Graph Node（图节点）的检索与排序计算，并返回未做跨 Node
 * 仲裁的 ready / partial 结果。
 *
 * 生命周期边界：取消与绝对 Run deadline 由上层 Orchestrator 统一管理；只要共享
 * Signal 已终止，本模块就原样抛出 reason；Node 终态由 Run 级协调器统一仲裁后发送。
 */
import {
  ResultGraphNodeSchema,
  StreamEventPayloadSchema,
  type AppErrorCode,
  type GraphPlanNode,
  type NodeWarningCode,
  type QueryAnalysis,
  type ResultGraphNode,
  type SearchLanguage,
  type StreamEventPayload,
} from "@wayfinder/contracts";

import type { LLMProvider } from "../ai/llm-provider.js";
import type { SearchProvider } from "../search/provider.js";
import {
  NodeSearchError,
  runNodeSearches,
} from "../search/run-node-searches.js";
import { guardAndShortlistCandidates } from "./candidate-guard.js";
import { canonicalizeAndDeduplicateCandidates } from "./canonicalize-candidates.js";
import { heuristicRankCandidates } from "./heuristic-rank.js";
import { preferLocalizedSiblings } from "./prefer-localized-siblings.js";
import {
  detectOfficialSourceSignals,
  type OfficialSourcePolicy,
} from "./official-source.js";
import { rerankCandidatesWithFallback } from "./rerank-candidates.js";
import { applyTrustedRiskSafetyOrder } from "./rank-fusion.js";
import {
  createRankingObservation,
  type RankingObservation,
} from "./ranking-observation.js";
import { finalizeResources } from "./resource-finalizer.js";

type NodeJobRejectedCode = Exclude<
  AppErrorCode,
  "RUN_DEADLINE_EXCEEDED" | "REQUEST_ABORTED"
>;

type SuccessfulResultGraphNode = Extract<
  ResultGraphNode,
  { status: "ready" | "partial" }
>;

export type NodeStreamEventPayload = Extract<
  StreamEventPayload,
  {
    type: "node.status" | "node.ready" | "node.partial" | "node.failed";
  }
>;

export type NodeStatusEventPayload = Extract<
  NodeStreamEventPayload,
  { type: "node.status" }
>;

/**
 * 普通 Node Job（节点任务）失败的服务端结构。公共事件只投影 code/retryable，
 * cause 与 stack 仅供后续脱敏诊断使用，不能进入 Wire Contract（传输协议）。
 */
export class NodeJobError extends Error {
  public readonly code: NodeJobRejectedCode;
  public readonly retryable: boolean;

  public constructor(
    code: NodeJobRejectedCode,
    retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "NodeJobError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * Event Sink（事件接收器）失败属于 Run/传输层故障，不能伪装成 Node 业务失败。
 * cause 只在进程内保留，后续日志仍须脱敏。
 */
export class NodeEventEmissionError extends Error {
  public constructor(options?: ErrorOptions) {
    super("NODE_EVENT_EMISSION_FAILED", options);
    this.name = "NodeEventEmissionError";
  }
}

export type ProcessNodeContext = Readonly<{
  /** GraphPlan.analysis 是 Query 分析的单一事实来源。 */
  analysis: QueryAnalysis;
  /** 业务层只依赖通用 Search Port，不感知 SerpAPI 私有字段。 */
  searchProvider: SearchProvider;
  /** Reranker 只依赖 SDK 无关的 Structured Output Port。 */
  rerankProvider: LLMProvider;
  officialSourcePolicy: OfficialSourcePolicy;
  /** 调用方注入同一次 Run 的稳定时间，避免各 Node 自行读取墙上时钟。 */
  nowMs: number;
  /** Rerank 阶段配置上限；真正调用前还要按 Run 当前剩余预算再次收窄。 */
  rerankTimeoutMs: number;
  /** 计算阶段只发送进度；所有终态由 Run 级协调器在全图仲裁后发送。 */
  emit: (payload: NodeStatusEventPayload) => Promise<void>;
  /** 匿名排序观测是旁路能力，失败不得改变 Node 结果。 */
  observeRanking?: (observation: RankingObservation) => void;
  language: SearchLanguage;
}>;

/**
 * Node Pipeline 只消费 Orchestrator 创建的同一 Run Scope，不接收 deadlineAt 数值，
 * 也不创建第二个 Timer。同步预算读取用于封闭 Timer 回调被事件循环延迟的窗口。
 */
export type ProcessNodeRunScope = Readonly<{
  signal: AbortSignal;
  requirePositiveRemainingMs: () => number;
}>;

/** 已知业务失败保留精确 code；未知内部错误收敛为不可重试的 UNKNOWN。 */
export function toNodeJobError(error: unknown): NodeJobError {
  if (error instanceof NodeJobError) {
    return error;
  }
  if (error instanceof NodeSearchError) {
    return new NodeJobError(error.code, error.retryable);
  }

  return new NodeJobError("UNKNOWN", false, { cause: error });
}

/**
 * Warning 按阶段首次出现的顺序保留并主动去重。当前 Search 与 Rerank 各自产生不同 code，
 * 此处仍守住公共 Contract 的唯一性，避免未来阶段组合变化制造非法 partial Node。
 */
function appendUniqueWarnings(
  target: NodeWarningCode[],
  additions: readonly NodeWarningCode[],
): void {
  for (const warning of additions) {
    if (!target.includes(warning)) {
      target.push(warning);
    }
  }
}

/** 在交给传输层前先校验 Payload，防止内部调用绕过公共 Event Contract。 */
async function emitValidated(
  emit: ProcessNodeContext["emit"],
  payload: NodeStatusEventPayload,
): Promise<void> {
  const parsed = StreamEventPayloadSchema.parse(payload);
  try {
    if (parsed.type !== "node.status") {
      // 输入类型已经固定为进度事件；此分支防止未来 Schema 调整后边界静默扩大。
      throw new TypeError("processNode 只能发送 Node 状态事件");
    }
    await emit(parsed);
  } catch (error: unknown) {
    throw new NodeEventEmissionError({ cause: error });
  }
}

/**
 * 依次执行已批准的单 Node Pipeline。成功与局部降级返回完整 ResultGraphNode；
 * 普通失败只抛 NodeJobError，供上层生成 rejected outcome 并执行全图终态仲裁。
 */
export async function processNode(
  node: GraphPlanNode,
  context: ProcessNodeContext,
  runScope: ProcessNodeRunScope,
): Promise<ResultGraphNode> {
  const { signal } = runScope;
  const warnings: NodeWarningCode[] = [];
  let result: SuccessfulResultGraphNode;
  let rankingObservation: RankingObservation | undefined;

  try {
    signal.throwIfAborted();
    await emitValidated(context.emit, {
      type: "node.status",
      nodeId: node.id,
      status: "searching",
    });

    // 每次外调前同步读取同一绝对预算，不能只依赖可能迟到执行的 Timer 回调。
    runScope.requirePositiveRemainingMs();
    const searchOutcome = await runNodeSearches({
      node,
      freshnessSensitive: context.analysis.freshnessSensitive,
      searchProvider: context.searchProvider,
      signal,
      language: context.language,
    });
    appendUniqueWarnings(warnings, searchOutcome.warnings);

    await emitValidated(context.emit, {
      type: "node.status",
      nodeId: node.id,
      status: "filtering",
    });

    // 确定性阶段只消费 Adapter 已规范化字段；Canonicalize 会立即移除 rawMetadata。
    const canonicalized = canonicalizeAndDeduplicateCandidates(
      searchOutcome.hits,
    );
    // 语言副本门禁必须早于 Candidate Guard / Top 6，使删除项不占据名额。
    const localized = preferLocalizedSiblings(canonicalized, context.language);
    const guarded = guardAndShortlistCandidates(localized);
    const shortlisted = guarded.accepted;
    if (shortlisted.length === 0) {
      throw new NodeJobError("SEARCH_PROVIDER_FAILED", true);
    }
    const assessments = detectOfficialSourceSignals(
      context.analysis,
      node,
      shortlisted,
      context.officialSourcePolicy,
    );
    const preRanked = heuristicRankCandidates({
      analysis: context.analysis,
      node,
      assessments,
      nowMs: context.nowMs,
    });
    const candidateByUrl = new Map(
      preRanked.map(candidate => [candidate.hit.canonicalUrl, candidate]),
    );
    const providerOrdered = shortlisted.map(hit => {
      const candidate = candidateByUrl.get(hit.canonicalUrl);
      if (candidate === undefined) {
        throw new TypeError("Provider 与 Heuristic 候选集合不一致");
      }
      return candidate;
    });

    // SerpAPI Adapter 已返回首屏摘要；生产链路不再远程 Extract，空 pages 是正常输入。
    const rerankTimeoutMs = Math.min(
      context.rerankTimeoutMs,
      runScope.requirePositiveRemainingMs(),
    );
    const reranked = await rerankCandidatesWithFallback({
      node,
      language: context.language,
      candidates: providerOrdered,
      fallbackCandidates: preRanked,
      pages: [],
      provider: context.rerankProvider,
      signal,
      timeoutMs: rerankTimeoutMs,
    });
    appendUniqueWarnings(warnings, reranked.warnings);

    // Safety 只在融合后稳定应用一次；它隔离已知风险，但不删除或重新评分。
    const safetyOrdered = applyTrustedRiskSafetyOrder(
      reranked.candidates,
      assessments,
    );
    try {
      rankingObservation = createRankingObservation({
        fusionMode: reranked.kind,
        providerOrder: providerOrdered,
        heuristicOrder: preRanked,
        finalOrder: safetyOrdered,
      });
    } catch {
      // 观测投影同样属于旁路；内部身份核对异常不能覆盖已经完成的业务排序。
    }
    const resources = finalizeResources(safetyOrdered, context.language);
    if (resources.length === 0) {
      throw new NodeJobError("SEARCH_PROVIDER_FAILED", true);
    }

    const parsedResult = ResultGraphNodeSchema.parse({
      ...node,
      status: warnings.length === 0 ? "ready" : "partial",
      resources,
      warnings,
    });
    if (parsedResult.status === "failed") {
      // 构造值已固定为 ready/partial；此分支只防止未来 Schema 重构扩大返回类型。
      throw new TypeError("processNode 成功路径不能生成 failed Node");
    }
    result = parsedResult;
  } catch (error: unknown) {
    // Cancellation/Deadline 必须优先于同时发生的普通错误，且由上层生命周期统一结算。
    if (signal.aborted) {
      throw signal.reason;
    }
    if (error instanceof NodeEventEmissionError) {
      throw error;
    }

    throw toNodeJobError(error);
  }

  // 最后一次外部调用结算后再次守住 Run 生命周期，禁止发送迟到的 ready/partial。
  signal.throwIfAborted();

  try {
    if (rankingObservation !== undefined) {
      context.observeRanking?.(rankingObservation);
    }
  } catch {
    // Ranking 已真实完成；后续全图仲裁即使清空 Node，也必须保留这条覆盖事实。
  }
  return result;
}
