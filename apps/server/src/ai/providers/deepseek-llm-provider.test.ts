/**
 * 测试职责：以零网络 transport 冻结 DeepSeek Adapter 的请求、取消和脱敏失败语义。
 *
 * Provider 原始错误正文使用 sentinel（哨兵值）验证不会进入业务层；
 * 测试不得读取环境变量或真实 Secret。
 */
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  RateLimitError,
} from "openai";
import { describe, expect, it, vi } from "vitest";

import { createDeferred } from "../../../../../tests/support/test-infrastructure.mjs";
import { LLMProviderError } from "../llm-provider.js";
import {
  DEEPSEEK_LLM_MODEL,
  DEEPSEEK_LLM_PROVIDER_ID,
  DEEPSEEK_RESPONSES_BASE_URL,
  DeepSeekLLMProvider,
  createDeepSeekSDKClientOptions,
} from "./deepseek-llm-provider.js";
import type {
  DeepSeekRequestOptions,
  DeepSeekStructuredRequest,
  DeepSeekTokenUsage,
} from "./deepseek-llm-provider.js";

const INPUT = {
  system: "只返回结构化结果。",
  user: "规划 Python 学习路径",
  schemaName: "graph_plan",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["topic"],
    properties: { topic: { type: "string" } },
  },
} as const;

function createProvider(
  transport: (
    request: DeepSeekStructuredRequest,
    options: DeepSeekRequestOptions,
  ) => PromiseLike<unknown>,
): DeepSeekLLMProvider {
  return new DeepSeekLLMProvider({ apiKey: "test-key", transport });
}

describe("DeepSeekLLMProvider Structured Output", () => {
  it("固定 baseURL、零重试与关闭 SDK 原始日志", () => {
    expect(createDeepSeekSDKClientOptions("  test-key  ")).toEqual({
      apiKey: "test-key",
      baseURL: "https://api.deepseek.com",
      maxRetries: 0,
      logLevel: "off",
    });
  });

  it("发送冻结模型、non-thinking、JSON Schema，并透传 signal/timeout", async () => {
    const controller = new AbortController();
    const transport = vi.fn(async () => ({
      status: "completed",
      output_text: '{"topic":"Python"}',
    }));
    const provider = createProvider(transport);

    await expect(
      provider.structured(INPUT, {
        signal: controller.signal,
        timeoutMs: 8_000,
      }),
    ).resolves.toEqual({ topic: "Python" });

    expect(provider.id).toBe(DEEPSEEK_LLM_PROVIDER_ID);
    expect(DEEPSEEK_LLM_MODEL).toBe("deepseek-flash");
    expect(DEEPSEEK_RESPONSES_BASE_URL).toBe("https://api.deepseek.com");
    expect(transport).toHaveBeenCalledWith(
      {
        model: "deepseek-flash",
        instructions: INPUT.system,
        input: INPUT.user,
        reasoning: { effort: "none" },
        text: {
          format: {
            type: "json_schema",
            name: "graph_plan",
            schema: INPUT.schema,
          },
        },
        store: false,
      },
      {
        signal: controller.signal,
        timeout: 8_000,
        maxRetries: 0,
      },
    );
  });

  it("只把合法聚合 Token 数量交给脱敏观察器", async () => {
    const usages: DeepSeekTokenUsage[] = [];
    const provider = new DeepSeekLLMProvider({
      apiKey: "test-key",
      onTokenUsage: usage => usages.push(usage),
      transport: async () => ({
        status: "completed",
        output_text: '{"topic":"Python"}',
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          total_tokens: 150,
          provider_private_details: "不得越过 Adapter",
        },
      }),
    });

    await provider.structured(INPUT, {
      signal: new AbortController().signal,
      timeoutMs: 8_000,
    });

    expect(usages).toEqual([
      { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    ]);
    expect(JSON.stringify(usages)).not.toContain("provider_private_details");
  });

  it.each([
    ["缺少 usage", undefined],
    ["字段类型非法", { input_tokens: "120", output_tokens: 30, total_tokens: 150 }],
    ["字段为负数", { input_tokens: 120, output_tokens: -1, total_tokens: 119 }],
  ])("%s 时不伪造 Token 数量", async (_name, usage) => {
    const onTokenUsage = vi.fn();
    const provider = new DeepSeekLLMProvider({
      apiKey: "test-key",
      onTokenUsage,
      transport: async () => ({
        status: "completed",
        output_text: '{"topic":"Python"}',
        ...(usage === undefined ? {} : { usage }),
      }),
    });

    await expect(
      provider.structured(INPUT, {
        signal: new AbortController().signal,
        timeoutMs: 8_000,
      }),
    ).resolves.toEqual({ topic: "Python" });
    expect(onTokenUsage).not.toHaveBeenCalled();
  });

  it("调用前取消或非法 timeout 都不会触发 transport", async () => {
    const transport = vi.fn(async () => ({
      status: "completed",
      output_text: "{}",
    }));
    const provider = createProvider(transport);
    const controller = new AbortController();
    const reason = new Error("用户取消");
    reason.name = "AbortError";
    controller.abort(reason);

    await expect(
      provider.structured(INPUT, {
        signal: controller.signal,
        timeoutMs: 8_000,
      }),
    ).rejects.toBe(reason);
    await expect(
      provider.structured(INPUT, {
        signal: new AbortController().signal,
        timeoutMs: 15_001,
      }),
    ).rejects.toThrow(RangeError);
    expect(transport).not.toHaveBeenCalled();
  });

  it("调用中取消传播同一个父 signal 原因", async () => {
    const started = createDeferred<void>();
    const transport = vi.fn(
      async (
        _request: DeepSeekStructuredRequest,
        options: DeepSeekRequestOptions,
      ): Promise<unknown> => {
        started.resolve();
        return await new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new APIUserAbortError()),
            { once: true },
          );
        });
      },
    );
    const provider = createProvider(transport);
    const controller = new AbortController();
    const reason = new Error("客户端断开");
    reason.name = "AbortError";
    const pending = provider.structured(INPUT, {
      signal: controller.signal,
      timeoutMs: 8_000,
    });

    await started.promise;
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["空输出", { status: "completed", output_text: "" }],
    ["非法 JSON", { status: "completed", output_text: "not-json" }],
    ["未完成响应", { status: "incomplete", output_text: "{}" }],
    ["null 响应", null],
    ["缺少字段", { status: "completed" }],
    ["字段类型错误", { status: "completed", output_text: 123 }],
  ])("将%s映射为不可重试的脱敏错误", async (_name, response) => {
    const provider = createProvider(async () => response);

    await expect(
      provider.structured(INPUT, {
        signal: new AbortController().signal,
        timeoutMs: 8_000,
      }),
    ).rejects.toMatchObject({
      name: "LLMProviderError",
      message: "LLM Provider 调用失败",
      kind: "invalid_response",
      retryable: false,
    });
  });
});

describe("DeepSeek Provider Error 脱敏映射", () => {
  const privateSentinel = "provider-private-response-body";
  const headers = new Headers();

  it.each([
    [
      "SDK timeout",
      new APIConnectionTimeoutError({ message: privateSentinel }),
      "timeout",
      true,
    ],
    [
      "rate limit",
      new RateLimitError(429, { message: privateSentinel }, privateSentinel, headers),
      "rate_limited",
      true,
    ],
    [
      "connection",
      new APIConnectionError({
        message: privateSentinel,
        cause: new Error(privateSentinel),
      }),
      "provider_failure",
      true,
    ],
    [
      "server",
      new APIError(503, { message: privateSentinel }, privateSentinel, headers),
      "provider_failure",
      true,
    ],
    [
      "request timeout",
      new APIError(408, { message: privateSentinel }, privateSentinel, headers),
      "provider_failure",
      true,
    ],
    [
      "conflict",
      new APIError(409, { message: privateSentinel }, privateSentinel, headers),
      "provider_failure",
      true,
    ],
    [
      "bad request",
      new APIError(400, { message: privateSentinel }, privateSentinel, headers),
      "provider_failure",
      false,
    ],
    ["unknown", new Error(privateSentinel), "provider_failure", false],
  ] as const)(
    "%s 不泄露原始错误并映射为 %s",
    async (_name, rawError, kind, retryable) => {
      const provider = createProvider(async () => {
        throw rawError;
      });

      let received: unknown;
      try {
        await provider.structured(INPUT, {
          signal: new AbortController().signal,
          timeoutMs: 8_000,
        });
      } catch (error: unknown) {
        received = error;
      }

      expect(received).toBeInstanceOf(LLMProviderError);
      expect(received).toMatchObject({
        message: "LLM Provider 调用失败",
        kind,
        retryable,
      });
      expect(JSON.stringify(received)).not.toContain(privateSentinel);
      expect(String(received)).not.toContain(privateSentinel);
    },
  );

  it("重新投影 transport 伪造的 LLMProviderError，移除私有扩展字段", async () => {
    const forgedError = Object.assign(
      new LLMProviderError("timeout", true),
      { cause: privateSentinel, privateBody: privateSentinel },
    );
    const provider = createProvider(async () => {
      throw forgedError;
    });

    let received: unknown;
    try {
      await provider.structured(INPUT, {
        signal: new AbortController().signal,
        timeoutMs: 8_000,
      });
    } catch (error: unknown) {
      received = error;
    }

    expect(received).toBeInstanceOf(LLMProviderError);
    expect(received).not.toBe(forgedError);
    expect(received).toMatchObject({
      kind: "provider_failure",
      retryable: false,
    });
    expect(JSON.stringify(received)).not.toContain(privateSentinel);
  });

  it("无父 signal 取消时将 SDK 取消错误转换为固定 AbortError", async () => {
    const provider = createProvider(async () => {
      throw new APIUserAbortError();
    });

    await expect(
      provider.structured(INPUT, {
        signal: new AbortController().signal,
        timeoutMs: 8_000,
      }),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "LLM 请求已取消",
    });
  });
});
