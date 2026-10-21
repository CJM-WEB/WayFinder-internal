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

/** V0 只移除已经明确确认的精确小写 Tracking 参数（追踪参数）。 */
const TRACKING_QUERY_PARAMETERS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
] as const;

/**
 * 使用平台原生 URL 实现确定性规范化。
 * 原生实现会统一主机大小写、默认端口与点路径；尾斜杠仍保留为不同页面语义。
 */
function canonicalizeUrl(input: string): URL | null {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(input);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return null;
  }

  for (const parameter of TRACKING_QUERY_PARAMETERS) {
    parsedUrl.searchParams.delete(parameter);
  }
  parsedUrl.hash = "";
  parsedUrl.searchParams.sort();

  return parsedUrl;
}

/** 标题只做 trim、连续空白折叠和小写化；V0 不做标点或语义相似度处理。 */
function createTitleKey(title: string): string {
  return title.trim().replace(/\s+/gu, " ").toLowerCase();
}

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
 * 按输入顺序保留第一个合法候选。canonical URL 或规范化标题与已保留候选重复时，
 * 丢弃当前项且不合并字段；因此非法项和被丢弃项不会污染后续去重集合。
 */
export function canonicalizeAndDeduplicateCandidates(
  hits: readonly NormalizedSearchHit[],
): CandidateSearchHit[] {
  const candidates: CandidateSearchHit[] = [];
  const seenCanonicalUrls = new Set<string>();
  const seenTitleKeys = new Set<string>();

  for (const hit of hits) {
    const canonicalUrl = canonicalizeUrl(hit.url);
    if (canonicalUrl === null) {
      continue;
    }

    const candidate = projectCandidate(hit, canonicalUrl);
    const titleKey = createTitleKey(candidate.title);

    if (
      seenCanonicalUrls.has(candidate.canonicalUrl) ||
      seenTitleKeys.has(titleKey)
    ) {
      continue;
    }

    seenCanonicalUrls.add(candidate.canonicalUrl);
    seenTitleKeys.add(titleKey);
    candidates.push(candidate);
  }

  return candidates;
}
