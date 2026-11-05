/**
 * 模块职责：集中维护 Graph 与 Resource Panel 共用的用户可见标签及六态展示模型。
 *
 * Record 约束确保 Contract 新增枚举值时编译立即失败，避免界面静默显示原始协议值。
 */
import type {
  EditableNode,
  NodeType,
  SearchLanguage,
  StreamNodeStatus,
} from "@wayfinder/contracts";

import { getMessages } from "../../i18n/messages.js";
import type { GraphDisplayNode, GraphNodeData } from "./graph-layout.js";

/** 文案快照与普通节点共用同一映射；换图旧字不需要重新布局或复制业务图。 */
export const buildGraphNodeData = (node: GraphDisplayNode, language: SearchLanguage): GraphNodeData => ({
  title: node.title,
  description: node.description,
  nodeType: node.nodeType,
  status: node.status,
  resourceCount: "resources" in node ? node.resources.length : 0,
  language,
});

/** H1/H2 评估界面暂不纳入本次多语言范围，保留中文默认导出以维持既有实验行为。 */
export const NODE_STATUS_LABELS: Readonly<
  Record<StreamNodeStatus, string>
> = getMessages("zh-CN").graph.statusLabels;

type NodeStatusVisual = Readonly<{
  /** 独立符号让状态不只依赖颜色；本地化可见标签继续承担完整语义。 */
  marker: string;
  isLoading: boolean;
}>;

/**
 * 六种公共状态的最小视觉模型。
 * 只有真正执行中的 searching / filtering 标记为加载；planned 是等待态，三个结果态均已结束。
 */
const NODE_STATUS_VISUALS: Record<StreamNodeStatus | EditableNode["status"], NodeStatusVisual> = {
  empty: { marker: "○", isLoading: false },
  edited: { marker: "✎", isLoading: false },
  planned: {
    marker: "○",
    isLoading: false,
  },
  searching: {
    marker: "↻",
    isLoading: true,
  },
  filtering: {
    marker: "◇",
    isLoading: true,
  },
  ready: {
    marker: "✓",
    isLoading: false,
  },
  partial: {
    marker: "!",
    isLoading: false,
  },
  failed: {
    marker: "×",
    isLoading: false,
  },
};

export type NodeStatusPresentation = Readonly<{
  label: string;
  marker: string;
  detail: string;
  isLoading: boolean;
}>;

/** Graph Node 只消费已收敛的展示模型，不在组件里重新判断状态机。 */
export const buildNodeStatusPresentation = (
  status: StreamNodeStatus | EditableNode["status"],
  resourceCount: number,
  language: SearchLanguage = "zh-CN",
): NodeStatusPresentation => {
  const visual = NODE_STATUS_VISUALS[status];
  const messages = getMessages(language).graph;

  return {
    label: messages.statusLabels[status],
    marker: visual.marker,
    detail: messages.statusDetails[status](resourceCount),
    isLoading: visual.isLoading,
  };
};

/** 中文默认值只供未接入语言参数的 Evaluation 路径复用。 */
export const NODE_TYPE_LABELS: Readonly<Record<NodeType, string>> =
  getMessages("zh-CN").graph.nodeTypeLabels;
