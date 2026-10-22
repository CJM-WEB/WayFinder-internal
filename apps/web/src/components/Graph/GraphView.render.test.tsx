/**
 * 测试职责：验证 GraphView（图视图）按 Graph/Compact 模式把 Store 快照同步接到 ReactFlow。
 *
 * React Flow 画布在测试中只捕获 Props（属性）；布局、Store 与 GraphView 均使用真实实现。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NodeChange } from "@xyflow/react";

import type { GraphFlowEdge, GraphFlowNode } from "./graph-layout.js";

const capturedFlow = vi.hoisted(() => ({
  nodes: undefined as readonly unknown[] | undefined,
  edges: undefined as readonly unknown[] | undefined,
  onNodesChange: undefined as ((changes: readonly unknown[]) => void) | undefined,
}));

vi.mock("zustand", () => ({
  useStore: <State, Selected>(
    store: { getState: () => State },
    selector: (state: State) => Selected,
  ): Selected => selector(store.getState()),
}));

vi.mock("@xyflow/react", async importOriginal => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();

  return {
    ...actual,
    ReactFlow: (props: {
      nodes: readonly unknown[];
      edges: readonly unknown[];
      onNodesChange?: (changes: readonly unknown[]) => void;
    }) => {
      capturedFlow.nodes = props.nodes;
      capturedFlow.edges = props.edges;
      capturedFlow.onNodesChange = props.onNodesChange;
      return null;
    },
    Background: () => null,
    Controls: () => null,
  };
});

import { graphStore } from "../../stores/graph-store.js";
import { createPythonMockStream } from "../../testing/python-mock-stream.js";
import { GraphView } from "./GraphView.js";

afterEach(() => {
  graphStore.getState().reset();
  capturedFlow.nodes = undefined;
  capturedFlow.edges = undefined;
  capturedFlow.onNodesChange = undefined;
});

describe("GraphView 渐进快照接线", () => {
  it("graph.plan 接纳后的首次 render 已包含完整 planned Draft", () => {
    const plan = createPythonMockStream({
      now: () => Date.parse("2026-10-22T00:00:00.000Z"),
    }).find(event => event.type === "graph.plan");
    if (plan?.type !== "graph.plan") {
      throw new Error("Python Mock Stream 缺少 graph.plan");
    }
    graphStore.getState().startRun({ runId: plan.runId, query: "Python" });
    graphStore.getState().applyStreamEvent(plan);

    const markup = renderToStaticMarkup(
      <GraphView presentationMode="graph" />,
    );

    const nodes = capturedFlow.nodes as readonly GraphFlowNode[] | undefined;
    const edges = capturedFlow.edges as readonly GraphFlowEdge[] | undefined;
    expect(nodes?.map(node => node.id)).toEqual(
      plan.data.nodes.map(node => node.id),
    );
    expect(nodes?.map(node => node.data.status)).toEqual(
      plan.data.nodes.map(() => "planned"),
    );
    expect(edges?.map(edge => edge.id)).toEqual(
      plan.data.edges.map(edge => edge.id),
    );
    expect(markup).toContain('data-presentation-mode="graph"');
    expect(markup).toContain('aria-label="探索式搜索结果图"');
  });

  it.each([1, 3])(
    "compact 完整渲染 %i 个 Node 且不提前自动选择",
    nodeCount => {
      const plan = createPythonMockStream({
        now: () => Date.parse("2026-10-22T00:00:00.000Z"),
      }).find(event => event.type === "graph.plan");
      if (plan?.type !== "graph.plan") {
        throw new Error("Python Mock Stream 缺少 graph.plan");
      }
      const nodes = plan.data.nodes.slice(0, nodeCount);
      const nodeIds = new Set(nodes.map(node => node.id));
      const edges = plan.data.edges.filter(
        edge => nodeIds.has(edge.source) && nodeIds.has(edge.target),
      );
      expect(nodes).toHaveLength(nodeCount);
      graphStore.getState().setGraph({ nodes, edges });

      const markup = renderToStaticMarkup(
        <GraphView presentationMode="compact" />,
      );

      expect(capturedFlow.nodes).toHaveLength(nodeCount);
      expect(capturedFlow.edges).toHaveLength(edges.length);
      expect(capturedFlow.edges).toEqual(
        expect.arrayContaining(
          edges.map(edge => expect.objectContaining({ id: edge.id })),
        ),
      );
      expect(graphStore.getState().selectedNodeId).toBeNull();
      expect(markup).toContain('data-presentation-mode="compact"');
      expect(markup).toContain('aria-label="紧凑搜索结果图"');
    },
  );

  it("把 React Flow 键盘选择变化接回 Store", () => {
    const plan = createPythonMockStream({
      now: () => Date.parse("2026-10-22T00:00:00.000Z"),
    }).find(event => event.type === "graph.plan");
    if (plan?.type !== "graph.plan") {
      throw new Error("Python Mock Stream 缺少 graph.plan");
    }
    graphStore.getState().startRun({ runId: plan.runId, query: "Python" });
    graphStore.getState().applyStreamEvent(plan);

    renderToStaticMarkup(<GraphView presentationMode="graph" />);

    const firstNodeId = plan.data.nodes[0]?.id;
    const secondNodeId = plan.data.nodes[1]?.id;
    if (!firstNodeId || !secondNodeId) {
      throw new Error("Python Mock Graph 至少需要两个节点");
    }
    const selectFirst = capturedFlow.onNodesChange as
      | ((changes: NodeChange<GraphFlowNode>[]) => void)
      | undefined;
    selectFirst?.([{ type: "select", id: firstNodeId, selected: true }]);
    expect(graphStore.getState().selectedNodeId).toBe(firstNodeId);

    // Store 更新后重新 render，确保回调基于最新受控 Nodes 完成键盘切换。
    renderToStaticMarkup(<GraphView presentationMode="graph" />);
    const switchSelection = capturedFlow.onNodesChange as
      | ((changes: NodeChange<GraphFlowNode>[]) => void)
      | undefined;
    switchSelection?.([
      { type: "select", id: firstNodeId, selected: false },
      { type: "select", id: secondNodeId, selected: true },
    ]);
    expect(graphStore.getState().selectedNodeId).toBe(secondNodeId);

    renderToStaticMarkup(<GraphView presentationMode="graph" />);
    const clearSelection = capturedFlow.onNodesChange as
      | ((changes: NodeChange<GraphFlowNode>[]) => void)
      | undefined;
    clearSelection?.([
      { type: "select", id: secondNodeId, selected: false },
    ]);
    expect(graphStore.getState().selectedNodeId).toBeNull();
  });
});
