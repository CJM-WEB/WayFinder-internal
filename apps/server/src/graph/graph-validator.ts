/**
 * 模块职责：对已通过 GraphPlanSchema 的计划执行确定性跨对象校验。
 *
 * 边界约束：
 * - 只报告可由代码稳定判断的问题，不推断 Node 或 Query 的主观语义质量。
 * - 不修改输入，也不删除或补写 Node / Edge；确定性 Repair 属于 WAY-38。
 * - Finding 只包含稳定 code、Contract 路径和数字元数据，避免泄漏模型自由文本。
 */
import type { GraphEdge, GraphPlan } from "@wayfinder/contracts";

export type GraphPlanFindingCode =
  | "TOTAL_NODE_COUNT_OUT_OF_RANGE"
  | "COMPACT_NODE_COUNT_OUT_OF_RANGE"
  | "COMPACT_SINGLE_NODE_HAS_EDGES"
  | "GRAPH_PRIMARY_COUNT_OUT_OF_RANGE"
  | "HIGH_AMBIGUITY_DISAMBIGUATION_COUNT_OUT_OF_RANGE"
  | "RELATED_NODE_COUNT_EXCEEDED"
  | "EMPTY_NODE_TITLE"
  | "EMPTY_SEARCH_QUERY"
  | "UNSUPPORTED_PROVIDER_HINTS"
  | "DUPLICATE_NODE_ID"
  | "DUPLICATE_EDGE_ID"
  | "DANGLING_EDGE_SOURCE"
  | "DANGLING_EDGE_TARGET"
  | "DUPLICATE_RECOMMENDED_EDGE"
  | "DUPLICATE_RELATED_EDGE"
  | "RECOMMENDED_NEXT_CYCLE"
  | "GRAPH_ALL_NODES_ISOLATED"
  | "PRIMARY_NODE_WITHOUT_EDGE"
  | "RELATED_NODE_WITHOUT_ANCHOR"
  | "PRIMARY_SUBGRAPH_DISCONNECTED";

export type GraphPlanFinding = Readonly<{
  code: GraphPlanFindingCode;
  path: readonly (string | number)[];
  metadata?: Readonly<Record<string, number | readonly number[]>>;
}>;

export type GraphPlanValidationResult = Readonly<{
  valid: boolean;
  findings: readonly GraphPlanFinding[];
}>;

type ProjectedEdge = Readonly<{
  edgeIndex: number;
  sourceIndex: number;
  targetIndex: number;
  type: GraphEdge["type"];
}>;

const TOTAL_NODE_MIN = 1;
const TOTAL_NODE_MAX = 8;
const COMPACT_NODE_MIN = 1;
const COMPACT_NODE_MAX = 3;
const GRAPH_PRIMARY_MIN = 4;
const GRAPH_PRIMARY_MAX = 6;
const DISAMBIGUATION_NODE_MIN = 2;
const DISAMBIGUATION_NODE_MAX = 4;
const RELATED_NODE_MAX = 2;

/** 数量 Finding 使用统一结构，便于测试和后续 Repair 稳定消费。 */
function countFinding(
  code: GraphPlanFindingCode,
  actual: number,
  min: number,
  max: number,
): GraphPlanFinding {
  return {
    code,
    path: ["nodes"],
    metadata: { actual, min, max },
  };
}

/**
 * 判断增量加入 recommended_next 后是否成环。
 * adjacency 只保存此前未成环的边，因此命中的当前 Edge 就是数组顺序中最后闭环的 Edge。
 */
function canReach(
  adjacency: ReadonlyMap<number, ReadonlySet<number>>,
  start: number,
  target: number,
): boolean {
  if (start === target) {
    return true;
  }

  const visited = new Set<number>();
  const pending = [start];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) {
      continue;
    }

    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      if (next === target) {
        return true;
      }
      if (!visited.has(next)) {
        pending.push(next);
      }
    }
  }

  return false;
}

/** 以无向视角返回从起点可达的 Node index；只消费调用方批准的投影视图。 */
function collectReachableNodeIndexes(
  adjacency: ReadonlyMap<number, ReadonlySet<number>>,
  start: number,
): ReadonlySet<number> {
  const visited = new Set<number>();
  const pending = [start];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) {
      continue;
    }

    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        pending.push(next);
      }
    }
  }

  return visited;
}

function addUndirectedEdge(
  adjacency: Map<number, Set<number>>,
  source: number,
  target: number,
): void {
  const sourceNeighbors = adjacency.get(source) ?? new Set<number>();
  sourceNeighbors.add(target);
  adjacency.set(source, sourceNeighbors);

  const targetNeighbors = adjacency.get(target) ?? new Set<number>();
  targetNeighbors.add(source);
  adjacency.set(target, targetNeighbors);
}

/**
 * 按固定阶段和原数组索引生成 Finding；追加顺序就是公共的稳定顺序。
 * 输入已由 WAY-36 完成结构收窄，本函数不重新实现完整 Zod Contract。
 */
export function validateGraphPlan(plan: GraphPlan): GraphPlanValidationResult {
  const findings: GraphPlanFinding[] = [];
  const primaryCount = plan.nodes.filter(
    node => node.nodeType === "primary",
  ).length;
  const relatedCount = plan.nodes.filter(
    node => node.nodeType === "related",
  ).length;
  const disambiguationCount = plan.nodes.filter(
    node => node.nodeType === "disambiguation",
  ).length;

  // 阶段 1：模式与数量。高歧义例外只适用于 graph 且完全没有 Primary 的计划。
  if (
    plan.nodes.length < TOTAL_NODE_MIN ||
    plan.nodes.length > TOTAL_NODE_MAX
  ) {
    findings.push(
      countFinding(
        "TOTAL_NODE_COUNT_OUT_OF_RANGE",
        plan.nodes.length,
        TOTAL_NODE_MIN,
        TOTAL_NODE_MAX,
      ),
    );
  }

  const isHighAmbiguityDisambiguationCandidate =
    plan.analysis.presentationMode === "graph" &&
    plan.analysis.ambiguityLevel === "high" &&
    primaryCount === 0;
  const isHighAmbiguityDisambiguationGraph =
    isHighAmbiguityDisambiguationCandidate &&
    disambiguationCount >= DISAMBIGUATION_NODE_MIN &&
    disambiguationCount <= DISAMBIGUATION_NODE_MAX;

  if (plan.analysis.presentationMode === "compact") {
    if (
      plan.nodes.length < COMPACT_NODE_MIN ||
      plan.nodes.length > COMPACT_NODE_MAX
    ) {
      findings.push(
        countFinding(
          "COMPACT_NODE_COUNT_OUT_OF_RANGE",
          plan.nodes.length,
          COMPACT_NODE_MIN,
          COMPACT_NODE_MAX,
        ),
      );
    }

    if (plan.nodes.length === 1 && plan.edges.length > 0) {
      findings.push({
        code: "COMPACT_SINGLE_NODE_HAS_EDGES",
        path: ["edges"],
        metadata: { actual: plan.edges.length, max: 0 },
      });
    }
  } else if (isHighAmbiguityDisambiguationCandidate) {
    if (
      disambiguationCount < DISAMBIGUATION_NODE_MIN ||
      disambiguationCount > DISAMBIGUATION_NODE_MAX
    ) {
      findings.push(
        countFinding(
          "HIGH_AMBIGUITY_DISAMBIGUATION_COUNT_OUT_OF_RANGE",
          disambiguationCount,
          DISAMBIGUATION_NODE_MIN,
          DISAMBIGUATION_NODE_MAX,
        ),
      );
    }
  } else if (
    primaryCount < GRAPH_PRIMARY_MIN ||
    primaryCount > GRAPH_PRIMARY_MAX
  ) {
    findings.push(
      countFinding(
        "GRAPH_PRIMARY_COUNT_OUT_OF_RANGE",
        primaryCount,
        GRAPH_PRIMARY_MIN,
        GRAPH_PRIMARY_MAX,
      ),
    );
  }

  if (relatedCount > RELATED_NODE_MAX) {
    findings.push(
      countFinding(
        "RELATED_NODE_COUNT_EXCEEDED",
        relatedCount,
        0,
        RELATED_NODE_MAX,
      ),
    );
  }

  // 阶段 2：只补充 Schema 未覆盖的空白文本与 V0 Provider 能力硬约束。
  for (const [nodeIndex, node] of plan.nodes.entries()) {
    if (node.title.trim().length === 0) {
      findings.push({
        code: "EMPTY_NODE_TITLE",
        path: ["nodes", nodeIndex, "title"],
      });
    }

    for (const [queryIndex, query] of node.searchPlan.queries.entries()) {
      if (query.trim().length === 0) {
        findings.push({
          code: "EMPTY_SEARCH_QUERY",
          path: ["nodes", nodeIndex, "searchPlan", "queries", queryIndex],
        });
      }
    }

    if (
      node.searchPlan.providerHints.length !== 1 ||
      node.searchPlan.providerHints[0] !== "general"
    ) {
      findings.push({
        code: "UNSUPPORTED_PROVIDER_HINTS",
        path: ["nodes", nodeIndex, "searchPlan", "providerHints"],
      });
    }
  }

  // 阶段 3：Node ID。后续投影只认第一个同名 Node，避免重复对象伪造图结构。
  const firstNodeIndexById = new Map<string, number>();
  const canonicalNodeIndexes = new Set<number>();
  for (const [nodeIndex, node] of plan.nodes.entries()) {
    const firstIndex = firstNodeIndexById.get(node.id);
    if (firstIndex !== undefined) {
      findings.push({
        code: "DUPLICATE_NODE_ID",
        path: ["nodes", nodeIndex, "id"],
        metadata: { firstIndex },
      });
      continue;
    }

    firstNodeIndexById.set(node.id, nodeIndex);
    canonicalNodeIndexes.add(nodeIndex);
  }

  // 阶段 4：Edge ID。重复项仍接受端点诊断，但不会进入后续语义投影。
  const firstEdgeIndexById = new Map<string, number>();
  const canonicalEdgeIndexes = new Set<number>();
  for (const [edgeIndex, edge] of plan.edges.entries()) {
    const firstIndex = firstEdgeIndexById.get(edge.id);
    if (firstIndex !== undefined) {
      findings.push({
        code: "DUPLICATE_EDGE_ID",
        path: ["edges", edgeIndex, "id"],
        metadata: { firstIndex },
      });
      continue;
    }

    firstEdgeIndexById.set(edge.id, edgeIndex);
    canonicalEdgeIndexes.add(edgeIndex);
  }

  // 阶段 5：先完整报告端点，再构造只含首个 Edge ID 和有效端点的候选投影。
  const endpointValidEdges: ProjectedEdge[] = [];
  for (const [edgeIndex, edge] of plan.edges.entries()) {
    const sourceIndex = firstNodeIndexById.get(edge.source);
    const targetIndex = firstNodeIndexById.get(edge.target);

    if (sourceIndex === undefined) {
      findings.push({
        code: "DANGLING_EDGE_SOURCE",
        path: ["edges", edgeIndex, "source"],
      });
    }
    if (targetIndex === undefined) {
      findings.push({
        code: "DANGLING_EDGE_TARGET",
        path: ["edges", edgeIndex, "target"],
      });
    }

    if (
      canonicalEdgeIndexes.has(edgeIndex) &&
      sourceIndex !== undefined &&
      targetIndex !== undefined
    ) {
      endpointValidEdges.push({
        edgeIndex,
        sourceIndex,
        targetIndex,
        type: edge.type,
      });
    }
  }

  // 阶段 6：recommended_next 有方向；related_to 用规范化端点对进行无向判重。
  const firstSemanticEdgeIndex = new Map<string, number>();
  const projectedEdges: ProjectedEdge[] = [];
  for (const edge of endpointValidEdges) {
    const first =
      edge.type === "related_to"
        ? Math.min(edge.sourceIndex, edge.targetIndex)
        : edge.sourceIndex;
    const second =
      edge.type === "related_to"
        ? Math.max(edge.sourceIndex, edge.targetIndex)
        : edge.targetIndex;
    const semanticKey = `${edge.type}:${first}:${second}`;
    const duplicateOf = firstSemanticEdgeIndex.get(semanticKey);

    if (duplicateOf !== undefined) {
      findings.push({
        code:
          edge.type === "related_to"
            ? "DUPLICATE_RELATED_EDGE"
            : "DUPLICATE_RECOMMENDED_EDGE",
        path: ["edges", edge.edgeIndex],
        metadata: { firstIndex: duplicateOf },
      });
      continue;
    }

    firstSemanticEdgeIndex.set(semanticKey, edge.edgeIndex);
    projectedEdges.push(edge);
  }

  // 阶段 7：增量检查 DAG，只记录闭环 Edge，不在 Validator 中执行删除。
  const recommendedAdjacency = new Map<number, Set<number>>();
  for (const edge of projectedEdges) {
    if (edge.type !== "recommended_next") {
      continue;
    }

    if (
      canReach(
        recommendedAdjacency,
        edge.targetIndex,
        edge.sourceIndex,
      )
    ) {
      findings.push({
        code: "RECOMMENDED_NEXT_CYCLE",
        path: ["edges", edge.edgeIndex],
      });
      continue;
    }

    const targets = recommendedAdjacency.get(edge.sourceIndex) ?? new Set();
    targets.add(edge.targetIndex);
    recommendedAdjacency.set(edge.sourceIndex, targets);
  }

  // 自环不为任何 Node 提供结构连接；其余有效语义 Edge 可用于参与度和无向连通性。
  const structuralEdges = projectedEdges.filter(
    edge => edge.sourceIndex !== edge.targetIndex,
  );
  const participatingNodeIndexes = new Set<number>();
  for (const edge of structuralEdges) {
    participatingNodeIndexes.add(edge.sourceIndex);
    participatingNodeIndexes.add(edge.targetIndex);
  }

  // 阶段 8：只有 graph 多节点要求“不能全部孤立”；高歧义消歧图明确豁免。
  if (
    plan.analysis.presentationMode === "graph" &&
    plan.nodes.length > 1 &&
    !isHighAmbiguityDisambiguationGraph &&
    structuralEdges.length === 0
  ) {
    findings.push({
      code: "GRAPH_ALL_NODES_ISOLATED",
      path: ["edges"],
    });
  }

  const isCompactSingleNode =
    plan.analysis.presentationMode === "compact" && plan.nodes.length === 1;

  // 阶段 9：重复 Node 的后续副本不参与投影，避免同一个 ID 被重复报告结构问题。
  if (!isCompactSingleNode && !isHighAmbiguityDisambiguationGraph) {
    for (const [nodeIndex, node] of plan.nodes.entries()) {
      if (
        canonicalNodeIndexes.has(nodeIndex) &&
        node.nodeType === "primary" &&
        !participatingNodeIndexes.has(nodeIndex)
      ) {
        findings.push({
          code: "PRIMARY_NODE_WITHOUT_EDGE",
          path: ["nodes", nodeIndex],
        });
      }
    }
  }

  // 阶段 10：Related 只能由 related_to 锚定到 Primary 或 Disambiguation。
  const anchoredRelatedNodeIndexes = new Set<number>();
  for (const edge of structuralEdges) {
    if (edge.type !== "related_to") {
      continue;
    }

    const source = plan.nodes[edge.sourceIndex];
    const target = plan.nodes[edge.targetIndex];
    if (source === undefined || target === undefined) {
      continue;
    }

    if (source.nodeType === "related" && target.nodeType !== "related") {
      anchoredRelatedNodeIndexes.add(edge.sourceIndex);
    }
    if (target.nodeType === "related" && source.nodeType !== "related") {
      anchoredRelatedNodeIndexes.add(edge.targetIndex);
    }
  }

  for (const [nodeIndex, node] of plan.nodes.entries()) {
    if (
      canonicalNodeIndexes.has(nodeIndex) &&
      node.nodeType === "related" &&
      !anchoredRelatedNodeIndexes.has(nodeIndex)
    ) {
      findings.push({
        code: "RELATED_NODE_WITHOUT_ANCHOR",
        path: ["nodes", nodeIndex],
      });
    }
  }

  // 阶段 11：Primary 诱导子图按无向检查，Related 不能作为两个 Primary 的桥梁。
  if (!isCompactSingleNode && !isHighAmbiguityDisambiguationGraph) {
    const primaryNodeIndexes = plan.nodes
      .map((node, nodeIndex) => ({ node, nodeIndex }))
      .filter(
        ({ node, nodeIndex }) =>
          canonicalNodeIndexes.has(nodeIndex) && node.nodeType === "primary",
      )
      .map(({ nodeIndex }) => nodeIndex);

    if (primaryNodeIndexes.length > 1) {
      const primaryIndexSet = new Set(primaryNodeIndexes);
      const primaryAdjacency = new Map<number, Set<number>>();
      for (const edge of structuralEdges) {
        if (
          primaryIndexSet.has(edge.sourceIndex) &&
          primaryIndexSet.has(edge.targetIndex)
        ) {
          addUndirectedEdge(
            primaryAdjacency,
            edge.sourceIndex,
            edge.targetIndex,
          );
        }
      }

      const firstPrimaryIndex = primaryNodeIndexes[0];
      if (firstPrimaryIndex !== undefined) {
        const reachable = collectReachableNodeIndexes(
          primaryAdjacency,
          firstPrimaryIndex,
        );
        const disconnectedNodeIndexes = primaryNodeIndexes.filter(
          nodeIndex => !reachable.has(nodeIndex),
        );

        if (disconnectedNodeIndexes.length > 0) {
          findings.push({
            code: "PRIMARY_SUBGRAPH_DISCONNECTED",
            path: ["nodes"],
            metadata: { componentNodeIndexes: disconnectedNodeIndexes },
          });
        }
      }
    }
  }

  return { valid: findings.length === 0, findings };
}
