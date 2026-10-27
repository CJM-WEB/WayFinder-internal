/**
 * 模块职责：把四个 Full Quality Eval Block 的质量、调用、排序、延迟、Token、Cache
 * 与成本事实汇总为可审核结果，并在 A-B-B-A 条件或覆盖率不完整时拒绝比较。
 *
 * 关键边界：
 * - 当前报告严格读取 `quality-eval.v6`；WAY-107 v5 基线仅经受限内存归一化读取；
 * - `0` 是有效测量值，`telemetry: null` 才表示缺失；
 * - 本模块只判断报告能否比较，不自动给出 Keep / Revert 产品结论。
 */
import { isDeepStrictEqual } from "node:util";

import {
  QualityEvalReportSchema,
  assertQualityEvalArtifactSafety,
  type QualityEvalReport,
} from "./run-quality-eval.js";
import {
  assertQualityEvalReportDatasetIntegrity,
  createQualityEvalOperatingSummary,
  summarizeQualityEvalProviderUsage,
  summarizeQualityEvalRanking,
  type QualityEvalOperatingSummary,
  type QualityEvalProviderUsage,
} from "./quality-eval-operating-summary.js";

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

type ParsedComparableReport = Readonly<{
  report: QualityEvalReport;
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
 * WAY-107 基线使用 outer v5 / query v4，且没有 Ranking telemetry。这里只为复用
 * 当前严格 Schema 做内存归一化；零观测会令 coverage 不完整，不能冒充新排序证据。
 */
function normalizeLegacyReport(value: Record<string, unknown>): unknown {
  const source = value.source;
  const results = value.results;
  if (!isRecord(source) || "ranking" in source || !Array.isArray(results)) {
    throw new TypeError("legacy_report_invalid");
  }

  return {
    ...value,
    schemaVersion: "quality-eval.v6",
    source: { ...source, ranking: "rank-fusion.v1" },
    results: results.map(result => {
      if (!isRecord(result) || result.schemaVersion !== "quality-eval.v4") {
        throw new TypeError("legacy_query_invalid");
      }
      const telemetry = result.telemetry;
      if (
        telemetry !== null &&
        (!isRecord(telemetry) ||
          "ranking" in telemetry ||
          "versions" in telemetry)
      ) {
        throw new TypeError("legacy_telemetry_invalid");
      }
      return {
        ...result,
        schemaVersion: "quality-eval.v5",
        telemetry:
          telemetry === null
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
    const legacy = isRecord(value) && value.schemaVersion === "quality-eval.v5";
    const parsed = QualityEvalReportSchema.safeParse(
      legacy ? normalizeLegacyReport(value) : value,
    );
    if (!parsed.success) {
      throw new TypeError("schema_invalid");
    }
    // 比较器可能读取历史或人工搬运的报告，不能只凭结构合法就假定已经脱敏。
    assertQualityEvalArtifactSafety(parsed.data, []);
    return {
      report: parsed.data,
      rankingVersion: legacy ? "pre-fusion.v0" : "rank-fusion.v1",
    };
  } catch {
    throw new TypeError(`Quality Eval ${block} 报告不符合严格 Schema`);
  }
}

/** 只选择必须跨 Block 相同的实验条件；Git Commit 由 A/B 预登记值单独核对。 */
function readComparableMetadata(report: QualityEvalReport): unknown {
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
  const ranking = summarizeQualityEvalRanking(report.results);
  const operating = createQualityEvalOperatingSummary(report);

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
    providerUsage: usage,
    ranking,
    tokens: operating.tokens,
    cache: operating.cache,
    estimatedCost: operating.estimatedCost,
  };
  const complete =
    usage.status === "complete" &&
    ranking.status === "complete" &&
    operating.latency.status === "complete" &&
    operating.tokens.status === "complete";
  const unavailable =
    usage.status === "unavailable" &&
    ranking.status === "unavailable" &&
    operating.latency.status === "unavailable" &&
    operating.tokens.status === "unavailable";
  return { ...facts, status: complete ? "complete" : unavailable ? "unavailable" : "partial" };
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
    assertQualityEvalReportDatasetIntegrity(report);
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
