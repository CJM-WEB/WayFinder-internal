/**
 * 集成测试职责：覆盖 D1 Mock Product 从合法 Stream 到可安全打开 Resource 的完整纵切。
 *
 * 范围边界：不挂载真实 DOM、不启动 Server、不读取 Secret，也不调用网络；
 * 后续真实 Stream reader（流读取器）与乱序状态机不在 WAY-33 提前实现。
 */
import { StreamEventSchema } from "@wayfinder/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFixedClock } from "../../../tests/support/test-infrastructure.mjs";
import { buildGraphFlowElements } from "./components/Graph/graph-layout.js";
import { buildResourcePanelModel } from "./components/ResourcePanel/ResourcePanel.js";
import { requestResourceOpen } from "./components/ResourcePanel/resource-url.js";
import {
  createGraphStore,
  selectSelectedNode,
} from "./stores/graph-store.js";
import { createPythonMockStream } from "./testing/python-mock-stream.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("D1 Mock Product happy path", () => {
  it("从连贯 Stream 构建 Graph、自由选择 Node 并显式安全打开 Resource", () => {
    const clock = createFixedClock("2026-01-01T00:00:00.000Z");
    const events = createPythonMockStream(clock);
    const parsedEvents = events.map(event => StreamEventSchema.parse(event));
    const opener = vi.fn(() => null);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Mock Product 测试禁止访问网络");
    });

    expect(parsedEvents.map(event => event.sequence)).toEqual(
      parsedEvents.map((_, index) => index + 1),
    );
    expect(new Set(parsedEvents.map(event => event.runId))).toEqual(
      new Set(["run-mock-python"]),
    );
    expect(parsedEvents.at(-1)?.type).toBe("complete");

    const terminalNodeIds = parsedEvents.flatMap(event =>
      event.type === "node.ready" ||
      event.type === "node.partial" ||
      event.type === "node.failed"
        ? [event.nodeId]
        : [],
    );
    expect(terminalNodeIds).toHaveLength(new Set(terminalNodeIds).size);

    const completeEvent = parsedEvents.at(-1);
    if (completeEvent?.type !== "complete") {
      throw new Error("Python Mock Stream 必须以 complete 结束");
    }

    const result = completeEvent.data.result;
    const store = createGraphStore();

    store.getState().startRun({
      runId: result.runId,
      query: result.query.raw,
    });
    store.getState().setGraph(result.graph);
    store.getState().finishRun();

    const flow = buildGraphFlowElements(
      store.getState().nodes,
      store.getState().edges,
    );
    expect(flow.nodes).toHaveLength(4);
    expect(flow.edges).toHaveLength(3);

    // 直接选择第三个主路径 Node，证明用户不必沿箭头顺序浏览。
    const targetFlowNode = flow.nodes.find(
      node => node.id === "python-basics",
    );
    if (targetFlowNode === undefined) {
      throw new Error("Python Mock Product 缺少基础语法节点");
    }

    store.getState().selectNode(targetFlowNode.id);
    expect(store.getState().selectedNodeId).toBe("python-basics");

    const selectedNode = selectSelectedNode(store.getState());
    if (selectedNode === null) {
      throw new Error("Store selector 未返回已选择的节点");
    }

    const panel = buildResourcePanelModel(selectedNode);
    if (panel.kind !== "selected" || panel.resources[0] === undefined) {
      throw new Error("已选择的 ready Node 必须提供 Resource");
    }

    expect(opener).not.toHaveBeenCalled();
    expect(requestResourceOpen(panel.resources[0].url, opener)).toBe(true);
    expect(opener).toHaveBeenCalledExactlyOnceWith(
      "https://docs.python.org/3/tutorial/",
      "_blank",
      "noopener,noreferrer",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toMatch(
      /api[_-]?key|authorization|bearer\s|cookie|client[_-]?secret/i,
    );
  });
});
