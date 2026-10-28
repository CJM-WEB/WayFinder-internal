/**
 * 模块职责：执行 evidence_assisted 的唯一一轮 Broad Discovery（广泛发现）搜索，
 * 并把 Provider 标准化结果投影为可安全交给 Graph Reviser 的 Evidence。
 *
 * 关键边界：
 * - 只接受合法的 evidence_assisted Analysis，1～3 条 Query 并发且每条只调用一次；
 * - 本层不重试、不 Extract、不去重、不排序，也不创建新的 Timeout 或 Run Deadline；
 * - 所有 Search 共享调用方的 Run Signal，取消与 Deadline reason 必须原样传播；
 * - Evidence 逐字段白名单化，Provider 原始 metadata 与错误不得进入后续 LLM 边界。
 */
import {
  QueryAnalysisSchema,
  type CandidateSearchHit,
  type NormalizedSearchHit,
  type ProviderSearchRequest,
  type QueryAnalysis,
  type SearchLanguage,
} from "@wayfinder/contracts";

import type { SearchProvider } from "./provider.js";

/** Broad Discovery 每条 Query 的固定候选预算；1～3 条 Query 总量最多为 15。 */
export const BROAD_DISCOVERY_RESULTS_PER_QUERY = 5;

export type EvidenceAssistedAnalysis = Extract<
  QueryAnalysis,
  { strategy: "evidence_assisted" }
>;

export type DiscoverBroadEvidenceInput = Readonly<{
  /** 必须来自已校验 Initial GraphPlan，运行时仍防御内部绕过 Contract。 */
  analysis: EvidenceAssistedAnalysis;
  provider: SearchProvider;
  /** Orchestrator 创建的统一 Run Signal；本函数不创建或延长其生命周期。 */
  signal: AbortSignal;
  language: SearchLanguage;
}>;

/** 零 Evidence 的脱敏内部错误；未来 Orchestrator 据此保留 Initial GraphPlan。 */
export class BroadDiscoveryError extends Error {
  public constructor() {
    super("BROAD_DISCOVERY_FAILED");
    this.name = "BroadDiscoveryError";
  }
}

function parseEvidenceAssistedAnalysis(
  analysis: EvidenceAssistedAnalysis,
): EvidenceAssistedAnalysis {
  const parsed = QueryAnalysisSchema.safeParse(analysis);
  if (!parsed.success || parsed.data.strategy !== "evidence_assisted") {
    // 不回传 Zod Issue 或自由文本 Query，避免内部错误把用户内容带入普通日志。
    throw new TypeError("Broad Discovery 需要合法的 evidence_assisted Analysis");
  }
  return parsed.data;
}

function createBroadSearchRequest(
  analysis: EvidenceAssistedAnalysis,
  query: string,
  language: SearchLanguage,
): ProviderSearchRequest {
  return {
    kind: "broad_discovery",
    query,
    maxResults: BROAD_DISCOVERY_RESULTS_PER_QUERY,
    capability: "general",
    freshnessSensitive: analysis.freshnessSensitive,
    language,
  };
}

/**
 * 显式复制 Evidence 白名单，保留 Adapter 已规范化的 URL / domain 与 Provider 顺序；
 * 不调用 Node Pipeline 的 canonicalize / dedupe，避免 Broad Discovery 越权做 Ranking 前处理。
 */
function projectEvidence(hit: NormalizedSearchHit): CandidateSearchHit {
  return {
    provider: hit.provider,
    query: hit.query,
    title: hit.title,
    url: hit.url,
    canonicalUrl: hit.canonicalUrl,
    domain: hit.domain,
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

/** 执行唯一一轮并发 Discovery，并按 Query、Provider 原顺序返回可用 Evidence。 */
export async function discoverBroadEvidence(
  input: DiscoverBroadEvidenceInput,
): Promise<CandidateSearchHit[]> {
  input.signal.throwIfAborted();
  const analysis = parseEvidenceAssistedAnalysis(input.analysis);
  const settled = await Promise.allSettled(
    analysis.broadSearchQueries.map(async query =>
      input.provider.search(
        createBroadSearchRequest(analysis, query, input.language),
        input.signal,
      ),
    ),
  );

  // 防御错误忽略 Signal、却在 Run 取消后仍返回成功值的 Provider 实现。
  input.signal.throwIfAborted();

  const evidence = settled.flatMap(outcome =>
    outcome.status === "fulfilled"
      ? outcome.value
          .slice(0, BROAD_DISCOVERY_RESULTS_PER_QUERY)
          .map(projectEvidence)
      : [],
  );

  if (evidence.length === 0) {
    throw new BroadDiscoveryError();
  }
  return evidence;
}
