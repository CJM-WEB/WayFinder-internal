/**
 * 模块职责：把 Rerank/fallback 产出的有序 ResourceCandidate，
 * 转换成公共 Contract 唯一认可的 Resource[]，供默认 Top 3 与 Show More 共用。
 *
 * 边界说明：本模块不重新评分、不重排、不补位，也不决定 Node 终态或 Warning。
 * 空输入自然返回空数组，后续 WAY-57 才负责映射 ready / partial / failed。
 */
import { createHash } from "node:crypto";

import {
  MAX_RETAINED_RESOURCES_PER_NODE,
  ResourceSchema,
  type Resource,
  type ResourceCandidate,
  type SearchLanguage,
} from "@wayfinder/contracts";

const FALLBACK_SOURCE_TYPE = "web";
const FALLBACK_TEXT_BY_LANGUAGE = Object.freeze({
  "zh-CN": Object.freeze({
    summary: "该搜索结果未提供可用摘要，请打开页面查看。",
    whySelected: "该结果由搜索提供方返回，并按当前确定性排序保留。",
  }),
  "en-US": Object.freeze({
    summary:
      "This search result does not provide a usable summary. Open the page to view it.",
    whySelected:
      "This result was returned by the search provider and retained by the current deterministic ranking.",
  }),
} as const satisfies Readonly<
  Record<SearchLanguage, Readonly<{ summary: string; whySelected: string }>>
>);
const FINAL_RESOURCE_LIST_SCHEMA = ResourceSchema.array().max(
  MAX_RETAINED_RESOURCES_PER_NODE,
);

function readTrimmedText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}

/**
 * canonicalUrl 已由 WAY-48 冻结；Finalizer 只验证并派生 domain，不能再次规范化或
 * 改写字符串，否则 Resource ID、去重结果与用户实际打开目标可能发生漂移。
 */
function readCanonicalDomain(candidate: ResourceCandidate): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(candidate.hit.canonicalUrl);
  } catch {
    throw new TypeError("Resource Finalizer canonicalUrl 无效");
  }

  const domain = parsedUrl.hostname.toLowerCase();
  if (
    (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
    domain.length === 0 ||
    domain !== candidate.hit.domain
  ) {
    throw new TypeError("Resource Finalizer canonicalUrl 与 domain 不一致");
  }

  return domain;
}

/** 完整 SHA-256 避免截断摘要引入不必要的碰撞面；ID 不包含 Candidate 临时身份。 */
function createResourceId(canonicalUrl: string): string {
  return `resource_${createHash("sha256").update(canonicalUrl).digest("hex")}`;
}

/** Provider 日期是可选弱信号；非法值表示“不可靠”，不能拖垮其余字段合法的 Resource。 */
function readReliablePublishedAt(
  value: string | null | undefined,
): string | null | undefined {
  const parsed = ResourceSchema.shape.publishedAt.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function createResource(
  candidate: ResourceCandidate,
  rank: number,
  language: SearchLanguage,
): Resource {
  const fallbackText = FALLBACK_TEXT_BY_LANGUAGE[language];
  if (fallbackText === undefined) {
    // 防御内部调用绕过公共 Contract；未知语言不能静默回退为中文或英文。
    throw new TypeError("Resource Finalizer 不支持该语言");
  }
  const summary =
    readTrimmedText(candidate.summary) ??
    readTrimmedText(candidate.hit.snippet) ??
    fallbackText.summary;

  const canonicalUrl = candidate.hit.canonicalUrl;
  const publishedAt = readReliablePublishedAt(candidate.hit.publishedAt);
  return ResourceSchema.parse({
    id: createResourceId(canonicalUrl),
    title: candidate.hit.title,
    url: candidate.hit.url,
    canonicalUrl,
    domain: readCanonicalDomain(candidate),
    sourceType:
      readTrimmedText(candidate.sourceType) ?? FALLBACK_SOURCE_TYPE,
    summary,
    whySelected:
      readTrimmedText(candidate.whySelected) ?? fallbackText.whySelected,
    rank,
    ...(candidate.scores === undefined ? {} : { scores: candidate.scores }),
    searchProvider: candidate.hit.provider,
    ...(publishedAt === undefined ? {} : { publishedAt }),
  });
}

/**
 * 只保留输入前八项并生成连续 rank。当前上游通常最多交付六项，但这里仍执行公共
 * Contract 的最终防御上限，避免未来候选预算调整后把数量责任散落到调用方。
 */
export function finalizeResources(
  candidates: readonly ResourceCandidate[],
  language: SearchLanguage,
): Resource[] {
  const retainedCandidates = candidates.slice(
    0,
    MAX_RETAINED_RESOURCES_PER_NODE,
  );
  const seenCanonicalUrls = new Set<string>();
  const seenResourceIds = new Set<string>();
  const resources = retainedCandidates.map((candidate, index) => {
    const resource = createResource(candidate, index + 1, language);
    if (
      seenCanonicalUrls.has(resource.canonicalUrl) ||
      seenResourceIds.has(resource.id)
    ) {
      throw new TypeError("Resource Finalizer 生成了重复的 Resource 身份");
    }

    seenCanonicalUrls.add(resource.canonicalUrl);
    seenResourceIds.add(resource.id);
    return resource;
  });

  return FINAL_RESOURCE_LIST_SCHEMA.parse(resources);
}
