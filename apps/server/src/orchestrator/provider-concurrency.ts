/**
 * 模块职责：在 Provider Port（提供方端口）边界集中限制真实外部调用并发。
 *
 * 生命周期边界：Composition Root（组合根）应只创建一个长生命周期实例，并让所有
 * Run 共用；Search、Extract、LLM 使用三个独立队列，不能限制整个 Node Pipeline。
 * Cache 应包在 Search 装饰器外层，使命中缓存时不占真实外部调用槽位。
 */
import pLimit from "p-limit";

import type { LLMProvider } from "../ai/llm-provider.js";
import {
  MAX_EXTRACT_CONCURRENCY,
  MAX_LLM_CONCURRENCY,
  MAX_SEARCH_CONCURRENCY,
} from "../config.js";
import type { SearchProvider } from "../search/provider.js";

export type ProviderConcurrencyLimits = Readonly<{
  search: number;
  extract: number;
  llm: number;
}>;

export type ConcurrencyLimitedProviders = Readonly<{
  searchProvider: SearchProvider;
  llmProvider: LLMProvider;
}>;

export type CreateConcurrencyLimitedProvidersInput = Readonly<{
  searchProvider: SearchProvider;
  llmProvider: LLMProvider;
  concurrency: ProviderConcurrencyLimits;
}>;

type Limit = ReturnType<typeof pLimit>;

function assertConcurrencyLimit(
  label: "Search" | "Extract" | "LLM",
  value: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} 并发上限必须是 1 到 ${maximum} 的安全整数`);
  }
}

/**
 * p-limit 负责 Permit（许可）计数；本层补齐排队取消语义：调用方在等待槽位时即可
 * 收到原始 Abort reason，而队列稍后轮到该任务时会在调用真实 Provider 前再次拒绝。
 */
function runLimited<T>(
  limit: Limit,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const scheduled = limit(async () => {
    signal.throwIfAborted();
    const result = await operation();
    // 防御忽略 Signal 的 Provider：取消后的迟到成功不能穿过装饰器。
    signal.throwIfAborted();
    return result;
  });

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (reason: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(reason);
    };
    const resolveOnce = (value: T): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = (): void => {
      rejectOnce(signal.reason);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    // 封闭初次检查与 Listener 注册之间的取消竞态。
    if (signal.aborted) {
      onAbort();
    }

    void scheduled.then(
      value => {
        if (signal.aborted) {
          rejectOnce(signal.reason);
        } else {
          resolveOnce(value);
        }
      },
      error => {
        // Run 取消优先于同时发生的普通 Provider 错误。
        rejectOnce(signal.aborted ? signal.reason : error);
      },
    );
  });
}

/**
 * 创建进程级共享的三层并发装饰器。单次 Adapter 逻辑调用（含其内部有界重试）只占
 * 一个槽位；本模块不读取 Provider 私有字段、不创建 Timeout，也不改写普通错误。
 */
export function createConcurrencyLimitedProviders(
  input: CreateConcurrencyLimitedProvidersInput,
): ConcurrencyLimitedProviders {
  assertConcurrencyLimit(
    "Search",
    input.concurrency.search,
    MAX_SEARCH_CONCURRENCY,
  );
  assertConcurrencyLimit(
    "Extract",
    input.concurrency.extract,
    MAX_EXTRACT_CONCURRENCY,
  );
  assertConcurrencyLimit(
    "LLM",
    input.concurrency.llm,
    MAX_LLM_CONCURRENCY,
  );

  const searchLimit = pLimit(input.concurrency.search);
  const extractLimit = pLimit(input.concurrency.extract);
  const llmLimit = pLimit(input.concurrency.llm);
  const providerExtract = input.searchProvider.extract;

  const searchProvider: SearchProvider = {
    id: input.searchProvider.id,
    capabilities: [...input.searchProvider.capabilities],
    search: (request, signal) =>
      runLimited(searchLimit, signal, () =>
        input.searchProvider.search(request, signal),
      ),
    ...(providerExtract === undefined
      ? {}
      : {
          extract: (canonicalUrls: string[], signal: AbortSignal) =>
            runLimited(extractLimit, signal, () =>
              providerExtract.call(
                input.searchProvider,
                canonicalUrls,
                signal,
              ),
            ),
        }),
  };

  const llmProvider: LLMProvider = {
    id: input.llmProvider.id,
    structured: (structuredInput, options) =>
      runLimited(llmLimit, options.signal, () =>
        input.llmProvider.structured(structuredInput, options),
      ),
  };

  return { searchProvider, llmProvider };
}
