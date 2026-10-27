/**
 * 模块职责：在 WAY-107 冻结的同一批 Candidate 上执行确定性序位融合，并在融合后
 * 稳定应用一次可信风险层级。
 *
 * 关键边界：
 * - Provider / Heuristic / LLM 只提供顺序，不混合各自私有原始分数；
 * - 三路 Candidate 身份与集合必须一致，缺项、重复或 URL 身份漂移立即失败；
 * - 只舍入最终融合分，同分再按 Provider Rank、Heuristic Rank、canonicalUrl 决胜；
 * - Safety 只稳定重排现有候选，不删除、不重新评分，也不认证官网。
 */
import type { ResourceCandidate } from "@wayfinder/contracts";

import { MAX_RERANK_CANDIDATES_PER_NODE } from "./candidate-guard.js";
import type { OfficialSourceAssessment } from "./official-source.js";

export const RANK_FUSION_VERSION = "rank-fusion.v1" as const;

export const THREE_WAY_RANK_WEIGHTS = Object.freeze({
  provider: 0.55,
  heuristic: 0.1,
  llm: 0.35,
});

export const FALLBACK_RANK_WEIGHTS = Object.freeze({
  provider: 11 / 13,
  heuristic: 2 / 13,
});

const SCORE_PRECISION = 1_000_000;

export type FusedCandidateRank = Readonly<{
  candidate: ResourceCandidate;
  providerRank: number;
  heuristicRank: number;
  llmRank?: number;
  finalRankScore: number;
}>;

export type RankFusionResult = Readonly<{
  candidates: readonly ResourceCandidate[];
  ranks: readonly FusedCandidateRank[];
}>;

type IndexedCandidate = Readonly<{
  candidate: ResourceCandidate;
  rank: number;
}>;

/** Rank 从 1 开始；函数只冻结数学语义，不读取候选内容。 */
export function rankUtility(rank: number): number {
  if (!Number.isSafeInteger(rank) || rank < 1) {
    throw new TypeError("序位必须为正安全整数");
  }
  return 1 / Math.log2(rank + 1);
}

function roundFinalScore(value: number): number {
  return Math.round(value * SCORE_PRECISION) / SCORE_PRECISION;
}

function compareCanonicalUrl(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 公开内部 Tie-break，便于用构造值直接验证完整决胜顺序。 */
export function compareRankFusionTieBreak(
  left: Pick<FusedCandidateRank, "providerRank" | "heuristicRank" | "candidate">,
  right: Pick<FusedCandidateRank, "providerRank" | "heuristicRank" | "candidate">,
): number {
  return (
    left.providerRank - right.providerRank ||
    left.heuristicRank - right.heuristicRank ||
    compareCanonicalUrl(
      left.candidate.hit.canonicalUrl,
      right.candidate.hit.canonicalUrl,
    )
  );
}

function indexCandidateOrder(
  label: "Provider" | "Heuristic" | "LLM",
  candidates: readonly ResourceCandidate[],
): ReadonlyMap<string, IndexedCandidate> {
  if (
    candidates.length < 1 ||
    candidates.length > MAX_RERANK_CANDIDATES_PER_NODE
  ) {
    throw new TypeError(
      `${label} Rank Candidate 数量必须为 1 到 ${MAX_RERANK_CANDIDATES_PER_NODE}`,
    );
  }

  const indexed = new Map<string, IndexedCandidate>();
  const canonicalUrls = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    if (
      candidate.candidateId.length === 0 ||
      candidate.hit.canonicalUrl.length === 0 ||
      indexed.has(candidate.candidateId) ||
      canonicalUrls.has(candidate.hit.canonicalUrl)
    ) {
      throw new TypeError(`${label} Rank Candidate 身份无效或重复`);
    }
    indexed.set(candidate.candidateId, { candidate, rank: index + 1 });
    canonicalUrls.add(candidate.hit.canonicalUrl);
  }
  return indexed;
}

function assertSameCandidateSet(
  reference: ReadonlyMap<string, IndexedCandidate>,
  compared: ReadonlyMap<string, IndexedCandidate>,
  label: "Heuristic" | "LLM",
): void {
  if (reference.size !== compared.size) {
    throw new TypeError(`${label} Rank Candidate 集合不一致`);
  }
  for (const [candidateId, referenceEntry] of reference) {
    const comparedEntry = compared.get(candidateId);
    if (
      comparedEntry === undefined ||
      comparedEntry.candidate.hit.canonicalUrl !==
        referenceEntry.candidate.hit.canonicalUrl
    ) {
      throw new TypeError(`${label} Rank Candidate 集合不一致`);
    }
  }
}

function createRankedResult(
  providerOrder: readonly ResourceCandidate[],
  heuristicOrder: readonly ResourceCandidate[],
  llmOrder: readonly ResourceCandidate[] | undefined,
): RankFusionResult {
  const provider = indexCandidateOrder("Provider", providerOrder);
  const heuristic = indexCandidateOrder("Heuristic", heuristicOrder);
  assertSameCandidateSet(provider, heuristic, "Heuristic");

  const llm =
    llmOrder === undefined ? undefined : indexCandidateOrder("LLM", llmOrder);
  if (llm !== undefined) assertSameCandidateSet(provider, llm, "LLM");

  // 成功路径保留 LLM 生成的摘要/解释；fallback 使用 Heuristic Candidate 原对象。
  const outputOrder = llm ?? heuristic;
  const ranks = [...outputOrder.values()].map(({ candidate }) => {
    const providerRank = provider.get(candidate.candidateId)!.rank;
    const heuristicRank = heuristic.get(candidate.candidateId)!.rank;
    const llmRank = llm?.get(candidate.candidateId)?.rank;
    const rawScore =
      llmRank === undefined
        ? FALLBACK_RANK_WEIGHTS.provider * rankUtility(providerRank) +
          FALLBACK_RANK_WEIGHTS.heuristic * rankUtility(heuristicRank)
        : THREE_WAY_RANK_WEIGHTS.provider * rankUtility(providerRank) +
          THREE_WAY_RANK_WEIGHTS.heuristic * rankUtility(heuristicRank) +
          THREE_WAY_RANK_WEIGHTS.llm * rankUtility(llmRank);

    return {
      candidate,
      providerRank,
      heuristicRank,
      ...(llmRank === undefined ? {} : { llmRank }),
      finalRankScore: roundFinalScore(rawScore),
    };
  });

  ranks.sort(
    (left, right) =>
      right.finalRankScore - left.finalRankScore ||
      compareRankFusionTieBreak(left, right),
  );
  return {
    candidates: ranks.map(entry => entry.candidate),
    ranks,
  };
}

export function fuseThreeWayCandidateRanks(input: Readonly<{
  providerOrder: readonly ResourceCandidate[];
  heuristicOrder: readonly ResourceCandidate[];
  llmOrder: readonly ResourceCandidate[];
}>): RankFusionResult {
  return createRankedResult(
    input.providerOrder,
    input.heuristicOrder,
    input.llmOrder,
  );
}

export function fuseFallbackCandidateRanks(input: Readonly<{
  providerOrder: readonly ResourceCandidate[];
  heuristicOrder: readonly ResourceCandidate[];
}>): RankFusionResult {
  return createRankedResult(input.providerOrder, input.heuristicOrder, undefined);
}

function safetyTier(assessment: OfficialSourceAssessment): number {
  if (
    assessment.queryKind !== "download" &&
    assessment.queryKind !== "documentation"
  ) {
    return 0;
  }
  return assessment.classification === "unknown" ? 1 : 0;
}

/**
 * 只在融合完成后稳定应用一次 `unknown > risky`。输入必须与 Assessment 一一对应；
 * 同层按融合后的 originalIndex 保序，因此不会形成第二套排序分数。
 */
export function applyTrustedRiskSafetyOrder(
  candidates: readonly ResourceCandidate[],
  assessments: readonly OfficialSourceAssessment[],
): ResourceCandidate[] {
  if (candidates.length !== assessments.length) {
    throw new TypeError("可信风险 Assessment 与融合候选集合不一致");
  }

  const assessmentByUrl = new Map<string, OfficialSourceAssessment>();
  for (const assessment of assessments) {
    const canonicalUrl = assessment.candidate.canonicalUrl;
    if (assessmentByUrl.has(canonicalUrl)) {
      throw new TypeError("可信风险 Assessment 与融合候选集合不一致");
    }
    assessmentByUrl.set(canonicalUrl, assessment);
  }

  const seenCandidateUrls = new Set<string>();
  const ordered = candidates.map((candidate, originalIndex) => {
    const canonicalUrl = candidate.hit.canonicalUrl;
    const assessment = assessmentByUrl.get(canonicalUrl);
    if (seenCandidateUrls.has(canonicalUrl) || assessment === undefined) {
      throw new TypeError("可信风险 Assessment 与融合候选集合不一致");
    }
    seenCandidateUrls.add(canonicalUrl);
    return { candidate, originalIndex, tier: safetyTier(assessment) };
  });

  if (seenCandidateUrls.size !== assessmentByUrl.size) {
    throw new TypeError("可信风险 Assessment 与融合候选集合不一致");
  }

  return ordered
    .sort(
      (left, right) =>
        right.tier - left.tier || left.originalIndex - right.originalIndex,
    )
    .map(entry => entry.candidate);
}
