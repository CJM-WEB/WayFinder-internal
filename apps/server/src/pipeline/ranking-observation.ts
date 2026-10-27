/**
 * 模块职责：把 Provider / Heuristic / Final 顺序差异投影为匿名排序事实。
 *
 * 隐私边界：输出只包含计数、布尔值与融合模式，不携带 Candidate ID、URL、标题、
 * 域名、分数或 Node ID；Run Log 只能聚合这些事实，不能还原候选内容。
 */
import type { ResourceCandidate } from "@wayfinder/contracts";

export type RankingFusionMode = "llm_success" | "fallback";

export type RankingObservation = Readonly<{
  fusionMode: RankingFusionMode;
  candidateCount: number;
  providerTop1Overridden: boolean;
  heuristicTop1Overridden: boolean;
  providerTop3FinalOverlap: number;
  heuristicTop3FinalOverlap: number;
  top3ComparisonSlots: number;
}>;

function identityMap(
  candidates: readonly ResourceCandidate[],
): ReadonlyMap<string, string> {
  const identities = new Map<string, string>();
  const urls = new Set<string>();
  for (const candidate of candidates) {
    if (
      identities.has(candidate.candidateId) ||
      urls.has(candidate.hit.canonicalUrl)
    ) {
      throw new TypeError("排序观测 Candidate 集合不一致");
    }
    identities.set(candidate.candidateId, candidate.hit.canonicalUrl);
    urls.add(candidate.hit.canonicalUrl);
  }
  return identities;
}

function assertSameIdentities(
  reference: ReadonlyMap<string, string>,
  candidates: readonly ResourceCandidate[],
): void {
  const compared = identityMap(candidates);
  if (
    compared.size !== reference.size ||
    [...reference].some(
      ([candidateId, canonicalUrl]) =>
        compared.get(candidateId) !== canonicalUrl,
    )
  ) {
    throw new TypeError("排序观测 Candidate 集合不一致");
  }
}

function countTopOverlap(
  baseline: readonly ResourceCandidate[],
  finalOrder: readonly ResourceCandidate[],
): number {
  const baselineIds = new Set(
    baseline.slice(0, 3).map(candidate => candidate.candidateId),
  );
  return finalOrder
    .slice(0, 3)
    .filter(candidate => baselineIds.has(candidate.candidateId)).length;
}

/** Top3 口径为集合重叠，分母是该 Node 实际存在的 `min(3, N)` 展示槽位。 */
export function createRankingObservation(input: Readonly<{
  fusionMode: RankingFusionMode;
  providerOrder: readonly ResourceCandidate[];
  heuristicOrder: readonly ResourceCandidate[];
  finalOrder: readonly ResourceCandidate[];
}>): RankingObservation {
  const providerTop1 = input.providerOrder[0];
  const heuristicTop1 = input.heuristicOrder[0];
  const finalTop1 = input.finalOrder[0];
  if (
    providerTop1 === undefined ||
    heuristicTop1 === undefined ||
    finalTop1 === undefined
  ) {
    throw new TypeError("排序观测要求非空 Candidate 顺序");
  }

  const identities = identityMap(input.providerOrder);
  assertSameIdentities(identities, input.heuristicOrder);
  assertSameIdentities(identities, input.finalOrder);

  const top3ComparisonSlots = Math.min(3, input.finalOrder.length);
  return {
    fusionMode: input.fusionMode,
    candidateCount: input.finalOrder.length,
    providerTop1Overridden:
      providerTop1.candidateId !== finalTop1.candidateId,
    heuristicTop1Overridden:
      heuristicTop1.candidateId !== finalTop1.candidateId,
    providerTop3FinalOverlap: countTopOverlap(
      input.providerOrder,
      input.finalOrder,
    ),
    heuristicTop3FinalOverlap: countTopOverlap(
      input.heuristicOrder,
      input.finalOrder,
    ),
    top3ComparisonSlots,
  };
}
