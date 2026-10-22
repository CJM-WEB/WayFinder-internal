/**
 * 模块职责：把最终已验证 GraphPlan（图计划）的全部 Node job 在同一同步轮次启动。
 *
 * 边界约束：本模块不按 layer / Edge 串行、不限制整个 processNode、不等待或分类结果；
 * Search / Extract / LLM 的 6/3/3 限流由注入的集中 Provider 装饰器负责，WAY-64 再
 * 对这里返回的原始 Promise 做 fulfilled / rejected / timed_out 结算。
 */
import type { GraphPlan, ResultGraphNode } from "@wayfinder/contracts";

import {
  processNode,
  type ProcessNodeContext,
} from "../pipeline/process-node.js";
import type { AbsoluteRunDeadlineScope } from "./absolute-run-deadline.js";
import type { ConcurrencyLimitedProviders } from "./provider-concurrency.js";

export type NodeJobTask = Readonly<{
  nodeId: string;
  promise: Promise<ResultGraphNode>;
}>;

type NodeJobContext = Omit<
  ProcessNodeContext,
  "analysis" | "rerankProvider" | "tavilyProvider"
>;

export type StartNodeJobsInput = Readonly<{
  /** 必须来自 WAY-62 最终 Schema + Validator 门禁。 */
  plan: Pick<GraphPlan, "analysis" | "nodes">;
  context: NodeJobContext;
  providers: ConcurrencyLimitedProviders;
  runScope: Pick<
    AbsoluteRunDeadlineScope,
    "requirePositiveRemainingMs" | "signal"
  >;
}>;

/**
 * 返回顺序与 GraphPlan.nodes 一致。函数刻意保持同步，禁止在 map 内 await，确保任意
 * layer 的 Node 都先取得独立 Promise；外部调用是否立即执行只由对应 Provider Gate 决定。
 */
export function startNodeJobs(
  input: StartNodeJobsInput,
): readonly NodeJobTask[] {
  // 在启动第一项前统一检查，避免中途抛错后遗失已经创建但无人持有的 Promise。
  input.runScope.requirePositiveRemainingMs();

  return input.plan.nodes.map(node => ({
    nodeId: node.id,
    promise: processNode(
      node,
      {
        ...input.context,
        analysis: input.plan.analysis,
        tavilyProvider: input.providers.searchProvider,
        rerankProvider: input.providers.llmProvider,
      },
      input.runScope.signal,
    ),
  }));
}
