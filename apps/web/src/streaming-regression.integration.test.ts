import { prepareTestCredentials } from "./testing/test-credentials.js";
/**
 * 集成测试职责：通过真实 Search Coordinator、NDJSON Reader 与 Graph Store，冻结客户端
 * happy、乱序/重复、断连、替换取消与迟到响应边界。
 *
 * 测试边界：Response 全部由内存 ReadableStream 构造；不访问外部网络、不读取 Secret，
 * 也不依赖 sleep、随机 ID 或墙钟竞态。
 */
import {
  StreamEventSchema,
  type StreamEvent,
} from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import { WEB_WAIT_TIMEOUT_MS } from "../test-timing.js";
import { createStartStreamingSearch } from "./api/search.js";
import { pythonResultGraphFixture } from "./fixtures/python-result-graph.js";
import { createGraphStore } from "./stores/graph-store.js";
import { createPythonMockStream } from "./testing/python-mock-stream.js";

const encoder = new TextEncoder();
const RUN_ID = pythonResultGraphFixture.runId;
const baseEvents = createPythonMockStream({
  now: () => Date.parse("2026-10-22T00:00:00.000Z"),
});

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}>;

/** 手动放行 fetch 响应，稳定构造旧请求迟于新请求返回的顺序。 */
function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) {
    throw new Error("Deferred 初始化失败");
  }
  return { promise, resolve: resolvePromise };
}

const eventOfType = <Type extends StreamEvent["type"]>(
  type: Type,
): Extract<StreamEvent, { type: Type }> => {
  const event = baseEvents.find(candidate => candidate.type === type);
  if (!event) throw new Error(`Mock Stream 缺少 ${type} 事件`);
  return event as Extract<StreamEvent, { type: Type }>;
};

/** complete 内外各有一次 Run 身份，替换时必须同步保持 Contract 一致。 */
const eventForRun = (event: StreamEvent, runId: string): StreamEvent =>
  StreamEventSchema.parse(
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

const replaceSequence = <Event extends StreamEvent>(
  event: Event,
  sequence: number,
): Event => StreamEventSchema.parse({ ...event, sequence }) as Event;

const toNdjson = (events: readonly StreamEvent[]): string =>
  `${events.map(event => JSON.stringify(event)).join("\n")}\n`;

/** 任意切分 UTF-8 字节，用于证明集成链仍走增量 Reader，而非逐事件测试替身。 */
function responseFromEvents(
  events: readonly StreamEvent[],
  cutPoints: readonly number[] = [],
): Response {
  const bytes = encoder.encode(toNdjson(events));
  const boundaries = [
    0,
    ...cutPoints.filter(point => point > 0 && point < bytes.length),
    bytes.length,
  ];
  const chunks = boundaries.slice(0, -1).map((start, index) =>
    bytes.slice(start, boundaries[index + 1]),
  );

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200 },
  );
}

describe("NDJSON Reader + Store 客户端回归矩阵", () => {
  it("happy：跨任意 Chunk 读取完整 Stream 并以 complete 权威收敛", async () => {
    const store = createGraphStore();
    const fetchImplementation = vi.fn(async () =>
      responseFromEvents(baseEvents, [1, 13, 97, 521]),
    );
    const search = createStartStreamingSearch({
      prepareCredentials: prepareTestCredentials,
      store,
      fetchImplementation,
      createRunId: () => RUN_ID,
    });

    await search({ query: "Python", language: "zh-CN" });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      activeRunId: RUN_ID,
      nodes: pythonResultGraphFixture.graph.nodes,
      edges: pythonResultGraphFixture.graph.edges,
      isSearching: false,
      lastSequence: baseEvents.at(-1)?.sequence,
    });
  });

  it("duplicate/out-of-order：真实 Reader 交付后由 Store 门禁完整丢弃", async () => {
    const store = createGraphStore();
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      }),
      { status: 200 },
    );
    const search = createStartStreamingSearch({
      prepareCredentials: prepareTestCredentials,
      store,
      fetchImplementation: async () => response,
      createRunId: () => RUN_ID,
    });
    const plan = replaceSequence(eventOfType("graph.plan"), 2);
    const ready = replaceSequence(eventOfType("node.ready"), 4);
    const untouchedNode = plan.data.nodes.find(node => node.id !== ready.nodeId);
    if (untouchedNode === undefined || streamController === undefined) {
      throw new Error("测试 Graph 缺少用于乱序断言的 Node 或 Stream Controller");
    }
    const outOfOrder = StreamEventSchema.parse({
      ...eventOfType("node.status"),
      sequence: 3,
      nodeId: untouchedNode.id,
      status: "filtering",
    });

    const searchPromise = search({ query: "Python", language: "zh-CN" });
    streamController.enqueue(
      encoder.encode(
        toNdjson([
          replaceSequence(eventOfType("query.analysis"), 1),
          plan,
          plan,
          ready,
          outOfOrder,
        ]),
      ),
    );

    await vi.waitFor(() => expect(store.getState().lastSequence).toBe(4), WEB_WAIT_TIMEOUT_MS);
    expect(
      store.getState().nodes.find(node => node.id === untouchedNode.id)?.status,
    ).toBe("planned");

    streamController.enqueue(
      encoder.encode(
        toNdjson([replaceSequence(eventOfType("complete"), 5)]),
      ),
    );
    streamController.close();
    await searchPromise;

    expect(store.getState()).toMatchObject({
      isSearching: false,
      lastSequence: 5,
      nodes: pythonResultGraphFixture.graph.nodes,
    });
  });

  it("disconnect：Reader 保留网络错误，关闭加载但保留已收到的 Draft", async () => {
    const store = createGraphStore();
    const disconnectError = new Error("connection reset by peer");
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      }),
      { status: 200 },
    );
    const search = createStartStreamingSearch({
      prepareCredentials: prepareTestCredentials,
      store,
      fetchImplementation: async () => response,
      createRunId: () => RUN_ID,
    });

    const searchPromise = search({ query: "Python", language: "zh-CN" });
    streamController?.enqueue(
      encoder.encode(toNdjson([eventOfType("graph.plan")])),
    );
    await vi.waitFor(
      () => expect(store.getState().nodes.length).toBeGreaterThan(0),
      WEB_WAIT_TIMEOUT_MS,
    );
    streamController?.error(disconnectError);

    await expect(searchPromise).rejects.toBe(disconnectError);
    expect(store.getState()).toMatchObject({
      nodes: eventOfType("graph.plan").data.nodes,
      isSearching: false,
    });
  });

  it("cancel/late：新 Run 不等待旧 fetch，并吸收旧 Run 的迟到完整响应", async () => {
    const store = createGraphStore();
    const lateResponseA = createDeferred<Response>();
    const runIds = ["run-streaming-a", "run-streaming-b"];
    const signals: AbortSignal[] = [];
    let runIndex = 0;
    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (!(init?.signal instanceof AbortSignal)) {
          throw new Error("Search Request 缺少 AbortSignal");
        }
        signals.push(init.signal);
        if (signals.length === 1) return lateResponseA.promise;

        return responseFromEvents(
          baseEvents.map(event => eventForRun(event, runIds[1]!)),
        );
      },
    );
    const search = createStartStreamingSearch({
      prepareCredentials: prepareTestCredentials,
      store,
      fetchImplementation,
      createRunId: () => runIds[runIndex++] ?? "unexpected-run",
    });

    const runA = search({ query: "first query", language: "zh-CN" });
    await vi.waitFor(() => expect(signals).toHaveLength(1), WEB_WAIT_TIMEOUT_MS);
    const runB = search({ query: "second query", language: "zh-CN" });
    await runB;

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    const completedB = store.getState();
    expect(completedB).toMatchObject({
      activeRunId: runIds[1],
      query: "second query",
      isSearching: false,
      nodes: pythonResultGraphFixture.graph.nodes,
    });

    // 模拟不遵守 AbortSignal 的旧 fetch：即使迟到返回一整条合法 Stream，也不得读入 Store。
    lateResponseA.resolve(
      responseFromEvents(
        baseEvents.map(event => eventForRun(event, runIds[0]!)),
      ),
    );
    await expect(runA).resolves.toBeUndefined();
    expect(store.getState()).toBe(completedB);
  });
});
