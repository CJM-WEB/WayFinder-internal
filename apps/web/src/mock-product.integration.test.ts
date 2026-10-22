/**
 * 集成测试职责：覆盖 Mock Product 从渐进 Stream 到可安全打开 Resource 的前端纵切。
 *
 * 范围边界：只使用确定性 Mock Stream，不挂载真实 DOM、不启动 Server、不读取 Secret、
 * 不调用网络；真实 Reader、乱序、断连、Deadline 等由完整跨层矩阵覆盖。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamEventSchema } from "@wayfinder/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFixedClock } from "../../../tests/support/test-infrastructure.mjs";
import { buildGraphFlowElements } from "./components/Graph/graph-layout.js";
import { applySelectedNodeId } from "./components/Graph/graph-selection.js";
import {
  buildResourcePanelModel,
  ResourcePanelView,
} from "./components/ResourcePanel/ResourcePanel.js";
import { requestSafeUrlOpen } from "./lib/url.js";
import {
  createGraphStore,
  selectSelectedNode,
} from "./stores/graph-store.js";
import { createPythonMockStream } from "./testing/python-mock-stream.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Mock Product 前端纵切", () => {
  it("compact 首个可用 Node 只展开 Resource Panel，不自动打开网页", () => {
    const events = createPythonMockStream(
      createFixedClock("2026-01-01T00:00:00.000Z"),
    );
    const plan = events.find(event => event.type === "graph.plan");
    const ready = events.find(event => event.type === "node.ready");
    if (plan?.type !== "graph.plan" || ready?.type !== "node.ready") {
      throw new Error("Python Mock Stream 缺少 Compact 自动选择测试事件");
    }
    const compactPlan = StreamEventSchema.parse({
      ...plan,
      data: {
        ...plan.data,
        analysis: { ...plan.data.analysis, presentationMode: "compact" },
      },
    });
    if (compactPlan.type !== "graph.plan") {
      throw new Error("测试事件必须保持 graph.plan 类型");
    }
    const store = createGraphStore();
    const opener = vi.fn(() => null);

    store.getState().startRun({ runId: plan.runId, query: "Python" });
    store.getState().applyStreamEvent(compactPlan);
    store.getState().applyStreamEvent(ready);

    const panel = buildResourcePanelModel(selectSelectedNode(store.getState()));
    expect(panel).toMatchObject({
      kind: "selected",
      nodeId: ready.nodeId,
      nodeStatus: "ready",
    });
    const markup = renderToStaticMarkup(
      createElement(ResourcePanelView, { model: panel, openResource: opener }),
    );
    expect(markup).toContain(">Open</button>");
    expect(opener).not.toHaveBeenCalled();
  });

  it("plan 后立即显示 Draft，并让单 Node 失败不阻塞其他 Node", () => {
    const events = createPythonMockStream(
      createFixedClock("2026-01-01T00:00:00.000Z"),
    );
    const plan = events.find(event => event.type === "graph.plan");
    const ready = events.find(event => event.type === "node.ready");
    const searching = events.find(
      event => event.type === "node.status" && event.nodeId !== ready?.nodeId,
    );
    const failed = events.find(event => event.type === "node.failed");
    if (
      plan?.type !== "graph.plan" ||
      ready?.type !== "node.ready" ||
      searching?.type !== "node.status" ||
      failed?.type !== "node.failed"
    ) {
      throw new Error("Python Mock Stream 缺少渐进状态测试事件");
    }

    const store = createGraphStore();
    store.getState().startRun({ runId: plan.runId, query: "Python" });
    let draftAtNotification:
      | ReturnType<typeof buildGraphFlowElements>
      | undefined;
    const unsubscribe = store.subscribe((state, previousState) => {
      if (previousState.nodes.length === 0 && state.nodes.length > 0) {
        // 在 Store 的同一次同步通知中构建布局，证明 Draft 不等待 Effect、Node 终态或 complete。
        draftAtNotification = buildGraphFlowElements(state.nodes, state.edges);
      }
    });

    store.getState().applyStreamEvent(plan);
    unsubscribe();

    expect(draftAtNotification?.nodes.map(node => node.data.status)).toEqual(
      plan.data.nodes.map(() => "planned"),
    );
    expect(draftAtNotification?.nodes.map(node => node.id)).toEqual(
      plan.data.nodes.map(node => node.id),
    );
    expect(draftAtNotification?.edges.map(edge => edge.id)).toEqual(
      plan.data.edges.map(edge => edge.id),
    );
    expect(store.getState().isSearching).toBe(true);

    store.getState().applyStreamEvent(ready);
    store.getState().applyStreamEvent(searching);
    store.getState().selectNode(ready.nodeId);
    store.getState().applyStreamEvent(failed);

    const stateAfterFailure = store.getState();
    const nodeStatusById = new Map(
      stateAfterFailure.nodes.map(node => [node.id, node.status]),
    );
    expect(nodeStatusById.get(ready.nodeId)).toBe("ready");
    expect(nodeStatusById.get(searching.nodeId)).toBe("searching");
    expect(nodeStatusById.get(failed.nodeId)).toBe("failed");
    expect(stateAfterFailure.isSearching).toBe(true);
    expect(stateAfterFailure.selectedNodeId).toBe(ready.nodeId);

    const selectedFlowNodes = applySelectedNodeId(
      buildGraphFlowElements(
        stateAfterFailure.nodes,
        stateAfterFailure.edges,
      ).nodes,
      stateAfterFailure.selectedNodeId,
    );
    expect(
      selectedFlowNodes.filter(node => node.selected).map(node => node.id),
    ).toEqual([ready.nodeId]);

    const panel = buildResourcePanelModel(
      selectSelectedNode(stateAfterFailure),
    );
    expect(panel).toMatchObject({
      kind: "selected",
      nodeId: ready.nodeId,
      nodeStatus: "ready",
    });
    if (panel.kind !== "selected") {
      throw new Error("ready Node 应保持可浏览");
    }
    expect(panel.resources.length).toBeGreaterThan(0);

    // failed 之后仍可切换到其他 Node；单点失败不产生 Graph 级禁用。
    const plannedNode = stateAfterFailure.nodes.find(
      node => node.status === "planned",
    );
    expect(plannedNode).toBeDefined();
    store.getState().selectNode(plannedNode?.id ?? null);
    expect(store.getState().selectedNodeId).toBe(plannedNode?.id);
  });

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
    expect(requestSafeUrlOpen(panel.resources[0].url, opener)).toBe(true);
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
