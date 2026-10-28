/**
 * 测试职责：冻结 WAY-18 的 SearchRequest（搜索请求）与 QueryAnalysis（查询分析）边界。
 *
 * 关键约束：
 * - Query（查询）先 trim，再按 Unicode code point（码点）校验 1～2000 长度。
 * - runId 只要求非空字符串，不收紧格式、长度，也不改写首尾空白。
 * - language 必须是当前唯一支持的 zh-CN，不允许缺失或静默回退。
 * - QueryAnalysis 七个字段全部必填，Strategy（策略）决定 Broad Query（广泛查询）的数量。
 * - 公共对象严格拒绝未知字段，公共类型从对应 Zod Schema 推导。
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import {
  QueryAnalysisSchema,
  SearchLanguageSchema,
  SearchRequestSchema,
} from "./index.js";
import type {
  QueryAnalysis,
  SearchLanguage,
  SearchRequest,
} from "./index.js";

describe("SearchRequest 请求边界", () => {
  const language = "zh-CN" as const;

  it("去除 Query 首尾空白并保留有效内容", () => {
    expect(
      SearchRequestSchema.parse({
        runId: "run-001",
        query: "  Python 入门  ",
        language,
      }),
    ).toEqual({
      runId: "run-001",
      query: "Python 入门",
      language,
    });
  });

  it.each([
    ["1 个 ASCII 字符", " a "],
    ["2000 个 ASCII 字符", ` ${"a".repeat(2000)} `],
    ["1 个非 BMP 码点", " 😀 "],
    ["2000 个非 BMP 码点", ` ${"😀".repeat(2000)} `],
  ])("接受 trim 后%s", (_name, query) => {
    expect(
      SearchRequestSchema.safeParse({ runId: "run-001", query, language })
        .success,
    ).toBe(true);
  });

  it.each([
    ["纯空白", " \t "],
    ["未限定格式与首尾空白", " arbitrary / identity? "],
    ["2001 个字符", "r".repeat(2001)],
  ])("runId 仅要求非空且保留原值：%s", (_name, runId) => {
    expect(
      SearchRequestSchema.parse({ runId, query: "Python", language }),
    ).toEqual({
      runId,
      query: "Python",
      language,
    });
  });

  it.each([
    ["缺少 runId", { query: "Python", language }],
    ["缺少 query", { runId: "run-001", language }],
    ["缺少 language", { runId: "run-001", query: "Python" }],
    ["非法 language", { runId: "run-001", query: "Python", language: "en" }],
    ["runId 为空", { runId: "", query: "Python", language }],
    ["runId 不是字符串", { runId: 1, query: "Python", language }],
    ["Query 不是字符串", { runId: "run-001", query: 1, language }],
    ["Query 为空", { runId: "run-001", query: "", language }],
    ["Query 全为空白", { runId: "run-001", query: " \t\n ", language }],
    [
      "trim 后有 2001 个 ASCII 字符",
      { runId: "run-001", query: ` ${"a".repeat(2001)} `, language },
    ],
    [
      "trim 后有 2001 个非 BMP 码点",
      { runId: "run-001", query: ` ${"😀".repeat(2001)} `, language },
    ],
    [
      "包含未知字段",
      { runId: "run-001", query: "Python", language, mode: "direct" },
    ],
  ])("拒绝%s", (_name, input) => {
    expect(SearchRequestSchema.safeParse(input).success).toBe(false);
  });

  it("SearchRequest 类型直接来自 Schema", () => {
    expectTypeOf<SearchRequest>().toEqualTypeOf<
      z.infer<typeof SearchRequestSchema>
    >();
  });

  it("搜索语言类型直接来自唯一公共 Schema", () => {
    expectTypeOf<SearchLanguage>().toEqualTypeOf<
      z.infer<typeof SearchLanguageSchema>
    >();
  });
});

const planFirstAnalysis = {
  intent: "learn",
  topic: "Python",
  freshnessSensitive: false,
  ambiguityLevel: "low",
  broadSearchQueries: [],
  strategy: "plan_first",
  presentationMode: "graph",
} as const;

const evidenceAssistedAnalysis = {
  ...planFirstAnalysis,
  broadSearchQueries: ["Python latest developments"],
  strategy: "evidence_assisted",
} as const;

const requiredAnalysisFields = [
  "intent",
  "topic",
  "freshnessSensitive",
  "ambiguityLevel",
  "broadSearchQueries",
  "strategy",
  "presentationMode",
] as const;

describe("QueryAnalysis 查询分析边界", () => {
  it.each(["graph", "compact"] as const)(
    "接受 plan_first 的 %s 展示模式和空 Broad Query 数组",
    presentationMode => {
      expect(
        QueryAnalysisSchema.safeParse({
          ...planFirstAnalysis,
          presentationMode,
        }).success,
      ).toBe(true);
    },
  );

  it.each([
    ["1 条", ["Python latest developments"]],
    [
      "3 条",
      [
        "Python latest developments",
        "Python release news",
        "Python ecosystem updates",
      ],
    ],
  ] as const)("接受 evidence_assisted 的%s Broad Query", (_name, queries) => {
    expect(
      QueryAnalysisSchema.safeParse({
        ...evidenceAssistedAnalysis,
        broadSearchQueries: queries,
      }).success,
    ).toBe(true);
  });

  it.each([
    ["plan_first", planFirstAnalysis],
    ["evidence_assisted", evidenceAssistedAnalysis],
  ] as const)("%s 拒绝缺少任一必填字段", (_strategy, analysis) => {
    for (const field of requiredAnalysisFields) {
      const input: Record<string, unknown> = { ...analysis };
      delete input[field];

      expect(QueryAnalysisSchema.safeParse(input).success).toBe(false);
    }
  });

  it.each([
    ["空 topic", { ...planFirstAnalysis, topic: "" }],
    [
      "错误类型的 freshnessSensitive",
      { ...planFirstAnalysis, freshnessSensitive: "false" },
    ],
    ["非法 intent", { ...planFirstAnalysis, intent: "research" }],
    [
      "非法 ambiguityLevel",
      { ...planFirstAnalysis, ambiguityLevel: "unknown" },
    ],
    ["非法 strategy", { ...planFirstAnalysis, strategy: "hybrid" }],
    [
      "direct 展示模式",
      { ...planFirstAnalysis, presentationMode: "direct" },
    ],
    ["plan_first 未知字段", { ...planFirstAnalysis, confidence: 0.95 }],
    [
      "evidence_assisted 未知字段",
      { ...evidenceAssistedAnalysis, confidence: 0.95 },
    ],
  ])("拒绝%s", (_name, input) => {
    expect(QueryAnalysisSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    [
      "plan_first 携带 Broad Query",
      { ...planFirstAnalysis, broadSearchQueries: ["Python"] },
    ],
    [
      "evidence_assisted 没有 Broad Query",
      { ...evidenceAssistedAnalysis, broadSearchQueries: [] },
    ],
    [
      "evidence_assisted 携带 4 条 Broad Query",
      {
        ...evidenceAssistedAnalysis,
        broadSearchQueries: ["q1", "q2", "q3", "q4"],
      },
    ],
    [
      "evidence_assisted 携带空字符串 Query",
      { ...evidenceAssistedAnalysis, broadSearchQueries: [""] },
    ],
  ])("拒绝%s并定位 broadSearchQueries", (_name, input) => {
    const result = QueryAnalysisSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          issue => issue.path[0] === "broadSearchQueries",
        ),
      ).toBe(true);
    }
  });

  it("QueryAnalysis 类型直接来自 Schema", () => {
    expectTypeOf<QueryAnalysis>().toEqualTypeOf<
      z.infer<typeof QueryAnalysisSchema>
    >();
  });
});
