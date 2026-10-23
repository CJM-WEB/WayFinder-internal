/**
 * 模块职责：把四个 Full Quality Eval Block 的 Provider 调用遥测汇总为可审核事实，
 * 并在 A-B-B-A 元数据或测量完整度不满足预登记条件时拒绝比较。
 *
 * 关键边界：
 * - 只汇总 `quality-eval.v4` 已脱敏报告，不读取 Provider 原始输入、网页正文或 Secret；
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
  summarizeQualityEvalProviderUsage,
  type QualityEvalCallCounts,
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
  expectedQueryCount: 20;
  observedTelemetryCount: number;
  missingQueryIds: readonly string[];
}>;

export type QualityEvalBlockSummary =
  | (BlockFacts &
      Readonly<{ status: "complete"; totals: QualityEvalCallCounts }>)
  | (BlockFacts &
      Readonly<{
        status: "partial";
        observedTotals: QualityEvalCallCounts;
      }>)
  | (BlockFacts & Readonly<{ status: "unavailable" }>);

export type QualityEvalComparison = Readonly<{
  status: "comparable" | "inconclusive";
  reason: "all_blocks_complete" | "telemetry_incomplete";
  blocks: readonly QualityEvalBlockSummary[];
}>;

function parseReport(value: unknown, block: BlockName): QualityEvalReport {
  try {
    const parsed = QualityEvalReportSchema.safeParse(value);
    if (!parsed.success) {
      throw new TypeError("schema_invalid");
    }
    // 比较器可能读取历史或人工搬运的报告，不能只凭结构合法就假定已经脱敏。
    assertQualityEvalArtifactSafety(parsed.data, []);
    return parsed.data;
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
  report: QualityEvalReport,
): QualityEvalBlockSummary {
  const usage = summarizeQualityEvalProviderUsage(report.results);

  const facts: BlockFacts = {
    block,
    condition: block.startsWith("A") ? "A" : "B",
    evaluationRunId: report.evaluationRunId,
    sourceCommit: report.source.git.commit,
    expectedQueryCount: 20,
    observedTelemetryCount: usage.observedQueryCount,
    missingQueryIds: usage.missingQueryIds,
  };
  if (usage.status === "complete") {
    return { ...facts, status: "complete", totals: usage.totals };
  }
  if (usage.status === "unavailable") {
    return { ...facts, status: "unavailable" };
  }
  return {
    ...facts,
    status: "partial",
    observedTotals: usage.observedTotals,
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

  const reports = input.blocks.map(entry =>
    parseReport(entry.report, entry.block),
  );
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

  const blocks = reports.map((report, index) =>
    aggregateBlock(BLOCK_ORDER[index]!, report),
  );
  const complete = blocks.every(block => block.status === "complete");
  return {
    status: complete ? "comparable" : "inconclusive",
    reason: complete ? "all_blocks_complete" : "telemetry_incomplete",
    blocks,
  };
}
