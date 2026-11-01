/**
 * 测试职责：证明 Async Context（异步上下文）只把脱敏观察值交给当前并发 Run，
 * 且观察器失败不会越过可观测性边界。
 */
import { describe, expect, it } from "vitest";

import { createConcurrencyLimitedProviders } from "../orchestrator/provider-concurrency.js";
import {
  observeCurrentRun,
  type RunLogObservation,
  withRunLogObserver,
} from "./run-log-context.js";

describe("Run Log Async Context", () => {
  it("隔离两个并发 Run 的 Cache 与 Token 观察值", async () => {
    const first: RunLogObservation[] = [];
    const second: RunLogObservation[] = [];

    await Promise.all([
      withRunLogObserver(
        observation => first.push(observation),
        async () => {
          await Promise.resolve();
          observeCurrentRun({
            kind: "cache",
            operation: "search",
            hitCount: 1,
            missCount: 0,
          });
        },
      ),
      withRunLogObserver(
        observation => second.push(observation),
        async () => {
          await Promise.resolve();
          observeCurrentRun({
            kind: "token_usage",
            inputTokens: 10,
            outputTokens: 4,
            totalTokens: 14,
          });
        },
      ),
    ]);

    expect(first).toEqual([
      {
        kind: "cache",
        operation: "search",
        hitCount: 1,
        missCount: 0,
      },
    ]);
    expect(second).toEqual([
      {
        kind: "token_usage",
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
    ]);
  });

  it("没有活动 Run 或观察器抛错时保持 fail-open", () => {
    expect(() =>
      observeCurrentRun({
        kind: "http_attempt",
        operation: "search",
      }),
    ).not.toThrow();

    expect(() =>
      withRunLogObserver(
        () => {
          throw new Error("包含敏感正文的观察器错误");
        },
        () =>
          observeCurrentRun({
            kind: "http_attempt",
            operation: "extract",
          }),
      ),
    ).not.toThrow();
  });

  it("共享并发队列延后执行时仍保留各自 Run 归属", async () => {
    const first: RunLogObservation[] = [];
    const second: RunLogObservation[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let callCount = 0;
    const providers = createConcurrencyLimitedProviders({
      searchProvider: {
        id: "fake-search",
        capabilities: ["general"],
        search: async request => {
          callCount += 1;
          if (callCount === 1) await firstGate;
          observeCurrentRun({
            kind: "cache",
            operation: "search",
            hitCount: request.query === "first" ? 1 : 0,
            missCount: request.query === "second" ? 1 : 0,
          });
          return [];
        },
      },
      llmProvider: {
        id: "fake-llm",
        structured: async () => ({}),
      },
      concurrency: { search: 1, llm: 1 },
    });
    const signal = new AbortController().signal;

    const firstCall = withRunLogObserver(
      observation => first.push(observation),
      () =>
        providers.searchProvider.search(
          {
            kind: "broad_discovery",
            query: "first",
            maxResults: 1,
            capability: "general",
            freshnessSensitive: false,
          language: "zh-CN",
          },
          signal,
        ),
    );
    const secondCall = withRunLogObserver(
      observation => second.push(observation),
      () =>
        providers.searchProvider.search(
          {
            kind: "broad_discovery",
            query: "second",
            maxResults: 1,
            capability: "general",
            freshnessSensitive: false,
          language: "zh-CN",
          },
          signal,
        ),
    );
    releaseFirst?.();
    await Promise.all([firstCall, secondCall]);

    expect(first).toEqual([
      {
        kind: "cache",
        operation: "search",
        hitCount: 1,
        missCount: 0,
      },
    ]);
    expect(second).toEqual([
      {
        kind: "cache",
        operation: "search",
        hitCount: 0,
        missCount: 1,
      },
    ]);
  });
});
