/**
 * 测试职责：冻结 WAY-60 进程内 Search Cache（缓存）的确定性语义。
 *
 * 关键边界：Key 不保存明文 Query/URL/Secret；TTL 非滑动；取消与 Provider 错误
 * 不写缓存；命中观察不携带用户或网页内容。
 */
import type { NormalizedSearchHit, ProviderSearchRequest } from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";
import { LRUCache } from "lru-cache";

import {
  createMemoryCachedSearchProvider,
  createSearchCacheKey,
  createSearchResultCache,
  SEARCH_CACHE_MAX_ENTRY_SIZE_BYTES,
  SEARCH_CACHE_MAX_SIZE_BYTES,
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
  it("同代际包装器共用有界池，跨代际和缺省命名空间互不命中", async () => {
    const sharedCache = createSearchResultCache();
    const namespace = "11111111-1111-4111-8111-111111111111";
    const nextNamespace = "22222222-2222-4222-8222-222222222222";
    const search = vi.fn<SearchProvider["search"]>(async request => [createHit(request.query)]);
    const first = createMemoryCachedSearchProvider(createProvider({ search }), { sharedCache, namespace });
    const second = createMemoryCachedSearchProvider(createProvider({ search }), { sharedCache, namespace });
    const changed = createMemoryCachedSearchProvider(createProvider({ search }), { sharedCache, namespace: nextNamespace });
    const legacy = createMemoryCachedSearchProvider(createProvider({ search }), { sharedCache });
    const signal = new AbortController().signal;
    await first.search(BASE_REQUEST, signal);
    await second.search(BASE_REQUEST, signal);
    expect(search).toHaveBeenCalledTimes(1);
    await changed.search(BASE_REQUEST, signal);
    await legacy.search(BASE_REQUEST, signal);
    expect(search).toHaveBeenCalledTimes(3);
    expect(sharedCache.has(createSearchCacheKey("test-provider", BASE_REQUEST))).toBe(true);
    for (const key of sharedCache.keys()) {
      expect(key).toMatch(/^search-v1:[a-f0-9]{64}$/);
      expect(key).not.toContain(namespace);
      expect(key).not.toContain(BASE_REQUEST.query);
    }
  });

  it("共享池跨代际仍只有4MiB总预算，旧代际按同一LRU规则淘汰", async () => {
    const sharedCache = createSearchResultCache();
    const search = vi.fn<SearchProvider["search"]>(async request => [{ ...createHit(request.query), snippet: "x".repeat(500_000) }]);
    const signal = new AbortController().signal;
    for (let generation = 0; generation < 12; generation += 1) {
      const namespace = `${String(generation).padStart(8, "0")}-1111-4111-8111-111111111111`;
      await createMemoryCachedSearchProvider(createProvider({ search }), { sharedCache, namespace }).search(BASE_REQUEST, signal);
      expect(sharedCache.calculatedSize).toBeLessThanOrEqual(SEARCH_CACHE_MAX_SIZE_BYTES);
    }
    expect(sharedCache.size).toBeGreaterThan(0);
    expect(sharedCache.size).toBeLessThan(12);
    const first = createMemoryCachedSearchProvider(createProvider({ search }), {
      sharedCache, namespace: "00000000-1111-4111-8111-111111111111",
    });
    await first.search(BASE_REQUEST, signal);
    expect(search).toHaveBeenCalledTimes(13);
  });

  it("不同请求的缺省缓存不共享，自带凭据无需跨请求注册表", async () => {
    const search = vi.fn<SearchProvider["search"]>(async request => [createHit(request.query)]);
    const first = createMemoryCachedSearchProvider(createProvider({ search }));
    const second = createMemoryCachedSearchProvider(createProvider({ search }));
    const signal = new AbortController().signal;
    await first.search(BASE_REQUEST, signal);
    await first.search(BASE_REQUEST, signal);
    await second.search(BASE_REQUEST, signal);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("拒绝把Key或Cookie当命名空间，也不接受扩张预算的共享池", () => {
    for (const namespace of ["fake-api-key", "cookie=fake", "author:11111111-1111-4111-8111-111111111111"]) {
      expect(() => createMemoryCachedSearchProvider(createProvider(), { namespace })).toThrow("服务端授权代际 UUID");
    }
    const sharedCache = new LRUCache<string, { expiresAtMs: number; value: readonly NormalizedSearchHit[] }>({
      max: 256, maxSize: SEARCH_CACHE_MAX_SIZE_BYTES * 2, maxEntrySize: SEARCH_CACHE_MAX_ENTRY_SIZE_BYTES,
    });
    expect(() => createMemoryCachedSearchProvider(createProvider(), { sharedCache })).toThrow("已批准的有界字节预算");
  });

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
      { ...BASE_REQUEST, engine: "google" },
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

  it("省略引擎与显式默认引擎共用缓存，覆盖引擎与默认隔离", () => {
    for (const language of ["zh-CN", "en-US"] as const) {
      const request = { ...BASE_REQUEST, language };
      const engine = language === "zh-CN" ? "baidu" : "google";
      const other = language === "zh-CN" ? "google" : "baidu";
      expect(createSearchCacheKey("provider", request)).toBe(createSearchCacheKey("provider", { ...request, engine }));
      expect(createSearchCacheKey("provider", request)).not.toBe(createSearchCacheKey("provider", { ...request, engine: other }));
    }
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
