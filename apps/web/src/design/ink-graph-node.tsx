/**
 * 组件职责：在原 React Flow 节点上呈现真实标题、说明与渐进状态；墨团由同一 WebGL 画布绘制。
 * 对齐边界：data-ink-node 所在元素尺寸固定，不能对它做入场缩放，否则会改变 GPU 的目标坐标。
 */
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { getMessages } from "../i18n/messages.js";
import { buildNodeStatusPresentation } from "../components/Graph/graph-labels.js";
import type { GraphFlowNode } from "../components/Graph/graph-layout.js";

export function InkGraphNode({ id, data }: NodeProps<GraphFlowNode>) {
  const presentation = buildNodeStatusPresentation(data.status, data.resourceCount, data.language);
  const messages = getMessages(data.language).graph;
  return <article className="ink-graph-node" data-ink-node={id} data-node-status={data.status} aria-busy={presentation.isLoading}>
    {/* 继续使用原图的四个连接锚点，相关边和推荐边的语义、方向与 ID 完全复用。 */}
    <Handle id="main-target" type="target" position={Position.Top} isConnectable={false} />
    <Handle id="related-target" type="target" position={Position.Left} isConnectable={false} />
    <div className="ink-graph-node__content">
      <div className="ink-graph-node__eyebrow"><span>{messages.nodeTypeLabels[data.nodeType]}</span><span>{presentation.label}</span></div>
      <h3>{data.title}</h3>
      <p>{data.description ?? ""}</p>
      <span className="ink-graph-node__detail">{presentation.detail}</span>
    </div>
    <Handle id="related-source" type="source" position={Position.Right} isConnectable={false} />
    <Handle id="main-source" type="source" position={Position.Bottom} isConnectable={false} />
  </article>;
}
