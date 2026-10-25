/**
 * 模块职责：把 WAY-53 的结构化 Rerank 决策合并回既有 Candidate，并在已知普通
 * Rerank 失败时保持 Heuristic 顺序，向后续 Node Pipeline 交付精确 Warning。
 *
 * 边界说明：本模块不构造最终 Resource 或 Node 终态。Diversity、Finalizer 与
 * ready/partial/failed 判定分别属于后续 WAY；这里只返回统一的 Candidate 形状。
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

const RERANK_FAILED_WARNING = ["RERANK_FAILED"] as const satisfies
  readonly NodeWarningCode[];

export type RerankCandidatesOutcome = Readonly<{
  /** 成功时按模型决策排序；降级时保持调用方提供的 Heuristic 顺序。 */
  candidates: readonly ResourceCandidate[];
  /** 调用方与 Search / Extract Warning 合并后，才能在 WAY-57 决定 Node 终态。 */
  warnings: readonly NodeWarningCode[];
}>;

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
  input: RerankResourcesInput,
): Promise<RerankCandidatesOutcome> {
  input.signal.throwIfAborted();
  if (input.candidates.length === 0) {
    return { candidates: [], warnings: [] };
  }

  try {
    const decisions = await rerankResources(input);
    return {
      candidates: mergeDecisions(input.candidates, decisions),
      warnings: [],
    };
  } catch (error: unknown) {
    // Run 取消/Deadline 拥有最高优先级，即使同时观察到普通 Rerank 错误也要传播 reason。
    input.signal.throwIfAborted();
    if (!(error instanceof ResourceRerankError)) {
      throw error;
    }

    return {
      candidates: input.candidates,
      warnings: RERANK_FAILED_WARNING,
    };
  }
}
