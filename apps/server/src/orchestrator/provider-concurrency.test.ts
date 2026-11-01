/**
 * 测试职责：冻结进程级 Provider 并发装饰器的两层独立配额、错误透明性和安全配置。
 * 本文件直接验证 LLM 排队扣时与取消，真实 Node 并行接线由
 * start-node-jobs.test.ts 联合验证。
 */
import type { NormalizedSearchHit, ProviderSearchRequest } from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createDeferred,
  createFixedClock,
  type Deferred,
} from "../../../../tests/support/test-infrastructure.mjs";
import {
  LLMProviderError,
  type LLMProvider,
  type StructuredLLMInput,
} from "../ai/llm-provider.js";
import type { SearchProvider } from "../search/provider.js";
import { createConcurrencyLimitedProviders } from "./provider-concurrency.js";

const REQUEST: ProviderSearchRequest = {
  kind: "node",
  nodeId: "node-1",
  query: "WayFinder",
  maxResults: 20,
  capability: "general",
  freshnessSensitive: false,
  language: "zh-CN",
};

const STRUCTURED_INPUT: StructuredLLMInput = {
  system: "system",
  user: "user",
  schemaName: "test_schema",
  schema: {},
};

const UNUSED_SEARCH_PROVIDER: SearchProvider = {
  id: "unused-search",
  capabilities: ["general"],
  search: async () => [],
};

type ActivityGate<T> = Readonly<{
  run: () => Promise<T>;
  releaseOne: (value: T) => void;
  releaseAll: (value: T) => void;
  active: () => number;
  calls: () => number;
  peak: () => number;
}>;

/** Deferred 只由测试显式释放，避免用 sleep 猜测 p-limit 队列推进时机。 */
function createActivityGate<T>(): ActivityGate<T> {
  let active = 0;
  let calls = 0;
  let peak = 0;
  const pending: Deferred<T>[] = [];

  return {
    run: async () => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      const deferred = createDeferred<T>();
      pending.push(deferred);
      try {
        return await deferred.promise;
      } finally {
        active -= 1;
      }
    },
    releaseOne: value => {
      const deferred = pending.shift();
      if (deferred === undefined) {
        throw new Error("没有可释放的活跃调用");
      }
      deferred.resolve(value);
    },
    releaseAll: value => {
      for (const deferred of pending.splice(0)) {
        deferred.resolve(value);
      }
    },
    active: () => active,
    calls: () => calls,
    peak: () => peak,
  };
}

describe("createConcurrencyLimitedProviders", () => {
  it("向 Search 与 LLM 原始 Provider 保持同一 Run Signal", async () => {
    const receivedSearchSignals: AbortSignal[] = [];
    const receivedLlmSignals: AbortSignal[] = [];
    const searchProvider: SearchProvider = {
      id: "signal-search",
      capabilities: ["general"],
      search: async (_request, signal) => {
        receivedSearchSignals.push(signal);
        return [];
      },
    };
    const llmProvider: LLMProvider = {
      id: "signal-llm",
      structured: async (_input, options) => {
        receivedLlmSignals.push(options.signal);
        return {};
      },
    };
    const limited = createConcurrencyLimitedProviders({
      searchProvider,
      llmProvider,
      concurrency: { search: 1, llm: 1 },
    });
    const signal = new AbortController().signal;

    await Promise.all([
      limited.searchProvider.search(REQUEST, signal),
      limited.llmProvider.structured(STRUCTURED_INPUT, {
        signal,
        timeoutMs: 1_000,
      }),
    ]);

    expect(receivedSearchSignals).toEqual([signal]);
    expect(receivedLlmSignals).toEqual([signal]);
  });

  it("Search 与 LLM 分别饱和 6/3，且互不占用彼此槽位", async () => {
    const searchGate = createActivityGate<NormalizedSearchHit[]>();
    const llmGate = createActivityGate<unknown>();
    const searchProvider: SearchProvider = {
      id: "tracked-search",
      capabilities: ["general"],
      search: () => searchGate.run(),
    };
    const llmProvider: LLMProvider = {
      id: "tracked-llm",
      structured: () => llmGate.run(),
    };
    const limited = createConcurrencyLimitedProviders({
      searchProvider,
      llmProvider,
      concurrency: { search: 6, llm: 3 },
    });
    const signal = new AbortController().signal;

    const searches = Array.from({ length: 7 }, (_, index) =>
      limited.searchProvider.search(
        { ...REQUEST, query: `search-${index}` },
        signal,
      ),
    );
    const llmCalls = Array.from({ length: 4 }, () =>
      limited.llmProvider.structured(STRUCTURED_INPUT, {
        signal,
        timeoutMs: 1_000,
      }),
    );

    await vi.waitFor(() => {
      expect([searchGate.calls(), llmGate.calls()]).toEqual([6, 3]);
    });
    expect([searchGate.active(), llmGate.active()]).toEqual([6, 3]);

    searchGate.releaseOne([]);
    llmGate.releaseOne({});
    await vi.waitFor(() => {
      expect([searchGate.calls(), llmGate.calls()]).toEqual([7, 4]);
    });

    searchGate.releaseAll([]);
    llmGate.releaseAll({});
    await Promise.all([
      ...searches,
      ...llmCalls,
    ]);

    expect([searchGate.peak(), llmGate.peak()]).toEqual([6, 3]);
    expect([searchGate.active(), llmGate.active()]).toEqual([0, 0]);
  });

  it("LLM 取得槽位后从阶段 timeout 扣除队列等待时间", async () => {
    const clock = createFixedClock(0);
    const activeResponses = Array.from({ length: 3 }, () =>
      createDeferred<unknown>(),
    );
    const receivedTimeouts: number[] = [];
    const llmProvider: LLMProvider = {
      id: "queue-budget-llm",
      structured: async (_input, options) => {
        const callIndex = receivedTimeouts.length;
        receivedTimeouts.push(options.timeoutMs);
        return activeResponses[callIndex]?.promise ?? {};
      },
    };
    const limited = createConcurrencyLimitedProviders({
      searchProvider: UNUSED_SEARCH_PROVIDER,
      llmProvider,
      concurrency: { search: 1, llm: 3 },
      now: clock.now,
    });
    const signal = new AbortController().signal;

    const activeCalls = Array.from({ length: 3 }, () =>
      limited.llmProvider.structured(STRUCTURED_INPUT, {
        signal,
        timeoutMs: 1_000,
      }),
    );
    await vi.waitFor(() =>
      expect(receivedTimeouts).toEqual([1_000, 1_000, 1_000]),
    );
    const queued = limited.llmProvider.structured(STRUCTURED_INPUT, {
      signal,
      timeoutMs: 1_000,
    });

    clock.advanceBy(400);
    for (const response of activeResponses) response.resolve({});

    await expect(Promise.all(activeCalls)).resolves.toEqual([{}, {}, {}]);
    await expect(queued).resolves.toEqual({});
    expect(receivedTimeouts).toEqual([1_000, 1_000, 1_000, 600]);
  });

  it("LLM 排队耗尽阶段 timeout 时不调用底层 Provider", async () => {
    const clock = createFixedClock(0);
    const activeResponses = Array.from({ length: 3 }, () =>
      createDeferred<unknown>(),
    );
    let providerCalls = 0;
    const llmProvider: LLMProvider = {
      id: "exhausted-queue-budget-llm",
      structured: async () => {
        const callIndex = providerCalls;
        providerCalls += 1;
        return activeResponses[callIndex]?.promise ?? {};
      },
    };
    const limited = createConcurrencyLimitedProviders({
      searchProvider: UNUSED_SEARCH_PROVIDER,
      llmProvider,
      concurrency: { search: 1, llm: 3 },
      now: clock.now,
    });
    const signal = new AbortController().signal;

    const activeCalls = Array.from({ length: 3 }, () =>
      limited.llmProvider.structured(STRUCTURED_INPUT, {
        signal,
        timeoutMs: 1_000,
      }),
    );
    await vi.waitFor(() => expect(providerCalls).toBe(3));
    const queued = limited.llmProvider.structured(STRUCTURED_INPUT, {
      signal,
      timeoutMs: 1_000,
    });

    clock.advanceBy(1_000);
    for (const response of activeResponses) response.resolve({});

    await expect(Promise.all(activeCalls)).resolves.toEqual([{}, {}, {}]);
    await expect(queued).rejects.toEqual(
      new LLMProviderError("timeout", true),
    );
    expect(providerCalls).toBe(3);
  });

  it("LLM 排队取消优先传播原始 reason，且释放槽位后不调用底层 Provider", async () => {
    const activeResponse = createDeferred<unknown>();
    let providerCalls = 0;
    const llmProvider: LLMProvider = {
      id: "cancelled-queue-budget-llm",
      structured: async () => {
        providerCalls += 1;
        return providerCalls === 1 ? activeResponse.promise : {};
      },
    };
    const limited = createConcurrencyLimitedProviders({
      searchProvider: UNUSED_SEARCH_PROVIDER,
      llmProvider,
      concurrency: { search: 1, llm: 1 },
    });
    const activeSignal = new AbortController().signal;
    const queuedController = new AbortController();
    const reason = new DOMException("run cancelled", "AbortError");

    const active = limited.llmProvider.structured(STRUCTURED_INPUT, {
      signal: activeSignal,
      timeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(providerCalls).toBe(1));
    const queued = limited.llmProvider.structured(STRUCTURED_INPUT, {
      signal: queuedController.signal,
      timeoutMs: 1_000,
    });

    queuedController.abort(reason);
    await expect(queued).rejects.toBe(reason);
    activeResponse.resolve({});
    await expect(active).resolves.toEqual({});
    await vi.waitFor(() => expect(providerCalls).toBe(1));
  });

  it("LLM 并发时钟回拨时不扩张调用方 timeout", async () => {
    const times = [100, 50];
    let receivedTimeoutMs: number | null = null;
    const limited = createConcurrencyLimitedProviders({
      searchProvider: UNUSED_SEARCH_PROVIDER,
      llmProvider: {
        id: "rollback-clock-llm",
        structured: async (_input, options) => {
          receivedTimeoutMs = options.timeoutMs;
          return {};
        },
      },
      concurrency: { search: 1, llm: 1 },
      now: () => times.shift() ?? 50,
    });

    await limited.llmProvider.structured(STRUCTURED_INPUT, {
      signal: new AbortController().signal,
      timeoutMs: 750,
    });

    expect(receivedTimeoutMs).toBe(750);
  });

  it.each([
    ["入队", [Number.NaN]],
    ["取得槽位", [0, Number.POSITIVE_INFINITY]],
  ] as const)("LLM %s时拒绝非有限时钟", async (_stage, sourceTimes) => {
    const times = [...sourceTimes];
    let providerCalls = 0;
    const limited = createConcurrencyLimitedProviders({
      searchProvider: UNUSED_SEARCH_PROVIDER,
      llmProvider: {
        id: "invalid-clock-llm",
        structured: async () => {
          providerCalls += 1;
          return {};
        },
      },
      concurrency: { search: 1, llm: 1 },
      now: () => times.shift() ?? 0,
    });

    const call = async (): Promise<unknown> =>
      limited.llmProvider.structured(STRUCTURED_INPUT, {
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      });

    await expect(call()).rejects.toThrow(
      "Provider 并发时钟必须返回有限数字",
    );
    expect(providerCalls).toBe(0);
  });

  it("Provider 同步抛错或异步拒绝都会释放槽位并保留原错误对象", async () => {
    for (const scenario of [
      {
        name: "同步抛错",
        fail: (error: Error): Promise<NormalizedSearchHit[]> => {
          throw error;
        },
      },
      {
        name: "异步拒绝",
        fail: (error: Error) => Promise.reject<NormalizedSearchHit[]>(error),
      },
    ] as const) {
      const originalError = new Error(`provider failed: ${scenario.name}`);
      let callCount = 0;
      const searchProvider: SearchProvider = {
        id: "failing-search",
        capabilities: ["general"],
        search: () => {
          callCount += 1;
          return callCount === 1
            ? scenario.fail(originalError)
            : Promise.resolve([]);
        },
      };
      const limited = createConcurrencyLimitedProviders({
        searchProvider,
        llmProvider: {
          id: "unused-llm",
          structured: async () => ({}),
        },
        concurrency: { search: 1, llm: 1 },
      });
      const signal = new AbortController().signal;
      const first = limited.searchProvider.search(REQUEST, signal);
      const second = limited.searchProvider.search(
        { ...REQUEST, query: "second" },
        signal,
      );

      await expect(first, scenario.name).rejects.toBe(originalError);
      await expect(second, scenario.name).resolves.toEqual([]);
      expect(callCount, scenario.name).toBe(2);
    }
  });

  it("保持缺失的 Extract 能力，并拒绝绕过批准上限", () => {
    const searchProvider: SearchProvider = {
      id: "search-only",
      capabilities: ["general"],
      search: async () => [],
    };
    const llmProvider: LLMProvider = {
      id: "llm",
      structured: async () => ({}),
    };
    const limited = createConcurrencyLimitedProviders({
      searchProvider,
      llmProvider,
      concurrency: { search: 6, llm: 3 },
    });

    expect(limited.searchProvider.extract).toBeUndefined();
    expect(() =>
      createConcurrencyLimitedProviders({
        searchProvider,
        llmProvider,
        concurrency: { search: 7, llm: 3 },
      }),
    ).toThrow(new RangeError("Search 并发上限必须是 1 到 6 的安全整数"));
  });
});
