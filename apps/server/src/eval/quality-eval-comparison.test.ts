/**
 * 测试职责：冻结 WAY-90/110 A-B-B-A 报告的完整度、调用、重复诊断与可比性门禁。
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

function createTelemetry(value: number, ranked = false) {
  const emptyMode = {
    nodeCount: 0,
    finalCandidateCount: 0,
    providerTop1OverrideCount: 0,
    heuristicTop1OverrideCount: 0,
    providerTop3FinalOverlapCount: 0,
    heuristicTop3FinalOverlapCount: 0,
    top3ComparisonSlots: 0,
  } as const;
  return {
    timingsMs: {
      planning: 0,
      nodeProcessing: 0,
      total: 0,
      provider: { search: 0, extract: 0, llm: 0 },
    },
    counts: {
      logicalSearchCalls: value,
      logicalExtractCalls: 0,
      extractUrlCount: 0,
      logicalLlmCalls: 1,
      searchHttpAttempts: value,
      extractHttpAttempts: 0,
    },
    versions: { rankFusion: "rank-fusion.v1" },
    ranking: {
      llmSuccess: ranked
        ? {
            nodeCount: 1,
            finalCandidateCount: 1,
            providerTop1OverrideCount: 0,
            heuristicTop1OverrideCount: 0,
            providerTop3FinalOverlapCount: 1,
            heuristicTop3FinalOverlapCount: 1,
            top3ComparisonSlots: 1,
          }
        : emptyMode,
      fallback: emptyMode,
    },
    tokens: {
      status: "complete",
      observations: 1,
      inputTokens: value,
      outputTokens: value,
      totalTokens: value * 2,
    },
    estimatedCost: { status: "unavailable", reason: "pricing_not_frozen" },
  } as const;
}

function createReport(
  commit: string,
  runIndex: number,
  includeRankedResult = true,
) {
  return QualityEvalReportSchema.parse({
    schemaVersion: "quality-eval.v9",
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
      runDeadlineMs: 40_000,
      language: "zh-CN",
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
      if (includeRankedResult && index === 0) {
        const plan = {
          analysis: {
            intent: "learn",
            topic: "Query 1",
            freshnessSensitive: false,
            ambiguityLevel: "low",
            broadSearchQueries: [],
            strategy: "plan_first",
            presentationMode: "compact",
          },
          nodes: [
            {
              id: "node-1",
              title: "测试节点",
              description: "冻结比较 Fixture 的最终可见节点。",
              nodeType: "primary",
              layer: 0,
              status: "planned",
              searchPlan: {
                queries: ["Query 1"],
                maxResults: 20,
                rankingProfile: "knowledge",
                providerHints: ["general"],
              },
            },
          ],
          edges: [],
        } as const;
        return {
          schemaVersion: "quality-eval.v7",
          comparisonKey: `wayfinder-regression.v1:${id}`,
          query: {
            id,
            query: "Query 1",
            category: "knowledge",
            rationale: "固定比较 Fixture。",
          },
          executionStatus: "completed",
          finalStatus: "complete",
          errorCode: null,
          freshnessReferenceAt: "2026-10-23T00:00:00.000Z",
          plan,
          nodes: [
            {
              id: "node-1",
              status: "ready",
              warnings: [],
              errorCode: null,
              resourceCount: 1,
              topResources: [
                {
                  id: "resource_1",
                  title: "测试资源",
                  url: "https://example.com/",
                  canonicalUrl: "https://example.com/",
                  domain: "example.com",
                  sourceType: "web",
                  summary: "测试摘要。",
                  whySelected: "用于冻结匿名比较覆盖率。",
                  rank: 1,
                  searchProvider: "serpapi_bing",
                  publishedAt: null,
                },
              ],
              officialSource: { status: "notApplicable" },
              diversity: { distinctExactDomainCount: 1 },
              freshness: { status: "notApplicable" },
            },
          ],
          duplicateResources: [],
          metrics: {
            version: "quality-metrics.v3",
            schemaValidity: "valid",
            nodeCount: 1,
            resourceCount: 1,
            plannedRequestDuplication: {
              totalCount: 1,
              uniqueCount: 1,
              intraNodeDuplicateOccurrenceCount: 0,
              crossNodeSharedGroupCount: 0,
              crossNodeExtraNodeOccurrenceCount: 0,
            },
            duplicateRate: {
              status: "measured",
              duplicateOccurrences: 0,
              totalOccurrences: 1,
              value: 0,
            },
            officialSource: { status: "notApplicable" },
            deadlineCompliance: { status: "within" },
          },
          metricFailure: null,
          telemetry: createTelemetry(index, true),
        };
      }
      const query = `Query ${index + 1}`;
      return {
        schemaVersion: "quality-eval.v7",
        comparisonKey: `wayfinder-regression.v1:${id}`,
        query: {
          id,
          query,
          category: "knowledge",
          rationale: "固定比较 Fixture。",
        },
        executionStatus: "completed",
        finalStatus: "partial",
        errorCode: null,
        freshnessReferenceAt: "2026-10-23T00:00:00.000Z",
        plan: {
          analysis: {
            intent: "learn",
            topic: query,
            freshnessSensitive: false,
            ambiguityLevel: "low",
            broadSearchQueries: [],
            strategy: "plan_first",
            presentationMode: "compact",
          },
          nodes: [
            {
              id: `node-${index + 1}`,
              title: "测试节点",
              description: "冻结比较 Fixture 的无资源节点。",
              nodeType: "primary",
              layer: 0,
              status: "planned",
              searchPlan: {
                queries: [query],
                maxResults: 20,
                rankingProfile: "knowledge",
                providerHints: ["general"],
              },
            },
          ],
          edges: [],
        },
        nodes: [
          {
            id: `node-${index + 1}`,
            status: "failed",
            warnings: [],
            errorCode: "SEARCH_PROVIDER_FAILED",
            resourceCount: 0,
            topResources: [],
            officialSource: { status: "notApplicable" },
            diversity: { distinctExactDomainCount: 0 },
            freshness: { status: "notApplicable" },
          },
        ],
        duplicateResources: [],
        metrics: {
          version: "quality-metrics.v3",
          schemaValidity: "valid",
          nodeCount: 1,
          resourceCount: 0,
          plannedRequestDuplication: {
            totalCount: 1,
            uniqueCount: 1,
            intraNodeDuplicateOccurrenceCount: 0,
            crossNodeSharedGroupCount: 0,
            crossNodeExtraNodeOccurrenceCount: 0,
          },
          duplicateRate: { status: "unavailable", reason: "noResources" },
          officialSource: { status: "notApplicable" },
          deadlineCompliance: { status: "within" },
        },
        metricFailure: null,
        // 零 Provider 调用仍是完整测量，不能误判为 unavailable。
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

function createLegacyReport(commit: string, runIndex: number): unknown {
  const legacy = structuredClone(createReport(commit, runIndex)) as Record<
    string,
    unknown
  >;
  legacy.schemaVersion = "quality-eval.v5";
  (legacy.runPolicy as Record<string, unknown>).language = "und";
  const source = legacy.source as Record<string, unknown>;
  delete source.ranking;
  for (const result of legacy.results as Record<string, unknown>[]) {
    result.schemaVersion = "quality-eval.v4";
    const metrics = result.metrics;
    if (metrics !== null) {
      const legacyMetrics = metrics as Record<string, unknown>;
      legacyMetrics.version = "quality-metrics.v1";
      delete legacyMetrics.plannedRequestDuplication;
    }
    const telemetry = result.telemetry;
    if (telemetry !== null) {
      delete (telemetry as Record<string, unknown>).versions;
      delete (telemetry as Record<string, unknown>).ranking;
    }
  }
  return legacy;
}

/** 外层 v6/query v5 保留 Ranking 遥测，仅缺少 WAY-110 计划请求诊断。 */
function createV6LegacyReport(commit: string, runIndex: number): unknown {
  const legacy = structuredClone(createReport(commit, runIndex)) as Record<
    string,
    unknown
  >;
  legacy.schemaVersion = "quality-eval.v6";
  (legacy.runPolicy as Record<string, unknown>).language = "und";
  for (const result of legacy.results as Record<string, unknown>[]) {
    result.schemaVersion = "quality-eval.v5";
    const metrics = result.metrics as Record<string, unknown>;
    metrics.version = "quality-metrics.v1";
    delete metrics.plannedRequestDuplication;
  }
  return legacy;
}

/** 外层 v7/query v6 代表旧 20 秒真实运行策略，不能伪装成当前 40 秒证据。 */
function createV7LegacyReport(commit: string, runIndex: number): unknown {
  const legacy = structuredClone(createReport(commit, runIndex)) as Record<
    string,
    unknown
  >;
  legacy.schemaVersion = "quality-eval.v7";
  const runPolicy = legacy.runPolicy as Record<string, unknown>;
  runPolicy.runDeadlineMs = 20_000;
  runPolicy.language = "und";
  for (const result of legacy.results as Record<string, unknown>[]) {
    result.schemaVersion = "quality-eval.v6";
    const metrics = result.metrics;
    if (metrics !== null) {
      (metrics as Record<string, unknown>).version = "quality-metrics.v2";
    }
  }
  return legacy;
}

/** outer v8/query v6/metrics v2 是 40 秒但仍使用 und 的最后历史组合。 */
function createV8LegacyReport(
  commit: string,
  runIndex: number,
  failureIndex?: number,
): unknown {
  const current = createReport(commit, runIndex);
  if (failureIndex !== undefined) replaceWithUnmeasuredFailure(current, failureIndex);
  const legacy = structuredClone(current) as Record<
    string,
    unknown
  >;
  legacy.schemaVersion = "quality-eval.v8";
  (legacy.runPolicy as Record<string, unknown>).language = "und";
  for (const result of legacy.results as Record<string, unknown>[]) {
    result.schemaVersion = "quality-eval.v6";
    const metrics = result.metrics;
    if (metrics !== null) {
      (metrics as Record<string, unknown>).version = "quality-metrics.v2";
    }
  }
  return legacy;
}

/** 用真实的未完成语义制造覆盖缺口，禁止在 completed 结果上伪造 null。 */
function replaceWithUnmeasuredFailure(
  report: ReturnType<typeof createReport>,
  index: number,
): void {
  const current = report.results[index]!;
  report.results[index] = {
    schemaVersion: "quality-eval.v7",
    comparisonKey: current.comparisonKey,
    query: current.query,
    executionStatus: "run_failed",
    finalStatus: null,
    errorCode: "PLANNER_FAILED",
    freshnessReferenceAt: null,
    plan: null,
    nodes: [],
    duplicateResources: [],
    metrics: null,
    metricFailure: {
      queryId: current.query.id,
      metric: "execution",
      stage: "pipeline",
      code: "PLANNER_FAILED",
    },
    telemetry: null,
  };
}

describe("WAY-90 Quality Eval A-B-B-A 比较", () => {
  it("拒绝把历史 und 基线与当前 zh-CN 条件混合比较", () => {
    expect(() =>
      compareQualityEvalBlocks({
        baselineCommit: BASELINE_COMMIT,
        candidateCommit: CANDIDATE_COMMIT,
        blocks: BLOCKS.map((block, index) => ({
          block,
          report: block.startsWith("A")
            ? createLegacyReport(BASELINE_COMMIT, index + 1)
            : createReport(CANDIDATE_COMMIT, index + 1),
        })),
      }),
    ).toThrow("数据集或运行条件不一致");
  });

  it("显式归一化 outer v6/query v5 计划请求诊断，且不修改旧报告", () => {
    const legacy = createV6LegacyReport(BASELINE_COMMIT, 1);
    const snapshot = structuredClone(legacy);
    // 当前外层 Schema 严格拒绝 v6；只有比较器的显式 legacy 路径可以归一化。
    expect(QualityEvalReportSchema.safeParse(legacy).success).toBe(false);
    expect(() =>
      compareQualityEvalBlocks({
        baselineCommit: BASELINE_COMMIT,
        candidateCommit: CANDIDATE_COMMIT,
        blocks: BLOCKS.map((block, index) => ({
          block,
          report:
            block === "A1"
              ? legacy
              : createReport(
                  block.startsWith("A") ? BASELINE_COMMIT : CANDIDATE_COMMIT,
                  index + 1,
                ),
        })),
      }),
    ).toThrow("数据集或运行条件不一致");
    expect(legacy).toEqual(snapshot);
  });

  it("显式且不可变地迁移整组 outer v8/query v6/metrics v2 报告", () => {
    const reports = BLOCKS.map((block, index) =>
      createV8LegacyReport(
        block.startsWith("A") ? BASELINE_COMMIT : CANDIDATE_COMMIT,
        index + 1,
      ),
    );
    const snapshots = structuredClone(reports);
    expect(
      reports.every(report => !QualityEvalReportSchema.safeParse(report).success),
    ).toBe(true);

    const compared = compareQualityEvalBlocks({
      baselineCommit: BASELINE_COMMIT,
      candidateCommit: CANDIDATE_COMMIT,
      blocks: BLOCKS.map((block, index) => ({ block, report: reports[index] })),
    });

    expect(compared.status).toBe("comparable");
    expect(reports).toEqual(snapshots);
  });

  it("迁移时保留旧 v8 失败 Query 的 null metrics", () => {
    const reports = BLOCKS.map((block, index) =>
      createV8LegacyReport(
        block.startsWith("A") ? BASELINE_COMMIT : CANDIDATE_COMMIT,
        index + 1,
        block === "A1" ? 0 : undefined,
      ),
    );
    const snapshots = structuredClone(reports);

    const compared = compareQualityEvalBlocks({
      baselineCommit: BASELINE_COMMIT,
      candidateCommit: CANDIDATE_COMMIT,
      blocks: BLOCKS.map((block, index) => ({ block, report: reports[index] })),
    });

    expect(compared.status).toBe("inconclusive");
    expect(reports).toEqual(snapshots);
  });

  it("拒绝历史上不可能的 v8/v6/v2 + zh-CN 组合", () => {
    const forged = createV8LegacyReport(BASELINE_COMMIT, 1) as Record<
      string,
      unknown
    >;
    (forged.runPolicy as Record<string, unknown>).language = "zh-CN";

    expect(() =>
      compareQualityEvalBlocks({
        baselineCommit: BASELINE_COMMIT,
        candidateCommit: CANDIDATE_COMMIT,
        blocks: BLOCKS.map((block, index) => ({
          block,
          report:
            block === "A1"
              ? forged
              : createReport(
                  block.startsWith("A") ? BASELINE_COMMIT : CANDIDATE_COMMIT,
                  index + 1,
                ),
        })),
      }),
    ).toThrow("Quality Eval A1 报告不符合严格 Schema");
  });

  it("拒绝把 outer v7 的 20 秒运行策略伪装为当前 40 秒证据", () => {
    const legacy = createV7LegacyReport(BASELINE_COMMIT, 1);
    expect(QualityEvalReportSchema.safeParse(legacy).success).toBe(false);

    expect(() =>
      compareQualityEvalBlocks({
        baselineCommit: BASELINE_COMMIT,
        candidateCommit: CANDIDATE_COMMIT,
        blocks: BLOCKS.map((block, index) => ({
          block,
          report:
            block === "A1"
              ? legacy
              : createReport(
                  block.startsWith("A")
                    ? BASELINE_COMMIT
                    : CANDIDATE_COMMIT,
                  index + 1,
                ),
        })),
      }),
    ).toThrow("Quality Eval A1 报告不符合严格 Schema");
  });

  it("20 条都有遥测但没有最终可见 Node 时仍判为 inconclusive", () => {
    const input = createInput();
    input.blocks[1]!.report = createReport(CANDIDATE_COMMIT, 2, false);

    const compared = compareQualityEvalBlocks(input);

    expect(compared.status).toBe("inconclusive");
    expect(compared.blocks[1]).toMatchObject({
      block: "B1",
      status: "partial",
      ranking: {
        status: "unavailable",
        reason: "noRankingEligibleNodes",
        observedTelemetryQueryCount: 20,
      },
    });
  });

  it("最终可见 Node 与 Ranking 观测数不一致时拒绝 comparable", () => {
    const input = createInput();
    input.blocks[1]!.report.results[0]!.telemetry!.ranking =
      createTelemetry(0).ranking;

    const compared = compareQualityEvalBlocks(input);

    expect(compared.status).toBe("inconclusive");
    expect(compared.blocks[1]).toMatchObject({
      block: "B1",
      status: "partial",
      ranking: {
        status: "partial",
        expectedRankedNodeCount: 1,
        observedRankedNodeCount: 0,
        incompleteQueryCount: 1,
      },
    });
  });

  it("Search-only Block 出现任一 Extract 事实时使用固定错误拒绝", () => {
    const input = createInput();
    input.blocks[1]!.report.results[2]!.telemetry!.counts.logicalExtractCalls = 1;

    expect(() => compareQualityEvalBlocks(input)).toThrow(
      "Search-only Block 出现 Extract 调用或耗时",
    );
  });

  it("完整汇总四个 Block，并保持计划请求与实际调用独立", () => {
    const compared = compareQualityEvalBlocks(createInput());

    expect(compared.status).toBe("comparable");
    expect(compared.blocks).toHaveLength(4);
    expect(JSON.stringify(compared).toLowerCase()).not.toMatch(
      /keep|revert/u,
    );
    expect(compared.blocks[0]).toMatchObject({
      block: "A1",
      condition: "A",
      evaluationRunId:
        "2026-10-23T00-00-01-000Z-00000001-0000-4000-8000-000000000001",
      sourceCommit: BASELINE_COMMIT,
      status: "complete",
      latency: { status: "complete", p50Ms: 0, sampleCount: 20 },
      providerUsage: {
        status: "complete",
        expectedQueryCount: 20,
        observedQueryCount: 20,
        totals: {
          logicalSearchCalls: 190,
          logicalExtractCalls: 0,
          extractUrlCount: 0,
          logicalLlmCalls: 20,
          searchHttpAttempts: 190,
          extractHttpAttempts: 0,
        },
      },
      duplication: {
        status: "complete",
        expectedQueryCount: 20,
        observedQueryCount: 20,
        totals: {
          plannedRequests: {
            totalCount: 20,
            uniqueCount: 20,
            intraNodeDuplicateOccurrenceCount: 0,
            crossNodeSharedGroupCount: 0,
            crossNodeExtraNodeOccurrenceCount: 0,
          },
          resources: {
            measuredQueryCount: 1,
            noResourceQueryCount: 19,
            duplicateOccurrences: 0,
            totalOccurrences: 1,
          },
        },
      },
      ranking: {
        status: "complete",
        expectedQueryCount: 20,
        observedTelemetryQueryCount: 20,
        expectedRankedNodeCount: 1,
        observedRankedNodeCount: 1,
        incompleteQueryCount: 0,
        totals: {
          observedNodeCount: 1,
          llmSuccessNodeCount: 1,
          fallbackNodeCount: 0,
          finalCandidateCount: 1,
        },
        rates: {
          llmSuccess: {
            providerTop1Override: {
              status: "measured",
              numerator: 0,
              denominator: 1,
              value: 0,
            },
            providerTop3FinalOverlap: {
              status: "measured",
              numerator: 1,
              denominator: 1,
              value: 1,
            },
          },
        },
      },
      tokens: {
        status: "complete",
        totals: { observations: 20, totalTokens: 380 },
      },
      cache: { status: "notMeasured", mode: "cold_disabled" },
      estimatedCost: {
        status: "unavailable",
        reason: "pricing_not_frozen",
      },
    });
  });

  it("单条缺失只输出 observedTotals，并使四 Block 比较为 inconclusive", () => {
    const input = createInput();
    replaceWithUnmeasuredFailure(input.blocks[1]!.report, 4);

    const compared = compareQualityEvalBlocks(input);

    expect(compared).toMatchObject({
      status: "inconclusive",
      reason: "telemetry_incomplete",
    });
    expect(compared.blocks[1]).toMatchObject({
      block: "B1",
      status: "partial",
      providerUsage: {
        status: "partial",
        observedQueryCount: 19,
        missingQueryIds: ["wfq-005"],
        observedTotals: { logicalSearchCalls: 186 },
      },
      duplication: {
        status: "partial",
        observedQueryCount: 19,
        missingQueryIds: ["wfq-005"],
      },
    });
    expect(compared.blocks[1]?.providerUsage).not.toHaveProperty("totals");
  });

  it("全部缺失时明确标为 unavailable，不生成任何总计", () => {
    const input = createInput();
    input.blocks[2]!.report = createReport(CANDIDATE_COMMIT, 3, false);
    for (let index = 0; index < input.blocks[2]!.report.results.length; index += 1) {
      replaceWithUnmeasuredFailure(input.blocks[2]!.report, index);
    }

    const compared = compareQualityEvalBlocks(input);

    expect(compared.blocks[2]).toMatchObject({
      block: "B2",
      status: "unavailable",
      providerUsage: {
        status: "unavailable",
        observedQueryCount: 0,
        missingQueryIds: Array.from({ length: 20 }, (_, index) =>
          `wfq-${String(index + 1).padStart(3, "0")}`,
        ),
      },
      duplication: {
        status: "unavailable",
        observedQueryCount: 0,
      },
      ranking: {
        status: "unavailable",
        reason: "noRankingEligibleNodes",
      },
    });
    expect(compared.blocks[2]?.providerUsage).not.toHaveProperty("totals");
    expect(compared.blocks[2]?.providerUsage).not.toHaveProperty(
      "observedTotals",
    );
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
    const telemetry = createTelemetry(0, true);
    input.blocks[0]!.report.results[0]!.telemetry = {
      ...telemetry,
      counts: {
        ...telemetry.counts,
        logicalSearchCalls: Number.MAX_SAFE_INTEGER,
      },
    };
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
