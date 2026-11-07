/**
 * 测试职责：冻结 HTTP/NDJSON 传输边界，并覆盖 Run Event Writer 的 Route 接线。
 * 业务事件顺序、Node exactly-once 与 Run 终态由 Orchestrator 负责。
 */
import { request as requestHttp, type IncomingMessage } from "node:http";
import { Writable } from "node:stream";

import {
  StreamEventSchema,
  type StreamEvent,
  type StreamEventPayload,
} from "@wayfinder/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  registerSearchRoute,
  writeNdjsonEvent,
  type SearchStreamHandler,
} from "./search.js";

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}>;

function createDeferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] = () => undefined;
  let reject: Deferred<T>["reject"] = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createStatusPayload(
  status: "planned" | "searching" | "filtering" = "searching",
): Extract<StreamEventPayload, { type: "node.status" }> {
  return { type: "node.status", nodeId: "node-a", status };
}

function createStatusEvent(
  sequence: number,
  status: "planned" | "searching" | "filtering" = "searching",
): StreamEvent {
  return StreamEventSchema.parse({
    runId: "run-67",
    sequence,
    protocolVersion: "0.1",
    timestamp: `2026-10-22T08:00:0${sequence}Z`,
    ...createStatusPayload(status),
  });
}

function createRunFailedPayload(): Extract<
  StreamEventPayload,
  { type: "run.failed" }
> {
  return {
    type: "run.failed",
    error: { code: "PLANNER_FAILED", retryable: true },
  };
}

function createServer(handleSearch: SearchStreamHandler): FastifyInstance {
  const server = Fastify({ logger: false });
  registerSearchRoute(server, handleSearch);
  return server;
}

it("凭据准备期间客户端断连，不发送流式200或启动迟到的处理器", async () => {
  const server = Fastify({ logger: false });
  const entered = createDeferred<AbortSignal>();
  const release = createDeferred<void>();
  const finished = createDeferred<void>();
  let handled = 0;
  registerSearchRoute(server, { prepare: async (_request, signal) => {
    entered.resolve(signal);
    await release.promise;
    finished.resolve();
    return async () => { handled += 1; };
  } });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  const opened = openSearchRequest(address);
  // 主动断连会拒绝客户端响应Promise；先接管拒绝，避免把预期取消变成未处理异常。
  const response = opened.response.catch(() => undefined);
  try {
    const signal = await entered.promise;
    const aborted = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    opened.request.destroy();
    await aborted;
    release.resolve();
    await finished.promise;
    await response;
    expect(signal.aborted).toBe(true);
    expect(handled).toBe(0);
  } finally {
    release.resolve();
    opened.request.destroy();
    await server.close();
  }
});

function parseNdjson(body: string): StreamEvent[] {
  expect(body.endsWith("\n")).toBe(true);
  expect(body).not.toContain("data:");
  const lines = body.split("\n");
  expect(lines.pop()).toBe("");
  expect(lines.every(line => line.length > 0)).toBe(true);
  return lines.map(line => StreamEventSchema.parse(JSON.parse(line)));
}

type OpenRequest = Readonly<{
  request: ReturnType<typeof requestHttp>;
  response: Promise<IncomingMessage>;
}>;

/** 使用临时端口发送真实请求，覆盖 inject 无法模拟的渐进读取与 Response 断连。 */
function openSearchRequest(address: string): OpenRequest {
  const payload = JSON.stringify({
    runId: "run-67",
    query: "TypeScript",
    language: "zh-CN",
  });
  let resolveResponse: (response: IncomingMessage) => void = () => undefined;
  let rejectResponse: (reason?: unknown) => void = () => undefined;
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const clientRequest = requestHttp(
    `${address}/api/search`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    },
    resolveResponse,
  );
  clientRequest.once("error", rejectResponse);
  clientRequest.end(payload);
  return { request: clientRequest, response };
}

type ObservedNdjsonResponse = Readonly<{
  chunks: string[];
  firstLine: Promise<StreamEvent>;
}>;

/**
 * 测试辅助：累计网络 Chunk 直到首个 LF，再校验完整事件。
 * HTTP 可在任意字节处分片，因此不能把第一次 data 回调等同于一条 NDJSON。
 */
function observeFirstNdjsonLine(
  response: IncomingMessage,
): ObservedNdjsonResponse {
  const chunks: string[] = [];
  let buffer = "";
  const firstLine = new Promise<StreamEvent>((resolve, reject) => {
    let settled = false;
    const cleanupTerminalListeners = (): void => {
      response.removeListener("error", onError);
      response.removeListener("aborted", onPrematureEnd);
      response.removeListener("end", onPrematureEnd);
      response.removeListener("close", onPrematureEnd);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanupTerminalListeners();
      reject(error);
    };
    const onError = (error: Error): void => rejectOnce(error);
    const onPrematureEnd = (): void => {
      rejectOnce(new Error("首条 NDJSON 完成前响应已关闭"));
    };

    response.on("data", (chunk: string) => {
      chunks.push(chunk);
      if (settled) return;
      buffer += chunk;
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd < 0) return;

      try {
        const event = StreamEventSchema.parse(
          JSON.parse(buffer.slice(0, lineEnd)),
        );
        settled = true;
        cleanupTerminalListeners();
        resolve(event);
      } catch (error: unknown) {
        rejectOnce(
          error instanceof Error ? error : new Error("首条 NDJSON 无法解析"),
        );
      }
    });
    response.once("error", onError);
    response.once("aborted", onPrematureEnd);
    response.once("end", onPrematureEnd);
    response.once("close", onPrematureEnd);
  });
  return { chunks, firstLine };
}

describe("registerSearchRoute", () => {
  it.each([
    ["空 Query", { runId: "run-67", query: "   ", language: "zh-CN" }],
    ["缺失 language", { runId: "run-67", query: "TypeScript" }],
    [
      "未支持 language",
      { runId: "run-67", query: "TypeScript", language: "en" },
    ],
    [
      "未知字段",
      { runId: "run-67", query: "TypeScript", language: "zh-CN", debug: true },
    ],
  ])("%s 在 Streaming Header 前返回普通 400", async (_name, payload) => {
    const handleSearch = vi.fn<SearchStreamHandler>();
    const server = createServer(handleSearch);

    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/search",
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers["content-type"] ?? "").not.toContain(
        "application/x-ndjson",
      );
      expect(response.headers["x-accel-buffering"]).toBeUndefined();
      expect(handleSearch).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("设置防缓冲 Header，并把完整事件序列化为一行一个 JSON", async () => {
    let observedSignal: AbortSignal | undefined;
    const handleSearch: SearchStreamHandler = async ({
      input,
      signal,
      emit,
    }) => {
      expect(input).toEqual({
        runId: "run-67",
        query: "TypeScript",
        language: "zh-CN",
      });
      observedSignal = signal;
      await emit(createStatusPayload("searching"));
      await emit(createStatusPayload("filtering"));
    };
    const server = createServer(handleSearch);

    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/search",
        payload: {
          runId: "run-67",
          query: "  TypeScript  ",
          language: "zh-CN",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(
        "application/x-ndjson; charset=utf-8",
      );
      expect(response.headers["cache-control"]).toBe(
        "no-cache, no-transform",
      );
      expect(response.headers["x-accel-buffering"]).toBe("no");
      expect(response.headers["content-length"]).toBeUndefined();
      const events = parseNdjson(response.body);
      expect(events[0]).toMatchObject({
        runId: "run-67",
        sequence: 1,
        protocolVersion: "0.1",
        ...createStatusPayload("searching"),
      });
      expect(events[1]).toMatchObject({
        runId: "run-67",
        sequence: 2,
        protocolVersion: "0.1",
        ...createStatusPayload("filtering"),
      });
      expect(observedSignal?.aborted).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("上层写入 run.failed 后正常 resolve，Route 只结束流而不追加第二个事件", async () => {
    const payload = createRunFailedPayload();
    const server = createServer(async ({ emit }) => {
      await emit(payload);
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/search",
        payload: { runId: "run-67", query: "TypeScript", language: "zh-CN" },
      });

      expect(response.statusCode).toBe(200);
      const events = parseNdjson(response.body);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        runId: "run-67",
        sequence: 1,
        protocolVersion: "0.1",
        ...payload,
      });
    } finally {
      await server.close();
    }
  });

  it("Header 前的 Fastify 服务端错误保持普通 500，不产生半截 NDJSON", async () => {
    const handleSearch = vi.fn<SearchStreamHandler>();
    const server = Fastify({ logger: false });
    server.addHook("preHandler", async () => {
      throw new Error("pre-header failure");
    });
    registerSearchRoute(server, handleSearch);

    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/search",
        payload: { runId: "run-67", query: "TypeScript", language: "zh-CN" },
      });

      expect(response.statusCode).toBe(500);
      expect(response.headers["content-type"] ?? "").not.toContain(
        "application/x-ndjson",
      );
      expect(response.headers["x-accel-buffering"]).toBeUndefined();
      expect(handleSearch).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("hijack 后 Header 提交异常会销毁连接且不调用 Handler", async () => {
    const handleSearch = vi.fn<SearchStreamHandler>();
    const server = Fastify({ logger: false });
    server.addHook("preHandler", async (_request, reply) => {
      reply.raw.flushHeaders = () => {
        throw new Error("header setup failure");
      };
    });
    registerSearchRoute(server, handleSearch);
    let opened: OpenRequest | undefined;

    try {
      const address = await server.listen({ host: "127.0.0.1", port: 0 });
      opened = openSearchRequest(address);

      await expect(opened.response).rejects.toBeInstanceOf(Error);
      expect(handleSearch).not.toHaveBeenCalled();
    } finally {
      opened?.request.destroy();
      await server.close();
    }
  });

  it("客户端在 Header 前断开时不会启动 Handler", async () => {
    const hookEntered = createDeferred<void>();
    const releaseHook = createDeferred<void>();
    const serverObservedClose = createDeferred<void>();
    const handleSearch = vi.fn<SearchStreamHandler>();
    const server = Fastify({ logger: false });
    server.addHook("preHandler", async (_request, reply) => {
      reply.raw.once("close", () => serverObservedClose.resolve());
      hookEntered.resolve();
      await releaseHook.promise;
    });
    registerSearchRoute(server, handleSearch);
    let opened: OpenRequest | undefined;

    try {
      const address = await server.listen({ host: "127.0.0.1", port: 0 });
      opened = openSearchRequest(address);
      // 预先挂接拒绝处理，避免主动断开与后续 await 之间出现未处理 Promise。
      const responseSettled = opened.response.catch(() => undefined);
      await hookEntered.promise;

      opened.request.destroy();
      await serverObservedClose.promise;
      releaseHook.resolve();
      await responseSettled;
    } finally {
      releaseHook.resolve();
      opened?.request.destroy();
      await server.close();
    }

    expect(handleSearch).not.toHaveBeenCalled();
  });

  it("真实连接在 Handler 完成前即可读取首个 NDJSON Chunk", async () => {
    const releaseHandler = createDeferred<void>();
    const handlerFinished = createDeferred<void>();
    const server = createServer(async ({ emit }) => {
      await emit(createStatusPayload());
      await releaseHandler.promise;
      await emit(createStatusPayload("filtering"));
      handlerFinished.resolve();
    });
    let opened: OpenRequest | undefined;
    let response: IncomingMessage | undefined;

    try {
      const address = await server.listen({ host: "127.0.0.1", port: 0 });
      opened = openSearchRequest(address);
      response = await opened.response;
      response.setEncoding("utf8");
      const observed = observeFirstNdjsonLine(response);

      expect(await observed.firstLine).toMatchObject({
        runId: "run-67",
        sequence: 1,
        ...createStatusPayload(),
      });
      expect(response.complete).toBe(false);

      // 必须先监听终止事件，再释放 Handler，避免同步 end() 造成漏接。
      const responseEnded = new Promise<void>((resolve, reject) => {
        response?.once("end", resolve);
        response?.once("error", reject);
        response?.once("aborted", () => reject(new Error("响应意外中止")));
      });
      releaseHandler.resolve();
      await handlerFinished.promise;
      await responseEnded;

      expect(parseNdjson(observed.chunks.join(""))).toHaveLength(2);
    } finally {
      releaseHandler.resolve();
      response?.destroy();
      opened?.request.destroy();
      await server.close();
    }
  });

  it("真实客户端断开会关闭 Writer，并安全丢弃忽略取消的迟到事件", async () => {
    const signalAborted = createDeferred<void>();
    const lateEmitSettled = createDeferred<void>();
    let observedSignal: AbortSignal | undefined;
    let lateEmitError: unknown;
    const server = createServer(async ({ signal, emit }) => {
      observedSignal = signal;
      await new Promise<void>(resolve => {
        signal.addEventListener(
          "abort",
          () => {
            signalAborted.resolve();
            resolve();
          },
          { once: true },
        );
      });
      // 模拟忽略取消、仍然迟到返回的 Provider；closed Guard 必须让 Emit 安全完成。
      try {
        await emit(createStatusPayload("filtering"));
      } catch (error: unknown) {
        lateEmitError = error;
      } finally {
        lateEmitSettled.resolve();
      }
    });
    let opened: OpenRequest | undefined;
    let response: IncomingMessage | undefined;

    try {
      const address = await server.listen({ host: "127.0.0.1", port: 0 });
      opened = openSearchRequest(address);
      response = await opened.response;
      response.once("error", () => undefined);
      response.destroy();

      await signalAborted.promise;
      await lateEmitSettled.promise;
      expect(observedSignal?.aborted).toBe(true);
      expect(lateEmitError).toBeUndefined();
    } finally {
      response?.destroy();
      opened?.request.destroy();
      await server.close();
    }
  });

  it("Header 后的未知服务端错误销毁不完整流，不拼接 Fastify JSON", async () => {
    const releaseFailure = createDeferred<void>();
    const firstPayload = createStatusPayload();
    const server = createServer(async ({ emit }) => {
      await emit(firstPayload);
      await releaseFailure.promise;
      throw new Error("post-header failure");
    });
    let opened: OpenRequest | undefined;
    let response: IncomingMessage | undefined;

    try {
      const address = await server.listen({ host: "127.0.0.1", port: 0 });
      opened = openSearchRequest(address);
      response = await opened.response;
      response.setEncoding("utf8");
      const observed = observeFirstNdjsonLine(response);
      const activeResponse = response;
      const responseClosed = new Promise<void>(resolve => {
        activeResponse.once("aborted", resolve);
        activeResponse.once("end", resolve);
        activeResponse.once("close", resolve);
        activeResponse.once("error", resolve);
      });

      expect(await observed.firstLine).toMatchObject({
        runId: "run-67",
        sequence: 1,
        ...firstPayload,
      });
      releaseFailure.resolve();
      await responseClosed;

      const events = parseNdjson(observed.chunks.join(""));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        runId: "run-67",
        sequence: 1,
        ...firstPayload,
      });
      expect(response.complete).toBe(false);
    } finally {
      releaseFailure.resolve();
      response?.destroy();
      opened?.request.destroy();
      await server.close();
    }
  });
});

describe("writeNdjsonEvent", () => {
  it("写缓冲区已满时等待 drain 后再完成", async () => {
    const chunks: string[] = [];
    let releaseWrite: (() => void) | undefined;
    const response = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        releaseWrite = callback;
      },
    });
    const event = createStatusEvent(1);

    const writing = writeNdjsonEvent(
      response,
      new AbortController().signal,
      event,
    );

    expect(response.listenerCount("drain")).toBe(1);
    releaseWrite?.();
    await writing;

    expect(chunks).toEqual([`${JSON.stringify(event)}\n`]);
    expect(response.listenerCount("drain")).toBe(0);
    response.destroy();
  });

  it("等待 drain 时收到取消会拒绝并移除监听器", async () => {
    let releaseWrite: (() => void) | undefined;
    const response = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        releaseWrite = callback;
      },
    });
    const controller = new AbortController();
    const reason = new Error("client disconnected");

    const writing = writeNdjsonEvent(
      response,
      controller.signal,
      createStatusEvent(1),
    );
    expect(response.listenerCount("drain")).toBe(1);

    controller.abort(reason);
    await expect(writing).rejects.toMatchObject({
      name: "AbortError",
      cause: reason,
    });
    expect(response.listenerCount("drain")).toBe(0);

    releaseWrite?.();
    response.destroy();
  });
});
