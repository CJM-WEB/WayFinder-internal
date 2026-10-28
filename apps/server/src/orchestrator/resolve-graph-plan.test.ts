/**
 * 测试职责：冻结失败关闭的 Outline → 可选 Evidence/Reviser → Bundle → GraphPlan 链路。
 */
import {
  GraphPlanSchema,
  type GraphPlan,
  type NormalizedSearchHit,
} from "@wayfinder/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDeferred,
  createFixedClock,
  FakeLLMProvider,
  FakeSearchProvider,
} from "../../../../tests/support/test-infrastructure.mjs";
import {
  GraphOutlineSchema,
  type GraphOutline,
} from "../ai/graph-outline.js";
import {
  LLMProviderError,
  type LLMProvider,
} from "../ai/llm-provider.js";
import {
  SearchPlanBundleSchema,
  type SearchPlanBundle,
} from "../ai/search-plan-generator.js";
import { validateGraphPlan } from "../graph/graph-validator.js";
import type { SearchProvider } from "../search/provider.js";
import { createAbsoluteRunDeadline } from "./absolute-run-deadline.js";
import {
  GraphPlanResolutionError,
  parseValidatedGraphPlanForRun,
  resolveValidatedGraphPlanForRun,
  type ResolveValidatedGraphPlanForRunInput,
} from "./resolve-graph-plan.js";

const QUERY = "NVIDIA 最新动态";
const BROAD_QUERY = "NVIDIA latest news";

function createOutline(
  strategy: "evidence_assisted" | "plan_first",
  description = "NVIDIA 概览",
): GraphOutline {
  return GraphOutlineSchema.parse({
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
        status: "planned",
      },
    ],
    edges: [],
  });
}

function createBundle(query = "NVIDIA 公司业务与产品概览"): SearchPlanBundle {
  return SearchPlanBundleSchema.parse({
    plans: [
      {
        nodeId: "overview",
        queries: [query],
        rankingProfile: "knowledge",
      },
    ],
  });
}

function createExpectedPlan(
  outline: GraphOutline,
  bundle = createBundle(),
): GraphPlan {
  const plan = bundle.plans[0];
  if (plan === undefined) throw new Error("测试 Bundle 缺少计划");
  return GraphPlanSchema.parse({
    analysis: outline.analysis,
    nodes: [
      {
        ...outline.nodes[0],
        searchPlan: {
          queries: plan.queries,
          maxResults: 20,
          rankingProfile: plan.rankingProfile,
          providerHints: ["general"],
        },
      },
    ],
    edges: outline.edges,
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
): ResolveValidatedGraphPlanForRunInput {
  return {
    query: QUERY,
    llmProvider,
    searchProvider,
    runScope,
    llmStageTimeoutMs: 30_000,
    language: "zh-CN",
    onPlannerValidationDiagnostic: () => undefined,
    onRevisionValidationDiagnostic: () => undefined,
    onSearchPlanValidationDiagnostic: () => undefined,
  };
}

describe("resolveValidatedGraphPlanForRun", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("plan_first 固定执行 Planner + 一次全图 Generator", async () => {
    const clock = createFixedClock(1_000);
    const runScope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: clock.now,
    });
    const outline = createOutline("plan_first");
    const bundle = createBundle();
    const llm = new FakeLLMProvider([outline, bundle]);
    const search = new FakeSearchProvider({ searchResponses: {} });

    try {
      const result = await resolveValidatedGraphPlanForRun(
        createInput(llm, search, runScope),
      );
      expect(result).toEqual(createExpectedPlan(outline, bundle));
      expect(validateGraphPlan(result).valid).toBe(true);
      expect(llm.calls.map(call => call.input.schemaName)).toEqual([
        "graph_outline",
        "search_plan_bundle",
      ]);
      expect(llm.calls.map(call => call.options.signal)).toEqual([
        runScope.signal,
        runScope.signal,
      ]);
      expect(search.searchCalls).toHaveLength(0);
    } finally {
      runScope.dispose();
    }
  });

  it("evidence_assisted 按固定顺序执行并为每个 LLM 阶段重算剩余预算", async () => {
    const clock = createFixedClock(0);
    const runScope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: clock.now,
    });
    const initial = createOutline("evidence_assisted");
    const revised = createOutline("evidence_assisted", "Evidence 修订后的概览");
    const bundle = createBundle("NVIDIA 最新产品与业务动态");
    const scripted = new FakeLLMProvider([initial, revised, bundle]);
    const sequence: string[] = [];
    const llm: LLMProvider = {
      id: scripted.id,
      structured: async (input, options) => {
        sequence.push(input.schemaName);
        const result = await scripted.structured(input, options);
        if (scripted.calls.length === 2) clock.advanceBy(5_000);
        return result;
      },
    };
    const scriptedSearch = new FakeSearchProvider({
      searchResponses: { [BROAD_QUERY]: [createHit()] },
    });
    const search: SearchProvider = {
      id: scriptedSearch.id,
      capabilities: [...scriptedSearch.capabilities],
      search: async (request, signal) => {
        sequence.push("broad_discovery");
        const result = await scriptedSearch.search(request, signal);
        clock.advanceBy(15_000);
        return result;
      },
    };

    try {
      await expect(
        resolveValidatedGraphPlanForRun(createInput(llm, search, runScope)),
      ).resolves.toEqual(createExpectedPlan(revised, bundle));
      expect(sequence).toEqual([
        "graph_outline",
        "broad_discovery",
        "graph_outline",
        "search_plan_bundle",
      ]);
      const stageTimeouts = scripted.calls.map(call => call.options.timeoutMs);
      const orchestrationCaps = [30_000, 25_000, 20_000];
      // 编排层的固定时钟只冻结各阶段上限；Provider 调用前还会用阶段
      // 单调时钟扣除已消耗毫秒。此处验证不突破全局预算，精确值由可注入时钟的单测负责。
      expect(stageTimeouts).toHaveLength(orchestrationCaps.length);
      for (const [index, timeoutMs] of stageTimeouts.entries()) {
        expect(timeoutMs).toBeGreaterThan(0);
        expect(timeoutMs).toBeLessThanOrEqual(orchestrationCaps[index]!);
        if (index > 0) {
          expect(timeoutMs).toBeLessThanOrEqual(stageTimeouts[index - 1]!);
        }
      }
      expect(scripted.calls.every(call => call.options.signal === runScope.signal)).toBe(
        true,
      );
      expect(scriptedSearch.searchCalls[0]?.signal).toBe(runScope.signal);
    } finally {
      runScope.dispose();
    }
  });

  it("无效 Initial Outline 在读取策略和 Broad Search 前失败", async () => {
    const invalid = createOutline("evidence_assisted");
    invalid.nodes[0] = { ...invalid.nodes[0]!, title: " " };
    const llm = new FakeLLMProvider([invalid, createBundle()]);
    const search = new FakeSearchProvider({
      searchResponses: { [BROAD_QUERY]: [createHit()] },
    });
    const runScope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: () => 0,
    });

    try {
      await expect(
        resolveValidatedGraphPlanForRun(createInput(llm, search, runScope)),
      ).rejects.toEqual(
        new GraphPlanResolutionError({ code: "INVALID_GRAPH", retryable: true }),
      );
      expect(llm.calls).toHaveLength(1);
      expect(search.searchCalls).toHaveLength(0);
    } finally {
      runScope.dispose();
    }
  });

  it("零 Evidence 失败关闭，不启动 Reviser 或 Generator", async () => {
    const runScope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: () => 0,
    });
    const llm = new FakeLLMProvider([createOutline("evidence_assisted")]);
    const search = new FakeSearchProvider({
      searchResponses: { [BROAD_QUERY]: [] },
    });
    try {
      await expect(
        resolveValidatedGraphPlanForRun(createInput(llm, search, runScope)),
      ).rejects.toEqual(
        new GraphPlanResolutionError({
          code: "SEARCH_PROVIDER_FAILED",
          retryable: true,
        }),
      );
      expect(llm.calls).toHaveLength(1);
    } finally {
      runScope.dispose();
    }
  });

  it("Reviser Provider 失败不保留 Initial Outline，也不启动 Generator", async () => {
    const runScope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: () => 0,
    });
    const llm = new FakeLLMProvider([
      createOutline("evidence_assisted"),
      new LLMProviderError("provider_failure", true),
      createBundle(),
    ]);
    const search = new FakeSearchProvider({
      searchResponses: { [BROAD_QUERY]: [createHit()] },
    });
    try {
      await expect(
        resolveValidatedGraphPlanForRun(createInput(llm, search, runScope)),
      ).rejects.toEqual(
        new GraphPlanResolutionError({ code: "PLANNER_FAILED", retryable: true }),
      );
      expect(llm.calls).toHaveLength(2);
    } finally {
      runScope.dispose();
    }
  });

  it("Generator 的重复 Query 以 INVALID_GRAPH 失败且不返回部分计划", async () => {
    const outline = createOutline("plan_first");
    const duplicateBundle = SearchPlanBundleSchema.parse({
      plans: [
        {
          nodeId: "overview",
          queries: ["NVIDIA 概览", " ｎｖｉｄｉａ\u00a0概览 "],
          rankingProfile: "knowledge",
        },
      ],
    });
    const runScope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: () => 0,
    });
    const llm = new FakeLLMProvider([outline, duplicateBundle]);
    const onPlanningStageFailed = vi.fn();
    try {
      await expect(
        resolveValidatedGraphPlanForRun(
          {
            ...createInput(
              llm,
              new FakeSearchProvider({ searchResponses: {} }),
              runScope,
            ),
            onPlanningStageFailed,
          },
        ),
      ).rejects.toEqual(
        new GraphPlanResolutionError({ code: "INVALID_GRAPH", retryable: true }),
      );
      expect(llm.calls).toHaveLength(2);
      expect(onPlanningStageFailed).toHaveBeenCalledExactlyOnceWith(
        "searchPlan",
        "INVALID_GRAPH",
      );
    } finally {
      runScope.dispose();
    }
  });

  it("未知程序错误保持未知错误对象，不伪装成预期规划失败", async () => {
    const error = new TypeError("programming bug");
    const runScope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: () => 0,
    });
    try {
      await expect(
        resolveValidatedGraphPlanForRun(
          createInput(
            new FakeLLMProvider([error]),
            new FakeSearchProvider({ searchResponses: {} }),
            runScope,
          ),
        ),
      ).rejects.toBe(error);
    } finally {
      runScope.dispose();
    }
  });

  it("Deadline 后迟到错误保留 Run reason，且不启动后续阶段", async () => {
    const deferred = createDeferred<unknown>();
    const runScope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: () => 0,
    });
    const provider: LLMProvider = {
      id: "deadline-ignoring",
      structured: () => deferred.promise,
    };
    const pending = resolveValidatedGraphPlanForRun(
      createInput(
        provider,
        new FakeSearchProvider({ searchResponses: {} }),
        runScope,
      ),
    );
    await vi.advanceTimersByTimeAsync(40_000);
    const reason = runScope.signal.reason;
    deferred.reject(new LLMProviderError("provider_failure", true));
    await expect(pending).rejects.toBe(reason);
    runScope.dispose();
  });
});

describe("parseValidatedGraphPlanForRun", () => {
  it("拒绝公共 Schema 合法但 Graph Validator 无效的计划", () => {
    const outline = createOutline("plan_first");
    const valid = createExpectedPlan(outline);
    const invalid = GraphPlanSchema.parse({
      ...valid,
      edges: [
        {
          id: "self-edge",
          source: "overview",
          target: "overview",
          type: "recommended_next",
        },
      ],
    });
    expect(() => parseValidatedGraphPlanForRun(invalid)).toThrow(
      new TypeError("Orchestrator GraphPlan 未通过最终校验"),
    );
  });
});
