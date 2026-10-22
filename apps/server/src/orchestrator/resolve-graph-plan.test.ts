/**
 * 测试职责：冻结 WAY-62 的 Planner → 可选 Broad Discovery / Reviser → 最终校验路径，
 * 证明所有阶段共享一个 Run Signal 和递减预算，且普通回退不会吞掉取消或程序错误。
 *
 * 边界说明：本文件不启动 Node jobs、不测试并发、StreamEvent 或 ResultGraph；这些属于
 * WAY-63 及后续任务。
 */
import {
  GraphPlanSchema,
  type GraphPlan,
  type NormalizedSearchHit,
} from "@wayfinder/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAbortFixture,
  createDeferred,
  createFixedClock,
  FakeLLMProvider,
  FakeSearchProvider,
} from "../../../../tests/support/test-infrastructure.mjs";
import {
  LLMProviderError,
  type LLMProvider,
} from "../ai/llm-provider.js";
import { validateGraphPlan } from "../graph/graph-validator.js";
import type { SearchProvider } from "../search/provider.js";
import { createAbsoluteRunDeadline } from "./absolute-run-deadline.js";
import {
  parseValidatedGraphPlanForRun,
  resolveValidatedGraphPlanForRun,
  type ResolveValidatedGraphPlanForRunInput,
} from "./resolve-graph-plan.js";

const QUERY = "NVIDIA 最新动态";
const BROAD_QUERY = "NVIDIA latest news";

function createPlan(
  strategy: "evidence_assisted" | "plan_first",
  description = "初始计划",
): GraphPlan {
  return GraphPlanSchema.parse({
    analysis:
      strategy === "evidence_assisted"
        ? {
            intent: "news",
            topic: "NVIDIA",
            freshnessSensitive: true,
            ambiguityLevel: "medium",
            broadSearchQueries: [BROAD_QUERY],
            strategy,
            presentationMode: "compact",
          }
        : {
            intent: "learn",
            topic: "NVIDIA",
            freshnessSensitive: false,
            ambiguityLevel: "low",
            broadSearchQueries: [],
            strategy,
            presentationMode: "compact",
          },
    nodes: [
      {
        id: "overview",
        title: "NVIDIA 概览",
        description,
        nodeType: "primary",
        layer: 0,
        searchPlan: {
          queries: ["NVIDIA"],
          maxResults: 20,
          rankingProfile: "general",
          providerHints: ["general"],
        },
        status: "planned",
      },
    ],
    edges: [],
  });
}

function createHit(): NormalizedSearchHit {
  return {
    provider: "fake-search",
    query: BROAD_QUERY,
    title: "NVIDIA 新闻",
    url: "https://example.com/nvidia",
    canonicalUrl: "https://example.com/nvidia",
    domain: "example.com",
    snippet: "NVIDIA 发布最新消息",
    providerRank: 1,
    rawMetadata: {},
  };
}

function createInput(
  llmProvider: LLMProvider,
  searchProvider: SearchProvider,
  runScope: ResolveValidatedGraphPlanForRunInput["runScope"],
  overrides: Partial<ResolveValidatedGraphPlanForRunInput> = {},
): ResolveValidatedGraphPlanForRunInput {
  return {
    query: QUERY,
    llmProvider,
    searchProvider,
    runScope,
    llmStageTimeoutMs: 15_000,
    onPlannerValidationDiagnostic: () => undefined,
    onRevisionValidationDiagnostic: () => undefined,
    ...overrides,
  };
}

describe("resolveValidatedGraphPlanForRun", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("plan_first 只执行 Planner，并在最终校验后返回完整计划", async () => {
    const clock = createFixedClock(1_000);
    const parent = new AbortController();
    const runScope = createAbsoluteRunDeadline({
      parentSignal: parent.signal,
      now: clock.now,
    });
    const plan = createPlan("plan_first");
    const llmProvider = new FakeLLMProvider([plan]);
    const searchProvider = new FakeSearchProvider({ searchResponses: {} });

    try {
      const result = await resolveValidatedGraphPlanForRun(
        createInput(llmProvider, searchProvider, runScope),
      );

      expect(result).toEqual(plan);
      expect(validateGraphPlan(result)).toEqual({ valid: true, findings: [] });
      expect(llmProvider.calls).toHaveLength(1);
      expect(llmProvider.calls[0]?.options).toEqual({
        signal: runScope.signal,
        timeoutMs: 15_000,
      });
      expect(searchProvider.searchCalls).toHaveLength(0);
      expect(searchProvider.extractCalls).toHaveLength(0);
      // Scope 由未来 runSearch 持有，本规划函数成功后不能擅自释放或替换它。
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      runScope.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("evidence_assisted 严格执行 Planner、一次 Discovery、一次 Reviser 并共享递减预算", async () => {
    const clock = createFixedClock(0);
    const parent = new AbortController();
    const runScope = createAbsoluteRunDeadline({
      parentSignal: parent.signal,
      now: clock.now,
    });
    const initialPlan = createPlan("evidence_assisted");
    const revisedPlan = createPlan("evidence_assisted", "修订计划");
    const sequence: string[] = [];
    const scriptedLLM = new FakeLLMProvider([initialPlan, revisedPlan]);
    const llmProvider: LLMProvider = {
      id: scriptedLLM.id,
      structured: async (input, options) => {
        sequence.push(scriptedLLM.calls.length === 0 ? "planner" : "reviser");
        return scriptedLLM.structured(input, options);
      },
    };
    const scriptedSearch = new FakeSearchProvider({
      searchResponses: { [BROAD_QUERY]: [createHit()] },
    });
    const searchProvider: SearchProvider = {
      id: scriptedSearch.id,
      capabilities: [...scriptedSearch.capabilities],
      search: async (request, signal) => {
        sequence.push("broadDiscovery");
        const hits = await scriptedSearch.search(request, signal);
        clock.advanceBy(7_000);
        return hits;
      },
      extract: (urls, signal) => scriptedSearch.extract(urls, signal),
    };

    try {
      const result = await resolveValidatedGraphPlanForRun(
        createInput(llmProvider, searchProvider, runScope, { language: "zh" }),
      );

      expect(result).toEqual(revisedPlan);
      expect(sequence).toEqual(["planner", "broadDiscovery", "reviser"]);
      expect(scriptedLLM.calls).toHaveLength(2);
      expect(scriptedLLM.calls.map(call => call.options.signal)).toEqual([
        runScope.signal,
        runScope.signal,
      ]);
      expect(scriptedLLM.calls.map(call => call.options.timeoutMs)).toEqual([
        15_000,
        13_000,
      ]);
      expect(scriptedSearch.searchCalls).toEqual([
        {
          request: {
            kind: "broad_discovery",
            query: BROAD_QUERY,
            maxResults: 5,
            capability: "general",
            freshnessSensitive: true,
            language: "zh",
          },
          signal: runScope.signal,
        },
      ]);
      expect(scriptedSearch.extractCalls).toHaveLength(0);
      expect(validateGraphPlan(result).valid).toBe(true);
    } finally {
      runScope.dispose();
    }
  });

  it("零 Evidence 只回退 Initial Plan，且绝不启动 Reviser", async () => {
    const clock = createFixedClock(0);
    const runScope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: clock.now,
    });
    const initialPlan = createPlan("evidence_assisted");
    const llmProvider = new FakeLLMProvider([initialPlan]);
    const searchProvider = new FakeSearchProvider({
      searchResponses: { [BROAD_QUERY]: [] },
    });

    try {
      await expect(
        resolveValidatedGraphPlanForRun(
          createInput(llmProvider, searchProvider, runScope),
        ),
      ).resolves.toEqual(initialPlan);
      expect(llmProvider.calls).toHaveLength(1);
      expect(searchProvider.searchCalls).toHaveLength(1);
    } finally {
      runScope.dispose();
    }
  });

  it("Reviser 普通失败保留 Initial Plan，但未知程序错误原样传播", async () => {
    const initialPlan = createPlan("evidence_assisted");

    for (const scenario of [
      {
        name: "普通 Provider 失败",
        error: new LLMProviderError("provider_failure", true),
        fallsBack: true,
      },
      {
        name: "未知程序错误",
        error: new TypeError("programming bug"),
        fallsBack: false,
      },
    ] as const) {
      const runScope = createAbsoluteRunDeadline({
        parentSignal: new AbortController().signal,
        now: () => 0,
      });
      const llmProvider = new FakeLLMProvider([initialPlan, scenario.error]);
      const searchProvider = new FakeSearchProvider({
        searchResponses: { [BROAD_QUERY]: [createHit()] },
      });

      try {
        const outcome = resolveValidatedGraphPlanForRun(
          createInput(llmProvider, searchProvider, runScope),
        );
        if (scenario.fallsBack) {
          await expect(outcome, scenario.name).resolves.toEqual(initialPlan);
        } else {
          await expect(outcome, scenario.name).rejects.toBe(scenario.error);
        }
        expect(llmProvider.calls, scenario.name).toHaveLength(2);
      } finally {
        runScope.dispose();
      }
    }
  });

  it("调用前已取消时不启动任何外部调用，并保留父 reason 对象", async () => {
    const cancelled = createAbortFixture("调用前取消");
    cancelled.abort();
    const runScope = createAbsoluteRunDeadline({
      parentSignal: cancelled.signal,
      now: () => 0,
    });
    const llmProvider = new FakeLLMProvider([createPlan("plan_first")]);
    const searchProvider = new FakeSearchProvider({ searchResponses: {} });

    try {
      await expect(
        resolveValidatedGraphPlanForRun(
          createInput(llmProvider, searchProvider, runScope),
        ),
      ).rejects.toBe(cancelled.reason);
      expect(llmProvider.calls).toHaveLength(0);
      expect(searchProvider.searchCalls).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      runScope.dispose();
    }
  });

  it("Broad Discovery 期间取消时传播父 reason，且不回退或启动 Reviser", async () => {
    const cancelled = createAbortFixture("Discovery 期间取消");
    const runScope = createAbsoluteRunDeadline({
      parentSignal: cancelled.signal,
      now: () => 0,
    });
    const llmProvider = new FakeLLMProvider([
      createPlan("evidence_assisted"),
      createPlan("evidence_assisted", "不应消费的修订计划"),
    ]);
    const searchCalls: AbortSignal[] = [];
    const searchProvider: SearchProvider = {
      id: "abort-ignoring-search",
      capabilities: ["general"],
      search: async (_request, signal) => {
        searchCalls.push(signal);
        cancelled.abort();
        return [createHit()];
      },
    };

    try {
      await expect(
        resolveValidatedGraphPlanForRun(
          createInput(llmProvider, searchProvider, runScope),
        ),
      ).rejects.toBe(cancelled.reason);
      expect(searchCalls).toEqual([runScope.signal]);
      expect(llmProvider.calls).toHaveLength(1);
    } finally {
      runScope.dispose();
    }
  });

  it("Deadline 后迟到的 Planner 普通失败不能生成 compact fallback", async () => {
    const deferred = createDeferred<unknown>();
    const calls: AbortSignal[] = [];
    const deadlineIgnoringProvider: LLMProvider = {
      id: "deadline-ignoring-llm",
      structured: async (_input, options) => {
        calls.push(options.signal);
        return deferred.promise;
      },
    };
    const runScope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: () => 0,
    });
    const searchProvider = new FakeSearchProvider({ searchResponses: {} });
    const outcome = resolveValidatedGraphPlanForRun(
      createInput(deadlineIgnoringProvider, searchProvider, runScope),
    );

    expect(calls).toEqual([runScope.signal]);
    await vi.advanceTimersByTimeAsync(20_000);
    const deadlineReason = runScope.signal.reason;
    deferred.reject(new LLMProviderError("provider_failure", true));

    await expect(outcome).rejects.toBe(deadlineReason);
    expect(searchProvider.searchCalls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    runScope.dispose();
  });
});

describe("parseValidatedGraphPlanForRun", () => {
  it("拒绝 Schema 合法但 Graph Validator 无效的计划，避免其进入 Node 边界", () => {
    const plan = createPlan("plan_first");
    const invalid = GraphPlanSchema.parse({
      ...plan,
      edges: [
        {
          id: "self-edge",
          source: "overview",
          target: "overview",
          type: "recommended_next",
        },
      ],
    });

    expect(validateGraphPlan(invalid).valid).toBe(false);
    expect(() => parseValidatedGraphPlanForRun(invalid)).toThrow(
      new TypeError("Orchestrator GraphPlan 未通过最终校验"),
    );
  });
});
