/**
 * 测试职责：冻结 WAY-39 Planner 的失败边界，并验证 WAY-40 plan_first 的典型计划。
 *
 * 测试全部使用本地 Fake（测试替身），不得访问真实 LLM、读取 Secret 或依赖墙钟等待。
 */
import {
  calculateSearchPlanMaxResults,
  GraphPlanSchema,
  SearchPlanSchema,
} from "@wayfinder/contracts";
import type { GraphPlan } from "@wayfinder/contracts";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  createAbortFixture,
  createDeferred,
  createFixedClock,
  FakeLLMProvider,
} from "../../../../tests/support/test-infrastructure.mjs";
import { validateGraphPlan } from "../graph/graph-validator.js";
import {
  LLMProviderError,
  type LLMCallOptions,
  type LLMProvider,
  type StructuredLLMInput,
} from "./llm-provider.js";
import type { GraphPlanValidationDiagnostic } from "./graph-plan-parser.js";
import { planOrCompactFallback } from "./graph-planner.js";
import { GRAPH_PLANNER_SYSTEM_PROMPT } from "./prompts/graph-planner.v1.js";

const QUERY = "TypeScript 官方文档";

type PlanNode = GraphPlan["nodes"][number];

/** 测试 Node 统一复用 Contract 的配额计算，避免 Fixture 另行维护 20 / 10 / 6。 */
function createPlanNode(
  input: Readonly<{
    id: string;
    title: string;
    description: string;
    layer: number;
    queries: readonly string[];
    rankingProfile: PlanNode["searchPlan"]["rankingProfile"];
  }>,
): PlanNode {
  const queries = [...input.queries];
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    nodeType: "primary",
    layer: input.layer,
    searchPlan: {
      queries,
      maxResults: calculateSearchPlanMaxResults(queries.length),
      rankingProfile: input.rankingProfile,
      providerHints: ["general"],
    },
    status: "planned",
  };
}

/**
 * knowledge Graph Fixture（知识图计划夹具）只表达已选择 plan_first 后的合法输出；
 * Query 到 Strategy 的主观分类质量留给 WAY-43 Golden Eval，不在测试中实现关键词规则。
 */
function createKnowledgeGraphPlan(): GraphPlan {
  return {
    analysis: {
      intent: "learn",
      topic: "Python",
      freshnessSensitive: false,
      ambiguityLevel: "low",
      broadSearchQueries: [],
      strategy: "plan_first",
      presentationMode: "graph",
    },
    nodes: [
      createPlanNode({
        id: "python-overview",
        title: "Python 概览",
        description: "理解 Python 的定位与常见用途",
        layer: 0,
        queries: ["Python language overview", "Python common uses"],
        rankingProfile: "knowledge",
      }),
      createPlanNode({
        id: "python-installation",
        title: "安装与环境",
        description: "查找 Python 的官方安装与环境配置说明",
        layer: 1,
        queries: [
          "Python official installation guide",
          "Python virtual environment guide",
        ],
        rankingProfile: "software",
      }),
      createPlanNode({
        id: "python-basics",
        title: "基础语法",
        description: "学习 Python 的核心语法与数据结构",
        layer: 1,
        queries: ["Python syntax tutorial", "Python data structures guide"],
        rankingProfile: "knowledge",
      }),
      createPlanNode({
        id: "python-practice",
        title: "练习与项目",
        description: "通过练习和小项目巩固 Python 基础",
        layer: 2,
        queries: ["Python beginner exercises", "Python beginner project ideas"],
        rankingProfile: "knowledge",
      }),
    ],
    edges: [
      {
        id: "overview-to-installation",
        source: "python-overview",
        target: "python-installation",
        type: "recommended_next",
      },
      {
        id: "overview-to-basics",
        source: "python-overview",
        target: "python-basics",
        type: "recommended_next",
      },
      {
        id: "basics-to-practice",
        source: "python-basics",
        target: "python-practice",
        type: "recommended_next",
      },
    ],
  };
}

/** 明确且稳定的 how-to 使用 compact，覆盖单 Node 必须没有 Edge 的硬约束。 */
function createHowToCompactPlan(): GraphPlan {
  return {
    analysis: {
      intent: "how_to",
      topic: "如何安装 pnpm",
      freshnessSensitive: false,
      ambiguityLevel: "low",
      broadSearchQueries: [],
      strategy: "plan_first",
      presentationMode: "compact",
    },
    nodes: [
      createPlanNode({
        id: "install-pnpm",
        title: "安装 pnpm",
        description: "查找 pnpm 官方安装步骤与前置要求",
        layer: 0,
        queries: ["pnpm official installation guide"],
        rankingProfile: "software",
      }),
    ],
    edges: [],
  };
}

function createValidPlan(query = QUERY): GraphPlan {
  return {
    analysis: {
      intent: "navigate",
      topic: query,
      freshnessSensitive: false,
      ambiguityLevel: "low",
      broadSearchQueries: [],
      strategy: "plan_first",
      presentationMode: "compact",
    },
    nodes: [
      {
        id: "typescript-docs",
        title: "TypeScript 官方文档",
        description: "查找 TypeScript 官方文档入口",
        nodeType: "primary",
        layer: 0,
        searchPlan: {
          queries: ["TypeScript official documentation"],
          maxResults: 20,
          rankingProfile: "software",
          providerHints: ["general"],
        },
        status: "planned",
      },
    ],
    edges: [],
  };
}

function createExpectedFallback(query = QUERY): GraphPlan {
  return {
    analysis: {
      intent: "mixed",
      topic: query,
      freshnessSensitive: false,
      ambiguityLevel: "low",
      broadSearchQueries: [],
      strategy: "plan_first",
      presentationMode: "compact",
    },
    nodes: [
      {
        id: "compact-fallback",
        title: query,
        description: query,
        nodeType: "primary",
        layer: 0,
        searchPlan: {
          queries: [query],
          maxResults: 20,
          rankingProfile: "general",
          providerHints: ["general"],
        },
        status: "planned",
      },
    ],
    edges: [],
  };
}

function createPlannerArgs(
  provider: LLMProvider,
  overrides: Partial<{
    query: string;
    signal: AbortSignal;
    timeoutMs: number;
    now: () => number;
    onValidationDiagnostic: (
      diagnostic: GraphPlanValidationDiagnostic,
    ) => void;
    onOutcome: NonNullable<
      Parameters<typeof planOrCompactFallback>[0]["onOutcome"]
    >;
  }> = {},
) {
  const base = {
    provider,
    query: overrides.query ?? QUERY,
    signal: overrides.signal ?? new AbortController().signal,
    timeoutMs: overrides.timeoutMs ?? 15_000,
    onValidationDiagnostic:
      overrides.onValidationDiagnostic ?? (() => undefined),
    ...(overrides.onOutcome === undefined
      ? {}
      : { onOutcome: overrides.onOutcome }),
  };

  return overrides.now === undefined
    ? base
    : { ...base, now: overrides.now };
}

describe("plan_first 典型计划", () => {
  it.each([
    {
      name: "knowledge Graph",
      query: "Python",
      presentationMode: "graph" as const,
      createPlan: createKnowledgeGraphPlan,
    },
    {
      name: "明确 how-to compact",
      query: "如何安装 pnpm",
      presentationMode: "compact" as const,
      createPlan: createHowToCompactPlan,
    },
  ])(
    "$name 由 Planner 一次返回合法 SearchPlans",
    async ({ query, presentationMode, createPlan }) => {
      const plan = createPlan();
      const provider = new FakeLLMProvider([plan]);

      const result = await planOrCompactFallback(
        createPlannerArgs(provider, { query }),
      );

      // plan_first 在 Planner 边界直接成为最终计划；本模块不依赖 SearchProvider 或 Broad Search。
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]?.input.user).toBe(query);
      expect(result).toEqual(plan);
      expect(result.analysis).toMatchObject({
        strategy: "plan_first",
        broadSearchQueries: [],
        presentationMode,
      });
      expect(GraphPlanSchema.safeParse(result).success).toBe(true);
      expect(validateGraphPlan(result)).toEqual({ valid: true, findings: [] });
      for (const node of result.nodes) {
        expect(SearchPlanSchema.safeParse(node.searchPlan).success).toBe(true);
      }
    },
  );
});

describe("Graph Planner retry 与 compact fallback", () => {
  it("通过脱敏观察器区分首次成功、重试成功与 fallback 原因", async () => {
    const outcomes: Parameters<
      NonNullable<Parameters<typeof planOrCompactFallback>[0]["onOutcome"]>
    >[0][] = [];

    await planOrCompactFallback(
      createPlannerArgs(new FakeLLMProvider([createValidPlan()]), {
        onOutcome: outcome => outcomes.push(outcome),
      }),
    );
    await planOrCompactFallback(
      createPlannerArgs(
        new FakeLLMProvider([{ invalid: true }, createValidPlan()]),
        { onOutcome: outcome => outcomes.push(outcome) },
      ),
    );
    await planOrCompactFallback(
      createPlannerArgs(
        new FakeLLMProvider([
          new LLMProviderError("provider_failure", false),
        ]),
        { onOutcome: outcome => outcomes.push(outcome) },
      ),
    );

    expect(outcomes).toEqual([
      { kind: "success", attempts: 1 },
      { kind: "success", attempts: 2 },
      {
        kind: "compact_fallback",
        attempts: 1,
        reason: "provider_failure",
      },
    ]);
  });

  it("首次合法输出直接返回，并传入现有 Prompt、Schema、父 Signal 与完整预算", async () => {
    const plan = createValidPlan();
    const provider = new FakeLLMProvider([plan]);
    const signal = new AbortController().signal;
    const clock = createFixedClock(1_000);

    await expect(
      planOrCompactFallback(
        createPlannerArgs(provider, { signal, now: clock.now }),
      ),
    ).resolves.toEqual(plan);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.input).toEqual({
      system: GRAPH_PLANNER_SYSTEM_PROMPT,
      user: QUERY,
      schemaName: "graph_plan",
      schema: z.toJSONSchema(GraphPlanSchema, {
        target: "draft-2020-12",
        io: "input",
        unrepresentable: "throw",
        reused: "inline",
      }),
    });
    expect(provider.calls[0]?.options).toEqual({ signal, timeoutMs: 15_000 });
  });

  it("首次 Schema-valid 语义错误先执行确定性 Repair，成功后不重试", async () => {
    const plan = createValidPlan();
    plan.edges = [
      {
        id: "self-edge",
        source: "typescript-docs",
        target: "typescript-docs",
        type: "related_to",
      },
    ];
    const provider = new FakeLLMProvider([plan]);

    const result = await planOrCompactFallback(createPlannerArgs(provider));

    expect(provider.calls).toHaveLength(1);
    expect(result).toEqual({ ...plan, edges: [] });
    expect(validateGraphPlan(result)).toEqual({ valid: true, findings: [] });
  });

  it("首次 Schema-valid 但不可修复时返回已确认的完整 fallback", async () => {
    const plan = createValidPlan();
    plan.nodes[0] = { ...plan.nodes[0]!, title: " " };
    const provider = new FakeLLMProvider([plan]);

    const result = await planOrCompactFallback(createPlannerArgs(provider));

    expect(provider.calls).toHaveLength(1);
    expect(result).toEqual(createExpectedFallback());
    expect(GraphPlanSchema.safeParse(result).success).toBe(true);
    expect(validateGraphPlan(result)).toEqual({ valid: true, findings: [] });
    expect(JSON.stringify(result)).not.toContain("resources");
  });

  it("invalid_response 即使 retryable=false 也只重试一次", async () => {
    const plan = createValidPlan();
    const diagnostics: GraphPlanValidationDiagnostic[] = [];
    const provider = new FakeLLMProvider([
      new LLMProviderError("invalid_response", false),
      plan,
    ]);

    await expect(
      planOrCompactFallback(
        createPlannerArgs(provider, {
          onValidationDiagnostic: diagnostic => diagnostics.push(diagnostic),
        }),
      ),
    ).resolves.toEqual(plan);
    expect(provider.calls).toHaveLength(2);
    expect(diagnostics).toEqual([]);
  });

  it("Schema 结构失败后以完全相同输入重试，不回灌输出或诊断", async () => {
    const plan = createValidPlan();
    const sensitiveOutput = "first-output-secret";
    const diagnostics: GraphPlanValidationDiagnostic[] = [];
    const provider = new FakeLLMProvider([{ invalid: sensitiveOutput }, plan]);

    await expect(
      planOrCompactFallback(
        createPlannerArgs(provider, {
          onValidationDiagnostic: diagnostic => diagnostics.push(diagnostic),
        }),
      ),
    ).resolves.toEqual(plan);

    expect(provider.calls).toHaveLength(2);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      stage: "graph_plan_schema_validation",
    });
    expect(JSON.stringify(diagnostics)).not.toContain(sensitiveOutput);
    expect(provider.calls[1]?.input).toEqual(provider.calls[0]?.input);
    expect(JSON.stringify(provider.calls[1]?.input)).not.toContain(
      sensitiveOutput,
    );
  });

  it("连续两次结构失败后返回 fallback，绝不启动第三次调用", async () => {
    const diagnostics: GraphPlanValidationDiagnostic[] = [];
    const provider = new FakeLLMProvider([
      { invalid: "first-output" },
      { invalid: "second-output" },
    ]);

    const result = await planOrCompactFallback(
      createPlannerArgs(provider, {
        onValidationDiagnostic: diagnostic => diagnostics.push(diagnostic),
      }),
    );

    expect(provider.calls).toHaveLength(2);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map(diagnostic => diagnostic.stage)).toEqual([
      "graph_plan_schema_validation",
      "graph_plan_schema_validation",
    ]);
    expect(result).toEqual(createExpectedFallback());
    expect(JSON.stringify(result)).not.toContain("first-output");
  });

  it("诊断观察器异常作为程序错误原样传播，不伪装成 fallback", async () => {
    const observerError = new Error("Run 上下文拒绝诊断");
    const provider = new FakeLLMProvider([{ invalid: "first-output" }]);

    await expect(
      planOrCompactFallback(
        createPlannerArgs(provider, {
          onValidationDiagnostic: () => {
            throw observerError;
          },
        }),
      ),
    ).rejects.toBe(observerError);
    expect(provider.calls).toHaveLength(1);
  });

  it("第二次 Schema-valid 语义错误也执行确定性 Repair", async () => {
    const repairable = createValidPlan();
    repairable.edges = [
      {
        id: "self-edge",
        source: "typescript-docs",
        target: "typescript-docs",
        type: "related_to",
      },
    ];
    const provider = new FakeLLMProvider([{ invalid: true }, repairable]);

    const result = await planOrCompactFallback(createPlannerArgs(provider));

    expect(provider.calls).toHaveLength(2);
    expect(result).toEqual({ ...repairable, edges: [] });
  });

  it("第二次 Schema-valid 但不可修复时返回 fallback", async () => {
    const invalid = createValidPlan();
    invalid.nodes[0] = { ...invalid.nodes[0]!, title: " " };
    const provider = new FakeLLMProvider([{ invalid: true }, invalid]);

    await expect(
      planOrCompactFallback(createPlannerArgs(provider)),
    ).resolves.toEqual(createExpectedFallback());
    expect(provider.calls).toHaveLength(2);
  });

  it("第二次调用发生普通 Provider 错误时直接 fallback", async () => {
    const provider = new FakeLLMProvider([
      { invalid: true },
      new LLMProviderError("provider_failure", true),
    ]);

    await expect(
      planOrCompactFallback(createPlannerArgs(provider)),
    ).resolves.toEqual(createExpectedFallback());
    expect(provider.calls).toHaveLength(2);
  });

  it.each(["provider_failure", "rate_limited", "timeout"] as const)(
    "%s 即使 retryable=true 也不触发 Planner retry",
    async kind => {
      const provider = new FakeLLMProvider([
        new LLMProviderError(kind, true),
      ]);

      await expect(
        planOrCompactFallback(createPlannerArgs(provider)),
      ).resolves.toEqual(createExpectedFallback());
      expect(provider.calls).toHaveLength(1);
    },
  );

  it("首次调用与 retry 共享 Planner 阶段预算和同一个父 Signal", async () => {
    const clock = createFixedClock(0);
    const signal = new AbortController().signal;
    const calls: Array<{
      input: StructuredLLMInput;
      options: LLMCallOptions;
    }> = [];
    const provider: LLMProvider = {
      id: "budget-provider",
      structured: (input, options) => {
        calls.push({ input, options });
        if (calls.length === 1) {
          clock.advanceBy(6_000);
          throw new LLMProviderError("invalid_response", false);
        }
        return Promise.resolve(createValidPlan());
      },
    };

    await expect(
      planOrCompactFallback(
        createPlannerArgs(provider, { signal, now: clock.now }),
      ),
    ).resolves.toEqual(createValidPlan());

    expect(calls.map(call => call.options.timeoutMs)).toEqual([15_000, 9_000]);
    expect(calls.every(call => call.options.signal === signal)).toBe(true);
  });

  it("结构失败时 Planner 预算已耗尽则不发第二次请求", async () => {
    const clock = createFixedClock(0);
    let callCount = 0;
    const provider: LLMProvider = {
      id: "expired-budget-provider",
      structured: () => {
        callCount += 1;
        clock.advanceBy(15_000);
        throw new LLMProviderError("invalid_response", false);
      },
    };

    await expect(
      planOrCompactFallback(createPlannerArgs(provider, { now: clock.now })),
    ).resolves.toEqual(createExpectedFallback());
    expect(callCount).toBe(1);
  });

  it("Provider 忽略 timeout 并超预算返回合法结果时仍进入 fallback", async () => {
    const clock = createFixedClock(0);
    let callCount = 0;
    const provider: LLMProvider = {
      id: "timeout-ignoring-provider",
      structured: () => {
        callCount += 1;
        clock.advanceBy(15_001);
        return Promise.resolve(createValidPlan());
      },
    };

    await expect(
      planOrCompactFallback(createPlannerArgs(provider, { now: clock.now })),
    ).resolves.toEqual(createExpectedFallback());
    expect(callCount).toBe(1);
  });

  it("调用前已取消时原样抛出 reason，且不调用 Provider", async () => {
    const abortFixture = createAbortFixture();
    abortFixture.abort();
    const provider = new FakeLLMProvider([createValidPlan()]);

    await expect(
      planOrCompactFallback(
        createPlannerArgs(provider, { signal: abortFixture.signal }),
      ),
    ).rejects.toBe(abortFixture.reason);
    expect(provider.calls).toHaveLength(0);
  });

  it("等待 Provider 期间取消时原样抛出 reason，不启动 fallback", async () => {
    const abortFixture = createAbortFixture();
    const deferred = createDeferred<unknown>();
    const provider = new FakeLLMProvider([deferred.promise]);

    const result = planOrCompactFallback(
      createPlannerArgs(provider, { signal: abortFixture.signal }),
    );
    abortFixture.abort();

    await expect(result).rejects.toBe(abortFixture.reason);
    expect(provider.calls).toHaveLength(1);
  });

  it("Provider 忽略取消并返回成功值时仍在 await 后原样终止", async () => {
    const abortFixture = createAbortFixture();
    let callCount = 0;
    const provider: LLMProvider = {
      id: "abort-ignoring-provider",
      structured: () => {
        callCount += 1;
        abortFixture.abort();
        return Promise.resolve(createValidPlan());
      },
    };

    await expect(
      planOrCompactFallback(
        createPlannerArgs(provider, { signal: abortFixture.signal }),
      ),
    ).rejects.toBe(abortFixture.reason);
    expect(callCount).toBe(1);
  });

  it("第一次结构失败后父 Signal 已取消时不启动 retry", async () => {
    const abortFixture = createAbortFixture();
    let callCount = 0;
    const provider: LLMProvider = {
      id: "abort-before-retry-provider",
      structured: () => {
        callCount += 1;
        abortFixture.abort();
        throw new LLMProviderError("invalid_response", false);
      },
    };

    await expect(
      planOrCompactFallback(
        createPlannerArgs(provider, { signal: abortFixture.signal }),
      ),
    ).rejects.toBe(abortFixture.reason);
    expect(callCount).toBe(1);
  });

  it("独立 AbortError 原样终止，不转换为 fallback", async () => {
    const abortError = new Error("SDK 已取消");
    abortError.name = "AbortError";
    const provider = new FakeLLMProvider([abortError]);

    await expect(
      planOrCompactFallback(createPlannerArgs(provider)),
    ).rejects.toBe(abortError);
    expect(provider.calls).toHaveLength(1);
  });

  it("未知程序错误原样抛出，不能伪装成成功 fallback", async () => {
    const programmingError = new TypeError("unexpected implementation bug");
    const provider = new FakeLLMProvider([programmingError]);

    await expect(
      planOrCompactFallback(createPlannerArgs(provider)),
    ).rejects.toBe(programmingError);
    expect(provider.calls).toHaveLength(1);
  });
});
