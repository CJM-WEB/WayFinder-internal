/**
 * 模块职责：在 Ranking（排序）前建立最小、确定性的候选安全边界。
 *
 * 该阶段只验证 URL 结构与已规范化域名的一致性，并按 Provider 原顺序截取前六条；
 * 不判断标题、摘要、路径、相关性或站点质量，避免本地规则覆盖搜索引擎的综合排序。
 */
import type { CandidateSearchHit } from "@wayfinder/contracts";

export const MAX_RERANK_CANDIDATES_PER_NODE = 6;

export type CandidateGuardOutcome = Readonly<{
  accepted: readonly CandidateSearchHit[];
  rejected: readonly Readonly<{
    candidate: CandidateSearchHit;
    reason: "ILLEGAL_URL";
  }>[];
}>;

function hasConsistentHttpDomain(candidate: CandidateSearchHit): boolean {
  try {
    const url = new URL(candidate.canonicalUrl);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname === candidate.domain
    );
  } catch {
    return false;
  }
}

/**
 * 稳定扫描确保非法项不会占用名额；达到六条后立即停止，后续 Heuristic 与 LLM
 * 只能重排这一个冻结集合，不能从 Provider 排名更低的位置补入候选。
 */
export function guardAndShortlistCandidates(
  candidates: readonly CandidateSearchHit[],
): CandidateGuardOutcome {
  const accepted: CandidateSearchHit[] = [];
  const rejected: Array<{
    candidate: CandidateSearchHit;
    reason: "ILLEGAL_URL";
  }> = [];

  for (const candidate of candidates) {
    if (!hasConsistentHttpDomain(candidate)) {
      rejected.push({ candidate, reason: "ILLEGAL_URL" });
      continue;
    }
    accepted.push(candidate);
    if (accepted.length === MAX_RERANK_CANDIDATES_PER_NODE) break;
  }

  return { accepted, rejected };
}
