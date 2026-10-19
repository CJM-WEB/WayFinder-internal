/**
 * 组件职责：以统一视觉展示 Graph Node 的最小产品信息。
 *
 * 范围边界：WAY-30 只展示标题、资源数和状态；资源列表与节点选择交互留给 WAY-31。
 */
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

import type { GraphFlowNode } from "./graph-layout.js";

const STATUS_LABELS: Record<GraphFlowNode["data"]["status"], string> = {
  planned: "等待检索",
  searching: "检索中",
  filtering: "筛选中",
  ready: "已就绪",
  partial: "部分完成",
  failed: "失败",
};

const NODE_TYPE_LABELS: Record<GraphFlowNode["data"]["nodeType"], string> = {
  primary: "主路径",
  related: "相关主题",
  disambiguation: "消歧分支",
};

export function GraphNode({ data }: NodeProps<GraphFlowNode>) {
  return (
    <article className="graph-node__content">
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
          {STATUS_LABELS[data.status]}
        </span>
      </div>
      <h3>{data.title}</h3>
      <p>{data.resourceCount} 条资源</p>

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
