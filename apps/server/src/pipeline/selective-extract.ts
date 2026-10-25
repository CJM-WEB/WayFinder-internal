/**
 * 模块职责：从 Heuristic Pre-rank（启发式粗排）结果中选择有限候选，调用既有
 * SearchProvider Batch Extract，并把普通抽取失败收敛为可审计的 Warning。
 *
 * 安全边界：
 * - 只向 Provider 传递候选已有的 canonicalUrl，不接收或抓取任意用户 URL；
 * - Candidate 与 ExtractedPage 始终分离，网页正文不能覆盖安全 Search snippet；
 * - 用户取消与 Run Deadline 共用调用方 Signal，必须原样向上传播。
 */
import type {
  ExtractedPage,
  NodeWarningCode,
  ResourceCandidate,
} from "@wayfinder/contracts";

import type { SearchProvider } from "../search/provider.js";

/** Extract 与粗排、最终保留是三个独立预算，禁止复用其他阶段的上限。 */
export const MAX_EXTRACT_CANDIDATES_PER_NODE = 5;

export type SelectiveExtractInput = Readonly<{
  /** 必须保持 WAY-51 已确定的排序；本阶段只读取前五项。 */
  candidates: readonly ResourceCandidate[];
  provider: SearchProvider;
  /** 整次 Run 共享的取消与绝对 Deadline Signal。 */
  signal: AbortSignal;
}>;

export type SelectiveExtractOutcome = Readonly<{
  /** 只包含与请求 URL 确定性关联且正文非空的页面。 */
  pages: readonly ExtractedPage[];
  /** 只要仍有候选，普通整批或局部失败都收敛为该 Warning。 */
  warnings: readonly NodeWarningCode[];
}>;

const EXTRACTION_FAILED_WARNING = ["EXTRACTION_FAILED"] as const;

/**
 * 防御内部 Provider 实现绕过 Adapter 约束：未知 URL 或重复关联会使整批降级，
 * 不能猜测正文属于哪个候选；缺失项与空正文则保留其他成功页面并标记局部失败。
 */
function validateAndOrderPages(
  canonicalUrls: readonly string[],
  pages: readonly ExtractedPage[],
): { pages: ExtractedPage[]; complete: boolean } | null {
  const requestedUrls = new Set(canonicalUrls);
  const seenCanonicalUrls = new Set<string>();
  const pageByCanonicalUrl = new Map<string, ExtractedPage>();

  for (const page of pages) {
    if (
      !requestedUrls.has(page.canonicalUrl) ||
      seenCanonicalUrls.has(page.canonicalUrl)
    ) {
      return null;
    }
    // 空正文同样占用一次关联，禁止后续同 URL 的非空项被误当作唯一结果。
    seenCanonicalUrls.add(page.canonicalUrl);

    if (page.content.trim().length > 0) {
      pageByCanonicalUrl.set(page.canonicalUrl, page);
    }
  }

  const orderedPages = canonicalUrls.flatMap(canonicalUrl => {
    const page = pageByCanonicalUrl.get(canonicalUrl);
    return page === undefined ? [] : [page];
  });

  return {
    pages: orderedPages,
    complete: orderedPages.length === canonicalUrls.length,
  };
}

/**
 * 最多抽取预排序前五个候选。少于五个时只处理现有候选，不能用低质量结果补齐。
 * 普通失败不抛错且不修改 Candidate；Signal 一旦终止，则以 signal.reason 结束。
 */
export async function extractCandidatesSelectively(
  input: SelectiveExtractInput,
): Promise<SelectiveExtractOutcome> {
  input.signal.throwIfAborted();

  const selectedCandidates = input.candidates.slice(
    0,
    MAX_EXTRACT_CANDIDATES_PER_NODE,
  );
  if (selectedCandidates.length === 0) {
    return { pages: [], warnings: [] };
  }

  const extract = input.provider.extract;
  if (extract === undefined) {
    return { pages: [], warnings: EXTRACTION_FAILED_WARNING };
  }

  const canonicalUrls = selectedCandidates.map(
    candidate => candidate.hit.canonicalUrl,
  );

  try {
    const pages = await extract.call(
      input.provider,
      canonicalUrls,
      input.signal,
    );
    // 防御错误忽略 Signal、却在 Run 取消后仍返回成功值的 Provider 实现。
    input.signal.throwIfAborted();

    const validated = validateAndOrderPages(canonicalUrls, pages);
    if (validated === null) {
      return { pages: [], warnings: EXTRACTION_FAILED_WARNING };
    }

    return {
      pages: validated.pages,
      warnings: validated.complete ? [] : EXTRACTION_FAILED_WARNING,
    };
  } catch {
    // 普通 Provider 错误不得泄漏；取消或 Deadline 则必须传播同一个 Run reason。
    input.signal.throwIfAborted();
    return { pages: [], warnings: EXTRACTION_FAILED_WARNING };
  }
}
