/**
 * 测试职责：冻结 WAY-87/110 自动质量指标的确定性公式、完整 ResultGraph 口径与脱敏失败定位。
 *
 * 边界说明：这些测试不设置质量阈值或综合分；只验证事实计算，且不重复测试 Runner、
 * Provider 或文件系统安全边界。
 */
import {
  GraphPlanSchema,
  ResultGraphSchema,
  type ResultGraph,
} from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import {
  QUALITY_EVAL_PLANNED_REQUEST_CONFIG,
  QUALITY_METRICS_VERSION,
  QualityEvalMetricsSchema,
  QualityEvalPlannedRequestDuplicationSchema,
  QualityEvalTelemetrySchema,
  measureQualityEvalPlannedRequestDuplication,
  measureQualityEvalMetrics,
} from "./quality-metrics.js";

const QUERY_ID = "wfq-009";
const RUN_DEADLINE_MS = 20_000;

const plan = GraphPlanSchema.parse({
  analysis: {
    intent: "navigate",
    topic: "VS Code download",
    freshnessSensitive: false,
    ambiguityLevel: "low",
    broadSearchQueries: [],
    strategy: "plan_first",
    presentationMode: "compact",
  },
  nodes: [
    {
      id: "download",
      title: "下载",
      description: "查找安装入口",
      nodeType: "primary",
      layer: 0,
      status: "planned",
      searchPlan: {
        queries: ["VS Code download"],
        maxResults: 20,
        rankingProfile: "software",
        providerHints: ["general"],
      },
    },
  ],
  edges: [],
});

const baseResource = {
  id: "resource-base",
  title: "Resource",
  url: "https://example.com/resource",
  canonicalUrl: "https://example.com/resource",
  domain: "example.com",
  sourceType: "web",
  summary: "摘要",
  whySelected: "与查询相关。",
  rank: 1,
  searchProvider: "tavily",
  publishedAt: null,
} as const;

function createReadyResult(urls: readonly string[]): ResultGraph {
  return ResultGraphSchema.parse({
    version: "0.1",
    runId: "metrics-run",
    query: {
      raw: "VS Code download",
      normalized: "vs code download",
      language: "zh-CN",
    },
    analysis: plan.analysis,
    graph: {
      nodes: [
        {
          ...plan.nodes[0],
          status: "ready",
          resources: urls.map((url, index) => ({
            ...baseResource,
            id: `resource-${index + 1}`,
            title: `Resource ${index + 1}`,
            url,
            canonicalUrl: url,
            domain: new URL(url).hostname,
            rank: index + 1,
          })),
          warnings: [],
        },
      ],
      edges: [],
    },
    meta: {
      createdAt: "2026-10-23T00:00:00.000Z",
      providersUsed: ["tavily"],
      timingMs: { total: 1_000 },
      partial: false,
    },
  });
}

function createFailedResult(): ResultGraph {
  return ResultGraphSchema.parse({
    version: "0.1",
    runId: "metrics-run",
    query: {
      raw: "VS Code download",
      normalized: "vs code download",
      language: "zh-CN",
    },
    analysis: plan.analysis,
    graph: {
      nodes: [
        {
          ...plan.nodes[0],
          status: "failed",
          resources: [],
          warnings: [],
          error: { code: "SEARCH_PROVIDER_FAILED", retryable: true },
        },
      ],
      edges: [],
    },
    meta: {
      createdAt: "2026-10-23T00:00:00.000Z",
      providersUsed: ["tavily"],
      timingMs: { total: 1_000 },
      partial: true,
    },
  });
}

function createTelemetry(totalMs: number) {
  return QualityEvalTelemetrySchema.parse({
    timingsMs: {
      planning: 100,
      nodeProcessing: 200,
      total: totalMs,
      // Provider 耗时可以并发累加，Deadline 指标只能读取 total。
      provider: { search: 30_000, extract: 30_000, llm: 30_000 },
    },
    counts: {
      logicalSearchCalls: 1,
      logicalExtractCalls: 1,
      extractUrlCount: 1,
      logicalLlmCalls: 2,
      searchHttpAttempts: 1,
      extractHttpAttempts: 1,
    },
    versions: { rankFusion: "rank-fusion.v1" },
    ranking: {
      llmSuccess: {
        nodeCount: 1,
        finalCandidateCount: 3,
        providerTop1OverrideCount: 1,
        heuristicTop1OverrideCount: 0,
        providerTop3FinalOverlapCount: 3,
        heuristicTop3FinalOverlapCount: 3,
        top3ComparisonSlots: 3,
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
      status: "complete",
      observations: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
    estimatedCost: {
      status: "unavailable",
      reason: "pricing_not_frozen",
    },
  });
}

/**
 * 为跨 Node 聚合与数量上界生成最小合法 Fixture。空 Resource 的 Node 使用 failed，
 * 其余 Node 使用 ready；这样测试只改变待观察事实，不引入额外 Warning 语义。
 */
function createGraphFixture(
  resourceUrlsByNode: readonly (readonly string[])[],
) {
  const basePlanNode = plan.nodes[0];
  if (basePlanNode === undefined) throw new Error("测试 Fixture 缺少基础 Node");
  const fixturePlan = GraphPlanSchema.parse({
    ...plan,
    nodes: resourceUrlsByNode.map((_, nodeIndex) => ({
      ...basePlanNode,
      id: `node-${nodeIndex + 1}`,
      title: `Node ${nodeIndex + 1}`,
    })),
    edges: [],
  });
  const hasFailedNode = resourceUrlsByNode.some(urls => urls.length === 0);
  const baseResult = createReadyResult(["https://placeholder.example/item"]);
  const result = ResultGraphSchema.parse({
    ...baseResult,
    analysis: fixturePlan.analysis,
    graph: {
      nodes: fixturePlan.nodes.map((node, nodeIndex) => {
        const urls = resourceUrlsByNode[nodeIndex] ?? [];
        return urls.length === 0
          ? {
              ...node,
              status: "failed",
              resources: [],
              warnings: [],
              error: { code: "SEARCH_PROVIDER_FAILED", retryable: true },
            }
          : {
              ...node,
              status: "ready",
              resources: urls.map((url, resourceIndex) => ({
                ...baseResource,
                id: `node-${nodeIndex + 1}-resource-${resourceIndex + 1}`,
                title: `Node ${nodeIndex + 1} Resource ${resourceIndex + 1}`,
                url,
                canonicalUrl: url,
                domain: new URL(url).hostname,
                rank: resourceIndex + 1,
              })),
              warnings: [],
            };
      }),
      edges: [],
    },
    meta: {
      ...baseResult.meta,
      partial: hasFailedNode,
    },
  });
  return { plan: fixturePlan, result };
}

describe("WAY-110 SearchPlan 计划请求重复聚合", () => {
  it("同一身份同时覆盖 Node 内重复与跨 Node 共享时保持互斥计数", () => {
    const baseNode = plan.nodes[0];
    if (baseNode === undefined) throw new Error("测试 Fixture 缺少基础 Node");
    const duplicatePlan = GraphPlanSchema.parse({
      ...plan,
      nodes: [
        {
          ...baseNode,
          id: "node-a",
          searchPlan: {
            ...baseNode.searchPlan,
            queries: ["same request", "same request"],
            maxResults: 10,
          },
        },
        {
          ...baseNode,
          id: "node-b",
          searchPlan: {
            ...baseNode.searchPlan,
            queries: ["same request", "other request"],
            maxResults: 10,
          },
        },
      ],
      edges: [],
    });

    expect(
      measureQualityEvalPlannedRequestDuplication(
        duplicatePlan,
        QUALITY_EVAL_PLANNED_REQUEST_CONFIG,
      ),
    ).toEqual({
      totalCount: 4,
      uniqueCount: 2,
      intraNodeDuplicateOccurrenceCount: 1,
      crossNodeSharedGroupCount: 1,
      crossNodeExtraNodeOccurrenceCount: 1,
    });
  });

  it("相似 Query 与相同 Query 的不同 maxResults 均不误判为同一身份", () => {
    const baseNode = plan.nodes[0];
    if (baseNode === undefined) throw new Error("测试 Fixture 缺少基础 Node");
    const distinctPlan = GraphPlanSchema.parse({
      ...plan,
      nodes: [
        {
          ...baseNode,
          id: "node-a",
          searchPlan: {
            ...baseNode.searchPlan,
            queries: ["same request", "Same request"],
            maxResults: 10,
          },
        },
        {
          ...baseNode,
          id: "node-b",
          searchPlan: {
            ...baseNode.searchPlan,
            queries: ["same request"],
            maxResults: 20,
          },
        },
      ],
      edges: [],
    });

    expect(
      measureQualityEvalPlannedRequestDuplication(
        distinctPlan,
        QUALITY_EVAL_PLANNED_REQUEST_CONFIG,
      ),
    ).toEqual({
      totalCount: 3,
      uniqueCount: 3,
      intraNodeDuplicateOccurrenceCount: 0,
      crossNodeSharedGroupCount: 0,
      crossNodeExtraNodeOccurrenceCount: 0,
    });
  });

  it("多 Node 多次重复严格拆分 Node 内 occurrence 与额外 Node occurrence", () => {
    const baseNode = plan.nodes[0];
    if (baseNode === undefined) throw new Error("测试 Fixture 缺少基础 Node");
    const combinedPlan = GraphPlanSchema.parse({
      ...plan,
      nodes: [
        {
          ...baseNode,
          id: "node-a",
          searchPlan: {
            ...baseNode.searchPlan,
            queries: ["same", "same", "same"],
            maxResults: 6,
          },
        },
        {
          ...baseNode,
          id: "node-b",
          searchPlan: {
            ...baseNode.searchPlan,
            queries: ["same", "same", "other-a"],
            maxResults: 6,
          },
        },
        {
          ...baseNode,
          id: "node-c",
          searchPlan: {
            ...baseNode.searchPlan,
            queries: ["same", "other-b", "other-c"],
            maxResults: 6,
          },
        },
      ],
      edges: [],
    });

    const measured = measureQualityEvalPlannedRequestDuplication(
      combinedPlan,
      QUALITY_EVAL_PLANNED_REQUEST_CONFIG,
    );

    expect(measured).toEqual({
      totalCount: 9,
      uniqueCount: 4,
      intraNodeDuplicateOccurrenceCount: 3,
      crossNodeSharedGroupCount: 1,
      crossNodeExtraNodeOccurrenceCount: 2,
    });
    expect(measured.totalCount - measured.uniqueCount).toBe(
      measured.intraNodeDuplicateOccurrenceCount +
        measured.crossNodeExtraNodeOccurrenceCount,
    );
    expect(measured.crossNodeSharedGroupCount).toBeLessThanOrEqual(
      measured.crossNodeExtraNodeOccurrenceCount,
    );
  });

  it("严格 Schema 拒绝不变量、非安全整数与任何请求身份字段", () => {
    const valid = {
      totalCount: 4,
      uniqueCount: 2,
      intraNodeDuplicateOccurrenceCount: 1,
      crossNodeSharedGroupCount: 1,
      crossNodeExtraNodeOccurrenceCount: 1,
    };

    expect(QualityEvalPlannedRequestDuplicationSchema.parse(valid)).toEqual(
      valid,
    );
    expect(
      QualityEvalPlannedRequestDuplicationSchema.safeParse({
        ...valid,
        crossNodeExtraNodeOccurrenceCount: 0,
      }).success,
    ).toBe(false);
    expect(
      QualityEvalPlannedRequestDuplicationSchema.safeParse({
        ...valid,
        totalCount: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    for (const forbiddenField of [
      "query",
      "queryFingerprint",
      "nodeId",
      "groupIdentity",
    ]) {
      expect(
        QualityEvalPlannedRequestDuplicationSchema.safeParse({
          ...valid,
          [forbiddenField]: "private-identity",
        }).success,
      ).toBe(false);
    }
  });

  it("当前 Metrics Schema 拒绝伪装成新结构的 v1 工件", () => {
    const measured = measureQualityEvalMetrics({
      queryId: QUERY_ID,
      plan,
      result: createReadyResult(["https://example.com/item"]),
      telemetry: createTelemetry(1_000),
      expectedOfficialDomains: [],
      runDeadlineMs: RUN_DEADLINE_MS,
    });
    expect(measured.status).toBe("measured");
    if (measured.status !== "measured") return;

    expect(
      QualityEvalMetricsSchema.safeParse({
        ...measured.metrics,
        version: "quality-metrics.v1",
      }).success,
    ).toBe(false);
  });
});

describe("WAY-87 确定性质量指标", () => {
  it("合法 ResultGraph 的 Resource 重复率严格为 0", () => {
    const fixture = createGraphFixture([
      [
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
        "https://example.com/d",
      ],
      ["https://example.com/e"],
    ]);

    const measured = measureQualityEvalMetrics({
      queryId: QUERY_ID,
      ...fixture,
      telemetry: createTelemetry(1_000),
      expectedOfficialDomains: [],
      runDeadlineMs: RUN_DEADLINE_MS,
    });

    expect(measured.status).toBe("measured");
    if (measured.status !== "measured") return;
    expect(measured.metrics).toMatchObject({
      version: QUALITY_METRICS_VERSION,
      schemaValidity: "valid",
      nodeCount: 2,
      resourceCount: 5,
      duplicateRate: {
        status: "measured",
        duplicateOccurrences: 0,
        totalOccurrences: 5,
        value: 0,
      },
      officialSource: { status: "notApplicable" },
      deadlineCompliance: { status: "within" },
    });
    expect(measured.nodeMetrics).toEqual([
      {
        nodeId: "node-1",
        resourceCount: 4,
        officialSource: { status: "notApplicable" },
      },
      {
        nodeId: "node-2",
        resourceCount: 1,
        officialSource: { status: "notApplicable" },
      },
    ]);
    expect(measured.duplicateResources).toEqual([]);
  });

  it("跨 Node 重复图被 Contract 拒绝，零资源时重复率不可用", () => {
    expect(() =>
      createGraphFixture([
        ["https://duplicate.example/item"],
        ["https://duplicate.example/item"],
        ["https://duplicate.example/item"],
        ["https://unique.example/item"],
      ]),
    ).toThrow();

    const empty = measureQualityEvalMetrics({
      queryId: QUERY_ID,
      plan,
      result: createFailedResult(),
      telemetry: createTelemetry(1_000),
      expectedOfficialDomains: ["code.visualstudio.com"],
      runDeadlineMs: RUN_DEADLINE_MS,
    });
    expect(empty.status).toBe("measured");
    if (empty.status === "measured") {
      expect(empty.metrics.resourceCount).toBe(0);
      expect(empty.metrics.duplicateRate).toEqual({
        status: "unavailable",
        reason: "noResources",
      });
      expect(empty.metrics.officialSource).toEqual({
        status: "unavailable",
        reason: "noResources",
      });
    }
  });

  it("相同 Path 但语义 Query 不同的 canonical URL 不误判为重复", () => {
    const fixture = createGraphFixture([
      ["https://www.youtube.com/watch?v=video-a"],
      ["https://www.youtube.com/watch?v=video-b"],
    ]);
    const measured = measureQualityEvalMetrics({
      queryId: QUERY_ID,
      ...fixture,
      telemetry: createTelemetry(1_000),
      expectedOfficialDomains: [],
      runDeadlineMs: RUN_DEADLINE_MS,
    });

    expect(measured.status).toBe("measured");
    if (measured.status !== "measured") return;
    expect(measured.metrics.duplicateRate).toEqual({
      status: "measured",
      duplicateOccurrences: 0,
      totalOccurrences: 2,
      value: 0,
    });
    expect(measured.duplicateResources).toEqual([]);
  });

  it.each([
    [19_999, "within"],
    [20_000, "within"],
    [20_001, "exceeded"],
  ] as const)("只用 total=%dms 判断 Deadline 为 %s", (totalMs, status) => {
    const measured = measureQualityEvalMetrics({
      queryId: QUERY_ID,
      plan,
      result: createReadyResult(["https://code.visualstudio.com/download"]),
      telemetry: createTelemetry(totalMs),
      expectedOfficialDomains: ["code.visualstudio.com"],
      runDeadlineMs: RUN_DEADLINE_MS,
    });
    expect(measured.status).toBe("measured");
    if (measured.status === "measured") {
      expect(measured.metrics.deadlineCompliance.status).toBe(status);
      expect(measured.metrics.officialSource).toEqual({
        status: "detected",
        rank: 1,
      });
    }
  });

  it("显式 Deadline 错误即使总耗时较短也标记 exceeded", () => {
    const baseFailedResult = createFailedResult();
    const failedNode = baseFailedResult.graph.nodes[0];
    if (failedNode === undefined) throw new Error("测试 Fixture 缺少失败 Node");
    const deadlineResult = ResultGraphSchema.parse({
      ...baseFailedResult,
      graph: {
        ...baseFailedResult.graph,
        nodes: [
          {
            ...failedNode,
            error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
          },
        ],
      },
    });
    const measured = measureQualityEvalMetrics({
      queryId: QUERY_ID,
      plan,
      result: deadlineResult,
      telemetry: createTelemetry(1_000),
      expectedOfficialDomains: [],
      runDeadlineMs: RUN_DEADLINE_MS,
    });

    expect(measured.status).toBe("measured");
    if (measured.status !== "measured") return;
    expect(measured.metrics.deadlineCompliance).toEqual({ status: "exceeded" });
    expect(
      QualityEvalMetricsSchema.safeParse({
        ...measured.metrics,
        deadlineCompliance: {
          status: "within",
          deadlineErrorObserved: true,
        },
      }).success,
    ).toBe(false);
  });

  it("跨 Node 官方来源取全局最小排名，且混合无资源时保留 noneDetected", () => {
    const detectedFixture = createGraphFixture([
      [
        ...Array.from(
          { length: 7 },
          (_, index) => `https://community.example/node-1-${index + 1}`,
        ),
        "https://code.visualstudio.com/rank-8",
      ],
      ["https://code.visualstudio.com/rank-1"],
    ]);
    const detected = measureQualityEvalMetrics({
      queryId: QUERY_ID,
      ...detectedFixture,
      telemetry: createTelemetry(1_000),
      expectedOfficialDomains: ["code.visualstudio.com"],
      runDeadlineMs: RUN_DEADLINE_MS,
    });
    expect(detected.status).toBe("measured");
    if (detected.status === "measured") {
      expect(detected.nodeMetrics.map(node => node.officialSource)).toEqual([
        { status: "detected", rank: 8 },
        { status: "detected", rank: 1 },
      ]);
      expect(detected.metrics.officialSource).toEqual({
        status: "detected",
        rank: 1,
      });
    }

    const mixedFixture = createGraphFixture([
      [],
      ["https://community.example/non-official"],
    ]);
    const mixed = measureQualityEvalMetrics({
      queryId: QUERY_ID,
      ...mixedFixture,
      telemetry: createTelemetry(1_000),
      expectedOfficialDomains: ["code.visualstudio.com"],
      runDeadlineMs: RUN_DEADLINE_MS,
    });
    expect(mixed.status).toBe("measured");
    if (mixed.status === "measured") {
      expect(mixed.nodeMetrics.map(node => node.officialSource)).toEqual([
        { status: "unavailable", reason: "noResources" },
        { status: "noneDetected" },
      ]);
      expect(mixed.metrics.officialSource).toEqual({ status: "noneDetected" });
    }
  });

  it("覆盖 8 Node × 8 Resource 的 Contract 上界", () => {
    const fixture = createGraphFixture(
      Array.from({ length: 8 }, (_, nodeIndex) =>
        Array.from(
          { length: 8 },
          (_, resourceIndex) =>
            `https://node-${nodeIndex + 1}.example/resource-${resourceIndex + 1}`,
        ),
      ),
    );
    const measured = measureQualityEvalMetrics({
      queryId: QUERY_ID,
      ...fixture,
      telemetry: createTelemetry(1_000),
      expectedOfficialDomains: [],
      runDeadlineMs: RUN_DEADLINE_MS,
    });

    expect(measured.status).toBe("measured");
    if (measured.status !== "measured") return;
    expect(measured.metrics.nodeCount).toBe(8);
    expect(measured.metrics.resourceCount).toBe(64);
    expect(measured.nodeMetrics).toHaveLength(8);
    expect(measured.nodeMetrics.every(node => node.resourceCount === 8)).toBe(
      true,
    );
  });

  it.each([
    {
      label: "GraphPlan",
      queryId: QUERY_ID,
      plan: { ...plan, leaked: "sk-private-value /Users/private/project" },
      result: createReadyResult(["https://example.com/item"]),
      telemetry: createTelemetry(1_000),
      stage: "graphPlan",
    },
    {
      label: "ResultGraph",
      queryId: QUERY_ID,
      plan,
      result: {
        ...createReadyResult(["https://example.com/item"]),
        leaked: "sk-private-value /Users/private/project",
      },
      telemetry: createTelemetry(1_000),
      stage: "resultGraph",
    },
    {
      label: "RunLog",
      queryId: QUERY_ID,
      plan,
      result: createReadyResult(["https://example.com/item"]),
      telemetry: {
        ...createTelemetry(1_000),
        leaked: "sk-private-value /Users/private/project",
      },
      stage: "runLog",
    },
    {
      label: "非法 Query ID",
      queryId: "sk-private-value /Users/private/project",
      plan: { ...plan, leaked: true },
      result: createReadyResult(["https://example.com/item"]),
      telemetry: createTelemetry(1_000),
      stage: "graphPlan",
    },
  ] as const)("$label Schema 失败只返回固定定位", testCase => {
    const secret = "sk-private-value";
    const invalid = measureQualityEvalMetrics({
      queryId: testCase.queryId,
      plan: testCase.plan,
      result: testCase.result,
      telemetry: testCase.telemetry,
      expectedOfficialDomains: [],
      runDeadlineMs: RUN_DEADLINE_MS,
    });

    expect(invalid).toEqual({
      status: "failed",
      failure: {
        queryId: testCase.queryId === QUERY_ID ? QUERY_ID : "unknown",
        metric: "schemaValidity",
        stage: testCase.stage,
        code: "schema_invalid",
      },
    });
    expect(JSON.stringify(invalid)).not.toContain(secret);
    expect(JSON.stringify(invalid)).not.toContain("/Users/private");
  });

  it("计划请求配置非法时返回固定失败，不抛异常或伪造零诊断", () => {
    const invalidProviderId = "private-provider-identity";
    const measured = measureQualityEvalMetrics({
      queryId: QUERY_ID,
      plan,
      result: createReadyResult(["https://example.com/item"]),
      telemetry: createTelemetry(1_000),
      expectedOfficialDomains: [],
      runDeadlineMs: RUN_DEADLINE_MS,
      plannedRequestConfig: {
        providerId: invalidProviderId,
        language: "zh-CN",
      },
    });

    expect(measured).toEqual({
      status: "failed",
      failure: {
        queryId: QUERY_ID,
        metric: "metricsProjection",
        stage: "metricsProjection",
        code: "policy_invalid",
      },
    });
    expect(JSON.stringify(measured)).not.toContain(invalidProviderId);
    expect(JSON.stringify(measured)).not.toContain("plannedRequestDuplication");
    expect(JSON.stringify(measured)).not.toContain("download");
  });

  it("不产生综合分、通过率或自动质量门禁", () => {
    const measured = measureQualityEvalMetrics({
      queryId: QUERY_ID,
      plan,
      result: createReadyResult(["https://example.com/item"]),
      telemetry: createTelemetry(1_000),
      expectedOfficialDomains: [],
      runDeadlineMs: RUN_DEADLINE_MS,
    });
    const serialized = JSON.stringify(measured).toLowerCase();

    expect(serialized).not.toContain("overallscore");
    expect(serialized).not.toContain("passrate");
    expect(serialized).not.toContain("qualitygate");
  });
});
