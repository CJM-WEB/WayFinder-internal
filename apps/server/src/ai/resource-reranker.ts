/**
 * 模块职责：使用一次 LLM Structured Output（结构化输出）比较既有真实网页候选，
 * 并返回不含 URL 的 Rerank Decision（重排决策）。
 *
 * 安全边界：
 * - Provider 输出始终以 unknown 接收，并经过严格 Zod Schema 与 Candidate ID 校验；
 * - 网页派生字段只进入标记为 UNTRUSTED_EXTERNAL_CONTENT 的 user 数据区；
 * - 本模块不做 fallback、不构造最终 Resource，也不生成或修改 URL。
 */
import type {
  ExtractedPage,
  GraphNodeCore,
  RankingProfile,
  ResourceCandidate,
  SearchLanguage,
} from "@wayfinder/contracts";
import { z } from "zod";

import { MAX_RERANK_CANDIDATES_PER_NODE } from "../pipeline/candidate-guard.js";
import {
  assertBoundedLLMTimeout,
  LLMProviderError,
  type LLMProvider,
  type StructuredLLMInput,
} from "./llm-provider.js";
import { RESOURCE_RERANKER_SYSTEM_PROMPT } from "./prompts/resource-reranker.v2.js";
import { appendTargetLanguageSystemInstruction } from "./prompts/target-language-system-instruction.js";

export const RESOURCE_RERANKER_MAX_NODE_ID_CODE_POINTS = 100;
export const RESOURCE_RERANKER_MAX_NODE_TITLE_CODE_POINTS = 200;
export const RESOURCE_RERANKER_MAX_NODE_DESCRIPTION_CODE_POINTS = 500;
export const RESOURCE_RERANKER_MAX_CANDIDATE_ID_CODE_POINTS = 100;
export const RESOURCE_RERANKER_MAX_QUERY_CODE_POINTS = 200;
export const RESOURCE_RERANKER_MAX_TITLE_CODE_POINTS = 200;
export const RESOURCE_RERANKER_MAX_URL_CODE_POINTS = 2_048;
export const RESOURCE_RERANKER_MAX_DOMAIN_CODE_POINTS = 253;
export const RESOURCE_RERANKER_MAX_SNIPPET_CODE_POINTS = 500;
export const RESOURCE_RERANKER_MAX_PUBLISHED_AT_CODE_POINTS = 64;
export const RESOURCE_RERANKER_MAX_CONTENT_CODE_POINTS = 4_000;
export const RESOURCE_RERANKER_MAX_PAYLOAD_CODE_POINTS = 32_000;
export const RESOURCE_RERANKER_MAX_DECISION_TEXT_CODE_POINTS = 500;

/**
 * Product Spec 批准的高层语义权重。general 没有批准的数值配置，因此保持模型的
 * 受控均衡顺序，禁止在代码或 Prompt 中自行发明一套权重。
 */
export const RESOURCE_RERANK_PROFILE_WEIGHTS: Readonly<
  Partial<Record<RankingProfile, Readonly<Record<string, number>>>>
> = Object.freeze({
  knowledge: Object.freeze({
    relevance: 0.3,
    authority: 0.2,
    clarity: 0.18,
    completeness: 0.15,
    trustSafety: 0.1,
    freshness: 0.07,
  }),
  news: Object.freeze({
    freshness: 0.28,
    authority: 0.24,
    relevance: 0.2,
    primarySource: 0.12,
    sourceDiversity: 0.1,
    trustSafety: 0.06,
  }),
  shopping: Object.freeze({
    relevance: 0.22,
    productFit: 0.18,
    authority: 0.15,
    evidence: 0.15,
    freshness: 0.13,
    userExperience: 0.1,
    trustSafety: 0.07,
  }),
  software: Object.freeze({
    officialness: 0.35,
    trustSafety: 0.25,
    relevance: 0.2,
    freshness: 0.1,
    clarity: 0.1,
  }),
});

const SCORE_SCHEMA = z.number().finite().min(0).max(1);
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * 高层语义维度来自 Product Spec 17.2/17.3；字段固定可审计，不能让模型自由创建
 * score key，也不能复用 WAY-51 的低层 Heuristic signal 名义冒充语义判断。
 */
const RERANK_SCORES_SCHEMA = z.strictObject({
  relevance: SCORE_SCHEMA,
  authority: SCORE_SCHEMA.optional(),
  contentQuality: SCORE_SCHEMA.optional(),
  completeness: SCORE_SCHEMA.optional(),
  freshness: SCORE_SCHEMA.optional(),
  clarity: SCORE_SCHEMA.optional(),
  practicalValue: SCORE_SCHEMA.optional(),
  trustSafety: SCORE_SCHEMA.optional(),
  sourceDiversity: SCORE_SCHEMA.optional(),
  officialness: SCORE_SCHEMA.optional(),
  primarySource: SCORE_SCHEMA.optional(),
  productFit: SCORE_SCHEMA.optional(),
  evidence: SCORE_SCHEMA.optional(),
  userExperience: SCORE_SCHEMA.optional(),
});

const RERANK_DECISION_SCHEMA = z.strictObject({
  candidateId: z
    .string()
    .min(1)
    .max(RESOURCE_RERANKER_MAX_CANDIDATE_ID_CODE_POINTS)
    .regex(CANDIDATE_ID_PATTERN),
  scores: RERANK_SCORES_SCHEMA,
  summary: z
    .string()
    .trim()
    .min(1)
    .max(RESOURCE_RERANKER_MAX_DECISION_TEXT_CODE_POINTS),
  whySelected: z
    .string()
    .trim()
    .min(1)
    .max(RESOURCE_RERANKER_MAX_DECISION_TEXT_CODE_POINTS),
});

const RERANK_OUTPUT_SCHEMA = z.strictObject({
  ranking: z
    .array(RERANK_DECISION_SCHEMA)
    .min(1)
    .max(MAX_RERANK_CANDIDATES_PER_NODE),
});

const RERANK_PROVIDER_SCHEMA = z.toJSONSchema(RERANK_OUTPUT_SCHEMA, {
  target: "draft-2020-12",
  io: "input",
  unrepresentable: "throw",
  reused: "inline",
});

export type ResourceRerankDecision = Readonly<
  z.infer<typeof RERANK_DECISION_SCHEMA>
>;

export type ResourceRerankErrorKind =
  | "budget_exhausted"
  | "candidate_mapping_failed"
  | "input_too_large"
  | "profile_scores_invalid"
  | "provider_failure"
  | "schema_validation_failed";

/** 普通 Rerank 失败的脱敏分类；WAY-54 再负责 fallback 与 Warning。 */
export class ResourceRerankError extends Error {
  public readonly kind: ResourceRerankErrorKind;

  public constructor(kind: ResourceRerankErrorKind) {
    super("RESOURCE_RERANK_FAILED");
    this.name = "ResourceRerankError";
    this.kind = kind;
  }
}

export type RerankResourcesInput = Readonly<{
  node: GraphNodeCore;
  /** 冻结于本次 Run，用于约束 summary 与 whySelected 的自产文本。 */
  language: SearchLanguage;
  candidates: readonly ResourceCandidate[];
  pages: readonly ExtractedPage[];
  provider: LLMProvider;
  /** 整次 Run 统一的取消/绝对截止 Signal。 */
  signal: AbortSignal;
  /** 调用方分配给 Reranker 的阶段预算，范围为 1..30000ms。 */
  timeoutMs: number;
  /** 轻量时钟注入只用于确定性预算测试；生产默认使用单调时钟。 */
  now?: () => number;
}>;

type PromptCandidate = Readonly<{
  candidateId: string;
  query: string;
  title: string;
  canonicalUrl: string;
  domain: string;
  snippet: string;
  publishedAt?: string | null;
  extractedContent?: string;
}>;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** 保留指定数量的 Unicode code point，避免截断非 BMP 字符的代理对。 */
function takeCodePoints(value: string, maximum: number): string {
  let count = 0;
  let endIndex = 0;

  for (const codePoint of value) {
    if (count >= maximum) {
      break;
    }
    count += 1;
    endIndex += codePoint.length;
  }

  return value.slice(0, endIndex);
}

/** 达到上限后立即停止计数，避免为拒绝超大载荷继续扫描剩余文本。 */
function exceedsCodePointLimit(value: string, maximum: number): boolean {
  let count = 0;
  const iterator = value[Symbol.iterator]();
  let iteration = iterator.next();
  while (!iteration.done) {
    count += 1;
    if (count > maximum) {
      return true;
    }
    iteration = iterator.next();
  }
  return false;
}

function readRequiredText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Resource Reranker ${field} 字段无效`);
  }
  return value;
}

/**
 * ExtractedPage 只用 canonicalUrl 与既有 Candidate 关联。未知或重复 URL 属于内部
 * 边界违例，必须在调用 LLM 前失败，不能猜测正文归属。
 */
function indexExtractedContent(
  candidates: readonly ResourceCandidate[],
  pages: readonly ExtractedPage[],
): ReadonlyMap<string, string> {
  const candidateUrls = new Set(
    candidates.map(candidate => candidate.hit.canonicalUrl),
  );
  const contentByCanonicalUrl = new Map<string, string>();

  for (const page of pages) {
    const canonicalUrl = readRequiredText(
      page.canonicalUrl,
      "ExtractedPage.canonicalUrl",
    );
    const content = readRequiredText(page.content, "ExtractedPage.content");
    if (
      !candidateUrls.has(canonicalUrl) ||
      contentByCanonicalUrl.has(canonicalUrl) ||
      content.trim().length === 0
    ) {
      throw new TypeError("Resource Reranker ExtractedPage 关联无效");
    }
    contentByCanonicalUrl.set(canonicalUrl, content);
  }

  return contentByCanonicalUrl;
}

function projectPromptCandidate(
  candidate: ResourceCandidate,
  contentByCanonicalUrl: ReadonlyMap<string, string>,
): PromptCandidate {
  const hit = candidate.hit;
  const publishedAt: unknown = hit.publishedAt;
  if (
    publishedAt !== undefined &&
    publishedAt !== null &&
    typeof publishedAt !== "string"
  ) {
    throw new TypeError("Resource Reranker publishedAt 字段无效");
  }

  const canonicalUrl = readRequiredText(hit.canonicalUrl, "canonicalUrl");
  const extractedContent = contentByCanonicalUrl.get(canonicalUrl);
  return {
    candidateId: takeCodePoints(
      readRequiredText(candidate.candidateId, "candidateId"),
      RESOURCE_RERANKER_MAX_CANDIDATE_ID_CODE_POINTS,
    ),
    query: takeCodePoints(
      readRequiredText(hit.query, "query"),
      RESOURCE_RERANKER_MAX_QUERY_CODE_POINTS,
    ),
    title: takeCodePoints(
      readRequiredText(hit.title, "title"),
      RESOURCE_RERANKER_MAX_TITLE_CODE_POINTS,
    ),
    canonicalUrl: takeCodePoints(
      canonicalUrl,
      RESOURCE_RERANKER_MAX_URL_CODE_POINTS,
    ),
    domain: takeCodePoints(
      readRequiredText(hit.domain, "domain"),
      RESOURCE_RERANKER_MAX_DOMAIN_CODE_POINTS,
    ),
    snippet: takeCodePoints(
      readRequiredText(hit.snippet, "snippet"),
      RESOURCE_RERANKER_MAX_SNIPPET_CODE_POINTS,
    ),
    ...(publishedAt === undefined
      ? {}
      : {
          publishedAt:
            publishedAt === null
              ? null
              : takeCodePoints(
                  publishedAt,
                  RESOURCE_RERANKER_MAX_PUBLISHED_AT_CODE_POINTS,
                ),
        }),
    ...(extractedContent === undefined
      ? {}
      : {
          extractedContent: takeCodePoints(
            extractedContent,
            RESOURCE_RERANKER_MAX_CONTENT_CODE_POINTS,
          ),
        }),
  };
}

function createStructuredInput(
  node: GraphNodeCore,
  language: SearchLanguage,
  candidates: readonly ResourceCandidate[],
  pages: readonly ExtractedPage[],
): StructuredLLMInput {
  if (
    candidates.length < 1 ||
    candidates.length > MAX_RERANK_CANDIDATES_PER_NODE
  ) {
    throw new TypeError(
      `Resource Reranker Candidate 数量必须为 1 到 ${MAX_RERANK_CANDIDATES_PER_NODE}`,
    );
  }

  const candidateIds = new Set<string>();
  for (const candidate of candidates) {
    const candidateId = readRequiredText(candidate.candidateId, "candidateId");
    if (
      !CANDIDATE_ID_PATTERN.test(candidateId) ||
      candidateId.length > RESOURCE_RERANKER_MAX_CANDIDATE_ID_CODE_POINTS ||
      candidateIds.has(candidateId)
    ) {
      throw new TypeError("Resource Reranker Candidate ID 无效或重复");
    }
    candidateIds.add(candidateId);
  }

  const contentByCanonicalUrl = indexExtractedContent(candidates, pages);
  const user = JSON.stringify({
    trustedControl: {
      rankingProfile: node.searchPlan.rankingProfile,
      candidateIds: [...candidateIds],
    },
    UNTRUSTED_EXTERNAL_CONTENT: {
      node: {
        id: takeCodePoints(
          readRequiredText(node.id, "node.id"),
          RESOURCE_RERANKER_MAX_NODE_ID_CODE_POINTS,
        ),
        title: takeCodePoints(
          readRequiredText(node.title, "node.title"),
          RESOURCE_RERANKER_MAX_NODE_TITLE_CODE_POINTS,
        ),
        description: takeCodePoints(
          readRequiredText(node.description, "node.description"),
          RESOURCE_RERANKER_MAX_NODE_DESCRIPTION_CODE_POINTS,
        ),
      },
      candidates: candidates.map(candidate =>
        projectPromptCandidate(candidate, contentByCanonicalUrl),
      ),
    },
  });

  if (
    exceedsCodePointLimit(user, RESOURCE_RERANKER_MAX_PAYLOAD_CODE_POINTS)
  ) {
    throw new ResourceRerankError("input_too_large");
  }

  return {
    system: appendTargetLanguageSystemInstruction(
      RESOURCE_RERANKER_SYSTEM_PROMPT,
      language,
    ),
    user,
    schemaName: "resource_rerank",
    schema: RERANK_PROVIDER_SCHEMA,
  };
}

function readRemainingTimeoutMs(
  deadlineAt: number,
  maximumTimeoutMs: number,
  now: () => number,
): number | null {
  const currentTime = now();
  if (!Number.isFinite(currentTime)) {
    throw new TypeError("Resource Reranker 时钟必须返回有限数字");
  }

  const remaining = Math.min(
    maximumTimeoutMs,
    Math.ceil(deadlineAt - currentTime),
  );
  return remaining >= 1 ? remaining : null;
}

function validateCandidateMapping(
  candidates: readonly ResourceCandidate[],
  decisions: readonly ResourceRerankDecision[],
): void {
  if (decisions.length !== candidates.length) {
    throw new ResourceRerankError("candidate_mapping_failed");
  }

  const expectedIds = new Set(
    candidates.map(candidate => candidate.candidateId),
  );
  const returnedIds = new Set<string>();
  for (const decision of decisions) {
    if (
      !expectedIds.has(decision.candidateId) ||
      returnedIds.has(decision.candidateId)
    ) {
      throw new ResourceRerankError("candidate_mapping_failed");
    }
    returnedIds.add(decision.candidateId);
  }
}

/**
 * 对批准了数值权重的 Profile 强制精确 score key，并用确定性加权结果排序。
 * 同分时保留模型原顺序；general 没有批准权重，因此不在代码中发明语义。
 */
function applyProfileRanking(
  profile: RankingProfile,
  decisions: readonly ResourceRerankDecision[],
): ResourceRerankDecision[] {
  const weights = RESOURCE_RERANK_PROFILE_WEIGHTS[profile];
  if (weights === undefined) {
    return [...decisions];
  }

  const expectedKeys = Object.keys(weights);
  const ranked = decisions.map((decision, originalIndex) => {
    const scoreKeys = Object.keys(decision.scores);
    if (
      scoreKeys.length !== expectedKeys.length ||
      expectedKeys.some(key => !(key in decision.scores))
    ) {
      throw new ResourceRerankError("profile_scores_invalid");
    }

    const weightedScore = expectedKeys.reduce((sum, key) => {
      const score = Reflect.get(decision.scores, key);
      const weight = weights[key];
      if (typeof score !== "number" || weight === undefined) {
        throw new ResourceRerankError("profile_scores_invalid");
      }
      return sum + score * weight;
    }, 0);

    return {
      decision,
      originalIndex,
      weightedScore: Math.round(weightedScore * 1_000_000) / 1_000_000,
    };
  });

  return ranked
    .sort(
      (left, right) =>
        right.weightedScore - left.weightedScore ||
        left.originalIndex - right.originalIndex,
    )
    .map(entry => entry.decision);
}

function assertDecisionTextContainsNoUrl(
  decisions: readonly ResourceRerankDecision[],
): void {
  const urlPattern = /(?:https?:\/\/|www\.)/iu;
  if (
    decisions.some(
      decision =>
        urlPattern.test(decision.summary) ||
        urlPattern.test(decision.whySelected),
    )
  ) {
    throw new ResourceRerankError("schema_validation_failed");
  }
}

/**
 * 执行一次版本化 Structured Rerank。成功值严格不含 URL；普通失败由 WAY-54
 * 精确捕获并回退，本函数绝不自行吞错或伪造 Heuristic 成功结果。
 */
export async function rerankResources(
  input: RerankResourcesInput,
): Promise<readonly ResourceRerankDecision[]> {
  assertBoundedLLMTimeout(input.timeoutMs);
  throwIfAborted(input.signal);

  const now = input.now ?? (() => performance.now());
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new TypeError("Resource Reranker 时钟必须返回有限数字");
  }
  const deadlineAt = startedAt + input.timeoutMs;
  const structuredInput = createStructuredInput(
    input.node,
    input.language,
    input.candidates,
    input.pages,
  );
  const remainingTimeoutMs = readRemainingTimeoutMs(
    deadlineAt,
    input.timeoutMs,
    now,
  );
  if (remainingTimeoutMs === null) {
    throw new ResourceRerankError("budget_exhausted");
  }

  let output: unknown;
  try {
    output = await input.provider.structured(structuredInput, {
      signal: input.signal,
      timeoutMs: remainingTimeoutMs,
    });
  } catch (error: unknown) {
    throwIfAborted(input.signal);
    if (isAbortError(error)) {
      throw error;
    }
    if (error instanceof LLMProviderError) {
      throw new ResourceRerankError("provider_failure");
    }
    throw error;
  }

  throwIfAborted(input.signal);
  if (readRemainingTimeoutMs(deadlineAt, input.timeoutMs, now) === null) {
    throw new ResourceRerankError("budget_exhausted");
  }

  const parsed = RERANK_OUTPUT_SCHEMA.safeParse(output);
  if (!parsed.success) {
    throw new ResourceRerankError("schema_validation_failed");
  }

  validateCandidateMapping(input.candidates, parsed.data.ranking);
  assertDecisionTextContainsNoUrl(parsed.data.ranking);
  return applyProfileRanking(
    input.node.searchPlan.rankingProfile,
    parsed.data.ranking,
  );
}
