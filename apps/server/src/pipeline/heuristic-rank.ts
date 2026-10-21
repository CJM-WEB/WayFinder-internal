/**
 * 模块职责：把 WAY-50 的候选评估转换为可解释、可复现的 Heuristic Ranking
 *（启发式粗排）结果，并裁剪到后续 Rerank 的单 Node 候选预算。
 *
 * 安全边界：候选标题与摘要只参与 Unicode 字面词覆盖率计算，不能改变 Profile、
 * 权重、安全层级或预算。该阶段不执行 Extract，也不伪造尚不可观察的语义质量信号。
 */
import type {
  GraphNodeCore,
  QueryAnalysis,
  RankingProfile,
  ResourceCandidate,
} from "@wayfinder/contracts";
import { z } from "zod";

import type { OfficialSourceAssessment } from "./official-source.js";

export const MAX_PRERANK_CANDIDATES_PER_NODE = 6;

export const HEURISTIC_SIGNAL_KEYS = [
  "providerQuality",
  "titleRelevance",
  "snippetRelevance",
  "https",
  "domainDiversity",
  "freshness",
  "officialness",
] as const;

export type HeuristicSignal = (typeof HEURISTIC_SIGNAL_KEYS)[number];
export type HeuristicSignals = Record<HeuristicSignal, number>;
export type HeuristicProfileWeights = Readonly<HeuristicSignals>;

/**
 * 五套权重集中冻结，避免调用点复制数值而产生不可审计的隐式 Profile。
 * 每套权重总和为 1；后续调参必须同步修改对应 Fixture 与质量评估记录。
 */
export const HEURISTIC_PROFILE_WEIGHTS = Object.freeze({
  knowledge: Object.freeze({
    providerQuality: 0.15,
    titleRelevance: 0.25,
    snippetRelevance: 0.25,
    https: 0.1,
    domainDiversity: 0.1,
    freshness: 0.05,
    officialness: 0.1,
  }),
  news: Object.freeze({
    providerQuality: 0.15,
    titleRelevance: 0.2,
    snippetRelevance: 0.15,
    https: 0.05,
    domainDiversity: 0.15,
    freshness: 0.3,
    officialness: 0,
  }),
  shopping: Object.freeze({
    providerQuality: 0.2,
    titleRelevance: 0.25,
    snippetRelevance: 0.2,
    https: 0.1,
    domainDiversity: 0.1,
    freshness: 0.1,
    officialness: 0.05,
  }),
  software: Object.freeze({
    providerQuality: 0.1,
    titleRelevance: 0.15,
    snippetRelevance: 0.1,
    https: 0.1,
    domainDiversity: 0.05,
    freshness: 0.1,
    officialness: 0.4,
  }),
  general: Object.freeze({
    providerQuality: 0.2,
    titleRelevance: 0.25,
    snippetRelevance: 0.25,
    https: 0.1,
    domainDiversity: 0.1,
    freshness: 0.05,
    officialness: 0.05,
  }),
}) satisfies Readonly<Record<RankingProfile, HeuristicProfileWeights>>;

export type HeuristicRankInput = {
  analysis: QueryAnalysis;
  node: GraphNodeCore;
  assessments: readonly OfficialSourceAssessment[];
  /** 调用方注入同一次 Run 的当前时间，禁止函数内部读取系统时钟。 */
  nowMs: number;
};

type RankedEntry = {
  candidate: ResourceCandidate;
  originalIndex: number;
  safetyTier: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const SCORE_PRECISION = 1_000_000;
/** 与最终 Resource Contract 复用相同语义：必须是带时区的严格 ISO datetime。 */
const PUBLISHED_AT_SCHEMA = z.iso.datetime({ offset: true });

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function tokenize(...values: readonly string[]): Set<string> {
  const tokens = new Set<string>();

  for (const value of values) {
    const normalized = value.normalize("NFKC").toLowerCase();
    for (const token of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
      tokens.add(token);
    }
  }

  return tokens;
}

/** 以可信上下文词为分母，计算候选文本覆盖了多少检索意图。 */
function calculateCoverage(
  contextTokens: ReadonlySet<string>,
  candidateTokens: ReadonlySet<string>,
): number {
  if (contextTokens.size === 0) {
    return 0;
  }

  let matches = 0;
  for (const token of contextTokens) {
    if (candidateTokens.has(token)) {
      matches += 1;
    }
  }

  return matches / contextTokens.size;
}

function calculateProviderQuality(
  providerScore: number | undefined,
  providerRank: number | undefined,
): number {
  if (Number.isFinite(providerScore)) {
    return clampUnit(providerScore as number);
  }

  if (Number.isFinite(providerRank) && (providerRank as number) > 0) {
    return clampUnit(1 / (providerRank as number));
  }

  return 0;
}

function calculateHttps(canonicalUrl: string): number {
  try {
    return new URL(canonicalUrl).protocol === "https:" ? 1 : 0;
  } catch {
    return 0;
  }
}

/**
 * Freshness 只在语义相关的任务启用；未来时间和不可解析时间都按 0 处理，
 * 防止异常 Provider 日期反向提升候选。
 */
function calculateFreshness(
  publishedAt: string | null | undefined,
  nowMs: number,
  enabled: boolean,
): number {
  if (!enabled || publishedAt == null) {
    return 0;
  }

  const parsedPublishedAt = PUBLISHED_AT_SCHEMA.safeParse(publishedAt);
  if (!parsedPublishedAt.success) {
    return 0;
  }

  const publishedAtMs = Date.parse(parsedPublishedAt.data);
  const ageMs = nowMs - publishedAtMs;
  if (ageMs < 0) {
    return 0;
  }
  if (ageMs <= DAY_MS) {
    return 1;
  }
  if (ageMs <= 7 * DAY_MS) {
    return 0.8;
  }
  if (ageMs <= 30 * DAY_MS) {
    return 0.6;
  }
  if (ageMs <= 365 * DAY_MS) {
    return 0.3;
  }
  return 0;
}

function isOfficialnessRelevant(
  assessment: OfficialSourceAssessment,
): boolean {
  return (
    assessment.queryKind === "download" ||
    assessment.queryKind === "documentation"
  );
}

function calculateOfficialness(
  assessment: OfficialSourceAssessment,
): number {
  if (!isOfficialnessRelevant(assessment)) {
    return 0;
  }
  if (assessment.classification === "official") {
    return 1;
  }
  if (
    assessment.classification === "unknown" &&
    assessment.signals.includes("ENTITY_HOST_TOKEN_MATCH")
  ) {
    return 0.25;
  }
  return 0;
}

/** 下载/文档任务的安全层级优先于分数，落实 WAY-50 留给本阶段的不变量。 */
function calculateSafetyTier(
  assessment: OfficialSourceAssessment,
): number {
  if (!isOfficialnessRelevant(assessment)) {
    return 0;
  }

  switch (assessment.classification) {
    case "official":
      return 2;
    case "unknown":
      return 1;
    case "risky":
      return 0;
  }
}

function calculateWeightedScore(
  signals: HeuristicSignals,
  weights: HeuristicProfileWeights,
): number {
  const total = HEURISTIC_SIGNAL_KEYS.reduce(
    (sum, key) => sum + signals[key] * weights[key],
    0,
  );
  return Math.round((total + Number.EPSILON) * SCORE_PRECISION) /
    SCORE_PRECISION;
}

/**
 * 候选 ID 在任何排序前由原输入位置生成。排序器显式使用 originalIndex 收尾，
 * 不依赖 JavaScript 引擎的隐式稳定排序承诺。
 */
export function heuristicRankCandidates(
  input: HeuristicRankInput,
): ResourceCandidate[] {
  if (!Number.isFinite(input.nowMs)) {
    throw new TypeError("nowMs must be finite");
  }

  const domainCounts = new Map<string, number>();
  for (const { candidate } of input.assessments) {
    domainCounts.set(candidate.domain, (domainCounts.get(candidate.domain) ?? 0) + 1);
  }

  const nodeTokens = tokenize(input.node.title, input.node.description);
  const freshnessEnabled =
    input.node.searchPlan.rankingProfile === "news" ||
    input.analysis.freshnessSensitive;
  const weights =
    HEURISTIC_PROFILE_WEIGHTS[input.node.searchPlan.rankingProfile];

  const entries: RankedEntry[] = input.assessments.map(
    (assessment, originalIndex) => {
      const { candidate } = assessment;
      const queryTokens = tokenize(candidate.query);
      const titleTokens = tokenize(candidate.title);
      const combinedContextTokens = new Set([
        ...queryTokens,
        ...nodeTokens,
      ]);
      const signals: HeuristicSignals = {
        providerQuality: calculateProviderQuality(
          candidate.providerScore,
          candidate.providerRank,
        ),
        titleRelevance:
          (calculateCoverage(queryTokens, titleTokens) +
            calculateCoverage(nodeTokens, titleTokens)) /
          2,
        snippetRelevance: calculateCoverage(
          combinedContextTokens,
          tokenize(candidate.snippet),
        ),
        https: calculateHttps(candidate.canonicalUrl),
        domainDiversity: 1 / (domainCounts.get(candidate.domain) ?? 1),
        freshness: calculateFreshness(
          candidate.publishedAt,
          input.nowMs,
          freshnessEnabled,
        ),
        officialness: calculateOfficialness(assessment),
      };

      return {
        candidate: {
          candidateId: `candidate_${originalIndex + 1}`,
          hit: candidate,
          heuristicScore: calculateWeightedScore(signals, weights),
          heuristicSignals: signals,
        },
        originalIndex,
        safetyTier: calculateSafetyTier(assessment),
      };
    },
  );

  return entries
    .sort(
      (left, right) =>
        right.safetyTier - left.safetyTier ||
        right.candidate.heuristicScore - left.candidate.heuristicScore ||
        left.originalIndex - right.originalIndex,
    )
    .slice(0, MAX_PRERANK_CANDIDATES_PER_NODE)
    .map(entry => entry.candidate);
}
