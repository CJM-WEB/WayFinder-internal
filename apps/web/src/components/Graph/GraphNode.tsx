/**
 * 组件职责：以独立文字、符号和语义样式展示 Graph Node（图节点）的六种渐进状态。
 *
 * 范围边界：加载只由当前 Node 状态决定；组件不读取 Run 全局状态，也不阻塞其他 Node 交互。
 */
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

import type { GraphFlowNode } from "./graph-layout.js";
import {
  buildNodeStatusPresentation,
  NODE_TYPE_LABELS,
} from "./graph-labels.js";

export function GraphNode({ data }: NodeProps<GraphFlowNode>) {
  const presentation = buildNodeStatusPresentation(
    data.status,
    data.resourceCount,
  );

  return (
    <article
      className="graph-node__content"
      data-node-status={data.status}
      aria-busy={presentation.isLoading}
    >
      {/* 主层级边固定从下方流向上方；侧边 Handle 专门承载 related_to。 */}
      <Handle
        id="main-target"
        type="target"
        position={Position.Top}
        className="graph-node__handle"
      />
      <Handle
        id="related-target"
        type="target"
        position={Position.Left}
        className="graph-node__handle"
      />

      <div className="graph-node__eyebrow">
        <span>{NODE_TYPE_LABELS[data.nodeType]}</span>
        <span className={`graph-node__status graph-node__status--${data.status}`}>
          <span className="graph-node__status-marker" aria-hidden="true">
            {presentation.marker}
          </span>
          {presentation.label}
        </span>
      </div>
      <h3>{data.title}</h3>
      <p>{presentation.detail}</p>

      <Handle
        id="related-source"
        type="source"
        position={Position.Right}
        className="graph-node__handle"
      />
      <Handle
        id="main-source"
        type="source"
        position={Position.Bottom}
        className="graph-node__handle"
      />
    </article>
  );
}
