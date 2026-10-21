/**
 * 测试职责：冻结 WAY-41 Broad Discovery（广泛发现）的一轮并发搜索与 Evidence 边界。
 *
 * 关键约束：
 * - 只消费合法 evidence_assisted Analysis，每条 Broad Query 在本层恰好调用一次；
 * - 所有 Search 共享同一个 Run Signal，不创建重试、Extract 或第二套 Deadline；
 * - Evidence 只保留 CandidateSearchHit 白名单，部分失败可用，零 Evidence 显式失败。
 */
import type {
  NormalizedSearchHit,
  ProviderSearchRequest,
  SearchCapability,
} from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import {
  createAbortFixture,
  createDeferred,
  FakeSearchProvider,
} from "../../../../tests/support/test-infrastructure.mjs";
import type { SearchProvider } from "./provider.js";
import {
  BROAD_DISCOVERY_RESULTS_PER_QUERY,
  BroadDiscoveryError,
  discoverBroadEvidence,
  type EvidenceAssistedAnalysis,
} from "./broad-discovery.js";

function createAnalysis(
  broadSearchQueries: string[],
): EvidenceAssistedAnalysis {
  return {
    intent: "news",
    topic: "NVIDIA",
    freshnessSensitive: true,
    ambiguityLevel: "medium",
    broadSearchQueries,
    strategy: "evidence_assisted",
    presentationMode: "graph",
  };
}

function createHit(
  query: string,
  suffix: string,
  overrides: Partial<NormalizedSearchHit> = {},
): NormalizedSearchHit {
  const url = `https://example.com/${suffix}`;
  return {
    provider: "fake-search",
    query,
    title: `结果 ${suffix}`,
    url,
    canonicalUrl: url,
    domain: "example.com",
    snippet: `摘要 ${suffix}`,
    providerRank: 1,
    providerScore: 0.8,
    rawMetadata: { secret: `private-${suffix}` },
    ...overrides,
  };
}

describe("discoverBroadEvidence", () => {
  it("以 broad_discovery 请求一条 Query，并强制每条最多保留 5 条白名单 Evidence", async () => {
    const query = "NVIDIA latest news";
    const hits = Array.from({ length: 6 }, (_value, index) =>
      createHit(query, String(index + 1)),
    );
    const provider = new FakeSearchProvider({
      searchResponses: { [query]: hits },
    });
    const signal = new AbortController().signal;

    const evidence = await discoverBroadEvidence({
      analysis: createAnalysis([query]),
      provider,
      signal,
      language: "en",
    });

    expect(provider.searchCalls).toEqual([
      {
        request: {
          kind: "broad_discovery",
          query,
          maxResults: BROAD_DISCOVERY_RESULTS_PER_QUERY,
          capability: "general",
          freshnessSensitive: true,
          language: "en",
        },
        signal,
      },
    ]);
    expect(provider.extractCalls).toHaveLength(0);
    expect(evidence).toHaveLength(BROAD_DISCOVERY_RESULTS_PER_QUERY);
    expect(evidence[0]).toEqual({
      provider: "fake-search",
      query,
      title: "结果 1",
      url: "https://example.com/1",
      canonicalUrl: "https://example.com/1",
      domain: "example.com",
      snippet: "摘要 1",
      providerRank: 1,
      providerScore: 0.8,
    });
    expect(JSON.stringify(evidence)).not.toContain("private-");
    expect(JSON.stringify(evidence)).not.toContain("rawMetadata");
  });

  it("并发启动三条 Query 各一次，并按 Query 与 Provider 原顺序稳定展平", async () => {
    const queries = ["query-a", "query-b", "query-c"];
    const deferredA = createDeferred<readonly NormalizedSearchHit[]>();
    const deferredB = createDeferred<readonly NormalizedSearchHit[]>();
    const deferredC = createDeferred<readonly NormalizedSearchHit[]>();
    const provider = new FakeSearchProvider({
      searchResponses: {
        "query-a": deferredA.promise,
        "query-b": deferredB.promise,
        "query-c": deferredC.promise,
      },
    });
    const signal = new AbortController().signal;

    const outcome = discoverBroadEvidence({
      analysis: createAnalysis(queries),
      provider,
      signal,
    });
    await Promise.resolve();

    expect(provider.searchCalls.map(call => call.request.query)).toEqual(
      queries,
    );
    expect(provider.searchCalls.map(call => call.signal)).toEqual([
      signal,
      signal,
      signal,
    ]);
    deferredC.resolve([createHit("query-c", "c")]);
    deferredB.resolve([createHit("query-b", "b-1"), createHit("query-b", "b-2")]);
    deferredA.resolve([createHit("query-a", "a")]);

    await expect(outcome).resolves.toEqual([
      expect.objectContaining({ query: "query-a", title: "结果 a" }),
      expect.objectContaining({ query: "query-b", title: "结果 b-1" }),
      expect.objectContaining({ query: "query-b", title: "结果 b-2" }),
      expect.objectContaining({ query: "query-c", title: "结果 c" }),
    ]);
  });

  it("部分 Query 失败时保留其他 Query 的成功 Evidence，且不自行重试", async () => {
    const provider = new FakeSearchProvider({
      searchResponses: {
        "query-a": [createHit("query-a", "a")],
        "query-b": new Error("provider-secret"),
        "query-c": [createHit("query-c", "c")],
      },
    });

    const evidence = await discoverBroadEvidence({
      analysis: createAnalysis(["query-a", "query-b", "query-c"]),
      provider,
      signal: new AbortController().signal,
    });

    expect(provider.searchCalls).toHaveLength(3);
    expect(evidence.map(hit => hit.query)).toEqual(["query-a", "query-c"]);
    expect(JSON.stringify(evidence)).not.toContain("provider-secret");
  });

  it("Provider 同步抛错也只隔离到对应 Query，不阻止其他 Query 启动", async () => {
    const calls: string[] = [];
    const provider: SearchProvider = {
      id: "sync-throw-provider",
      capabilities: ["general"],
      search(request) {
        calls.push(request.query);
        if (request.query === "query-a") {
          throw new Error("sync-provider-secret");
        }
        return Promise.resolve([createHit(request.query, "b")]);
      },
    };

    const evidence = await discoverBroadEvidence({
      analysis: createAnalysis(["query-a", "query-b"]),
      provider,
      signal: new AbortController().signal,
    });

    expect(calls).toEqual(["query-a", "query-b"]);
    expect(evidence).toEqual([
      expect.objectContaining({ query: "query-b", title: "结果 b" }),
    ]);
    expect(JSON.stringify(evidence)).not.toContain("sync-provider-secret");
  });

  it.each([
    ["全部调用失败", { "query-a": new Error("a"), "query-b": new Error("b") }],
    ["全部返回空结果", { "query-a": [], "query-b": [] }],
    ["失败之外只有空结果", { "query-a": [], "query-b": new Error("b") }],
  ] as const)("%s时抛出脱敏 BroadDiscoveryError", async (_name, responses) => {
    const provider = new FakeSearchProvider({ searchResponses: responses });

    await expect(
      discoverBroadEvidence({
        analysis: createAnalysis(["query-a", "query-b"]),
        provider,
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(new BroadDiscoveryError());
    expect(provider.searchCalls).toHaveLength(2);
  });

  it.each([
    { queries: [] },
    { queries: ["q1", "q2", "q3", "q4"] },
  ])(
    "运行时拒绝 $queries.length 条 Broad Query，且不调用 Provider",
    async ({ queries }) => {
      const provider = new FakeSearchProvider({ searchResponses: {} });

      await expect(
        discoverBroadEvidence({
          analysis: createAnalysis(queries),
          provider,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(TypeError);
      expect(provider.searchCalls).toHaveLength(0);
    },
  );

  it("运行时拒绝 plan_first Analysis，且不调用 Provider", async () => {
    const provider = new FakeSearchProvider({ searchResponses: {} });
    const planFirstAnalysis = {
      ...createAnalysis([]),
      broadSearchQueries: [],
      strategy: "plan_first",
    } as unknown as EvidenceAssistedAnalysis;

    await expect(
      discoverBroadEvidence({
        analysis: planFirstAnalysis,
        provider,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(TypeError);
    expect(provider.searchCalls).toHaveLength(0);
  });

  it("调用前已取消时原样抛出 reason，且不调用 Provider", async () => {
    const abortFixture = createAbortFixture();
    abortFixture.abort();
    const provider = new FakeSearchProvider({
      searchResponses: { query: [createHit("query", "unused")] },
    });

    await expect(
      discoverBroadEvidence({
        analysis: createAnalysis(["query"]),
        provider,
        signal: abortFixture.signal,
      }),
    ).rejects.toBe(abortFixture.reason);
    expect(provider.searchCalls).toHaveLength(0);
  });

  it("等待 Provider 期间取消时原样抛出同一个 Run reason", async () => {
    const abortFixture = createAbortFixture();
    const deferred = createDeferred<readonly NormalizedSearchHit[]>();
    const provider = new FakeSearchProvider({
      searchResponses: { query: deferred.promise },
    });

    const outcome = discoverBroadEvidence({
      analysis: createAnalysis(["query"]),
      provider,
      signal: abortFixture.signal,
    });
    abortFixture.abort();

    await expect(outcome).rejects.toBe(abortFixture.reason);
    expect(provider.searchCalls).toHaveLength(1);
  });

  it("Provider 忽略取消并返回成功时仍在 await 后原样终止", async () => {
    const controller = new AbortController();
    const reason = new Error("run deadline");
    const requests: ProviderSearchRequest[] = [];
    const provider: SearchProvider = {
      id: "abort-ignoring-provider",
      capabilities: ["general"] satisfies SearchCapability[],
      search(request) {
        requests.push(request);
        controller.abort(reason);
        return Promise.resolve([createHit(request.query, "late")]);
      },
    };

    await expect(
      discoverBroadEvidence({
        analysis: createAnalysis(["query"]),
        provider,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(requests).toHaveLength(1);
  });
});
