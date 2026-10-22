/**
 * 模块职责：集中维护 Graph 与 Resource Panel 共用的用户可见标签及六态展示模型。
 *
 * Record 约束确保 Contract 新增枚举值时编译立即失败，避免界面静默显示原始协议值。
 */
import type { NodeType, StreamNodeStatus } from "@wayfinder/contracts";

export const NODE_STATUS_LABELS: Record<StreamNodeStatus, string> = {
  planned: "等待检索",
  searching: "检索中",
  filtering: "筛选中",
  ready: "已就绪",
  partial: "部分完成",
  failed: "失败",
};

type NodeStatusVisual = Readonly<{
  /** 独立符号让状态不只依赖颜色；可见中文标签继续承担完整语义。 */
  marker: string;
  detail: (resourceCount: number) => string;
  isLoading: boolean;
}>;

/**
 * 六种公共状态的最小视觉模型。
 * 只有真正执行中的 searching / filtering 标记为加载；planned 是等待态，三个结果态均已结束。
 */
const NODE_STATUS_VISUALS: Record<StreamNodeStatus, NodeStatusVisual> = {
  planned: {
    marker: "○",
    detail: () => "等待开始",
    isLoading: false,
  },
  searching: {
    marker: "↻",
    detail: () => "正在检索网页",
    isLoading: true,
  },
  filtering: {
    marker: "◇",
    detail: () => "正在筛选结果",
    isLoading: true,
  },
  ready: {
    marker: "✓",
    detail: resourceCount => `${resourceCount} 条可用资源`,
    isLoading: false,
  },
  partial: {
    marker: "!",
    detail: resourceCount => `${resourceCount} 条可用资源 · 含降级`,
    isLoading: false,
  },
  failed: {
    marker: "×",
    detail: () => "没有可用资源",
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
  status: StreamNodeStatus,
  resourceCount: number,
): NodeStatusPresentation => {
  const visual = NODE_STATUS_VISUALS[status];

  return {
    label: NODE_STATUS_LABELS[status],
    marker: visual.marker,
    detail: visual.detail(resourceCount),
    isLoading: visual.isLoading,
  };
};

export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  primary: "主路径",
  related: "相关主题",
  disambiguation: "消歧分支",
};
