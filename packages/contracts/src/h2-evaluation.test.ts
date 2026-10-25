/**
 * 测试职责：冻结 H2 本地评估工件的严格 A/B 配对与生产 ResultGraphNode 复用边界。
 */
import { describe, expect, it } from "vitest";

import {
  H2EvaluationArtifactSchema,
  type H2EvaluationArtifact,
} from "./index.js";

const resource: H2EvaluationArtifact["conditions"][number]["node"]["resources"][number] = {
  id: "resource-one",
  title: "Resource one",
  url: "https://example.com/one",
  canonicalUrl: "https://example.com/one",
  domain: "example.com",
  sourceType: "documentation",
  summary: "可用于 H2 比较的资源摘要。",
  whySelected: "与评估节点直接相关。",
  rank: 1,
  searchProvider: "test",
  publishedAt: null,
};

const node: H2EvaluationArtifact["conditions"][number]["node"] = {
  id: "node-one",
  title: "测试节点",
  description: "用于比较两种检索查询来源。",
  nodeType: "primary",
  layer: 0,
  searchPlan: {
    queries: ["node-specific query"],
    maxResults: 20,
    rankingProfile: "knowledge",
    providerHints: ["general"],
  },
  status: "ready",
  resources: [resource],
  warnings: [],
};

const validArtifact: H2EvaluationArtifact = {
  version: "h2-evaluation.v1",
  query: "original query",
  conditions: [
    { id: "A", source: "node_specific", node },
    {
      id: "B",
      source: "raw_query",
      node: {
        ...node,
        searchPlan: {
          ...node.searchPlan,
          queries: ["original query"],
        },
      },
    },
  ],
};

describe("H2 Evaluation Artifact", () => {
  it("接受同一 Node 的中性 A/B 与两种唯一来源", () => {
    expect(H2EvaluationArtifactSchema.parse(validArtifact)).toEqual(
      validArtifact,
    );
  });

  it.each([
    [
      "重复条件标识",
      {
        ...validArtifact,
        conditions: [
          validArtifact.conditions[0],
          { ...validArtifact.conditions[1], id: "A" },
        ],
      },
    ],
    [
      "重复检索来源",
      {
        ...validArtifact,
        conditions: [
          validArtifact.conditions[0],
          {
            ...validArtifact.conditions[1],
            source: "node_specific",
          },
        ],
      },
    ],
    [
      "不同 Node",
      {
        ...validArtifact,
        conditions: [
          validArtifact.conditions[0],
          {
            ...validArtifact.conditions[1],
            node: { ...validArtifact.conditions[1].node, id: "node-two" },
          },
        ],
      },
    ],
    [
      "失败条件",
      {
        ...validArtifact,
        conditions: [
          validArtifact.conditions[0],
          {
            ...validArtifact.conditions[1],
            node: {
              ...validArtifact.conditions[1].node,
              status: "failed",
              resources: [],
              warnings: [],
              error: { code: "SEARCH_PROVIDER_FAILED", retryable: true },
            },
          },
        ],
      },
    ],
    [
      "Raw 条件未使用工件 Query",
      {
        ...validArtifact,
        conditions: [
          validArtifact.conditions[0],
          {
            ...validArtifact.conditions[1],
            node: {
              ...validArtifact.conditions[1].node,
              searchPlan: {
                ...validArtifact.conditions[1].node.searchPlan,
                queries: ["another query"],
              },
            },
          },
        ],
      },
    ],
    [
      "两个条件使用相同原始 Query",
      {
        ...validArtifact,
        conditions: [
          {
            ...validArtifact.conditions[0],
            node: {
              ...validArtifact.conditions[0].node,
              searchPlan: {
                ...validArtifact.conditions[0].node.searchPlan,
                queries: [validArtifact.query],
              },
            },
          },
          validArtifact.conditions[1],
        ],
      },
    ],
    [
      "条件间改动 Ranking Profile",
      {
        ...validArtifact,
        conditions: [
          validArtifact.conditions[0],
          {
            ...validArtifact.conditions[1],
            node: {
              ...validArtifact.conditions[1].node,
              searchPlan: {
                ...validArtifact.conditions[1].node.searchPlan,
                rankingProfile: "general",
              },
            },
          },
        ],
      },
    ],
    [
      "条件间候选总预算不同",
      {
        ...validArtifact,
        conditions: [
          {
            ...validArtifact.conditions[0],
            node: {
              ...validArtifact.conditions[0].node,
              searchPlan: {
                ...validArtifact.conditions[0].node.searchPlan,
                queries: ["node query one", "node query two", "node query three"],
                maxResults: 6,
              },
            },
          },
          validArtifact.conditions[1],
        ],
      },
    ],
  ])("拒绝%s", (_name, input) => {
    expect(H2EvaluationArtifactSchema.safeParse(input).success).toBe(false);
  });

  it("严格拒绝未知根字段和未知条件字段", () => {
    expect(
      H2EvaluationArtifactSchema.safeParse({
        ...validArtifact,
        hiddenHint: "raw condition is B",
      }).success,
    ).toBe(false);
    expect(
      H2EvaluationArtifactSchema.safeParse({
        ...validArtifact,
        conditions: [
          { ...validArtifact.conditions[0], providerResponse: {} },
          validArtifact.conditions[1],
        ],
      }).success,
    ).toBe(false);
  });

  it.each([
    ["重复 Resource ID", { id: resource.id }],
    ["重复 canonical URL", { canonicalUrl: resource.canonicalUrl }],
    ["不连续 rank", { rank: 3 }],
  ])("拒绝%s", (_name, changedFields) => {
    const secondResource = {
      ...resource,
      id: "resource-two",
      url: "https://example.com/two",
      canonicalUrl: "https://example.com/two",
      rank: 2,
      ...changedFields,
    };
    expect(
      H2EvaluationArtifactSchema.safeParse({
        ...validArtifact,
        conditions: [
          {
            ...validArtifact.conditions[0],
            node: {
              ...validArtifact.conditions[0].node,
              resources: [resource, secondResource],
            },
          },
          validArtifact.conditions[1],
        ],
      }).success,
    ).toBe(false);
  });
});
