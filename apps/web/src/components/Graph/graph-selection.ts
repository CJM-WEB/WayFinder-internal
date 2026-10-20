/**
 * 模块职责：在 React Flow 交互选择与 Graph Store 业务选择之间做确定性映射。
 *
 * 关键约束：Store ID 是单一事实来源；图快照刷新不能让高亮与 Resource Panel 分叉。
 */
import type { GraphFlowNode } from "./graph-layout.js";

/** 空 selection 表示用户已取消选择，必须同步为 null 以清除 Resource Panel。 */
export const resolveSelectedNodeId = (
  selectedNodes: readonly Pick<GraphFlowNode, "id">[],
): GraphFlowNode["id"] | null => selectedNodes.at(-1)?.id ?? null;

/** 图快照或业务选择变化时，从 Store ID 重新派生唯一高亮。 */
export const applySelectedNodeId = (
  nodes: readonly GraphFlowNode[],
  selectedNodeId: GraphFlowNode["id"] | null,
): GraphFlowNode[] =>
  nodes.map(node => ({
    ...node,
    selected: node.id === selectedNodeId,
  }));
