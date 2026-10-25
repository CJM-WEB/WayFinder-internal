/**
 * 测试职责：冻结 WAY-20 的计划节点与 Graph Edge（图边）结构边界。
 *
 * 关键约束：
 * - 计划节点只允许 planned 状态，并继续复用完整 SearchPlan。
 * - 计划阶段不能提前混入 Resource、Warning 或 Error 等结果字段。
 * - Graph Edge 复用共享 EdgeTypeSchema，公共类型从对应 Zod Schema 推导。
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import {
  GraphEdgeSchema,
  GraphPlanNodeSchema,
  GraphPlanSchema,
} from "./index.js";
import type { GraphEdge, GraphPlan, GraphPlanNode } from "./index.js";

const validSearchPlan = {
  queries: ["typescript strict mode"],
  maxResults: 20,
  rankingProfile: "software",
  providerHints: ["code"],
} as const;

const validGraphPlanNode = {
  id: "node-001",
  title: "TypeScript 学习入口",
  description: "组织官方文档和高质量教程。",
  nodeType: "primary",
  layer: 0,
  searchPlan: validSearchPlan,
  status: "planned",
} as const;

describe("GraphPlanNode 计划节点边界", () => {
  it("接受带完整 SearchPlan 的 planned 节点", () => {
    expect(GraphPlanNodeSchema.parse(validGraphPlanNode)).toEqual(
      validGraphPlanNode,
    );
  });

  it.each(["searching", "filtering", "ready", "partial", "failed"])(
    "拒绝非 planned 状态：%s",
    status => {
      expect(
        GraphPlanNodeSchema.safeParse({
          ...validGraphPlanNode,
          status,
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    ["resources", []],
    ["warnings", ["RERANK_FAILED"]],
    ["error", { code: "UNKNOWN", retryable: false }],
  ] as const)("拒绝计划阶段的 %s 字段", (field, value) => {
    expect(
      GraphPlanNodeSchema.safeParse({
        ...validGraphPlanNode,
        [field]: value,
      }).success,
    ).toBe(false);
  });

  it("拒绝缺少 status 或 SearchPlan", () => {
    for (const field of ["status", "searchPlan"] as const) {
      const input: Record<string, unknown> = { ...validGraphPlanNode };
      delete input[field];

      expect(GraphPlanNodeSchema.safeParse(input).success).toBe(false);
    }
  });

  it("拒绝非法嵌套 SearchPlan", () => {
    expect(
      GraphPlanNodeSchema.safeParse({
        ...validGraphPlanNode,
        searchPlan: {
          ...validSearchPlan,
          queries: [],
        },
      }).success,
    ).toBe(false);
  });

  it("GraphPlanNode 类型直接来自 Schema", () => {
    expectTypeOf<GraphPlanNode>().toEqualTypeOf<
      z.infer<typeof GraphPlanNodeSchema>
    >();
  });
});

const validGraphEdge = {
  id: "edge-001",
  source: "node-001",
  target: "node-002",
  type: "recommended_next",
} as const;

describe("GraphEdge 图边结构边界", () => {
  it.each(["recommended_next", "related_to"] as const)(
    "接受共享 Edge type：%s",
    type => {
      expect(
        GraphEdgeSchema.safeParse({
          ...validGraphEdge,
          type,
        }).success,
      ).toBe(true);
    },
  );

  it("拒绝缺少任一必填字段", () => {
    for (const field of ["id", "source", "target", "type"] as const) {
      const input: Record<string, unknown> = { ...validGraphEdge };
      delete input[field];

      expect(GraphEdgeSchema.safeParse(input).success).toBe(false);
    }
  });

  it.each([
    ["空 id", { ...validGraphEdge, id: "" }],
    ["空 source", { ...validGraphEdge, source: "" }],
    ["空 target", { ...validGraphEdge, target: "" }],
    ["未知 type", { ...validGraphEdge, type: "depends_on" }],
    ["未知字段", { ...validGraphEdge, weight: 1 }],
  ])("拒绝%s", (_name, input) => {
    expect(GraphEdgeSchema.safeParse(input).success).toBe(false);
  });

  it("GraphEdge 类型直接来自 Schema", () => {
    expectTypeOf<GraphEdge>().toEqualTypeOf<z.infer<typeof GraphEdgeSchema>>();
  });
});

const validAnalysis = {
  intent: "learn",
  topic: "TypeScript",
  freshnessSensitive: false,
  ambiguityLevel: "low",
  broadSearchQueries: [],
  strategy: "plan_first",
  presentationMode: "graph",
} as const;

const validGraphPlan = {
  analysis: validAnalysis,
  nodes: [validGraphPlanNode],
  edges: [],
} as const;

describe("GraphPlan 严格根协议", () => {
  it("接受恰好包含 analysis、nodes 与 edges 的完整计划", () => {
    expect(GraphPlanSchema.parse(validGraphPlan)).toEqual(validGraphPlan);
  });

  it.each([1, 8])("接受 %i 个计划节点", nodeCount => {
    const nodes = Array.from({ length: nodeCount }, (_, index) => ({
      ...validGraphPlanNode,
      id: `node-${index + 1}`,
      layer: index,
    }));

    expect(
      GraphPlanSchema.safeParse({
        ...validGraphPlan,
        nodes,
      }).success,
    ).toBe(true);
  });

  it.each([0, 9])("拒绝 %i 个计划节点", nodeCount => {
    const nodes = Array.from({ length: nodeCount }, (_, index) => ({
      ...validGraphPlanNode,
      id: `node-${index + 1}`,
    }));

    expect(
      GraphPlanSchema.safeParse({
        ...validGraphPlan,
        nodes,
      }).success,
    ).toBe(false);
  });

  it("拒绝根缺少任一必填字段", () => {
    for (const field of ["analysis", "nodes", "edges"] as const) {
      const input: Record<string, unknown> = { ...validGraphPlan };
      delete input[field];

      expect(GraphPlanSchema.safeParse(input).success).toBe(false);
    }
  });

  it("严格拒绝根未知字段", () => {
    expect(
      GraphPlanSchema.safeParse({
        ...validGraphPlan,
        protocolVersion: "0.1",
      }).success,
    ).toBe(false);
  });

  it("拒绝 Node 的非法嵌套 SearchPlan 并定位失败路径", () => {
    const result = GraphPlanSchema.safeParse({
      ...validGraphPlan,
      nodes: [
        {
          ...validGraphPlanNode,
          searchPlan: {
            ...validSearchPlan,
            queries: [],
          },
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          issue =>
            issue.path[0] === "nodes" &&
            issue.path[1] === 0 &&
            issue.path[2] === "searchPlan",
        ),
      ).toBe(true);
    }
  });

  it("拒绝不符合 QueryAnalysis 策略的 analysis", () => {
    expect(
      GraphPlanSchema.safeParse({
        ...validGraphPlan,
        analysis: {
          ...validAnalysis,
          broadSearchQueries: ["typescript"],
        },
      }).success,
    ).toBe(false);
  });

  it("拒绝不符合 GraphEdge 协议的 Edge", () => {
    expect(
      GraphPlanSchema.safeParse({
        ...validGraphPlan,
        edges: [{ ...validGraphEdge, type: "depends_on" }],
      }).success,
    ).toBe(false);
  });

  it("GraphPlan 类型直接来自 Schema", () => {
    expectTypeOf<GraphPlan>().toEqualTypeOf<z.infer<typeof GraphPlanSchema>>();
  });
});
