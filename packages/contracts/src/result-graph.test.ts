/**
 * 测试职责：冻结 WAY-21 最终节点与 ResultGraph 根契约的局部结构边界。
 *
 * 关键约束：
 * - 最终节点只能是 ready、partial 或 failed，并由 status 决定合法字段组合。
 * - 本文件只测试单个对象可判定的规则；跨对象关系由 WAY-22 负责。
 * - Zod Schema 同时服务运行时校验、TypeScript 推导和后续 JSON Schema 生成。
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  ResultGraphNodeSchema,
  ResultGraphSchema,
} from "./index.js";
import type { ResultGraph, ResultGraphNode } from "./index.js";

const validSearchPlan = {
  queries: ["typescript strict mode"],
  rankingProfile: "software",
  providerHints: ["code"],
} as const;

const validNodeCore = {
  id: "node-001",
  title: "TypeScript 学习入口",
  description: "组织官方文档和高质量教程。",
  nodeType: "primary",
  layer: 0,
  searchPlan: validSearchPlan,
} as const;

const createResource = (index: number) => ({
  id: `resource-${index}`,
  title: `资源 ${index}`,
  url: `https://example.com/source-${index}`,
  canonicalUrl: `https://example.com/source-${index}`,
  domain: "example.com",
  sourceType: "documentation",
  summary: "经过规范化的资源摘要。",
  whySelected: "与节点主题直接相关。",
  rank: ((index - 1) % 8) + 1,
  searchProvider: "general",
});

const createResources = (count: number) =>
  Array.from({ length: count }, (_, index) => createResource(index + 1));

const validReadyNode = {
  ...validNodeCore,
  status: "ready",
  resources: createResources(1),
  warnings: [],
} as const;

const validPartialNode = {
  ...validNodeCore,
  status: "partial",
  resources: createResources(1),
  warnings: ["SEARCH_PROVIDER_PARTIAL"],
} as const;

const validFailedNode = {
  ...validNodeCore,
  status: "failed",
  resources: [],
  warnings: [],
  error: { code: "SEARCH_PROVIDER_FAILED", retryable: true },
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const hasPartialWarningsUniqueItems = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }

  const properties = value.properties;
  if (isRecord(properties)) {
    const status = properties.status;
    const warnings = properties.warnings;
    if (
      isRecord(status) &&
      status.const === "partial" &&
      isRecord(warnings) &&
      warnings.type === "array" &&
      warnings.minItems === 1 &&
      warnings.maxItems === 3 &&
      warnings.uniqueItems === true
    ) {
      return true;
    }
  }

  return Object.values(value).some(hasPartialWarningsUniqueItems);
};

describe("ResultGraphNode 最终节点边界", () => {
  it.each([1, 8])("ready 接受 %i 个 Resource 和必填空 warnings", count => {
    expect(
      ResultGraphNodeSchema.safeParse({
        ...validReadyNode,
        resources: createResources(count),
      }).success,
    ).toBe(true);
  });

  it.each([0, 9])("ready 拒绝 %i 个 Resource", count => {
    expect(
      ResultGraphNodeSchema.safeParse({
        ...validReadyNode,
        resources: createResources(count),
      }).success,
    ).toBe(false);
  });

  it.each([
    ["非空 warnings", { ...validReadyNode, warnings: ["RERANK_FAILED"] }],
    [
      "error 字段",
      {
        ...validReadyNode,
        error: { code: "UNKNOWN", retryable: false },
      },
    ],
  ])("ready 拒绝%s", (_name, input) => {
    expect(ResultGraphNodeSchema.safeParse(input).success).toBe(false);
  });

  it.each([1, 8])("partial 接受 %i 个 Resource 与合法唯一 Warning", count => {
    expect(
      ResultGraphNodeSchema.safeParse({
        ...validPartialNode,
        resources: createResources(count),
      }).success,
    ).toBe(true);
  });

  it("partial 接受三个不同的合法 Warning", () => {
    expect(
      ResultGraphNodeSchema.safeParse({
        ...validPartialNode,
        warnings: [
          "SEARCH_PROVIDER_PARTIAL",
          "EXTRACTION_FAILED",
          "RERANK_FAILED",
        ],
      }).success,
    ).toBe(true);
  });

  it.each([
    ["空 warnings", []],
    ["重复 warnings", ["RERANK_FAILED", "RERANK_FAILED"]],
    ["未知 Warning", ["UNKNOWN_WARNING"]],
  ])("partial 拒绝%s", (_name, warnings) => {
    expect(
      ResultGraphNodeSchema.safeParse({
        ...validPartialNode,
        warnings,
      }).success,
    ).toBe(false);
  });

  it("partial 拒绝 0 或 9 个 Resource，也拒绝 error 字段", () => {
    for (const resources of [createResources(0), createResources(9)]) {
      expect(
        ResultGraphNodeSchema.safeParse({
          ...validPartialNode,
          resources,
        }).success,
      ).toBe(false);
    }

    expect(
      ResultGraphNodeSchema.safeParse({
        ...validPartialNode,
        error: { code: "EXTRACTION_FAILED", retryable: true },
      }).success,
    ).toBe(false);
  });

  it("failed 只接受空 Resource、空 warnings 与严格 AppError", () => {
    expect(ResultGraphNodeSchema.parse(validFailedNode)).toEqual(
      validFailedNode,
    );

    for (const input of [
      { ...validFailedNode, resources: createResources(1) },
      { ...validFailedNode, warnings: ["SEARCH_PROVIDER_PARTIAL"] },
      {
        ...validFailedNode,
        error: { ...validFailedNode.error, providerMessage: "secret" },
      },
    ]) {
      expect(ResultGraphNodeSchema.safeParse(input).success).toBe(false);
    }
  });

  it.each([
    ["ready", "resources", validReadyNode],
    ["ready", "warnings", validReadyNode],
    ["partial", "resources", validPartialNode],
    ["partial", "warnings", validPartialNode],
    ["failed", "resources", validFailedNode],
    ["failed", "warnings", validFailedNode],
    ["failed", "error", validFailedNode],
  ] as const)("%s 拒绝缺少必填字段 %s", (_status, field, node) => {
    const input: Record<string, unknown> = { ...node };
    delete input[field];
    expect(ResultGraphNodeSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    ["ready", { ...validReadyNode, debugMessage: "unexpected" }],
    ["partial", { ...validPartialNode, debugMessage: "unexpected" }],
    ["failed", { ...validFailedNode, debugMessage: "unexpected" }],
  ])("%s 分支严格拒绝未知节点字段", (_status, input) => {
    expect(ResultGraphNodeSchema.safeParse(input).success).toBe(false);
  });

  it.each(["planned", "searching", "filtering", "unknown"])(
    "拒绝非最终状态：%s",
    status => {
      expect(
        ResultGraphNodeSchema.safeParse({
          ...validReadyNode,
          status,
        }).success,
      ).toBe(false);
    },
  );

  it("JSON Schema 保留 partial Warning 的数量和唯一性", () => {
    expect(
      hasPartialWarningsUniqueItems(z.toJSONSchema(ResultGraphNodeSchema)),
    ).toBe(true);
  });

  it("ResultGraphNode 类型直接来自 Schema", () => {
    expectTypeOf<ResultGraphNode>().toEqualTypeOf<
      z.infer<typeof ResultGraphNodeSchema>
    >();
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

const validResultGraph = {
  version: "0.1",
  runId: "run-001",
  query: {
    raw: "学习 TypeScript strict mode",
    normalized: "学习 typescript strict mode",
    language: "zh-CN",
  },
  analysis: validAnalysis,
  graph: {
    nodes: [validReadyNode],
    edges: [],
  },
  meta: {
    createdAt: "2026-10-17T08:00:00Z",
    providersUsed: ["general"],
    partial: false,
    timingMs: { total: 18 },
  },
} as const;

describe("ResultGraph 严格根契约", () => {
  it("接受完整且严格的 ResultGraph", () => {
    expect(ResultGraphSchema.parse(validResultGraph)).toEqual(validResultGraph);
  });

  it("拒绝缺少任一根必填字段", () => {
    for (const field of [
      "version",
      "runId",
      "query",
      "analysis",
      "graph",
      "meta",
    ] as const) {
      const input: Record<string, unknown> = { ...validResultGraph };
      delete input[field];
      expect(ResultGraphSchema.safeParse(input).success).toBe(false);
    }
  });

  it("拒绝 query、graph 或 meta 缺少嵌套必填字段", () => {
    const cases = [
      ["query", ["raw", "normalized", "language"]],
      ["graph", ["nodes", "edges"]],
      ["meta", ["createdAt", "providersUsed", "partial", "timingMs"]],
    ] as const;

    for (const [section, fields] of cases) {
      for (const field of fields) {
        const nested: Record<string, unknown> = {
          ...validResultGraph[section],
        };
        delete nested[field];
        expect(
          ResultGraphSchema.safeParse({
            ...validResultGraph,
            [section]: nested,
          }).success,
        ).toBe(false);
      }
    }
  });

  it.each([
    ["未知根字段", { ...validResultGraph, requestId: "request-001" }],
    ["错误版本", { ...validResultGraph, version: "0.2" }],
    ["空 runId", { ...validResultGraph, runId: "" }],
  ])("拒绝%s", (_name, input) => {
    expect(ResultGraphSchema.safeParse(input).success).toBe(false);
  });

  it.each([1, 2000])("query 接受 %i 个字符的 raw 与 normalized", length => {
    const value = "q".repeat(length);
    expect(
      ResultGraphSchema.safeParse({
        ...validResultGraph,
        query: { raw: value, normalized: value, language: "en" },
      }).success,
    ).toBe(true);
  });

  it.each([0, 2001])("query 拒绝 %i 个字符的 raw 或 normalized", length => {
    const value = "q".repeat(length);
    for (const field of ["raw", "normalized"] as const) {
      expect(
        ResultGraphSchema.safeParse({
          ...validResultGraph,
          query: {
            ...validResultGraph.query,
            [field]: value,
          },
        }).success,
      ).toBe(false);
    }
  });

  it("query 拒绝过短 language 与未知字段", () => {
    for (const query of [
      { ...validResultGraph.query, language: "z" },
      { ...validResultGraph.query, locale: "zh-CN" },
    ]) {
      expect(
        ResultGraphSchema.safeParse({ ...validResultGraph, query }).success,
      ).toBe(false);
    }
  });

  it("复用 QueryAnalysisSchema 并拒绝策略不一致", () => {
    expect(
      ResultGraphSchema.safeParse({
        ...validResultGraph,
        analysis: {
          ...validAnalysis,
          broadSearchQueries: ["typescript"],
        },
      }).success,
    ).toBe(false);
  });

  it.each([1, 8])("graph 接受 %i 个最终节点", nodeCount => {
    const nodes = Array.from({ length: nodeCount }, (_, index) => ({
      ...validReadyNode,
      id: `node-${index + 1}`,
    }));
    expect(
      ResultGraphSchema.safeParse({
        ...validResultGraph,
        graph: { ...validResultGraph.graph, nodes },
      }).success,
    ).toBe(true);
  });

  it.each([0, 9])("graph 拒绝 %i 个最终节点", nodeCount => {
    const nodes = Array.from({ length: nodeCount }, (_, index) => ({
      ...validReadyNode,
      id: `node-${index + 1}`,
    }));
    expect(
      ResultGraphSchema.safeParse({
        ...validResultGraph,
        graph: { ...validResultGraph.graph, nodes },
      }).success,
    ).toBe(false);
  });

  it("graph 接受复用 GraphEdgeSchema 的非空 Edge 数组", () => {
    const secondNode = { ...validReadyNode, id: "node-002" };
    expect(
      ResultGraphSchema.safeParse({
        ...validResultGraph,
        graph: {
          nodes: [validReadyNode, secondNode],
          edges: [
            {
              id: "edge-001",
              source: "node-001",
              target: "node-002",
              type: "recommended_next",
            },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it("graph 复用 GraphEdgeSchema 并保持严格", () => {
    for (const graph of [
      {
        ...validResultGraph.graph,
        edges: [
          {
            id: "edge-001",
            source: "node-001",
            target: "node-002",
            type: "depends_on",
          },
        ],
      },
      { ...validResultGraph.graph, layout: "force" },
    ]) {
      expect(
        ResultGraphSchema.safeParse({ ...validResultGraph, graph }).success,
      ).toBe(false);
    }
  });

  it("meta 接受带时区时间、可选 warnings 与非负 timingMs", () => {
    expect(
      ResultGraphSchema.safeParse({
        ...validResultGraph,
        meta: {
          ...validResultGraph.meta,
          createdAt: "2026-10-17T16:00:00+08:00",
          providersUsed: [],
          timingMs: { search: 0, total: 18.5 },
          warnings: ["结果使用了降级路径"],
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    [
      "无时区 createdAt",
      { ...validResultGraph.meta, createdAt: "2026-10-17T08:00:00" },
    ],
    [
      "重复 providersUsed",
      { ...validResultGraph.meta, providersUsed: ["general", "general"] },
    ],
    ["空 Provider ID", { ...validResultGraph.meta, providersUsed: [""] }],
    ["非 boolean partial", { ...validResultGraph.meta, partial: "false" }],
    ["负 timingMs", { ...validResultGraph.meta, timingMs: { search: -1 } }],
    ["未知字段", { ...validResultGraph.meta, costUsd: 0.01 }],
  ])("meta 拒绝%s", (_name, meta) => {
    expect(
      ResultGraphSchema.safeParse({ ...validResultGraph, meta }).success,
    ).toBe(false);
  });

  it("JSON Schema 保留 providersUsed 唯一性", () => {
    expect(z.toJSONSchema(ResultGraphSchema)).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        meta: {
          type: "object",
          additionalProperties: false,
          properties: {
            providersUsed: {
              type: "array",
              uniqueItems: true,
            },
          },
        },
      },
    });
  });

  it("ResultGraph 类型直接来自 Schema", () => {
    expectTypeOf<ResultGraph>().toEqualTypeOf<
      z.infer<typeof ResultGraphSchema>
    >();
  });
});
