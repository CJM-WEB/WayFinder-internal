/**
 * 模块职责：把 Provider Adapter（提供方适配器）的标准化搜索结果投影为业务候选，
 * 并在进入 Ranking（排序）前完成确定性的 URL 规范化与全局去重。
 *
 * 失败路径：单条 URL 无法解析或不是 HTTP(S) 时仅丢弃该条，不能让整批失败。
 * 安全边界：始终逐字段构造 CandidateSearchHit，避免 rawMetadata 等第三方私有字段泄漏。
 */
import type {
  CandidateSearchHit,
  NormalizedSearchHit,
} from "@wayfinder/contracts";
import { canonicalizeHttpUrl } from "@wayfinder/contracts";

/**
 * 显式投影业务允许字段，同时重新派生 canonicalUrl 与 domain。
 * 可选字段必须保持“缺失”语义，不能写入 undefined 破坏 exactOptionalPropertyTypes。
 */
function projectCandidate(
  hit: NormalizedSearchHit,
  canonicalUrl: URL,
): CandidateSearchHit {
  return {
    provider: hit.provider,
    ...(hit.engine === undefined ? {} : { engine: hit.engine }),
    query: hit.query,
    title: hit.title,
    url: hit.url,
    canonicalUrl: canonicalUrl.toString(),
    domain: canonicalUrl.hostname.toLowerCase(),
    snippet: hit.snippet,
    ...(hit.publishedAt !== undefined
      ? { publishedAt: hit.publishedAt }
      : {}),
    ...(hit.providerRank !== undefined
      ? { providerRank: hit.providerRank }
      : {}),
    ...(hit.providerScore !== undefined
      ? { providerScore: hit.providerScore }
      : {}),
  };
}

/**
 * 按输入顺序保留第一个合法 canonical URL。标题相同不代表页面相同，因此不参与
 * 去重；丢弃项不合并字段，也不会污染后续去重集合。
 */
export function canonicalizeAndDeduplicateCandidates(
  hits: readonly NormalizedSearchHit[],
): CandidateSearchHit[] {
  const candidates: CandidateSearchHit[] = [];
  const seenCanonicalUrls = new Set<string>();

  for (const hit of hits) {
    const canonicalUrl = canonicalizeHttpUrl(hit.url);
    if (canonicalUrl === null) {
      continue;
    }

    const candidate = projectCandidate(hit, canonicalUrl);
    if (seenCanonicalUrls.has(candidate.canonicalUrl)) {
      continue;
    }

    seenCanonicalUrls.add(candidate.canonicalUrl);
    candidates.push(candidate);
  }

  return candidates;
}
