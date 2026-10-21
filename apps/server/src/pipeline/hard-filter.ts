/**
 * 模块职责：在 Extract（正文抽取）和 Ranking（排序）之前，以低成本确定性规则
 * 拒绝明显不合格的搜索候选，并为每个拒绝结果保留稳定、可审计的原因列表。
 *
 * 安全边界：候选标题、摘要和 URL 都是 Untrusted Input（不可信输入）。本模块只做
 * URL 解析、Unicode 规范化、分词、计数与集合比较，绝不执行文本中的命令。
 */
import type {
  CandidateSearchHit,
  GraphNodeCore,
} from "@wayfinder/contracts";

export const HARD_FILTER_REASON_ORDER = [
  "ILLEGAL_URL",
  "EMPTY_SNIPPET",
  "OBVIOUS_SPAM",
  "DANGEROUS_DOWNLOAD_MIRROR",
  "CLEARLY_IRRELEVANT",
] as const;

export type HardFilterReason = (typeof HARD_FILTER_REASON_ORDER)[number];

export type HardFilterOutcome = {
  accepted: CandidateSearchHit[];
  rejected: Array<{
    candidate: CandidateSearchHit;
    reasons: HardFilterReason[];
  }>;
};

const DANGEROUS_DOWNLOAD_SEGMENTS = new Set([
  "crack",
  "cracked",
  "keygen",
  "warez",
  "pirated",
  "activator",
]);

const MIN_EFFECTIVE_WORD_LENGTH = 3;
const MIN_SPAM_WORD_COUNT = 8;
const MIN_SPAM_REPETITIONS = 4;
const MIN_SPAM_RATIO = 0.4;
const MIN_RELEVANCE_CONTEXT_WORDS = 2;

/**
 * 统一 V0 的有效词定义。使用固定 Unicode 正则与 NFKC，避免依赖操作系统 Locale；
 * code point 计数可正确处理代理对，不把 UTF-16 单元数误当作字符长度。
 */
function extractEffectiveWords(...values: string[]): string[] {
  const normalized = values.join(" ").normalize("NFKC").toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];

  return words.filter(
    word => Array.from(word).length >= MIN_EFFECTIVE_WORD_LENGTH,
  );
}

/** URL 解析失败只影响当前候选；调用方仍会继续收集其他确定性原因。 */
function parseCanonicalUrl(canonicalUrl: string): URL | null {
  try {
    return new URL(canonicalUrl);
  } catch {
    return null;
  }
}

function isIllegalUrl(candidate: CandidateSearchHit, parsedUrl: URL | null) {
  return (
    parsedUrl === null ||
    (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
    parsedUrl.hostname !== candidate.domain
  );
}

function isObviousSpam(candidate: CandidateSearchHit): boolean {
  const words = extractEffectiveWords(candidate.title, candidate.snippet);
  if (words.length < MIN_SPAM_WORD_COUNT) {
    return false;
  }

  const frequencies = new Map<string, number>();
  for (const word of words) {
    frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  }

  return Array.from(frequencies.values()).some(
    frequency =>
      frequency >= MIN_SPAM_REPETITIONS &&
      frequency / words.length >= MIN_SPAM_RATIO,
  );
}

/** 百分号编码损坏时回退原始路径，保证单项结果仍可确定性结算。 */
function safelyDecodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function isDangerousDownloadMirror(
  node: GraphNodeCore,
  parsedUrl: URL | null,
): boolean {
  if (
    node.searchPlan.rankingProfile !== "software" ||
    parsedUrl === null
  ) {
    return false;
  }

  const segments = extractEffectiveWords(
    parsedUrl.hostname,
    safelyDecodePathname(parsedUrl.pathname),
  );

  return segments.some(segment => DANGEROUS_DOWNLOAD_SEGMENTS.has(segment));
}

function isClearlyIrrelevant(
  node: GraphNodeCore,
  candidate: CandidateSearchHit,
): boolean {
  const contextWords = new Set(
    extractEffectiveWords(node.title, node.description, candidate.query),
  );
  if (contextWords.size < MIN_RELEVANCE_CONTEXT_WORDS) {
    return false;
  }

  const candidateWords = new Set(
    extractEffectiveWords(candidate.title, candidate.snippet, candidate.domain),
  );

  return !Array.from(contextWords).some(word => candidateWords.has(word));
}

/**
 * 按输入顺序执行全部规则，不因首个原因而短路。这样同一候选的解释信息完整，
 * accepted 与 rejected 也分别保持原始相对顺序；函数只返回原对象引用，不修改输入。
 */
export function applyDeterministicHardFilters(
  node: GraphNodeCore,
  candidates: readonly CandidateSearchHit[],
): HardFilterOutcome {
  const outcome: HardFilterOutcome = { accepted: [], rejected: [] };

  for (const candidate of candidates) {
    const reasons: HardFilterReason[] = [];
    const parsedUrl = parseCanonicalUrl(candidate.canonicalUrl);

    if (isIllegalUrl(candidate, parsedUrl)) {
      reasons.push("ILLEGAL_URL");
    }
    if (candidate.snippet.trim().length === 0) {
      reasons.push("EMPTY_SNIPPET");
    }
    if (isObviousSpam(candidate)) {
      reasons.push("OBVIOUS_SPAM");
    }
    if (isDangerousDownloadMirror(node, parsedUrl)) {
      reasons.push("DANGEROUS_DOWNLOAD_MIRROR");
    }
    if (isClearlyIrrelevant(node, candidate)) {
      reasons.push("CLEARLY_IRRELEVANT");
    }

    if (reasons.length === 0) {
      outcome.accepted.push(candidate);
    } else {
      outcome.rejected.push({ candidate, reasons });
    }
  }

  return outcome;
}
