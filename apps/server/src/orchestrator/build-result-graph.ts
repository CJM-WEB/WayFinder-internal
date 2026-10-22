/**
 * 模块职责：把已验证 GraphPlan 与全部 NodeJobOutcome 组装成唯一终态 ResultGraph。
 *
 * 关键边界：
 * - 每个计划 Node 必须且只能按 nodeId 消费一个 Outcome，不能依赖数组位置猜测归属；
 * - fulfilled 结果还必须保留同一个 Node ID，防止合法 Node 被挂到错误计划节点；
 * - meta.partial 只由最终 Node 状态派生，调用方不能覆盖；
 * - Node、Edge、Resource 与根对象关系统一交给 ResultGraphSchema 最终校验；
 * - 本模块不发送 StreamEvent，也不管理 Run Deadline 或 Route 生命周期。
 */
import {
  ResultGraphSchema,
  type GraphPlan,
  type NodeJobOutcome,
  type ResultGraph,
} from "@wayfinder/contracts";

import { outcomeToResultNode } from "./outcome-to-result-node.js";

export type BuildResultGraphInput = Readonly<{
  runId: ResultGraph["runId"];
  query: ResultGraph["query"];
  /** 必须来自最终 GraphPlan Schema + Validator 门禁。 */
  plan: GraphPlan;
  outcomes: readonly NodeJobOutcome[];
  /** partial 不属于调用方输入，避免同一派生状态存在两个事实来源。 */
  meta: Readonly<Omit<ResultGraph["meta"], "partial">>;
}>;

/**
 * 建立 Outcome 索引时立即拒绝未知和重复 ID；缺失项稍后按计划顺序检查，
 * 使错误始终指向第一个无法形成终态的计划 Node。
 */
function indexOutcomesByNodeId(
  plan: GraphPlan,
  outcomes: readonly NodeJobOutcome[],
): ReadonlyMap<string, NodeJobOutcome> {
  const plannedNodeIds = new Set(plan.nodes.map(node => node.id));
  const outcomesByNodeId = new Map<string, NodeJobOutcome>();

  for (const outcome of outcomes) {
    if (!plannedNodeIds.has(outcome.nodeId)) {
      throw new TypeError(`Node outcome 引用了未计划的 Node：${outcome.nodeId}`);
    }
    if (outcomesByNodeId.has(outcome.nodeId)) {
      throw new TypeError(`Node outcome 重复：${outcome.nodeId}`);
    }
    outcomesByNodeId.set(outcome.nodeId, outcome);
  }

  return outcomesByNodeId;
}

/**
 * 按 GraphPlan Node 顺序生成完整终态快照。ResultGraphSchema.parse 是最后一道门禁，
 * 因此即使内部调用方绕过 TypeScript，也不能输出 processing Node 或非法跨对象关系。
 */
export function buildResultGraph(input: BuildResultGraphInput): ResultGraph {
  const outcomesByNodeId = indexOutcomesByNodeId(input.plan, input.outcomes);
  const nodes = input.plan.nodes.map(planNode => {
    const outcome = outcomesByNodeId.get(planNode.id);
    if (outcome === undefined) {
      throw new TypeError(`计划 Node 缺少 outcome：${planNode.id}`);
    }

    const resultNode = outcomeToResultNode(planNode, outcome);
    if (resultNode.id !== planNode.id) {
      throw new TypeError(`fulfilled Node 结果 ID 与计划不一致：${planNode.id}`);
    }
    return resultNode;
  });

  return ResultGraphSchema.parse({
    version: "0.1",
    runId: input.runId,
    query: input.query,
    analysis: input.plan.analysis,
    graph: {
      nodes,
      edges: input.plan.edges,
    },
    meta: {
      createdAt: input.meta.createdAt,
      providersUsed: input.meta.providersUsed,
      partial: nodes.some(node => node.status !== "ready"),
      timingMs: input.meta.timingMs,
      ...(input.meta.warnings === undefined
        ? {}
        : { warnings: input.meta.warnings }),
    },
  });
}
