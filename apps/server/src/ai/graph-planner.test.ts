/**
 * 测试职责：冻结 WAY-39 Planner 的单次重试、共享预算、取消传播与 compact fallback。
 *
 * 测试全部使用本地 Fake（测试替身），不得访问真实 LLM、读取 Secret 或依赖墙钟等待。
 */
import { GraphPlanSchema } from "@wayfinder/contracts";
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
import { planOrCompactFallback } from "./graph-planner.js";
import { GRAPH_PLANNER_SYSTEM_PROMPT } from "./prompts/graph-planner.v1.js";

const QUERY = "TypeScript 官方文档";

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
    signal: AbortSignal;
    timeoutMs: number;
    now: () => number;
  }> = {},
) {
  const base = {
    provider,
    query: QUERY,
    signal: overrides.signal ?? new AbortController().signal,
    timeoutMs: overrides.timeoutMs ?? 15_000,
  };

  return overrides.now === undefined
    ? base
    : { ...base, now: overrides.now };
}

describe("Graph Planner retry 与 compact fallback", () => {
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
    const provider = new FakeLLMProvider([
      new LLMProviderError("invalid_response", false),
      plan,
    ]);

    await expect(
      planOrCompactFallback(createPlannerArgs(provider)),
    ).resolves.toEqual(plan);
    expect(provider.calls).toHaveLength(2);
  });

  it("Schema 结构失败后以完全相同输入重试，不回灌输出或诊断", async () => {
    const plan = createValidPlan();
    const provider = new FakeLLMProvider([{ invalid: "first-output" }, plan]);

    await expect(
      planOrCompactFallback(createPlannerArgs(provider)),
    ).resolves.toEqual(plan);

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.input).toEqual(provider.calls[0]?.input);
    expect(JSON.stringify(provider.calls[1]?.input)).not.toContain(
      "first-output",
    );
  });

  it("连续两次结构失败后返回 fallback，绝不启动第三次调用", async () => {
    const provider = new FakeLLMProvider([
      { invalid: "first-output" },
      new LLMProviderError("invalid_response", false),
    ]);

    const result = await planOrCompactFallback(createPlannerArgs(provider));

    expect(provider.calls).toHaveLength(2);
    expect(result).toEqual(createExpectedFallback());
    expect(JSON.stringify(result)).not.toContain("first-output");
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
