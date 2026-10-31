/**
 * 模块职责：在精确 canonical URL 去重后，过滤同一页面的明确语言副本。
 *
 * 保守边界：只识别首个 Path Segment 或唯一的语言 Query 参数；
 * 任何冲突、重复参数或未知标记都 fail-open（失败时保留）。
 * 本函数不改写 URL、canonicalUrl 或候选对象，只稳定过滤输入数组。
 */
import type {
  CandidateSearchHit,
  SearchLanguage,
} from "@wayfinder/contracts";

const LANGUAGE_QUERY_KEYS = new Set(["lang", "language", "locale"]);
const LANGUAGE_MARKERS = Object.freeze({
  "zh-CN": new Set(["zh-cn", "zh-hans", "zh", "cn"]),
  "en-US": new Set(["en", "en-us", "en-gb"]),
} as const satisfies Readonly<Record<SearchLanguage, ReadonlySet<string>>>);

type LanguageKind = SearchLanguage | "neutral";
type GroupableCandidate = Readonly<{
  index: number;
  groupKey: string;
  languageKind: LanguageKind;
}>;

/** Locale marker 的规范化是专用规则，绝不用它改写真实 URL。 */
function normalizeLanguageMarker(value: string): string {
  return value.replaceAll("_", "-").replace(/[A-Z]/g, character =>
    character.toLowerCase(),
  );
}

function classifyLanguageMarker(
  value: string,
): Exclude<LanguageKind, "neutral"> | null {
  const marker = normalizeLanguageMarker(value);
  if (LANGUAGE_MARKERS["zh-CN"].has(marker)) return "zh-CN";
  if (LANGUAGE_MARKERS["en-US"].has(marker)) return "en-US";
  return null;
}

function normalizeTitle(title: string): string {
  return title.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * 投影可审核的分组身份。Path 与 Query 语言维度不能同时存在；
 * Query 只允许一个指定 key 出现一次，否则整个候选不参与分组。
 */
function describeGroupableCandidate(
  candidate: CandidateSearchHit,
  index: number,
): GroupableCandidate | null {
  let url: URL;
  try {
    url = new URL(candidate.canonicalUrl);
  } catch {
    return null;
  }

  const pathSegments = url.pathname.split("/");
  const firstPathSegment = pathSegments[1] ?? "";
  const pathLanguage = classifyLanguageMarker(firstPathSegment);

  const languageParameters = [...url.searchParams.entries()].filter(([key]) =>
    LANGUAGE_QUERY_KEYS.has(key),
  );
  if (languageParameters.length > 1) return null;

  const queryLanguageEntry = languageParameters[0];
  const queryLanguage =
    queryLanguageEntry === undefined
      ? null
      : classifyLanguageMarker(queryLanguageEntry[1]);
  if (queryLanguageEntry !== undefined && queryLanguage === null) return null;
  if (pathLanguage !== null && queryLanguage !== null) return null;

  let languageKind: LanguageKind = "neutral";
  if (pathLanguage !== null) {
    languageKind = pathLanguage;
    pathSegments.splice(1, 1);
    url.pathname = pathSegments.join("/") || "/";
  } else if (queryLanguageEntry !== undefined && queryLanguage !== null) {
    languageKind = queryLanguage;
    url.searchParams.delete(queryLanguageEntry[0]);
    url.searchParams.sort();
  }

  return {
    index,
    languageKind,
    // JSON tuple 避免 origin/title/path/query 中的分隔符造成拼接碰撞。
    groupKey: JSON.stringify([
      url.origin,
      normalizeTitle(candidate.title),
      url.pathname,
      url.search,
    ]),
  };
}

/**
 * 当且仅当组内有明确目标语言时，保留 Provider 顺序最靠前的目标副本。
 * 两遍扫描允许目标副本出现在其他语言或中性入口之后，且保持其他候选相对顺序。
 */
export function preferLocalizedSiblings(
  candidates: readonly CandidateSearchHit[],
  language: SearchLanguage,
): CandidateSearchHit[] {
  const described = candidates
    .map(describeGroupableCandidate)
    .filter((value): value is GroupableCandidate => value !== null);
  const groups = new Map<string, GroupableCandidate[]>();
  for (const candidate of described) {
    const group = groups.get(candidate.groupKey) ?? [];
    group.push(candidate);
    groups.set(candidate.groupKey, group);
  }

  const removedIndexes = new Set<number>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const winner = group.find(candidate => candidate.languageKind === language);
    if (winner === undefined) continue;
    for (const candidate of group) {
      if (candidate.index !== winner.index) removedIndexes.add(candidate.index);
    }
  }

  return candidates.filter((_candidate, index) => !removedIndexes.has(index));
}
