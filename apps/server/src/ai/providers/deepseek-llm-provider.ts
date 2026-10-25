/**
 * 模块职责：通过 OpenAI SDK 的 Responses API 兼容层调用 DeepSeek Structured Output。
 *
 * 关键边界：
 * - Provider、模型、baseURL 与 non-thinking 模式均使用 WAY-10 冻结值。
 * - 父 AbortSignal 与有界 timeout 直接传给 SDK；maxRetries 固定为 0。
 * - SDK Error 和响应正文不得越过 Adapter，只能转换为脱敏 LLMProviderError。
 */
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  RateLimitError,
} from "openai";

import { observeCurrentRun } from "../../observability/run-log-context.js";
import {
  assertBoundedLLMTimeout,
  LLMProviderError,
} from "../llm-provider.js";
import type {
  LLMCallOptions,
  LLMProvider,
  StructuredLLMInput,
} from "../llm-provider.js";

export const DEEPSEEK_LLM_PROVIDER_ID = "deepseek" as const;
export const DEEPSEEK_LLM_MODEL = "deepseek-flash" as const;
export const DEEPSEEK_RESPONSES_BASE_URL =
  "https://api.deepseek.com" as const;

/**
 * 固定关闭 SDK Logger，避免部署环境中的 OPENAI_LOG 意外开启原始 HTTP 响应日志。
 * 未来可观测性必须走项目自己的脱敏 Run Log，不能复用第三方 Debug Logger。
 */
export function createDeepSeekSDKClientOptions(apiKey: string): Readonly<{
  apiKey: string;
  baseURL: typeof DEEPSEEK_RESPONSES_BASE_URL;
  maxRetries: 0;
  logLevel: "off";
}> {
  return {
    apiKey: apiKey.trim(),
    baseURL: DEEPSEEK_RESPONSES_BASE_URL,
    maxRetries: 0,
    logLevel: "off",
  };
}

/** Adapter 发给 SDK 的固定请求形状；测试通过同一边界检查参数而不访问网络。 */
export type DeepSeekStructuredRequest = Readonly<{
  model: typeof DEEPSEEK_LLM_MODEL;
  instructions: string;
  input: string;
  reasoning: Readonly<{ effort: "none" }>;
  text: Readonly<{
    format: Readonly<{
      type: "json_schema";
      name: string;
      schema: Record<string, unknown>;
    }>;
  }>;
  store: false;
}>;

/** 每次请求再次显式关闭重试，避免客户端配置被未来重构静默覆盖。 */
export type DeepSeekRequestOptions = Readonly<{
  signal: AbortSignal;
  timeout: number;
  maxRetries: 0;
}>;

export type DeepSeekResponseTransport = (
  request: DeepSeekStructuredRequest,
  options: DeepSeekRequestOptions,
) => PromiseLike<unknown>;

/**
 * 仅暴露计费所需的聚合 Token（词元）数量；Provider 的明细、请求标识与原始响应
 * 仍停留在 Adapter 边界内，避免 Eval 可观测性扩大敏感数据面。
 */
export type DeepSeekTokenUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}>;

export type DeepSeekLLMProviderOptions = Readonly<{
  apiKey: string;
  /** 测试只注入同形 transport；生产默认使用固定配置的 OpenAI SDK Client。 */
  transport?: DeepSeekResponseTransport;
  /** 可选脱敏出口；缺失或非法 usage 不调用，调用方据此标记不可用。 */
  onTokenUsage?: (usage: DeepSeekTokenUsage) => void;
}>;

function createAbortError(): Error {
  const error = new Error("LLM 请求已取消");
  error.name = "AbortError";
  return error;
}

/**
 * 第三方响应始终是不可信输入，只提取本步骤消费的最小字段。
 * GraphPlan 的业务结构由 WAY-36 的 Zod Schema 继续校验，此处只守住 SDK 边界。
 */
function readCompletedOutputText(response: unknown): string {
  if (
    typeof response !== "object" ||
    response === null ||
    !("status" in response) ||
    response.status !== "completed" ||
    !("output_text" in response) ||
    typeof response.output_text !== "string" ||
    response.output_text.length === 0
  ) {
    throw new LLMProviderError("invalid_response", false);
  }

  return response.output_text;
}

/** 第三方 usage 同样是不可信输入，只接受三个非负安全整数。 */
function readTokenUsage(response: unknown): DeepSeekTokenUsage | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }

  const usage = Reflect.get(response, "usage");
  if (typeof usage !== "object" || usage === null) {
    return null;
  }

  const inputTokens = Reflect.get(usage, "input_tokens");
  const outputTokens = Reflect.get(usage, "output_tokens");
  const totalTokens = Reflect.get(usage, "total_tokens");
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    !Number.isSafeInteger(totalTokens) ||
    (inputTokens as number) < 0 ||
    (outputTokens as number) < 0 ||
    (totalTokens as number) < 0
  ) {
    return null;
  }

  return {
    inputTokens: inputTokens as number,
    outputTokens: outputTokens as number,
    totalTokens: totalTokens as number,
  };
}

/**
 * SDK Error 可能持有响应正文和 Headers；这里只读取分类所需字段，
 * 构造的新错误不保存 message、cause、response 或 request ID。
 */
function mapSDKError(error: unknown): LLMProviderError {
  if (error instanceof APIConnectionTimeoutError) {
    return new LLMProviderError("timeout", true);
  }

  if (error instanceof RateLimitError) {
    return new LLMProviderError("rate_limited", true);
  }

  if (error instanceof APIConnectionError) {
    return new LLMProviderError("provider_failure", true);
  }

  if (error instanceof APIError) {
    const status = error.status;
    const retryable =
      status === 408 ||
      status === 409 ||
      (typeof status === "number" && status >= 500);

    return new LLMProviderError("provider_failure", retryable);
  }

  return new LLMProviderError("provider_failure", false);
}

export class DeepSeekLLMProvider implements LLMProvider {
  public readonly id = DEEPSEEK_LLM_PROVIDER_ID;
  readonly #transport: DeepSeekResponseTransport;
  readonly #onTokenUsage: ((usage: DeepSeekTokenUsage) => void) | undefined;

  public constructor(options: DeepSeekLLMProviderOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error("DeepSeek API Key 不能为空");
    }

    this.#onTokenUsage = options.onTokenUsage;

    if (options.transport !== undefined) {
      this.#transport = options.transport;
      return;
    }

    const client = new OpenAI(createDeepSeekSDKClientOptions(options.apiKey));

    this.#transport = (request, requestOptions) =>
      client.responses.create(request, requestOptions);
  }

  public async structured(
    input: StructuredLLMInput,
    options: LLMCallOptions,
  ): Promise<unknown> {
    if (options.signal.aborted) {
      throw options.signal.reason;
    }
    assertBoundedLLMTimeout(options.timeoutMs);

    let response: unknown;
    try {
      response = await this.#transport(
        {
          model: DEEPSEEK_LLM_MODEL,
          instructions: input.system,
          input: input.user,
          reasoning: { effort: "none" },
          text: {
            format: {
              type: "json_schema",
              name: input.schemaName,
              schema: { ...input.schema },
            },
          },
          store: false,
        },
        {
          signal: options.signal,
          timeout: options.timeoutMs,
          maxRetries: 0,
        },
      );

    } catch (error: unknown) {
      // 父 signal 的原始取消原因必须向上游传播，不能降级成普通 Provider 失败。
      if (options.signal.aborted) {
        throw options.signal.reason;
      }
      if (error instanceof APIUserAbortError) {
        throw createAbortError();
      }
      // Transport 抛出的对象一律重新投影，防止伪造错误携带 cause 或原始正文。
      throw mapSDKError(error);
    }

    const outputText = readCompletedOutputText(response);
    const usage = readTokenUsage(response);
    if (usage !== null) {
      // Run Log 与外部观察器均为旁路能力，异常不得把有效模型响应改成失败。
      observeCurrentRun({ kind: "token_usage", ...usage });
      try {
        this.#onTokenUsage?.(usage);
      } catch {
        // 可观测性失败不改变 Structured Output 结果。
      }
    }
    try {
      // Structured Output 保证 JSON 形状，但业务 Schema 校验仍由 WAY-36 负责。
      const value: unknown = JSON.parse(outputText);
      return value;
    } catch {
      throw new LLMProviderError("invalid_response", false);
    }
  }
}
