/**
 * 模块职责：把一个 Graph Node（图节点）的 SearchPlan 确定性映射为 Provider 调用，
 * 并同时返回 Node 汇总与逐 Query（查询）结算。
 *
 * 关键边界：
 * - V0 的所有 providerHints 只选择唯一 Search Provider，每条 Query 恰好调用一次；
 * - Provider 已负责单次调用的 Timeout 与有界重试，本层只共享 Run Signal；
 * - 逐 Query 结果按深度稳定轮询，URL 可用性与去重仍属于后续 Pipeline；
 * - 原始调用合并后没有 Hit 就是搜索失败，不能伪装成局部成功。
 */
import {
  calculateSearchPlanMaxResults,
  type AppErrorCode,
  type GraphPlanNode,
  type NodeSearchOutcome,
  type ProviderSearchRequest,
  type QuerySearchOutcome,
  type SearchLanguage,
} from "@wayfinder/contracts";

import type { SearchProvider } from "./provider.js";
import { selectSearchProvider } from "./router.js";

/**
 * Provider 无法交付任何 Hit 时使用的稳定业务错误。
 * 具体 Provider 异常只进入脱敏 Run Log，不能通过 cause 泄漏到业务层。
 */
export class NodeSearchError extends Error {
  public readonly code: Extract<AppErrorCode, "SEARCH_PROVIDER_FAILED"> =
    "SEARCH_PROVIDER_FAILED";
  public readonly retryable = true;

  public constructor() {
    super("SEARCH_PROVIDER_FAILED");
    this.name = "NodeSearchError";
  }
}

export type RunNodeSearchesInput = {
  /** nodeId 必须来自 GraphNode.id，不能在 SearchPlan 中维护重复副本。 */
  node: Pick<GraphPlanNode, "id" | "searchPlan">;
  /** 该值来自 GraphPlan.analysis，确保 Planner 分析仍是单一事实来源。 */
  freshnessSensitive: boolean;
  /** V0 唯一真实 Provider；Selector 仍隔离具体 Adapter 与业务编排。 */
  searchProvider: SearchProvider;
  /** 整次 Run 共享的取消与绝对 Deadline Signal。 */
  signal: AbortSignal;
  language: SearchLanguage;
};

/** 为一条 Query 构造无 Provider 私有字段的统一请求。 */
function createProviderRequest(
  input: RunNodeSearchesInput,
  query: string,
): ProviderSearchRequest {
  return {
    kind: "node",
    nodeId: input.node.id,
    query,
    // 即使内部调用方绕过 Zod，也不能用任意字段值改变 Provider 调用预算。
    maxResults: calculateSearchPlanMaxResults(
      input.node.searchPlan.queries.length,
    ),
    // V0 所有 Hint 都映射到唯一 Provider 的通用搜索能力。
    capability: "general",
    freshnessSensitive: input.freshnessSensitive,
    language: input.language,
  };
}

/**
 * 按结果深度稳定轮询逐 Query Hit，同时保持 Query 顺序与各 Query 内 Provider 顺序。
 *
 * 这里不做 URL 校验、去重或数量截断：这些职责继续由后续确定性 Pipeline 负责，
 * 从而让重复或非法项被移除后，仍可从更深轮次补入合法候选。
 */
function mergeQueryHitsRoundRobin(
  queryOutcomes: readonly QuerySearchOutcome[],
): NodeSearchOutcome["hits"] {
  const hits: NodeSearchOutcome["hits"] = [];
  const maxDepth = queryOutcomes.reduce(
    (maximum, outcome) => Math.max(maximum, outcome.hits.length),
    0,
  );

  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const outcome of queryOutcomes) {
      const hit = outcome.hits[depth];
      if (hit !== undefined) {
        hits.push(hit);
      }
    }
  }

  return hits;
}

/**
 * 独立结算每条 Query；单次失败不抹掉其他成功结果，但空汇总绝不伪装为 partial。
 */
export async function runNodeSearches(
  input: RunNodeSearchesInput,
): Promise<NodeSearchOutcome> {
  input.signal.throwIfAborted();

  const provider = selectSearchProvider({
    providerHints: input.node.searchPlan.providerHints,
    searchProvider: input.searchProvider,
  });
  const settled = await Promise.allSettled(
    input.node.searchPlan.queries.map(query =>
      provider.search(createProviderRequest(input, query), input.signal),
    ),
  );

  // Adapter 必须原样传播取消；即使某实现错误地包装 reason，本层也以 Run Signal 为准。
  if (input.signal.aborted) {
    throw input.signal.reason;
  }

  const queryOutcomes: QuerySearchOutcome[] =
    input.node.searchPlan.queries.map((query, index) => {
      const outcome = settled[index];
      if (outcome === undefined) {
        // Promise.allSettled 保证等长；此分支只防止未来重构静默制造错位结果。
        throw new Error("Query 结算数量与 SearchPlan 不一致");
      }

      return outcome.status === "fulfilled"
        ? { query, hits: outcome.value, warnings: [] }
        : {
            query,
            hits: [],
            warnings: ["SEARCH_PROVIDER_PARTIAL"],
          };
    });
  const hits = mergeQueryHitsRoundRobin(queryOutcomes);

  if (hits.length === 0) {
    throw new NodeSearchError();
  }

  const hasRejectedQuery = settled.some(
    outcome => outcome.status === "rejected",
  );
  return {
    hits,
    warnings: hasRejectedQuery ? ["SEARCH_PROVIDER_PARTIAL"] : [],
    queryOutcomes,
  };
}
