/**
 * 测试职责：冻结 Graph Repair 的稳定删除顺序、纯函数边界与残余 Finding 语义。
 *
 * Repair 只证明“安全删除已有结构”；不会通过补造 Node、Edge、Query、URL 或 Resource
 * 把不可修复计划伪装为成功，也不会在本层触发 WAY-39 retry / fallback。
 */
import { describe, expect, it } from "vitest";
import type {
  GraphEdge,
  GraphPlan,
  GraphPlanNode,
  NodeType,
  PresentationMode,
} from "@wayfinder/contracts";

import { repairGraphPlan } from "./graph-repair.js";

function makeNode(id: string, nodeType: NodeType = "primary"): GraphPlanNode {
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
      topic: "确定性修复",
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
  return makePlan(
    Array.from({ length: count }, (_, index) =>
      makeNode(`primary-${index + 1}`),
    ),
    Array.from({ length: Math.max(0, count - 1) }, (_, index) =>
      makeEdge(
        `edge-${index + 1}`,
        `primary-${index + 1}`,
        `primary-${index + 2}`,
      ),
    ),
  );
}

describe("GraphPlan 确定性 Repair", () => {
  it("合法 compact 与 graph 保持内容不变且无需修复", () => {
    const compact = makePlan([makeNode("only")], [], "compact");
    const graph = makePrimaryChain(4);

    expect(repairGraphPlan(compact)).toEqual({
      plan: compact,
      repaired: false,
      validation: { valid: true, findings: [] },
    });
    expect(repairGraphPlan(graph)).toEqual({
      plan: graph,
      repaired: false,
      validation: { valid: true, findings: [] },
    });
  });

  it("先保留前两个 Related，再按 compact 上限保留剩余前三个 Node", () => {
    const plan = makePlan(
      [
        makeNode("related-1", "related"),
        makeNode("related-2", "related"),
        makeNode("related-3", "related"),
        makeNode("primary"),
      ],
      [
        makeEdge("anchor-1", "related-1", "primary", "related_to"),
        makeEdge("anchor-2", "related-2", "primary", "related_to"),
        makeEdge("anchor-3", "related-3", "primary", "related_to"),
      ],
      "compact",
    );

    const result = repairGraphPlan(plan);

    expect(result.plan.nodes.map(node => node.id)).toEqual([
      "related-1",
      "related-2",
      "primary",
    ]);
    expect(result.plan.edges.map(edge => edge.id)).toEqual([
      "anchor-1",
      "anchor-2",
    ]);
    expect(result.repaired).toBe(true);
    expect(result.validation).toEqual({ valid: true, findings: [] });
  });

  it("普通 graph 保留前六个 Primary，并清理指向被删 Node 的 Edge", () => {
    const plan = makePrimaryChain(7);

    const result = repairGraphPlan(plan);

    expect(result.plan.nodes.map(node => node.id)).toEqual([
      "primary-1",
      "primary-2",
      "primary-3",
      "primary-4",
      "primary-5",
      "primary-6",
    ]);
    expect(result.plan.edges.map(edge => edge.id)).toEqual([
      "edge-1",
      "edge-2",
      "edge-3",
      "edge-4",
      "edge-5",
    ]);
    expect(result.validation.valid).toBe(true);
  });

  it("高歧义纯消歧图保留前四个 Disambiguation", () => {
    const plan = makePlan(
      Array.from({ length: 5 }, (_, index) =>
        makeNode(`meaning-${index + 1}`, "disambiguation"),
      ),
      [],
      "graph",
      "high",
    );

    const result = repairGraphPlan(plan);

    expect(result.plan.nodes.map(node => node.id)).toEqual([
      "meaning-1",
      "meaning-2",
      "meaning-3",
      "meaning-4",
    ]);
    expect(result.validation).toEqual({ valid: true, findings: [] });
  });

  it("compact 修复为单节点时删除全部 Edge", () => {
    const plan = makePlan(
      [makeNode("only")],
      [makeEdge("self", "only", "only", "related_to")],
      "compact",
    );
    const before = structuredClone(plan);

    const result = repairGraphPlan(plan);

    expect(result.plan.edges).toEqual([]);
    expect(result.validation.valid).toBe(true);
    expect(plan).toEqual(before);
  });

  it("稳定删除重复 Edge ID、同向 recommended_next 与对称 related_to", () => {
    const nodes = [
      ...makePrimaryChain(4).nodes,
      makeNode("related", "related"),
    ];
    const plan = makePlan(nodes, [
      makeEdge("edge-1", "primary-1", "primary-2"),
      makeEdge("edge-1", "primary-2", "primary-3"),
      makeEdge("edge-2", "primary-2", "primary-3"),
      makeEdge("edge-3", "primary-3", "primary-4"),
      makeEdge("anchor", "related", "primary-1", "related_to"),
      makeEdge("reverse-anchor", "primary-1", "related", "related_to"),
      makeEdge("same-path", "primary-1", "primary-2"),
      makeEdge("different-type", "primary-1", "primary-2", "related_to"),
    ]);

    const result = repairGraphPlan(plan);

    expect(result.plan.edges.map(edge => edge.id)).toEqual([
      "edge-1",
      "edge-2",
      "edge-3",
      "anchor",
      "different-type",
    ]);
    expect(result.validation.valid).toBe(true);
  });

  it("严格先去重再删悬空 Edge，不用后出现的合法重复项替换前项", () => {
    const nodes = makePrimaryChain(4).nodes;
    const plan = makePlan(nodes, [
      makeEdge("duplicate", "missing", "primary-2"),
      makeEdge("duplicate", "primary-1", "primary-2"),
      makeEdge("edge-2", "primary-2", "primary-3"),
      makeEdge("edge-3", "primary-3", "primary-4"),
    ]);

    const result = repairGraphPlan(plan);

    expect(result.plan.edges.map(edge => edge.id)).toEqual([
      "edge-2",
      "edge-3",
    ]);
    expect(result.validation.valid).toBe(false);
    expect(result.validation.findings.map(finding => finding.code)).toContain(
      "PRIMARY_NODE_WITHOUT_EDGE",
    );
  });

  it("删除最后闭环的 recommended_next Edge 与自环，不把 related_to 当作 DAG", () => {
    const plan = makePlan(makePrimaryChain(4).nodes, [
      makeEdge("a-b", "primary-1", "primary-2"),
      makeEdge("b-c", "primary-2", "primary-3"),
      makeEdge("c-a", "primary-3", "primary-1"),
      makeEdge("self", "primary-4", "primary-4"),
      makeEdge("c-d", "primary-3", "primary-4", "related_to"),
    ]);

    const result = repairGraphPlan(plan);

    expect(result.plan.edges.map(edge => edge.id)).toEqual([
      "a-b",
      "b-c",
      "c-d",
    ]);
    expect(result.validation.valid).toBe(true);
  });

  it("不可安全修复的 Finding 保留给 WAY-39，不补造内容", () => {
    const plan = makePrimaryChain(3);
    const before = structuredClone(plan);

    const result = repairGraphPlan(plan);

    expect(result.repaired).toBe(false);
    expect(result.plan).toEqual(plan);
    expect(result.validation.valid).toBe(false);
    expect(result.validation.findings.map(finding => finding.code)).toContain(
      "GRAPH_PRIMARY_COUNT_OUT_OF_RANGE",
    );
    expect(plan).toEqual(before);
  });

  it("组合缺陷按固定阶段修复，结果稳定且所有保留对象都来自输入", () => {
    const plan = makePrimaryChain(7);
    plan.edges = [
      makeEdge("one-two", "primary-1", "primary-2"),
      makeEdge("two-three", "primary-2", "primary-3"),
      makeEdge("three-one", "primary-3", "primary-1"),
      makeEdge("three-four", "primary-3", "primary-4"),
      makeEdge("four-five", "primary-4", "primary-5"),
      makeEdge("five-six", "primary-5", "primary-6"),
      makeEdge("six-seven", "primary-6", "primary-7"),
      makeEdge("three-four", "primary-1", "primary-4"),
      makeEdge("same-path", "primary-1", "primary-2"),
      makeEdge("dangling", "missing", "primary-1"),
    ];
    const before = structuredClone(plan);

    const first = repairGraphPlan(plan);
    const second = repairGraphPlan(structuredClone(plan));

    expect(second).toEqual(first);
    expect(first.plan.nodes.map(node => node.id)).toEqual([
      "primary-1",
      "primary-2",
      "primary-3",
      "primary-4",
      "primary-5",
      "primary-6",
    ]);
    expect(first.plan.edges.map(edge => edge.id)).toEqual([
      "one-two",
      "two-three",
      "three-four",
      "four-five",
      "five-six",
    ]);
    expect(first.validation).toEqual({ valid: true, findings: [] });
    expect(first.plan.analysis).toEqual(plan.analysis);
    expect(Object.keys(first.plan).sort()).toEqual([
      "analysis",
      "edges",
      "nodes",
    ]);
    for (const node of first.plan.nodes) {
      expect(plan.nodes).toContain(node);
    }
    for (const edge of first.plan.edges) {
      expect(plan.edges).toContain(edge);
    }
    expect(plan).toEqual(before);
  });
});
