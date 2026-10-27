/**
 * 模块职责：把结构化 Rerank 决策合并回既有 Candidate，并执行 WAY-108 的三路
 * 序位融合；已知普通失败时改用 Provider / Heuristic 双路融合并交付精确 Warning。
 *
 * 边界说明：本模块不构造最终 Resource 或 Node 终态。Finalizer 与
 * ready/partial/failed 判定属于后续阶段；这里只返回统一的 Candidate 形状。
 */
import type {
  NodeWarningCode,
  ResourceCandidate,
} from "@wayfinder/contracts";

import {
  rerankResources,
  ResourceRerankError,
  type RerankResourcesInput,
  type ResourceRerankDecision,
} from "../ai/resource-reranker.js";
import {
  fuseFallbackCandidateRanks,
  fuseThreeWayCandidateRanks,
} from "./rank-fusion.js";

const RERANK_FAILED_WARNING = ["RERANK_FAILED"] as const satisfies
  readonly NodeWarningCode[];

export type RerankCandidatesOutcome =
  | Readonly<{
      kind: "llm_success";
      candidates: readonly ResourceCandidate[];
      warnings: readonly [];
    }>
  | Readonly<{
      kind: "fallback";
      candidates: readonly ResourceCandidate[];
      warnings: typeof RERANK_FAILED_WARNING;
    }>;

export type RerankCandidatesWithFallbackInput = RerankResourcesInput &
  Readonly<{
    /** LLM 始终读取 Provider 顺序；Heuristic Order 只参与融合与普通失败回退。 */
    fallbackCandidates?: readonly ResourceCandidate[];
  }>;

function assertSameCandidateSet(
  candidates: readonly ResourceCandidate[],
  fallbackCandidates: readonly ResourceCandidate[] | undefined,
): void {
  if (fallbackCandidates === undefined) return;

  const identityById = new Map(
    candidates.map(candidate => [
      candidate.candidateId,
      candidate.hit.canonicalUrl,
    ]),
  );
  const fallbackIds = new Set(
    fallbackCandidates.map(candidate => candidate.candidateId),
  );
  if (
    identityById.size !== candidates.length ||
    fallbackIds.size !== fallbackCandidates.length ||
    fallbackCandidates.length !== candidates.length ||
    fallbackCandidates.some(
      candidate =>
        identityById.get(candidate.candidateId) !== candidate.hit.canonicalUrl,
    )
  ) {
    throw new TypeError("Rerank 与 fallback 候选集合不一致");
  }
}

/** Zod 的多 Profile 联合会产生可选键；只投影实际存在的有限数值，禁止断言绕过。 */
function projectScores(
  scores: ResourceRerankDecision["scores"],
): Record<string, number> {
  const projected: Record<string, number> = {};
  for (const [key, value] of Object.entries(scores)) {
    if (value !== undefined) {
      projected[key] = value;
    }
  }
  return projected;
}

/**
 * 只复制允许由 Reranker 补充的决策字段；URL、Hit 与 Heuristic 信号始终取自
 * 原 Candidate，网页正文和模型无法覆盖这些确定性身份字段。
 */
function mergeDecisions(
  candidates: readonly ResourceCandidate[],
  decisions: readonly ResourceRerankDecision[],
): ResourceCandidate[] {
  const candidateById = new Map(
    candidates.map(candidate => [candidate.candidateId, candidate]),
  );

  return decisions.map(decision => {
    const candidate = candidateById.get(decision.candidateId);
    if (candidate === undefined) {
      // rerankResources 已冻结完整唯一映射；到达这里代表内部不变量被破坏。
      throw new TypeError("Rerank Candidate 映射不变量被破坏");
    }

    return {
      candidateId: candidate.candidateId,
      hit: candidate.hit,
      heuristicScore: candidate.heuristicScore,
      heuristicSignals: candidate.heuristicSignals,
      scores: projectScores(decision.scores),
      summary: decision.summary,
      whySelected: decision.whySelected,
      ...(candidate.sourceType === undefined
        ? {}
        : { sourceType: candidate.sourceType }),
    };
  });
}

/**
 * 空候选没有可回退结果，直接交给后续 Finalizer/Node 终态处理为 failed。已知普通
 * Rerank 失败才产生 Warning；取消、绝对 Deadline 与未知程序错误绝不能伪装成降级成功。
 */
export async function rerankCandidatesWithFallback(
  input: RerankCandidatesWithFallbackInput,
): Promise<RerankCandidatesOutcome> {
  input.signal.throwIfAborted();
  assertSameCandidateSet(input.candidates, input.fallbackCandidates);
  if (input.candidates.length === 0) {
    // 生产链不会传空集合；保留旧内部调用的无副作用语义。
    return { kind: "llm_success", candidates: [], warnings: [] };
  }

  const heuristicOrder = input.fallbackCandidates ?? input.candidates;

  try {
    const decisions = await rerankResources(input);
    const llmOrder = mergeDecisions(input.candidates, decisions);
    return {
      kind: "llm_success",
      candidates: fuseThreeWayCandidateRanks({
        providerOrder: input.candidates,
        heuristicOrder,
        llmOrder,
      }).candidates,
      warnings: [],
    };
  } catch (error: unknown) {
    // Run 取消/Deadline 拥有最高优先级，即使同时观察到普通 Rerank 错误也要传播 reason。
    input.signal.throwIfAborted();
    if (!(error instanceof ResourceRerankError)) {
      throw error;
    }

    return {
      kind: "fallback",
      candidates: fuseFallbackCandidateRanks({
        providerOrder: input.candidates,
        heuristicOrder,
      }).candidates,
      warnings: RERANK_FAILED_WARNING,
    };
  }
}
