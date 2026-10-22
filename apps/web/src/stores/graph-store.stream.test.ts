/**
 * 测试职责：冻结 StreamEvent Reducer 的 Run、sequence 与终态门禁。
 *
 * 关键约束：合法事件的业务效果和 sequence 只能原子提交一次；旧 Run、重复、
 * 倒序、已关闭 Run 与不一致最终快照必须保持完整 Store 状态不变。
 */
import {
  StreamEventSchema,
  type StreamEvent,
} from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import { pythonResultGraphFixture } from "../fixtures/python-result-graph.js";
import { createPythonMockStream } from "../testing/python-mock-stream.js";
import { createGraphStore } from "./graph-store.js";

const mockEvents = createPythonMockStream({
  now: () => Date.parse("2026-10-22T00:00:00.000Z"),
});
const runId = pythonResultGraphFixture.runId;

const eventOfType = <Type extends StreamEvent["type"]>(
  type: Type,
): Extract<StreamEvent, { type: Type }> => {
  const event = mockEvents.find(candidate => candidate.type === type);
  if (!event) throw new Error(`Mock Stream 缺少 ${type} 事件`);
  return event as Extract<StreamEvent, { type: Type }>;
};

const runFailedEvent = StreamEventSchema.parse({
  runId,
  sequence: 99,
  protocolVersion: "0.1",
  timestamp: "2026-10-22T00:00:00.000Z",
  type: "run.failed",
  error: { code: "UNKNOWN", retryable: false },
});

const everyEventType = [
  eventOfType("query.analysis"),
  eventOfType("graph.plan"),
  eventOfType("node.status"),
  eventOfType("node.ready"),
  eventOfType("node.partial"),
  eventOfType("node.failed"),
  eventOfType("complete"),
  runFailedEvent,
] as const;

const replaceEnvelope = (
  event: StreamEvent,
  envelope: Partial<Pick<StreamEvent, "runId" | "sequence">>,
): StreamEvent => StreamEventSchema.parse({ ...event, ...envelope });

const createActiveStore = () => {
  const store = createGraphStore();
  store.getState().startRun({
    runId,
    query: pythonResultGraphFixture.query.raw,
  });
  return store;
};

describe("Graph store StreamEvent Reducer", () => {
  it.each(everyEventType)(
    "旧 Run 的 $type 不改变状态或通知订阅者",
    event => {
      const store = createActiveStore();
      const before = store.getState();
      const subscriber = vi.fn();
      store.subscribe(subscriber);

      store.getState().applyStreamEvent(
        replaceEnvelope(event, { runId: "stale-run", sequence: 200 }),
      );

      expect(store.getState()).toBe(before);
      expect(subscriber).not.toHaveBeenCalled();
    },
  );

  it.each(everyEventType)(
    "$type 的重复与倒序 sequence 均被完整丢弃",
    event => {
      const store = createActiveStore();
      store.getState().applyStreamEvent(
        replaceEnvelope(eventOfType("query.analysis"), { sequence: 50 }),
      );
      const before = store.getState();
      const subscriber = vi.fn();
      store.subscribe(subscriber);

      store.getState().applyStreamEvent(
        replaceEnvelope(event, { sequence: 50 }),
      );
      store.getState().applyStreamEvent(
        replaceEnvelope(event, { sequence: 49 }),
      );

      expect(store.getState()).toBe(before);
      expect(subscriber).not.toHaveBeenCalled();
    },
  );

  it("允许 sequence 跳号，并把事件效果与游标原子通知一次", () => {
    const store = createActiveStore();
    const subscriber = vi.fn();
    store.subscribe(subscriber);

    store.getState().applyStreamEvent(
      replaceEnvelope(eventOfType("graph.plan"), { sequence: 3 }),
    );

    expect(store.getState()).toMatchObject({
      nodes: eventOfType("graph.plan").data.nodes,
      edges: eventOfType("graph.plan").data.edges,
      lastSequence: 3,
    });
    expect(subscriber).toHaveBeenCalledOnce();
    expect(subscriber.mock.calls[0]?.[0]).toMatchObject({
      nodes: eventOfType("graph.plan").data.nodes,
      lastSequence: 3,
    });
  });

  it("按完整 Mock Stream 逐步形成三个 Node 终态并以 complete 权威收敛", () => {
    const store = createActiveStore();
    const complete = eventOfType("complete");

    for (const event of mockEvents) {
      if (event.type === "complete") break;
      store.getState().applyStreamEvent(event);
    }

    expect(store.getState().nodes).toEqual(pythonResultGraphFixture.graph.nodes);
    expect(store.getState().nodes.find(node => node.status === "failed")).toMatchObject({
      resources: [],
      warnings: [],
      error: { code: "SEARCH_PROVIDER_FAILED", retryable: true },
    });
    expect(store.getState().isSearching).toBe(true);

    store.getState().applyStreamEvent(complete);

    expect(store.getState()).toMatchObject({
      nodes: pythonResultGraphFixture.graph.nodes,
      edges: pythonResultGraphFixture.graph.edges,
      lastSequence: complete.sequence,
      isSearching: false,
    });
  });

  it("未知 Node 与已终态 Node 不被猜造或覆盖，但仍消费新 sequence", () => {
    const store = createActiveStore();
    const plan = eventOfType("graph.plan");
    const ready = eventOfType("node.ready");

    store.getState().applyStreamEvent(plan);
    store.getState().applyStreamEvent(eventOfType("node.status"));
    store.getState().applyStreamEvent(ready);
    const terminalNode = store.getState().nodes.find(
      node => node.id === ready.nodeId,
    );

    const unknownNodeEvent = StreamEventSchema.parse({
      ...eventOfType("node.status"),
      nodeId: "unknown-node",
      sequence: ready.sequence + 1,
    });
    const lateStatusEvent = StreamEventSchema.parse({
      ...eventOfType("node.status"),
      nodeId: ready.nodeId,
      sequence: ready.sequence + 2,
    });
    store.getState().applyStreamEvent(unknownNodeEvent);
    store.getState().applyStreamEvent(lateStatusEvent);

    expect(store.getState().nodes).toHaveLength(plan.data.nodes.length);
    expect(
      store.getState().nodes.find(node => node.id === ready.nodeId),
    ).toBe(terminalNode);
    expect(store.getState().lastSequence).toBe(lateStatusEvent.sequence);
  });

  it("迟到的第二个 graph.plan 不会把已经终态的 Node 重置", () => {
    const store = createActiveStore();
    const ready = eventOfType("node.ready");

    store.getState().applyStreamEvent(eventOfType("graph.plan"));
    store.getState().applyStreamEvent(eventOfType("node.status"));
    store.getState().applyStreamEvent(ready);
    const terminalNodes = store.getState().nodes;
    const repeatedPlan = replaceEnvelope(eventOfType("graph.plan"), {
      sequence: ready.sequence + 1,
    });

    store.getState().applyStreamEvent(repeatedPlan);

    expect(store.getState().nodes).toBe(terminalNodes);
    expect(store.getState().lastSequence).toBe(repeatedPlan.sequence);
  });

  it("complete 与 run.failed 都封闭 Run，之后所有事件保持状态不变", () => {
    const completeStore = createActiveStore();
    for (const event of mockEvents) completeStore.getState().applyStreamEvent(event);
    const completed = completeStore.getState();
    completeStore.getState().applyStreamEvent(
      replaceEnvelope(eventOfType("node.status"), {
        sequence: completed.lastSequence + 1,
      }),
    );
    expect(completeStore.getState()).toBe(completed);

    const failedStore = createActiveStore();
    failedStore.getState().applyStreamEvent(eventOfType("graph.plan"));
    const graphBeforeFailure = failedStore.getState().nodes;
    failedStore.getState().applyStreamEvent(runFailedEvent);
    const failed = failedStore.getState();
    failedStore.getState().applyStreamEvent(
      replaceEnvelope(eventOfType("query.analysis"), { sequence: 100 }),
    );

    expect(failed).toMatchObject({
      nodes: graphBeforeFailure,
      lastSequence: runFailedEvent.sequence,
      isSearching: false,
    });
    expect(failedStore.getState()).toBe(failed);
  });

  it.each([
    ["complete", eventOfType("complete")],
    ["run.failed", runFailedEvent],
  ] as const)("%s 原子提交终态快照且只通知一次", (_label, terminal) => {
    const store = createActiveStore();
    store.getState().applyStreamEvent(eventOfType("graph.plan"));
    const graphBeforeTerminal = store.getState().nodes;
    const subscriber = vi.fn();
    store.subscribe(subscriber);

    store.getState().applyStreamEvent(terminal);

    expect(subscriber).toHaveBeenCalledOnce();
    const observed = subscriber.mock.calls[0]?.[0];
    expect(observed).toMatchObject({
      lastSequence: terminal.sequence,
      isSearching: false,
      nodes:
        terminal.type === "complete"
          ? terminal.data.result.graph.nodes
          : graphBeforeTerminal,
    });
  });

  it("Reader 提前关闭后的迟到事件不依赖 AbortSignal 也无法写入", () => {
    const store = createActiveStore();
    store.getState().finishRun();
    const closed = store.getState();

    for (const event of everyEventType) {
      store.getState().applyStreamEvent(
        replaceEnvelope(event, { sequence: event.sequence + 200 }),
      );
    }

    expect(store.getState()).toBe(closed);
  });

  it("complete 的内外 Run 身份不一致时拒绝最终快照", () => {
    const store = createActiveStore();
    const complete = eventOfType("complete");
    const inconsistentComplete = StreamEventSchema.parse({
      ...complete,
      data: {
        ...complete.data,
        result: { ...complete.data.result, runId: "other-run" },
      },
    });
    const before = store.getState();

    store.getState().applyStreamEvent(inconsistentComplete);

    expect(store.getState()).toBe(before);
  });

  it("新 Run 重置封闭状态并重新接受 sequence 1", () => {
    const store = createActiveStore();
    store.getState().applyStreamEvent(runFailedEvent);

    store.getState().startRun({
      runId: "new-run",
      query: "new query",
    });
    store.getState().applyStreamEvent(
      replaceEnvelope(eventOfType("query.analysis"), {
        runId: "new-run",
        sequence: 1,
      }),
    );

    expect(store.getState()).toMatchObject({
      activeRunId: "new-run",
      query: "new query",
      nodes: [],
      isSearching: true,
      lastSequence: 1,
    });
  });

  it("计划与最终快照替换时仅保留仍存在的选择", () => {
    const store = createActiveStore();
    const plan = eventOfType("graph.plan");
    const complete = eventOfType("complete");
    const selectedNodeId = plan.data.nodes[0]?.id;
    if (!selectedNodeId) throw new Error("GraphPlan 缺少测试 Node");

    store.getState().applyStreamEvent(plan);
    store.getState().selectNode(selectedNodeId);
    store.getState().applyStreamEvent(complete);
    expect(store.getState().selectedNodeId).toBe(selectedNodeId);

    store.getState().startRun({ runId, query: "second run" });
    store.getState().selectNode("missing-node");
    store.getState().applyStreamEvent(plan);
    expect(store.getState().selectedNodeId).toBeNull();
  });
});
