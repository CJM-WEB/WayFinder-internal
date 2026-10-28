/**
 * 模块职责：把单次 Quality Eval 的已脱敏事实汇总为 Quality / Latency / Cost
 * （质量 / 延迟 / 成本）三角摘要，供基线审核而非生产监控使用。
 *
 * 关键边界：
 * - 只消费已经通过 `QualityEvalReportSchema` 校验的报告，不读取文件、Secret 或原始 Provider 数据；
 * - P50 使用 nearest-rank（最近秩）且仅在全部 Query 都有遥测时生成，避免用残缺样本伪装基线；
 * - 成本费率未冻结时保持不可用，Cache 禁用时只报告策略，不伪造 Hit / Miss；
 * - 摘要永远要求独立人工质量审核，不能因延迟或成本更低而自动接受改动。
 */
import { z } from "zod";

import type { QualityEvalQueryResult } from "./quality-eval.js";
import { QualityEvalPlannedRequestDuplicationSchema } from "./quality-metrics.js";
import type { QualityEvalReport } from "./run-quality-eval.js";

export const QUALITY_EVAL_OPERATING_SUMMARY_VERSION =
  "quality-eval-operating-summary.v4" as const;

const CALL_COUNT_KEYS = [
  "logicalSearchCalls",
  "logicalExtractCalls",
  "extractUrlCount",
  "logicalLlmCalls",
  "searchHttpAttempts",
  "extractHttpAttempts",
] as const;
const GOLDEN_QUERY_IDS = [
  "wfq-001",
  "wfq-006",
  "wfq-009",
  "wfq-012",
  "wfq-013",
  "wfq-015",
] as const;
const FULL_QUERY_IDS = Array.from({ length: 20 }, (_, index) =>
  `wfq-${String(index + 1).padStart(3, "0")}`,
);

type CallCountKey = (typeof CALL_COUNT_KEYS)[number];
export type QualityEvalCallCounts = Readonly<
  Record<CallCountKey, number>
>;

type ProviderUsageFacts = Readonly<{
  expectedQueryCount: number;
  observedQueryCount: number;
  missingQueryIds: readonly string[];
}>;

export type QualityEvalProviderUsage =
  | (ProviderUsageFacts &
      Readonly<{ status: "complete"; totals: QualityEvalCallCounts }>)
  | (ProviderUsageFacts &
      Readonly<{
        status: "partial";
        observedTotals: QualityEvalCallCounts;
      }>)
  | (ProviderUsageFacts & Readonly<{ status: "unavailable" }>);

const NonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const NonNegativeFiniteSchema = z.number().finite().min(0);

const CallCountsSchema = z.strictObject({
  logicalSearchCalls: NonNegativeSafeIntegerSchema,
  logicalExtractCalls: NonNegativeSafeIntegerSchema,
  extractUrlCount: NonNegativeSafeIntegerSchema,
  logicalLlmCalls: NonNegativeSafeIntegerSchema,
  searchHttpAttempts: NonNegativeSafeIntegerSchema,
  extractHttpAttempts: NonNegativeSafeIntegerSchema,
});

const CoverageFactsSchema = z.strictObject({
  expectedQueryCount: z.number().int().min(1).max(20),
  observedQueryCount: z.number().int().min(0).max(20),
  missingQueryIds: z.array(z.string().regex(/^wfq-\d{3}$/u)),
});

const ProviderUsageSchema = z.discriminatedUnion("status", [
  CoverageFactsSchema.extend({
    status: z.literal("complete"),
    totals: CallCountsSchema,
  }),
  CoverageFactsSchema.extend({
    status: z.literal("partial"),
    observedTotals: CallCountsSchema,
  }),
  CoverageFactsSchema.extend({ status: z.literal("unavailable") }),
]);

const ResourceDuplicationTotalsSchema = z.strictObject({
  measuredQueryCount: NonNegativeSafeIntegerSchema,
  noResourceQueryCount: NonNegativeSafeIntegerSchema,
  duplicateOccurrences: NonNegativeSafeIntegerSchema,
  totalOccurrences: NonNegativeSafeIntegerSchema,
});

const DuplicationTotalsSchema = z.strictObject({
  plannedRequests: QualityEvalPlannedRequestDuplicationSchema,
  resources: ResourceDuplicationTotalsSchema,
});

const DuplicationSummarySchema = z.discriminatedUnion("status", [
  CoverageFactsSchema.extend({
    status: z.literal("complete"),
    totals: DuplicationTotalsSchema,
  }),
  CoverageFactsSchema.extend({
    status: z.literal("partial"),
    observedTotals: DuplicationTotalsSchema,
  }),
  CoverageFactsSchema.extend({ status: z.literal("unavailable") }),
]);

const RankingTotalsSchema = z.strictObject({
  observedNodeCount: NonNegativeSafeIntegerSchema,
  llmSuccessNodeCount: NonNegativeSafeIntegerSchema,
  fallbackNodeCount: NonNegativeSafeIntegerSchema,
  finalCandidateCount: NonNegativeSafeIntegerSchema,
});

const RankingRatioSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("measured"),
    numerator: NonNegativeSafeIntegerSchema,
    denominator: NonNegativeSafeIntegerSchema.min(1),
    value: z.number().finite().min(0).max(1),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.literal("noRankingObservations"),
  }),
]);

const RankingModeRatesSchema = z.strictObject({
  providerTop1Override: RankingRatioSchema,
  heuristicTop1Override: RankingRatioSchema,
  providerTop3FinalOverlap: RankingRatioSchema,
  heuristicTop3FinalOverlap: RankingRatioSchema,
});

const RankingRatesSchema = z.strictObject({
  llmSuccess: RankingModeRatesSchema,
  fallback: RankingModeRatesSchema,
});

const RankingCoverageSchema = z.strictObject({
  expectedQueryCount: z.number().int().min(1).max(20),
  observedTelemetryQueryCount: z.number().int().min(0).max(20),
  expectedRankedNodeCount: NonNegativeSafeIntegerSchema,
  observedRankedNodeCount: NonNegativeSafeIntegerSchema,
  incompleteQueryCount: z.number().int().min(0).max(20),
});

const RankingSummarySchema = z.discriminatedUnion("status", [
  RankingCoverageSchema.extend({
    status: z.literal("complete"),
    totals: RankingTotalsSchema,
    rates: RankingRatesSchema,
  }),
  RankingCoverageSchema.extend({
    status: z.literal("partial"),
    observedTotals: RankingTotalsSchema,
    rates: RankingRatesSchema,
  }),
  RankingCoverageSchema.extend({
    status: z.literal("unavailable"),
    reason: z.enum(["noTelemetry", "noRankingEligibleNodes"]),
  }),
]);

const TokenTotalsSchema = z.strictObject({
  observations: NonNegativeSafeIntegerSchema,
  inputTokens: NonNegativeSafeIntegerSchema,
  outputTokens: NonNegativeSafeIntegerSchema,
  totalTokens: NonNegativeSafeIntegerSchema,
});

const TokenCoverageSchema = z.strictObject({
  complete: z.number().int().min(0).max(20),
  notUsed: z.number().int().min(0).max(20),
  partial: z.number().int().min(0).max(20),
  unavailable: z.number().int().min(0).max(20),
  telemetryMissing: z.number().int().min(0).max(20),
});

const TokensSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("complete"),
    coverage: TokenCoverageSchema,
    totals: TokenTotalsSchema,
  }),
  z.strictObject({
    status: z.literal("partial"),
    coverage: TokenCoverageSchema,
    observedQueryCount: z.number().int().min(1).max(20),
    observedTotals: TokenTotalsSchema,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    coverage: TokenCoverageSchema,
  }),
]);

const LatencySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("complete"),
    metric: z.literal("totalRunMs"),
    percentileMethod: z.literal("nearest_rank"),
    sampleCount: z.number().int().min(1).max(20),
    p50Ms: NonNegativeFiniteSchema,
    representativeWorstCase: z.strictObject({
      queryId: z.string().regex(/^wfq-\d{3}$/u),
      executionStatus: z.enum([
        "completed",
        "run_failed",
        "cancelled",
        "unexpected_internal_error",
      ]),
      totalMs: NonNegativeFiniteSchema,
    }),
  }),
  CoverageFactsSchema.extend({ status: z.literal("partial") }),
  CoverageFactsSchema.extend({ status: z.literal("unavailable") }),
]);

export const QualityEvalOperatingSummarySchema = z.strictObject({
  schemaVersion: z.literal(QUALITY_EVAL_OPERATING_SUMMARY_VERSION),
  source: z.strictObject({
    evaluationRunId: z.string().min(1),
    completedAt: z.iso.datetime({ offset: true }),
    gitCommit: z.string().regex(/^[0-9a-f]{40}$/u),
    datasetKind: z.enum(["golden", "full"]),
    datasetVersion: z.string().min(1),
    datasetFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  quality: z.strictObject({
    execution: z.strictObject({
      completed: z.number().int().min(0).max(20),
      runFailed: z.number().int().min(0).max(20),
      cancelled: z.number().int().min(0).max(20),
      unexpectedInternalError: z.number().int().min(0).max(20),
    }),
    finalStatus: z.strictObject({
      complete: z.number().int().min(0).max(20),
      partial: z.number().int().min(0).max(20),
      unavailable: z.number().int().min(0).max(20),
    }),
    deadlineCompliance: z.strictObject({
      within: z.number().int().min(0).max(20),
      exceeded: z.number().int().min(0).max(20),
      unavailable: z.number().int().min(0).max(20),
    }),
    humanReview: z.strictObject({
      status: z.literal("required"),
      decision: z.literal("not_recorded"),
      automaticAcceptance: z.literal(false),
    }),
  }),
  latency: LatencySchema,
  duplication: DuplicationSummarySchema,
  providerUsage: ProviderUsageSchema,
  ranking: RankingSummarySchema,
  tokens: TokensSchema,
  cache: z.strictObject({
    status: z.literal("notMeasured"),
    mode: z.literal("cold_disabled"),
    hitRate: z.literal("notApplicable"),
  }),
  estimatedCost: z.strictObject({
    status: z.literal("unavailable"),
    reason: z.literal("pricing_not_frozen"),
  }),
});

export type QualityEvalOperatingSummary = Readonly<
  z.infer<typeof QualityEvalOperatingSummarySchema>
>;

/**
 * 报告 Schema 负责单项结构，本函数补齐 Dataset 级数量、顺序和 comparisonKey 不变量。
 * Full 检查同时供 WAY-90 比较器复用，避免形成第二套 20 条 Query 完整性规则。
 */
export function assertQualityEvalReportDatasetIntegrity(
  report: QualityEvalReport,
): void {
  const expectedIds =
    report.dataset.kind === "full" ? FULL_QUERY_IDS : GOLDEN_QUERY_IDS;
  const observedIds = report.results.map(result => result.query.id);
  if (
    report.dataset.queryCount !== expectedIds.length ||
    observedIds.length !== expectedIds.length ||
    observedIds.some((id, index) => id !== expectedIds[index]) ||
    report.results.some(
      result =>
        result.comparisonKey !==
        `${report.dataset.version}:${result.query.id}`,
    )
  ) {
    throw new TypeError(
      report.dataset.kind === "full"
        ? "Quality Eval 基线只接受按 wfq-001 至 wfq-020 排列的完整 Full 报告"
        : "Quality Eval Golden 报告的数量、顺序或 comparisonKey 无效",
    );
  }
}

function createZeroCallCounts(): Record<CallCountKey, number> {
  return {
    logicalSearchCalls: 0,
    logicalExtractCalls: 0,
    extractUrlCount: 0,
    logicalLlmCalls: 0,
    searchHttpAttempts: 0,
    extractHttpAttempts: 0,
  };
}

function addSafeInteger(
  current: number,
  value: number,
  label: string,
): number {
  const next = current + value;
  if (!Number.isSafeInteger(next)) {
    throw new TypeError(`Quality Eval ${label} 总计超出安全整数范围`);
  }
  return next;
}

function createZeroDuplicationTotals(): z.infer<
  typeof DuplicationTotalsSchema
> {
  return {
    plannedRequests: {
      totalCount: 0,
      uniqueCount: 0,
      intraNodeDuplicateOccurrenceCount: 0,
      crossNodeSharedGroupCount: 0,
      crossNodeExtraNodeOccurrenceCount: 0,
    },
    resources: {
      measuredQueryCount: 0,
      noResourceQueryCount: 0,
      duplicateOccurrences: 0,
      totalOccurrences: 0,
    },
  };
}

/**
 * 只汇总逐 Query 已验证的计划请求与既有 Resource 重复事实。缺少 Metrics 的 Query
 * 进入 coverage 缺口，不能按零重复处理；计划数量与实际 Provider 调用保持独立。
 */
export function summarizeQualityEvalDuplication(
  results: readonly QualityEvalQueryResult[],
): z.infer<typeof DuplicationSummarySchema> {
  const totals = createZeroDuplicationTotals();
  const missingQueryIds: string[] = [];
  let observedQueryCount = 0;

  for (const result of results) {
    if (result.metrics === null) {
      missingQueryIds.push(result.query.id);
      continue;
    }
    observedQueryCount += 1;
    const planned = result.metrics.plannedRequestDuplication;
    for (const key of Object.keys(
      totals.plannedRequests,
    ) as (keyof typeof totals.plannedRequests)[]) {
      totals.plannedRequests[key] = addSafeInteger(
        totals.plannedRequests[key],
        planned[key],
        "计划请求重复",
      );
    }

    const resource = result.metrics.duplicateRate;
    if (resource.status === "measured") {
      totals.resources.measuredQueryCount = addSafeInteger(
        totals.resources.measuredQueryCount,
        1,
        "Resource 重复已测 Query",
      );
      totals.resources.duplicateOccurrences = addSafeInteger(
        totals.resources.duplicateOccurrences,
        resource.duplicateOccurrences,
        "Resource 重复 occurrence",
      );
      totals.resources.totalOccurrences = addSafeInteger(
        totals.resources.totalOccurrences,
        resource.totalOccurrences,
        "Resource 总 occurrence",
      );
    } else {
      totals.resources.noResourceQueryCount = addSafeInteger(
        totals.resources.noResourceQueryCount,
        1,
        "零 Resource Query",
      );
    }
  }

  const facts: ProviderUsageFacts = {
    expectedQueryCount: results.length,
    observedQueryCount,
    missingQueryIds,
  };
  if (observedQueryCount === results.length) {
    return DuplicationSummarySchema.parse({
      ...facts,
      status: "complete",
      totals,
    });
  }
  if (observedQueryCount === 0) {
    return DuplicationSummarySchema.parse({
      ...facts,
      status: "unavailable",
    });
  }
  return DuplicationSummarySchema.parse({
    ...facts,
    status: "partial",
    observedTotals: totals,
  });
}

/**
 * Provider 调用覆盖率由 `telemetry` 是否存在决定；零调用仍是完整测量。
 * 该纯函数同时供 WAY-90 A-B-B-A 比较器复用，保持唯一聚合口径。
 */
export function summarizeQualityEvalProviderUsage(
  results: readonly QualityEvalQueryResult[],
): QualityEvalProviderUsage {
  const totals = createZeroCallCounts();
  const missingQueryIds: string[] = [];
  let observedQueryCount = 0;

  for (const result of results) {
    if (result.telemetry === null) {
      missingQueryIds.push(result.query.id);
      continue;
    }
    observedQueryCount += 1;
    for (const key of CALL_COUNT_KEYS) {
      totals[key] = addSafeInteger(
        totals[key],
        result.telemetry.counts[key],
        "Provider 调用",
      );
    }
  }

  const facts: ProviderUsageFacts = {
    expectedQueryCount: results.length,
    observedQueryCount,
    missingQueryIds,
  };
  if (observedQueryCount === results.length) {
    return { ...facts, status: "complete", totals };
  }
  if (observedQueryCount === 0) {
    return { ...facts, status: "unavailable" };
  }
  return { ...facts, status: "partial", observedTotals: totals };
}

function createRankingRatio(
  numerator: number,
  denominator: number,
): z.infer<typeof RankingRatioSchema> {
  if (denominator === 0) {
    return { status: "unavailable", reason: "noRankingObservations" };
  }
  return {
    status: "measured",
    numerator,
    denominator,
    value: numerator / denominator,
  };
}

/**
 * 排序覆盖以 Query telemetry 是否存在为外层状态；比例分母只取真实完成排序的 Node
 * 或实际 Top3 槽位，零观测明确为 unavailable，不能伪装成 0%。
 */
export function summarizeQualityEvalRanking(
  results: readonly QualityEvalQueryResult[],
): z.infer<typeof RankingSummarySchema> {
  const totals = {
    observedNodeCount: 0,
    llmSuccessNodeCount: 0,
    fallbackNodeCount: 0,
    finalCandidateCount: 0,
  };
  const modes = {
    llmSuccess: {
      nodeCount: 0,
      providerTop1OverrideCount: 0,
      heuristicTop1OverrideCount: 0,
      providerTop3FinalOverlapCount: 0,
      heuristicTop3FinalOverlapCount: 0,
      top3ComparisonSlots: 0,
    },
    fallback: {
      nodeCount: 0,
      providerTop1OverrideCount: 0,
      heuristicTop1OverrideCount: 0,
      providerTop3FinalOverlapCount: 0,
      heuristicTop3FinalOverlapCount: 0,
      top3ComparisonSlots: 0,
    },
  };
  let observedTelemetryQueryCount = 0;
  let expectedRankedNodeCount = 0;
  let incompleteQueryCount = 0;

  for (const result of results) {
    const expectedForQuery =
      result.executionStatus === "completed"
        ? result.nodes.filter(
            node =>
              node.status === "ready" ||
              node.status === "partial" ||
              (node.status === "failed" &&
                node.errorCode === "NO_UNIQUE_RESOURCE_AVAILABLE"),
          ).length
        : 0;
    expectedRankedNodeCount = addSafeInteger(
      expectedRankedNodeCount,
      expectedForQuery,
      "预期排序 Node",
    );
    if (result.telemetry === null) {
      incompleteQueryCount += 1;
      continue;
    }
    observedTelemetryQueryCount += 1;
    const ranking = result.telemetry.ranking;
    const observedNodeCount =
      ranking.llmSuccess.nodeCount + ranking.fallback.nodeCount;
    if (observedNodeCount !== expectedForQuery) incompleteQueryCount += 1;
    totals.observedNodeCount = addSafeInteger(
      totals.observedNodeCount,
      observedNodeCount,
      "排序 Node",
    );
    totals.llmSuccessNodeCount = addSafeInteger(
      totals.llmSuccessNodeCount,
      ranking.llmSuccess.nodeCount,
      "三路融合 Node",
    );
    totals.fallbackNodeCount = addSafeInteger(
      totals.fallbackNodeCount,
      ranking.fallback.nodeCount,
      "fallback Node",
    );
    totals.finalCandidateCount = addSafeInteger(
      totals.finalCandidateCount,
      ranking.llmSuccess.finalCandidateCount +
        ranking.fallback.finalCandidateCount,
      "最终候选",
    );
    for (const modeName of ["llmSuccess", "fallback"] as const) {
      const target = modes[modeName];
      const source = ranking[modeName];
      target.nodeCount = addSafeInteger(
        target.nodeCount,
        source.nodeCount,
        `${modeName} 排序 Node`,
      );
      target.providerTop1OverrideCount = addSafeInteger(
        target.providerTop1OverrideCount,
        source.providerTop1OverrideCount,
        `${modeName} Provider Top1 override`,
      );
      target.heuristicTop1OverrideCount = addSafeInteger(
        target.heuristicTop1OverrideCount,
        source.heuristicTop1OverrideCount,
        `${modeName} Heuristic Top1 override`,
      );
      target.providerTop3FinalOverlapCount = addSafeInteger(
        target.providerTop3FinalOverlapCount,
        source.providerTop3FinalOverlapCount,
        `${modeName} Provider Top3 overlap`,
      );
      target.heuristicTop3FinalOverlapCount = addSafeInteger(
        target.heuristicTop3FinalOverlapCount,
        source.heuristicTop3FinalOverlapCount,
        `${modeName} Heuristic Top3 overlap`,
      );
      target.top3ComparisonSlots = addSafeInteger(
        target.top3ComparisonSlots,
        source.top3ComparisonSlots,
        `${modeName} Top3 比较槽位`,
      );
    }
  }

  const coverage = {
    expectedQueryCount: results.length,
    observedTelemetryQueryCount,
    expectedRankedNodeCount,
    observedRankedNodeCount: totals.observedNodeCount,
    incompleteQueryCount,
  };
  if (
    coverage.expectedRankedNodeCount === 0 &&
    coverage.observedRankedNodeCount === 0
  ) {
    return {
      ...coverage,
      status: "unavailable",
      reason: "noRankingEligibleNodes",
    };
  }
  if (coverage.observedTelemetryQueryCount === 0) {
    return { ...coverage, status: "unavailable", reason: "noTelemetry" };
  }

  const createModeRates = (
    mode: (typeof modes)["llmSuccess"],
  ): z.infer<typeof RankingModeRatesSchema> => ({
    providerTop1Override: createRankingRatio(
      mode.providerTop1OverrideCount,
      mode.nodeCount,
    ),
    heuristicTop1Override: createRankingRatio(
      mode.heuristicTop1OverrideCount,
      mode.nodeCount,
    ),
    providerTop3FinalOverlap: createRankingRatio(
      mode.providerTop3FinalOverlapCount,
      mode.top3ComparisonSlots,
    ),
    heuristicTop3FinalOverlap: createRankingRatio(
      mode.heuristicTop3FinalOverlapCount,
      mode.top3ComparisonSlots,
    ),
  });
  const rates = {
    llmSuccess: createModeRates(modes.llmSuccess),
    fallback: createModeRates(modes.fallback),
  };
  return coverage.incompleteQueryCount === 0
    ? { ...coverage, status: "complete", totals, rates }
    : { ...coverage, status: "partial", observedTotals: totals, rates };
}

function summarizeLatency(
  results: readonly QualityEvalQueryResult[],
): z.infer<typeof LatencySchema> {
  const samples = results.flatMap((result, index) =>
    result.telemetry === null
      ? []
      : [{
          index,
          queryId: result.query.id,
          executionStatus: result.executionStatus,
          totalMs: result.telemetry.timingsMs.total,
        }],
  );
  const missingQueryIds = results
    .filter(result => result.telemetry === null)
    .map(result => result.query.id);
  const coverage = {
    expectedQueryCount: results.length,
    observedQueryCount: samples.length,
    missingQueryIds,
  };
  if (samples.length === 0) return { ...coverage, status: "unavailable" };
  if (samples.length !== results.length) return { ...coverage, status: "partial" };

  const sorted = [...samples].sort(
    (left, right) => left.totalMs - right.totalMs || left.index - right.index,
  );
  const p50 = sorted[Math.ceil(sorted.length * 0.5) - 1]!;
  const worst = samples.reduce((current, sample) =>
    sample.totalMs > current.totalMs ? sample : current,
  );
  return {
    status: "complete",
    metric: "totalRunMs",
    percentileMethod: "nearest_rank",
    sampleCount: samples.length,
    p50Ms: p50.totalMs,
    representativeWorstCase: {
      queryId: worst.queryId,
      executionStatus: worst.executionStatus,
      totalMs: worst.totalMs,
    },
  };
}

function summarizeTokens(
  results: readonly QualityEvalQueryResult[],
): z.infer<typeof TokensSchema> {
  const coverage = {
    complete: 0,
    notUsed: 0,
    partial: 0,
    unavailable: 0,
    telemetryMissing: 0,
  };
  const totals = {
    observations: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  let observedQueryCount = 0;

  for (const result of results) {
    if (result.telemetry === null) {
      coverage.telemetryMissing += 1;
      continue;
    }
    const tokens = result.telemetry.tokens;
    const llmCalls = result.telemetry.counts.logicalLlmCalls;
    const tokenCountsAreZero =
      tokens.observations === 0 &&
      tokens.inputTokens === 0 &&
      tokens.outputTokens === 0 &&
      tokens.totalTokens === 0;
    const validStatus =
      (tokens.status === "not_used" && llmCalls === 0 && tokenCountsAreZero) ||
      (tokens.status === "complete" &&
        llmCalls > 0 &&
        tokens.observations === llmCalls) ||
      (tokens.status === "partial" &&
        llmCalls > 0 &&
        tokens.observations > 0 &&
        tokens.observations !== llmCalls) ||
      (tokens.status === "unavailable" &&
        llmCalls > 0 &&
        tokenCountsAreZero);
    if (!validStatus) {
      throw new TypeError(
        "Quality Eval Token 状态与 LLM 调用或 Usage 覆盖不一致",
      );
    }

    if (tokens.status === "complete") coverage.complete += 1;
    if (tokens.status === "not_used") coverage.notUsed += 1;
    if (tokens.status === "partial") coverage.partial += 1;
    if (tokens.status === "unavailable") {
      coverage.unavailable += 1;
      continue;
    }

    observedQueryCount += 1;
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
      totals[key] = addSafeInteger(totals[key], tokens[key], "Token");
    }
  }

  if (observedQueryCount === 0) {
    return { status: "unavailable", coverage };
  }
  if (
    coverage.telemetryMissing === 0 &&
    coverage.partial === 0 &&
    coverage.unavailable === 0
  ) {
    return { status: "complete", coverage, totals };
  }
  return {
    status: "partial",
    coverage,
    observedQueryCount,
    observedTotals: totals,
  };
}

function summarizeQuality(
  results: readonly QualityEvalQueryResult[],
): QualityEvalOperatingSummary["quality"] {
  const execution = {
    completed: 0,
    runFailed: 0,
    cancelled: 0,
    unexpectedInternalError: 0,
  };
  const finalStatus = { complete: 0, partial: 0, unavailable: 0 };
  const deadlineCompliance = { within: 0, exceeded: 0, unavailable: 0 };

  for (const result of results) {
    if (result.executionStatus === "completed") execution.completed += 1;
    if (result.executionStatus === "run_failed") execution.runFailed += 1;
    if (result.executionStatus === "cancelled") execution.cancelled += 1;
    if (result.executionStatus === "unexpected_internal_error") {
      execution.unexpectedInternalError += 1;
    }

    if (result.finalStatus === "complete") finalStatus.complete += 1;
    else if (result.finalStatus === "partial") finalStatus.partial += 1;
    else finalStatus.unavailable += 1;

    const deadline = result.metrics?.deadlineCompliance.status;
    if (deadline === "within") deadlineCompliance.within += 1;
    else if (deadline === "exceeded") deadlineCompliance.exceeded += 1;
    else if (
      result.metricFailure?.metric === "deadlineCompliance" &&
      result.metricFailure.stage === "runDeadline" &&
      result.metricFailure.code === "RUN_DEADLINE_EXCEEDED"
    ) {
      deadlineCompliance.exceeded += 1;
    }
    else deadlineCompliance.unavailable += 1;
  }

  return {
    execution,
    finalStatus,
    deadlineCompliance,
    humanReview: {
      status: "required",
      decision: "not_recorded",
      automaticAcceptance: false,
    },
  };
}

/** 构造只含聚合事实的严格摘要；调用方仍须执行统一工件安全扫描。 */
export function createQualityEvalOperatingSummary(
  report: QualityEvalReport,
): QualityEvalOperatingSummary {
  assertQualityEvalReportDatasetIntegrity(report);
  return QualityEvalOperatingSummarySchema.parse({
    schemaVersion: QUALITY_EVAL_OPERATING_SUMMARY_VERSION,
    source: {
      evaluationRunId: report.evaluationRunId,
      completedAt: report.completedAt,
      gitCommit: report.source.git.commit,
      datasetKind: report.dataset.kind,
      datasetVersion: report.dataset.version,
      datasetFingerprint: report.dataset.fingerprint,
    },
    quality: summarizeQuality(report.results),
    latency: summarizeLatency(report.results),
    duplication: summarizeQualityEvalDuplication(report.results),
    providerUsage: summarizeQualityEvalProviderUsage(report.results),
    ranking: summarizeQualityEvalRanking(report.results),
    tokens: summarizeTokens(report.results),
    cache: {
      status: "notMeasured",
      mode: report.runPolicy.cache,
      hitRate: "notApplicable",
    },
    estimatedCost: {
      status: "unavailable",
      reason: "pricing_not_frozen",
    },
  });
}
