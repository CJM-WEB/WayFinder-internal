/**
 * 测试职责：冻结 Run Log 的内部隐私白名单、聚合语义与 fail-open 写入边界。
 */
import {
  GraphPlanSchema,
  ResultGraphSchema,
  type GraphPlan,
  type ResultGraph,
} from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createRunLogRecorder,
  RunLogRecordSchema,
  type RunLogRecord,
} from "./run-log.js";

const SENSITIVE_TEXT =
  "Authorization Bearer secret Cookie session=private https://private.example/body";
const IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
] as const;

function createPlan(): GraphPlan {
  return GraphPlanSchema.parse({
    analysis: {
      intent: "learn",
      topic: SENSITIVE_TEXT,
      freshnessSensitive: false,
      ambiguityLevel: "low",
      broadSearchQueries: [],
      strategy: "plan_first",
      presentationMode: "compact",
    },
    nodes: [
      {
        id: "private-node",
        title: SENSITIVE_TEXT,
        description: SENSITIVE_TEXT,
        nodeType: "primary",
        layer: 0,
        status: "planned",
        searchPlan: {
          queries: [SENSITIVE_TEXT],
          maxResults: 20,
          rankingProfile: "knowledge",
          providerHints: ["general"],
        },
      },
    ],
    edges: [],
  });
}

function createPartialResult(plan: GraphPlan): ResultGraph {
  return ResultGraphSchema.parse({
    version: "0.1",
    runId: `../../${SENSITIVE_TEXT}`,
    query: {
      raw: SENSITIVE_TEXT,
      normalized: SENSITIVE_TEXT,
      language: "en",
    },
    analysis: plan.analysis,
    graph: {
      nodes: [
        {
          ...plan.nodes[0],
          status: "partial",
          resources: [
            {
              id: "resource-1",
              title: SENSITIVE_TEXT,
              url: "https://private.example/body",
              canonicalUrl: "https://private.example/body",
              domain: "private.example",
              sourceType: "documentation",
              summary: SENSITIVE_TEXT,
              whySelected: SENSITIVE_TEXT,
              rank: 1,
              searchProvider: "fake-search",
            },
          ],
          warnings: ["EXTRACTION_FAILED"],
        },
      ],
      edges: [],
    },
    meta: {
      createdAt: "2026-10-22T00:00:00.000Z",
      providersUsed: ["fake-search"],
      partial: true,
      timingMs: { total: 12 },
    },
  });
}

describe("Run Log Recorder", () => {
  it("只输出随机标识、阶段耗时、聚合计数和稳定 Code", async () => {
    const records: RunLogRecord[] = [];
    let nowMs = Date.parse("2026-10-22T00:00:00.000Z");
    let idIndex = 0;
    const recorder = createRunLogRecorder({
      sink: {
        write: async record => {
          records.push(record);
        },
      },
      searchProviderId: "fake-search",
      llmProviderId: "fake-llm",
      startedAt: nowMs,
      now: () => nowMs,
      createId: () => IDS[idIndex++]!,
    });
    const plan = createPlan();

    nowMs += 5;
    recorder.recordProviderCallStarted("llm");
    recorder.observe({
      kind: "token_usage",
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    });
    recorder.recordProviderCallFinished("llm", 5, 0);
    recorder.recordPlan(plan);
    recorder.recordNodeProcessingStarted();
    recorder.recordProviderCallStarted("search");
    recorder.observe({
      kind: "cache",
      operation: "search",
      hitCount: 0,
      missCount: 1,
    });
    recorder.observe({ kind: "http_attempt", operation: "search" });
    nowMs += 7;
    recorder.recordProviderCallFinished("search", 7, 2);
    recorder.recordProviderCallStarted("extract", 1);
    recorder.observe({
      kind: "cache",
      operation: "extract",
      hitCount: 1,
      missCount: 0,
    });
    recorder.recordProviderCallFinished("extract", 0, 1);
    recorder.recordEvent({
      type: "complete",
      data: {
        finalStatus: "partial",
        result: createPartialResult(plan),
      },
    });
    await recorder.finish();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      identifiers: {
        logId: IDS[0],
        queryId: IDS[1],
        planId: IDS[2],
      },
      outcome: "partial",
      timingsMs: {
        planning: 5,
        nodeProcessing: 7,
        total: 12,
        provider: { search: 7, extract: 0, llm: 5 },
      },
      counts: {
        plannedNodes: 1,
        edges: 0,
        resources: 1,
        readyNodes: 0,
        partialNodes: 1,
        failedNodes: 0,
        logicalSearchCalls: 1,
        logicalExtractCalls: 1,
        extractUrlCount: 1,
        logicalLlmCalls: 1,
        searchResultCount: 2,
        extractedPageCount: 1,
        searchHttpAttempts: 1,
        extractHttpAttempts: 0,
      },
      warningCodes: ["EXTRACTION_FAILED"],
      errorCodes: [],
      cache: {
        search: { hitCount: 0, missCount: 1 },
        extract: { hitCount: 1, missCount: 0 },
      },
      tokens: {
        status: "complete",
        observations: 1,
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
      estimatedCost: {
        status: "unavailable",
        reason: "pricing_not_frozen",
      },
    });
    expect(JSON.stringify(records[0])).not.toContain(SENSITIVE_TEXT);
    expect(JSON.stringify(records[0])).not.toContain("private.example");
  });

  it("严格拒绝未列入白名单的敏感字段", () => {
    const base = RunLogRecordSchema.parse({
      schemaVersion: "run-log.v1",
      createdAt: "2026-10-22T00:00:00.000Z",
      identifiers: {
        logId: IDS[0],
        queryId: IDS[1],
        planId: null,
      },
      outcome: "failed",
      timingsMs: {
        planning: null,
        nodeProcessing: null,
        total: 0,
        provider: { search: 0, extract: 0, llm: 0 },
      },
      counts: {
        plannedNodes: 0,
        edges: 0,
        resources: 0,
        readyNodes: 0,
        partialNodes: 0,
        failedNodes: 0,
        logicalSearchCalls: 0,
        logicalExtractCalls: 0,
        extractUrlCount: 0,
        logicalLlmCalls: 0,
        searchResultCount: 0,
        extractedPageCount: 0,
        searchHttpAttempts: 0,
        extractHttpAttempts: 0,
      },
      warningCodes: [],
      errorCodes: ["UNKNOWN"],
      versions: {
        protocol: "0.1",
        resultGraph: "0.1",
        plannerPrompt: "graph-planner.v1",
        reviserPrompt: "graph-reviser.v2",
        rerankerPrompt: "resource-reranker.v1",
      },
      providers: { search: "fake-search", llm: "fake-llm" },
      cache: {
        search: { hitCount: 0, missCount: 0 },
        extract: { hitCount: 0, missCount: 0 },
      },
      tokens: {
        status: "not_used",
        observations: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      estimatedCost: {
        status: "unavailable",
        reason: "pricing_not_frozen",
      },
    });

    expect(() =>
      RunLogRecordSchema.parse({
        ...base,
        rawQuery: SENSITIVE_TEXT,
      }),
    ).toThrow();
    expect(() =>
      RunLogRecordSchema.parse({
        ...base,
        authorization: "Bearer secret",
      }),
    ).toThrow();
  });

  it("失败与取消只记录稳定 Code，不保存 Error 对象", async () => {
    const records: RunLogRecord[] = [];
    let idIndex = 0;
    const recorder = createRunLogRecorder({
      sink: {
        write: async record => {
          records.push(record);
        },
      },
      searchProviderId: "fake-search",
      llmProviderId: "fake-llm",
      startedAt: Date.parse("2026-10-22T00:00:00.000Z"),
      createId: () => IDS[idIndex++]!,
    });

    recorder.recordProviderCallStarted("llm");
    recorder.recordEvent({
      type: "node.failed",
      nodeId: "node-1",
      error: { code: "SEARCH_PROVIDER_FAILED", retryable: true },
    });
    recorder.recordEvent({
      type: "run.failed",
      error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
    });
    // 已有合法 run.failed 后，finally 的取消观察不能覆盖真实失败终态。
    recorder.recordInterrupted(true);
    await recorder.finish();

    expect(records[0]).toMatchObject({
      outcome: "failed",
      errorCodes: ["SEARCH_PROVIDER_FAILED", "RUN_DEADLINE_EXCEEDED"],
      tokens: { status: "unavailable", observations: 0 },
    });
    expect(JSON.stringify(records[0])).not.toContain("stack");
    expect(JSON.stringify(records[0])).not.toContain("cause");
    expect(JSON.stringify(records[0])).not.toContain("message");
  });

  it("没有业务终态的用户取消收敛为 REQUEST_ABORTED", async () => {
    const records: RunLogRecord[] = [];
    let idIndex = 0;
    const recorder = createRunLogRecorder({
      sink: {
        write: async record => {
          records.push(record);
        },
      },
      searchProviderId: "fake-search",
      llmProviderId: "fake-llm",
      startedAt: Date.parse("2026-10-22T00:00:00.000Z"),
      createId: () => IDS[idIndex++]!,
    });

    recorder.recordInterrupted(true);
    await recorder.finish();

    expect(records[0]).toMatchObject({
      outcome: "cancelled",
      errorCodes: ["REQUEST_ABORTED"],
    });
  });

  it("Sink 或诊断出口失败时只报告一次且不向调用方抛出", async () => {
    const onWriteFailure = vi.fn(() => {
      throw new Error("二级诊断失败");
    });
    let idIndex = 0;
    const recorder = createRunLogRecorder({
      sink: {
        write: async () => {
          throw new Error(SENSITIVE_TEXT);
        },
      },
      searchProviderId: "fake-search",
      llmProviderId: "fake-llm",
      startedAt: Date.parse("2026-10-22T00:00:00.000Z"),
      createId: () => IDS[idIndex++]!,
      onWriteFailure,
    });

    await expect(recorder.finish()).resolves.toBeUndefined();
    await expect(recorder.finish()).resolves.toBeUndefined();
    expect(onWriteFailure).toHaveBeenCalledTimes(1);
  });
});
