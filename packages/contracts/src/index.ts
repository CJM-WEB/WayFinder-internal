/**
 * 模块职责：提供 WayFinder 公共协议使用的共享枚举与错误结构。
 *
 * 关键约束：
 * - Zod Schema 是运行时校验与 TypeScript 类型的 Single Source of Truth（单一事实来源）。
 * - 公共类型必须通过 `z.infer` 推导，禁止再维护手写 union 或 TypeScript enum。
 * - 这里仅描述跨模块稳定语义；Provider（提供方）私有字段必须留在 Adapter（适配器）边界。
 */
import { z } from "zod";

/** Query（查询）分析阶段使用的稳定分类。 */
export const IntentSchema = z.enum([
  "learn",
  "understand",
  "news",
  "compare",
  "shop",
  "navigate",
  "how_to",
  "mixed",
]);
export type Intent = z.infer<typeof IntentSchema>;

/** Retrieval Strategy（检索策略）只描述 Graph 规划前是否需要证据辅助。 */
export const RetrievalStrategySchema = z.enum([
  "plan_first",
  "evidence_assisted",
]);
export type RetrievalStrategy = z.infer<typeof RetrievalStrategySchema>;

/** Presentation Mode（展示模式）决定结果采用 Graph 或紧凑布局。 */
export const PresentationModeSchema = z.enum(["graph", "compact"]);
export type PresentationMode = z.infer<typeof PresentationModeSchema>;

/** Graph（图）结构词表由计划图与最终结果图共同使用。 */
export const NodeTypeSchema = z.enum([
  "primary",
  "related",
  "disambiguation",
]);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const EdgeTypeSchema = z.enum(["recommended_next", "related_to"]);
export type EdgeType = z.infer<typeof EdgeTypeSchema>;

/** Ranking Profile（排序配置）描述不同检索意图采用的排序侧重点。 */
export const RankingProfileSchema = z.enum([
  "knowledge",
  "news",
  "shopping",
  "software",
  "general",
]);
export type RankingProfile = z.infer<typeof RankingProfileSchema>;

/** Search Capability（搜索能力）供 Planner（规划器）与 Provider Router（提供方路由器）共享。 */
export const SearchCapabilitySchema = z.enum([
  "general",
  "news",
  "shopping",
  "academic",
  "code",
  "community",
  "finance",
  "images",
]);
export type SearchCapability = z.infer<typeof SearchCapabilitySchema>;

/**
 * Node（节点）状态按生命周期分层：处理中事件不能伪装成最终结果，最终快照也不能残留处理中状态。
 */
export const ProcessingNodeStatusSchema = z.enum([
  "planned",
  "searching",
  "filtering",
]);
export type ProcessingNodeStatus = z.infer<typeof ProcessingNodeStatusSchema>;

export const ResultNodeStatusSchema = z.enum(["ready", "partial", "failed"]);
export type ResultNodeStatus = z.infer<typeof ResultNodeStatusSchema>;

// 完整流式状态从两组基础状态组合，避免第三次手写同一批协议值。
export const StreamNodeStatusSchema = z.enum([
  ...ProcessingNodeStatusSchema.options,
  ...ResultNodeStatusSchema.options,
]);
export type StreamNodeStatus = z.infer<typeof StreamNodeStatusSchema>;

/**
 * Warning（警告）表示“已有可交付结果，但发生局部回退”；不得把无结果的失败包装成 Warning。
 */
export const NodeWarningCodeSchema = z.enum([
  "SEARCH_PROVIDER_PARTIAL",
  "EXTRACTION_FAILED",
  "RERANK_FAILED",
]);
export type NodeWarningCode = z.infer<typeof NodeWarningCodeSchema>;

/** Error（错误）表示对应 Node 或 Run 没有可交付结果。 */
export const AppErrorCodeSchema = z.enum([
  "PLANNER_FAILED",
  "INVALID_GRAPH",
  "SEARCH_PROVIDER_FAILED",
  "EXTRACTION_FAILED",
  "RERANK_FAILED",
  "RUN_DEADLINE_EXCEEDED",
  "REQUEST_ABORTED",
  "UNKNOWN",
]);
export type AppErrorCode = z.infer<typeof AppErrorCodeSchema>;

/**
 * 公共错误对象刻意保持最小且严格：详细诊断进入脱敏 Run Log，不得把 Provider 原始错误暴露给业务层。
 */
export const AppErrorSchema = z.strictObject({
  code: AppErrorCodeSchema,
  retryable: z.boolean(),
});
export type AppError = z.infer<typeof AppErrorSchema>;
