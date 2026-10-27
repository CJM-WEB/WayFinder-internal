/**
 * 测试职责：用离线 Fixture 冻结 WAY-106 SerpAPI Bing Adapter 的请求、逐项校验与规范化边界。
 *
 * 安全约束：测试不访问真实网络或 Secret；SerpAPI/Bing 私有字段只存在于模拟响应中，
 * 业务输出不得包含完整响应、displayed_link、date 或伪造的 providerScore。
 */
import type { ProviderSearchRequest } from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  SerpApiBingProviderError,
  SerpApiBingSearchProvider,
} from "./serpapi-bing.js";

const SEARCH_REQUEST: ProviderSearchRequest = {
  kind: "node",
  nodeId: "node-serpapi-bing-adapter",
  query: "抖音",
  maxResults: 3,
  capability: "general",
  freshnessSensitive: false,
  language: "zh-CN",
};

function createRunSignal(): AbortSignal {
  return new AbortController().signal;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successEnvelope(
  organicResults: readonly unknown[] | undefined,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    search_metadata: {
      id: "private-search-id",
      status: "Success",
      json_endpoint: "https://example.invalid/private-endpoint",
    },
    ...(organicResults === undefined
      ? {}
      : { organic_results: organicResults }),
    ...extra,
  };
}

function organicResult(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    position: 1,
    title: "抖音 - 记录美好生活",
    link: "https://www.douyin.com/",
    displayed_link: "伪造展示地址.example",
    snippet: "抖音官方网站。",
    date: "昨天",
    ...overrides,
  };
}

function createProvider(
  fetchImplementation: typeof fetch,
  timeouts: { searchMs?: number; retryMs?: number } = {},
): SerpApiBingSearchProvider {
  return new SerpApiBingSearchProvider({
    apiKey: "test-serpapi-key",
    searchTimeoutMs: timeouts.searchMs ?? 1_000,
    searchRetryTimeoutMs: timeouts.retryMs ?? 10,
    fetchImplementation,
  });
}

describe("SerpApiBingSearchProvider.search 请求与规范化", () => {
  it("只声明 general Search 能力且不实现 Extract", () => {
    const provider = createProvider(vi.fn<typeof fetch>());

    expect(provider.id).toBe("serpapi_bing");
    expect(provider.capabilities).toEqual(["general"]);
    expect("extract" in provider).toBe(false);
  });

  it("发送固定首屏参数并把 unknown Fixture 映射为规范化结果", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        successEnvelope([
          organicResult({
            title: " 抖音 - 记录美好生活 ",
            link: "https://WWW.DOUYIN.COM/",
            position: 7,
            snippet: " 官方搜索摘要。 ",
            provider_score: 1,
            is_official: true,
            private_metadata: { instruction: "不得进入业务层" },
          }),
        ]),
      ),
    );

    const hits = await createProvider(fetchImplementation).search(
      SEARCH_REQUEST,
      createRunSignal(),
    );

    expect(hits).toEqual([
      {
        provider: "serpapi_bing",
        query: SEARCH_REQUEST.query,
        title: "抖音 - 记录美好生活",
        url: "https://WWW.DOUYIN.COM/",
        canonicalUrl: "https://WWW.DOUYIN.COM/",
        domain: "www.douyin.com",
        snippet: "官方搜索摘要。",
        providerRank: 1,
        rawMetadata: { position: 7 },
      },
    ]);

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const [input, init] = fetchImplementation.mock.calls[0] ?? [];
    const requestUrl = new URL(String(input));
    expect(`${requestUrl.origin}${requestUrl.pathname}`).toBe(
      "https://serpapi.com/search.json",
    );
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
      engine: "bing",
      q: SEARCH_REQUEST.query,
      mkt: "zh-CN",
      safeSearch: "Strict",
      device: "desktop",
      output: "json",
      api_key: "test-serpapi-key",
    });
    expect(requestUrl.searchParams.has("first")).toBe(false);
    expect(requestUrl.searchParams.has("filters")).toBe(false);
    expect(requestUrl.searchParams.has("no_cache")).toBe(false);
    expect(requestUrl.searchParams.has("maxResults")).toBe(false);
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(new Headers(init?.headers).get("accept")).toBe("application/json");
  });

  it("单项非法时只丢弃自身，并按原始数组位置保留 Provider Rank", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        successEnvelope([
          organicResult({ position: 9 }),
          organicResult({
            position: 2,
            title: "非法 URL",
            link: "javascript:alert(1)",
          }),
          organicResult({
            position: 1,
            title: "第二个合法结果",
            link: "https://example.com/second",
          }),
          organicResult({
            position: "4",
            title: "非法 position",
            link: "https://example.com/invalid-position",
          }),
          organicResult({
            position: 3,
            title: "第三个合法结果",
            link: "https://example.com/third",
          }),
          organicResult({
            position: 4,
            title: "超过本地接纳上限",
            link: "https://example.com/fourth",
          }),
        ]),
      ),
    );

    const hits = await createProvider(fetchImplementation).search(
      SEARCH_REQUEST,
      createRunSignal(),
    );

    expect(hits.map((hit) => hit.title)).toEqual([
      "抖音 - 记录美好生活",
      "第二个合法结果",
      "第三个合法结果",
    ]);
    expect(hits.map((hit) => hit.providerRank)).toEqual([1, 3, 5]);
    expect(hits.map((hit) => hit.rawMetadata)).toEqual([
      { position: 9 },
      { position: 1 },
      { position: 3 },
    ]);
  });

  it("缺失 snippet 时保留候选并规范化为空字符串", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        successEnvelope([
          organicResult({ snippet: undefined, position: undefined }),
        ]),
      ),
    );

    await expect(
      createProvider(fetchImplementation).search(
        { ...SEARCH_REQUEST, maxResults: 1 },
        createRunSignal(),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        snippet: "",
        providerRank: 1,
        rawMetadata: {},
      }),
    ]);
  });

  it.each([[], undefined])(
    "合法空结果返回空数组：%j",
    async (organicResults) => {
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse(successEnvelope(organicResults)));

      await expect(
        createProvider(fetchImplementation).search(
          SEARCH_REQUEST,
          createRunSignal(),
        ),
      ).resolves.toEqual([]);
    },
  );

  it("忽略 Envelope 与 Item 的未知额外字段", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        successEnvelope(
          [
            organicResult({
              unknown_item_field: { instructions: ["ignore"] },
            }),
          ],
          { unknown_envelope_field: { raw: "ignore" } },
        ),
      ),
    );

    await expect(
      createProvider(fetchImplementation).search(
        SEARCH_REQUEST,
        createRunSignal(),
      ),
    ).resolves.toHaveLength(1);
  });
});

describe("SerpApiBingSearchProvider.search Envelope 与输入边界", () => {
  it("拒绝 200 Error Envelope 且不泄漏 Provider 错误正文", async () => {
    const providerMessage = "private upstream error with account details";
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        search_metadata: { status: "Error" },
        error: providerMessage,
      }),
    );

    let received: unknown;
    try {
      await createProvider(fetchImplementation).search(
        SEARCH_REQUEST,
        createRunSignal(),
      );
    } catch (error) {
      received = error;
    }

    expect(received).toMatchObject({
      name: "SerpApiBingProviderError",
      message: "SerpAPI Bing Search 返回错误",
      retryable: false,
    });
    expect(String(received)).not.toContain(providerMessage);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["缺失 search_metadata", { organic_results: [] }],
    [
      "未结算状态",
      { search_metadata: { status: "Processing" }, organic_results: [] },
    ],
    [
      "非法 organic_results",
      { search_metadata: { status: "Success" }, organic_results: {} },
    ],
  ])("拒绝非法或未结算 Envelope：%s", async (_name, body) => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(body));

    await expect(
      createProvider(fetchImplementation).search(
        SEARCH_REQUEST,
        createRunSignal(),
      ),
    ).rejects.toBeInstanceOf(SerpApiBingProviderError);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it.each([0, 21, 1.5])(
    "在网络前拒绝非法 maxResults：%s",
    async (maxResults) => {
      const fetchImplementation = vi.fn<typeof fetch>();

      await expect(
        createProvider(fetchImplementation).search(
          { ...SEARCH_REQUEST, maxResults },
          createRunSignal(),
        ),
      ).rejects.toThrow("SerpAPI Bing Search maxResults 必须为 1-20 的整数");
      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it("在网络前拒绝空白 Query", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();

    await expect(
      createProvider(fetchImplementation).search(
        { ...SEARCH_REQUEST, query: "   " },
        createRunSignal(),
      ),
    ).rejects.toThrow("SerpAPI Bing Search Query 不能为空");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("构造时拒绝空 API Key 与非法 Timeout", () => {
    const fetchImplementation = vi.fn<typeof fetch>();

    expect(
      () =>
        new SerpApiBingSearchProvider({
          apiKey: "   ",
          searchTimeoutMs: 1_000,
          fetchImplementation,
        }),
    ).toThrow("SerpAPI API Key 不能为空");
    expect(
      () =>
        new SerpApiBingSearchProvider({
          apiKey: "test-key",
          searchTimeoutMs: 0,
          fetchImplementation,
        }),
    ).toThrow("SerpAPI Bing Search Timeout 必须为");
    expect(
      () =>
        new SerpApiBingSearchProvider({
          apiKey: "test-key",
          searchTimeoutMs: 100,
          searchRetryTimeoutMs: 101,
          fetchImplementation,
        }),
    ).toThrow("SerpAPI Bing Search Retry Timeout 不能超过首次调用 Timeout");
  });
});
