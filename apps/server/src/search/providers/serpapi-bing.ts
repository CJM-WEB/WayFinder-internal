/**
 * 模块职责：在 SerpAPI Bing Search HTTP API 与 WayFinder SearchProvider Port 之间完成边界适配。
 *
 * 关键约束：
 * - Provider JSON 始终以 unknown 接收，Envelope 与 organic result 分两层校验；
 * - 单个非法结果只丢弃自身，其他合法结果仍按原始数组位置保留 Provider Rank；
 * - api_key 位于 Query String，但仍按 Authorization Secret 处理，完整 URL 与原始正文不得进入错误；
 * - 每次尝试同时受调用方 AbortSignal 与 Provider Timeout 约束，且最多只允许一次重试。
 */
import type {
  AppErrorCode,
  NormalizedSearchHit,
  ProviderSearchRequest,
  SearchCapability,
} from "@wayfinder/contracts";
import { z } from "zod";

import { RUN_DEADLINE_MS } from "../../config.js";
import { observeCurrentRun } from "../../observability/run-log-context.js";
import type { SearchProvider } from "../provider.js";

const SERPAPI_BING_SEARCH_URL = "https://serpapi.com/search.json";
const SERPAPI_BING_MAX_RESULTS = 20;
const MAX_ATTEMPTS = 2;
const DEFAULT_SEARCH_RETRY_TIMEOUT_MS = 5_000;

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const NETWORK_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "EPROTO",
  "ETIMEDOUT",
  "ERR_NETWORK",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const HttpUrlSchema = z
  .string()
  .refine((value) => {
    if (value !== value.trim() || !URL.canParse(value)) {
      return false;
    }
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  });

/**
 * Envelope 只验证请求是否已成功结算，并把每个 Organic Result 保持为 unknown。
 * 逐项 Schema 不能合并到数组 Schema，否则一个坏项会拖垮整批合法结果。
 */
const SerpApiBingEnvelopeSchema = z.object({
  search_metadata: z.object({
    status: z.enum(["Success", "Error", "Processing", "Queued"]),
  }),
  error: z.string().optional(),
  organic_results: z.array(z.unknown()).optional(),
});

/** Provider 可增加字段；这里只白名单提取当前规范化边界需要的数据。 */
const SerpApiBingOrganicResultSchema = z.object({
  position: z.number().int().positive().optional(),
  title: z.string().trim().min(1),
  link: HttpUrlSchema,
  snippet: z.string().optional(),
});

export type SerpApiBingSearchProviderOptions = {
  apiKey: string;
  searchTimeoutMs: number;
  searchRetryTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
  /** 只记录脱敏的实际 HTTP 尝试序号；不得传递 Query、URL、Header 或响应。 */
  onAttempt?: (observation: SerpApiBingAttemptObservation) => void;
};

export type SerpApiBingAttemptObservation = Readonly<{
  operation: "search";
  attempt: 1 | 2;
}>;

/** Adapter 错误只保留稳定分类，不附带 Secret、请求 URL、响应正文或底层 cause。 */
export class SerpApiBingProviderError extends Error {
  public readonly code: Extract<AppErrorCode, "SEARCH_PROVIDER_FAILED"> =
    "SEARCH_PROVIDER_FAILED";

  public constructor(
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "SerpApiBingProviderError";
  }
}

/** WAY-106 只实现 Search；可选 Extract Port 继续保留给现有兼容边界。 */
export class SerpApiBingSearchProvider implements SearchProvider {
  public readonly id = "serpapi_bing";
  public readonly capabilities: SearchCapability[] = ["general"];

  private readonly apiKey: string;
  private readonly searchTimeoutMs: number;
  private readonly searchRetryTimeoutMs: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly onAttempt:
    | ((observation: SerpApiBingAttemptObservation) => void)
    | undefined;

  public constructor(options: SerpApiBingSearchProviderOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey.length === 0) {
      throw new SerpApiBingProviderError("SerpAPI API Key 不能为空");
    }

    assertTimeout("Search", options.searchTimeoutMs);

    this.apiKey = apiKey;
    this.searchTimeoutMs = options.searchTimeoutMs;
    this.searchRetryTimeoutMs = resolveRetryTimeout(
      options.searchTimeoutMs,
      options.searchRetryTimeoutMs,
    );
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.onAttempt = options.onAttempt;
  }

  public async search(
    request: ProviderSearchRequest,
    signal: AbortSignal,
  ): Promise<NormalizedSearchHit[]> {
    assertSearchRequest(request);

    const rawResponse = await this.getJson(
      createSearchUrl(request.query, request.language, this.apiKey),
      signal,
    );
    const parsedEnvelope = SerpApiBingEnvelopeSchema.safeParse(rawResponse);

    if (!parsedEnvelope.success) {
      throw new SerpApiBingProviderError(
        "SerpAPI Bing Search 响应结构无效",
      );
    }
    if (
      parsedEnvelope.data.search_metadata.status !== "Success" ||
      parsedEnvelope.data.error !== undefined
    ) {
      throw new SerpApiBingProviderError("SerpAPI Bing Search 返回错误");
    }

    return normalizeOrganicResults(
      parsedEnvelope.data.organic_results ?? [],
      request,
      this.id,
    );
  }

  private async getJson(
    requestUrl: URL,
    callerSignal: AbortSignal,
  ): Promise<unknown> {
    let lastRetryableMessage = "SerpAPI Bing Search 网络请求失败";

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const timeoutMs =
        attempt === 0 ? this.searchTimeoutMs : this.searchRetryTimeoutMs;
      const outcome = await this.runAttempt(
        requestUrl,
        timeoutMs,
        callerSignal,
        attempt === 0 ? 1 : 2,
      );

      if (outcome.kind === "success") {
        return outcome.rawResponse;
      }
      if (outcome.kind === "terminal") {
        throw outcome.error;
      }

      lastRetryableMessage = outcome.message;
    }

    throw new SerpApiBingProviderError(lastRetryableMessage, true);
  }

  /**
   * 单次尝试只负责执行与分类；固定两轮外层循环从结构上阻止递归或无限重试。
   * 调用方 Signal 在 Fetch、正文读取和资源清理前后始终具有最高优先级。
   */
  private async runAttempt(
    requestUrl: URL,
    timeoutMs: number,
    callerSignal: AbortSignal,
    attempt: 1 | 2,
  ): Promise<AttemptOutcome> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = AbortSignal.any([callerSignal, timeoutSignal]);

    callerSignal.throwIfAborted();
    requestSignal.throwIfAborted();

    let response: Response;
    try {
      observeCurrentRun({ kind: "http_attempt", operation: "search" });
      this.onAttempt?.({ operation: "search", attempt });
      response = await this.fetchImplementation(requestUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: requestSignal,
      });
    } catch (error) {
      return classifyAttemptError(error, timeoutSignal, callerSignal);
    }

    callerSignal.throwIfAborted();
    if (timeoutSignal.aborted) {
      return {
        kind: "retryable",
        message: "SerpAPI Bing Search 请求超时",
      };
    }

    if (!response.ok) {
      const message = `SerpAPI Bing Search 请求失败（HTTP ${response.status}）`;
      const retryableStatus = RETRYABLE_HTTP_STATUSES.has(response.status);
      const terminalHttpError = new SerpApiBingProviderError(message);

      // HTTP 错误响应也可能持有连接；重试前必须在同一组合 Signal 下释放正文。
      try {
        await cancelResponseBody(response, requestSignal);
      } catch (error) {
        callerSignal.throwIfAborted();
        return retryableStatus
          ? classifyAttemptError(error, timeoutSignal, callerSignal)
          : { kind: "terminal", error: terminalHttpError };
      }
      callerSignal.throwIfAborted();
      if (timeoutSignal.aborted) {
        return retryableStatus
          ? {
              kind: "retryable",
              message: "SerpAPI Bing Search 请求超时",
            }
          : { kind: "terminal", error: terminalHttpError };
      }

      return retryableStatus
        ? { kind: "retryable", message }
        : { kind: "terminal", error: terminalHttpError };
    }

    try {
      const rawResponse: unknown = await response.json();
      callerSignal.throwIfAborted();
      timeoutSignal.throwIfAborted();
      return { kind: "success", rawResponse };
    } catch (error) {
      const classified = classifyAttemptError(
        error,
        timeoutSignal,
        callerSignal,
      );
      return classified.kind === "terminal"
        ? {
            kind: "terminal",
            error: new SerpApiBingProviderError(
              "SerpAPI Bing Search 响应不是有效 JSON",
            ),
          }
        : classified;
    }
  }
}

function assertSearchRequest(request: ProviderSearchRequest): void {
  if (
    !Number.isInteger(request.maxResults) ||
    request.maxResults < 1 ||
    request.maxResults > SERPAPI_BING_MAX_RESULTS
  ) {
    throw new SerpApiBingProviderError(
      `SerpAPI Bing Search maxResults 必须为 1-${SERPAPI_BING_MAX_RESULTS} 的整数`,
    );
  }
  if (request.query.trim().length === 0) {
    throw new SerpApiBingProviderError("SerpAPI Bing Search Query 不能为空");
  }
  if (request.language !== "zh-CN") {
    // 这是最后一道 Adapter 边界：非法语言必须在网络调用前失败。
    throw new SerpApiBingProviderError("SerpAPI Bing Search language 不受支持");
  }
}

/**
 * 只发送已批准的第一页 Bing 参数。maxResults 是本地接纳上限，不映射为分页、
 * filters 或 no_cache 参数；URL 仅在 Adapter 内传给 Fetch，禁止写入错误与日志。
 */
function createSearchUrl(
  query: string,
  language: ProviderSearchRequest["language"],
  apiKey: string,
): URL {
  const url = new URL(SERPAPI_BING_SEARCH_URL);
  url.searchParams.set("engine", "bing");
  url.searchParams.set("q", query);
  url.searchParams.set("mkt", language);
  url.searchParams.set("safeSearch", "Strict");
  url.searchParams.set("device", "desktop");
  url.searchParams.set("output", "json");
  url.searchParams.set("api_key", apiKey);
  return url;
}

/**
 * 逐项校验后按原始数组位置生成 Provider Rank。坏项不会导致补号或重排；
 * 遍历会继续到第一页末尾，直到达到本地最多接纳数量。
 */
function normalizeOrganicResults(
  rawResults: readonly unknown[],
  request: ProviderSearchRequest,
  providerId: string,
): NormalizedSearchHit[] {
  const hits: NormalizedSearchHit[] = [];

  for (const [index, rawResult] of rawResults.entries()) {
    if (hits.length === request.maxResults) {
      break;
    }

    const parsedResult = SerpApiBingOrganicResultSchema.safeParse(rawResult);
    if (!parsedResult.success) {
      continue;
    }

    const result = parsedResult.data;
    hits.push({
      provider: providerId,
      query: request.query,
      title: result.title,
      url: result.link,
      canonicalUrl: result.link,
      domain: new URL(result.link).hostname.toLowerCase(),
      snippet: result.snippet?.trim() ?? "",
      providerRank: index + 1,
      // position 只作为已校验的可解释观测，业务层不得依赖 rawMetadata 排序。
      rawMetadata:
        result.position === undefined ? {} : { position: result.position },
    });
  }

  return hits;
}

type AttemptOutcome =
  | { kind: "success"; rawResponse: unknown }
  | { kind: "retryable"; message: string }
  | { kind: "terminal"; error: SerpApiBingProviderError };

function classifyAttemptError(
  error: unknown,
  timeoutSignal: AbortSignal,
  callerSignal: AbortSignal,
): Exclude<AttemptOutcome, { kind: "success" }> {
  callerSignal.throwIfAborted();

  if (timeoutSignal.aborted) {
    return {
      kind: "retryable",
      message: "SerpAPI Bing Search 请求超时",
    };
  }
  if (isNetworkConnectionError(error)) {
    return {
      kind: "retryable",
      message: "SerpAPI Bing Search 网络请求失败",
    };
  }

  return {
    kind: "terminal",
    error: new SerpApiBingProviderError("SerpAPI Bing Search 请求失败"),
  };
}

/** 尽力释放错误响应正文；清理失败不得泄漏底层信息或遮蔽调用方取消。 */
async function cancelResponseBody(
  response: Response,
  requestSignal: AbortSignal,
): Promise<void> {
  requestSignal.throwIfAborted();
  if (response.body === null) {
    return;
  }

  try {
    await awaitWithAbortSignal(response.body.cancel(), requestSignal);
  } catch {
    requestSignal.throwIfAborted();
  }
  requestSignal.throwIfAborted();
}

/** 将可能卡住的资源清理与本次组合 Signal 竞速，并封闭 Listener 注册竞态。 */
function awaitWithAbortSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );

    if (signal.aborted) {
      onAbort();
    }
  });
}

/** 只依据稳定网络错误码有界检查 cause，不能按可能含完整 URL 的 message 分类。 */
function isNetworkConnectionError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "NetworkError") {
    return true;
  }

  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return false;
    }
    const code = Reflect.get(current, "code");
    if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) {
      return true;
    }
    current = Reflect.get(current, "cause");
  }

  return false;
}

function assertTimeout(
  operation: "Search" | "Search Retry",
  timeoutMs: number,
): void {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > RUN_DEADLINE_MS
  ) {
    throw new SerpApiBingProviderError(
      `SerpAPI Bing ${operation} Timeout 必须为 1-${RUN_DEADLINE_MS} 毫秒的整数`,
    );
  }
}

function resolveRetryTimeout(
  configuredTimeoutMs: number,
  requestedRetryTimeoutMs: number | undefined,
): number {
  const retryTimeoutMs =
    requestedRetryTimeoutMs ??
    Math.min(DEFAULT_SEARCH_RETRY_TIMEOUT_MS, configuredTimeoutMs);
  assertTimeout("Search Retry", retryTimeoutMs);

  if (retryTimeoutMs > configuredTimeoutMs) {
    throw new SerpApiBingProviderError(
      "SerpAPI Bing Search Retry Timeout 不能超过首次调用 Timeout",
    );
  }
  return retryTimeoutMs;
}
