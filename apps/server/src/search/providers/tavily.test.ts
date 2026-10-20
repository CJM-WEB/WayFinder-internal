/**
 * 测试职责：用离线 Fixture 冻结 WAY-45 Tavily Adapter 的请求、校验与规范化边界。
 *
 * 关键约束：测试不得访问真实网络或 Secret；所有 snake_case 仅出现在模拟的
 * Provider 输入中，业务输出只能是共享的 camelCase 类型。
 */
import type { ProviderSearchRequest } from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  TavilyProviderError,
  TavilySearchProvider,
} from "./tavily.js";

const SEARCH_REQUEST: ProviderSearchRequest = {
  nodeId: "node-typescript",
  query: "TypeScript strict mode",
  maxResults: 2,
  capability: "general",
  freshnessSensitive: false,
  language: "en",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createProvider(
  fetchImplementation: typeof fetch,
  timeouts: { searchMs?: number; extractMs?: number } = {},
): TavilySearchProvider {
  return new TavilySearchProvider({
    apiKey: "test-tavily-key",
    searchTimeoutMs: timeouts.searchMs ?? 1_000,
    extractTimeoutMs: timeouts.extractMs ?? 1_000,
    fetchImplementation,
  });
}

describe("TavilySearchProvider.search", () => {
  it("校验 unknown Fixture 并立即映射为 camelCase NormalizedSearchHit", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        query: "不可信回显，不得覆盖请求 Query",
        response_time: 0.42,
        request_id: "request-private-metadata",
        results: [
          {
            title: " TypeScript Strict Mode ",
            url: "https://Docs.Example.COM/strict-mode",
            content: "Strict mode enables stronger checks.",
            score: 0.91,
            published_date: "2026-10-01T00:00:00Z",
            raw_content: "不得进入搜索结果的 Provider 私有正文",
            favicon: "https://docs.example.com/favicon.ico",
          },
          {
            title: "Compiler Options",
            url: "https://example.com/compiler-options",
            content: "Compiler option reference.",
            score: 0.75,
            published_date: null,
          },
        ],
      }),
    );
    const provider = createProvider(fetchImplementation);

    const hits = await provider.search(SEARCH_REQUEST);

    expect(hits).toEqual([
      {
        provider: "tavily",
        query: SEARCH_REQUEST.query,
        title: "TypeScript Strict Mode",
        url: "https://Docs.Example.COM/strict-mode",
        canonicalUrl: "https://Docs.Example.COM/strict-mode",
        domain: "docs.example.com",
        snippet: "Strict mode enables stronger checks.",
        publishedAt: "2026-10-01T00:00:00Z",
        providerRank: 1,
        providerScore: 0.91,
        rawMetadata: {},
      },
      {
        provider: "tavily",
        query: SEARCH_REQUEST.query,
        title: "Compiler Options",
        url: "https://example.com/compiler-options",
        canonicalUrl: "https://example.com/compiler-options",
        domain: "example.com",
        snippet: "Compiler option reference.",
        publishedAt: null,
        providerRank: 2,
        providerScore: 0.75,
        rawMetadata: {},
      },
    ]);

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe("https://api.tavily.com/search");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer test-tavily-key",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      query: SEARCH_REQUEST.query,
      max_results: SEARCH_REQUEST.maxResults,
      include_answer: false,
      include_raw_content: false,
    });
  });

  it("拒绝未通过私有 Schema 的原始响应", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        results: [
          {
            title: "Invalid score",
            url: "https://example.com/invalid",
            content: "Invalid provider payload.",
            score: "0.9",
          },
        ],
      }),
    );

    await expect(
      createProvider(fetchImplementation).search(SEARCH_REQUEST),
    ).rejects.toMatchObject({
      name: "TavilyProviderError",
      message: "Tavily Search 响应结构无效",
    });
  });

  it("原始响应包含无效 URL 时返回稳定的 Schema 错误", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        results: [
          {
            title: "Invalid URL",
            url: "not-a-url",
            content: "Untrusted provider payload.",
            score: 0.5,
          },
        ],
      }),
    );

    await expect(
      createProvider(fetchImplementation).search(SEARCH_REQUEST),
    ).rejects.toMatchObject({
      name: "TavilyProviderError",
      message: "Tavily Search 响应结构无效",
    });
  });

  it("Provider 超额返回时仍确定性遵守请求数量上限", async () => {
    const results = ["first", "second", "third"].map((slug, index) => ({
      title: slug,
      url: `https://example.com/${slug}`,
      content: `${slug} content`,
      score: 0.9 - index * 0.1,
    }));
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ results }),
    );

    const hits = await createProvider(fetchImplementation).search(SEARCH_REQUEST);

    expect(hits.map((hit) => hit.title)).toEqual(["first", "second"]);
    expect(hits.map((hit) => hit.providerRank)).toEqual([1, 2]);
  });

  it("HTTP 失败不泄漏 API Key 或 Provider 响应正文", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("provider-secret-body", { status: 401 }),
    );

    const operation = createProvider(fetchImplementation).search(SEARCH_REQUEST);

    await expect(operation).rejects.toBeInstanceOf(TavilyProviderError);
    await expect(operation).rejects.toMatchObject({
      message: "Tavily Search 请求失败（HTTP 401）",
    });
    await expect(operation).rejects.not.toThrow("test-tavily-key");
    await expect(operation).rejects.not.toThrow("provider-secret-body");
  });

  it("调用前取消时不发出外部请求", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort(new Error("上层 Run 已取消"));

    await expect(
      createProvider(fetchImplementation).search(
        SEARCH_REQUEST,
        controller.signal,
      ),
    ).rejects.toThrow("上层 Run 已取消");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("单次调用 Timeout 可中止等待中的外部请求", async () => {
    const fetchImplementation = vi.fn<typeof fetch>((_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === null || signal === undefined) {
          reject(new Error("测试要求请求携带 AbortSignal"));
          return;
        }

        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
    );

    await expect(
      createProvider(fetchImplementation, { searchMs: 5 }).search(
        SEARCH_REQUEST,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("读取响应正文期间超时仍保留 Timeout 取消语义", async () => {
    const fetchImplementation = vi.fn<typeof fetch>((_url, init) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined) {
        return Promise.reject(new Error("测试要求请求携带 AbortSignal"));
      }

      const body = new ReadableStream({
        start(controller) {
          signal.addEventListener(
            "abort",
            () => controller.error(signal.reason),
            { once: true },
          );
        },
      });
      return Promise.resolve(new Response(body));
    });

    await expect(
      createProvider(fetchImplementation, { searchMs: 5 }).search(
        SEARCH_REQUEST,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("TavilySearchProvider.extract", () => {
  it("按输入 canonicalUrl 重新关联、恢复顺序并丢弃空正文", async () => {
    const firstUrl = "https://example.com/first";
    const secondUrl = "https://example.com/second";
    const emptyUrl = "https://example.com/empty";
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        response_time: 0.31,
        request_id: "extract-private-metadata",
        results: [
          {
            url: secondUrl,
            raw_content: "Second page content.",
            title: "不得进入 ExtractedPage",
          },
          {
            url: emptyUrl,
            raw_content: "   ",
          },
          {
            url: firstUrl,
            raw_content: "First page content.",
          },
        ],
        failed_results: [],
      }),
    );
    const provider = createProvider(fetchImplementation);

    const pages = await provider.extract([firstUrl, secondUrl, emptyUrl]);

    expect(pages).toEqual([
      { canonicalUrl: firstUrl, content: "First page content." },
      { canonicalUrl: secondUrl, content: "Second page content." },
    ]);
    const [, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      urls: [firstUrl, secondUrl, emptyUrl],
      include_images: false,
      extract_depth: "basic",
      format: "markdown",
    });
  });

  it("拒绝重复关联或 Provider 返回的未请求 URL", async () => {
    const requestedUrl = "https://example.com/requested";

    for (const results of [
      [
        { url: requestedUrl, raw_content: "first" },
        { url: requestedUrl, raw_content: "duplicate" },
      ],
      [{ url: "https://example.com/unrequested", raw_content: "unexpected" }],
    ]) {
      const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ results, failed_results: [] }),
      );

      await expect(
        createProvider(fetchImplementation).extract([requestedUrl]),
      ).rejects.toThrow("Tavily Extract 响应关联无效");
    }
  });

  it("拒绝必须改写后才能关联的 Provider URL", async () => {
    const requestedUrl = "https://example.com/requested";
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        results: [
          { url: ` ${requestedUrl} `, raw_content: "must not be associated" },
        ],
      }),
    );

    await expect(
      createProvider(fetchImplementation).extract([requestedUrl]),
    ).rejects.toMatchObject({
      name: "TavilyProviderError",
      message: "Tavily Extract 响应结构无效",
    });
  });

  it("拒绝无效输入 URL 且不发出外部请求", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();

    await expect(
      createProvider(fetchImplementation).extract(["not-a-url"]),
    ).rejects.toMatchObject({
      name: "TavilyProviderError",
      message: "Tavily Extract 输入 URL 无效",
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("空输入直接返回且不访问网络", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();

    await expect(
      createProvider(fetchImplementation).extract([]),
    ).resolves.toEqual([]);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
