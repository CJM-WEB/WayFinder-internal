/**
 * 测试职责：冻结 WAY-106 SerpAPI Bing Search 的 Deadline、取消、脱敏与有界重试语义。
 *
 * 关键约束：每次逻辑 Search 最多两次 HTTP Attempt；Provider Timeout 和瞬时故障
 * 才能重试，调用方取消与绝对 Run Deadline 必须按对象身份原样传播。
 */
import type { ProviderSearchRequest } from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  SerpApiBingProviderError,
  SerpApiBingSearchProvider,
} from "./serpapi-bing.js";

const SEARCH_REQUEST: ProviderSearchRequest = {
  kind: "node",
  nodeId: "node-serpapi-bing-retry",
  query: "bounded SerpAPI retry",
  maxResults: 1,
  capability: "general",
  freshnessSensitive: false,
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

function successfulSearchResponse(): Response {
  return jsonResponse({
    search_metadata: { status: "Success" },
    organic_results: [
      {
        position: 1,
        title: "Retry result",
        link: "https://example.com/retry",
        snippet: "Retry succeeded.",
      },
    ],
  });
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

/** Node fetch 常把连接错误放入 TypeError.cause；分类只能读取稳定错误码。 */
function createFetchNetworkError(code: string, message = "模拟网络失败"): TypeError {
  return new TypeError(message, {
    cause: Object.assign(new Error(message), { code }),
  });
}

function createCodedError(code: string): Error {
  return Object.assign(new Error("模拟带码错误"), { code });
}

function waitUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === null || signal === undefined) {
      reject(new Error("测试要求请求携带 AbortSignal"));
      return;
    }

    try {
      signal.throwIfAborted();
    } catch (error) {
      reject(error);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

describe("SerpApiBingSearchProvider 有界重试", () => {
  it("观察器只记录每次真实 HTTP 尝试的操作与序号", async () => {
    const attempts: Array<{ operation: "search"; attempt: 1 | 2 }> = [];
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(createFetchNetworkError("ECONNRESET"))
      .mockResolvedValueOnce(successfulSearchResponse());
    const provider = new SerpApiBingSearchProvider({
      apiKey: "test-serpapi-key",
      searchTimeoutMs: 1_000,
      searchRetryTimeoutMs: 10,
      fetchImplementation,
      onAttempt: (observation) => attempts.push(observation),
    });

    await expect(
      provider.search(SEARCH_REQUEST, createRunSignal()),
    ).resolves.toHaveLength(1);
    expect(attempts).toEqual([
      { operation: "search", attempt: 1 },
      { operation: "search", attempt: 2 },
    ]);
  });

  it("网络连接失败后只重试一次并可恢复", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(createFetchNetworkError("ECONNRESET"))
      .mockResolvedValueOnce(successfulSearchResponse());

    await expect(
      createProvider(fetchImplementation).search(
        SEARCH_REQUEST,
        createRunSignal(),
      ),
    ).resolves.toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("响应正文读取期间的网络断开允许一次重试", async () => {
    const disconnectedBody = new ReadableStream({
      start(controller) {
        controller.error(createCodedError("UND_ERR_SOCKET"));
      },
    });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(disconnectedBody))
      .mockResolvedValueOnce(successfulSearchResponse());

    await expect(
      createProvider(fetchImplementation).search(
        SEARCH_REQUEST,
        createRunSignal(),
      ),
    ).resolves.toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it.each([408, 429, 500, 502, 503, 504])(
    "HTTP %i 允许唯一一次重试",
    async (status) => {
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("transient", { status }))
        .mockResolvedValueOnce(successfulSearchResponse());

      await expect(
        createProvider(fetchImplementation).search(
          SEARCH_REQUEST,
          createRunSignal(),
        ),
      ).resolves.toHaveLength(1);
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
    },
  );

  it("发出重试前先释放首个 HTTP 错误响应正文", async () => {
    let bodyCanceled = false;
    const errorBody = new ReadableStream({
      cancel() {
        bodyCanceled = true;
      },
    });
    let attempt = 0;
    const fetchImplementation = vi.fn<typeof fetch>(() => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.resolve(new Response(errorBody, { status: 503 }));
      }
      if (!bodyCanceled) {
        return Promise.reject(new Error("第二次请求不能早于正文清理"));
      }
      return Promise.resolve(successfulSearchResponse());
    });

    await expect(
      createProvider(fetchImplementation).search(
        SEARCH_REQUEST,
        createRunSignal(),
      ),
    ).resolves.toHaveLength(1);
    expect(bodyCanceled).toBe(true);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("错误正文清理卡住时由本次 Provider Timeout 进入重试", async () => {
    const hangingBody = new ReadableStream({
      cancel() {
        return new Promise<void>(() => undefined);
      },
    });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(hangingBody, { status: 503 }))
      .mockResolvedValueOnce(successfulSearchResponse());

    await expect(
      createProvider(fetchImplementation, {
        searchMs: 10,
        retryMs: 10,
      }).search(SEARCH_REQUEST, createRunSignal()),
    ).resolves.toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it.each([401, 422])(
    "确定性 HTTP %i 的正文清理超时仍不得触发重试",
    async (status) => {
      const hangingBody = new ReadableStream({
        cancel() {
          return new Promise<void>(() => undefined);
        },
      });
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(hangingBody, { status }));

      await expect(
        createProvider(fetchImplementation, {
          searchMs: 10,
          retryMs: 10,
        }).search(SEARCH_REQUEST, createRunSignal()),
      ).rejects.toMatchObject({
        name: "SerpApiBingProviderError",
        message: `SerpAPI Bing Search 请求失败（HTTP ${status}）`,
        retryable: false,
      });
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
    },
  );

  it("Provider Timeout 后使用短 Timeout 重试一次", async () => {
    let attempt = 0;
    const fetchImplementation = vi.fn<typeof fetch>((_input, init) => {
      attempt += 1;
      return attempt === 1
        ? waitUntilAborted(init)
        : Promise.resolve(successfulSearchResponse());
    });

    await expect(
      createProvider(fetchImplementation, {
        searchMs: 5,
        retryMs: 5,
      }).search(SEARCH_REQUEST, createRunSignal()),
    ).resolves.toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("连续两次 Provider Timeout 后返回稳定的可重试错误", async () => {
    const fetchImplementation = vi.fn<typeof fetch>((_input, init) =>
      waitUntilAborted(init),
    );

    await expect(
      createProvider(fetchImplementation, {
        searchMs: 5,
        retryMs: 5,
      }).search(SEARCH_REQUEST, createRunSignal()),
    ).rejects.toMatchObject({
      name: "SerpApiBingProviderError",
      message: "SerpAPI Bing Search 请求超时",
      code: "SEARCH_PROVIDER_FAILED",
      retryable: true,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("读取成功响应正文期间的 Timeout 同样允许一次重试", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementationOnce((_input, init) => {
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
      })
      .mockResolvedValueOnce(successfulSearchResponse());

    await expect(
      createProvider(fetchImplementation, {
        searchMs: 5,
        retryMs: 5,
      }).search(SEARCH_REQUEST, createRunSignal()),
    ).resolves.toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("连续瞬时失败严格停止在两次且不泄漏实际请求 URL、Query、Key 或 cause", async () => {
    const privateQuery = "private-query-in-real-request";
    const privateKey = "private-key-in-real-request";
    let actualRequestUrl = "";
    const fetchImplementation = vi.fn<typeof fetch>((input) => {
      actualRequestUrl = String(input);
      return Promise.reject(
        createFetchNetworkError("ECONNRESET", actualRequestUrl),
      );
    });
    const provider = new SerpApiBingSearchProvider({
      apiKey: privateKey,
      searchTimeoutMs: 1_000,
      searchRetryTimeoutMs: 10,
      fetchImplementation,
    });

    let received: unknown;
    try {
      await provider.search(
        { ...SEARCH_REQUEST, query: privateQuery },
        createRunSignal(),
      );
    } catch (error) {
      received = error;
    }

    expect(received).toMatchObject({
      name: "SerpApiBingProviderError",
      message: "SerpAPI Bing Search 网络请求失败",
      code: "SEARCH_PROVIDER_FAILED",
      retryable: true,
    });
    const serialized = `${String(received)}\n${JSON.stringify(received)}`;
    expect(serialized).not.toContain(privateQuery);
    expect(serialized).not.toContain(privateKey);
    expect(actualRequestUrl).toContain(privateQuery);
    expect(actualRequestUrl).toContain(privateKey);
    expect(serialized).not.toContain(actualRequestUrl);
    expect(received).not.toHaveProperty("cause");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("首次瞬时失败后第二次确定性失败采用最终不可重试分类", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(createFetchNetworkError("ECONNRESET"))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));

    await expect(
      createProvider(fetchImplementation).search(
        SEARCH_REQUEST,
        createRunSignal(),
      ),
    ).rejects.toMatchObject({
      name: "SerpApiBingProviderError",
      message: "SerpAPI Bing Search 请求失败（HTTP 401）",
      retryable: false,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it.each([301, 400, 401, 403, 404, 409, 422, 501])(
    "确定性 HTTP %i 不重试且不读取错误正文",
    async (status) => {
      const privateBody = "provider-private-body";
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(privateBody, { status }));

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
        code: "SEARCH_PROVIDER_FAILED",
        retryable: false,
      });
      expect(String(received)).not.toContain(privateBody);
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
    },
  );

  it("无效 JSON 与 Envelope Schema 错误均不重试", async () => {
    const invalidJsonFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{"));
    const invalidEnvelopeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ organic_results: [] }));

    await expect(
      createProvider(invalidJsonFetch).search(
        SEARCH_REQUEST,
        createRunSignal(),
      ),
    ).rejects.toBeInstanceOf(SerpApiBingProviderError);
    await expect(
      createProvider(invalidEnvelopeFetch).search(
        SEARCH_REQUEST,
        createRunSignal(),
      ),
    ).rejects.toBeInstanceOf(SerpApiBingProviderError);
    expect(invalidJsonFetch).toHaveBeenCalledTimes(1);
    expect(invalidEnvelopeFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["普通 Error", new Error("programming failure")],
    ["裸 TypeError", new TypeError("programming failure")],
    ["Undici 参数错误", createCodedError("UND_ERR_INVALID_ARG")],
    ["未知 Undici 前缀", createCodedError("UND_ERR_FUTURE_UNKNOWN")],
  ])("%s 不得被宽泛识别为网络瞬时故障", async (_name, error) => {
    const fetchImplementation = vi.fn<typeof fetch>().mockRejectedValue(error);

    await expect(
      createProvider(fetchImplementation).search(
        SEARCH_REQUEST,
        createRunSignal(),
      ),
    ).rejects.toMatchObject({
      name: "SerpApiBingProviderError",
      retryable: false,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it.each([
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
  ])("精确网络错误码 %s 允许唯一一次重试", async (code) => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(createCodedError(code))
      .mockResolvedValueOnce(successfulSearchResponse());

    await expect(
      createProvider(fetchImplementation).search(
        SEARCH_REQUEST,
        createRunSignal(),
      ),
    ).resolves.toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});

describe("SerpApiBingSearchProvider Run Signal", () => {
  it("调用前已取消时不记录 Attempt 且不调用 Fetch", async () => {
    const attempts: Array<{ operation: "search"; attempt: 1 | 2 }> = [];
    const fetchImplementation = vi.fn<typeof fetch>();
    const controller = new AbortController();
    const abortReason = new Error("Run 已取消");
    controller.abort(abortReason);
    const provider = new SerpApiBingSearchProvider({
      apiKey: "test-serpapi-key",
      searchTimeoutMs: 1_000,
      fetchImplementation,
      onAttempt: (observation) => attempts.push(observation),
    });

    await expect(
      provider.search(SEARCH_REQUEST, controller.signal),
    ).rejects.toBe(abortReason);
    expect(attempts).toEqual([]);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("Run Deadline 早于 Provider Timeout 时原样传播且不重试", async () => {
    const fetchImplementation = vi.fn<typeof fetch>((_input, init) =>
      waitUntilAborted(init),
    );
    const controller = new AbortController();
    const deadlineReason = Object.assign(new Error("Run deadline reached"), {
      code: "RUN_DEADLINE_EXCEEDED",
    });
    const operation = createProvider(fetchImplementation).search(
      SEARCH_REQUEST,
      controller.signal,
    );

    controller.abort(deadlineReason);

    await expect(operation).rejects.toBe(deadlineReason);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("Fetch 返回时 Run 已取消仍优先传播原始原因", async () => {
    const controller = new AbortController();
    const abortReason = Object.assign(new Error("Request replaced"), {
      code: "REQUEST_ABORTED",
    });
    const fetchImplementation = vi.fn<typeof fetch>(() => {
      controller.abort(abortReason);
      return Promise.resolve(successfulSearchResponse());
    });

    await expect(
      createProvider(fetchImplementation).search(
        SEARCH_REQUEST,
        controller.signal,
      ),
    ).rejects.toBe(abortReason);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "用户取消",
      Object.assign(new Error("Request replaced"), {
        code: "REQUEST_ABORTED",
      }),
    ],
    [
      "Run Deadline",
      Object.assign(new Error("Run deadline reached"), {
        code: "RUN_DEADLINE_EXCEEDED",
      }),
    ],
  ])(
    "成功响应正文读取期间的%s原样传播且不重试",
    async (_name, abortReason) => {
      let bodyReadStarted = false;
      const controller = new AbortController();
      const fetchImplementation = vi.fn<typeof fetch>((_input, init) => {
        const signal = init?.signal;
        if (signal === null || signal === undefined) {
          return Promise.reject(new Error("测试要求请求携带 AbortSignal"));
        }

        const body = new ReadableStream({
          start(streamController) {
            signal.addEventListener(
              "abort",
              () => streamController.error(signal.reason),
              { once: true },
            );
          },
          pull() {
            bodyReadStarted = true;
          },
        });
        return Promise.resolve(new Response(body));
      });
      const operation = createProvider(fetchImplementation).search(
        SEARCH_REQUEST,
        controller.signal,
      );

      await vi.waitFor(() => expect(bodyReadStarted).toBe(true));
      controller.abort(abortReason);

      await expect(operation).rejects.toBe(abortReason);
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
    },
  );

  it("HTTP 正文清理卡住时立即传播 Run 的原始取消原因", async () => {
    let cancelStarted = false;
    const hangingBody = new ReadableStream({
      cancel() {
        cancelStarted = true;
        return new Promise<void>(() => undefined);
      },
    });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(hangingBody, { status: 503 }));
    const controller = new AbortController();
    const deadlineReason = Object.assign(new Error("Run deadline reached"), {
      code: "RUN_DEADLINE_EXCEEDED",
    });
    const operation = createProvider(fetchImplementation).search(
      SEARCH_REQUEST,
      controller.signal,
    );

    await vi.waitFor(() => expect(cancelStarted).toBe(true));
    controller.abort(deadlineReason);

    await expect(
      Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("正文清理阻塞了 Run Signal")), 200);
        }),
      ]),
    ).rejects.toBe(deadlineReason);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("重试期间到达 Run Deadline 时立即停止并原样传播", async () => {
    const controller = new AbortController();
    const deadlineReason = Object.assign(new Error("Run deadline reached"), {
      code: "RUN_DEADLINE_EXCEEDED",
    });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(createFetchNetworkError("ECONNRESET"))
      .mockImplementationOnce((_input, init) => waitUntilAborted(init));
    const operation = createProvider(fetchImplementation, {
      retryMs: 1_000,
    }).search(SEARCH_REQUEST, controller.signal);

    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(2));
    controller.abort(deadlineReason);

    await expect(operation).rejects.toBe(deadlineReason);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
