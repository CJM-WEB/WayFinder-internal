/**
 * 模块职责：在 Provider Port（提供方端口）边界集中限制真实外部调用并发。
 *
 * 生命周期边界：Composition Root（组合根）应只创建一个长生命周期实例，并让所有
 * Run 共用；Search、LLM 使用两个独立队列，不能限制整个 Node Pipeline。
 * Cache 应包在 Search 装饰器外层，使命中缓存时不占真实外部调用槽位。
 */
import { AsyncLocalStorage } from "node:async_hooks";

import pLimit from "p-limit";

import {
  assertBoundedLLMTimeout,
  LLMProviderError,
  type LLMProvider,
} from "../ai/llm-provider.js";
import { MAX_LLM_CONCURRENCY, MAX_SEARCH_CONCURRENCY } from "../config.js";
import type { SearchProvider } from "../search/provider.js";

export type ProviderConcurrencyLimits = Readonly<{
  search: number;
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
  /** 仅用于确定性验证队列等待；生产默认使用单调时钟。 */
  now?: () => number;
}>;

type Limit = ReturnType<typeof pLimit>;

function assertConcurrencyLimit(
  label: "Search" | "LLM",
  value: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} 并发上限必须是 1 到 ${maximum} 的安全整数`);
  }
}

/** 读取单调时钟并拒绝会破坏阶段预算计算的非法测试或运行时注入。 */
function readFiniteNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value)) {
    throw new TypeError("Provider 并发时钟必须返回有限数字");
  }
  return value;
}

/**
 * LLM 的 timeoutMs 在入队前已经包含 Prompt 构造与 Run 剩余预算；取得槽位后必须继续
 * 扣除队列等待，不能把陈旧预算原样交给真实 Provider。时钟回拨只允许保持原预算，
 * 不能扩张调用方已经批准的上限。
 */
function readQueuedLlmTimeoutMs(
  deadlineAt: number,
  originalTimeoutMs: number,
  now: () => number,
): number | null {
  const remaining = Math.min(
    originalTimeoutMs,
    Math.ceil(deadlineAt - readFiniteNow(now)),
  );
  return remaining >= 1 ? remaining : null;
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
  /**
   * p-limit 会在前一个任务释放 Slot 的异步上下文里启动队列下一项；若不显式恢复
   * 调用方 Context，并发 Run 的日志观察值可能串账。snapshot 不承载业务数据，只保证
   * 所有 AsyncLocalStorage（异步本地存储）在真实 Provider 调用时恢复到入队来源。
   */
  const runInCallerContext = AsyncLocalStorage.snapshot();
  const scheduled = limit(() =>
    runInCallerContext(async () => {
      signal.throwIfAborted();
      const result = await operation();
      // 防御忽略 Signal 的 Provider：取消后的迟到成功不能穿过装饰器。
      signal.throwIfAborted();
      return result;
    }),
  );

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
 * 创建进程级共享的两层并发装饰器。单次 Adapter 逻辑调用（含其内部有界重试）只占
 * 一个槽位；本模块不读取 Provider 私有字段、不创建第二个 Timer。LLM 只收窄调用方
 * 已有阶段预算，排队耗尽时使用与 SDK Timeout 相同的脱敏错误语义。
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
    "LLM",
    input.concurrency.llm,
    MAX_LLM_CONCURRENCY,
  );

  const searchLimit = pLimit(input.concurrency.search);
  const llmLimit = pLimit(input.concurrency.llm);
  const now = input.now ?? (() => performance.now());

  const searchProvider: SearchProvider = {
    id: input.searchProvider.id,
    capabilities: [...input.searchProvider.capabilities],
    search: (request, signal) =>
      runLimited(searchLimit, signal, () =>
        input.searchProvider.search(request, signal),
      ),
  };

  const llmProvider: LLMProvider = {
    id: input.llmProvider.id,
    structured: (structuredInput, options) => {
      // 先保留取消优先级，再冻结入队时的阶段截止点；不向 Provider Port 暴露 deadlineAt。
      options.signal.throwIfAborted();
      assertBoundedLLMTimeout(options.timeoutMs);
      const deadlineAt = readFiniteNow(now) + options.timeoutMs;

      return runLimited(llmLimit, options.signal, () => {
        const timeoutMs = readQueuedLlmTimeoutMs(
          deadlineAt,
          options.timeoutMs,
          now,
        );
        if (timeoutMs === null) {
          throw new LLMProviderError("timeout", true);
        }
        return input.llmProvider.structured(structuredInput, {
          signal: options.signal,
          timeoutMs,
        });
      });
    },
  };

  return { searchProvider, llmProvider };
}
