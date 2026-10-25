/**
 * 模块职责：把 Orchestrator 已完成最终校验的 GraphPlan（图计划）按固定顺序发到事件流。
 *
 * 关键边界：
 * - query.analysis 与 graph.plan 都只从同一个 validatedPlan 构造，不重新分析 Query；
 * - 两个 Payload 在首次 await 前完成 Schema 校验和快照，避免背压期间的可变对象漂移；
 * - 本模块不解析 Planner 输出、不启动 Node，也不决定 Run 终态。
 */
import {
  StreamEventPayloadSchema,
  type GraphPlan,
  type StreamEventPayload,
} from "@wayfinder/contracts";

import { parseValidatedGraphPlanForRun } from "./resolve-graph-plan.js";

export type EmitValidatedPlanEventsInput = Readonly<{
  /** 必须是 resolveValidatedGraphPlanForRun 返回的最终 GraphPlan。 */
  validatedPlan: GraphPlan;
  emit: (payload: StreamEventPayload) => Promise<void>;
}>;

/**
 * 串行发送计划阶段的两条事件。先等待 Analysis 写入完成，再交付完整 GraphPlan，
 * 从而让物理背压下的观察顺序与协议顺序一致。
 */
export async function emitValidatedPlanEvents(
  input: EmitValidatedPlanEventsInput,
): Promise<void> {
  // 即使调用方绕过约定，也不能让仅通过结构校验、但违反图规则的计划上流。
  const validatedPlan = parseValidatedGraphPlanForRun(input.validatedPlan);
  // 先构造两份独立快照；二者均源自同一 validatedPlan，且不在 await 后重新计算。
  const analysisPayload = StreamEventPayloadSchema.parse({
    type: "query.analysis",
    data: validatedPlan.analysis,
  });
  const graphPlanPayload = StreamEventPayloadSchema.parse({
    type: "graph.plan",
    data: validatedPlan,
  });

  await input.emit(analysisPayload);
  await input.emit(graphPlanPayload);
}
