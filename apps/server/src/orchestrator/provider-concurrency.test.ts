/**
 * 测试职责：冻结进程级 Provider 并发装饰器的三层独立配额、错误透明性和安全配置。
 * 排队取消与真实 Node 并行接线由 start-node-jobs.test.ts 联合验证。
 */
import type {
  ExtractedPage,
  NormalizedSearchHit,
  ProviderSearchRequest,
} from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createDeferred,
  type Deferred,
} from "../../../../tests/support/test-infrastructure.mjs";
import type {
  LLMProvider,
  StructuredLLMInput,
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
};

const STRUCTURED_INPUT: StructuredLLMInput = {
  system: "system",
  user: "user",
  schemaName: "test_schema",
  schema: {},
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
  it("Search、Extract、LLM 分别饱和 6/3/3，且互不占用彼此槽位", async () => {
    const searchGate = createActivityGate<NormalizedSearchHit[]>();
    const extractGate = createActivityGate<ExtractedPage[]>();
    const llmGate = createActivityGate<unknown>();
    const searchProvider: SearchProvider = {
      id: "tracked-search",
      capabilities: ["general"],
      search: () => searchGate.run(),
      extract: () => extractGate.run(),
    };
    const llmProvider: LLMProvider = {
      id: "tracked-llm",
      structured: () => llmGate.run(),
    };
    const limited = createConcurrencyLimitedProviders({
      searchProvider,
      llmProvider,
      concurrency: { search: 6, extract: 3, llm: 3 },
    });
    const signal = new AbortController().signal;

    const searches = Array.from({ length: 7 }, (_, index) =>
      limited.searchProvider.search(
        { ...REQUEST, query: `search-${index}` },
        signal,
      ),
    );
    const extracts = Array.from({ length: 4 }, (_, index) =>
      limited.searchProvider.extract?.(
        [`https://example.com/${index}`],
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
      expect([
        searchGate.calls(),
        extractGate.calls(),
        llmGate.calls(),
      ]).toEqual([6, 3, 3]);
    });
    expect([searchGate.active(), extractGate.active(), llmGate.active()]).toEqual(
      [6, 3, 3],
    );

    searchGate.releaseOne([]);
    extractGate.releaseOne([]);
    llmGate.releaseOne({});
    await vi.waitFor(() => {
      expect([
        searchGate.calls(),
        extractGate.calls(),
        llmGate.calls(),
      ]).toEqual([7, 4, 4]);
    });

    searchGate.releaseAll([]);
    extractGate.releaseAll([]);
    llmGate.releaseAll({});
    await Promise.all([
      ...searches,
      ...extracts.map(operation => operation ?? Promise.resolve([])),
      ...llmCalls,
    ]);

    expect([searchGate.peak(), extractGate.peak(), llmGate.peak()]).toEqual([
      6, 3, 3,
    ]);
    expect([searchGate.active(), extractGate.active(), llmGate.active()]).toEqual(
      [0, 0, 0],
    );
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
        concurrency: { search: 1, extract: 1, llm: 1 },
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
      concurrency: { search: 6, extract: 3, llm: 3 },
    });

    expect(limited.searchProvider.extract).toBeUndefined();
    expect(() =>
      createConcurrencyLimitedProviders({
        searchProvider,
        llmProvider,
        concurrency: { search: 7, extract: 3, llm: 3 },
      }),
    ).toThrow(new RangeError("Search 并发上限必须是 1 到 6 的安全整数"));
  });
});
