/**
 * 测试职责：冻结 WAY-86 统一质量评估接口的数据集、完整管线事实投影与失败语义。
 *
 * 边界说明：测试只使用公共 Contract 对象和 Fake Handler，不读取 Secret、不访问网络，
 * 也不对质量设置通过阈值；自动判分属于后续 WAY-87。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  GraphPlanSchema,
  ResultGraphSchema,
  type StreamEventPayload,
} from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import { RunLogRecordSchema } from "../observability/run-log.js";
import {
  QUALITY_EVAL_DATASET_VERSION,
  QUALITY_EVAL_SCHEMA_VERSION,
  QualityEvalQueryResultSchema,
  evaluateQualityEvalDataset,
  evaluateQualityEvalQuery,
  parseQualityEvalDatasets,
} from "./quality-eval.js";

const QUERY = {
  id: "wfq-009",
  query: "VS Code download",
  category: "navigateDownload",
  rationale: "固定下载类 Query。",
} as const;

const plan = GraphPlanSchema.parse({
  analysis: {
    intent: "navigate",
    topic: QUERY.query,
    freshnessSensitive: false,
    ambiguityLevel: "low",
    broadSearchQueries: [],
    strategy: "plan_first",
    presentationMode: "compact",
  },
  nodes: [
    {
      id: "download",
      title: "官方下载",
      description: "找到官方安装入口",
      nodeType: "primary",
      layer: 0,
      status: "planned",
      searchPlan: {
        queries: ["VS Code official download"],
        maxResults: 20,
        rankingProfile: "software",
        providerHints: ["general"],
      },
    },
    {
      id: "docs",
      title: "安装文档",
      description: "阅读跨平台安装说明",
      nodeType: "primary",
      layer: 1,
      status: "planned",
      searchPlan: {
        queries: ["site:code.visualstudio.com VS Code setup docs"],
        maxResults: 20,
        rankingProfile: "software",
        providerHints: ["general"],
      },
    },
  ],
  edges: [
    {
      id: "download-to-docs",
      source: "download",
      target: "docs",
      type: "recommended_next",
    },
  ],
});

const sharedResource = {
  id: "resource-shared",
  title: "Visual Studio Code",
  url: "https://alice:password@code.visualstudio.com/download?access_token=top-secret#section",
  canonicalUrl: "https://code.visualstudio.com/download?access_token=top-secret",
  domain: "code.visualstudio.com",
  sourceType: "documentation",
  summary: "Visual Studio Code 官方下载页面。",
  whySelected: "与下载 Node 直接相关。",
  rank: 1,
  searchProvider: "tavily",
  publishedAt: null,
} as const;

function createSensitiveSharedResource(nodeId: string) {
  const canonicalUrl =
    `https://code.visualstudio.com/download?access_token=${nodeId}-secret-value`;
  return {
    ...sharedResource,
    id: `resource_${createHash("sha256").update(canonicalUrl).digest("hex")}`,
    url: `https://alice:password@code.visualstudio.com/download?access_token=${nodeId}-secret-value#section`,
    canonicalUrl,
  } as const;
}

const SAFE_SHARED_RESOURCE_ID = `resource_${createHash("sha256")
  .update("https://code.visualstudio.com/download")
  .digest("hex")}`;

const resultGraph = ResultGraphSchema.parse({
  version: "0.1",
  runId: "eval-run",
  query: { raw: QUERY.query, normalized: "vs code download", language: "und" },
  analysis: plan.analysis,
  graph: {
    nodes: plan.nodes.map(node => ({
      ...node,
      status: "ready",
      resources: [
        createSensitiveSharedResource(node.id),
        {
          ...sharedResource,
          id: `${node.id}-resource-2`,
          title: `${node.title}官方更新`,
          url: `https://updates.code.visualstudio.com/${node.id}`,
          canonicalUrl: `https://updates.code.visualstudio.com/${node.id}`,
          domain: "updates.code.visualstudio.com",
          rank: 2,
        },
        {
          ...sharedResource,
          id: `${node.id}-resource-3`,
          title: `${node.title}社区材料`,
          url: `https://community.example.net/${node.id}`,
          canonicalUrl: `https://community.example.net/${node.id}`,
          domain: "community.example.net",
          rank: 3,
        },
        {
          ...sharedResource,
          id: `${node.id}-resource-4`,
          title: `${node.title}保留材料`,
          url: `https://retained.example.org/${node.id}`,
          canonicalUrl: `https://retained.example.org/${node.id}`,
          domain: "retained.example.org",
          rank: 4,
        },
      ],
      warnings: [],
    })),
    edges: plan.edges,
  },
  meta: {
    createdAt: "2026-10-23T00:00:00.000Z",
    providersUsed: ["tavily"],
    timingMs: { total: 1_234 },
    partial: false,
  },
});

const runLog = RunLogRecordSchema.parse({
  schemaVersion: "run-log.v1",
  createdAt: "2026-10-23T00:00:00.000Z",
  identifiers: {
    logId: "11111111-1111-4111-8111-111111111111",
    queryId: "22222222-2222-4222-8222-222222222222",
    planId: "33333333-3333-4333-8333-333333333333",
  },
  outcome: "complete",
  timingsMs: {
    planning: 200,
    nodeProcessing: 900,
    total: 1_234,
    provider: { search: 300, extract: 250, llm: 500 },
  },
  counts: {
    plannedNodes: 2,
    edges: 1,
    resources: 8,
    readyNodes: 2,
    partialNodes: 0,
    failedNodes: 0,
    logicalSearchCalls: 2,
    logicalExtractCalls: 2,
    extractUrlCount: 8,
    logicalLlmCalls: 3,
    searchResultCount: 16,
    extractedPageCount: 8,
    searchHttpAttempts: 2,
    extractHttpAttempts: 2,
  },
  warningCodes: [],
  errorCodes: [],
  versions: {
    protocol: "0.1",
    resultGraph: "0.1",
    plannerPrompt: "graph-planner.v1",
    reviserPrompt: "graph-reviser.v1",
    rerankerPrompt: "resource-reranker.v1",
  },
  providers: { search: "tavily", llm: "deepseek" },
  cache: {
    search: { hitCount: 0, missCount: 2 },
    extract: { hitCount: 0, missCount: 2 },
  },
  tokens: {
    status: "complete",
    observations: 3,
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
  },
  estimatedCost: {
    status: "unavailable",
    reason: "pricing_not_frozen",
  },
});

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      fileURLToPath(new URL(`../../../../${relativePath}`, import.meta.url)),
      "utf8",
    ),
  ) as unknown;
}

describe("WAY-86 Quality Eval 数据集", () => {
  it("通过同一版本化接口加载 Golden 6 条与 Full 20 条", async () => {
    const datasets = parseQualityEvalDatasets(
      await readJson("tests/eval-queries.json"),
      await readJson("tests/eval-full-queries.json"),
    );

    expect(datasets.golden.version).toBe(QUALITY_EVAL_DATASET_VERSION);
    expect(datasets.full.version).toBe(QUALITY_EVAL_DATASET_VERSION);
    expect(datasets.golden.queries).toHaveLength(6);
    expect(datasets.full.queries).toHaveLength(20);
    expect(datasets.full.queries.map(query => query.id)).toEqual(
      Array.from({ length: 20 }, (_, index) =>
        `wfq-${String(index + 1).padStart(3, "0")}`,
      ),
    );
    expect(
      datasets.golden.queries.every(goldenQuery =>
        datasets.full.queries.some(
          fullQuery => JSON.stringify(fullQuery) === JSON.stringify(goldenQuery),
        ),
      ),
    ).toBe(true);
    expect(datasets.full.officialDomainsByQueryId).toEqual({
      "wfq-009": ["code.visualstudio.com"],
      "wfq-010": ["python.org"],
    });
  });

  it("拒绝 Golden 与 Full 的同 ID 条目漂移", async () => {
    const golden = await readJson("tests/eval-queries.json");
    const full = (await readJson("tests/eval-full-queries.json")) as unknown[];

    expect(() =>
      parseQualityEvalDatasets(golden, [
        { ...(full[0] as object), category: "drifted" },
        ...full.slice(1),
      ]),
    ).toThrow("Golden 与 Full Query 定义不一致");

    expect(() =>
      parseQualityEvalDatasets(golden, [
        full[0],
        { ...(full[1] as object), query: "drifted" },
        ...full.slice(2),
      ]),
    ).toThrow("必须升级 Dataset Version 与冻结指纹");
  });
});

describe("WAY-86 Quality Eval 查询投影", () => {
  it("保留计划、Top 3、官方排名、跨 Node 重复、多样性与 Run Log 遥测", async () => {
    const payloads: StreamEventPayload[] = [
      { type: "query.analysis", data: plan.analysis },
      { type: "graph.plan", data: plan },
      {
        type: "complete",
        data: { finalStatus: "complete", result: resultGraph },
      },
    ];
    const projected = await evaluateQualityEvalQuery({
      query: QUERY,
      runId: "eval-run",
      signal: new AbortController().signal,
      expectedOfficialDomains: ["code.visualstudio.com"],
      handleSearch: async ({ emit }) => {
        for (const payload of payloads) await emit(payload);
      },
      readRunLog: () => runLog,
    });

    expect(projected).toMatchObject({
      schemaVersion: QUALITY_EVAL_SCHEMA_VERSION,
      comparisonKey: `${QUALITY_EVAL_DATASET_VERSION}:${QUERY.id}`,
      executionStatus: "completed",
      finalStatus: "complete",
      plan,
      telemetry: {
        timingsMs: runLog.timingsMs,
        tokens: runLog.tokens,
        estimatedCost: runLog.estimatedCost,
      },
    });
    expect(projected.nodes).toHaveLength(2);
    expect(projected.nodes[0]).toMatchObject({
      officialSource: { status: "detected", rank: 1 },
      diversity: {
        distinctExactDomainCount: 3,
      },
    });
    expect(projected.nodes[0]?.topResources).toHaveLength(3);
    expect(projected.nodes[0]?.topResources[0]).toMatchObject({
      url: "https://code.visualstudio.com/download",
      canonicalUrl: "https://code.visualstudio.com/download",
      id: SAFE_SHARED_RESOURCE_ID,
    });
    expect(projected.nodes[0]?.topResources[0]?.id).not.toBe(
      resultGraph.graph.nodes[0]?.resources.find(resource => resource.rank === 1)
        ?.id,
    );
    expect(JSON.stringify(projected)).not.toContain("secret-value");
    expect(projected.duplicateResources).toEqual([
      {
        canonicalUrlFingerprint: createHash("sha256")
          .update("https://code.visualstudio.com/download")
          .digest("hex"),
        occurrences: [
          {
            nodeId: "download",
            rank: 1,
          },
          {
            nodeId: "docs",
            rank: 1,
          },
        ],
      },
    ]);
  });

  it("Top 3 忠实保留生产数组顺序，官方排名仍取最小显式 rank", async () => {
    const firstNode = resultGraph.graph.nodes[0];
    if (firstNode === undefined) throw new Error("测试 Fixture 缺少首个 Node");
    const reorderedResult = ResultGraphSchema.parse({
      ...resultGraph,
      graph: {
        ...resultGraph.graph,
        nodes: [
          {
            ...firstNode,
            // Contract 允许 rank 与数组位置暂时不一致，用于防止 Eval 擅自掩盖生产顺序回归。
            resources: [
              firstNode.resources[3],
              firstNode.resources[1],
              firstNode.resources[0],
              firstNode.resources[2],
            ],
          },
          ...resultGraph.graph.nodes.slice(1),
        ],
      },
    });
    const projected = await evaluateQualityEvalQuery({
      query: QUERY,
      runId: "array-order-run",
      signal: new AbortController().signal,
      expectedOfficialDomains: ["code.visualstudio.com"],
      handleSearch: async ({ emit }) => {
        await emit({ type: "graph.plan", data: plan });
        await emit({
          type: "complete",
          data: { finalStatus: "complete", result: reorderedResult },
        });
      },
      readRunLog: () => runLog,
    });

    expect(projected.nodes[0]?.topResources.map(resource => resource.rank))
      .toEqual([4, 2, 1]);
    expect(projected.nodes[0]?.officialSource).toEqual({
      status: "detected",
      rank: 1,
    });
  });

  it("run.failed 不伪造成空成功，并且只保留稳定错误码", async () => {
    const projected = await evaluateQualityEvalQuery({
      query: QUERY,
      runId: "failed-run",
      signal: new AbortController().signal,
      expectedOfficialDomains: ["code.visualstudio.com"],
      handleSearch: async ({ emit }) => {
        await emit({
          type: "run.failed",
          error: { code: "PLANNER_FAILED", retryable: false },
        });
      },
      readRunLog: () => ({ ...runLog, outcome: "failed" }),
    });

    expect(projected).toMatchObject({
      executionStatus: "run_failed",
      errorCode: "PLANNER_FAILED",
      plan: null,
      nodes: [],
      duplicateResources: [],
    });
  });

  it("取消与未知内部错误保持不同状态且不保存原始 Error", async () => {
    const cancelController = new AbortController();
    const sensitiveError = new Error("secret-local-path");
    const cancelled = await evaluateQualityEvalQuery({
      query: QUERY,
      runId: "cancelled-run",
      signal: cancelController.signal,
      expectedOfficialDomains: ["code.visualstudio.com"],
      handleSearch: async () => {
        cancelController.abort(sensitiveError);
        throw sensitiveError;
      },
      readRunLog: () => undefined,
    });
    const failed = await evaluateQualityEvalQuery({
      query: QUERY,
      runId: "internal-run",
      signal: new AbortController().signal,
      expectedOfficialDomains: ["code.visualstudio.com"],
      handleSearch: async () => {
        throw sensitiveError;
      },
      readRunLog: () => undefined,
    });

    expect(cancelled.executionStatus).toBe("cancelled");
    expect(failed.executionStatus).toBe("unexpected_internal_error");
    expect(JSON.stringify([cancelled, failed])).not.toContain(
      sensitiveError.message,
    );
  });

  it("保留 Partial 与 Deadline 失败事实，并将无结果的官方排名标为不可用", async () => {
    const partialResult = ResultGraphSchema.parse({
      ...resultGraph,
      graph: {
        ...resultGraph.graph,
        nodes: resultGraph.graph.nodes.map((node, index) =>
          index === 0
            ? { ...node, status: "partial", warnings: ["RERANK_FAILED"] }
            : {
                ...node,
                status: "failed",
                resources: [],
                warnings: [],
                error: {
                  code: "RUN_DEADLINE_EXCEEDED",
                  retryable: true,
                },
              },
        ),
      },
      meta: { ...resultGraph.meta, partial: true },
    });
    const projected = await evaluateQualityEvalQuery({
      query: QUERY,
      runId: "partial-run",
      signal: new AbortController().signal,
      expectedOfficialDomains: ["code.visualstudio.com"],
      handleSearch: async ({ emit }) => {
        await emit({ type: "graph.plan", data: plan });
        await emit({
          type: "complete",
          data: { finalStatus: "partial", result: partialResult },
        });
      },
      readRunLog: () => ({ ...runLog, outcome: "partial" }),
    });

    expect(projected.finalStatus).toBe("partial");
    expect(projected.nodes[0]).toMatchObject({
      status: "partial",
      warnings: ["RERANK_FAILED"],
    });
    expect(projected.nodes[1]).toMatchObject({
      status: "failed",
      errorCode: "RUN_DEADLINE_EXCEEDED",
      officialSource: { status: "unavailable", reason: "noResources" },
    });
  });
});

describe("WAY-86 Quality Eval Suite 编排", () => {
  it("按 Full 顺序执行，并在父 Signal 取消后不再启动后续 Query", async () => {
    const datasets = parseQualityEvalDatasets(
      await readJson("tests/eval-queries.json"),
      await readJson("tests/eval-full-queries.json"),
    );
    const fullSeen: string[] = [];
    const fullController = new AbortController();
    await evaluateQualityEvalDataset({
      dataset: datasets.full,
      signal: fullController.signal,
      evaluate: async (query, receivedSignal) => {
        expect(receivedSignal).toBe(fullController.signal);
        fullSeen.push(query.id);
        return QualityEvalQueryResultSchema.parse({
          schemaVersion: QUALITY_EVAL_SCHEMA_VERSION,
          comparisonKey: `${QUALITY_EVAL_DATASET_VERSION}:${query.id}`,
          query,
          executionStatus: "run_failed",
          finalStatus: null,
          errorCode: "PLANNER_FAILED",
          plan: null,
          nodes: [],
          duplicateResources: [],
          telemetry: null,
        });
      },
    });
    expect(fullSeen).toEqual(datasets.full.queries.map(query => query.id));

    const controller = new AbortController();
    const goldenSeen: string[] = [];
    await evaluateQualityEvalDataset({
      dataset: datasets.golden,
      signal: controller.signal,
      evaluate: async (query, receivedSignal) => {
        expect(receivedSignal).toBe(controller.signal);
        goldenSeen.push(query.id);
        if (goldenSeen.length === 2) controller.abort();
        return QualityEvalQueryResultSchema.parse({
          schemaVersion: QUALITY_EVAL_SCHEMA_VERSION,
          comparisonKey: `${QUALITY_EVAL_DATASET_VERSION}:${query.id}`,
          query,
          executionStatus:
            goldenSeen.length === 2 ? "cancelled" : "run_failed",
          finalStatus: null,
          errorCode:
            goldenSeen.length === 2 ? null : "PLANNER_FAILED",
          plan: null,
          nodes: [],
          duplicateResources: [],
          telemetry: null,
        });
      },
    });
    expect(goldenSeen).toEqual(["wfq-001", "wfq-006"]);
  });
});
