/**
 * 测试职责：冻结 WAY-91 单 Run 三角摘要的覆盖率、P50、最坏样本与成本代理口径。
 *
 * 边界说明：Fixture 只使用固定 Query ID 和失败状态，不访问网络、不读取私密工件，
 * 也不把延迟或成本事实自动转换为产品接受结论。
 */
import { describe, expect, it } from "vitest";

import {
  createQualityEvalOperatingSummary,
  summarizeQualityEvalProviderUsage,
} from "./quality-eval-operating-summary.js";
import { QualityEvalReportSchema } from "./run-quality-eval.js";

const SOURCE_COMMIT = "a".repeat(40);

function createTelemetry(index: number) {
  const value = index + 1;
  return {
    timingsMs: {
      planning: value,
      nodeProcessing: value,
      total: value,
      provider: { search: value, extract: value, llm: value },
    },
    counts: {
      logicalSearchCalls: value,
      logicalExtractCalls: value,
      extractUrlCount: value,
      logicalLlmCalls: value,
      searchHttpAttempts: value,
      extractHttpAttempts: value,
    },
    versions: { rankFusion: "rank-fusion.v1" as const },
    ranking: {
      llmSuccess: {
        nodeCount: 0,
        finalCandidateCount: 0,
        providerTop1OverrideCount: 0,
        heuristicTop1OverrideCount: 0,
        providerTop3FinalOverlapCount: 0,
        heuristicTop3FinalOverlapCount: 0,
        top3ComparisonSlots: 0,
      },
      fallback: {
        nodeCount: 0,
        finalCandidateCount: 0,
        providerTop1OverrideCount: 0,
        heuristicTop1OverrideCount: 0,
        providerTop3FinalOverlapCount: 0,
        heuristicTop3FinalOverlapCount: 0,
        top3ComparisonSlots: 0,
      },
    },
    tokens: {
      status: "complete" as const,
      observations: value,
      inputTokens: value,
      outputTokens: value,
      totalTokens: value,
    },
    estimatedCost: {
      status: "unavailable" as const,
      reason: "pricing_not_frozen" as const,
    },
  };
}

function createReport() {
  return QualityEvalReportSchema.parse({
    schemaVersion: "quality-eval.v6",
    issue: "WAY-86",
    evaluationRunId:
      "2026-10-23T09-00-00-000Z-11111111-1111-4111-8111-111111111111",
    completedAt: "2026-10-23T09:10:00.000Z",
    dataset: {
      kind: "full",
      version: "wayfinder-regression.v1",
      queryCount: 20,
      queryFiles: ["tests/eval-queries.json", "tests/eval-full-queries.json"],
      fingerprint: "b".repeat(64),
    },
    source: {
      git: { commit: SOURCE_COMMIT, worktreeClean: true },
      contracts: { protocol: "0.1", resultGraph: "0.1" },
      prompts: {
        planner: "graph-planner.v1",
        reviser: "graph-reviser.v1",
        reranker: "resource-reranker.v1",
      },
      ranking: "rank-fusion.v1",
      providers: {
        search: "serpapi_bing",
        llm: "deepseek",
        llmModel: "deepseek-flash",
      },
    },
    runPolicy: {
      execution: "sequential",
      repetitionsPerQuery: 1,
      cache: "cold_disabled",
      runDeadlineMs: 20_000,
      language: "und",
      queryNormalization: "nfkc_trim_lowercase",
      riskyDownloadDomainPolicy: "not_frozen_empty",
      timeoutsMs: {
        search: 2_500,
        planner: 10_000,
        rerank: 10_000,
      },
      concurrency: { search: 6, llm: 3 },
    },
    artifactPolicy: {
      localOnly: true,
      automaticUpload: false,
      automaticDeletion: false,
      retention: "until_human_review_and_controlled_sync_decision",
    },
    results: Array.from({ length: 20 }, (_, index) => {
      const id = `wfq-${String(index + 1).padStart(3, "0")}`;
      return {
        schemaVersion: "quality-eval.v5",
        comparisonKey: `wayfinder-regression.v1:${id}`,
        query: {
          id,
          query: `Query ${index + 1}`,
          category: "knowledge",
          rationale: "固定 WAY-91 汇总 Fixture。",
        },
        executionStatus: "run_failed",
        finalStatus: null,
        errorCode: "PLANNER_FAILED",
        freshnessReferenceAt: null,
        plan: null,
        nodes: [],
        duplicateResources: [],
        metrics: null,
        metricFailure: {
          queryId: id,
          metric: "execution",
          stage: "pipeline",
          code: "PLANNER_FAILED",
        },
        telemetry: createTelemetry(index),
      };
    }),
  });
}

describe("WAY-91 Quality Eval 运行摘要", () => {
  it("按匿名分子/分母汇总三路、fallback、Top1 override 与 Top3 overlap", () => {
    const report = createReport();
    for (const [index, result] of report.results.entries()) {
      const mode = {
        nodeCount: 1,
        finalCandidateCount: 3,
        providerTop1OverrideCount: index % 2,
        heuristicTop1OverrideCount: 0,
        providerTop3FinalOverlapCount: 2,
        heuristicTop3FinalOverlapCount: 3,
        top3ComparisonSlots: 3,
      };
      const emptyMode = {
        nodeCount: 0,
        finalCandidateCount: 0,
        providerTop1OverrideCount: 0,
        heuristicTop1OverrideCount: 0,
        providerTop3FinalOverlapCount: 0,
        heuristicTop3FinalOverlapCount: 0,
        top3ComparisonSlots: 0,
      };
      result.telemetry!.ranking = {
        llmSuccess: index % 2 === 0 ? mode : emptyMode,
        fallback: index % 2 === 0 ? emptyMode : mode,
      };
    }

    expect(createQualityEvalOperatingSummary(report).ranking).toEqual({
      status: "partial",
      expectedQueryCount: 20,
      observedTelemetryQueryCount: 20,
      expectedRankedNodeCount: 0,
      observedRankedNodeCount: 20,
      incompleteQueryCount: 20,
      observedTotals: {
        observedNodeCount: 20,
        llmSuccessNodeCount: 10,
        fallbackNodeCount: 10,
        finalCandidateCount: 60,
      },
      rates: {
        llmSuccess: {
          providerTop1Override: {
            status: "measured",
            numerator: 0,
            denominator: 10,
            value: 0,
          },
          heuristicTop1Override: {
            status: "measured",
            numerator: 0,
            denominator: 10,
            value: 0,
          },
          providerTop3FinalOverlap: {
            status: "measured",
            numerator: 20,
            denominator: 30,
            value: 2 / 3,
          },
          heuristicTop3FinalOverlap: {
            status: "measured",
            numerator: 30,
            denominator: 30,
            value: 1,
          },
        },
        fallback: {
          providerTop1Override: {
            status: "measured",
            numerator: 10,
            denominator: 10,
            value: 1,
          },
          heuristicTop1Override: {
            status: "measured",
            numerator: 0,
            denominator: 10,
            value: 0,
          },
          providerTop3FinalOverlap: {
            status: "measured",
            numerator: 20,
            denominator: 30,
            value: 2 / 3,
          },
          heuristicTop3FinalOverlap: {
            status: "measured",
            numerator: 30,
            denominator: 30,
            value: 1,
          },
        },
      },
    });
  });

  it("按 Full 顺序生成 nearest-rank P50、最坏样本与完整成本代理", () => {
    const report = createReport();
    for (const [index, result] of report.results.entries()) {
      // 故意让耗时与 Query 顺序相反，确保 P50 来自排序后的样本而非数组中点。
      result.telemetry!.timingsMs.total = 20 - index;
    }
    const summary = createQualityEvalOperatingSummary(report);

    expect(summary).toMatchObject({
      schemaVersion: "quality-eval-operating-summary.v2",
      source: {
        gitCommit: SOURCE_COMMIT,
        datasetKind: "full",
      },
      quality: {
        execution: {
          completed: 0,
          runFailed: 20,
          cancelled: 0,
          unexpectedInternalError: 0,
        },
        finalStatus: { complete: 0, partial: 0, unavailable: 20 },
        deadlineCompliance: { within: 0, exceeded: 0, unavailable: 20 },
        humanReview: {
          status: "required",
          decision: "not_recorded",
          automaticAcceptance: false,
        },
      },
      latency: {
        status: "complete",
        metric: "totalRunMs",
        percentileMethod: "nearest_rank",
        sampleCount: 20,
        p50Ms: 10,
        representativeWorstCase: {
          queryId: "wfq-001",
          executionStatus: "run_failed",
          totalMs: 20,
        },
      },
      providerUsage: {
        status: "complete",
        observedQueryCount: 20,
        missingQueryIds: [],
        totals: {
          logicalSearchCalls: 210,
          logicalExtractCalls: 210,
          extractUrlCount: 210,
          logicalLlmCalls: 210,
          searchHttpAttempts: 210,
          extractHttpAttempts: 210,
        },
      },
      ranking: {
        status: "unavailable",
        reason: "noRankingEligibleNodes",
        expectedQueryCount: 20,
        observedTelemetryQueryCount: 20,
        expectedRankedNodeCount: 0,
        observedRankedNodeCount: 0,
        incompleteQueryCount: 0,
      },
      tokens: {
        status: "complete",
        coverage: {
          complete: 20,
          notUsed: 0,
          partial: 0,
          unavailable: 0,
          telemetryMissing: 0,
        },
        totals: {
          observations: 210,
          inputTokens: 210,
          outputTokens: 210,
          totalTokens: 210,
        },
      },
      cache: {
        status: "notMeasured",
        mode: "cold_disabled",
        hitRate: "notApplicable",
      },
      estimatedCost: {
        status: "unavailable",
        reason: "pricing_not_frozen",
      },
    });
  });

  it("把零调用和 not_used Token 保留为完整测量", () => {
    const report = createReport();
    for (const result of report.results) {
      const telemetry = createTelemetry(0);
      telemetry.timingsMs.planning = 0;
      telemetry.timingsMs.nodeProcessing = 0;
      telemetry.timingsMs.total = 0;
      result.telemetry = {
        ...telemetry,
        counts: {
          logicalSearchCalls: 0,
          logicalExtractCalls: 0,
          extractUrlCount: 0,
          logicalLlmCalls: 0,
          searchHttpAttempts: 0,
          extractHttpAttempts: 0,
        },
        tokens: { ...telemetry.tokens, status: "not_used" },
      };
      result.telemetry.tokens.observations = 0;
      result.telemetry.tokens.inputTokens = 0;
      result.telemetry.tokens.outputTokens = 0;
      result.telemetry.tokens.totalTokens = 0;
    }

    const summary = createQualityEvalOperatingSummary(report);

    expect(summary.latency).toMatchObject({
      status: "complete",
      p50Ms: 0,
      representativeWorstCase: { queryId: "wfq-001", totalMs: 0 },
    });
    expect(summary.providerUsage).toMatchObject({
      status: "complete",
      totals: {
        logicalSearchCalls: 0,
        logicalExtractCalls: 0,
        extractUrlCount: 0,
        logicalLlmCalls: 0,
        searchHttpAttempts: 0,
        extractHttpAttempts: 0,
      },
    });
    expect(summary.tokens).toEqual({
      status: "complete",
      coverage: {
        complete: 0,
        notUsed: 20,
        partial: 0,
        unavailable: 0,
        telemetryMissing: 0,
      },
      totals: {
        observations: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    });
  });

  it("遥测缺失时不从残缺样本生成 P50 或正式调用总计", () => {
    const report = createReport();
    report.results[4]!.telemetry = null;

    const summary = createQualityEvalOperatingSummary(report);

    expect(summary.latency).toEqual({
      status: "partial",
      expectedQueryCount: 20,
      observedQueryCount: 19,
      missingQueryIds: ["wfq-005"],
    });
    expect(summary.providerUsage).toMatchObject({
      status: "partial",
      observedQueryCount: 19,
      missingQueryIds: ["wfq-005"],
      observedTotals: { logicalSearchCalls: 205 },
    });
    expect(summary.providerUsage).not.toHaveProperty("totals");
    expect(summary.tokens).toMatchObject({
      status: "partial",
      coverage: { telemetryMissing: 1 },
      observedQueryCount: 19,
      observedTotals: { totalTokens: 205 },
    });
  });

  it("全部遥测缺失时明确标为 unavailable 且不生成观察总计", () => {
    const report = createReport();
    for (const result of report.results) result.telemetry = null;

    const summary = createQualityEvalOperatingSummary(report);

    expect(summary.latency).toMatchObject({
      status: "unavailable",
      observedQueryCount: 0,
    });
    expect(summary.providerUsage).toMatchObject({
      status: "unavailable",
      observedQueryCount: 0,
    });
    expect(summary.providerUsage).not.toHaveProperty("observedTotals");
    expect(summary.tokens).toMatchObject({
      status: "unavailable",
      coverage: { telemetryMissing: 20 },
    });
    expect(summary.tokens).not.toHaveProperty("observedTotals");
  });

  it("Token partial 与 unavailable 只生成带覆盖率的 observedTotals", () => {
    const report = createReport();
    report.results[3]!.telemetry!.tokens.status = "partial";
    report.results[3]!.telemetry!.tokens.observations = 3;
    report.results[4]!.telemetry!.tokens = {
      status: "unavailable",
      observations: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };

    const summary = createQualityEvalOperatingSummary(report);

    expect(summary.tokens).toMatchObject({
      status: "partial",
      coverage: {
        complete: 18,
        notUsed: 0,
        partial: 1,
        unavailable: 1,
        telemetryMissing: 0,
      },
      observedQueryCount: 19,
      observedTotals: { totalTokens: 205 },
    });
    expect(summary.tokens).not.toHaveProperty("totals");
  });

  it("全部 Token 不可用时不输出观察总计", () => {
    const report = createReport();
    for (const result of report.results) {
      result.telemetry!.tokens = {
        status: "unavailable",
        observations: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
    }

    const summary = createQualityEvalOperatingSummary(report);

    expect(summary.tokens).toMatchObject({
      status: "unavailable",
      coverage: { unavailable: 20 },
    });
    expect(summary.tokens).not.toHaveProperty("observedTotals");
  });

  it.each([
    { status: "not_used", logicalLlmCalls: 1, observations: 1 },
    { status: "complete", logicalLlmCalls: 0, observations: 0 },
    { status: "partial", logicalLlmCalls: 1, observations: 1 },
    { status: "unavailable", logicalLlmCalls: 1, observations: 1 },
  ] as const)("拒绝矛盾的 $status Token 覆盖", testCase => {
    const report = createReport();
    const telemetry = report.results[0]!.telemetry!;
    telemetry.counts.logicalLlmCalls = testCase.logicalLlmCalls;
    telemetry.tokens.status = testCase.status;
    telemetry.tokens.observations = testCase.observations;
    if (testCase.status === "unavailable") {
      telemetry.tokens.inputTokens = 0;
      telemetry.tokens.outputTokens = 0;
      telemetry.tokens.totalTokens = 0;
    }

    expect(() => createQualityEvalOperatingSummary(report)).toThrow(
      "Token 状态与 LLM 调用或 Usage 覆盖不一致",
    );
  });

  it("把显式 Run Deadline 失败计为 exceeded 而非 unavailable", () => {
    const report = createReport();
    const result = report.results[0]!;
    result.errorCode = "RUN_DEADLINE_EXCEEDED";
    result.metricFailure = {
      queryId: "wfq-001",
      metric: "deadlineCompliance",
      stage: "runDeadline",
      code: "RUN_DEADLINE_EXCEEDED",
    };

    const summary = createQualityEvalOperatingSummary(report);

    expect(summary.quality.deadlineCompliance).toEqual({
      within: 0,
      exceeded: 1,
      unavailable: 19,
    });
  });

  it("最坏延迟并列时稳定选择数据集顺序靠前的 Query", () => {
    const report = createReport();
    report.results[18]!.telemetry!.timingsMs.total = 20;

    const summary = createQualityEvalOperatingSummary(report);

    expect(summary.latency).toMatchObject({
      status: "complete",
      representativeWorstCase: { queryId: "wfq-019", totalMs: 20 },
    });
  });

  it("拒绝 Full 数量、顺序或 comparisonKey 漂移", () => {
    const missing = createReport();
    missing.results.pop();
    expect(() => createQualityEvalOperatingSummary(missing)).toThrow(
      "完整 Full 报告",
    );

    const wrongOrder = createReport();
    wrongOrder.results.reverse();
    expect(() => createQualityEvalOperatingSummary(wrongOrder)).toThrow(
      "完整 Full 报告",
    );

    const wrongKey = createReport();
    wrongKey.results[0]!.comparisonKey = "wayfinder-regression.v1:wfq-020";
    expect(() => createQualityEvalOperatingSummary(wrongKey)).toThrow(
      "完整 Full 报告",
    );
  });

  it("拒绝 Provider 调用或 Token 累加溢出安全整数", () => {
    const providerReport = createReport();
    providerReport.results[0]!.telemetry!.counts.logicalSearchCalls =
      Number.MAX_SAFE_INTEGER;
    expect(() =>
      summarizeQualityEvalProviderUsage(providerReport.results),
    ).toThrow("安全整数范围");

    const tokenReport = createReport();
    tokenReport.results[0]!.telemetry!.tokens.totalTokens =
      Number.MAX_SAFE_INTEGER;
    expect(() => createQualityEvalOperatingSummary(tokenReport)).toThrow(
      "安全整数范围",
    );
  });
});
