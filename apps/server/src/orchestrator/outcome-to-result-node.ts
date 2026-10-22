/**
 * 模块职责：把单个 NodeJobOutcome（节点任务结算）投影为最终 ResultGraphNode。
 *
 * 边界约束：
 * - fulfilled 直接保留 processNode 已校验的 ready / partial Node；
 * - rejected 只投影原始 code / retryable，不能改写成 Deadline 或泄漏内部诊断；
 * - timed_out 是唯一可生成 RUN_DEADLINE_EXCEEDED 的分支；
 * - 本模块不匹配整图 Node ID、不处理 Edge，也不构建 ResultGraph。
 */
import {
  ResultGraphNodeSchema,
  type GraphPlanNode,
  type NodeJobOutcome,
  type ResultGraphNode,
} from "@wayfinder/contracts";

type FailedNodeJobOutcome = Exclude<
  NodeJobOutcome,
  { status: "fulfilled" }
>;

/**
 * 生成严格 failed Node。显式复制公共 Error 字段，避免 Error 的 message、stack、cause
 * 或 Provider 私有诊断通过对象扩展进入最终快照。
 */
function createFailedResultNode(
  planNode: GraphPlanNode,
  error: FailedNodeJobOutcome["error"],
): ResultGraphNode {
  return ResultGraphNodeSchema.parse({
    ...planNode,
    status: "failed",
    resources: [],
    warnings: [],
    error: {
      code: error.code,
      retryable: error.retryable,
    },
  });
}

/** 按 Outcome 判别分支保留真实失败原因；跨 Node 关系校验属于 WAY-66 Builder。 */
export function outcomeToResultNode(
  planNode: GraphPlanNode,
  outcome: NodeJobOutcome,
): ResultGraphNode {
  switch (outcome.status) {
    case "fulfilled": {
      if (outcome.value.status === "failed") {
        // processNode 的成功承诺只能返回 ready/partial；防止伪造 fulfilled 绕过失败分支。
        throw new TypeError("fulfilled Node job 不能携带 failed Node");
      }
      return outcome.value;
    }
    case "rejected":
      return createFailedResultNode(planNode, outcome.error);
    case "timed_out":
      return createFailedResultNode(planNode, outcome.error);
  }
}
