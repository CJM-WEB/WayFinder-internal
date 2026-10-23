/**
 * 测试职责：冻结 WAY-90 A-B-B-A 报告的完整度、六项调用总计与可比性门禁。
 *
 * 边界说明：Fixture 只使用脱敏失败结果；测试不访问网络、不自动判定产品质量，
 * 也不允许用部分遥测冒充完整总计。
 */
import { describe, expect, it } from "vitest";

import { QualityEvalReportSchema } from "./run-quality-eval.js";
import { compareQualityEvalBlocks } from "./quality-eval-comparison.js";

const BASELINE_COMMIT = "a".repeat(40);
const CANDIDATE_COMMIT = "b".repeat(40);
const BLOCKS = ["A1", "B1", "B2", "A2"] as const;

function createTelemetry(value: number) {
  return {
    timingsMs: {
      planning: 0,
      nodeProcessing: 0,
      total: 0,
      provider: { search: 0, extract: 0, llm: 0 },
    },
    counts: {
      logicalSearchCalls: value,
      logicalExtractCalls: value,
      extractUrlCount: value,
      logicalLlmCalls: value,
      searchHttpAttempts: value,
      extractHttpAttempts: value,
    },
    tokens: {
      status: "complete",
      observations: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    estimatedCost: { status: "unavailable", reason: "pricing_not_frozen" },
  } as const;
}

function createReport(commit: string, runIndex: number) {
  return QualityEvalReportSchema.parse({
    schemaVersion: "quality-eval.v4",
    issue: "WAY-86",
    evaluationRunId: `2026-10-23T00-00-0${runIndex}-000Z-0000000${runIndex}-0000-4000-8000-00000000000${runIndex}`,
    completedAt: `2026-10-23T00:00:0${runIndex}.000Z`,
    dataset: {
      kind: "full",
      version: "wayfinder-regression.v1",
      queryCount: 20,
      queryFiles: ["tests/eval-queries.json", "tests/eval-full-queries.json"],
      fingerprint: "c".repeat(64),
    },
    source: {
      git: { commit, worktreeClean: true },
      contracts: { protocol: "0.1", resultGraph: "0.1" },
      prompts: {
        planner: "graph-planner.v1",
        reviser: "graph-reviser.v1",
        reranker: "resource-reranker.v1",
      },
      providers: {
        search: "tavily",
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
        extract: 3_700,
        planner: 10_000,
        rerank: 10_000,
      },
      concurrency: { search: 6, extract: 3, llm: 3 },
    },
    artifactPolicy: {
      localOnly: true,
      automaticUpload: false,
      automaticDeletion: false,
      retention: "until_human_review_and_controlled_sync_decision",
    },
    results: Array.from({ length: 20 }, (_, index) => {
      const id = `wfq-${String(index + 1).padStart(3, "0")}`;
      const deadlineFailure = index === 0;
      return {
        schemaVersion: "quality-eval.v4",
        comparisonKey: `wayfinder-regression.v1:${id}`,
        query: {
          id,
          query: `Query ${index + 1}`,
          category: "knowledge",
          rationale: "固定比较 Fixture。",
        },
        executionStatus: "run_failed",
        finalStatus: null,
        errorCode: deadlineFailure
          ? "RUN_DEADLINE_EXCEEDED"
          : "PLANNER_FAILED",
        freshnessReferenceAt: null,
        plan: null,
        nodes: [],
        duplicateResources: [],
        metrics: null,
        metricFailure: {
          queryId: id,
          metric: deadlineFailure ? "deadlineCompliance" : "execution",
          stage: deadlineFailure ? "runDeadline" : "pipeline",
          code: deadlineFailure
            ? "RUN_DEADLINE_EXCEEDED"
            : "PLANNER_FAILED",
        },
        // 第一条失败 Query 的零调用仍是完整测量，不能误判为 unavailable。
        telemetry: createTelemetry(index),
      };
    }),
  });
}

type TestInput = {
  baselineCommit: string;
  candidateCommit: string;
  blocks: {
    block: (typeof BLOCKS)[number];
    report: ReturnType<typeof createReport>;
  }[];
};

function createInput(): TestInput {
  return {
    baselineCommit: BASELINE_COMMIT,
    candidateCommit: CANDIDATE_COMMIT,
    blocks: BLOCKS.map((block, index) => ({
      block,
      report: createReport(
        block.startsWith("A") ? BASELINE_COMMIT : CANDIDATE_COMMIT,
        index + 1,
      ),
    })),
  };
}

describe("WAY-90 Quality Eval A-B-B-A 比较", () => {
  it("完整汇总四个 Block，并把失败 Query 的零调用视为有效测量", () => {
    const compared = compareQualityEvalBlocks(createInput());

    expect(compared.status).toBe("comparable");
    expect(compared.blocks).toHaveLength(4);
    expect(JSON.stringify(compared).toLowerCase()).not.toMatch(
      /keep|revert/u,
    );
    expect(compared.blocks[0]).toEqual({
      block: "A1",
      condition: "A",
      evaluationRunId:
        "2026-10-23T00-00-01-000Z-00000001-0000-4000-8000-000000000001",
      sourceCommit: BASELINE_COMMIT,
      expectedQueryCount: 20,
      observedTelemetryCount: 20,
      missingQueryIds: [],
      status: "complete",
      totals: {
        logicalSearchCalls: 190,
        logicalExtractCalls: 190,
        extractUrlCount: 190,
        logicalLlmCalls: 190,
        searchHttpAttempts: 190,
        extractHttpAttempts: 190,
      },
    });
  });

  it("单条缺失只输出 observedTotals，并使四 Block 比较为 inconclusive", () => {
    const input = createInput();
    input.blocks[1]!.report.results[4]!.telemetry = null;

    const compared = compareQualityEvalBlocks(input);

    expect(compared).toMatchObject({
      status: "inconclusive",
      reason: "telemetry_incomplete",
    });
    expect(compared.blocks[1]).toMatchObject({
      block: "B1",
      status: "partial",
      observedTelemetryCount: 19,
      missingQueryIds: ["wfq-005"],
      observedTotals: { logicalSearchCalls: 186 },
    });
    expect(compared.blocks[1]).not.toHaveProperty("totals");
  });

  it("全部缺失时明确标为 unavailable，不生成任何总计", () => {
    const input = createInput();
    for (const result of input.blocks[2]!.report.results) {
      result.telemetry = null;
    }

    const compared = compareQualityEvalBlocks(input);

    expect(compared.blocks[2]).toMatchObject({
      block: "B2",
      status: "unavailable",
      observedTelemetryCount: 0,
      missingQueryIds: Array.from({ length: 20 }, (_, index) =>
        `wfq-${String(index + 1).padStart(3, "0")}`,
      ),
    });
    expect(compared.blocks[2]).not.toHaveProperty("totals");
    expect(compared.blocks[2]).not.toHaveProperty("observedTotals");
  });

  it.each([
    {
      name: "重复 Query",
      mutate: (input: ReturnType<typeof createInput>) => {
        input.blocks[0]!.report.results[1] =
          input.blocks[0]!.report.results[0]!;
      },
    },
    {
      name: "缺少 Query",
      mutate: (input: ReturnType<typeof createInput>) => {
        input.blocks[0]!.report.results.pop();
      },
    },
    {
      name: "Query 顺序变化",
      mutate: (input: ReturnType<typeof createInput>) => {
        input.blocks[0]!.report.results.reverse();
      },
    },
    {
      name: "错误 Comparison Key",
      mutate: (input: ReturnType<typeof createInput>) => {
        for (const block of input.blocks) {
          block.report.results[0]!.comparisonKey =
            "wayfinder-regression.v1:wfq-020";
        }
      },
    },
  ])("拒绝$name", ({ mutate }) => {
    const input = createInput();
    mutate(input);
    expect(() => compareQualityEvalBlocks(input)).toThrow("完整 Full 报告");
  });

  it.each([
    {
      name: "Dataset 指纹漂移",
      mutate: (input: ReturnType<typeof createInput>) => {
        input.blocks[1]!.report.dataset.fingerprint = "d".repeat(64);
      },
    },
    {
      name: "Run Policy 漂移",
      mutate: (input: ReturnType<typeof createInput>) => {
        input.blocks[1]!.report.runPolicy.timeoutsMs.search = 2_600;
      },
    },
  ])("拒绝$name", ({ mutate }) => {
    const input = createInput();
    mutate(input);
    expect(() => compareQualityEvalBlocks(input)).toThrow("运行条件不一致");
  });

  it.each([
    {
      name: "Block 次序错误",
      mutate: (input: ReturnType<typeof createInput>) => {
        input.blocks.reverse();
      },
      error: "A1-B1-B2-A2",
    },
    {
      name: "Block 数量不足",
      mutate: (input: ReturnType<typeof createInput>) => {
        input.blocks.pop();
      },
      error: "A1-B1-B2-A2",
    },
    {
      name: "重复 Run ID",
      mutate: (input: ReturnType<typeof createInput>) => {
        input.blocks[1]!.report.evaluationRunId =
          input.blocks[0]!.report.evaluationRunId;
      },
      error: "四次独立运行",
    },
    {
      name: "Commit 角色错误",
      mutate: (input: ReturnType<typeof createInput>) => {
        input.blocks[0]!.report.source.git.commit = CANDIDATE_COMMIT;
      },
      error: "预登记 Commit",
    },
    {
      name: "预登记 Commit 非法",
      mutate: (input: ReturnType<typeof createInput>) => {
        input.baselineCommit = "invalid";
      },
      error: "Commit 预登记值无效",
    },
    {
      name: "A/B 使用相同 Commit",
      mutate: (input: ReturnType<typeof createInput>) => {
        input.candidateCommit = BASELINE_COMMIT;
      },
      error: "Commit 预登记值无效",
    },
  ])("拒绝$name", ({ mutate, error }) => {
    const input = createInput();
    mutate(input);
    expect(() => compareQualityEvalBlocks(input)).toThrow(error);
  });

  it.each([
    {
      name: "相同完成时间",
      mutate: (input: ReturnType<typeof createInput>) => {
        input.blocks[1]!.report.completedAt =
          input.blocks[0]!.report.completedAt;
      },
    },
    {
      name: "逆序完成时间",
      mutate: (input: ReturnType<typeof createInput>) => {
        input.blocks[1]!.report.completedAt =
          "2026-10-22T23:59:59.000Z";
      },
    },
  ])("拒绝$name", ({ mutate }) => {
    const input = createInput();
    mutate(input);
    expect(() => compareQualityEvalBlocks(input)).toThrow(
      "完成时间必须严格递增",
    );
  });

  it("拒绝会让聚合结果失真的安全整数溢出", () => {
    const input = createInput();
    input.blocks[0]!.report.results[0]!.telemetry =
      createTelemetry(Number.MAX_SAFE_INTEGER);
    input.blocks[0]!.report.results[1]!.telemetry = createTelemetry(1);

    expect(() => compareQualityEvalBlocks(input)).toThrow("安全整数范围");
  });

  it("重新扫描结构合法报告，并且不回显凭据形态原值", () => {
    const input = createInput();
    const sensitiveValue = "password: comparison-secret-value";
    input.blocks[0]!.report.results[0]!.query.query = sensitiveValue;

    let message = "";
    try {
      compareQualityEvalBlocks(input);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Quality Eval A1 报告不符合严格 Schema");
    expect(message).not.toContain(sensitiveValue);
  });
});
