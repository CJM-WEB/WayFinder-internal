/**
 * 测试职责：用真实 processNode 证明不同 layer 的 Node 同步启动，而调用级 Search
 * 仍共享一个集中队列；取消时排队调用立即结束且不得在槽位释放后迟到访问 Provider。
 * Outcome 分类、Deadline timed_out 合成与 ResultGraph 由对应结算模块负责。
 */
import {
  GraphPlanSchema,
  type NormalizedSearchHit,
} from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createAbortFixture,
  createDeferred,
  type Deferred,
} from "../../../../tests/support/test-infrastructure.mjs";
import type { LLMProvider } from "../ai/llm-provider.js";
import { validateGraphPlan } from "../graph/graph-validator.js";
import type { NodeStreamEventPayload } from "../pipeline/process-node.js";
import type { SearchProvider } from "../search/provider.js";
import { createConcurrencyLimitedProviders } from "./provider-concurrency.js";
import { startNodeJobs } from "./start-node-jobs.js";

const PLAN = GraphPlanSchema.parse({
  analysis: {
    intent: "learn",
    topic: "并发测试",
    freshnessSensitive: false,
    ambiguityLevel: "low",
    broadSearchQueries: [],
    strategy: "plan_first",
    presentationMode: "compact",
  },
  nodes: Array.from({ length: 3 }, (_, index) => ({
    id: `node-${index + 1}`,
    title: `节点 ${index + 1}`,
    description: "验证 Node 不按 layer 串行",
    nodeType: "primary",
    layer: index,
    searchPlan: {
      queries: Array.from(
        { length: 3 },
        (_unused, queryIndex) => `node-${index + 1}-query-${queryIndex + 1}`,
      ),
      maxResults: 6,
      rankingProfile: "general",
      providerHints: ["general"],
    },
    status: "planned",
  })),
  edges: [
    {
      id: "node-1-to-node-2",
      source: "node-1",
      target: "node-2",
      type: "recommended_next",
    },
    {
      id: "node-2-to-node-3",
      source: "node-2",
      target: "node-3",
      type: "recommended_next",
    },
  ],
});

describe("startNodeJobs", () => {
  it("全部 layer 的 Node 立即推进，同时全图 Search 峰值严格为 6", async () => {
    expect(validateGraphPlan(PLAN)).toEqual({ valid: true, findings: [] });
    let activeSearches = 0;
    let peakSearches = 0;
    const searchSignals: AbortSignal[] = [];
    const pendingSearches: Deferred<NormalizedSearchHit[]>[] = [];
    const rawSearchProvider: SearchProvider = {
      id: "abort-ignoring-search",
      capabilities: ["general"],
      search: async (_request, signal) => {
        searchSignals.push(signal);
        activeSearches += 1;
        peakSearches = Math.max(peakSearches, activeSearches);
        const deferred = createDeferred<NormalizedSearchHit[]>();
        pendingSearches.push(deferred);
        try {
          return await deferred.promise;
        } finally {
          activeSearches -= 1;
        }
      },
    };
    const unusedLlmProvider: LLMProvider = {
      id: "unused-llm",
      structured: () => Promise.reject(new Error("Search 未完成前不应调用 LLM")),
    };
    const providers = createConcurrencyLimitedProviders({
      searchProvider: rawSearchProvider,
      llmProvider: unusedLlmProvider,
      concurrency: { search: 6, llm: 3 },
    });
    const cancelled = createAbortFixture("Node Search 排队期间取消");
    const events: NodeStreamEventPayload[] = [];
    const tasks = startNodeJobs({
      plan: PLAN,
      context: {
        officialSourcePolicy: { knownRiskyDownloadDomains: [] },
        nowMs: Date.parse("2026-10-22T00:00:00.000Z"),
        rerankTimeoutMs: 12_000,
        emit: async payload => {
          events.push(structuredClone(payload));
        },
      },
      providers,
      runScope: {
        signal: cancelled.signal,
        requirePositiveRemainingMs: () => 20_000,
      },
    });
    const taskSettlement = Promise.allSettled(tasks.map(task => task.promise));

    expect(tasks.map(task => task.nodeId)).toEqual([
      "node-1",
      "node-2",
      "node-3",
    ]);
    expect(
      events.filter(event => event.type === "node.status"),
    ).toEqual(
      PLAN.nodes.map(node => ({
        type: "node.status",
        nodeId: node.id,
        status: "searching",
      })),
    );
    await vi.waitFor(() => expect(searchSignals).toHaveLength(6));
    expect(peakSearches).toBe(6);
    expect(searchSignals.every(signal => signal === cancelled.signal)).toBe(true);

    cancelled.abort();
    const outcomes = await taskSettlement;
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBe(cancelled.reason);
      }
    }

    // 活跃 Provider 即使忽略取消并迟到返回，队列中的另外 3 次调用也不得启动。
    for (const deferred of pendingSearches.splice(0)) {
      deferred.resolve([]);
    }
    await vi.waitFor(() => expect(activeSearches).toBe(0));
    await Promise.resolve();
    expect(searchSignals).toHaveLength(6);
  });

  it("启动前已过 Deadline 时不创建任何 Node task", () => {
    const deadlineReason = new DOMException("Run deadline", "TimeoutError");
    const providers = createConcurrencyLimitedProviders({
      searchProvider: {
        id: "unused-search",
        capabilities: ["general"],
        search: async () => [],
      },
      llmProvider: {
        id: "unused-llm",
        structured: async () => ({}),
      },
      concurrency: { search: 6, llm: 3 },
    });

    expect(() =>
      startNodeJobs({
        plan: PLAN,
        context: {
          officialSourcePolicy: { knownRiskyDownloadDomains: [] },
          nowMs: 0,
          rerankTimeoutMs: 12_000,
          emit: async () => undefined,
        },
        providers,
        runScope: {
          signal: new AbortController().signal,
          requirePositiveRemainingMs: () => {
            throw deadlineReason;
          },
        },
      }),
    ).toThrow(deadlineReason);
  });
});
