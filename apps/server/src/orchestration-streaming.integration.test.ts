/**
 * 集成测试职责：通过真实 Route、Run Event Writer 与 Orchestrator，冻结服务端渐进流的
 * happy / partial / rejected / deadline 主矩阵。
 *
 * 测试边界：只在 LLM、Search Provider 与 Clock 边界注入确定性 Fake；主矩阵使用
 * Fastify inject，Route → Reader 与断连证据使用临时本机 loopback。全部场景都不访问
 * 外部网络、不读取环境变量或 Secret，也不等待真实 20 秒。
 */
import {
  calculateSearchPlanMaxResults,
  GraphPlanSchema,
  StreamEventSchema,
  type GraphPlan,
  type NormalizedSearchHit,
  type SearchCapability,
  type StreamEvent,
  type StreamEventPayload,
} from "@wayfinder/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import {
  createDeferred,
  createFixedClock,
  FakeLLMProvider,
  FakeSearchProvider,
  type Deferred,
  type FixedClock,
} from "../../../tests/support/test-infrastructure.mjs";
import { readSearchEventStream } from "../../web/src/lib/stream.js";
import { createGraphStore } from "../../web/src/stores/graph-store.js";
import { createPythonMockStream } from "../../web/src/testing/python-mock-stream.js";
import { createConcurrencyLimitedProviders } from "./orchestrator/provider-concurrency.js";
import { createRunSearchHandler } from "./orchestrator/run-search.js";
import { registerSearchRoute } from "./routes/search.js";
import type { SearchProvider } from "./search/provider.js";

const QUERY = "TypeScript compiler guide";
const BACKUP_QUERY = "TypeScript compiler reference";
const LATE_QUERY = "TypeScript compiler internals";
const RUN_ID = "run-streaming-regression";

function createPlan(queries: readonly string[] = [QUERY]): GraphPlan {
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
          queries,
          maxResults: calculateSearchPlanMaxResults(queries.length),
          rankingProfile: "knowledge",
          providerHints: ["general"],
        },
      },
    ],
    edges: [],
  });
}

function createHit(query = QUERY): NormalizedSearchHit {
  const url = "https://docs.example.com/typescript/compiler";
  return {
    provider: "fake-search",
    query,
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
        id: "typescript-internals",
        title: "TypeScript compiler internals",
        description: "Explore the TypeScript compiler internals",
        layer: 1,
        searchPlan: {
          ...first.nodes[0]!.searchPlan,
          queries: [LATE_QUERY],
        },
      },
    ],
    edges: [
      {
        id: "guide-to-internals",
        source: "typescript-guide",
        target: "typescript-internals",
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

function createFakeSearchProvider(
  searchResponses: Readonly<
    Record<string, readonly NormalizedSearchHit[] | Error>
  >,
): FakeSearchProvider {
  const hit = createHit();
  return new FakeSearchProvider({
    searchResponses,
    extractResponse: [
      {
        canonicalUrl: hit.canonicalUrl,
        content: "The compiler guide explains all relevant options.",
      },
    ],
  });
}

/**
 * Provider 在真正 Search 调用时推进固定时钟，模拟 Timer 回调尚未执行的 Deadline 窗口。
 * 下一次状态提交会读取同一绝对时钟并把仍 pending 的 Node 归为 timed_out。
 */
class DeadlineAdvancingSearchProvider implements SearchProvider {
  public readonly id = "fake-search";
  public readonly capabilities: SearchCapability[] = ["general"];

  public constructor(private readonly clock: FixedClock) {}

  public async search(
    _request: Parameters<SearchProvider["search"]>[0],
    signal: AbortSignal,
  ): Promise<NormalizedSearchHit[]> {
    signal.throwIfAborted();
    this.clock.advanceBy(20_000);
    return [createHit()];
  }

  public async extract(): Promise<never> {
    throw new Error("Deadline 后不应继续 Extract");
  }
}

/** 第一 Node 普通失败，第二 Node 故意忽略 Signal 并迟到，用于冻结分类竞态。 */
class RejectedAndLateSearchProvider implements SearchProvider {
  public readonly id = "fake-search";
  public readonly capabilities: SearchCapability[] = ["general"];

  public constructor(
    private readonly lateSearch: Deferred<readonly NormalizedSearchHit[]>,
  ) {}

  public async search(
    request: Parameters<SearchProvider["search"]>[0],
  ): Promise<NormalizedSearchHit[]> {
    if (request.query === QUERY) {
      throw new Error("provider unavailable before deadline");
    }
    if (request.query === LATE_QUERY) {
      // 故意不读取 Signal，模拟不守约的 Provider 迟到返回。
      return [...(await this.lateSearch.promise)];
    }
    throw new Error(`测试 Provider 未配置 Query：${request.query}`);
  }

  public async extract(): Promise<never> {
    throw new Error("失败与超时路径不应继续 Extract");
  }
}

/** 记录 Route 取消但故意等到测试放行才返回，模拟忽略 AbortSignal 的外部 SDK。 */
class AbortObservingLateSearchProvider implements SearchProvider {
  public readonly id = "fake-search";
  public readonly capabilities: SearchCapability[] = ["general"];
  public observedSignal: AbortSignal | undefined;

  public constructor(
    private readonly entered: Deferred<void>,
    private readonly aborted: Deferred<unknown>,
    private readonly lateSearch: Deferred<readonly NormalizedSearchHit[]>,
    private readonly returned: Deferred<void>,
  ) {}

  public async search(
    _request: Parameters<SearchProvider["search"]>[0],
    signal: AbortSignal,
  ): Promise<NormalizedSearchHit[]> {
    this.observedSignal = signal;
    const recordAbort = (): void => this.aborted.resolve(signal.reason);
    if (signal.aborted) {
      recordAbort();
    } else {
      signal.addEventListener("abort", recordAbort, { once: true });
    }
    this.entered.resolve();

    const hits = await this.lateSearch.promise;
    signal.removeEventListener("abort", recordAbort);
    this.returned.resolve();
    return [...hits];
  }

  public async extract(): Promise<never> {
    throw new Error("取消后的迟到路径不应继续 Extract");
  }
}

type ScenarioInput = Readonly<{
  clock: FixedClock;
  plan: GraphPlan;
  searchProvider: SearchProvider;
  includeRerank?: boolean;
  expireBeforePlan?: boolean;
}>;

/** 真实组合层只替换外部能力；事件 Envelope、NDJSON 与业务状态机均使用生产实现。 */
function createScenarioServer(input: ScenarioInput): FastifyInstance {
  const llmResponses: unknown[] = [input.plan];
  if (input.includeRerank === true) {
    llmResponses.push(createRerankOutput());
  }
  const providers = createConcurrencyLimitedProviders({
    searchProvider: input.searchProvider,
    llmProvider: new FakeLLMProvider(llmResponses),
    concurrency: { search: 6, llm: 3 },
  });
  const server = Fastify({ logger: false });
  registerSearchRoute(
    server,
    createRunSearchHandler({
      providers,
      officialSourcePolicy: { knownRiskyDownloadDomains: [] },
      llmStageTimeoutMs: 15_000,
      rerankTimeoutMs: 12_000,
      language: "en",
      normalizeQuery: query => {
        // 固定时钟只在测试专用入口推进，用同一生产状态机证明 GraphPlan 前 Deadline。
        if (input.expireBeforePlan === true) {
          input.clock.advanceBy(20_000);
        }
        return query.normalize("NFKC").toLowerCase();
      },
      onPlannerValidationDiagnostic: () => undefined,
      onRevisionValidationDiagnostic: () => undefined,
      now: input.clock.now,
    }),
  );
  return server;
}

async function runScenario(input: ScenarioInput): Promise<StreamEvent[]> {
  const server = createScenarioServer(input);

  try {
    const response = await server.inject({
      method: "POST",
      url: "/api/search",
      payload: { runId: RUN_ID, query: QUERY },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(
      "application/x-ndjson; charset=utf-8",
    );

    return response.body
      .trimEnd()
      .split("\n")
      .map(line => StreamEventSchema.parse(JSON.parse(line)));
  } finally {
    await server.close();
  }
}

/** complete 的 Envelope 与 ResultGraph 必须同步换 Run 身份，供真实 Web Store 接纳。 */
function eventForRun(event: StreamEvent, runId: string): StreamEvent {
  return StreamEventSchema.parse(
    event.type === "complete"
      ? {
          ...event,
          runId,
          data: {
            ...event.data,
            result: { ...event.data.result, runId },
          },
        }
      : { ...event, runId },
  );
}

function responseFromEvents(events: readonly StreamEvent[]): Response {
  return new Response(
    `${events.map(event => JSON.stringify(event)).join("\n")}\n`,
    {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    },
  );
}

describe("Orchestration + NDJSON 服务端回归矩阵", () => {
  it("happy：按顺序发布计划、唯一 Node 终态和 complete", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const events = await runScenario({
      clock,
      plan: createPlan(),
      searchProvider: createFakeSearchProvider({
        [QUERY]: [createHit()],
      }),
      includeRerank: true,
    });

    expect(events.map(event => event.type)).toEqual([
      "query.analysis",
      "graph.plan",
      "node.status",
      "node.status",
      "node.ready",
      "complete",
    ]);
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events.at(-1)).toMatchObject({
      type: "complete",
      data: {
        finalStatus: "complete",
        result: {
          meta: { partial: false },
          graph: { nodes: [{ status: "ready" }] },
        },
      },
    });
  });

  it("loopback：真实 Route 响应由 Web Reader 消费并原子收敛 Store", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const server = createScenarioServer({
      clock,
      plan: createPlan([QUERY, BACKUP_QUERY]),
      searchProvider: createFakeSearchProvider({
        [QUERY]: [createHit()],
        [BACKUP_QUERY]: new Error("provider partial failure"),
      }),
      includeRerank: true,
    });
    const store = createGraphStore();

    try {
      const address = await server.listen({ host: "127.0.0.1", port: 0 });
      store.getState().startRun({ runId: RUN_ID, query: QUERY });
      const response = await globalThis.fetch(`${address}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: RUN_ID, query: QUERY }),
      });
      await readSearchEventStream({
        response,
        onEvent: event => store.getState().applyStreamEvent(event),
        closeRun: () => store.getState().finishRun(),
      });

      expect(store.getState()).toMatchObject({
        activeRunId: RUN_ID,
        query: QUERY,
        isSearching: false,
        lastSequence: 6,
        nodes: [
          expect.objectContaining({
            id: "typescript-guide",
            status: "partial",
            warnings: ["SEARCH_PROVIDER_PARTIAL"],
          }),
        ],
      });
    } finally {
      await server.close();
    }
  });

  it("partial：单 Query 拒绝但仍有 Resource 时保留 Warning 并完成", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const events = await runScenario({
      clock,
      plan: createPlan([QUERY, BACKUP_QUERY]),
      searchProvider: createFakeSearchProvider({
        [QUERY]: [createHit()],
        [BACKUP_QUERY]: new Error("provider partial failure"),
      }),
      includeRerank: true,
    });

    expect(events.find(event => event.type === "node.partial")).toMatchObject({
      type: "node.partial",
      warnings: ["SEARCH_PROVIDER_PARTIAL"],
      resources: expect.arrayContaining([expect.objectContaining({ rank: 1 })]),
    });
    expect(events.at(-1)).toMatchObject({
      type: "complete",
      data: {
        finalStatus: "partial",
        result: {
          meta: { partial: true },
          graph: {
            nodes: [
              expect.objectContaining({
                status: "partial",
                warnings: ["SEARCH_PROVIDER_PARTIAL"],
              }),
            ],
          },
        },
      },
    });
  });

  it("rejected：普通 Provider 失败在 Wire 与 ResultGraph 中都不变成 Deadline", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const events = await runScenario({
      clock,
      plan: createPlan(),
      searchProvider: createFakeSearchProvider({
        [QUERY]: new Error("provider unavailable"),
      }),
    });

    const failed = events.find(event => event.type === "node.failed");
    expect(failed).toMatchObject({
      type: "node.failed",
      error: { code: "SEARCH_PROVIDER_FAILED", retryable: true },
    });
    expect(failed).not.toMatchObject({
      error: { code: "RUN_DEADLINE_EXCEEDED" },
    });
    expect(events.at(-1)).toMatchObject({
      type: "complete",
      data: {
        // GraphPlan 已发布后的 Node 失败属于可浏览的局部结果，不提升为全局 run.failed。
        finalStatus: "partial",
        result: {
          graph: {
            nodes: [
              expect.objectContaining({
                status: "failed",
                error: {
                  code: "SEARCH_PROVIDER_FAILED",
                  retryable: true,
                },
              }),
            ],
          },
        },
      },
    });
  });

  it("deadline：计划发布后只把截止时 pending Node 收敛为超时再 complete", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const events = await runScenario({
      clock,
      plan: createPlan(),
      searchProvider: new DeadlineAdvancingSearchProvider(clock),
    });

    expect(events.map(event => event.type)).toEqual([
      "query.analysis",
      "graph.plan",
      "node.status",
      "node.failed",
      "complete",
    ]);
    expect(events[3]).toMatchObject({
      type: "node.failed",
      error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "run.failed" }),
    );
  });

  it("deadline：计划发布前只发送唯一 run.failed", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const events = await runScenario({
      clock,
      plan: createPlan(),
      searchProvider: createFakeSearchProvider({
        [QUERY]: [createHit()],
      }),
      expireBeforePlan: true,
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "run.failed",
        runId: RUN_ID,
        sequence: 1,
        error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
      }),
    ]);
  });

  it("rejected + deadline：保留先发生的 Provider 错误并忽略另一 Node 的迟到结果", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const lateSearch = createDeferred<readonly NormalizedSearchHit[]>();
    const plan = createTwoNodePlan();
    const providers = createConcurrencyLimitedProviders({
      searchProvider: new RejectedAndLateSearchProvider(lateSearch),
      llmProvider: new FakeLLMProvider([plan]),
      concurrency: { search: 6, llm: 3 },
    });
    const handler = createRunSearchHandler({
      providers,
      officialSourcePolicy: { knownRiskyDownloadDomains: [] },
      llmStageTimeoutMs: 15_000,
      rerankTimeoutMs: 12_000,
      language: "en",
      normalizeQuery: query => query.normalize("NFKC").toLowerCase(),
      onPlannerValidationDiagnostic: () => undefined,
      onRevisionValidationDiagnostic: () => undefined,
      now: clock.now,
    });
    const payloads: StreamEventPayload[] = [];

    await handler({
      input: { runId: RUN_ID, query: QUERY },
      signal: new AbortController().signal,
      emit: async payload => {
        payloads.push(structuredClone(payload));
        if (
          payload.type === "node.failed" &&
          payload.nodeId === "typescript-guide"
        ) {
          // 终态已由账本同步占位后再到期，Deadline 快照不能把它改写。
          clock.advanceBy(20_000);
        }
      },
    });

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
        nodeId: "typescript-internals",
        error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
      },
    ]);
    expect(payloads.at(-1)).toMatchObject({
      type: "complete",
      data: {
        finalStatus: "partial",
        result: {
          graph: {
            nodes: [
              expect.objectContaining({
                id: "typescript-guide",
                error: { code: "SEARCH_PROVIDER_FAILED", retryable: true },
              }),
              expect.objectContaining({
                id: "typescript-internals",
                error: {
                  code: "RUN_DEADLINE_EXCEEDED",
                  retryable: true,
                },
              }),
            ],
          },
        },
      },
    });
    expect(payloads).not.toContainEqual(
      expect.objectContaining({ type: "run.failed" }),
    );

    const closedPayloads = structuredClone(payloads);
    lateSearch.resolve([createHit(LATE_QUERY)]);
    await Promise.resolve();
    await Promise.resolve();
    expect(payloads).toEqual(closedPayloads);
  });

  it("cancel + disconnect + late：浏览器替换取消传播到 Provider 且不污染新 Run", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const entered = createDeferred<void>();
    const aborted = createDeferred<unknown>();
    const lateSearch = createDeferred<readonly NormalizedSearchHit[]>();
    const returned = createDeferred<void>();
    const searchProvider = new AbortObservingLateSearchProvider(
      entered,
      aborted,
      lateSearch,
      returned,
    );
    const server = createScenarioServer({
      clock,
      plan: createPlan(),
      searchProvider,
    });
    const store = createGraphStore();
    const runIds = ["run-streaming-a", "run-streaming-b"];
    const mockEvents = createPythonMockStream(clock);
    const clientController = new AbortController();
    const clientReason = new DOMException("新 Query 已开始", "AbortError");

    try {
      const address = await server.listen({ host: "127.0.0.1", port: 0 });
      store.getState().startRun({ runId: runIds[0]!, query: "first query" });
      const responseA = await globalThis.fetch(`${address}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: runIds[0], query: "first query" }),
        signal: clientController.signal,
      });
      const readA = readSearchEventStream({
        response: responseA,
        signal: clientController.signal,
        onEvent: event => store.getState().applyStreamEvent(event),
        closeRun: () => {
          if (store.getState().activeRunId === runIds[0]) {
            store.getState().finishRun();
          }
        },
      });
      // 立即观察拒绝，避免在 B 收敛期间留下短暂的 unhandled rejection 窗口。
      const readAResult = readA.then(
        () => undefined,
        (error: unknown) => error,
      );

      await entered.promise;
      clientController.abort(clientReason);
      store.getState().startRun({ runId: runIds[1]!, query: "second query" });
      await readSearchEventStream({
        response: responseFromEvents(
          mockEvents.map(event => eventForRun(event, runIds[1]!)),
        ),
        onEvent: event => store.getState().applyStreamEvent(event),
        closeRun: () => store.getState().finishRun(),
      });
      const abortReason = await aborted.promise;
      expect(await readAResult).toBe(clientReason);

      expect(searchProvider.observedSignal?.aborted).toBe(true);
      expect(abortReason).toBe(searchProvider.observedSignal?.reason);
      const completedB = store.getState();
      expect(completedB).toMatchObject({
        activeRunId: runIds[1],
        query: "second query",
        isSearching: false,
        lastSequence: mockEvents.at(-1)?.sequence,
      });

      lateSearch.resolve([createHit()]);
      await returned.promise;
      await Promise.resolve();
      expect(store.getState()).toBe(completedB);
    } finally {
      // 失败断言也必须放行 Provider，避免 server.close 等待悬挂的 Route。
      lateSearch.resolve([createHit()]);
      await server.close();
    }
  });
});
