/**
 * 模块职责：为任意 SearchProvider 增加进程内 Search LRU Cache（缓存）。
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
  NormalizedSearchHit,
  ProviderSearchRequest,
} from "@wayfinder/contracts";
import { resolveSearchEngine } from "@wayfinder/contracts";
import { LRUCache } from "lru-cache";
import { z } from "zod";

import { observeCurrentRun } from "../observability/run-log-context.js";
import type { SearchProvider } from "./provider.js";

export const SEARCH_CACHE_TTL_MS = 10 * 60 * 1_000;
export const DEFAULT_SEARCH_CACHE_MAX_ENTRIES = 256;
/** Search 使用 V8 序列化字节近似；条目数与总量双重限制，避免 opaque metadata 绕过预算。 */
export const SEARCH_CACHE_MAX_SIZE_BYTES = 4 * 1_024 * 1_024;
export const SEARCH_CACHE_MAX_ENTRY_SIZE_BYTES = 512 * 1_024;
export type SearchProviderCacheObservation = Readonly<{
  operation: "search";
  hitCount: number;
  missCount: number;
}>;

export type MemoryCachedSearchProviderOptions = Readonly<{
  /** 默认读取墙钟；测试可注入单调推进的确定性时间。 */
  nowMs?: () => number;
  searchMaxEntries?: number;
  /** 只由组合根注入；跨授权代际仍共用同一有界池，不能为每位用户建立长期注册表。 */
  sharedCache?: SearchResultCache;
  /** 仅接受作者授权代际 UUID，不接收 Key（密钥）、邀请码或 Cookie（浏览器凭证）。 */
  namespace?: string;
  /** 回调只接收脱敏计数；其异常不得改变 Search 结果。 */
  onObservation?: (observation: SearchProviderCacheObservation) => void;
}>;

type CacheEntry<T> = Readonly<{
  expiresAtMs: number;
  value: T;
}>;

export type SearchResultCache = LRUCache<string, CacheEntry<readonly NormalizedSearchHit[]>>;

/** 创建固定字节预算的缓存池；条目数测试接缝不改变总字节和单项上限。 */
export function createSearchResultCache(searchMaxEntries?: number): SearchResultCache {
  return new LRUCache<string, CacheEntry<readonly NormalizedSearchHit[]>>({
    max: resolveMaxEntries("Search", searchMaxEntries, DEFAULT_SEARCH_CACHE_MAX_ENTRIES),
    maxSize: SEARCH_CACHE_MAX_SIZE_BYTES,
    maxEntrySize: SEARCH_CACHE_MAX_ENTRY_SIZE_BYTES,
  });
}

/** 不信任任意手工构造的 LRU 配置，防止注入时静默扩张共享内存预算。 */
function assertSharedCacheBudget(cache: SearchResultCache): void {
  if (cache.maxSize !== SEARCH_CACHE_MAX_SIZE_BYTES ||
    cache.maxEntrySize !== SEARCH_CACHE_MAX_ENTRY_SIZE_BYTES ||
    !Number.isSafeInteger(cache.max) || cache.max < 1) {
    throw new TypeError("共享 Search Cache 必须使用已批准的有界字节预算");
  }
}

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
    request.language,
    resolveSearchEngine(request.language, request.engine),
  ]);
}

function createHashedKey(
  namespace: "search-v1",
  parts: readonly unknown[],
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(parts), "utf8")
    .digest("hex");
  return `${namespace}:${digest}`;
}

function resolveMaxEntries(
  label: "Search",
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

function readNow(nowMs: () => number): number | null {
  const value = nowMs();
  return Number.isFinite(value) ? value : null;
}

/** 观察能力不能成为 Search 的新失败源。 */
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
  cache: SearchResultCache,
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

/**
 * 创建保持原 SearchProvider Port 的缓存装饰器。调用方应在 Composition Root
 * （组合根）创建一个长生命周期实例，再把它注入 Broad Discovery / Node Pipeline。
 */
export function createMemoryCachedSearchProvider(
  provider: SearchProvider,
  options: MemoryCachedSearchProviderOptions = {},
): SearchProvider {
  const nowMs = options.nowMs ?? Date.now;
  if (options.namespace !== undefined && !z.uuid().safeParse(options.namespace).success) {
    throw new TypeError("Search Cache 命名空间必须是服务端授权代际 UUID");
  }
  const searchCache = options.sharedCache ?? createSearchResultCache(options.searchMaxEntries);
  assertSharedCacheBudget(searchCache);
  const search: SearchProvider["search"] = async (request, signal) => {
    signal.throwIfAborted();
    const baseKey = createSearchCacheKey(provider.id, request);
    // 缺省严格保留旧 Key；代际进入摘要而非明文，防止跨代际命中但不另建缓存池。
    const key = options.namespace === undefined ? baseKey
      : createHashedKey("search-v1", [options.namespace, baseKey]);
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

  return {
    id: provider.id,
    capabilities: [...provider.capabilities],
    search,
  };
}
