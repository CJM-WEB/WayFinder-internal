/**
 * 测试职责：冻结全图 Bundle 单次生成、双射、Query 唯一门禁与确定性 GraphPlan 装配。
 */
import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  createDeferred,
  createFixedClock,
  FakeLLMProvider,
} from "../../../../tests/support/test-infrastructure.mjs";
import {
  GraphOutlineSchema,
  type GraphOutline,
} from "./graph-outline.js";
import {
  LLMProviderError,
  type LLMProvider,
} from "./llm-provider.js";
import { SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT } from "./prompts/search-plan-generator.v1.js";
import {
  SearchPlanBundleSchema,
  SearchPlanGenerationError,
  assembleGraphPlan,
  generateSearchPlanBundle,
  normalizeSearchPlanQueryKey,
  type SearchPlanBundle,
  type SearchPlanBundleValidationDiagnostic,
} from "./search-plan-generator.js";

const QUERY = "什么是 MySQL";

function createOutline(): GraphOutline {
  return GraphOutlineSchema.parse({
    analysis: {
      intent: "learn",
      topic: "MySQL",
      freshnessSensitive: false,
      ambiguityLevel: "low",
      presentationMode: "compact",
      broadSearchQueries: [],
      strategy: "plan_first",
    },
    nodes: [
      {
        id: "mysql-overview",
        title: "MySQL 概览",
        description: "理解 MySQL 的定位与用途。",
        nodeType: "primary",
        layer: 0,
        status: "planned",
      },
      {
        id: "mysql-architecture",
        title: "关键架构",
        description: "理解 MySQL 的核心架构与存储引擎。",
        nodeType: "primary",
        layer: 1,
        status: "planned",
      },
    ],
    edges: [
      {
        id: "overview-to-architecture",
        source: "mysql-overview",
        target: "mysql-architecture",
        type: "recommended_next",
      },
    ],
  });
}

function createBundle(): SearchPlanBundle {
  return SearchPlanBundleSchema.parse({
    plans: [
      {
        nodeId: "mysql-overview",
        queries: ["MySQL 是什么", "MySQL 数据库主要用途"],
        rankingProfile: "knowledge",
      },
      {
        nodeId: "mysql-architecture",
        queries: ["MySQL 核心架构 存储引擎"],
        rankingProfile: "software",
      },
    ],
  });
}

function createArgs(
  provider: LLMProvider,
  overrides: Partial<{
    outline: GraphOutline;
    signal: AbortSignal;
    timeoutMs: number;
    now: () => number;
    onValidationDiagnostic: (
      diagnostic: SearchPlanBundleValidationDiagnostic,
    ) => void;
  }> = {},
) {
  const base = {
    query: QUERY,
    language: "zh-CN" as const,
    outline: overrides.outline ?? createOutline(),
    provider,
    signal: overrides.signal ?? new AbortController().signal,
    timeoutMs: overrides.timeoutMs ?? 9_000,
    onValidationDiagnostic:
      overrides.onValidationDiagnostic ?? (() => undefined),
  };
  return overrides.now === undefined
    ? base
    : { ...base, now: overrides.now };
}

describe("SearchPlan Generator", () => {
  it("一次全图调用携带原始 Query、语言、完整 Outline 与内部 Schema", async () => {
    const outline = createOutline();
    const bundle = createBundle();
    const provider = new FakeLLMProvider([bundle]);
    const signal = new AbortController().signal;
    const clock = createFixedClock(100);

    await expect(
      generateSearchPlanBundle(
        createArgs(provider, { outline, signal, now: clock.now }),
      ),
    ).resolves.toEqual(bundle);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.input).toMatchObject({
      system: SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT,
      schemaName: "search_plan_bundle",
      schema: z.toJSONSchema(SearchPlanBundleSchema, {
        target: "draft-2020-12",
        io: "input",
        unrepresentable: "throw",
        reused: "inline",
      }),
    });
    expect(JSON.parse(provider.calls[0]?.input.user ?? "")).toEqual({
      query: QUERY,
      language: "zh-CN",
      outline,
    });
    expect(provider.calls[0]?.options).toEqual({ signal, timeoutMs: 9_000 });
  });

  it("按 Outline 顺序装配并确定 maxResults 与 providerHints", () => {
    const outline = createOutline();
    const reversed = SearchPlanBundleSchema.parse({
      plans: [...createBundle().plans].reverse(),
    });

    const graphPlan = assembleGraphPlan(outline, reversed);

    expect(graphPlan.nodes.map(node => node.id)).toEqual([
      "mysql-overview",
      "mysql-architecture",
    ]);
    expect(graphPlan.nodes[0]?.searchPlan).toEqual({
      queries: ["MySQL 是什么", "MySQL 数据库主要用途"],
      maxResults: 10,
      rankingProfile: "knowledge",
      providerHints: ["general"],
    });
    expect(graphPlan.nodes[1]?.searchPlan.maxResults).toBe(20);
  });

  it.each([
    {
      name: "缺失 Node",
      bundle: {
        plans: [createBundle().plans[0]],
      },
    },
    {
      name: "重复 Node",
      bundle: {
        plans: [createBundle().plans[0], createBundle().plans[0]],
      },
    },
    {
      name: "未知 Node",
      bundle: {
        plans: [
          createBundle().plans[0],
          { ...createBundle().plans[1], nodeId: "unknown" },
        ],
      },
    },
  ])("$name 违反双射时失败", async ({ bundle }) => {
    const provider = new FakeLLMProvider([
      SearchPlanBundleSchema.parse(bundle),
    ]);
    await expect(generateSearchPlanBundle(createArgs(provider))).rejects.toEqual(
      new SearchPlanGenerationError("node_mapping_invalid"),
    );
  });

  it("同 Node 与跨 Node 都使用同一个 Unicode 精确唯一门禁", async () => {
    expect(normalizeSearchPlanQueryKey(" ＭｙＳＱＬ\u00a0  架构 ")).toBe(
      "mysql 架构",
    );
    expect(normalizeSearchPlanQueryKey("\u0085MySQL\u0085架构\u0085")).toBe(
      "mysql 架构",
    );
    expect(normalizeSearchPlanQueryKey("\u0085")).toBe("");

    const sameNode = SearchPlanBundleSchema.parse({
      plans: [
        {
          nodeId: "mysql-overview",
          queries: ["MySQL 架构", " ＭｙＳＱＬ\u00a0架构 "],
          rankingProfile: "knowledge",
        },
        createBundle().plans[1],
      ],
    });
    await expect(
      generateSearchPlanBundle(
        createArgs(new FakeLLMProvider([sameNode])),
      ),
    ).rejects.toEqual(new SearchPlanGenerationError("duplicate_query"));

    const crossNode = SearchPlanBundleSchema.parse({
      plans: [
        {
          ...createBundle().plans[0],
          queries: ["MYSQL 核心架构"],
        },
        {
          ...createBundle().plans[1],
          queries: ["mysql\u2003核心架构"],
        },
      ],
    });
    await expect(
      generateSearchPlanBundle(
        createArgs(new FakeLLMProvider([crossNode])),
      ),
    ).rejects.toEqual(new SearchPlanGenerationError("duplicate_query"));
  });

  it("拒绝只包含 Unicode White_Space 的 Query", async () => {
    const bundle = SearchPlanBundleSchema.parse({
      plans: [
        { ...createBundle().plans[0], queries: ["\u0085"] },
        createBundle().plans[1],
      ],
    });

    await expect(
      generateSearchPlanBundle(
        createArgs(new FakeLLMProvider([bundle])),
      ),
    ).rejects.toEqual(new SearchPlanGenerationError("empty_query"));
  });

  it("只拒绝精确重复，不擅自加入模糊语义阈值", async () => {
    const similar = SearchPlanBundleSchema.parse({
      plans: [
        { ...createBundle().plans[0], queries: ["MySQL 核心架构"] },
        { ...createBundle().plans[1], queries: ["MySQL 存储架构"] },
      ],
    });
    await expect(
      generateSearchPlanBundle(createArgs(new FakeLLMProvider([similar]))),
    ).resolves.toEqual(similar);
  });

  it("Schema 失败发布脱敏计数并直接失败", async () => {
    const diagnostics: SearchPlanBundleValidationDiagnostic[] = [];
    const provider = new FakeLLMProvider([
      { plans: [{ nodeId: "mysql-overview", queries: [] }] },
      createBundle(),
    ]);
    await expect(
      generateSearchPlanBundle(
        createArgs(provider, {
          onValidationDiagnostic: diagnostic => diagnostics.push(diagnostic),
        }),
      ),
    ).rejects.toEqual(new SearchPlanGenerationError("schema_validation_failed"));
    expect(provider.calls).toHaveLength(1);
    expect(diagnostics).toMatchObject([
      { stage: "search_plan_bundle_schema_validation" },
    ]);
  });

  it.each([
    "invalid_response",
    "provider_failure",
    "rate_limited",
    "timeout",
  ] as const)("Provider %s 失败不重试", async kind => {
    const provider = new FakeLLMProvider([
      new LLMProviderError(kind, true),
      createBundle(),
    ]);
    await expect(generateSearchPlanBundle(createArgs(provider))).rejects.toEqual(
      new SearchPlanGenerationError("provider_failure"),
    );
    expect(provider.calls).toHaveLength(1);
  });

  it("晚返回按预算失败，取消 reason 优先", async () => {
    const clock = createFixedClock(0);
    await expect(
      generateSearchPlanBundle(
        createArgs(
          {
            id: "late",
            structured: () => {
              clock.advanceBy(9_001);
              return Promise.resolve(createBundle());
            },
          },
          { now: clock.now },
        ),
      ),
    ).rejects.toEqual(new SearchPlanGenerationError("budget_exhausted"));

    const deferred = createDeferred<unknown>();
    const controller = new AbortController();
    const reason = new Error("用户取消");
    const pending = generateSearchPlanBundle(
      createArgs(
        { id: "deferred", structured: () => deferred.promise },
        { signal: controller.signal },
      ),
    );
    controller.abort(reason);
    deferred.resolve(createBundle());
    await expect(pending).rejects.toBe(reason);
  });

  it("非法 Outline 在调用前失败", async () => {
    const invalid = createOutline();
    invalid.edges = [];
    const provider = new FakeLLMProvider([createBundle()]);
    await expect(
      generateSearchPlanBundle(createArgs(provider, { outline: invalid })),
    ).rejects.toEqual(new SearchPlanGenerationError("invalid_outline"));
    expect(provider.calls).toHaveLength(0);
  });
});
