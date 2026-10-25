/**
 * 模块职责：为任意 SearchProvider 增加进程内 Search / Extract LRU Cache（缓存）。
 *
 * 设计边界：
 * - 只缓存 Provider 已规范化的成功结果，不读取 Provider 私有字段或 Secret；
 * - Key 只保留版本化 SHA-256 摘要，观察器只接收 Hit/Miss 聚合计数；
 * - 缓存不拥有 Run 生命周期，始终复用并复核调用方 AbortSignal；
 * - 不持久化、不合并并发请求、不重试，也不改变底层 Provider 的错误语义。
 */
import { createHash } from "node:crypto";
import { serialize } from "node:v8";

import type {
  ExtractedPage,
  NormalizedSearchHit,
  ProviderSearchRequest,
} from "@wayfinder/contracts";
import { LRUCache } from "lru-cache";

import { observeCurrentRun } from "../observability/run-log-context.js";
import type { SearchProvider } from "./provider.js";

export const SEARCH_CACHE_TTL_MS = 10 * 60 * 1_000;
export const EXTRACT_CACHE_TTL_MS = 60 * 60 * 1_000;
export const DEFAULT_SEARCH_CACHE_MAX_ENTRIES = 256;
export const DEFAULT_EXTRACT_CACHE_MAX_ENTRIES = 512;
/** Search 使用 V8 序列化字节近似；条目数与总量双重限制，避免 opaque metadata 绕过预算。 */
export const SEARCH_CACHE_MAX_SIZE_BYTES = 4 * 1_024 * 1_024;
export const SEARCH_CACHE_MAX_ENTRY_SIZE_BYTES = 512 * 1_024;
/** Extract 仅含字符串字段，使用 UTF-16 code unit 作为确定性近似预算。 */
export const EXTRACT_CACHE_MAX_SIZE_CODE_UNITS = 16 * 1_024 * 1_024;
export const EXTRACT_CACHE_MAX_ENTRY_SIZE_CODE_UNITS = 1_024 * 1_024;
/** V0 唯一 Tavily Provider 的批量上限；更大请求直接旁路缓存并交回 Adapter 校验。 */
export const DEFAULT_MAX_CACHEABLE_EXTRACT_URLS = 20;

export type SearchProviderCacheObservation = Readonly<{
  operation: "search" | "extract";
  hitCount: number;
  missCount: number;
}>;

export type MemoryCachedSearchProviderOptions = Readonly<{
  /** 默认读取墙钟；测试可注入单调推进的确定性时间。 */
  nowMs?: () => number;
  searchMaxEntries?: number;
  extractMaxEntries?: number;
  /** 只决定是否旁路缓存；底层 Provider 仍是输入有效性的最终校验者。 */
  maxCacheableExtractUrls?: number;
  /** 回调只接收脱敏计数；其异常不得改变 Search / Extract 结果。 */
  onObservation?: (observation: SearchProviderCacheObservation) => void;
}>;

type CacheEntry<T> = Readonly<{
  expiresAtMs: number;
  value: T;
}>;

/** 固定字段顺序避免对象插入顺序影响 Key；nodeId 只标识 Graph，不改变检索语义。 */
export function createSearchCacheKey(
  providerId: string,
  request: ProviderSearchRequest,
): string {
  return createHashedKey("search-v1", [
    providerId,
    request.kind,
    request.query,
    request.maxResults,
    request.capability,
    request.freshnessSensitive,
    request.language ?? null,
  ]);
}

/** Extract 必须按单个完整 canonicalUrl 缓存，不能把 Batch 数组当作身份。 */
export function createExtractCacheKey(
  providerId: string,
  canonicalUrl: string,
): string {
  return createHashedKey("extract-v1", [providerId, canonicalUrl]);
}

function createHashedKey(
  namespace: "search-v1" | "extract-v1",
  parts: readonly unknown[],
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(parts), "utf8")
    .digest("hex");
  return `${namespace}:${digest}`;
}

function resolveMaxEntries(
  label: "Search" | "Extract" | "Extract Batch",
  value: number | undefined,
  fallback: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${label} Cache 容量必须为正安全整数`);
  }
  return resolved;
}

/**
 * `rawMetadata` 的运行时类型仍是 unknown。V8 序列化可覆盖 Map、ArrayBuffer 等
 * structuredClone 支持但 JSON 会低估的值；无法序列化时直接跳过缓存。返回 null
 * 是 fail-open（失败时保持业务成功），也会拒绝共享内存等无法安全隔离的值。
 */
function measureSearchEntryBytes(
  key: string,
  hits: readonly NormalizedSearchHit[],
): number | null {
  try {
    return Buffer.byteLength(key, "utf8") + serialize(hits).byteLength;
  } catch {
    return null;
  }
}

function measureExtractEntryCodeUnits(
  key: string,
  page: ExtractedPage,
): number {
  return Math.max(
    1,
    key.length + page.canonicalUrl.length + page.content.length,
  );
}

/**
 * Provider 输出可能含 opaque rawMetadata；无法安全复制时直接跳过缓存，不能让优化层
 * 把一个成功的 Provider 调用升级为业务失败。
 */
function cloneSearchHits(
  hits: readonly NormalizedSearchHit[],
): NormalizedSearchHit[] | null {
  try {
    return structuredClone([...hits]);
  } catch {
    return null;
  }
}

function clonePage(page: ExtractedPage): ExtractedPage {
  return { canonicalUrl: page.canonicalUrl, content: page.content };
}

function readNow(nowMs: () => number): number | null {
  const value = nowMs();
  return Number.isFinite(value) ? value : null;
}

/** 观察能力不能成为 Search / Extract 的新失败源。 */
function emitObservation(
  observer: MemoryCachedSearchProviderOptions["onObservation"],
  observation: SearchProviderCacheObservation,
): void {
  // Async Context 只接收脱敏计数，用于并发 Run 的本地日志归属。
  observeCurrentRun({ kind: "cache", ...observation });
  try {
    observer?.(observation);
  } catch {
    // 未来 Run Log 暂时不可用时，缓存与 Provider 业务语义仍保持不变。
  }
}

function readSearchEntry(
  cache: LRUCache<string, CacheEntry<readonly NormalizedSearchHit[]>>,
  key: string,
  nowMs: () => number,
): NormalizedSearchHit[] | null {
  const entry = cache.get(key);
  if (entry === undefined) {
    return null;
  }
  const now = readNow(nowMs);
  if (now === null || entry.expiresAtMs <= now) {
    cache.delete(key);
    return null;
  }

  const cloned = cloneSearchHits(entry.value);
  if (cloned === null) {
    cache.delete(key);
  }
  return cloned;
}

function readExtractEntry(
  cache: LRUCache<string, CacheEntry<ExtractedPage>>,
  key: string,
  nowMs: () => number,
): ExtractedPage | null {
  const entry = cache.get(key);
  if (entry === undefined) {
    return null;
  }
  const now = readNow(nowMs);
  if (now === null || entry.expiresAtMs <= now) {
    cache.delete(key);
    return null;
  }
  return clonePage(entry.value);
}

/**
 * 创建保持原 SearchProvider Port 的缓存装饰器。调用方应在 Composition Root
 * （组合根）创建一个长生命周期实例，再把它注入 Broad Discovery / Node Pipeline。
 */
export function createMemoryCachedSearchProvider(
  provider: SearchProvider,
  options: MemoryCachedSearchProviderOptions = {},
): SearchProvider {
  const nowMs = options.nowMs ?? Date.now;
  const searchCache = new LRUCache<
    string,
    CacheEntry<readonly NormalizedSearchHit[]>
  >({
    max: resolveMaxEntries(
      "Search",
      options.searchMaxEntries,
      DEFAULT_SEARCH_CACHE_MAX_ENTRIES,
    ),
    maxSize: SEARCH_CACHE_MAX_SIZE_BYTES,
    maxEntrySize: SEARCH_CACHE_MAX_ENTRY_SIZE_BYTES,
  });
  const extractCache = new LRUCache<string, CacheEntry<ExtractedPage>>({
    max: resolveMaxEntries(
      "Extract",
      options.extractMaxEntries,
      DEFAULT_EXTRACT_CACHE_MAX_ENTRIES,
    ),
    maxSize: EXTRACT_CACHE_MAX_SIZE_CODE_UNITS,
    maxEntrySize: EXTRACT_CACHE_MAX_ENTRY_SIZE_CODE_UNITS,
  });
  const maxCacheableExtractUrls = resolveMaxEntries(
    "Extract Batch",
    options.maxCacheableExtractUrls,
    DEFAULT_MAX_CACHEABLE_EXTRACT_URLS,
  );

  const search: SearchProvider["search"] = async (request, signal) => {
    signal.throwIfAborted();
    const key = createSearchCacheKey(provider.id, request);
    const cached = readSearchEntry(searchCache, key, nowMs);
    if (cached !== null) {
      emitObservation(options.onObservation, {
        operation: "search",
        hitCount: 1,
        missCount: 0,
      });
      signal.throwIfAborted();
      return cached;
    }

    emitObservation(options.onObservation, {
      operation: "search",
      hitCount: 0,
      missCount: 1,
    });
    const hits = await provider.search(request, signal);
    // Provider 若忽略 Signal 并迟到，绝不能把迟到结果返回或写入跨 Run Cache。
    signal.throwIfAborted();

    const cacheValue = cloneSearchHits(hits);
    const storedAtMs = readNow(nowMs);
    if (cacheValue !== null && storedAtMs !== null) {
      const size = measureSearchEntryBytes(key, cacheValue);
      if (
        size !== null &&
        size <= SEARCH_CACHE_MAX_ENTRY_SIZE_BYTES
      ) {
        signal.throwIfAborted();
        searchCache.set(
          key,
          {
            expiresAtMs: storedAtMs + SEARCH_CACHE_TTL_MS,
            value: cacheValue,
          },
          { size },
        );
      }
    }
    return hits;
  };

  const baseProvider: SearchProvider = {
    id: provider.id,
    capabilities: [...provider.capabilities],
    search,
  };
  const providerExtract = provider.extract;
  if (providerExtract === undefined) {
    return baseProvider;
  }

  const extract: NonNullable<SearchProvider["extract"]> = async (
    canonicalUrls,
    signal,
  ) => {
    signal.throwIfAborted();
    if (canonicalUrls.length === 0) {
      return [];
    }

    /*
     * 缓存层不知道未来 Provider 的全部私有输入规则。重复 URL 或超过 V0 Tavily
     * 上限的批次不做 Lookup，必须完整委托 Adapter，防止 Warm Cache 绕过其校验。
     */
    if (
      new Set(canonicalUrls).size !== canonicalUrls.length ||
      canonicalUrls.length > maxCacheableExtractUrls
    ) {
      const pages = await providerExtract.call(
        provider,
        canonicalUrls,
        signal,
      );
      signal.throwIfAborted();
      return pages;
    }

    const cachedByCanonicalUrl = new Map<string, ExtractedPage>();
    const missingCanonicalUrls: string[] = [];
    for (const canonicalUrl of canonicalUrls) {
      const cached = readExtractEntry(
        extractCache,
        createExtractCacheKey(provider.id, canonicalUrl),
        nowMs,
      );
      if (cached === null) {
        missingCanonicalUrls.push(canonicalUrl);
      } else {
        cachedByCanonicalUrl.set(canonicalUrl, cached);
      }
    }

    emitObservation(options.onObservation, {
      operation: "extract",
      hitCount: canonicalUrls.length - missingCanonicalUrls.length,
      missCount: missingCanonicalUrls.length,
    });
    signal.throwIfAborted();

    if (missingCanonicalUrls.length === 0) {
      return canonicalUrls.map(canonicalUrl =>
        clonePage(cachedByCanonicalUrl.get(canonicalUrl)!),
      );
    }

    const freshPages = await providerExtract.call(
      provider,
      missingCanonicalUrls,
      signal,
    );
    signal.throwIfAborted();

    /*
     * Provider Port 承诺返回规范化 Page，但缓存层仍防御未知 URL 与重复关联。异常批次
     * 不写缓存；Fresh 原项与已有 Hit 一并交给下游 Validator，避免隐藏非法关联。
     */
    const missingSet = new Set(missingCanonicalUrls);
    const freshByCanonicalUrl = new Map<string, ExtractedPage>();
    let cacheableBatch = true;
    for (const page of freshPages) {
      if (
        !missingSet.has(page.canonicalUrl) ||
        freshByCanonicalUrl.has(page.canonicalUrl)
      ) {
        cacheableBatch = false;
        break;
      }
      freshByCanonicalUrl.set(page.canonicalUrl, page);
    }
    if (!cacheableBatch) {
      return [
        ...canonicalUrls.flatMap(canonicalUrl => {
          const cached = cachedByCanonicalUrl.get(canonicalUrl);
          return cached === undefined ? [] : [clonePage(cached)];
        }),
        ...freshPages.map(clonePage),
      ];
    }

    const storedAtMs = readNow(nowMs);
    if (storedAtMs !== null) {
      for (const [canonicalUrl, page] of freshByCanonicalUrl) {
        // 缺失或空正文不做负缓存，下次仍允许 Provider 恢复。
        if (page.content.trim().length === 0) {
          continue;
        }
        const key = createExtractCacheKey(provider.id, canonicalUrl);
        const cacheValue = clonePage(page);
        const size = measureExtractEntryCodeUnits(key, cacheValue);
        if (size > EXTRACT_CACHE_MAX_ENTRY_SIZE_CODE_UNITS) {
          continue;
        }
        signal.throwIfAborted();
        extractCache.set(
          key,
          {
            expiresAtMs: storedAtMs + EXTRACT_CACHE_TTL_MS,
            value: cacheValue,
          },
          { size },
        );
      }
    }

    // 只返回本次请求的有效关联，并恢复调用方原始 URL 顺序。
    return canonicalUrls.flatMap(canonicalUrl => {
      const page =
        cachedByCanonicalUrl.get(canonicalUrl) ??
        freshByCanonicalUrl.get(canonicalUrl);
      return page === undefined ? [] : [clonePage(page)];
    });
  };

  return { ...baseProvider, extract };
}
