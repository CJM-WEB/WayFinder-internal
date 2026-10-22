/**
 * 模块职责：在 Rerank/Heuristic 已确定的质量与安全顺序上执行最小 Source Diversity
 *（来源多样性）约束，避免后续默认 Top 3 被同一精确 hostname 完全占据。
 *
 * 边界说明：本模块只做稳定过滤，不重新评分、重排、补齐、分类 sourceType，
 * 也不构造最终 Resource；幸存 Candidate 的全部字段和对象身份保持不变。
 */
import type { ResourceCandidate } from "@wayfinder/contracts";

/** V0 的批准规则：每个精确 hostname 默认最多保留两个 Candidate。 */
export const MAX_CANDIDATES_PER_DOMAIN = 2;

/**
 * Candidate 正常来自 WAY-48 的规范化结果；这里仍防御性复核，避免绕过前序调用时
 * 由冲突 domain 操纵分组。V0 没有组织归属数据，因此不猜测 eTLD+1 或子域关系。
 */
function readExactDomain(candidate: ResourceCandidate): string {
  let canonicalUrl: URL;
  try {
    canonicalUrl = new URL(candidate.hit.canonicalUrl);
  } catch {
    throw new TypeError("Diversity Candidate canonicalUrl 无效");
  }

  if (
    (canonicalUrl.protocol !== "http:" &&
      canonicalUrl.protocol !== "https:") ||
    canonicalUrl.hostname !== candidate.hit.domain
  ) {
    throw new TypeError("Diversity Candidate domain 与 canonicalUrl 不一致");
  }

  return canonicalUrl.hostname;
}

/**
 * 单次稳定扫描只返回输入的子序列。全为同域时最多返回两条；这不是失败，也不能
 * 为达到 Top 3 从已淘汰集合回捞或生成占位项。默认展示与质量阈值属于 WAY-56。
 */
export function applySourceDiversity(
  candidates: readonly ResourceCandidate[],
): ResourceCandidate[] {
  const retained: ResourceCandidate[] = [];
  const domainCounts = new Map<string, number>();

  for (const candidate of candidates) {
    const domain = readExactDomain(candidate);
    const retainedForDomain = domainCounts.get(domain) ?? 0;
    if (retainedForDomain >= MAX_CANDIDATES_PER_DOMAIN) {
      continue;
    }

    retained.push(candidate);
    domainCounts.set(domain, retainedForDomain + 1);
  }

  return retained;
}
