/**
 * 测试职责：冻结 WAY-71 增量 NDJSON Reader 的字节边界、Contract 门禁与清理语义。
 *
 * 范围边界：不测试旧 runId、sequence 去重、事件归并或终态封闭；这些属于 WAY-72。
 */
import { StreamEventSchema, type StreamEvent } from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import { pythonResultGraphFixture } from "../fixtures/python-result-graph.js";
import { createGraphStore } from "../stores/graph-store.js";
import { readSearchEventStream } from "./stream.js";

const encoder = new TextEncoder();

const createEvent = (
  sequence: number,
  topic = "中文主题🙂",
): StreamEvent =>
  StreamEventSchema.parse({
    runId: "run-way-71",
    sequence,
    protocolVersion: "0.1",
    timestamp: "2026-10-22T00:00:00.000Z",
    type: "query.analysis",
    data: {
      intent: "learn",
      topic,
      freshnessSensitive: false,
      ambiguityLevel: "low",
      broadSearchQueries: [],
      strategy: "plan_first",
      presentationMode: "graph",
    },
  });

const createResponse = (
  body: ReadableStream<Uint8Array> | null,
  status = 200,
) => ({
  body,
  ok: status >= 200 && status < 300,
  status,
});

const streamChunks = (
  chunks: readonly Uint8Array[],
): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const createDeferred = () => {
  let resolve = (): void => undefined;
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const closeActiveRun = (
  store: ReturnType<typeof createGraphStore>,
  runId: string,
): (() => void) =>
  vi.fn(() => {
    const state = store.getState();
    if (state.activeRunId === runId) state.finishRun();
  });

describe("readSearchEventStream", () => {
  it("跨任意 chunk 与 UTF-8 多字节边界按 Wire 顺序逐条交付", async () => {
    const first = createEvent(1);
    const second = createEvent(2, "第二个主题");
    const bytes = encoder.encode(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
    const chunks = Array.from(bytes, byte => Uint8Array.of(byte));
    const received: StreamEvent[] = [];
    const closeRun = vi.fn();

    await readSearchEventStream({
      response: createResponse(streamChunks(chunks)),
      onEvent: event => {
        received.push(event);
      },
      closeRun,
    });

    expect(received).toEqual([first, second]);
    expect(closeRun).toHaveBeenCalledOnce();
  });

  it("一个 chunk 内解析多行，并在 EOF 解析无 LF 的 final residual", async () => {
    const first = createEvent(1);
    const second = createEvent(2);
    const received: StreamEvent[] = [];

    await readSearchEventStream({
      response: createResponse(
        streamChunks([
          encoder.encode(`${JSON.stringify(first)}\n${JSON.stringify(second)}`),
        ]),
      ),
      onEvent: event => {
        received.push(event);
      },
      closeRun: vi.fn(),
    });

    expect(received).toEqual([first, second]);
  });

  it("末尾 LF 与空白行不会产生空事件或重复 residual", async () => {
    const event = createEvent(1);
    const onEvent = vi.fn();

    await readSearchEventStream({
      response: createResponse(
        streamChunks([encoder.encode(`\n${JSON.stringify(event)}\r\n  \n`)]),
      ),
      onEvent,
      closeRun: vi.fn(),
    });

    expect(onEvent).toHaveBeenCalledExactlyOnceWith(event);
  });

  it.each([
    ["损坏 JSON", "{not-json}\n"],
    [
      "不符合 StreamEvent Contract 的 JSON",
      `${JSON.stringify({ ...createEvent(1), sequence: 0 })}\n`,
    ],
  ])("%s 会关闭当前 Run，并停止交付后续行", async (_label, invalidLine) => {
    const store = createGraphStore();
    store.getState().startRun({ runId: "run-way-71", query: "WayFinder" });
    const first = createEvent(1);
    const afterFailure = createEvent(2);
    const onEvent = vi.fn();
    const closeRun = closeActiveRun(store, "run-way-71");
    const stream = streamChunks([
      encoder.encode(
        `${JSON.stringify(first)}\n${invalidLine}${JSON.stringify(afterFailure)}\n`,
      ),
    ]);

    await expect(
      readSearchEventStream({
        response: createResponse(stream),
        onEvent,
        closeRun,
      }),
    ).rejects.toBeDefined();

    expect(onEvent).toHaveBeenCalledExactlyOnceWith(first);
    expect(closeRun).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      activeRunId: "run-way-71",
      query: "WayFinder",
      isSearching: false,
    });
    expect(stream.locked).toBe(false);
  });

  it("截断 UTF-8 不会被替换字符掩盖", async () => {
    const complete = encoder.encode(`${JSON.stringify(createEvent(1))}\n`);
    const emojiStart = complete.indexOf(0xf0);
    if (emojiStart < 0) throw new Error("测试事件缺少四字节 emoji");
    const truncated = complete.slice(0, emojiStart + 2);
    const onEvent = vi.fn();
    const closeRun = vi.fn();

    await expect(
      readSearchEventStream({
        response: createResponse(streamChunks([truncated])),
        onEvent,
        closeRun,
      }),
    ).rejects.toBeInstanceOf(TypeError);

    expect(onEvent).not.toHaveBeenCalled();
    expect(closeRun).toHaveBeenCalledOnce();
  });

  it("网络读取失败保留原始错误，并释放 Reader lock", async () => {
    const networkError = new Error("socket reset");
    const first = createEvent(1);
    const store = createGraphStore();
    store.getState().startRun({ runId: "run-way-71", query: "WayFinder" });
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(encoder.encode(`${JSON.stringify(first)}\n`));
          return;
        }
        controller.error(networkError);
      },
    });
    const onEvent = vi.fn();
    const closeRun = closeActiveRun(store, "run-way-71");

    await expect(
      readSearchEventStream({
        response: createResponse(stream),
        onEvent,
        closeRun,
      }),
    ).rejects.toBe(networkError);

    expect(onEvent).toHaveBeenCalledExactlyOnceWith(first);
    expect(closeRun).toHaveBeenCalledOnce();
    expect(store.getState().isSearching).toBe(false);
    expect(stream.locked).toBe(false);
  });

  it("partial line 中途断网时不交付残片", async () => {
    const networkError = new Error("body interrupted");
    const encoded = encoder.encode(JSON.stringify(createEvent(1)));
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(encoded.slice(0, Math.floor(encoded.length / 2)));
          return;
        }
        controller.error(networkError);
      },
    });
    const onEvent = vi.fn();

    await expect(
      readSearchEventStream({
        response: createResponse(stream),
        onEvent,
        closeRun: vi.fn(),
      }),
    ).rejects.toBe(networkError);

    expect(onEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["非 2xx Response", createResponse(null, 503)],
    ["缺少 Response body", createResponse(null)],
  ])("%s 会稳定关闭 Run", async (_label, response) => {
    const closeRun = vi.fn();

    await expect(
      readSearchEventStream({
        response,
        onEvent: vi.fn(),
        closeRun,
      }),
    ).rejects.toBeInstanceOf(Error);

    expect(closeRun).toHaveBeenCalledOnce();
  });

  it("等待异步 onEvent，且消费者错误不会被清理错误覆盖", async () => {
    const consumerError = new Error("consumer failed");
    const second = createEvent(2);
    const stream = streamChunks([
      encoder.encode(
        `${JSON.stringify(createEvent(1))}\n${JSON.stringify(second)}\n`,
      ),
    ]);
    const onEvent = vi.fn(async () => {
      throw consumerError;
    });

    await expect(
      readSearchEventStream({
        response: createResponse(stream),
        onEvent,
        closeRun: vi.fn(),
      }),
    ).rejects.toBe(consumerError);

    expect(onEvent).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("Reader cancel 的二次清理错误不会覆盖首个 JSON 错误", async () => {
    const cleanupError = new Error("cancel cleanup failed");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("{invalid}\n"));
      },
      cancel() {
        throw cleanupError;
      },
    });

    let caught: unknown;
    try {
      await readSearchEventStream({
        response: createResponse(stream),
        onEvent: vi.fn(),
        closeRun: vi.fn(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SyntaxError);
    expect(caught).not.toBe(cleanupError);
    expect(stream.locked).toBe(false);
  });

  it("reader.cancel 同步触发用户取消时最终传播取消 reason", async () => {
    const controller = new AbortController();
    const reason = new DOMException("用户取消优先", "AbortError");
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode("{invalid}\n"));
      },
      cancel() {
        controller.abort(reason);
      },
    });

    await expect(
      readSearchEventStream({
        response: createResponse(stream),
        signal: controller.signal,
        onEvent: vi.fn(),
        closeRun: vi.fn(),
      }),
    ).rejects.toBe(reason);
  });

  it("预先取消时不读取 Body，并原样传播 reason", async () => {
    const controller = new AbortController();
    const reason = new DOMException("用户取消", "AbortError");
    const stream = streamChunks([]);
    const getReader = vi.spyOn(stream, "getReader");
    const closeRun = vi.fn();
    controller.abort(reason);

    await expect(
      readSearchEventStream({
        response: createResponse(stream),
        signal: controller.signal,
        onEvent: vi.fn(),
        closeRun,
      }),
    ).rejects.toBe(reason);

    expect(getReader).not.toHaveBeenCalled();
    expect(closeRun).toHaveBeenCalledOnce();
  });

  it("read 返回后发生取消时不交付尚未形成 LF 的合法 residual", async () => {
    const controller = new AbortController();
    const reason = new DOMException("取消 residual", "AbortError");
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controllerForStream) {
        streamController = controllerForStream;
      },
    });
    const onEvent = vi.fn();
    const reading = readSearchEventStream({
      response: createResponse(stream),
      signal: controller.signal,
      onEvent,
      closeRun: vi.fn(),
    });

    streamController?.enqueue(encoder.encode(JSON.stringify(createEvent(1))));
    controller.abort(reason);

    await expect(reading).rejects.toBe(reason);
    expect(onEvent).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it("异步 onEvent pending 时取消无需等待消费者即可关闭", async () => {
    const controller = new AbortController();
    const reason = new DOMException("取消消费者", "AbortError");
    const entered = createDeferred();
    const consumerGate = createDeferred();
    const closeRun = vi.fn();
    const reading = readSearchEventStream({
      response: createResponse(
        streamChunks([encoder.encode(`${JSON.stringify(createEvent(1))}\n`)]),
      ),
      signal: controller.signal,
      onEvent: async () => {
        entered.resolve();
        await consumerGate.promise;
      },
      closeRun,
    });

    await entered.promise;
    controller.abort(reason);

    await expect(reading).rejects.toBe(reason);
    expect(closeRun).toHaveBeenCalledOnce();
    consumerGate.resolve();
  });

  it("底层 cancel pending 不阻塞 UI 关闭、Reader 解锁或主 Promise", async () => {
    const controller = new AbortController();
    const reason = new DOMException("取消慢清理", "AbortError");
    const cancelGate = createDeferred();
    const closeRun = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        // 保持 read pending，测试 cancel 的底层清理 Promise 不参与主流程结算。
      },
      cancel() {
        return cancelGate.promise;
      },
    });
    const reading = readSearchEventStream({
      response: createResponse(stream),
      signal: controller.signal,
      onEvent: vi.fn(),
      closeRun,
    });

    controller.abort(reason);

    expect(closeRun).toHaveBeenCalledOnce();
    await expect(reading).rejects.toBe(reason);
    expect(stream.locked).toBe(false);
    cancelGate.resolve();
  });

  it("pending read 期间取消时原样传播 reason 并及时解锁", async () => {
    const controller = new AbortController();
    const reason = new DOMException("用户开始了新查询", "AbortError");
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        // 保持 read pending，Abort listener 必须主动 cancel Reader 才能结束。
      },
    });
    const closeRun = vi.fn();
    const reading = readSearchEventStream({
      response: createResponse(stream),
      signal: controller.signal,
      onEvent: vi.fn(),
      closeRun,
    });

    controller.abort(reason);

    await expect(reading).rejects.toBe(reason);
    expect(closeRun).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("旧 Reader 的关闭钩子不会关闭已启动的新 Run", async () => {
    const store = createGraphStore();
    store.getState().startRun({ runId: "old-run", query: "old" });
    const closeOldRun = closeActiveRun(store, "old-run");
    store.getState().startRun({ runId: "new-run", query: "new" });

    await readSearchEventStream({
      response: createResponse(streamChunks([])),
      onEvent: vi.fn(),
      closeRun: closeOldRun,
    });

    expect(closeOldRun).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      activeRunId: "new-run",
      query: "new",
      isSearching: true,
    });
  });

  it("无业务终态的 clean EOF 只结束当前加载并保留已有 UI 状态", async () => {
    const store = createGraphStore();
    const runId = pythonResultGraphFixture.runId;
    const selectedNodeId = pythonResultGraphFixture.graph.nodes[0]?.id ?? null;
    store.getState().startRun({
      runId,
      query: pythonResultGraphFixture.query.raw,
    });
    store.getState().setGraph(pythonResultGraphFixture.graph);
    store.getState().selectNode(selectedNodeId);
    store.getState().setLastSequence(7);

    await readSearchEventStream({
      response: createResponse(streamChunks([])),
      onEvent: vi.fn(),
      closeRun: closeActiveRun(store, runId),
    });

    expect(store.getState()).toMatchObject({
      activeRunId: runId,
      query: pythonResultGraphFixture.query.raw,
      nodes: pythonResultGraphFixture.graph.nodes,
      edges: pythonResultGraphFixture.graph.edges,
      selectedNodeId,
      lastSequence: 7,
      isSearching: false,
    });
  });
});
