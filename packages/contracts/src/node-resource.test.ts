/**
 * 测试职责：冻结 WAY-19 的 Resource、SearchPlan 与 GraphNodeCore 边界。
 *
 * 关键约束：
 * - 外部 URL 只允许绝对 HTTP(S)，公共对象严格拒绝未知字段。
 * - providerHints 唯一性、数量与 rank 由确定性 Schema 保证，不交给 Prompt。
 * - 公共 TypeScript 类型必须直接从对应 Zod Schema 推导。
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  GraphNodeCoreSchema,
  MAX_RETAINED_RESOURCES_PER_NODE,
  ResourceSchema,
  SearchPlanSchema,
} from "./index.js";
import type { GraphNodeCore, Resource, SearchPlan } from "./index.js";

const validResource = {
  id: "resource-001",
  title: "TypeScript Handbook",
  url: "https://www.typescriptlang.org/docs/",
  canonicalUrl: "https://www.typescriptlang.org/docs/",
  domain: "www.typescriptlang.org",
  sourceType: "official_docs",
  summary: "TypeScript 官方文档入口。",
  whySelected: "官方来源且覆盖语言核心能力。",
  rank: 1,
  scores: {
    relevance: 1,
    authority: 0,
  },
  searchProvider: "tavily",
  publishedAt: "2026-10-16T08:00:00+08:00",
} as const;

describe("Resource 公共资源边界", () => {
  it("接受完整 Resource 和省略可选字段的 Resource", () => {
    expect(ResourceSchema.parse(validResource)).toEqual(validResource);

    expect(
      ResourceSchema.safeParse({
        id: "resource-002",
        title: "Python Tutorial",
        url: "http://docs.python.org/3/tutorial/",
        canonicalUrl: "http://docs.python.org/3/tutorial/",
        domain: "docs.python.org",
        sourceType: "official_docs",
        summary: "Python 官方教程。",
        whySelected: "官方且适合入门。",
        rank: MAX_RETAINED_RESOURCES_PER_NODE,
        searchProvider: "tavily",
      }).success,
    ).toBe(true);
  });

  it.each([
    "http://example.com/resource",
    "https://example.com/resource",
    "HTTP://example.com/resource",
    "hTtPs://example.com/resource",
  ])("接受 HTTP(S) URL：%s", url => {
    expect(
      ResourceSchema.safeParse({
        ...validResource,
        url,
        canonicalUrl: url,
      }).success,
    ).toBe(true);
  });

  it.each([
    ["url", "ftp://example.com/resource"],
    ["url", "file:///tmp/resource"],
    ["url", "data:text/plain,resource"],
    ["url", "javascript:alert(1)"],
    ["url", "http://"],
    ["url", "/relative/resource"],
    ["canonicalUrl", "ftp://example.com/resource"],
    ["canonicalUrl", "example.com/resource"],
  ] as const)("拒绝 %s 的非 HTTP(S) 值：%s", (field, value) => {
    expect(
      ResourceSchema.safeParse({
        ...validResource,
        [field]: value,
      }).success,
    ).toBe(false);
  });

  it("URL 前导空白作为不可信输入时安全返回失败", () => {
    const input = {
      ...validResource,
      url: " https://example.com/resource",
    };

    expect(() => ResourceSchema.safeParse(input)).not.toThrow();
    expect(ResourceSchema.safeParse(input).success).toBe(false);
  });

  it("拒绝 Provider 私有未知字段", () => {
    expect(
      ResourceSchema.safeParse({
        ...validResource,
        providerPayload: { score: 0.9 },
      }).success,
    ).toBe(false);
  });

  it("固定 V0 retained 上限为 8", () => {
    expect(MAX_RETAINED_RESOURCES_PER_NODE).toBe(8);
  });

  it.each([1, 8])("接受 rank 边界 %i", rank => {
    expect(ResourceSchema.safeParse({ ...validResource, rank }).success).toBe(
      true,
    );
  });

  it.each([0, 1.5, 9, "1"])("拒绝非法 rank %s", rank => {
    expect(ResourceSchema.safeParse({ ...validResource, rank }).success).toBe(
      false,
    );
  });

  it("拒绝必填字符串为空", () => {
    for (const field of [
      "id",
      "title",
      "domain",
      "sourceType",
      "summary",
      "whySelected",
      "searchProvider",
    ] as const) {
      expect(
        ResourceSchema.safeParse({
          ...validResource,
          [field]: "",
        }).success,
      ).toBe(false);
    }
  });

  it("拒绝缺少任一必填字段", () => {
    for (const field of [
      "id",
      "title",
      "url",
      "canonicalUrl",
      "domain",
      "sourceType",
      "summary",
      "whySelected",
      "rank",
      "searchProvider",
    ] as const) {
      const input: Record<string, unknown> = { ...validResource };
      delete input[field];

      expect(ResourceSchema.safeParse(input).success).toBe(false);
    }
  });

  it("接受开放的 sourceType、searchProvider 与 score key", () => {
    expect(
      ResourceSchema.safeParse({
        ...validResource,
        sourceType: "custom_source_taxonomy",
        searchProvider: "provider-v2",
        scores: {
          customSignal: 0.5,
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["score 小于 0", { ...validResource, scores: { relevance: -0.01 } }],
    ["score 大于 1", { ...validResource, scores: { relevance: 1.01 } }],
    ["score 不是数字", { ...validResource, scores: { relevance: "1" } }],
    ["publishedAt 非 ISO 时间", { ...validResource, publishedAt: "today" }],
    [
      "publishedAt 没有时区",
      { ...validResource, publishedAt: "2026-10-16T08:00:00" },
    ],
  ])("拒绝%s", (_name, input) => {
    expect(ResourceSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    null,
    "2026-10-16T00:00:00Z",
    "2026-10-16T08:00:00+08:00",
  ])("接受 publishedAt：%s", publishedAt => {
    expect(
      ResourceSchema.safeParse({
        ...validResource,
        publishedAt,
      }).success,
    ).toBe(true);
  });

  it("Resource 类型直接来自 Schema", () => {
    expectTypeOf<Resource>().toEqualTypeOf<
      z.infer<typeof ResourceSchema>
    >();
  });
});

const validSearchPlan = {
  queries: ["typescript strict mode"],
  rankingProfile: "software",
  providerHints: ["code"],
} as const;

describe("SearchPlan 节点搜索计划边界", () => {
  it.each([
    [
      "最小数量",
      {
        queries: ["typescript"],
        rankingProfile: "software",
        providerHints: ["code"],
      },
    ],
    [
      "最大数量",
      {
        queries: ["typescript", "typescript docs", "typescript examples"],
        rankingProfile: "knowledge",
        providerHints: ["general", "code", "community"],
      },
    ],
  ] as const)("接受%s的 Query 和 Provider Hint", (_name, input) => {
    expect(SearchPlanSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ["0 条 Query", { ...validSearchPlan, queries: [] }],
    [
      "4 条 Query",
      { ...validSearchPlan, queries: ["q1", "q2", "q3", "q4"] },
    ],
    ["空字符串 Query", { ...validSearchPlan, queries: [""] }],
    ["0 个 Provider Hint", { ...validSearchPlan, providerHints: [] }],
    [
      "4 个 Provider Hint",
      {
        ...validSearchPlan,
        providerHints: ["general", "code", "community", "academic"],
      },
    ],
    ["未知 Provider Hint", { ...validSearchPlan, providerHints: ["web"] }],
    ["未知 Ranking Profile", { ...validSearchPlan, rankingProfile: "latest" }],
  ])("拒绝%s", (_name, input) => {
    expect(SearchPlanSchema.safeParse(input).success).toBe(false);
  });

  it("拒绝缺少任一必填字段", () => {
    for (const field of [
      "queries",
      "rankingProfile",
      "providerHints",
    ] as const) {
      const input: Record<string, unknown> = { ...validSearchPlan };
      delete input[field];

      expect(SearchPlanSchema.safeParse(input).success).toBe(false);
    }
  });

  it("拒绝重复 Provider Hint 并定位 providerHints", () => {
    const result = SearchPlanSchema.safeParse({
      ...validSearchPlan,
      providerHints: ["code", "code"],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(issue => issue.path[0] === "providerHints"),
      ).toBe(true);
    }
  });

  it("严格拒绝未知字段", () => {
    expect(
      SearchPlanSchema.safeParse({
        ...validSearchPlan,
        maxResults: 8,
      }).success,
    ).toBe(false);
  });

  it("JSON Schema 保留 Provider Hint 数量和唯一性", () => {
    expect(z.toJSONSchema(SearchPlanSchema)).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        providerHints: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
        },
      },
    });
  });

  it("SearchPlan 类型直接来自 Schema", () => {
    expectTypeOf<SearchPlan>().toEqualTypeOf<
      z.infer<typeof SearchPlanSchema>
    >();
  });
});

const validGraphNodeCore = {
  id: "node-001",
  title: "TypeScript 学习入口",
  description: "组织官方文档和高质量教程。",
  nodeType: "primary",
  layer: 0,
  searchPlan: validSearchPlan,
} as const;

describe("GraphNodeCore 节点共享结构边界", () => {
  it("接受完整的共享节点字段", () => {
    expect(GraphNodeCoreSchema.parse(validGraphNodeCore)).toEqual(
      validGraphNodeCore,
    );
  });

  it("拒绝必填字符串为空", () => {
    for (const field of ["id", "title", "description"] as const) {
      expect(
        GraphNodeCoreSchema.safeParse({
          ...validGraphNodeCore,
          [field]: "",
        }).success,
      ).toBe(false);
    }
  });

  it.each([
    ["未知 nodeType", { ...validGraphNodeCore, nodeType: "root" }],
    ["负数 layer", { ...validGraphNodeCore, layer: -1 }],
    ["小数 layer", { ...validGraphNodeCore, layer: 0.5 }],
    ["字符串 layer", { ...validGraphNodeCore, layer: "0" }],
    [
      "非法嵌套 SearchPlan",
      {
        ...validGraphNodeCore,
        searchPlan: { ...validSearchPlan, providerHints: [] },
      },
    ],
    [
      "后续阶段字段",
      {
        ...validGraphNodeCore,
        status: "planned",
        resources: [],
      },
    ],
  ])("拒绝%s", (_name, input) => {
    expect(GraphNodeCoreSchema.safeParse(input).success).toBe(false);
  });

  it("拒绝缺少任一必填字段", () => {
    for (const field of [
      "id",
      "title",
      "description",
      "nodeType",
      "layer",
      "searchPlan",
    ] as const) {
      const input: Record<string, unknown> = { ...validGraphNodeCore };
      delete input[field];

      expect(GraphNodeCoreSchema.safeParse(input).success).toBe(false);
    }
  });

  it("GraphNodeCore 类型直接来自 Schema", () => {
    expectTypeOf<GraphNodeCore>().toEqualTypeOf<
      z.infer<typeof GraphNodeCoreSchema>
    >();
  });
});
