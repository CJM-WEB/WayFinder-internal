/**
 * 测试职责：冻结 WAY-57 的单 Node Pipeline、Warning 合并与唯一终态语义。
 *
 * 关键约束：ready/partial 返回完整且通过 Contract 的 Node；普通失败只发一次
 * node.failed；取消由上层接管；任何处理中事件都不得携带 Resource 快照。
 */
import {
  ResultGraphNodeSchema,
  StreamEventPayloadSchema,
  type GraphPlanNode,
  type NormalizedSearchHit,
  type QueryAnalysis,
  type StreamEventPayload,
} from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import {
  createDeferred,
  FakeLLMProvider,
  FakeSearchProvider,
} from "../../../../tests/support/test-infrastructure.mjs";
import { LLMProviderError } from "../ai/llm-provider.js";
import {
  NodeEventEmissionError,
  NodeJobError,
  processNode,
  toNodeJobError,
  type ProcessNodeContext,
} from "./process-node.js";

const ANALYSIS: QueryAnalysis = {
  intent: "learn",
  topic: "TypeScript compiler guide",
  freshnessSensitive: false,
  ambiguityLevel: "low",
  presentationMode: "compact",
  broadSearchQueries: [],
  strategy: "plan_first",
};

function createNode(queries: string[] = ["TypeScript compiler guide"]): GraphPlanNode {
  return {
    id: "typescript-guide",
    title: "TypeScript compiler guide",
    description: "Learn TypeScript compiler options",
    nodeType: "primary",
    layer: 0,
    searchPlan: {
      queries,
      maxResults: Math.floor(20 / queries.length),
      rankingProfile: "knowledge",
      providerHints: ["general"],
    },
    status: "planned",
  };
}

function createHit(
  query = "TypeScript compiler guide",
  overrides: Partial<NormalizedSearchHit> = {},
): NormalizedSearchHit {
  const url = "https://docs.example.com/typescript/compiler";
  return {
    provider: "fake-search",
    query,
    title: "TypeScript compiler guide",
    url,
    canonicalUrl: url,
    domain: "docs.example.com",
    snippet: "Learn TypeScript compiler options with practical examples.",
    providerRank: 1,
    providerScore: 0.9,
    rawMetadata: { privateProviderValue: "must-not-leak" },
    ...overrides,
  };
}

function createRerankOutput() {
  return {
    ranking: [
      {
        candidateId: "candidate_1",
        scores: {
          relevance: 0.95,
          authority: 0.9,
          clarity: 0.85,
          completeness: 0.8,
          trustSafety: 0.95,
          freshness: 0.7,
        },
        summary: "TypeScript 编译器选项的结构化教程。",
        whySelected: "内容与当前节点直接相关且说明完整。",
      },
    ],
  };
}

function createContext(
  searchProvider: FakeSearchProvider,
  rerankProvider: FakeLLMProvider,
  events: StreamEventPayload[],
  overrides: Partial<ProcessNodeContext> = {},
): ProcessNodeContext {
  return {
    analysis: ANALYSIS,
    tavilyProvider: searchProvider,
    rerankProvider,
    officialSourcePolicy: { knownRiskyDownloadDomains: [] },
    nowMs: Date.parse("2026-10-22T00:00:00.000Z"),
    rerankTimeoutMs: 10_000,
    emit(payload) {
      events.push(structuredClone(payload));
    },
    ...overrides,
  };
}

function terminalEvents(events: readonly StreamEventPayload[]) {
  return events.filter(event =>
    ["node.ready", "node.partial", "node.failed"].includes(event.type),
  );
}

describe("processNode 成功与局部降级", () => {
  it("组装全部阶段并返回 ready，同时只发送一个携带最终 Resource 的终态", async () => {
    const hit = createHit();
    const searchProvider = new FakeSearchProvider({
      searchResponses: { [hit.query]: [hit] },
      extractResponse: [
        {
          canonicalUrl: hit.canonicalUrl,
          content: "The compiler guide explains all relevant options.",
        },
      ],
    });
    const rerankProvider = new FakeLLMProvider([createRerankOutput()]);
    const events: StreamEventPayload[] = [];

    const result = await processNode(
      createNode(),
      createContext(searchProvider, rerankProvider, events),
      new AbortController().signal,
    );

    expect(ResultGraphNodeSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      id: "typescript-guide",
      status: "ready",
      warnings: [],
    });
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]).toMatchObject({
      canonicalUrl: hit.canonicalUrl,
      domain: "docs.example.com",
      rank: 1,
      searchProvider: "fake-search",
      summary: "TypeScript 编译器选项的结构化教程。",
    });
    expect(JSON.stringify(result)).not.toContain("privateProviderValue");
    expect(events.map(event => event.type)).toEqual([
      "node.status",
      "node.status",
      "node.ready",
    ]);
    expect(events.slice(0, 2)).toEqual([
      {
        type: "node.status",
        nodeId: "typescript-guide",
        status: "searching",
      },
      {
        type: "node.status",
        nodeId: "typescript-guide",
        status: "filtering",
      },
    ]);
    expect(terminalEvents(events)).toHaveLength(1);
    expect(events.every(event => StreamEventPayloadSchema.safeParse(event).success))
      .toBe(true);
  });

  it("按阶段顺序合并三个唯一 Warning，并以完整 Resource 返回 partial", async () => {
    const node = createNode(["TypeScript compiler guide", "backup query"]);
    const hit = createHit(node.searchPlan.queries[0]);
    const searchProvider = new FakeSearchProvider({
      searchResponses: {
        [node.searchPlan.queries[0]!]: [hit],
        [node.searchPlan.queries[1]!]: new Error("search unavailable"),
      },
      // 请求的候选没有对应正文，构成局部 Extract 降级。
      extractResponse: [],
    });
    const rerankProvider = new FakeLLMProvider([
      new LLMProviderError("provider_failure", true),
    ]);
    const events: StreamEventPayload[] = [];

    const result = await processNode(
      node,
      createContext(searchProvider, rerankProvider, events),
      new AbortController().signal,
    );

    expect(ResultGraphNodeSchema.parse(result)).toEqual(result);
    expect(result.status).toBe("partial");
    expect(result.resources).toHaveLength(1);
    expect(result.warnings).toEqual([
      "SEARCH_PROVIDER_PARTIAL",
      "EXTRACTION_FAILED",
      "RERANK_FAILED",
    ]);
    expect(events.map(event => event.type)).toEqual([
      "node.status",
      "node.status",
      "node.partial",
    ]);
    expect(terminalEvents(events)).toEqual([
      {
        type: "node.partial",
        nodeId: node.id,
        resources: result.resources,
        warnings: result.warnings,
      },
    ]);
  });
});

describe("processNode 失败与取消", () => {
  it("所有 Search 都无结果时发送精确 node.failed 并抛可重试错误", async () => {
    const node = createNode();
    const searchProvider = new FakeSearchProvider({
      searchResponses: { [node.searchPlan.queries[0]!]: [] },
    });
    const events: StreamEventPayload[] = [];

    const operation = processNode(
      node,
      createContext(
        searchProvider,
        new FakeLLMProvider([createRerankOutput()]),
        events,
      ),
      new AbortController().signal,
    );

    await expect(operation).rejects.toMatchObject({
      name: "NodeJobError",
      code: "SEARCH_PROVIDER_FAILED",
      retryable: true,
    });
    expect(events).toEqual([
      {
        type: "node.status",
        nodeId: node.id,
        status: "searching",
      },
      {
        type: "node.failed",
        nodeId: node.id,
        error: { code: "SEARCH_PROVIDER_FAILED", retryable: true },
      },
    ]);
    expect(terminalEvents(events)).toHaveLength(1);
  });

  it("全部候选被确定性过滤后仍是无 Resource 的 Search 失败", async () => {
    const node = createNode();
    const hit = createHit(node.searchPlan.queries[0], { snippet: "" });
    const searchProvider = new FakeSearchProvider({
      searchResponses: { [node.searchPlan.queries[0]!]: [hit] },
      extractResponse: [],
    });
    const events: StreamEventPayload[] = [];

    await expect(
      processNode(
        node,
        createContext(
          searchProvider,
          new FakeLLMProvider([createRerankOutput()]),
          events,
        ),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "SEARCH_PROVIDER_FAILED",
      retryable: true,
    });
    expect(events.map(event => event.type)).toEqual([
      "node.status",
      "node.status",
      "node.failed",
    ]);
    expect(terminalEvents(events)).toHaveLength(1);
  });

  it("内部未知错误收敛为不可重试 UNKNOWN，且公共事件不泄漏 cause", async () => {
    const node = createNode();
    const hit = createHit(node.searchPlan.queries[0]);
    const searchProvider = new FakeSearchProvider({
      searchResponses: { [node.searchPlan.queries[0]!]: [hit] },
    });
    const events: StreamEventPayload[] = [];

    await expect(
      processNode(
        node,
        createContext(
          searchProvider,
          new FakeLLMProvider([createRerankOutput()]),
          events,
          {
            officialSourcePolicy: {
              knownRiskyDownloadDomains: ["https://invalid-policy.example"],
            },
          },
        ),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN", retryable: false });
    expect(terminalEvents(events)).toEqual([
      {
        type: "node.failed",
        nodeId: node.id,
        error: { code: "UNKNOWN", retryable: false },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("invalid-policy");
  });

  it("等待 Search 时取消会原样抛出 reason，且不发送任何终态", async () => {
    const node = createNode();
    const pending = createDeferred<readonly NormalizedSearchHit[]>();
    const searchProvider = new FakeSearchProvider({
      searchResponses: { [node.searchPlan.queries[0]!]: pending.promise },
    });
    const events: StreamEventPayload[] = [];
    const controller = new AbortController();
    const reason = new Error("run cancelled");
    const operation = processNode(
      node,
      createContext(
        searchProvider,
        new FakeLLMProvider([createRerankOutput()]),
        events,
      ),
      controller.signal,
    );

    controller.abort(reason);

    await expect(operation).rejects.toBe(reason);
    expect(events).toEqual([
      {
        type: "node.status",
        nodeId: node.id,
        status: "searching",
      },
    ]);
    expect(terminalEvents(events)).toEqual([]);
  });

  it("调用前已经取消时不发送进度或终态，并保留 Deadline reason 身份", async () => {
    const node = createNode();
    const events: StreamEventPayload[] = [];
    const controller = new AbortController();
    const reason = new DOMException("run deadline", "TimeoutError");
    controller.abort(reason);

    const operation = processNode(
      node,
      createContext(
        new FakeSearchProvider({
          searchResponses: { [node.searchPlan.queries[0]!]: [] },
        }),
        new FakeLLMProvider([createRerankOutput()]),
        events,
      ),
      controller.signal,
    );

    await expect(operation).rejects.toBe(reason);
    expect(events).toEqual([]);
  });

  it("进度 Emit 失败属于传输故障，不得补发 node.failed", async () => {
    const node = createNode();
    const events: StreamEventPayload[] = [];
    const emitError = new Error("event sink unavailable");
    const baseContext = createContext(
      new FakeSearchProvider({
        searchResponses: { [node.searchPlan.queries[0]!]: [] },
      }),
      new FakeLLMProvider([createRerankOutput()]),
      events,
    );

    const operation = processNode(
      node,
      {
        ...baseContext,
        emit(payload) {
          events.push(structuredClone(payload));
          throw emitError;
        },
      },
      new AbortController().signal,
    );

    await expect(operation).rejects.toMatchObject({
      name: "NodeEventEmissionError",
      cause: emitError,
    });
    expect(events.map(event => event.type)).toEqual(["node.status"]);
    expect(terminalEvents(events)).toEqual([]);
  });

  it("ready 终态的 Emit 抛错时不会再补发第二个 failed 终态", async () => {
    const node = createNode();
    const hit = createHit(node.searchPlan.queries[0]);
    const searchProvider = new FakeSearchProvider({
      searchResponses: { [node.searchPlan.queries[0]!]: [hit] },
      extractResponse: [
        { canonicalUrl: hit.canonicalUrl, content: "Compiler reference" },
      ],
    });
    const events: StreamEventPayload[] = [];
    const emitError = new Error("stream transport closed");
    const baseContext = createContext(
      searchProvider,
      new FakeLLMProvider([createRerankOutput()]),
      events,
    );

    await expect(
      processNode(
        node,
        {
          ...baseContext,
          emit(payload) {
            events.push(structuredClone(payload));
            if (payload.type === "node.ready") {
              throw emitError;
            }
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "NodeEventEmissionError",
      cause: emitError,
    });
    expect(terminalEvents(events).map(event => event.type)).toEqual([
      "node.ready",
    ]);
  });

  it("failed 终态 Emit 失败时只尝试一次，并作为传输故障上抛", async () => {
    const node = createNode();
    const events: StreamEventPayload[] = [];
    const emitError = new Error("failed event rejected");
    const baseContext = createContext(
      new FakeSearchProvider({
        searchResponses: { [node.searchPlan.queries[0]!]: [] },
      }),
      new FakeLLMProvider([createRerankOutput()]),
      events,
    );

    const operation = processNode(
      node,
      {
        ...baseContext,
        emit(payload) {
          events.push(structuredClone(payload));
          if (payload.type === "node.failed") {
            throw emitError;
          }
        },
      },
      new AbortController().signal,
    );

    await expect(operation).rejects.toBeInstanceOf(NodeEventEmissionError);
    expect(terminalEvents(events).map(event => event.type)).toEqual([
      "node.failed",
    ]);
  });
});

describe("NodeJobError 映射", () => {
  it("保留既有 NodeJobError，并把未知值收敛为 UNKNOWN", () => {
    const known = new NodeJobError("RERANK_FAILED", true);
    expect(toNodeJobError(known)).toBe(known);
    expect(toNodeJobError(new Error("private details"))).toMatchObject({
      code: "UNKNOWN",
      retryable: false,
    });
  });
});
