/**
 * 模块职责：把四个 Full Quality Eval Block 的质量、调用、排序、延迟、Token、Cache
 * 与成本事实汇总为可审核结果，并在 A-B-B-A 条件或覆盖率不完整时拒绝比较。
 *
 * 关键边界：
 * - 当前报告严格读取 `quality-eval.v9`；旧 v5-v8 只经显式内存归一化读取；
 * - `0` 是有效测量值，`telemetry: null` 才表示缺失；
 * - 本模块只判断报告能否比较，不自动给出 Keep / Revert 产品结论。
 */
import { isDeepStrictEqual } from "node:util";

import { GraphPlanSchema } from "@wayfinder/contracts";

import {
  QualityEvalReportSchema,
  assertQualityEvalArtifactSafety,
  type QualityEvalReport,
} from "./run-quality-eval.js";
import {
  assertQualityEvalReportDatasetIntegrity,
  createQualityEvalOperatingSummary,
  summarizeQualityEvalDuplication,
  summarizeQualityEvalProviderUsage,
  summarizeQualityEvalRanking,
  type QualityEvalOperatingSummary,
  type QualityEvalProviderUsage,
} from "./quality-eval-operating-summary.js";
import { measureQualityEvalPlannedRequestDuplication } from "./quality-metrics.js";

const BLOCK_ORDER = ["A1", "B1", "B2", "A2"] as const;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

type BlockName = (typeof BLOCK_ORDER)[number];

export type QualityEvalComparisonInput = Readonly<{
  baselineCommit: string;
  candidateCommit: string;
  blocks: readonly Readonly<{
    block: BlockName;
    report: unknown;
  }>[];
}>;

type BlockFacts = Readonly<{
  block: BlockName;
  condition: "A" | "B";
  evaluationRunId: string;
  sourceCommit: string;
  rankingVersion: "pre-fusion.v0" | "rank-fusion.v1";
  latency: QualityEvalOperatingSummary["latency"];
  duplication: QualityEvalOperatingSummary["duplication"];
  providerUsage: QualityEvalProviderUsage;
  ranking: QualityEvalOperatingSummary["ranking"];
  tokens: QualityEvalOperatingSummary["tokens"];
  cache: QualityEvalOperatingSummary["cache"];
  estimatedCost: QualityEvalOperatingSummary["estimatedCost"];
}>;

export type QualityEvalBlockSummary = BlockFacts &
  Readonly<{ status: "complete" | "partial" | "unavailable" }>;

export type QualityEvalComparison = Readonly<{
  status: "comparable" | "inconclusive";
  reason: "all_blocks_complete" | "telemetry_incomplete";
  blocks: readonly QualityEvalBlockSummary[];
}>;

type ComparableQualityEvalReport = Omit<QualityEvalReport, "runPolicy"> &
  Readonly<{
    runPolicy: Omit<QualityEvalReport["runPolicy"], "language"> &
      Readonly<{ language: "zh-CN" | "und" }>;
  }>;

type ParsedComparableReport = Readonly<{
  report: ComparableQualityEvalReport;
  rankingVersion: BlockFacts["rankingVersion"];
}>;

const EMPTY_RANKING_METRICS = Object.freeze({
  llmSuccess: Object.freeze({
    nodeCount: 0,
    finalCandidateCount: 0,
    providerTop1OverrideCount: 0,
    heuristicTop1OverrideCount: 0,
    providerTop3FinalOverlapCount: 0,
    heuristicTop3FinalOverlapCount: 0,
    top3ComparisonSlots: 0,
  }),
  fallback: Object.freeze({
    nodeCount: 0,
    finalCandidateCount: 0,
    providerTop1OverrideCount: 0,
    heuristicTop1OverrideCount: 0,
    providerTop3FinalOverlapCount: 0,
    heuristicTop3FinalOverlapCount: 0,
    top3ComparisonSlots: 0,
  }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 旧 outer v5/query v4 没有 Ranking telemetry，outer v6/query v5 没有计划请求诊断；
 * outer v7/v8 使用 query v6 / metrics v2。归一化只升级工件形状，不改写
 * 旧 runPolicy.language；因此 und 与 zh-CN 会在跨 Block 条件比较时明确不一致。
 */
function normalizeLegacyReport(
  value: Record<string, unknown>,
  outerVersion:
    | "quality-eval.v5"
    | "quality-eval.v6"
    | "quality-eval.v7"
    | "quality-eval.v8",
): unknown {
  const source = value.source;
  const runPolicy = value.runPolicy;
  const results = value.results;
  if (
    !isRecord(source) ||
    !isRecord(runPolicy) ||
    runPolicy.language !== "und" ||
    !Array.isArray(results) ||
    (outerVersion === "quality-eval.v5" && "ranking" in source) ||
    (outerVersion !== "quality-eval.v5" && source.ranking !== "rank-fusion.v1")
  ) {
    throw new TypeError("legacy_report_invalid");
  }
  const providers = source.providers;
  if (!isRecord(providers)) throw new TypeError("legacy_provider_invalid");
  const plannedRequestConfig = {
    providerId: providers.search,
    // 这只重建 v1 未序列化的五个聚合计数：全局常量从 und 换为
    // zh-CN 不改变分组基数；真实历史身份仍保留在 runPolicy.language。
    language: "zh-CN",
  };
  const expectedQueryVersion =
    outerVersion === "quality-eval.v5"
      ? "quality-eval.v4"
      : outerVersion === "quality-eval.v6"
        ? "quality-eval.v5"
        : "quality-eval.v6";

  return {
    ...value,
    schemaVersion: "quality-eval.v9",
    source:
      outerVersion === "quality-eval.v5"
        ? { ...source, ranking: "rank-fusion.v1" }
        : source,
    results: results.map(result => {
      if (!isRecord(result) || result.schemaVersion !== expectedQueryVersion) {
        throw new TypeError("legacy_query_invalid");
      }
      const telemetry = result.telemetry;
      if (
        outerVersion === "quality-eval.v5" &&
        telemetry !== null &&
        (!isRecord(telemetry) ||
          "ranking" in telemetry ||
          "versions" in telemetry)
      ) {
        throw new TypeError("legacy_telemetry_invalid");
      }
      const metrics = result.metrics;
      let normalizedMetrics = metrics;
      if (
        metrics !== null &&
        outerVersion !== "quality-eval.v7" &&
        outerVersion !== "quality-eval.v8"
      ) {
        const parsedPlan = GraphPlanSchema.safeParse(result.plan);
        if (
          !isRecord(metrics) ||
          metrics.version !== "quality-metrics.v1" ||
          !parsedPlan.success
        ) {
          throw new TypeError("legacy_metrics_invalid");
        }
        normalizedMetrics = {
          ...metrics,
          version: "quality-metrics.v3",
          plannedRequestDuplication:
            measureQualityEvalPlannedRequestDuplication(
              parsedPlan.data,
              plannedRequestConfig,
            ),
        };
      } else if (metrics !== null) {
        if (!isRecord(metrics) || metrics.version !== "quality-metrics.v2") {
          throw new TypeError("legacy_metrics_invalid");
        }
        // v2 与 v3 的聚合数值形状不变；历史语言身份继续由 runPolicy 保留。
        normalizedMetrics = { ...metrics, version: "quality-metrics.v3" };
      }
      return {
        ...result,
        schemaVersion: "quality-eval.v7",
        metrics: normalizedMetrics,
        telemetry:
          outerVersion !== "quality-eval.v5"
            ? telemetry
            : telemetry === null
              ? null
              : {
                  ...telemetry,
                  versions: { rankFusion: "rank-fusion.v1" },
                  ranking: EMPTY_RANKING_METRICS,
                },
      };
    }),
  };
}

function parseReport(
  value: unknown,
  block: BlockName,
): ParsedComparableReport {
  try {
    const legacyVersion =
      isRecord(value) &&
      (value.schemaVersion === "quality-eval.v5" ||
        value.schemaVersion === "quality-eval.v6" ||
        value.schemaVersion === "quality-eval.v7" ||
        value.schemaVersion === "quality-eval.v8")
        ? value.schemaVersion
        : null;
    let candidate = value;
    if (legacyVersion !== null) {
      // legacyVersion 只能由 record 分支生成；再次缩窄以保留 unknown 输入边界。
      if (!isRecord(value)) throw new TypeError("legacy_report_invalid");
      candidate = normalizeLegacyReport(value, legacyVersion);
    }
    const legacyLanguage =
      legacyVersion !== null &&
      isRecord(candidate) &&
      isRecord(candidate.runPolicy) &&
      candidate.runPolicy.language === "und"
        ? "und"
        : null;
    const validationCandidate =
      legacyLanguage === null || !isRecord(candidate) || !isRecord(candidate.runPolicy)
        ? candidate
        : {
            ...candidate,
            // 仅用当前 Schema 验证其余结构；返回的历史报告仍保留 und。
            runPolicy: { ...candidate.runPolicy, language: "zh-CN" },
          };
    const parsed = QualityEvalReportSchema.safeParse(validationCandidate);
    if (!parsed.success) {
      throw new TypeError("schema_invalid");
    }
    // 比较器可能读取历史或人工搬运的报告，不能只凭结构合法就假定已经脱敏。
    assertQualityEvalArtifactSafety(candidate, []);
    const report: ComparableQualityEvalReport =
      legacyLanguage === null
        ? parsed.data
        : {
            ...parsed.data,
            runPolicy: { ...parsed.data.runPolicy, language: legacyLanguage },
          };
    return {
      report,
      rankingVersion:
        legacyVersion === "quality-eval.v5"
          ? "pre-fusion.v0"
          : "rank-fusion.v1",
    };
  } catch {
    throw new TypeError(`Quality Eval ${block} 报告不符合严格 Schema`);
  }
}

/** 只选择必须跨 Block 相同的实验条件；Git Commit 由 A/B 预登记值单独核对。 */
function readComparableMetadata(report: ComparableQualityEvalReport): unknown {
  return {
    dataset: report.dataset,
    contracts: report.source.contracts,
    prompts: report.source.prompts,
    providers: report.source.providers,
    runPolicy: report.runPolicy,
    artifactPolicy: report.artifactPolicy,
    queries: report.results.map(result => ({
      comparisonKey: result.comparisonKey,
      query: result.query,
    })),
  };
}

function aggregateBlock(
  block: BlockName,
  parsed: ParsedComparableReport,
): QualityEvalBlockSummary {
  const { report } = parsed;
  const usage = summarizeQualityEvalProviderUsage(report.results);
  const duplication = summarizeQualityEvalDuplication(report.results);
  const ranking = summarizeQualityEvalRanking(report.results);
  // 摘要器不读取 language；历史 und 仅在比较元数据中保留并守门。
  const operating = createQualityEvalOperatingSummary(
    report as QualityEvalReport,
  );

  // SerpAPI Bing-only 链路没有 Extract 阶段；任一非零事实说明实验条件已漂移。
  const extractDrift = report.results.some(result => {
    const telemetry = result.telemetry;
    return (
      telemetry !== null &&
      (telemetry.counts.logicalExtractCalls !== 0 ||
        telemetry.counts.extractUrlCount !== 0 ||
        telemetry.counts.extractHttpAttempts !== 0 ||
        telemetry.timingsMs.provider.extract !== 0)
    );
  });
  if (extractDrift) {
    throw new TypeError("Quality Eval Search-only Block 出现 Extract 调用或耗时");
  }

  const facts: BlockFacts = {
    block,
    condition: block.startsWith("A") ? "A" : "B",
    evaluationRunId: report.evaluationRunId,
    sourceCommit: report.source.git.commit,
    rankingVersion: parsed.rankingVersion,
    latency: operating.latency,
    duplication,
    providerUsage: usage,
    ranking,
    tokens: operating.tokens,
    cache: operating.cache,
    estimatedCost: operating.estimatedCost,
  };
  const complete =
    usage.status === "complete" &&
    duplication.status === "complete" &&
    ranking.status === "complete" &&
    operating.latency.status === "complete" &&
    operating.tokens.status === "complete";
  const unavailable =
    usage.status === "unavailable" &&
    duplication.status === "unavailable" &&
    ranking.status === "unavailable" &&
    operating.latency.status === "unavailable" &&
    operating.tokens.status === "unavailable";
  return {
    ...facts,
    status: complete ? "complete" : unavailable ? "unavailable" : "partial",
  };
}

/**
 * 四个 Block 必须严格按 A1-B1-B2-A2 输入。元数据漂移属于协议错误并直接拒绝；
 * 遥测缺失属于可审计的测量失败，返回 inconclusive，禁止选择性补跑后拼接比较。
 */
export function compareQualityEvalBlocks(
  input: QualityEvalComparisonInput,
): QualityEvalComparison {
  if (
    !COMMIT_PATTERN.test(input.baselineCommit) ||
    !COMMIT_PATTERN.test(input.candidateCommit) ||
    input.baselineCommit === input.candidateCommit
  ) {
    throw new TypeError("Quality Eval A/B Commit 预登记值无效");
  }
  if (
    input.blocks.length !== BLOCK_ORDER.length ||
    input.blocks.some((entry, index) => entry.block !== BLOCK_ORDER[index])
  ) {
    throw new TypeError("Quality Eval Block 必须严格按 A1-B1-B2-A2 排列");
  }

  const parsedReports = input.blocks.map(entry =>
    parseReport(entry.report, entry.block),
  );
  const reports = parsedReports.map(parsed => parsed.report);
  const runIds = new Set(reports.map(report => report.evaluationRunId));
  if (runIds.size !== reports.length) {
    throw new TypeError("Quality Eval Block 必须来自四次独立运行");
  }
  if (
    reports.slice(1).some(
      (report, index) =>
        Date.parse(reports[index]!.completedAt) >=
        Date.parse(report.completedAt),
    )
  ) {
    throw new TypeError("Quality Eval Block 完成时间必须严格递增");
  }

  for (const [index, report] of reports.entries()) {
    if (report.dataset.kind !== "full") {
      throw new TypeError("Quality Eval 比较只接受完整 Full 报告");
    }
    // 完整性校验只读数据集、Query 顺序与 comparisonKey。
    assertQualityEvalReportDatasetIntegrity(report as QualityEvalReport);
    const expectedCommit =
      BLOCK_ORDER[index]?.startsWith("A") === true
        ? input.baselineCommit
        : input.candidateCommit;
    if (report.source.git.commit !== expectedCommit) {
      throw new TypeError("Quality Eval Block 与预登记 Commit 不一致");
    }
  }

  const referenceMetadata = readComparableMetadata(reports[0]!);
  if (
    reports.slice(1).some(
      report =>
        !isDeepStrictEqual(
          readComparableMetadata(report),
          referenceMetadata,
        ),
    )
  ) {
    throw new TypeError("Quality Eval Block 的数据集或运行条件不一致");
  }

  const blocks = parsedReports.map((parsed, index) =>
    aggregateBlock(BLOCK_ORDER[index]!, parsed),
  );
  const complete = blocks.every(block => block.status === "complete");
  return {
    status: complete ? "comparable" : "inconclusive",
    reason: complete ? "all_blocks_complete" : "telemetry_incomplete",
    blocks,
  };
}
