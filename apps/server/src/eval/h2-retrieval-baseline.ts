/**
 * 模块职责：复用真实 Single-Node Pipeline（单节点管线）生成 H2 检索实验的本地 A/B 工件。
 *
 * 实验边界：
 * - Node-specific 条件使用原 GraphPlan Node；Raw Query 条件只替换 queries 与其派生 maxResults；
 * - Provider、Analysis、筛选、排序、Rerank、Resource Finalizer、稳定时间与每条件 Deadline 完全一致；
 * - 任一条件失败、取消或超时都拒绝生成工件，不能把空结果伪装成可比较样本；
 * - 输出仍经公共 H2EvaluationArtifactSchema 严格校验，网页内容不能扩张协议。
 */
import {
  GraphPlanNodeSchema,
  H2EvaluationArtifactSchema,
  H2RetrievalSourceSchema,
  ResultGraphNodeSchema,
  SearchRequestSchema,
  calculateSearchPlanMaxResults,
  type H2EvaluationArtifact,
  type H2RetrievalSource,
} from "@wayfinder/contracts";

import type { LLMProvider } from "../ai/llm-provider.js";
import { RUN_DEADLINE_MS } from "../config.js";
import type { DeepSeekTokenUsage } from "../ai/providers/deepseek-llm-provider.js";
import type { SearchProvider } from "../search/provider.js";
import type { SerpApiBingAttemptObservation } from "../search/providers/serpapi-bing.js";
import {
  evaluateSingleNodeSmokeCase,
  type SingleNodeSmokeCase,
  type SingleNodeSmokeCaseResult,
} from "./run-single-node-smoke.js";

export type H2ConditionOrder = readonly [
  H2RetrievalSource,
  H2RetrievalSource,
];

export type EvaluateH2RetrievalBaselineInput = Readonly<{
  smokeCase: SingleNodeSmokeCase;
  searchProvider: SearchProvider;
  rerankProvider: LLMProvider;
  rerankTimeoutMs: number;
  conditionOrder?: H2ConditionOrder;
  readAttemptObservations?: () => readonly SerpApiBingAttemptObservation[];
  readTokenUsages?: () => readonly DeepSeekTokenUsage[];
  runDeadlineMs?: number;
  parentSignal?: AbortSignal;
  now?: () => number;
  referenceTime?: string;
}>;

/** 失败只暴露稳定条件与执行状态，不携带 Provider 原始错误或网页内容。 */
export class H2EvaluationError extends Error {
  public readonly conditionId: "A" | "B";
  public readonly executionStatus: SingleNodeSmokeCaseResult["executionStatus"];

  public constructor(
    conditionId: "A" | "B",
    executionStatus: SingleNodeSmokeCaseResult["executionStatus"],
  ) {
    super(`H2 条件 ${conditionId} 未生成可比较结果：${executionStatus}`);
    this.name = "H2EvaluationError";
    this.conditionId = conditionId;
    this.executionStatus = executionStatus;
  }
}

/**
 * Raw Query 条件使用 SearchRequest 的既有 Query 规则，并只重建 SearchPlan 中由 Query 数量
 * 决定的两个字段。其余 Node 字段均保持原值，且不会修改调用方对象。
 */
export function createH2RawQuerySmokeCase(
  smokeCase: SingleNodeSmokeCase,
): SingleNodeSmokeCase {
  const query = SearchRequestSchema.shape.query.parse(smokeCase.originalQuery);
  const node = GraphPlanNodeSchema.parse({
    ...smokeCase.node,
    searchPlan: {
      ...smokeCase.node.searchPlan,
      queries: [query],
      maxResults: calculateSearchPlanMaxResults(1),
    },
  });

  return { ...smokeCase, node };
}

function parseConditionOrder(
  order: H2ConditionOrder | undefined,
): H2ConditionOrder {
  const parsed = H2RetrievalSourceSchema.array().length(2).parse(
    order ?? ["node_specific", "raw_query"],
  );
  if (new Set(parsed).size !== 2) {
    throw new TypeError("H2 条件顺序必须各包含一种检索来源");
  }
  return [parsed[0]!, parsed[1]!];
}

/** 累积 Observer（观察器）按条件切片，避免前一条件的计数污染后一条件预算。 */
function createObservationSliceReader<T>(
  read: (() => readonly T[]) | undefined,
): () => readonly T[] {
  const start = read?.().length ?? 0;
  return () => (read?.() ?? []).slice(start);
}

function buildSuccessfulNode(
  smokeCase: SingleNodeSmokeCase,
  result: SingleNodeSmokeCaseResult,
) {
  if (
    result.executionStatus !== "completed" ||
    (result.nodeStatus !== "ready" && result.nodeStatus !== "partial")
  ) {
    return null;
  }

  const node = ResultGraphNodeSchema.parse({
    ...smokeCase.node,
    status: result.nodeStatus,
    resources: result.resources,
    warnings: result.warnings,
  });
  return node.status === "failed" ? null : node;
}

/**
 * 两个条件串行共享同一 Provider Port，并分别获得相同且不超过 20 秒的绝对 Run Deadline。
 * conditionOrder 可用于受控交叉安排；页面只获得中性 A/B，不根据来源改变任何 UI。
 */
export async function evaluateH2RetrievalBaseline(
  input: EvaluateH2RetrievalBaselineInput,
): Promise<H2EvaluationArtifact> {
  const now = input.now ?? (() => performance.now());
  const runDeadlineMs = input.runDeadlineMs ?? RUN_DEADLINE_MS;
  if (
    !Number.isInteger(runDeadlineMs) ||
    runDeadlineMs < 1 ||
    runDeadlineMs > RUN_DEADLINE_MS
  ) {
    throw new RangeError(`runDeadlineMs 必须是 1 到 ${RUN_DEADLINE_MS} 的整数`);
  }

  const conditionOrder = parseConditionOrder(input.conditionOrder);
  const referenceTime = input.referenceTime ?? new Date().toISOString();
  const rawQueryCase = createH2RawQuerySmokeCase(input.smokeCase);
  const caseBySource: Record<H2RetrievalSource, SingleNodeSmokeCase> = {
    node_specific: input.smokeCase,
    raw_query: rawQueryCase,
  };
  const conditions: H2EvaluationArtifact["conditions"][number][] = [];

  for (const [index, source] of conditionOrder.entries()) {
    input.parentSignal?.throwIfAborted();

    const smokeCase = caseBySource[source];
    const result = await evaluateSingleNodeSmokeCase({
      smokeCase,
      searchProvider: input.searchProvider,
      rerankProvider: input.rerankProvider,
      rerankTimeoutMs: input.rerankTimeoutMs,
      readAttemptObservations: createObservationSliceReader(
        input.readAttemptObservations,
      ),
      readTokenUsages: createObservationSliceReader(input.readTokenUsages),
      runDeadlineMs,
      ...(input.parentSignal === undefined
        ? {}
        : { parentSignal: input.parentSignal }),
      now,
      referenceTime,
    });
    const node = buildSuccessfulNode(smokeCase, result);
    const conditionId = index === 0 ? "A" : "B";
    if (node === null) {
      throw new H2EvaluationError(conditionId, result.executionStatus);
    }
    conditions.push({ id: conditionId, source, node });
  }

  return H2EvaluationArtifactSchema.parse({
    version: "h2-evaluation.v1",
    query: input.smokeCase.originalQuery,
    conditions,
  });
}
