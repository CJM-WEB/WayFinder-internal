/**
 * 模块职责：集中维护 Graph 与 Resource Panel 共用的用户可见标签。
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

export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  primary: "主路径",
  related: "相关主题",
  disambiguation: "消歧分支",
};
