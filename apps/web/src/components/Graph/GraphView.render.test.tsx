/**
 * 测试职责：验证 GraphView（图视图）按 Graph/Compact 模式把 Store 快照同步接到 ReactFlow。
 *
 * React Flow 画布在测试中只捕获 Props（属性）；布局、Store 与 GraphView 均使用真实实现。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AriaLabelConfig, NodeChange, ReactFlowInstance, ReactFlowProps } from "@xyflow/react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { GraphFlowEdge, GraphFlowNode } from "./graph-layout.js";

const capturedFlow = vi.hoisted(() => ({
  nodes: undefined as readonly unknown[] | undefined,
  edges: undefined as readonly unknown[] | undefined,
  ariaLabels: undefined as Partial<AriaLabelConfig> | undefined,
  onNodesChange: undefined as ((changes: readonly unknown[]) => void) | undefined,
  props: undefined as ReactFlowProps<GraphFlowNode, GraphFlowEdge> | undefined,
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
      ariaLabelConfig?: Partial<AriaLabelConfig>;
      onNodesChange?: (changes: readonly unknown[]) => void;
    }) => {
      capturedFlow.nodes = props.nodes;
      capturedFlow.edges = props.edges;
      capturedFlow.ariaLabels = props.ariaLabelConfig;
      capturedFlow.onNodesChange = props.onNodesChange;
      capturedFlow.props = props as unknown as ReactFlowProps<GraphFlowNode, GraphFlowEdge>;
      return null;
    },
    Background: () => null,
    Controls: () => null,
  };
});

import { graphStore } from "../../stores/graph-store.js";
import { createPythonMockStream } from "../../testing/python-mock-stream.js";
import { GraphView } from "./GraphView.js";
import { fromResultGraph, workspaceStore } from "../../stores/workspace-store.js";
import { pythonResultGraphFixture } from "../../fixtures/python-result-graph.js";

afterEach(() => {
  graphStore.getState().reset();
  capturedFlow.nodes = undefined;
  capturedFlow.edges = undefined;
  capturedFlow.ariaLabels = undefined;
  capturedFlow.onNodesChange = undefined;
  capturedFlow.props = undefined;
  workspaceStore.getState().restoreDocuments([], null);
});

/** 仅替换浏览器事件/画布实例；身份、坐标转发和生产编辑函数保持真实。 */
const contextEvent = (clientX: number, clientY: number): ReactMouseEvent => ({
  clientX,clientY,preventDefault: vi.fn(),stopPropagation: vi.fn(),
}) as unknown as ReactMouseEvent;

describe("GraphView 墨迹交互桥", () => {
  it("旧空态不挂 Flow；墨迹空态保留可接世界坐标的同一画布", () => {
    const empty = { nodes: [],edges: [],positions: {} };
    const oldMarkup = renderToStaticMarkup(<GraphView presentationMode="graph" language="zh-CN" graph={empty} />);
    expect(oldMarkup).toContain("graph-empty");
    expect(capturedFlow.props).toBeUndefined();
    const request = vi.fn();
    renderToStaticMarkup(<GraphView appearance="ink" presentationMode="graph" language="zh-CN" graph={empty} onContextRequest={request} />);
    const convert = vi.fn(() => ({ x: 123,y: -45 }));
    capturedFlow.props?.onInit?.({ screenToFlowPosition: convert,getNodes: () => [] } as unknown as ReactFlowInstance<GraphFlowNode, GraphFlowEdge>);
    const event = contextEvent(700,480);
    capturedFlow.props?.onPaneContextMenu?.(event);
    expect(convert).toHaveBeenCalledWith({ x: 700,y: 480 });
    expect(request).toHaveBeenCalledWith({ kind: "pane",clientPoint: { x: 700,y: 480 },flowPoint: { x: 123,y: -45 },positions: {} });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it("右键传真实 Node/Edge ID 和 world 布局快照，不从标签或屏幕像素猜身份", () => {
    const graph = fromResultGraph(pythonResultGraphFixture,"context-graph");
    const request = vi.fn(), select = vi.fn();
    renderToStaticMarkup(<GraphView appearance="ink" presentationMode="graph" language="zh-CN" graph={graph}
      onSelectNode={select} onContextRequest={request} />);
    const nodes = capturedFlow.nodes as GraphFlowNode[], edges = capturedFlow.edges as GraphFlowEdge[];
    const first = nodes[0], edge = edges[0];
    if (first===undefined || edge===undefined) throw new Error("Fixture 缺少节点或边");
    capturedFlow.props?.onInit?.({ getNodes: () => nodes } as unknown as ReactFlowInstance<GraphFlowNode, GraphFlowEdge>);
    capturedFlow.props?.onNodeContextMenu?.(contextEvent(20,30),first);
    expect(select).toHaveBeenCalledWith(first.id);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "node",nodeId: first.id,clientPoint: { x: 20,y: 30 },
      positions: expect.objectContaining({ [first.id]: first.position }) }));
    capturedFlow.props?.onEdgeContextMenu?.(contextEvent(40,50),edge);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "edge",edgeId: edge.id,clientPoint: { x: 40,y: 50 } }));
  });

  it("搬动门禁期间不能连接或呼出菜单，正常拖动/空白点击可通知外层", () => {
    const request = vi.fn(), pane = vi.fn(), interaction = vi.fn();
    const graph = fromResultGraph(pythonResultGraphFixture,"locked-graph");
    renderToStaticMarkup(<GraphView appearance="ink" presentationMode="graph" language="zh-CN" graph={graph}
      editableGraphId={graph.id} interactionReady={false} onContextRequest={request} onPaneClick={pane} onInteractionStart={interaction} />);
    expect(capturedFlow.props?.nodesConnectable).toBe(false);
    const first = (capturedFlow.nodes as GraphFlowNode[])[0];
    if (first===undefined) throw new Error("Fixture 缺少节点");
    capturedFlow.props?.onNodeContextMenu?.(contextEvent(20,30),first);
    capturedFlow.props?.onPaneClick?.(contextEvent(20,30));
    expect(request).not.toHaveBeenCalled();
    expect(pane).not.toHaveBeenCalled();
    renderToStaticMarkup(<GraphView appearance="ink" presentationMode="graph" language="zh-CN" graph={graph}
      editableGraphId={graph.id} onPaneClick={pane} onInteractionStart={interaction} />);
    expect(capturedFlow.props?.nodesConnectable).toBe(true);
    capturedFlow.props?.onPaneClick?.(contextEvent(20,30));
    (capturedFlow.props?.onNodeDragStart as (() => void) | undefined)?.();
    (capturedFlow.props?.onConnectStart as (() => void) | undefined)?.();
    expect(pane).toHaveBeenCalledOnce();
    expect(interaction).toHaveBeenCalledTimes(2);
    renderToStaticMarkup(<GraphView appearance="ink" presentationMode="graph" language="zh-CN" graph={graph}
      editableGraphId={graph.id} visibleNodeIds={new Set([first.id])} />);
    const gatedNodes = capturedFlow.nodes as GraphFlowNode[];
    expect(gatedNodes.find(node => node.id===first.id)?.connectable).toBe(true);
    expect(gatedNodes.filter(node => node.id!==first.id).every(node => node.connectable===false)).toBe(true);
  });

  it("墨迹连线一次提交原编辑函数及未保存布局，最新显式位置优先且可一次撤销", () => {
    const base = fromResultGraph(pythonResultGraphFixture,"connect-graph");
    const first = base.nodes[0], second = base.nodes[1];
    if (first===undefined || second===undefined) throw new Error("Fixture 缺少连接端点");
    const graph = { ...base,edges: [],positions: { [first.id]: { x: 501,y: 602 } } };
    workspaceStore.getState().restoreDocuments([graph],graph.id);
    renderToStaticMarkup(<GraphView appearance="ink" presentationMode="graph" language="zh-CN" graph={graph} editableGraphId={graph.id} />);
    const nodes = (capturedFlow.nodes as GraphFlowNode[]).map((node,index) => ({ ...node,position: { x: index*30+10,y: index*20+5 } }));
    capturedFlow.props?.onInit?.({ getNodes: () => nodes } as unknown as ReactFlowInstance<GraphFlowNode, GraphFlowEdge>);
    capturedFlow.props?.onConnect?.({ source: first.id,target: second.id,sourceHandle: "related-source",targetHandle: "related-target" });
    const edited = workspaceStore.getState().documents[0];
    expect(edited?.edges).toEqual([expect.objectContaining({ source: first.id,target: second.id,type: "related_to" })]);
    expect(edited?.positions[first.id]).toEqual({ x: 501,y: 602 });
    expect(edited?.positions[second.id]).toEqual(nodes[1]?.position);
    expect(workspaceStore.getState().histories[graph.id]?.past).toHaveLength(1);
    workspaceStore.getState().undo();
    expect(workspaceStore.getState().documents[0]).toEqual(graph);
  });
});

describe("GraphView 渐进快照接线", () => {
  it("graph.plan 接纳后的首次 render 已包含完整 planned Draft", () => {
    const plan = createPythonMockStream({
      now: () => Date.parse("2026-10-22T00:00:00.000Z"),
    }).find(event => event.type === "graph.plan");
    if (plan?.type !== "graph.plan") {
      throw new Error("Python Mock Stream 缺少 graph.plan");
    }
    graphStore
      .getState()
      .startRun({ runId: plan.runId, query: "Python", language: "zh-CN" });
    graphStore.getState().applyStreamEvent(plan);

    const markup = renderToStaticMarkup(
      <GraphView presentationMode="graph" language="zh-CN" />,
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
        <GraphView presentationMode="compact" language="zh-CN" />,
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

  it("English 统一映射画布、Node、Edge 与 React Flow 可访问文案", () => {
    const plan = createPythonMockStream({
      now: () => Date.parse("2026-10-22T00:00:00.000Z"),
    }).find(event => event.type === "graph.plan");
    if (plan?.type !== "graph.plan") {
      throw new Error("Python Mock Stream 缺少 graph.plan");
    }
    graphStore.getState().setGraph(plan.data);

    const markup = renderToStaticMarkup(
      <GraphView presentationMode="graph" language="en-US" />,
    );
    const nodes = capturedFlow.nodes as readonly GraphFlowNode[] | undefined;
    const edges = capturedFlow.edges as readonly GraphFlowEdge[] | undefined;

    expect(markup).toContain(
      'aria-label="Exploratory search results graph"',
    );
    expect(nodes?.[0]?.data.language).toBe("en-US");
    expect(nodes?.[0]?.ariaLabel).toContain("status: Waiting");
    expect(edges?.[0]?.label).toBe("Recommended next");
    expect(capturedFlow.ariaLabels).toMatchObject({
      "node.a11yDescription.default":
        "Press Enter or Space to select a node.",
      "controls.zoomIn.ariaLabel": "Zoom in",
      "controls.fitView.ariaLabel": "Fit all nodes",
    });
  });

  it("把 React Flow 键盘选择变化接回 Store", () => {
    const plan = createPythonMockStream({
      now: () => Date.parse("2026-10-22T00:00:00.000Z"),
    }).find(event => event.type === "graph.plan");
    if (plan?.type !== "graph.plan") {
      throw new Error("Python Mock Stream 缺少 graph.plan");
    }
    graphStore
      .getState()
      .startRun({ runId: plan.runId, query: "Python", language: "zh-CN" });
    graphStore.getState().applyStreamEvent(plan);

    renderToStaticMarkup(
      <GraphView presentationMode="graph" language="zh-CN" />,
    );

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
    renderToStaticMarkup(
      <GraphView presentationMode="graph" language="zh-CN" />,
    );
    const switchSelection = capturedFlow.onNodesChange as
      | ((changes: NodeChange<GraphFlowNode>[]) => void)
      | undefined;
    switchSelection?.([
      { type: "select", id: firstNodeId, selected: false },
      { type: "select", id: secondNodeId, selected: true },
    ]);
    expect(graphStore.getState().selectedNodeId).toBe(secondNodeId);

    renderToStaticMarkup(
      <GraphView presentationMode="graph" language="zh-CN" />,
    );
    const clearSelection = capturedFlow.onNodesChange as
      | ((changes: NodeChange<GraphFlowNode>[]) => void)
      | undefined;
    clearSelection?.([
      { type: "select", id: secondNodeId, selected: false },
    ]);
    expect(graphStore.getState().selectedNodeId).toBeNull();
  });
});
