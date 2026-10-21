/**
 * 测试职责：冻结 WAY-47 的 Node Search（节点搜索）编排与逐 Query 结算语义。
 *
 * 关键约束：
 * - V0 不按 providerHints 扩增调用；每条 Query 恰好调用一次 Tavily，能力固定为 general；
 * - Node 汇总与逐 Query 明细都保持原 Query 顺序，局部失败只产生一个 Node Warning；
 * - 合并后没有 Hit 必须抛出结构化失败，Run 取消则原样传播取消 reason。
 */
import type {
  GraphPlanNode,
  NormalizedSearchHit,
  ProviderSearchRequest,
  SearchCapability,
} from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import type { SearchProvider } from "./provider.js";
import {
  NodeSearchError,
  runNodeSearches,
} from "./run-node-searches.js";

type SearchResponse = readonly NormalizedSearchHit[] | Error;

function createHit(query: string, suffix: string): NormalizedSearchHit {
  const url = `https://example.com/${suffix}`;
  return {
    provider: "tavily",
    query,
    title: `结果 ${suffix}`,
    url,
    canonicalUrl: url,
    domain: "example.com",
    snippet: `摘要 ${suffix}`,
    rawMetadata: {},
  };
}

function createRecordingProvider(
  responses: Readonly<Record<string, SearchResponse>>,
): SearchProvider & {
  calls: Array<{
    request: ProviderSearchRequest;
    signal: AbortSignal;
  }>;
} {
  const calls: Array<{
    request: ProviderSearchRequest;
    signal: AbortSignal;
  }> = [];

  return {
    id: "tavily",
    capabilities: ["general"] satisfies SearchCapability[],
    calls,
    async search(request, signal) {
      signal.throwIfAborted();
      calls.push({ request: structuredClone(request), signal });
      const response = responses[request.query];
      if (response === undefined) {
        throw new Error(`测试未配置 Query：${request.query}`);
      }
      if (response instanceof Error) {
        throw response;
      }
      return [...structuredClone(response)];
    },
  };
}

const NODE: Pick<GraphPlanNode, "id" | "searchPlan"> = {
  id: "node-001",
  searchPlan: {
    queries: ["query-a", "query-b"],
    maxResults: 10,
    rankingProfile: "general",
    providerHints: ["news", "code"],
  },
};

describe("runNodeSearches", () => {
  it("把每条 Query 恰好一次映射到统一 Tavily 请求", async () => {
    const signal = new AbortController().signal;
    const provider = createRecordingProvider({
      "query-a": [createHit("query-a", "a")],
      "query-b": [createHit("query-b", "b")],
    });

    await runNodeSearches({
      node: NODE,
      freshnessSensitive: true,
      language: "zh-CN",
      tavilyProvider: provider,
      signal,
    });

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls.map(call => call.request)).toEqual([
      {
        nodeId: "node-001",
        query: "query-a",
        maxResults: 10,
        capability: "general",
        freshnessSensitive: true,
        language: "zh-CN",
      },
      {
        nodeId: "node-001",
        query: "query-b",
        maxResults: 10,
        capability: "general",
        freshnessSensitive: true,
        language: "zh-CN",
      },
    ]);
    expect(provider.calls.every(call => call.signal === signal)).toBe(true);
  });

  it("执行层按 Query 数量重新计算配额，不信任调用方字段", async () => {
    const provider = createRecordingProvider({
      "query-a": [createHit("query-a", "a")],
      "query-b": [createHit("query-b", "b")],
    });
    const nodeWithUntrustedBudget: Pick<
      GraphPlanNode,
      "id" | "searchPlan"
    > = {
      ...NODE,
      searchPlan: {
        ...NODE.searchPlan,
        // 模拟绕过 Zod Contract 的内部调用方；执行配额仍不能被该值控制。
        maxResults: 20,
      },
    };

    await runNodeSearches({
      node: nodeWithUntrustedBudget,
      freshnessSensitive: false,
      tavilyProvider: provider,
      signal: new AbortController().signal,
    });

    expect(provider.calls.map(call => call.request.maxResults)).toEqual([
      10,
      10,
    ]);
  });

  it("同时返回 Node 汇总与按原顺序排列的逐 Query 结果", async () => {
    const hitA = createHit("query-a", "a");
    const hitB = createHit("query-b", "b");
    const provider = createRecordingProvider({
      "query-a": [hitA],
      "query-b": [hitB],
    });

    const outcome = await runNodeSearches({
      node: NODE,
      freshnessSensitive: false,
      tavilyProvider: provider,
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({
      hits: [hitA, hitB],
      warnings: [],
      queryOutcomes: [
        { query: "query-a", hits: [hitA], warnings: [] },
        { query: "query-b", hits: [hitB], warnings: [] },
      ],
    });
  });

  it("保留成功 Hit，并把失败精确标记到对应 Query", async () => {
    const hitA = createHit("query-a", "a");
    const provider = createRecordingProvider({
      "query-a": [hitA],
      "query-b": new Error("provider unavailable"),
    });

    const outcome = await runNodeSearches({
      node: NODE,
      freshnessSensitive: false,
      tavilyProvider: provider,
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({
      hits: [hitA],
      warnings: ["SEARCH_PROVIDER_PARTIAL"],
      queryOutcomes: [
        { query: "query-a", hits: [hitA], warnings: [] },
        {
          query: "query-b",
          hits: [],
          warnings: ["SEARCH_PROVIDER_PARTIAL"],
        },
      ],
    });
  });

  it.each([
    [
      "所有调用失败",
      {
        "query-a": new Error("failure-a"),
        "query-b": new Error("failure-b"),
      },
    ],
    ["所有调用都没有 Hit", { "query-a": [], "query-b": [] }],
    [
      "失败调用之外只有空结果",
      { "query-a": [], "query-b": new Error("failure-b") },
    ],
  ] as const)("%s时抛出 SEARCH_PROVIDER_FAILED", async (_name, responses) => {
    const provider = createRecordingProvider(responses);

    await expect(
      runNodeSearches({
        node: NODE,
        freshnessSensitive: false,
        tavilyProvider: provider,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      name: "NodeSearchError",
      code: "SEARCH_PROVIDER_FAILED",
      retryable: true,
    });
  });

  it("调用前已取消时原样传播 Run reason，且不消费 Provider", async () => {
    const controller = new AbortController();
    const reason = new Error("run deadline");
    controller.abort(reason);
    const provider = createRecordingProvider({
      "query-a": [createHit("query-a", "a")],
      "query-b": [createHit("query-b", "b")],
    });

    await expect(
      runNodeSearches({
        node: NODE,
        freshnessSensitive: false,
        tavilyProvider: provider,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(provider.calls).toHaveLength(0);
  });

  it("调用期间取消时也原样传播同一个 Run reason", async () => {
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    const provider: SearchProvider = {
      id: "tavily",
      capabilities: ["general"],
      search(_request, signal) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    };

    const outcomePromise = runNodeSearches({
      node: NODE,
      freshnessSensitive: false,
      tavilyProvider: provider,
      signal: controller.signal,
    });
    controller.abort(reason);

    await expect(outcomePromise).rejects.toBe(reason);
  });

  it("NodeSearchError 不携带 Provider 原始错误", () => {
    const error = new NodeSearchError();

    expect(error).toMatchObject({
      message: "SEARCH_PROVIDER_FAILED",
      code: "SEARCH_PROVIDER_FAILED",
      retryable: true,
    });
    expect(error.cause).toBeUndefined();
  });
});
