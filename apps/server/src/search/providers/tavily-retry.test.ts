/**
 * 测试职责：冻结 WAY-46 的 Deadline（截止时间）与有界重试策略。
 *
 * 关键约束：一次 Provider 调用最多包含首次尝试和一次重试；用户取消与 Run Deadline
 * 必须原样上抛，任何错误分类都不能延长该共享 Signal 的生命周期。
 */
import type { ProviderSearchRequest } from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  TavilyProviderError,
  TavilySearchProvider,
} from "./tavily.js";

const SEARCH_REQUEST: ProviderSearchRequest = {
  kind: "node",
  nodeId: "node-way-46",
  query: "deadline aware retry",
  maxResults: 1,
  capability: "general",
  freshnessSensitive: false,
};

/** 每个非取消测试都使用独立的未取消 Run Signal，冻结 Port 的必填边界。 */
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
    results: [
      {
        title: "Retry result",
        url: "https://example.com/retry",
        content: "Retry succeeded.",
        score: 0.8,
      },
    ],
  });
}

/**
 * Node fetch 会把底层连接故障包装进 TypeError.cause；测试只使用稳定错误码，
 * 不依赖可能包含 URL 或平台文本的 message。
 */
function createFetchNetworkError(code: string): TypeError {
  return new TypeError("模拟 fetch 网络失败", {
    cause: Object.assign(new Error("模拟底层网络失败"), { code }),
  });
}

/** 构造带稳定 code 的底层错误，覆盖响应流等不经过 fetch 包装的路径。 */
function createCodedError(code: string): Error {
  return Object.assign(new Error("模拟带码错误"), { code });
}

function createProvider(
  fetchImplementation: typeof fetch,
  timeouts: {
    searchMs?: number;
    extractMs?: number;
    searchRetryMs?: number;
    extractRetryMs?: number;
  } = {},
): TavilySearchProvider {
  return new TavilySearchProvider({
    apiKey: "test-tavily-key",
    searchTimeoutMs: timeouts.searchMs ?? 1_000,
    extractTimeoutMs: timeouts.extractMs ?? 1_000,
    searchRetryTimeoutMs: timeouts.searchRetryMs ?? 10,
    extractRetryTimeoutMs: timeouts.extractRetryMs ?? 10,
    fetchImplementation,
  });
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

describe("TavilySearchProvider 有界重试", () => {
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

  it("响应正文读取期间的网络断开也允许一次重试", async () => {
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
    "HTTP %i 允许一次重试",
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

  it("发出重试前先取消首个 HTTP 错误响应正文", async () => {
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
        return Promise.reject(
          new Error("第二次请求不能早于首个响应正文清理"),
        );
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

  it("HTTP 错误正文清理卡住时由 Provider Timeout 进入一次重试", async () => {
    const hangingBody = new ReadableStream({
      cancel() {
        return new Promise<void>(() => undefined);
      },
    });
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(hangingBody, { status: 503 }))
      .mockResolvedValueOnce(successfulSearchResponse());
    const operation = createProvider(fetchImplementation, {
      searchMs: 10,
      searchRetryMs: 10,
    }).search(SEARCH_REQUEST, createRunSignal());

    await expect(
      Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("正文清理未受 Provider Timeout 约束")), 200);
        }),
      ]),
    ).resolves.toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

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
        searchRetryMs: 5,
      }).search(SEARCH_REQUEST, createRunSignal()),
    ).resolves.toHaveLength(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("连续网络失败时总尝试次数严格限制为 2", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValue(createFetchNetworkError("ECONNRESET"));

    await expect(
      createProvider(fetchImplementation).search(
        SEARCH_REQUEST,
        createRunSignal(),
      ),
    ).rejects.toMatchObject({
      name: "TavilyProviderError",
      code: "SEARCH_PROVIDER_FAILED",
      retryable: true,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 409, 422, 501])(
    "确定性 HTTP %i 不重试",
    async (status) => {
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("deterministic", { status }));

      await expect(
        createProvider(fetchImplementation).search(
          SEARCH_REQUEST,
          createRunSignal(),
        ),
      ).rejects.toMatchObject({
        name: "TavilyProviderError",
        code: "SEARCH_PROVIDER_FAILED",
        retryable: false,
      });
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
    },
  );

  it("无效 JSON 与 Schema 错误均不重试", async () => {
    const invalidJsonFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{"));
    const invalidSchemaFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        results: [{ title: "bad", url: "not-a-url", score: "0.8" }],
      }),
    );

    await expect(
      createProvider(invalidJsonFetch).search(
        SEARCH_REQUEST,
        createRunSignal(),
      ),
    ).rejects.toBeInstanceOf(TavilyProviderError);
    await expect(
      createProvider(invalidSchemaFetch).search(
        SEARCH_REQUEST,
        createRunSignal(),
      ),
    ).rejects.toBeInstanceOf(TavilyProviderError);
    expect(invalidJsonFetch).toHaveBeenCalledTimes(1);
    expect(invalidSchemaFetch).toHaveBeenCalledTimes(1);
  });

  it("非网络异常不重试", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("programming failure"));

    await expect(
      createProvider(fetchImplementation).search(
        SEARCH_REQUEST,
        createRunSignal(),
      ),
    ).rejects.toMatchObject({
      name: "TavilyProviderError",
      retryable: false,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["裸 TypeError", new TypeError("programming failure")],
    ["Undici 参数错误", createCodedError("UND_ERR_INVALID_ARG")],
    ["Undici 不支持错误", createCodedError("UND_ERR_NOT_SUPPORTED")],
    ["未知 Undici 前缀错误", createCodedError("UND_ERR_FUTURE_UNKNOWN")],
  ])("%s 不得被宽泛分类为网络瞬时故障", async (_name, error) => {
    const fetchImplementation = vi.fn<typeof fetch>().mockRejectedValue(error);

    await expect(
      createProvider(fetchImplementation).search(
        SEARCH_REQUEST,
        createRunSignal(),
      ),
    ).rejects.toMatchObject({
      name: "TavilyProviderError",
      code: "SEARCH_PROVIDER_FAILED",
      retryable: false,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it.each([
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
  ])("精确网络/Timeout 错误码 %s 仍允许唯一一次重试", async code => {
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

describe("TavilySearchProvider Run Signal", () => {
  it("Run Deadline 早于配置 Timeout 时原样传播且不重试", async () => {
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
    const rejection = expect(operation).rejects.toBe(deadlineReason);

    controller.abort(deadlineReason);

    await rejection;
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

  it("HTTP 错误正文清理卡住时立即传播 Run 的原始取消原因", async () => {
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

    await vi.waitFor(() => {
      expect(cancelStarted).toBe(true);
    });
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
      searchRetryMs: 1_000,
    }).search(SEARCH_REQUEST, controller.signal);
    const rejection = expect(operation).rejects.toBe(deadlineReason);

    await vi.waitFor(() => {
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
    });
    controller.abort(deadlineReason);

    await rejection;
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("Extract 使用相同的单次网络重试策略", async () => {
    const canonicalUrl = "https://example.com/page";
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(createFetchNetworkError("ECONNRESET"))
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ url: canonicalUrl, raw_content: "page content" }],
        }),
      );

    await expect(
      createProvider(fetchImplementation).extract(
        [canonicalUrl],
        createRunSignal(),
      ),
    ).resolves.toEqual([
      { canonicalUrl, content: "page content" },
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
