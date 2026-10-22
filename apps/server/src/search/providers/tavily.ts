/**
 * 模块职责：在 Tavily HTTP API 与 WayFinder SearchProvider Port 之间完成边界适配。
 *
 * 关键约束：
 * - Provider JSON 始终以 unknown 接收，只有通过本文件的私有 Schema 后才能进入业务层；
 * - Tavily 的 snake_case 字段在这里立即转换，Graph Engine 只接收共享 camelCase Contract；
 * - Provider 私有 metadata、原始正文和错误正文均不得越过 Adapter 边界；
 * - 每次外部调用同时组合调用方 AbortSignal 与单次 Timeout，且 Timeout 不得突破全局 Run Deadline。
 */
import type {
  AppErrorCode,
  ExtractedPage,
  NormalizedSearchHit,
  ProviderSearchRequest,
  SearchCapability,
} from "@wayfinder/contracts";
import { z } from "zod";

import { RUN_DEADLINE_MS } from "../../config.js";
import type { SearchProvider } from "../provider.js";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";
const TAVILY_MAX_RESULTS = 20;
const TAVILY_MAX_EXTRACT_URLS = 20;
const MAX_ATTEMPTS = 2;

/*
 * WAY-46 在 2026-10-20 使用 6 条 Golden Queries 顺序执行 4 轮真实调用：
 * Search 24 个成功样本的平均值/P95 为 722/2035ms，Extract 为 1192/3051ms。
 * 按 max(平均值×1.5, P95×1.2) 向上取整至 100ms，得到短重试预算。
 */
const DEFAULT_SEARCH_RETRY_TIMEOUT_MS = 2_500;
const DEFAULT_EXTRACT_RETRY_TIMEOUT_MS = 3_700;

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

/** Provider 可增加字段，因此私有 Schema 只提取当前 Contract 所需的白名单。 */
const TavilySearchResponseSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        url: HttpUrlSchema,
        content: z.string(),
        score: z.number().finite().min(0).max(1),
        published_date: z.string().trim().min(1).nullable().optional(),
      }),
    )
    .max(TAVILY_MAX_RESULTS),
});

const TavilyExtractResponseSchema = z.object({
  results: z
    .array(
      z.object({
        url: HttpUrlSchema,
        raw_content: z.string(),
      }),
    )
    .max(TAVILY_MAX_EXTRACT_URLS),
});

export type TavilySearchProviderOptions = {
  apiKey: string;
  searchTimeoutMs: number;
  extractTimeoutMs: number;
  searchRetryTimeoutMs?: number;
  extractRetryTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
  /** 只记录脱敏 HTTP 尝试序号；不得在观察器中传递 Query、URL 或响应。 */
  onAttempt?: (observation: TavilyAttemptObservation) => void;
};

export type TavilyAttemptObservation = Readonly<{
  operation: "extract" | "search";
  attempt: 1 | 2;
}>;

/**
 * Adapter 错误只保存稳定的分类信息，不附带 Secret、请求头、响应正文或完整原始对象。
 */
export class TavilyProviderError extends Error {
  public readonly code: Extract<AppErrorCode, "SEARCH_PROVIDER_FAILED"> =
    "SEARCH_PROVIDER_FAILED";

  public constructor(
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "TavilyProviderError";
  }
}

export class TavilySearchProvider implements SearchProvider {
  public readonly id = "tavily";
  public readonly capabilities: SearchCapability[] = ["general"];

  private readonly apiKey: string;
  private readonly searchTimeoutMs: number;
  private readonly extractTimeoutMs: number;
  private readonly searchRetryTimeoutMs: number;
  private readonly extractRetryTimeoutMs: number;
  private readonly fetchImplementation: typeof fetch;
  private readonly onAttempt:
    | ((observation: TavilyAttemptObservation) => void)
    | undefined;

  public constructor(options: TavilySearchProviderOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey.length === 0) {
      throw new TavilyProviderError("Tavily API Key 不能为空");
    }

    assertTimeout("Search", options.searchTimeoutMs);
    assertTimeout("Extract", options.extractTimeoutMs);

    this.apiKey = apiKey;
    this.searchTimeoutMs = options.searchTimeoutMs;
    this.extractTimeoutMs = options.extractTimeoutMs;
    this.searchRetryTimeoutMs = resolveRetryTimeout(
      "Search",
      options.searchTimeoutMs,
      options.searchRetryTimeoutMs,
      DEFAULT_SEARCH_RETRY_TIMEOUT_MS,
    );
    this.extractRetryTimeoutMs = resolveRetryTimeout(
      "Extract",
      options.extractTimeoutMs,
      options.extractRetryTimeoutMs,
      DEFAULT_EXTRACT_RETRY_TIMEOUT_MS,
    );
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.onAttempt = options.onAttempt;
  }

  public async search(
    request: ProviderSearchRequest,
    signal: AbortSignal,
  ): Promise<NormalizedSearchHit[]> {
    if (
      !Number.isInteger(request.maxResults) ||
      request.maxResults < 1 ||
      request.maxResults > TAVILY_MAX_RESULTS
    ) {
      throw new TavilyProviderError(
        `Tavily Search maxResults 必须为 1-${TAVILY_MAX_RESULTS} 的整数`,
      );
    }

    const rawResponse = await this.postJson(
      TAVILY_SEARCH_URL,
      {
        query: request.query,
        max_results: request.maxResults,
        include_answer: false,
        include_raw_content: false,
      },
      "Search",
      this.searchTimeoutMs,
      this.searchRetryTimeoutMs,
      signal,
    );
    const parsedResponse = TavilySearchResponseSchema.safeParse(rawResponse);

    if (!parsedResponse.success) {
      throw new TavilyProviderError("Tavily Search 响应结构无效");
    }

    return parsedResponse.data.results
      .slice(0, request.maxResults)
      .map((result, index) => ({
        provider: this.id,
        query: request.query,
        title: result.title,
        url: result.url,
        canonicalUrl: result.url,
        domain: new URL(result.url).hostname.toLowerCase(),
        snippet: result.content,
        ...(result.published_date !== undefined
          ? { publishedAt: result.published_date }
          : {}),
        providerRank: index + 1,
        providerScore: result.score,
        // WAY-45 不允许业务层依赖 Tavily 的 request_id、response_time 等私有 metadata。
        rawMetadata: {},
      }));
  }

  public async extract(
    canonicalUrls: string[],
    signal: AbortSignal,
  ): Promise<ExtractedPage[]> {
    if (canonicalUrls.length === 0) {
      return [];
    }
    if (canonicalUrls.length > TAVILY_MAX_EXTRACT_URLS) {
      throw new TavilyProviderError(
        `Tavily Extract 一次最多接收 ${TAVILY_MAX_EXTRACT_URLS} 个 URL`,
      );
    }

    const requestedUrls = new Set<string>();
    for (const canonicalUrl of canonicalUrls) {
      if (!HttpUrlSchema.safeParse(canonicalUrl).success) {
        throw new TavilyProviderError("Tavily Extract 输入 URL 无效");
      }
      if (requestedUrls.has(canonicalUrl)) {
        throw new TavilyProviderError("Tavily Extract 输入 URL 不得重复");
      }
      requestedUrls.add(canonicalUrl);
    }

    const rawResponse = await this.postJson(
      TAVILY_EXTRACT_URL,
      {
        urls: canonicalUrls,
        include_images: false,
        extract_depth: "basic",
        format: "markdown",
      },
      "Extract",
      this.extractTimeoutMs,
      this.extractRetryTimeoutMs,
      signal,
    );
    const parsedResponse = TavilyExtractResponseSchema.safeParse(rawResponse);

    if (!parsedResponse.success) {
      throw new TavilyProviderError("Tavily Extract 响应结构无效");
    }

    /*
     * 不能信任 Provider 返回顺序，也不能用其 URL 替换 Pipeline 已选定的 canonicalUrl。
     * 因此先执行精确的一对一关联检查，再按调用方输入顺序构造结果。
     */
    const contentByCanonicalUrl = new Map<string, string>();
    for (const result of parsedResponse.data.results) {
      if (
        !requestedUrls.has(result.url) ||
        contentByCanonicalUrl.has(result.url)
      ) {
        throw new TavilyProviderError("Tavily Extract 响应关联无效");
      }
      contentByCanonicalUrl.set(result.url, result.raw_content);
    }

    return canonicalUrls.flatMap((canonicalUrl) => {
      const content = contentByCanonicalUrl.get(canonicalUrl);
      return content === undefined || content.trim().length === 0
        ? []
        : [{ canonicalUrl, content }];
    });
  }

  private async postJson(
    url: string,
    body: Readonly<Record<string, unknown>>,
    operation: "Search" | "Extract",
    timeoutMs: number,
    retryTimeoutMs: number,
    callerSignal: AbortSignal,
  ): Promise<unknown> {
    let lastRetryableMessage = `Tavily ${operation} 网络请求失败`;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const attemptTimeoutMs = attempt === 0 ? timeoutMs : retryTimeoutMs;
      const outcome = await this.runAttempt(
        url,
        body,
        operation,
        attemptTimeoutMs,
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

    throw new TavilyProviderError(lastRetryableMessage, true);
  }

  /**
   * 单次尝试只负责分类，不在此处递归重试；外层固定两轮循环从结构上保证
   * 错误类型不会叠加成第三次调用。调用方 Signal 永远优先于本地 Timeout。
   */
  private async runAttempt(
    url: string,
    body: Readonly<Record<string, unknown>>,
    operation: "Search" | "Extract",
    timeoutMs: number,
    callerSignal: AbortSignal,
    attempt: 1 | 2,
  ): Promise<AttemptOutcome> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = AbortSignal.any([callerSignal, timeoutSignal]);

    // 已取消的 Run 必须在任何网络副作用前终止，并保留其原始 reason。
    callerSignal.throwIfAborted();
    requestSignal.throwIfAborted();

    let response: Response;
    try {
      // 只有通过取消检查、即将调用 fetch 的尝试才计入实际 HTTP 次数。
      this.onAttempt?.({
        operation: operation === "Search" ? "search" : "extract",
        attempt,
      });
      response = await this.fetchImplementation(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
    } catch (error) {
      return classifyAttemptError(
        error,
        operation,
        timeoutSignal,
        callerSignal,
      );
    }

    callerSignal.throwIfAborted();
    if (timeoutSignal.aborted) {
      return {
        kind: "retryable",
        message: `Tavily ${operation} 请求超时`,
      };
    }

    if (!response.ok) {
      // HTTP 错误也可能携带未读完的流。重试前先释放正文，避免首个请求继续
      // 占用 undici 连接；清理失败不暴露底层错误，但 Run 取消仍拥有最高优先级。
      try {
        await cancelResponseBody(response, requestSignal);
      } catch (error) {
        return classifyAttemptError(
          error,
          operation,
          timeoutSignal,
          callerSignal,
        );
      }
      callerSignal.throwIfAborted();
      if (timeoutSignal.aborted) {
        return {
          kind: "retryable",
          message: `Tavily ${operation} 请求超时`,
        };
      }
      const message = `Tavily ${operation} 请求失败（HTTP ${response.status}）`;
      return RETRYABLE_HTTP_STATUSES.has(response.status)
        ? { kind: "retryable", message }
        : {
            kind: "terminal",
            error: new TavilyProviderError(message),
          };
    }

    try {
      const rawResponse: unknown = await response.json();
      callerSignal.throwIfAborted();
      timeoutSignal.throwIfAborted();
      return { kind: "success", rawResponse };
    } catch (error) {
      const classified = classifyAttemptError(
        error,
        operation,
        timeoutSignal,
        callerSignal,
      );
      if (classified.kind === "terminal") {
        return {
          kind: "terminal",
          error: new TavilyProviderError(
            `Tavily ${operation} 响应不是有效 JSON`,
          ),
        };
      }
      return classified;
    }
  }
}

/**
 * 尽力释放 HTTP 错误响应正文，保证后续重试能够复用连接。
 *
 * 正文取消属于资源清理：失败时继续沿用已经确定的 HTTP 分类，既不泄漏第三方
 * 错误细节，也不把清理失败误判成新的网络故障；但调用方 Run Signal 的原始
 * reason 必须在清理前后直接传播，交由 Orchestrator 统一映射。
 */
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

/**
 * 将可能永不结束的资源清理与当前尝试 Signal 竞速。
 *
 * 即使 Signal 在注册监听器的极短窗口内已经触发，注册后的二次检查也会立即
 * 拒绝；原 Promise 始终保留成功/失败处理器，避免竞速结束后出现未处理拒绝。
 */
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

type AttemptOutcome =
  | { kind: "success"; rawResponse: unknown }
  | { kind: "retryable"; message: string }
  | { kind: "terminal"; error: TavilyProviderError };

function classifyAttemptError(
  error: unknown,
  operation: "Search" | "Extract",
  timeoutSignal: AbortSignal,
  callerSignal: AbortSignal,
): Exclude<AttemptOutcome, { kind: "success" }> {
  // Run Deadline 与用户取消优先，Adapter 不改写、不记录也不重试。
  callerSignal.throwIfAborted();

  if (timeoutSignal.aborted) {
    return {
      kind: "retryable",
      message: `Tavily ${operation} 请求超时`,
    };
  }
  if (isNetworkConnectionError(error)) {
    return {
      kind: "retryable",
      message: `Tavily ${operation} 网络请求失败`,
    };
  }

  return {
    kind: "terminal",
    error: new TavilyProviderError(`Tavily ${operation} 请求失败`),
  };
}

/**
 * Node 原生 fetch 会把底层故障包装为 TypeError，但 TypeError 同时也表示参数与程序
 * 错误，因此不能仅凭错误类型或 `UND_ERR_` 前缀决定重试。这里只接受冻结的网络/
 * Timeout 错误码白名单，并沿 cause 有界查找；分类不依赖可能含 URL 的 message。
 */
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
  operation: "Search" | "Extract" | "Search Retry" | "Extract Retry",
  timeoutMs: number,
): void {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > RUN_DEADLINE_MS
  ) {
    throw new TavilyProviderError(
      `Tavily ${operation} Timeout 必须为 1-${RUN_DEADLINE_MS} 毫秒的整数`,
    );
  }
}

function resolveRetryTimeout(
  operation: "Search" | "Extract",
  configuredTimeoutMs: number,
  requestedRetryTimeoutMs: number | undefined,
  measuredDefaultMs: number,
): number {
  const retryTimeoutMs =
    requestedRetryTimeoutMs ?? Math.min(measuredDefaultMs, configuredTimeoutMs);
  assertTimeout(`${operation} Retry`, retryTimeoutMs);

  if (retryTimeoutMs > configuredTimeoutMs) {
    throw new TavilyProviderError(
      `Tavily ${operation} Retry Timeout 不能超过首次调用 Timeout`,
    );
  }
  return retryTimeoutMs;
}
