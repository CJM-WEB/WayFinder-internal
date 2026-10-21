/**
 * 测试职责：冻结 Graph Validator 的确定性硬规则、Finding 顺序与只读边界。
 *
 * 主观语义质量（例如标题是否“明显重复”、Query 是否足够贴合 Node）不在这里伪造规则；
 * 这些问题必须等待产品规则明确后再由 Eval 或新的确定性 Contract 覆盖。
 */
import { describe, expect, it } from "vitest";
import type {
  GraphEdge,
  GraphPlan,
  GraphPlanNode,
  NodeType,
  PresentationMode,
} from "@wayfinder/contracts";

import { validateGraphPlan } from "./graph-validator.js";

function makeNode(
  id: string,
  nodeType: NodeType = "primary",
  overrides: Partial<GraphPlanNode> = {},
): GraphPlanNode {
  return {
    id,
    title: `节点 ${id}`,
    description: `节点 ${id} 的检索目标`,
    nodeType,
    layer: 0,
    searchPlan: {
      queries: [`查询 ${id}`],
      maxResults: 20,
      rankingProfile: "knowledge",
      providerHints: ["general"],
    },
    status: "planned",
    ...overrides,
  };
}

function makeEdge(
  id: string,
  source: string,
  target: string,
  type: GraphEdge["type"] = "recommended_next",
): GraphEdge {
  return { id, source, target, type };
}

function makePlan(
  nodes: GraphPlanNode[],
  edges: GraphEdge[] = [],
  presentationMode: PresentationMode = "graph",
  ambiguityLevel: GraphPlan["analysis"]["ambiguityLevel"] = "low",
): GraphPlan {
  return {
    analysis: {
      intent: "learn",
      topic: "确定性验证",
      freshnessSensitive: false,
      ambiguityLevel,
      presentationMode,
      broadSearchQueries: [],
      strategy: "plan_first",
    },
    nodes,
    edges,
  };
}

function makePrimaryChain(count: number): GraphPlan {
  const nodes = Array.from({ length: count }, (_, index) =>
    makeNode(`primary-${index + 1}`),
  );
  const edges = Array.from({ length: Math.max(0, count - 1) }, (_, index) =>
    makeEdge(
      `edge-${index + 1}`,
      `primary-${index + 1}`,
      `primary-${index + 2}`,
    ),
  );
  return makePlan(nodes, edges);
}

function findingCodes(plan: GraphPlan): string[] {
  return validateGraphPlan(plan).findings.map(finding => finding.code);
}

describe("GraphPlan 确定性 Validator", () => {
  it("接受 compact 单节点、普通 graph 和高歧义纯消歧图", () => {
    const compact = makePlan([makeNode("only")], [], "compact");
    const graph = makePrimaryChain(4);
    const disambiguation = makePlan(
      [
        makeNode("meaning-a", "disambiguation"),
        makeNode("meaning-b", "disambiguation"),
      ],
      [],
      "graph",
      "high",
    );

    expect(validateGraphPlan(compact)).toEqual({ valid: true, findings: [] });
    expect(validateGraphPlan(graph)).toEqual({ valid: true, findings: [] });
    expect(validateGraphPlan(disambiguation)).toEqual({
      valid: true,
      findings: [],
    });
  });

  it.each([
    { count: 3, code: "GRAPH_PRIMARY_COUNT_OUT_OF_RANGE" },
    { count: 7, code: "GRAPH_PRIMARY_COUNT_OUT_OF_RANGE" },
  ])("强制执行 graph 的 Primary 数量边界：$count", ({ count, code }) => {
    expect(findingCodes(makePrimaryChain(count))).toContain(code);
  });

  it("强制执行 compact、Related 与总 Node 数量边界", () => {
    const compact = makePlan(
      Array.from({ length: 4 }, (_, index) => makeNode(`compact-${index}`)),
      [
        makeEdge("c-1", "compact-0", "compact-1"),
        makeEdge("c-2", "compact-1", "compact-2"),
        makeEdge("c-3", "compact-2", "compact-3"),
      ],
      "compact",
    );
    const tooManyRelated = makePlan(
      [
        ...makePrimaryChain(4).nodes,
        makeNode("related-1", "related"),
        makeNode("related-2", "related"),
        makeNode("related-3", "related"),
      ],
      [
        ...makePrimaryChain(4).edges,
        makeEdge("r-1", "related-1", "primary-1", "related_to"),
        makeEdge("r-2", "related-2", "primary-2", "related_to"),
        makeEdge("r-3", "related-3", "primary-3", "related_to"),
      ],
    );
    const totalNine = makePrimaryChain(9);

    expect(findingCodes(compact)).toContain(
      "COMPACT_NODE_COUNT_OUT_OF_RANGE",
    );
    expect(findingCodes(tooManyRelated)).toContain(
      "RELATED_NODE_COUNT_EXCEEDED",
    );
    expect(findingCodes(totalNine)).toContain(
      "TOTAL_NODE_COUNT_OUT_OF_RANGE",
    );
  });

  it.each([1, 5])(
    "高歧义纯消歧图只接受 2～4 个 Disambiguation：%s",
    count => {
      const plan = makePlan(
        Array.from({ length: count }, (_, index) =>
          makeNode(`meaning-${index}`, "disambiguation"),
        ),
        [],
        "graph",
        "high",
      );

      expect(findingCodes(plan)).toContain(
        "HIGH_AMBIGUITY_DISAMBIGUATION_COUNT_OUT_OF_RANGE",
      );
      if (count > 1) {
        expect(findingCodes(plan)).toContain("GRAPH_ALL_NODES_ISOLATED");
      }
    },
  );

  it("low ambiguity 与包含 Primary 的 high ambiguity 都不能误用消歧例外", () => {
    const lowAmbiguity = makePlan(
      Array.from({ length: 3 }, (_, index) =>
        makeNode(`meaning-${index}`, "disambiguation"),
      ),
      [],
      "graph",
      "low",
    );
    const highWithPrimary = makePrimaryChain(3);
    highWithPrimary.analysis.ambiguityLevel = "high";

    expect(findingCodes(lowAmbiguity)).toEqual([
      "GRAPH_PRIMARY_COUNT_OUT_OF_RANGE",
      "GRAPH_ALL_NODES_ISOLATED",
    ]);
    expect(findingCodes(highWithPrimary)).toContain(
      "GRAPH_PRIMARY_COUNT_OUT_OF_RANGE",
    );
    expect(findingCodes(highWithPrimary)).not.toContain(
      "HIGH_AMBIGUITY_DISAMBIGUATION_COUNT_OUT_OF_RANGE",
    );
  });

  it("compact 单节点必须保持空 Edge，Validator 只报告而不删除", () => {
    const plan = makePlan(
      [makeNode("only")],
      [makeEdge("self", "only", "only", "related_to")],
      "compact",
    );
    const before = structuredClone(plan);

    expect(validateGraphPlan(plan).findings).toEqual([
      {
        code: "COMPACT_SINGLE_NODE_HAS_EDGES",
        path: ["edges"],
        metadata: { actual: 1, max: 0 },
      },
    ]);
    expect(plan).toEqual(before);
  });

  it("只补充可确定的空白文本与 V0 Provider Hint 规则", () => {
    const invalidNode = makeNode("only", "primary", {
      title: " \n ",
      searchPlan: {
        queries: ["\t"],
        maxResults: 20,
        rankingProfile: "knowledge",
        providerHints: ["news"],
      },
    });

    expect(findingCodes(makePlan([invalidNode], [], "compact"))).toEqual([
      "EMPTY_NODE_TITLE",
      "EMPTY_SEARCH_QUERY",
      "UNSUPPORTED_PROVIDER_HINTS",
    ]);
  });

  it("按原索引稳定报告重复 ID、悬空端点与 Edge 语义重复", () => {
    const nodes = makePrimaryChain(4).nodes;
    const plan = makePlan(
      [...nodes, { ...nodes[0] } as GraphPlanNode],
      [
        makeEdge("same-id", "primary-1", "primary-2"),
        makeEdge("same-id", "missing-source", "missing-target"),
        makeEdge("reverse-a", "primary-1", "primary-2", "related_to"),
        makeEdge("reverse-b", "primary-2", "primary-1", "related_to"),
        makeEdge("same-direction", "primary-1", "primary-2"),
      ],
    );

    const selected = validateGraphPlan(plan).findings.filter(finding =>
      [
        "DUPLICATE_NODE_ID",
        "DUPLICATE_EDGE_ID",
        "DANGLING_EDGE_SOURCE",
        "DANGLING_EDGE_TARGET",
        "DUPLICATE_RELATED_EDGE",
        "DUPLICATE_RECOMMENDED_EDGE",
      ].includes(finding.code),
    );

    expect(selected).toEqual([
      {
        code: "DUPLICATE_NODE_ID",
        path: ["nodes", 4, "id"],
        metadata: { firstIndex: 0 },
      },
      {
        code: "DUPLICATE_EDGE_ID",
        path: ["edges", 1, "id"],
        metadata: { firstIndex: 0 },
      },
      { code: "DANGLING_EDGE_SOURCE", path: ["edges", 1, "source"] },
      { code: "DANGLING_EDGE_TARGET", path: ["edges", 1, "target"] },
      {
        code: "DUPLICATE_RELATED_EDGE",
        path: ["edges", 3],
        metadata: { firstIndex: 2 },
      },
      {
        code: "DUPLICATE_RECOMMENDED_EDGE",
        path: ["edges", 4],
        metadata: { firstIndex: 0 },
      },
    ]);
  });

  it("只让 recommended_next 参与 DAG，并定位最后闭环的 Edge", () => {
    const plan = makePlan(makePrimaryChain(4).nodes, [
      makeEdge("a-b", "primary-1", "primary-2"),
      makeEdge("b-c", "primary-2", "primary-3"),
      makeEdge("c-a", "primary-3", "primary-1"),
      makeEdge("c-d", "primary-3", "primary-4", "related_to"),
    ]);
    const before = structuredClone(plan);

    expect(
      validateGraphPlan(plan).findings.filter(
        finding => finding.code === "RECOMMENDED_NEXT_CYCLE",
      ),
    ).toEqual([{ code: "RECOMMENDED_NEXT_CYCLE", path: ["edges", 2] }]);
    expect(plan).toEqual(before);
  });

  it("把 recommended_next 自环视为 cycle，且不把自环算作结构参与", () => {
    const plan = makePlan(makePrimaryChain(4).nodes, [
      makeEdge("self", "primary-1", "primary-1"),
      makeEdge("two-three", "primary-2", "primary-3"),
      makeEdge("three-four", "primary-3", "primary-4"),
    ]);

    const result = validateGraphPlan(plan);
    expect(result.findings).toContainEqual({
      code: "RECOMMENDED_NEXT_CYCLE",
      path: ["edges", 0],
    });
    expect(result.findings).toContainEqual({
      code: "PRIMARY_NODE_WITHOUT_EDGE",
      path: ["nodes", 0],
    });
  });

  it("要求 Primary 参与 Edge，并检查 Primary 诱导子图的无向连通性", () => {
    const plan = makePlan(makePrimaryChain(4).nodes, [
      makeEdge("one-related", "primary-1", "related", "related_to"),
      makeEdge("related-two", "related", "primary-2", "related_to"),
      makeEdge("three-four", "primary-3", "primary-4"),
    ]);
    plan.nodes.push(makeNode("related", "related"));

    const result = validateGraphPlan(plan);
    expect(result.findings).not.toContainEqual({
      code: "PRIMARY_NODE_WITHOUT_EDGE",
      path: ["nodes", 0],
    });
    expect(findingCodes(plan)).toContain("PRIMARY_SUBGRAPH_DISCONNECTED");
  });

  it("Related 只能通过 related_to 锚定到非 Related Node", () => {
    const invalid = makePlan(
      [
        ...makePrimaryChain(4).nodes,
        makeNode("related-a", "related"),
        makeNode("related-b", "related"),
      ],
      [
        ...makePrimaryChain(4).edges,
        makeEdge("recommended", "primary-1", "related-a"),
        makeEdge("related-chain", "related-a", "related-b", "related_to"),
      ],
    );
    const validDisambiguationAnchor = makePlan(
      [
        makeNode("meaning-a", "disambiguation"),
        makeNode("meaning-b", "disambiguation"),
        makeNode("related", "related"),
      ],
      [makeEdge("anchor", "related", "meaning-a", "related_to")],
      "graph",
      "high",
    );

    expect(
      validateGraphPlan(invalid).findings.filter(
        finding => finding.code === "RELATED_NODE_WITHOUT_ANCHOR",
      ),
    ).toEqual([
      { code: "RELATED_NODE_WITHOUT_ANCHOR", path: ["nodes", 4] },
      { code: "RELATED_NODE_WITHOUT_ANCHOR", path: ["nodes", 5] },
    ]);
    expect(validateGraphPlan(validDisambiguationAnchor)).toEqual({
      valid: true,
      findings: [],
    });
  });

  it("同一输入和克隆输入产生完全一致的 Finding 顺序", () => {
    const plan = makePlan(
      [makeNode("same"), makeNode("same"), makeNode("related", "related")],
      [
        makeEdge("same-edge", "same", "related"),
        makeEdge("same-edge", "missing-a", "missing-b"),
        makeEdge("self", "same", "same"),
      ],
    );
    const before = structuredClone(plan);
    const first = validateGraphPlan(plan);
    const second = validateGraphPlan(structuredClone(plan));

    expect(second).toEqual(first);
    expect(plan).toEqual(before);
    expect(first.valid).toBe(false);
  });
});
