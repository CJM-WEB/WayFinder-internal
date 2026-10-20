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
  fetchImplementation?: typeof fetch;
};

/**
 * Adapter 错误只保存稳定的分类信息，不附带 Secret、请求头、响应正文或完整原始对象。
 */
export class TavilyProviderError extends Error {
  public constructor(message: string) {
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
  private readonly fetchImplementation: typeof fetch;

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
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async search(
    request: ProviderSearchRequest,
    signal?: AbortSignal,
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
    signal?: AbortSignal,
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
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;

    // 已取消的 Run 必须在任何网络副作用前终止。
    requestSignal.throwIfAborted();

    const response = await this.fetchImplementation(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    });

    if (!response.ok) {
      throw new TavilyProviderError(
        `Tavily ${operation} 请求失败（HTTP ${response.status}）`,
      );
    }

    try {
      const rawResponse: unknown = await response.json();
      return rawResponse;
    } catch {
      // Body 读取同样受组合信号约束；取消原因必须原样交给上层状态机处理。
      requestSignal.throwIfAborted();
      throw new TavilyProviderError(`Tavily ${operation} 响应不是有效 JSON`);
    }
  }
}

function assertTimeout(operation: "Search" | "Extract", timeoutMs: number): void {
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
