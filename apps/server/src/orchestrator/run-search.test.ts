/**
 * 测试职责：用本地 Fake Provider 证明真实 Run 组合已连通计划、Node、结算与终态。
 *
 * 关键回归：GraphPlan 发布后才启动 Node；发布后立即越过绝对 Deadline 时，
 * 不得补 run.failed，而是为已公开的每个 Node 收敛唯一 failed 后 complete。
 */
import {
  GraphPlanSchema,
  type GraphPlan,
  type NormalizedSearchHit,
  type ResultGraph,
  type StreamEventPayload,
} from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createDeferred,
  createFixedClock,
  FakeLLMProvider,
  FakeSearchProvider,
} from "../../../../tests/support/test-infrastructure.mjs";
import type { LLMProvider } from "../ai/llm-provider.js";
import { NodeEventEmissionError } from "../pipeline/process-node.js";
import type { SearchProvider } from "../search/provider.js";
import { createConcurrencyLimitedProviders } from "./provider-concurrency.js";
import { createRunSearchHandler } from "./run-search.js";

const QUERY = "TypeScript compiler guide";
const SECOND_QUERY = "TypeScript project configuration";
const BROAD_QUERY = "TypeScript compiler ecosystem";

function createPlan(): GraphPlan {
  return GraphPlanSchema.parse({
    analysis: {
      intent: "learn",
      topic: QUERY,
      freshnessSensitive: false,
      ambiguityLevel: "low",
      broadSearchQueries: [],
      strategy: "plan_first",
      presentationMode: "compact",
    },
    nodes: [
      {
        id: "typescript-guide",
        title: "TypeScript compiler guide",
        description: "Learn TypeScript compiler options",
        nodeType: "primary",
        layer: 0,
        status: "planned",
        searchPlan: {
          queries: [QUERY],
          maxResults: 20,
          rankingProfile: "knowledge",
          providerHints: ["general"],
        },
      },
    ],
    edges: [],
  });
}

function createHit(): NormalizedSearchHit {
  const url = "https://docs.example.com/typescript/compiler";
  return {
    provider: "fake-search",
    query: QUERY,
    title: "TypeScript compiler guide",
    url,
    canonicalUrl: url,
    domain: "docs.example.com",
    snippet: "Learn TypeScript compiler options with practical examples.",
    providerRank: 1,
    providerScore: 0.9,
    rawMetadata: {},
  };
}

function createTwoNodePlan(): GraphPlan {
  const first = createPlan();
  return GraphPlanSchema.parse({
    ...first,
    nodes: [
      ...first.nodes,
      {
        ...first.nodes[0]!,
        id: "typescript-project",
        title: "TypeScript project configuration",
        description: "Learn TypeScript project configuration",
        layer: 1,
        searchPlan: {
          ...first.nodes[0]!.searchPlan,
          queries: [SECOND_QUERY],
        },
      },
    ],
    edges: [
      {
        id: "guide-to-project",
        source: "typescript-guide",
        target: "typescript-project",
        type: "recommended_next",
      },
    ],
  });
}

function createEvidenceAssistedPlan(description: string): GraphPlan {
  const plan = createTwoNodePlan();
  return GraphPlanSchema.parse({
    ...plan,
    analysis: {
      ...plan.analysis,
      intent: "learn",
      topic: "TypeScript compiler ecosystem",
      freshnessSensitive: false,
      ambiguityLevel: "medium",
      broadSearchQueries: [BROAD_QUERY],
      strategy: "evidence_assisted",
    },
    nodes: plan.nodes.map((node, index) =>
      index === 0 ? { ...node, description } : node,
    ),
  });
}

function createRerankOutput() {
  return {
    ranking: [
      {
        candidateId: "candidate_1",
        scores: {
          relevance: 0.95,
          authority: 0.95,
          clarity: 0.95,
          completeness: 0.95,
          trustSafety: 0.95,
          freshness: 0.95,
        },
        summary: "TypeScript 编译器选项的结构化摘要。",
        whySelected: "该文档与当前 Node 直接相关。",
      },
    ],
  };
}

function createDependencies(
  clock: ReturnType<typeof createFixedClock>,
  llmResponses: readonly unknown[],
) {
  const hit = createHit();
  return {
    providers: createConcurrencyLimitedProviders({
      searchProvider: new FakeSearchProvider({
        searchResponses: { [QUERY]: [hit] },
        extractResponse: [
          {
            canonicalUrl: hit.canonicalUrl,
            content: "The compiler guide explains all relevant options.",
          },
        ],
      }),
      llmProvider: new FakeLLMProvider(llmResponses),
      concurrency: { search: 6, extract: 3, llm: 3 },
    }),
    officialSourcePolicy: { knownRiskyDownloadDomains: [] },
    llmStageTimeoutMs: 15_000,
    rerankTimeoutMs: 12_000,
    language: "en",
    normalizeQuery: (query: string) => query.normalize("NFKC").toLowerCase(),
    onPlannerValidationDiagnostic: () => undefined,
    onRevisionValidationDiagnostic: () => undefined,
    now: clock.now,
  };
}

describe("createRunSearchHandler", () => {
  it("六个外部阶段共享同一 Run Scope，且迟到 Rerank 不能改写已完成 Graph", async () => {
    vi.useFakeTimers();
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const initialPlan = createEvidenceAssistedPlan("初始计划");
    const revisedPlan = createEvidenceAssistedPlan("Evidence 修订计划");
    const lateRerank = createDeferred<unknown>();
    const rerankEntered = createDeferred<void>();
    const observedSignals: Array<{
      stage: string;
      signal: AbortSignal;
    }> = [];
    const llmTimeouts: number[] = [];
    let llmCallIndex = 0;

    const llmProvider: LLMProvider = {
      id: "deadline-matrix-llm",
      structured: async (_input, options) => {
        const stage = ["planner", "reviser", "rerank"][llmCallIndex];
        if (stage === undefined) {
          throw new Error("Deadline 矩阵收到未预期的 LLM 调用");
        }
        llmCallIndex += 1;
        observedSignals.push({ stage, signal: options.signal });
        llmTimeouts.push(options.timeoutMs);
        if (stage === "planner") return initialPlan;
        if (stage === "reviser") return revisedPlan;
        rerankEntered.resolve();
        // 故意忽略 AbortSignal，模拟不能及时取消的外部 SDK。
        return lateRerank.promise;
      },
    };
    const broadHit: NormalizedSearchHit = {
      ...createHit(),
      query: BROAD_QUERY,
      url: "https://evidence.example/typescript",
      canonicalUrl: "https://evidence.example/typescript",
      domain: "evidence.example",
    };
    const nodeHit: NormalizedSearchHit = {
      ...createHit(),
      query: SECOND_QUERY,
      title: SECOND_QUERY,
      url: "https://docs.example.com/typescript/project",
      canonicalUrl: "https://docs.example.com/typescript/project",
    };
    const searchProvider: SearchProvider = {
      id: "deadline-matrix-search",
      capabilities: ["general"],
      search: async (request, signal) => {
        observedSignals.push({
          stage:
            request.kind === "broad_discovery"
              ? "broadSearch"
              : `search:${request.nodeId}`,
          signal,
        });
        if (request.kind === "broad_discovery") {
          clock.advanceBy(7_000);
          vi.advanceTimersByTime(7_000);
          return [broadHit];
        }
        if (request.query === QUERY) {
          throw new Error("第一个 Node 在 Deadline 前普通失败");
        }
        if (request.query === SECOND_QUERY) return [nodeHit];
        throw new Error(`Deadline 矩阵未配置 Query：${request.query}`);
      },
      extract: async (canonicalUrls, signal) => {
        observedSignals.push({ stage: "extract", signal });
        clock.advanceBy(10_000);
        vi.advanceTimersByTime(10_000);
        return canonicalUrls.map(canonicalUrl => ({
          canonicalUrl,
          content: "TypeScript project configuration reference.",
        }));
      },
    };
    const handler = createRunSearchHandler({
      ...createDependencies(clock, []),
      providers: createConcurrencyLimitedProviders({
        searchProvider,
        llmProvider,
        concurrency: { search: 6, extract: 3, llm: 3 },
        // Run Scope 与排队装饰器共用固定时钟，避免真实微任务延迟污染预算断言。
        now: clock.now,
      }),
    });
    const payloads: StreamEventPayload[] = [];
    let emittedResult: ResultGraph | undefined;
    let handlerFinished = false;
    const pending = handler({
      input: { runId: "run-93-degraded", query: QUERY },
      signal: new AbortController().signal,
      emit: async payload => {
        if (payload.type === "complete") {
          // 保留生产对象引用，避免克隆后的事件掩盖迟到任务对最终 Graph 的突变。
          emittedResult = payload.data.result;
        }
        payloads.push(structuredClone(payload));
      },
    }).then(() => {
      handlerFinished = true;
    });

    try {
      await rerankEntered.promise;
      await Promise.resolve();

      expect(observedSignals.map(item => item.stage)).toEqual([
        "planner",
        "broadSearch",
        "reviser",
        "search:typescript-guide",
        "search:typescript-project",
        "extract",
        "rerank",
      ]);
      const sharedSignal = observedSignals[0]?.signal;
      expect(sharedSignal).toBeDefined();
      expect(observedSignals.every(item => item.signal === sharedSignal)).toBe(
        true,
      );
      // Broad Search 与 Extract 已消耗 17 秒，Rerank 只能拿到同一 Run 的最后 3 秒。
      expect(llmTimeouts).toEqual([15_000, 13_000, 3_000]);
      expect(vi.getTimerCount()).toBe(1);
      expect(payloads).toContainEqual({
        type: "node.failed",
        nodeId: "typescript-guide",
        error: { code: "SEARCH_PROVIDER_FAILED", retryable: true },
      });

      await vi.advanceTimersByTimeAsync(2_999);
      expect(handlerFinished).toBe(false);
      expect(payloads.some(payload => payload.type === "complete")).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(handlerFinished).toBe(true);

      const nodeFailures = payloads.filter(
        (payload): payload is Extract<
          StreamEventPayload,
          { type: "node.failed" }
        > => payload.type === "node.failed",
      );
      expect(nodeFailures).toEqual([
        {
          type: "node.failed",
          nodeId: "typescript-guide",
          error: { code: "SEARCH_PROVIDER_FAILED", retryable: true },
        },
        {
          type: "node.failed",
          nodeId: "typescript-project",
          error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
        },
      ]);
      const complete = payloads.find(
        (payload): payload is Extract<
          StreamEventPayload,
          { type: "complete" }
        > => payload.type === "complete",
      );
      expect(complete).toBeDefined();
      expect(payloads.at(-1)).toBe(complete);
      if (emittedResult === undefined) {
        throw new Error("Deadline 矩阵缺少原始最终 ResultGraph");
      }
      const resultSnapshot = structuredClone(emittedResult);
      const closedPayloads = structuredClone(payloads);

      lateRerank.resolve(createRerankOutput());
      await Promise.resolve();
      await Promise.resolve();

      expect(payloads).toEqual(closedPayloads);
      expect(emittedResult).toEqual(resultSnapshot);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      lateRerank.resolve(createRerankOutput());
      await Promise.resolve();
      vi.useRealTimers();
    }
  });

  it("GraphPlan 前无响应的 Planner 不阻塞 Deadline，且迟到结果不能追加事件", async () => {
    vi.useFakeTimers();
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const latePlanner = createDeferred<unknown>();
    const plannerEntered = createDeferred<void>();
    const llmProvider: LLMProvider = {
      id: "deadline-ignoring-planner",
      structured: async () => {
        plannerEntered.resolve();
        // 故意忽略 AbortSignal，证明进程级并发装饰器仍会按 Run Deadline 释放调用方。
        return latePlanner.promise;
      },
    };
    const handler = createRunSearchHandler({
      ...createDependencies(clock, []),
      providers: createConcurrencyLimitedProviders({
        searchProvider: new FakeSearchProvider({ searchResponses: {} }),
        llmProvider,
        concurrency: { search: 6, extract: 3, llm: 3 },
      }),
    });
    const payloads: StreamEventPayload[] = [];
    const pending = handler({
      input: { runId: "run-93-late-planner", query: QUERY },
      signal: new AbortController().signal,
      emit: async payload => {
        payloads.push(structuredClone(payload));
      },
    });

    try {
      await plannerEntered.promise;
      await vi.advanceTimersByTimeAsync(20_000);
      await pending;

      expect(payloads).toEqual([
        {
          type: "run.failed",
          error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
        },
      ]);
      const closedPayloads = structuredClone(payloads);

      latePlanner.resolve(createPlan());
      await Promise.resolve();
      await Promise.resolve();

      expect(payloads).toEqual(closedPayloads);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      latePlanner.resolve(createPlan());
      await Promise.resolve();
      vi.useRealTimers();
    }
  });

  it("连通真实计划与 Node Pipeline，并在唯一 Node 终态后 complete", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const payloads: StreamEventPayload[] = [];
    const handler = createRunSearchHandler(
      createDependencies(clock, [createPlan(), createRerankOutput()]),
    );

    await handler({
      input: { runId: "run-70", query: QUERY },
      signal: new AbortController().signal,
      emit: async payload => {
        payloads.push(structuredClone(payload));
      },
    });

    expect(payloads.map(payload => payload.type)).toEqual([
      "query.analysis",
      "graph.plan",
      "node.status",
      "node.status",
      "node.ready",
      "complete",
    ]);
    expect(payloads.filter(payload => payload.type === "node.ready")).toHaveLength(
      1,
    );
    expect(payloads.at(-1)).toMatchObject({
      type: "complete",
      data: {
        finalStatus: "complete",
        result: {
          runId: "run-70",
          query: {
            raw: QUERY,
            normalized: "typescript compiler guide",
            language: "en",
          },
          meta: {
            providersUsed: ["fake-search"],
            partial: false,
          },
        },
      },
    });
  });

  it("GraphPlan 发布后 Timer 未回调却已过 Deadline 时收敛 Node 而不发 run.failed", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const payloads: StreamEventPayload[] = [];
    const handler = createRunSearchHandler(
      createDependencies(clock, [createPlan()]),
    );

    await handler({
      input: { runId: "run-70-deadline", query: QUERY },
      signal: new AbortController().signal,
      emit: async payload => {
        payloads.push(structuredClone(payload));
        if (payload.type === "graph.plan") {
          // 只推进统一时钟，不让真实 Timer 取得执行权，稳定覆盖延迟窗口。
          clock.advanceBy(20_000);
        }
      },
    });

    expect(payloads.map(payload => payload.type)).toEqual([
      "query.analysis",
      "graph.plan",
      "node.failed",
      "complete",
    ]);
    expect(payloads).not.toContainEqual(
      expect.objectContaining({ type: "run.failed" }),
    );
    expect(payloads[2]).toEqual({
      type: "node.failed",
      nodeId: "typescript-guide",
      error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
    });
  });

  it("GraphPlan 前普通错误只收敛为唯一 UNKNOWN run.failed", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const ordinaryError = new Error("normalize failed");
    const dependencies = createDependencies(clock, []);
    const handler = createRunSearchHandler({
      ...dependencies,
      normalizeQuery: () => {
        throw ordinaryError;
      },
    });
    const payloads: StreamEventPayload[] = [];

    await handler({
      input: { runId: "run-70-failed", query: QUERY },
      signal: new AbortController().signal,
      emit: async payload => {
        payloads.push(payload);
      },
    });

    expect(payloads).toEqual([
      {
        type: "run.failed",
        error: { code: "UNKNOWN", retryable: false },
      },
    ]);
  });

  it("GraphPlan 前绝对 Deadline 只发送 RUN_DEADLINE_EXCEEDED", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const dependencies = createDependencies(clock, [createPlan()]);
    const handler = createRunSearchHandler({
      ...dependencies,
      normalizeQuery: query => {
        clock.advanceBy(20_000);
        return query;
      },
    });
    const payloads: StreamEventPayload[] = [];

    await handler({
      input: { runId: "run-70-pre-plan-deadline", query: QUERY },
      signal: new AbortController().signal,
      emit: async payload => {
        payloads.push(payload);
      },
    });

    expect(payloads).toEqual([
      {
        type: "run.failed",
        error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
      },
    ]);
  });

  it("预先用户取消保持同名 TimeoutError 身份且零事件", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const handler = createRunSearchHandler(
      createDependencies(clock, [createPlan()]),
    );
    const controller = new AbortController();
    const userReason = new DOMException("用户主动停止", "TimeoutError");
    controller.abort(userReason);
    const payloads: StreamEventPayload[] = [];

    await expect(
      handler({
        input: { runId: "run-70-cancelled", query: QUERY },
        signal: controller.signal,
        emit: async payload => {
          payloads.push(payload);
        },
      }),
    ).rejects.toBe(userReason);
    expect(payloads).toEqual([]);
  });

  it("query.analysis 写入失败时传播 Sink 原错误且不补 run.failed", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const handler = createRunSearchHandler(
      createDependencies(clock, [createPlan()]),
    );
    const writeError = new Error("analysis sink failed");
    const payloads: StreamEventPayload[] = [];

    await expect(
      handler({
        input: { runId: "run-70-sink-failed", query: QUERY },
        signal: new AbortController().signal,
        emit: async payload => {
          payloads.push(payload);
          throw writeError;
        },
      }),
    ).rejects.toBe(writeError);
    expect(payloads.map(payload => payload.type)).toEqual([
      "query.analysis",
    ]);
  });

  it("query.analysis 背压中先取消时保留用户 reason 而不被后到 Sink 错误覆盖", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const handler = createRunSearchHandler(
      createDependencies(clock, [createPlan()]),
    );
    const controller = new AbortController();
    const userReason = new DOMException("用户背压期间取消", "AbortError");
    const writeError = new Error("late analysis sink failure");
    const analysisWrite = createDeferred<void>();
    const analysisAccepted = createDeferred<void>();
    const payloads: StreamEventPayload[] = [];

    const pending = handler({
      input: { runId: "run-70-plan-cancelled", query: QUERY },
      signal: controller.signal,
      emit: payload => {
        payloads.push(payload);
        if (payload.type === "query.analysis") {
          analysisAccepted.resolve();
          return analysisWrite.promise;
        }
        return Promise.resolve();
      },
    });
    await analysisAccepted.promise;
    controller.abort(userReason);
    analysisWrite.reject(writeError);

    await expect(pending).rejects.toBe(userReason);
    expect(payloads.map(payload => payload.type)).toEqual([
      "query.analysis",
    ]);
  });

  it("graph.plan 已接纳但写入失败时不补 run.failed", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const handler = createRunSearchHandler(
      createDependencies(clock, [createPlan()]),
    );
    const writeError = new Error("graph plan sink failed");
    const payloads: StreamEventPayload[] = [];

    await expect(
      handler({
        input: { runId: "run-70-plan-sink-failed", query: QUERY },
        signal: new AbortController().signal,
        emit: async payload => {
          payloads.push(payload);
          if (payload.type === "graph.plan") throw writeError;
        },
      }),
    ).rejects.toBe(writeError);
    expect(payloads.map(payload => payload.type)).toEqual([
      "query.analysis",
      "graph.plan",
    ]);
  });

  it("complete 写入失败时传播原错误且不补 run.failed", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const handler = createRunSearchHandler(
      createDependencies(clock, [createPlan(), createRerankOutput()]),
    );
    const writeError = new Error("complete sink failed");
    const payloads: StreamEventPayload[] = [];

    await expect(
      handler({
        input: { runId: "run-70-complete-sink-failed", query: QUERY },
        signal: new AbortController().signal,
        emit: async payload => {
          payloads.push(payload);
          if (payload.type === "complete") throw writeError;
        },
      }),
    ).rejects.toBe(writeError);
    expect(payloads.map(payload => payload.type)).toEqual([
      "query.analysis",
      "graph.plan",
      "node.status",
      "node.status",
      "node.ready",
      "complete",
    ]);
  });

  it("query.analysis 背压期间过 Deadline 时拒绝 graph.plan 并收敛 run.failed", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const handler = createRunSearchHandler(
      createDependencies(clock, [createPlan()]),
    );
    const payloads: StreamEventPayload[] = [];

    await handler({
      input: { runId: "run-70-plan-deadline", query: QUERY },
      signal: new AbortController().signal,
      emit: async payload => {
        payloads.push(payload);
        if (payload.type === "query.analysis") {
          // 模拟首条计划事件写入背压期间时钟越过 20 秒。
          clock.advanceBy(20_000);
        }
      },
    });
    expect(payloads.map(payload => payload.type)).toEqual([
      "query.analysis",
      "run.failed",
    ]);
    expect(payloads[1]).toEqual({
      type: "run.failed",
      error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
    });
  });

  it("Node Event Sink 致命失败时中止仍在 Provider 中的兄弟 Node", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const firstStatusWrite = createDeferred<void>();
    const writeError = new Error("first node status failed");
    let siblingSignal: AbortSignal | undefined;
    let siblingAbortReason: unknown;
    const rawSearchProvider: SearchProvider = {
      id: "fatal-test-search",
      capabilities: ["general"],
      search: async (request, signal) => {
        if (request.query !== SECOND_QUERY) {
          throw new Error("第一个 Node 在 status 写失败后不应进入 Search");
        }
        siblingSignal = signal;
        firstStatusWrite.reject(writeError);
        return await new Promise<NormalizedSearchHit[]>((_resolve, reject) => {
          const onAbort = (): void => {
            siblingAbortReason = signal.reason;
            reject(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      },
    };
    const providers = createConcurrencyLimitedProviders({
      searchProvider: rawSearchProvider,
      llmProvider: new FakeLLMProvider([createTwoNodePlan()]),
      concurrency: { search: 6, extract: 3, llm: 3 },
    });
    const dependencies = createDependencies(clock, []);
    const handler = createRunSearchHandler({
      ...dependencies,
      providers,
    });
    const payloads: StreamEventPayload[] = [];
    let handlerError: unknown;

    try {
      await handler({
        input: { runId: "run-70-fatal", query: QUERY },
        signal: new AbortController().signal,
        emit: payload => {
          payloads.push(payload);
          if (
            payload.type === "node.status" &&
            payload.nodeId === "typescript-guide"
          ) {
            return firstStatusWrite.promise;
          }
          return Promise.resolve();
        },
      });
    } catch (error: unknown) {
      handlerError = error;
    }

    expect(handlerError).toBeInstanceOf(NodeEventEmissionError);
    expect((handlerError as NodeEventEmissionError).cause).toBe(writeError);
    expect(siblingSignal?.aborted).toBe(true);
    expect(siblingAbortReason).toBe(handlerError);
    expect(payloads.map(payload => payload.type)).toEqual([
      "query.analysis",
      "graph.plan",
      "node.status",
      "node.status",
    ]);
  });
});
