/**
 * 组件职责：订阅 Graph store，并把确定性布局结果交给 React Flow 渲染。
 *
 * 失败路径：Graph 为空时显示明确空态；布局异常不会在此处静默修复 Contract 数据。
 */
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
} from "@xyflow/react";
import type {
  AriaLabelConfig,
  NodeChange,
  NodeTypes,
} from "@xyflow/react";
import type { PresentationMode } from "@wayfinder/contracts";
import { useCallback, useMemo } from "react";
import { useStore } from "zustand";

import { graphStore } from "../../stores/graph-store.js";
import { GraphNode } from "./GraphNode.js";
import {
  buildGraphFlowElements,
  type GraphFlowEdge,
  type GraphFlowNode,
} from "./graph-layout.js";
import {
  applySelectedNodeId,
  resolveSelectedNodeId,
  resolveSelectedNodeIdFromChanges,
} from "./graph-selection.js";

/** 稳定引用避免 React Flow 在每次渲染时重建 Node Type 注册表。 */
const NODE_TYPES: NodeTypes = {
  wayfinder: GraphNode,
};

const ARIA_LABELS: Partial<AriaLabelConfig> = {
  "node.a11yDescription.default": "按回车或空格选择节点。",
  "edge.a11yDescription.default": "图中的节点关系。",
  "controls.ariaLabel": "图视图控制",
  "controls.zoomIn.ariaLabel": "放大",
  "controls.zoomOut.ariaLabel": "缩小",
  "controls.fitView.ariaLabel": "显示全部节点",
};

export type GraphViewProps = Readonly<{
  presentationMode: PresentationMode;
}>;

/** 两种展示模式共用同一 Product Graph；Compact 只改变视图密度，不改写 Node 或 Edge。 */
export function GraphView({ presentationMode }: GraphViewProps) {
  const nodes = useStore(graphStore, state => state.nodes);
  const edges = useStore(graphStore, state => state.edges);
  const selectedNodeId = useStore(graphStore, state => state.selectedNodeId);
  const selectNode = useStore(graphStore, state => state.selectNode);
  const elements = useMemo(
    () => buildGraphFlowElements(nodes, edges),
    [nodes, edges],
  );
  /**
   * Flow Node 是 Store 当前快照的同步派生值；不能通过 Effect 复制第二份节点状态，
   * 否则 graph.plan 与增量状态会先绘制一帧旧 Graph。选择也只由业务 ID 派生。
   */
  const flowNodes = useMemo(
    () => applySelectedNodeId(elements.nodes, selectedNodeId),
    [elements.nodes, selectedNodeId],
  );

  const handleSelectionChange = useCallback(
    ({ nodes: selectedNodes }: { nodes: GraphFlowNode[] }) => {
      // 事件只回写业务 ID；上方同步派生值再统一形成高亮。
      // Store 对同值写入不通知，阻断 React Flow 与 Store 的重复回写环。
      selectNode(resolveSelectedNodeId(selectedNodes));
    },
    [selectNode],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<GraphFlowNode>[]) => {
      /**
       * 键盘 Enter / Space 只产生 select change，不触发 onNodeClick；这里仅提取选择，
       * 测量与位置等 React Flow 内部变化不进入业务 Store。
       */
      const nextSelectedNodeId = resolveSelectedNodeIdFromChanges(
        flowNodes,
        changes,
      );
      if (nextSelectedNodeId !== undefined) {
        selectNode(nextSelectedNodeId);
      }
    },
    [flowNodes, selectNode],
  );

  if (elements.nodes.length === 0) {
    return <p className="graph-empty">暂无可展示的搜索结果。</p>;
  }

  return (
    <div
      className={`graph-canvas graph-canvas--${presentationMode}`}
      data-presentation-mode={presentationMode}
      aria-label={
        presentationMode === "compact"
          ? "紧凑搜索结果图"
          : "探索式搜索结果图"
      }
    >
      <ReactFlow<GraphFlowNode, GraphFlowEdge>
        nodes={flowNodes}
        edges={elements.edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={handleNodesChange}
        onNodeClick={(_event, node) => selectNode(node.id)}
        // React Flow 的键盘选择不触发 onNodeClick，必须从 selection 事件同步 Store。
        onSelectionChange={handleSelectionChange}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.35}
        maxZoom={1.8}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        panOnDrag
        zoomOnScroll
        ariaLabelConfig={ARIA_LABELS}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
        <Controls aria-label="图视图控制" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
