/**
 * 测试职责：冻结 WAY-60 进程内 Search Cache（缓存）的确定性语义。
 *
 * 关键边界：Key 不保存明文 Query/URL/Secret；TTL 非滑动；取消与 Provider 错误
 * 不写缓存；命中观察不携带用户或网页内容。
 */
import type { NormalizedSearchHit, ProviderSearchRequest } from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createMemoryCachedSearchProvider,
  createSearchCacheKey,
  SEARCH_CACHE_MAX_ENTRY_SIZE_BYTES,
  SEARCH_CACHE_TTL_MS,
  type SearchProviderCacheObservation,
} from "./memory-cached-provider.js";
import type { SearchProvider } from "./provider.js";

const BASE_REQUEST: ProviderSearchRequest = {
  kind: "node",
  nodeId: "node-a",
  query: "TypeScript handbook",
  maxResults: 10,
  capability: "general",
  freshnessSensitive: false,
  language: "zh-CN",
};

function createHit(query: string, suffix = "handbook"): NormalizedSearchHit {
  const canonicalUrl = `https://example.com/${suffix}`;
  return {
    provider: "test-provider",
    query,
    title: `结果 ${suffix}`,
    url: canonicalUrl,
    canonicalUrl,
    domain: "example.com",
    snippet: `摘要 ${suffix}`,
    rawMetadata: { nested: { stable: true } },
  };
}

function createProvider(input?: {
  id?: string;
  search?: SearchProvider["search"];
}): SearchProvider {
  return {
    id: input?.id ?? "test-provider",
    capabilities: ["general"],
    search:
      input?.search ??
      (async request => [createHit(request.query)]),
  };
}

describe("MemoryCachedSearchProvider", () => {
  it("为稳定 Search Key 复用结果，并隔离调用方对返回值的修改", async () => {
    const search = vi.fn<SearchProvider["search"]>(async request => [
      createHit(request.query),
    ]);
    const observations: SearchProviderCacheObservation[] = [];
    const provider = createMemoryCachedSearchProvider(
      createProvider({ search }),
      { onObservation: observation => observations.push(observation) },
    );
    const signal = new AbortController().signal;

    const first = await provider.search(BASE_REQUEST, signal);
    first[0]!.title = "被调用方修改";
    (first[0]!.rawMetadata.nested as { stable: boolean }).stable = false;

    const second = await provider.search(BASE_REQUEST, signal);

    expect(search).toHaveBeenCalledOnce();
    expect(second).toEqual([createHit(BASE_REQUEST.query)]);
    expect(observations).toEqual([
      { operation: "search", hitCount: 0, missCount: 1 },
      { operation: "search", hitCount: 1, missCount: 0 },
    ]);
  });

  it("Search Key 排除 nodeId，但所有检索语义字段和 Provider 都参与隔离", () => {
    const sameSemanticsDifferentNode: ProviderSearchRequest = {
      ...BASE_REQUEST,
      nodeId: "node-b",
    };
    expect(createSearchCacheKey("provider-a", BASE_REQUEST)).toBe(
      createSearchCacheKey("provider-a", sameSemanticsDifferentNode),
    );

    const variants: ProviderSearchRequest[] = [
      { ...BASE_REQUEST, query: "TypeScript docs" },
      { ...BASE_REQUEST, maxResults: 5 },
      { ...BASE_REQUEST, capability: "code" },
      { ...BASE_REQUEST, freshnessSensitive: true },
      { ...BASE_REQUEST, language: "en-US" },
      {
        kind: "broad_discovery",
        query: BASE_REQUEST.query,
        maxResults: BASE_REQUEST.maxResults,
        capability: BASE_REQUEST.capability,
        freshnessSensitive: BASE_REQUEST.freshnessSensitive,
        language: BASE_REQUEST.language,
      },
    ];
    for (const variant of variants) {
      expect(createSearchCacheKey("provider-a", variant)).not.toBe(
        createSearchCacheKey("provider-a", BASE_REQUEST),
      );
    }
    expect(createSearchCacheKey("provider-b", BASE_REQUEST)).not.toBe(
      createSearchCacheKey("provider-a", BASE_REQUEST),
    );
  });

  it("Key 只暴露版本化摘要，不包含 Query 明文", () => {
    const searchKey = createSearchCacheKey("private-provider", {
      ...BASE_REQUEST,
      query: "sensitive query text",
    });
    expect(searchKey).toMatch(/^search-v1:[a-f0-9]{64}$/u);
    expect(searchKey).not.toContain("sensitive");
  });

  it("Search TTL 从写入开始且命中不续期，边界时重新委托 Provider", async () => {
    let nowMs = 1_000;
    let searchCallCount = 0;
    const search = vi.fn<SearchProvider["search"]>(async request => {
      searchCallCount += 1;
      return [createHit(request.query, `call-${searchCallCount}`)];
    });
    const provider = createMemoryCachedSearchProvider(
      createProvider({ search }),
      { nowMs: () => nowMs },
    );
    const signal = new AbortController().signal;

    const first = await provider.search(BASE_REQUEST, signal);
    nowMs += SEARCH_CACHE_TTL_MS - 1;
    expect(await provider.search(BASE_REQUEST, signal)).toEqual(first);
    nowMs += 1;
    const expired = await provider.search(BASE_REQUEST, signal);

    expect(search).toHaveBeenCalledTimes(2);
    expect(expired).not.toEqual(first);
  });

  it("Search Hit 会更新 LRU 次序，并淘汰最久未使用项", async () => {
    const search = vi.fn<SearchProvider["search"]>(async request => [
      createHit(request.query, request.query),
    ]);
    const provider = createMemoryCachedSearchProvider(
      createProvider({ search }),
      { searchMaxEntries: 2 },
    );
    const signal = new AbortController().signal;
    const requestB = { ...BASE_REQUEST, query: "B" };
    const requestC = { ...BASE_REQUEST, query: "C" };

    await provider.search(BASE_REQUEST, signal);
    await provider.search(requestB, signal);
    await provider.search(BASE_REQUEST, signal);
    await provider.search(requestC, signal);
    await provider.search(BASE_REQUEST, signal);
    await provider.search(requestB, signal);

    expect(search.mock.calls.map(call => call[0].query)).toEqual([
      BASE_REQUEST.query,
      "B",
      "C",
      "B",
    ]);
  });

  it("Search 成功空数组可以缓存，异常不缓存", async () => {
    const providerError = new Error("provider failed");
    const search = vi
      .fn<SearchProvider["search"]>()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(providerError)
      .mockResolvedValueOnce([createHit("retry", "retry")]);
    const provider = createMemoryCachedSearchProvider(
      createProvider({ search }),
    );
    const signal = new AbortController().signal;

    expect(await provider.search(BASE_REQUEST, signal)).toEqual([]);
    expect(await provider.search(BASE_REQUEST, signal)).toEqual([]);
    const retryRequest = { ...BASE_REQUEST, query: "retry" };
    await expect(provider.search(retryRequest, signal)).rejects.toBe(
      providerError,
    );
    await expect(provider.search(retryRequest, signal)).resolves.toEqual([
      createHit("retry", "retry"),
    ]);
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("Search 值不可复制时保持成功并跳过缓存", async () => {
    const hit = createHit(BASE_REQUEST.query);
    hit.rawMetadata = { notCloneable: () => true };
    const search = vi.fn<SearchProvider["search"]>(async () => [hit]);
    const provider = createMemoryCachedSearchProvider(
      createProvider({ search }),
    );
    const signal = new AbortController().signal;

    expect((await provider.search(BASE_REQUEST, signal))[0]).toBe(hit);
    expect((await provider.search(BASE_REQUEST, signal))[0]).toBe(hit);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("Search 单项超过大小上限时正常返回但不缓存", async () => {
    const oversizedHit = {
      ...createHit(BASE_REQUEST.query),
      snippet: "x".repeat(SEARCH_CACHE_MAX_ENTRY_SIZE_BYTES + 1),
    };
    const search = vi.fn<SearchProvider["search"]>(async () => [
      oversizedHit,
    ]);
    const provider = createMemoryCachedSearchProvider(
      createProvider({ search }),
    );
    const signal = new AbortController().signal;

    expect(await provider.search(BASE_REQUEST, signal)).toEqual([
      oversizedHit,
    ]);
    expect(await provider.search(BASE_REQUEST, signal)).toEqual([
      oversizedHit,
    ]);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "ArrayBuffer",
      () => new ArrayBuffer(SEARCH_CACHE_MAX_ENTRY_SIZE_BYTES + 1),
    ],
    [
      "Map",
      () =>
        new Map([
          ["payload", "x".repeat(SEARCH_CACHE_MAX_ENTRY_SIZE_BYTES + 1)],
        ]),
    ],
  ])("Search %s metadata 不能绕过字节预算", async (_name, metadata) => {
    const search = vi.fn<SearchProvider["search"]>(async () => {
      const hit = createHit(BASE_REQUEST.query);
      hit.rawMetadata = { opaque: metadata() };
      return [hit];
    });
    const provider = createMemoryCachedSearchProvider(
      createProvider({ search }),
    );
    const signal = new AbortController().signal;

    await provider.search(BASE_REQUEST, signal);
    await provider.search(BASE_REQUEST, signal);

    expect(search).toHaveBeenCalledTimes(2);
  });

  it("Search 共享内存无法安全隔离时跳过缓存", async () => {
    const search = vi.fn<SearchProvider["search"]>(async () => {
      const shared = new SharedArrayBuffer(1);
      new Uint8Array(shared)[0] = 7;
      const hit = createHit(BASE_REQUEST.query);
      hit.rawMetadata = { shared };
      return [hit];
    });
    const provider = createMemoryCachedSearchProvider(
      createProvider({ search }),
    );
    const signal = new AbortController().signal;

    const first = await provider.search(BASE_REQUEST, signal);
    const firstShared = first[0]!.rawMetadata.shared as SharedArrayBuffer;
    new Uint8Array(firstShared)[0] = 99;
    const second = await provider.search(BASE_REQUEST, signal);
    const secondShared = second[0]!.rawMetadata.shared as SharedArrayBuffer;

    expect(new Uint8Array(secondShared)[0]).toBe(7);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("预先取消即使已有 Hit 也传播原 reason，Provider 晚到结果不得写缓存", async () => {
    const cachedSearch = vi.fn<SearchProvider["search"]>(async request => [
      createHit(request.query),
    ]);
    const cachedProvider = createMemoryCachedSearchProvider(
      createProvider({ search: cachedSearch }),
    );
    await cachedProvider.search(
      BASE_REQUEST,
      new AbortController().signal,
    );
    const preAborted = new AbortController();
    const preAbortReason = new Error("pre-aborted");
    preAborted.abort(preAbortReason);
    await expect(
      cachedProvider.search(BASE_REQUEST, preAborted.signal),
    ).rejects.toBe(preAbortReason);
    expect(cachedSearch).toHaveBeenCalledOnce();

    let resolveLate: ((hits: NormalizedSearchHit[]) => void) | undefined;
    const lateSearch = vi.fn<SearchProvider["search"]>(
      () =>
        new Promise(resolve => {
          resolveLate = resolve;
        }),
    );
    const lateProvider = createMemoryCachedSearchProvider(
      createProvider({ search: lateSearch }),
    );
    const lateController = new AbortController();
    const lateReason = new Error("deadline");
    const pending = lateProvider.search(BASE_REQUEST, lateController.signal);
    lateController.abort(lateReason);
    resolveLate?.([createHit(BASE_REQUEST.query, "late")]);
    await expect(pending).rejects.toBe(lateReason);

    const retry = lateProvider.search(
      BASE_REQUEST,
      new AbortController().signal,
    );
    resolveLate?.([createHit(BASE_REQUEST.query, "retry")]);
    await expect(retry).resolves.toEqual([
      createHit(BASE_REQUEST.query, "retry"),
    ]);
    expect(lateSearch).toHaveBeenCalledTimes(2);
  });

  it("观察器只接收脱敏计数，观察器失败不改变业务结果", async () => {
    const observations: SearchProviderCacheObservation[] = [];
    const search = vi.fn<SearchProvider["search"]>(async request => [
      createHit(request.query),
    ]);
    const provider = createMemoryCachedSearchProvider(
      createProvider({ search }),
      {
        onObservation: observation => {
          observations.push(observation);
          throw new Error("observer unavailable");
        },
      },
    );

    await expect(
      provider.search(BASE_REQUEST, new AbortController().signal),
    ).resolves.toEqual([createHit(BASE_REQUEST.query)]);
    expect(Object.keys(observations[0]!).sort()).toEqual([
      "hitCount",
      "missCount",
      "operation",
    ]);
  });

});
