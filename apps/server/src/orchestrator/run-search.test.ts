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
  type StreamEventPayload,
} from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import {
  createDeferred,
  createFixedClock,
  FakeLLMProvider,
  FakeSearchProvider,
} from "../../../../tests/support/test-infrastructure.mjs";
import { NodeEventEmissionError } from "../pipeline/process-node.js";
import type { SearchProvider } from "../search/provider.js";
import { createConcurrencyLimitedProviders } from "./provider-concurrency.js";
import { createRunSearchHandler } from "./run-search.js";

const QUERY = "TypeScript compiler guide";
const SECOND_QUERY = "TypeScript project configuration";

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
