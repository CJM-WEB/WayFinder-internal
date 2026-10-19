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
import type { AriaLabelConfig, NodeTypes } from "@xyflow/react";
import { useMemo } from "react";
import { useStore } from "zustand";

import { graphStore } from "../../stores/graph-store.js";
import { GraphNode } from "./GraphNode.js";
import {
  buildGraphFlowElements,
  type GraphFlowEdge,
  type GraphFlowNode,
} from "./graph-layout.js";

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

export function GraphView() {
  const nodes = useStore(graphStore, state => state.nodes);
  const edges = useStore(graphStore, state => state.edges);
  const elements = useMemo(
    () => buildGraphFlowElements(nodes, edges),
    [nodes, edges],
  );

  if (elements.nodes.length === 0) {
    return <p className="graph-empty">暂无可展示的搜索结果。</p>;
  }

  return (
    <div className="graph-canvas" aria-label="Python 搜索结果图">
      <ReactFlow<GraphFlowNode, GraphFlowEdge>
        nodes={elements.nodes}
        edges={elements.edges}
        nodeTypes={NODE_TYPES}
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
