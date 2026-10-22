/**
 * 测试职责：冻结 WAY-68 的 Envelope 分配、FIFO 写入与 closed Guard 竞态。
 *
 * 本文件不判断 Analysis/Plan 顺序、Node exactly-once 或终态生成条件；这些分别属于
 * WAY-69/70。所有测试使用内存 Sink 与显式 Deferred，不访问网络或真实 Provider。
 */
import {
  StreamEventSchema,
  type QueryAnalysis,
  type StreamEvent,
  type StreamEventPayload,
} from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createDeferred,
  createFixedClock,
} from "../../../../tests/support/test-infrastructure.mjs";
import { createRunEventWriter } from "./run-event-writer.js";

function statusPayload(
  status: "planned" | "searching" | "filtering" = "searching",
): Extract<StreamEventPayload, { type: "node.status" }> {
  return { type: "node.status", nodeId: "node-a", status };
}

function runFailedPayload(): Extract<
  StreamEventPayload,
  { type: "run.failed" }
> {
  return {
    type: "run.failed",
    error: { code: "PLANNER_FAILED", retryable: true },
  };
}

function completePayload(): Extract<
  StreamEventPayload,
  { type: "complete" }
> {
  const analysis: QueryAnalysis = {
    intent: "learn",
    topic: "TypeScript",
    freshnessSensitive: false,
    ambiguityLevel: "low",
    broadSearchQueries: [],
    strategy: "plan_first",
    presentationMode: "compact",
  };
  return {
    type: "complete",
    data: {
      finalStatus: "partial",
      result: {
        version: "0.1",
        runId: "run-68",
        query: {
          raw: "TypeScript",
          normalized: "typescript",
          language: "zh-CN",
        },
        analysis,
        graph: {
          nodes: [
            {
              id: "node-a",
              title: "TypeScript",
              description: "学习 TypeScript",
              nodeType: "primary",
              layer: 0,
              searchPlan: {
                queries: ["TypeScript"],
                maxResults: 20,
                rankingProfile: "knowledge",
                providerHints: ["general"],
              },
              status: "failed",
              resources: [],
              warnings: [],
              error: { code: "SEARCH_PROVIDER_FAILED", retryable: true },
            },
          ],
          edges: [],
        },
        meta: {
          createdAt: "2026-10-22T08:00:00.000Z",
          providersUsed: ["fake-search"],
          partial: true,
          timingMs: { total: 1 },
        },
      },
    },
  };
}

describe("createRunEventWriter", () => {
  it("为每个已接受 Payload 分配同一 Run 的连续 Envelope", async () => {
    const clock = createFixedClock("2026-10-22T08:00:00.000Z");
    const events: StreamEvent[] = [];
    const writer = createRunEventWriter({
      runId: "run-68",
      connectionSignal: new AbortController().signal,
      now: clock.now,
      writeEvent: async event => {
        events.push(structuredClone(event));
      },
    });

    await writer.emit(statusPayload("planned"));
    clock.advanceBy(5);
    await writer.emit(statusPayload("searching"));
    // 墙上时钟不要求随 sequence 严格递增；同毫秒事件仍然合法。
    await writer.emit(statusPayload("filtering"));
    await writer.close();

    expect(events.map(event => event.runId)).toEqual([
      "run-68",
      "run-68",
      "run-68",
    ]);
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3]);
    expect(events.map(event => event.protocolVersion)).toEqual([
      "0.1",
      "0.1",
      "0.1",
    ]);
    expect(events.map(event => event.timestamp)).toEqual([
      "2026-10-22T08:00:00.000Z",
      "2026-10-22T08:00:00.005Z",
      "2026-10-22T08:00:00.005Z",
    ]);
    expect(events.every(event => StreamEventSchema.safeParse(event).success))
      .toBe(true);
  });

  it("以 FIFO 单写队列等待背压，close 也会等待全部已接受事件", async () => {
    const gates = [
      createDeferred<void>(),
      createDeferred<void>(),
      createDeferred<void>(),
    ];
    const events: StreamEvent[] = [];
    let activeWrites = 0;
    let peakWrites = 0;
    const writer = createRunEventWriter({
      runId: "run-68",
      connectionSignal: new AbortController().signal,
      writeEvent: async event => {
        events.push(event);
        activeWrites += 1;
        peakWrites = Math.max(peakWrites, activeWrites);
        await gates[event.sequence - 1]!.promise;
        activeWrites -= 1;
      },
    });

    const emissions = [
      writer.emit(statusPayload("planned")),
      writer.emit(statusPayload("searching")),
      writer.emit(statusPayload("filtering")),
    ];
    let closeSettled = false;
    const closing = writer.close().finally(() => {
      closeSettled = true;
    });

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(closeSettled).toBe(false);
    gates[0]!.resolve();
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(closeSettled).toBe(false);
    gates[1]!.resolve();
    await vi.waitFor(() => expect(events).toHaveLength(3));
    gates[2]!.resolve();

    await Promise.all([...emissions, closing]);
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3]);
    expect(peakWrites).toBe(1);
    expect(closeSettled).toBe(true);
  });

  it.each([
    ["complete", completePayload(), runFailedPayload()],
    ["run.failed", runFailedPayload(), completePayload()],
  ] as const)(
    "%s 一经接纳便成为最后一个事件，同时保留此前 FIFO",
    async (_name, terminal, competingTerminal) => {
      const firstGate = createDeferred<void>();
      const terminalGate = createDeferred<void>();
      const events: StreamEvent[] = [];
      const writer = createRunEventWriter({
        runId: "run-68",
        connectionSignal: new AbortController().signal,
        writeEvent: async event => {
          events.push(event);
          if (event.sequence === 1) await firstGate.promise;
          if (event.sequence === 2) await terminalGate.promise;
        },
      });

      const first = writer.emit(statusPayload("searching"));
      const terminalWrite = writer.emit(terminal);
      const late = writer.emit(statusPayload("filtering"));
      const competing = writer.emit(competingTerminal);

      await vi.waitFor(() => expect(events).toHaveLength(1));
      await expect(late).resolves.toBeUndefined();
      await expect(competing).resolves.toBeUndefined();
      firstGate.resolve();
      await vi.waitFor(() => expect(events).toHaveLength(2));
      expect(events[1]?.type).toBe(terminal.type);
      terminalGate.resolve();

      await Promise.all([first, terminalWrite, writer.close()]);
      expect(events.map(event => event.sequence)).toEqual([1, 2]);
    },
  );

  it("连接关闭会跳过已排队但尚未开始的事件，并保持重复关闭安全", async () => {
    const controller = new AbortController();
    const firstGate = createDeferred<void>();
    const events: StreamEvent[] = [];
    const writer = createRunEventWriter({
      runId: "run-68",
      connectionSignal: controller.signal,
      writeEvent: async event => {
        events.push(event);
        await firstGate.promise;
      },
    });

    const first = writer.emit(statusPayload("searching"));
    const queued = writer.emit(statusPayload("filtering"));
    const queuedTerminal = writer.emit(runFailedPayload());
    await vi.waitFor(() => expect(events).toHaveLength(1));

    controller.abort(new Error("client disconnected"));
    await expect(writer.emit(statusPayload("planned"))).resolves.toBeUndefined();
    firstGate.resolve();

    await Promise.all([first, queued, queuedTerminal]);
    await expect(writer.close()).resolves.toBeUndefined();
    await expect(writer.close()).resolves.toBeUndefined();
    expect(events).toHaveLength(1);
  });

  it("不依赖 AbortSignal，终态后安全丢弃忽略取消的 Provider 迟到结果", async () => {
    const lateProvider = createDeferred<StreamEventPayload>();
    const controller = new AbortController();
    const events: StreamEvent[] = [];
    const writer = createRunEventWriter({
      runId: "run-68",
      connectionSignal: controller.signal,
      writeEvent: async event => {
        events.push(event);
      },
    });
    const lateContinuation = lateProvider.promise.then(writer.emit);

    await writer.emit(runFailedPayload());
    lateProvider.resolve(statusPayload("filtering"));
    await expect(lateContinuation).resolves.toBeUndefined();
    await writer.close();

    expect(controller.signal.aborted).toBe(false);
    expect(events.map(event => event.type)).toEqual(["run.failed"]);
  });

  it("首次 Sink 失败保留原错误，并阻止已排队与后续事件继续写入", async () => {
    const failure = new Error("stream sink failed");
    const firstStarted = createDeferred<void>();
    const releaseFailure = createDeferred<void>();
    const events: StreamEvent[] = [];
    const writer = createRunEventWriter({
      runId: "run-68",
      connectionSignal: new AbortController().signal,
      writeEvent: async event => {
        events.push(event);
        firstStarted.resolve();
        await releaseFailure.promise;
        throw failure;
      },
    });

    const first = writer.emit(statusPayload("searching"));
    const firstObserved = expect(first).rejects.toBe(failure);
    const queued = writer.emit(statusPayload("filtering"));
    await firstStarted.promise;
    releaseFailure.resolve();

    await firstObserved;
    await expect(queued).resolves.toBeUndefined();
    await expect(writer.emit(statusPayload("planned"))).resolves.toBeUndefined();
    await expect(writer.close()).rejects.toBe(failure);
    expect(events).toHaveLength(1);
  });

  it("非法 Payload 不写入且不消耗下一条合法事件的 sequence", async () => {
    const events: StreamEvent[] = [];
    const writer = createRunEventWriter({
      runId: "run-68",
      connectionSignal: new AbortController().signal,
      writeEvent: async event => {
        events.push(event);
      },
    });

    expect(() =>
      writer.emit({ type: "node.status", nodeId: "", status: "searching" }),
    ).toThrow();
    await writer.emit(statusPayload());
    await writer.close();

    expect(events.map(event => event.sequence)).toEqual([1]);
  });
});
