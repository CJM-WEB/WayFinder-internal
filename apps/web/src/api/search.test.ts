import { prepareTestCredentials, testCredentials } from "../testing/test-credentials.js";
/**
 * 测试职责：冻结 Query（查询）取消协调器的 ID、Signal（中止信号）、
 * Store（状态仓库）所有权与错误边界。
 *
 * 测试使用显式 Deferred（延迟门）控制旧 Reader（读取器）的完成时刻，不依赖计时器或网络速度。
 */
import {
  StreamEventSchema,
  type StreamEvent,
} from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import { WEB_WAIT_TIMEOUT_MS } from "../../test-timing.js";
import { pythonResultGraphFixture } from "../fixtures/python-result-graph.js";
import type { ReadSearchEventStreamOptions } from "../lib/stream.js";
import { createGraphStore } from "../stores/graph-store.js";
import { createPythonMockStream } from "../testing/python-mock-stream.js";
import { createStartStreamingSearch } from "./search.js";

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}>;

/** 可手工放行的 Promise 用于构造 A 清理迟于 B/C 启动的确定性顺序。 */
const createDeferred = (): Deferred => {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>(resolve => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
};

type ValueDeferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}>;

/** 带返回值的延迟门用于模拟忽略 Controller（控制器）取消的 pending fetch。 */
const createValueDeferred = <T>(): ValueDeferred<T> => {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: value => resolvePromise?.(value),
  };
};

const response = new Response("");
const baseEvents = createPythonMockStream({
  now: () => Date.parse("2026-10-22T00:00:00.000Z"),
});

const eventOfType = <Type extends StreamEvent["type"]>(
  type: Type,
): Extract<StreamEvent, { type: Type }> => {
  const event = baseEvents.find(candidate => candidate.type === type);
  if (!event) throw new Error(`Mock Stream 缺少 ${type} 事件`);
  return event as Extract<StreamEvent, { type: Type }>;
};

/** complete 的 Envelope 与内层 ResultGraph 都携带 Run 身份，替换时必须保持一致。 */
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

describe("Query 取消协调器", () => {
  it("每次合法调用只创建一个 ID，并复用同一 Request 与 Signal", async () => {
    const store = createGraphStore();
    store
      .getState()
      .startRun({ runId: "old-run", query: "旧查询", language: "zh-CN" });
    store.getState().setGraph(pythonResultGraphFixture.graph);
    store.getState().selectNode(pythonResultGraphFixture.graph.nodes[0]?.id ?? null);

    const createRunId = vi.fn(() => "run-73");
    let fetchSignal: AbortSignal | null = null;
    let postedBody: unknown;
    const fetchImplementation = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchSignal = init?.signal ?? null;
        postedBody = JSON.parse(String(init?.body));

        // fetch 开始前 startRun 已原子清空旧 Graph、选择与 sequence。
        expect(store.getState()).toMatchObject({
          activeRunId: "run-73",
          query: "WayFinder",
          nodes: [],
          edges: [],
          selectedNodeId: null,
          lastSequence: 0,
          isSearching: true,
        });
        return response;
      },
    );
    const readStreamImplementation = vi.fn(
      async (options: ReadSearchEventStreamOptions) => {
        expect(options.signal).toBe(fetchSignal);
        await options.onEvent(eventForRun(eventOfType("graph.plan"), "run-73"));
        options.closeRun();
      },
    );
    const search = createStartStreamingSearch({
      prepareCredentials: prepareTestCredentials,
      store,
      createRunId,
      fetchImplementation,
      readStreamImplementation,
    });

    await search({ query: "  WayFinder  ", language: "zh-CN" });

    expect(createRunId).toHaveBeenCalledOnce();
    expect(postedBody).toEqual({
      runId: "run-73",
      query: "WayFinder",
      language: "zh-CN",
    });
    expect(fetchImplementation).toHaveBeenCalledWith("/api/search", {
      method: "POST",
      headers: {
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
        "x-wayfinder-credentials": JSON.stringify(testCredentials),
      },
      body: JSON.stringify(postedBody),
      credentials: "same-origin",
      cache: "no-store",
      signal: fetchSignal,
    });
    expect(store.getState()).toMatchObject({
      activeRunId: "run-73",
      query: "WayFinder",
      language: "zh-CN",
      nodes: eventOfType("graph.plan").data.nodes,
      isSearching: false,
    });
  });

  it("非法 Query 在创建 ID、取消旧 Run 和重置 Store 之前失败", async () => {
    const store = createGraphStore();
    const readerGate = createDeferred();
    let activeSignal: AbortSignal | undefined;
    const createRunId = vi.fn(() => "run-valid");
    const search = createStartStreamingSearch({
      prepareCredentials: prepareTestCredentials,
      store,
      createRunId,
      fetchImplementation: async (_input, init) => {
        activeSignal = init?.signal ?? undefined;
        return response;
      },
      readStreamImplementation: async options => {
        await readerGate.promise;
        options.closeRun();
      },
    });

    const validRun = search({ query: "有效查询", language: "zh-CN" });
    await vi.waitFor(() => expect(activeSignal).toBeDefined(), WEB_WAIT_TIMEOUT_MS);
    const beforeInvalid = store.getState();

    await expect(
      search({ query: " \t\n ", language: "zh-CN" }),
    ).rejects.toBeDefined();

    await expect(
      search({
        query: "有效查询",
        // 模拟绕过组件类型的 DOM/运行时输入，它不得产生任何副作用。
        language: "en",
      } as never),
    ).rejects.toBeDefined();

    expect(createRunId).toHaveBeenCalledOnce();
    expect(activeSignal?.aborted).toBe(false);
    expect(store.getState()).toBe(beforeInvalid);

    readerGate.resolve();
    await validRun;
  });

  it("B 在 A 的 fetch 仍 pending 时立即接管，并吸收 A 的迟到响应", async () => {
    const store = createGraphStore();
    const pendingFetchA = createValueDeferred<Response>();
    const readerBGate = createDeferred();
    const signals: AbortSignal[] = [];
    const readerOptions: ReadSearchEventStreamOptions[] = [];
    const runIds = ["run-fetch-a", "run-fetch-b"];
    let runIdIndex = 0;
    const search = createStartStreamingSearch({
      prepareCredentials: prepareTestCredentials,
      store,
      createRunId: () => runIds[runIdIndex++] ?? "unexpected-run",
      fetchImplementation: async (_input, init) => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) {
          throw new Error("测试请求缺少 AbortSignal");
        }
        signals.push(signal);
        return signals.length === 1 ? pendingFetchA.promise : response;
      },
      readStreamImplementation: async options => {
        readerOptions.push(options);
        if (options.signal === signals[0]) {
          // 模拟 A 的 fetch 忽略取消并迟到成功；Reader 仍必须收到已中止的同一 Signal。
          options.signal?.throwIfAborted();
          return;
        }
        await readerBGate.promise;
        options.closeRun();
      },
    });

    const runA = search({ query: "fetch A", language: "zh-CN" });
    await vi.waitFor(() => expect(signals).toHaveLength(1), WEB_WAIT_TIMEOUT_MS);

    const runB = search({ query: "fetch B", language: "zh-CN" });
    await vi.waitFor(() => expect(signals).toHaveLength(2), WEB_WAIT_TIMEOUT_MS);

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(store.getState()).toMatchObject({
      activeRunId: "run-fetch-b",
      query: "fetch B",
      isSearching: true,
    });

    pendingFetchA.resolve(response);
    await expect(runA).resolves.toBeUndefined();
    // 迟到响应在解析错误体或流之前就被拦截，旧请求不能触发配置提示或新的Reader。
    expect(readerOptions.find(options => options.signal === signals[0])).toBeUndefined();
    expect(store.getState()).toMatchObject({
      activeRunId: "run-fetch-b",
      isSearching: true,
    });

    readerBGate.resolve();
    await expect(runB).resolves.toBeUndefined();
    expect(store.getState().isSearching).toBe(false);
  });

  it("B 不等待 A 清理即可接管 Store，旧事件、close 与 finally 均不能影响 B/C", async () => {
    const store = createGraphStore();
    const runIds = ["run-a", "run-b", "run-c"];
    const gates = runIds.map(() => createDeferred());
    const entered = runIds.map(() => createDeferred());
    const readers: ReadSearchEventStreamOptions[] = [];
    let runIdIndex = 0;
    const search = createStartStreamingSearch({
      prepareCredentials: prepareTestCredentials,
      store,
      createRunId: () => runIds[runIdIndex++] ?? "unexpected-run",
      fetchImplementation: async () => response,
      readStreamImplementation: async options => {
        const index = readers.push(options) - 1;
        entered[index]?.resolve();
        await gates[index]?.promise;
        options.signal?.throwIfAborted();
        options.closeRun();
      },
    });

    const runA = search({ query: "相同查询", language: "zh-CN" });
    await entered[0]?.promise;
    const signalA = readers[0]?.signal;

    const runB = search({ query: "相同查询", language: "zh-CN" });
    await entered[1]?.promise;

    expect(signalA?.aborted).toBe(true);
    expect(readers[1]?.signal?.aborted).toBe(false);
    expect(store.getState()).toMatchObject({
      activeRunId: "run-b",
      query: "相同查询",
      nodes: [],
      isSearching: true,
    });

    // 模拟不遵守 Signal 的旧 Reader：Store runId 门禁和本层 close guard 都必须拒绝它。
    await readers[0]?.onEvent(
      eventForRun(eventOfType("graph.plan"), "run-a"),
    );
    readers[0]?.closeRun();
    expect(store.getState()).toMatchObject({
      activeRunId: "run-b",
      nodes: [],
      isSearching: true,
    });

    gates[0]?.resolve();
    await expect(runA).resolves.toBeUndefined();
    expect(store.getState().isSearching).toBe(true);

    await readers[1]?.onEvent(
      eventForRun(eventOfType("graph.plan"), "run-b"),
    );
    expect(store.getState().nodes).toEqual(eventOfType("graph.plan").data.nodes);

    // A 的迟到 finally 若错误清空所有权，C 将无法取消 B；这里显式冻结身份守卫。
    const runC = search({ query: "第三次查询", language: "zh-CN" });
    await entered[2]?.promise;
    expect(readers[1]?.signal?.aborted).toBe(true);
    expect(readers[2]?.signal?.aborted).toBe(false);
    expect(store.getState()).toMatchObject({
      activeRunId: "run-c",
      query: "第三次查询",
      nodes: [],
      isSearching: true,
    });

    gates[1]?.resolve();
    gates[2]?.resolve();
    await expect(runB).resolves.toBeUndefined();
    await expect(runC).resolves.toBeUndefined();
    expect(store.getState().isSearching).toBe(false);
    expect(runIdIndex).toBe(3);
  });

  it.each([
    ["网络错误", new Error("network down")],
    ["非本协调器发出的 AbortError", new DOMException("external abort", "AbortError")],
  ])("%s 保持原始错误上抛并关闭当前 Run", async (_label, failure) => {
    const store = createGraphStore();
    const search = createStartStreamingSearch({
      prepareCredentials: prepareTestCredentials,
      store,
      createRunId: () => "run-failed",
      fetchImplementation: async () => {
        throw failure;
      },
    });

    await expect(
      search({ query: "会失败的查询", language: "zh-CN" }),
    ).rejects.toBe(failure);
    expect(store.getState()).toMatchObject({
      activeRunId: "run-failed",
      isSearching: false,
      nodes: [],
    });
  });
});

it("完成回调只交付当前运行真正接纳的结果，忽略旧身份和重复终态", async () => {
  const store = createGraphStore();
  const onStart = vi.fn();
  const onComplete = vi.fn();
  const search = createStartStreamingSearch({
      prepareCredentials: prepareTestCredentials,
    store,
    createRunId: () => "当前运行",
    onStart,
    onComplete,
    fetchImplementation: async () => response,
    readStreamImplementation: async options => {
      options.onEvent(eventForRun(eventOfType("complete"), "过期运行"));
      expect(onComplete).not.toHaveBeenCalled();
      options.onEvent(eventForRun(eventOfType("complete"), "当前运行"));
      options.onEvent(eventForRun(eventOfType("complete"), "当前运行"));
    },
  });
  await search({ query: "Python", language: "zh-CN" });
  expect(onStart).toHaveBeenCalledExactlyOnceWith({ runId: "当前运行", query: "Python", language: "zh-CN" });
  expect(onComplete).toHaveBeenCalledTimes(1);
  expect(onComplete.mock.calls[0]?.[0]).toMatchObject({ runId: "当前运行" });
});

it("配置检查失败不分配身份、不取消旧Run，也不清空已有Graph", async () => {
  const store = createGraphStore();
  const gate = createDeferred();
  const failure = new Error("脱敏配置错误");
  const createRunId = vi.fn(() => "保留运行");
  let signal: AbortSignal | undefined;
  let configured = true;
  const search = createStartStreamingSearch({
    store, createRunId,
    prepareCredentials: async () => { if (!configured) throw failure; return testCredentials; },
    fetchImplementation: async (_input, init) => { signal = init?.signal ?? undefined; return response; },
    readStreamImplementation: async () => gate.promise,
  });
  const first = search({ query: "旧查询", language: "zh-CN" });
  await vi.waitFor(() => expect(signal).toBeDefined());
  store.getState().setGraph(pythonResultGraphFixture.graph);
  const previous = store.getState();
  configured = false;
  const onStart = vi.fn();
  await expect(search({ query: "仍留在输入框的新查询", language: "zh-CN" }, { onStart })).rejects.toBe(failure);
  expect(createRunId).toHaveBeenCalledTimes(1);
  expect(signal?.aborted).toBe(false);
  expect(store.getState()).toBe(previous);
  expect(onStart).not.toHaveBeenCalled();
  search.cancelPending();
  expect(signal?.aborted).toBe(false);
  gate.resolve();
  await first;
});

it("替换或取消的待检查意图即使迟到成功也不能创建Run", async () => {
  const store = createGraphStore();
  const checks = [createValueDeferred<typeof testCredentials>(), createValueDeferred<typeof testCredentials>(), createValueDeferred<typeof testCredentials>()];
  let next = 0;
  const createRunId = vi.fn(() => "唯一许可运行");
  const started = vi.fn();
  const fetchImplementation = vi.fn(async () => response);
  const search = createStartStreamingSearch({
    store, createRunId, fetchImplementation,
    prepareCredentials: () => checks[next++]!.promise,
    readStreamImplementation: async () => {},
  });
  const first = search({ query: "过期意图", language: "zh-CN" }, { onStart: started });
  const second = search({ query: "最新意图", language: "zh-CN" }, { onStart: started });
  expect(createRunId).not.toHaveBeenCalled();
  checks[1]!.resolve(testCredentials);
  await second;
  checks[0]!.resolve(testCredentials);
  await first;
  const third = search({ query: "已取消意图", language: "zh-CN" }, { onStart: started });
  search.cancel();
  checks[2]!.resolve(testCredentials);
  await third;
  expect(createRunId).toHaveBeenCalledOnce();
  expect(fetchImplementation).toHaveBeenCalledOnce();
  expect(started).toHaveBeenCalledExactlyOnceWith("唯一许可运行");
  expect(store.getState().query).toBe("最新意图");
});
