/**
 * 测试职责：冻结 WAY-60 进程内 Search / Extract Cache（缓存）的确定性语义。
 *
 * 关键边界：Key 不保存明文 Query/URL/Secret；TTL 非滑动；取消与 Provider 错误
 * 不写缓存；Extract 只复用成功 URL；命中观察不携带用户或网页内容。
 */
import type {
  ExtractedPage,
  NormalizedSearchHit,
  ProviderSearchRequest,
} from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createExtractCacheKey,
  createMemoryCachedSearchProvider,
  createSearchCacheKey,
  EXTRACT_CACHE_MAX_ENTRY_SIZE_CODE_UNITS,
  EXTRACT_CACHE_TTL_MS,
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

function createPage(canonicalUrl: string): ExtractedPage {
  return { canonicalUrl, content: `正文 ${canonicalUrl}` };
}

function createProvider(input?: {
  id?: string;
  search?: SearchProvider["search"];
  extract?: NonNullable<SearchProvider["extract"]>;
}): SearchProvider {
  return {
    id: input?.id ?? "test-provider",
    capabilities: ["general"],
    search:
      input?.search ??
      (async request => [createHit(request.query)]),
    ...(input?.extract === undefined ? {} : { extract: input.extract }),
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
      { ...BASE_REQUEST, language: "en" },
      {
        kind: "broad_discovery",
        query: BASE_REQUEST.query,
        maxResults: BASE_REQUEST.maxResults,
        capability: BASE_REQUEST.capability,
        freshnessSensitive: BASE_REQUEST.freshnessSensitive,
        ...(BASE_REQUEST.language === undefined
          ? {}
          : { language: BASE_REQUEST.language }),
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

  it("Key 只暴露版本化摘要，并严格分离 Search 与 Extract 命名空间", () => {
    const searchKey = createSearchCacheKey("private-provider", {
      ...BASE_REQUEST,
      query: "sensitive query text",
    });
    const extractKey = createExtractCacheKey(
      "private-provider",
      "https://example.com/private-path?token=not-a-real-secret",
    );

    expect(searchKey).toMatch(/^search-v1:[a-f0-9]{64}$/u);
    expect(extractKey).toMatch(/^extract-v1:[a-f0-9]{64}$/u);
    expect(searchKey).not.toContain("sensitive");
    expect(extractKey).not.toContain("private-path");
    expect(extractKey).not.toContain("token");
    expect(searchKey).not.toBe(extractKey);
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

  it("Extract 重叠批次只委托 Miss URL，并按原输入顺序合并与隔离结果", async () => {
    const extract = vi.fn<NonNullable<SearchProvider["extract"]>>(
      async canonicalUrls =>
        canonicalUrls
          .map(createPage)
          .reverse(),
    );
    const observations: SearchProviderCacheObservation[] = [];
    const provider = createMemoryCachedSearchProvider(
      createProvider({ extract }),
      { onObservation: observation => observations.push(observation) },
    );
    const signal = new AbortController().signal;
    const a = "https://example.com/a";
    const b = "https://example.com/b";
    const c = "https://example.com/c";

    expect(await provider.extract!([a, b], signal)).toEqual([
      createPage(a),
      createPage(b),
    ]);
    const overlap = await provider.extract!([b, c], signal);
    expect(overlap).toEqual([createPage(b), createPage(c)]);
    overlap[0]!.content = "被调用方修改";
    expect(await provider.extract!([b], signal)).toEqual([createPage(b)]);

    expect(extract.mock.calls.map(call => call[0])).toEqual([
      [a, b],
      [c],
    ]);
    expect(observations).toEqual([
      { operation: "extract", hitCount: 0, missCount: 2 },
      { operation: "extract", hitCount: 1, missCount: 1 },
      { operation: "extract", hitCount: 1, missCount: 0 },
    ]);
  });

  it("Extract 使用独立 LRU，并在 Hit 后保留最近使用项", async () => {
    const a = "https://example.com/a";
    const b = "https://example.com/b";
    const c = "https://example.com/c";
    const extract = vi.fn<NonNullable<SearchProvider["extract"]>>(
      async canonicalUrls => canonicalUrls.map(createPage),
    );
    const provider = createMemoryCachedSearchProvider(
      createProvider({ extract }),
      { extractMaxEntries: 2 },
    );
    const signal = new AbortController().signal;

    await provider.extract!([a, b], signal);
    await provider.extract!([a], signal);
    await provider.extract!([c], signal);
    await provider.extract!([a], signal);
    await provider.extract!([b], signal);

    expect(extract.mock.calls.map(call => call[0])).toEqual([
      [a, b],
      [c],
      [b],
    ]);
  });

  it("Extract 只缓存实际成功页面，缺失 URL 下次仍为 Miss", async () => {
    const a = "https://example.com/a";
    const b = "https://example.com/b";
    const extract = vi
      .fn<NonNullable<SearchProvider["extract"]>>()
      .mockResolvedValueOnce([createPage(a)])
      .mockResolvedValueOnce([createPage(b)]);
    const provider = createMemoryCachedSearchProvider(
      createProvider({ extract }),
    );
    const signal = new AbortController().signal;

    expect(await provider.extract!([a, b], signal)).toEqual([createPage(a)]);
    expect(await provider.extract!([a, b], signal)).toEqual([
      createPage(a),
      createPage(b),
    ]);
    expect(extract.mock.calls.map(call => call[0])).toEqual([[a, b], [b]]);
  });

  it("Extract 空正文与超大正文正常返回但不缓存", async () => {
    const blankUrl = "https://example.com/blank";
    const largeUrl = "https://example.com/large";
    const oversizedContent = "x".repeat(
      EXTRACT_CACHE_MAX_ENTRY_SIZE_CODE_UNITS + 1,
    );
    const extract = vi.fn<NonNullable<SearchProvider["extract"]>>(
      async canonicalUrls =>
        canonicalUrls.map(canonicalUrl => ({
          canonicalUrl,
          content:
            canonicalUrl === blankUrl ? "   " : oversizedContent,
        })),
    );
    const provider = createMemoryCachedSearchProvider(
      createProvider({ extract }),
    );
    const signal = new AbortController().signal;

    const expected = [
      { canonicalUrl: blankUrl, content: "   " },
      { canonicalUrl: largeUrl, content: oversizedContent },
    ];
    await expect(
      provider.extract!([blankUrl, largeUrl], signal),
    ).resolves.toEqual(expected);
    await expect(
      provider.extract!([blankUrl, largeUrl], signal),
    ).resolves.toEqual(expected);
    expect(extract.mock.calls.map(call => call[0])).toEqual([
      [blankUrl, largeUrl],
      [blankUrl, largeUrl],
    ]);
  });

  it.each([
    [
      "未知 URL",
      (requestedUrl: string) => [
        createPage(requestedUrl),
        createPage("https://unexpected.example/page"),
      ],
    ],
    [
      "重复关联",
      (requestedUrl: string) => [
        createPage(requestedUrl),
        createPage(requestedUrl),
      ],
    ],
  ])("Extract %s 的 Fresh 批次整体不写缓存", async (_name, response) => {
    const url = "https://example.com/page";
    const extract = vi.fn<NonNullable<SearchProvider["extract"]>>(
      async canonicalUrls => response(canonicalUrls[0]!),
    );
    const provider = createMemoryCachedSearchProvider(
      createProvider({ extract }),
    );
    const signal = new AbortController().signal;

    await provider.extract!([url], signal);
    await provider.extract!([url], signal);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it("Warm Cache 仍把重复或超出缓存批量上限的输入交给 Provider 校验", async () => {
    const a = "https://example.com/a";
    const b = "https://example.com/b";
    const c = "https://example.com/c";
    const providerError = new Error("invalid extract input");
    const extract = vi.fn<NonNullable<SearchProvider["extract"]>>(
      async canonicalUrls => {
        if (
          new Set(canonicalUrls).size !== canonicalUrls.length ||
          canonicalUrls.length > 2
        ) {
          throw providerError;
        }
        return canonicalUrls.map(createPage);
      },
    );
    const provider = createMemoryCachedSearchProvider(
      createProvider({ extract }),
      { maxCacheableExtractUrls: 2 },
    );
    const signal = new AbortController().signal;

    await provider.extract!([a, b], signal);
    await provider.extract!([c], signal);
    await expect(provider.extract!([a, a], signal)).rejects.toBe(
      providerError,
    );
    await expect(provider.extract!([a, b, c], signal)).rejects.toBe(
      providerError,
    );
    expect(extract).toHaveBeenCalledTimes(4);
  });

  it("Extract TTL 为一小时且命中不续期", async () => {
    let nowMs = 5_000;
    const url = "https://example.com/page";
    let extractCallCount = 0;
    const extract = vi.fn<NonNullable<SearchProvider["extract"]>>(
      async canonicalUrls => {
        extractCallCount += 1;
        return canonicalUrls.map(canonicalUrl => ({
          canonicalUrl,
          content: `调用 ${extractCallCount}`,
        }));
      },
    );
    const provider = createMemoryCachedSearchProvider(
      createProvider({ extract }),
      { nowMs: () => nowMs },
    );
    const signal = new AbortController().signal;

    const first = await provider.extract!([url], signal);
    nowMs += EXTRACT_CACHE_TTL_MS - 1;
    expect(await provider.extract!([url], signal)).toEqual(first);
    nowMs += 1;
    expect(await provider.extract!([url], signal)).not.toEqual(first);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it("Extract 异常与晚到取消结果均不写缓存", async () => {
    const url = "https://example.com/page";
    const providerError = new Error("extract failed");
    const failedExtract = vi
      .fn<NonNullable<SearchProvider["extract"]>>()
      .mockRejectedValueOnce(providerError)
      .mockResolvedValueOnce([createPage(url)]);
    const failedProvider = createMemoryCachedSearchProvider(
      createProvider({ extract: failedExtract }),
    );
    await expect(
      failedProvider.extract!([url], new AbortController().signal),
    ).rejects.toBe(providerError);
    await failedProvider.extract!([url], new AbortController().signal);
    expect(failedExtract).toHaveBeenCalledTimes(2);

    let resolveLate: ((pages: ExtractedPage[]) => void) | undefined;
    const lateExtract = vi.fn<NonNullable<SearchProvider["extract"]>>(
      () =>
        new Promise(resolve => {
          resolveLate = resolve;
        }),
    );
    const lateProvider = createMemoryCachedSearchProvider(
      createProvider({ extract: lateExtract }),
    );
    const controller = new AbortController();
    const reason = new Error("deadline");
    const pending = lateProvider.extract!([url], controller.signal);
    controller.abort(reason);
    resolveLate?.([createPage(url)]);
    await expect(pending).rejects.toBe(reason);

    const retry = lateProvider.extract!([url], new AbortController().signal);
    resolveLate?.([createPage(url)]);
    await expect(retry).resolves.toEqual([createPage(url)]);
    expect(lateExtract).toHaveBeenCalledTimes(2);
  });

  it("底层 Provider 没有 Extract 时不伪造该能力", () => {
    const provider = createMemoryCachedSearchProvider(createProvider());
    expect(provider.extract).toBeUndefined();
  });
});
