/**
 * 测试职责：冻结 Outline-only Planner 的单次调用、失败关闭与取消/预算边界。
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
  type GraphOutlineValidationDiagnostic,
} from "./graph-outline.js";
import {
  GraphPlannerError,
  planGraphOutline,
} from "./graph-planner.js";
import {
  LLMProviderError,
  type LLMProvider,
} from "./llm-provider.js";
import { GRAPH_PLANNER_SYSTEM_PROMPT } from "./prompts/graph-planner.v2.js";

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
        description: "理解 MySQL 的定位与核心概念。",
        nodeType: "primary",
        layer: 0,
        status: "planned",
      },
    ],
    edges: [],
  });
}

function createArgs(
  provider: LLMProvider,
  overrides: Partial<{
    signal: AbortSignal;
    timeoutMs: number;
    now: () => number;
    onValidationDiagnostic: (
      diagnostic: GraphOutlineValidationDiagnostic,
    ) => void;
  }> = {},
) {
  const base = {
    query: QUERY,
    provider,
    signal: overrides.signal ?? new AbortController().signal,
    timeoutMs: overrides.timeoutMs ?? 10_000,
    onValidationDiagnostic:
      overrides.onValidationDiagnostic ?? (() => undefined),
  };
  return overrides.now === undefined
    ? base
    : { ...base, now: overrides.now };
}

describe("planGraphOutline", () => {
  it("只调用一次并使用 Outline Schema、v2 Prompt、父 Signal 与有限预算", async () => {
    const outline = createOutline();
    const provider = new FakeLLMProvider([outline]);
    const signal = new AbortController().signal;
    const clock = createFixedClock(1_000);

    await expect(
      planGraphOutline(createArgs(provider, { signal, now: clock.now })),
    ).resolves.toEqual(outline);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toEqual({
      input: {
        system: GRAPH_PLANNER_SYSTEM_PROMPT,
        user: QUERY,
        schemaName: "graph_outline",
        schema: z.toJSONSchema(GraphOutlineSchema, {
          target: "draft-2020-12",
          io: "input",
          unrepresentable: "throw",
          reused: "inline",
        }),
      },
      options: { signal, timeoutMs: 10_000 },
    });
  });

  it("Schema 失败发布脱敏诊断并直接失败，不重试或 fallback", async () => {
    const sentinel = "private-model-output";
    const diagnostics: GraphOutlineValidationDiagnostic[] = [];
    const provider = new FakeLLMProvider([
      { unexpected: sentinel },
      createOutline(),
    ]);

    await expect(
      planGraphOutline(
        createArgs(provider, {
          onValidationDiagnostic: diagnostic => diagnostics.push(diagnostic),
        }),
      ),
    ).rejects.toEqual(new GraphPlannerError("schema_validation_failed"));
    expect(provider.calls).toHaveLength(1);
    expect(diagnostics).toMatchObject([
      { stage: "graph_outline_schema_validation" },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(sentinel);
  });

  it("语义无效的 Outline 不 repair，直接失败", async () => {
    const invalid = createOutline();
    invalid.edges = [
      {
        id: "self-edge",
        source: "mysql-overview",
        target: "mysql-overview",
        type: "related_to",
      },
    ];
    const provider = new FakeLLMProvider([invalid]);

    await expect(planGraphOutline(createArgs(provider))).rejects.toEqual(
      new GraphPlannerError("semantic_validation_failed"),
    );
    expect(provider.calls).toHaveLength(1);
  });

  it.each([
    "invalid_response",
    "provider_failure",
    "rate_limited",
    "timeout",
  ] as const)("Provider %s 失败只调用一次并脱敏分类", async kind => {
    const provider = new FakeLLMProvider([
      new LLMProviderError(kind, true),
      createOutline(),
    ]);

    await expect(planGraphOutline(createArgs(provider))).rejects.toEqual(
      new GraphPlannerError("provider_failure"),
    );
    expect(provider.calls).toHaveLength(1);
  });

  it("Provider 晚返回时按阶段预算失败", async () => {
    const clock = createFixedClock(0);
    let calls = 0;
    const provider: LLMProvider = {
      id: "late-provider",
      structured: () => {
        calls += 1;
        clock.advanceBy(10_001);
        return Promise.resolve(createOutline());
      },
    };

    await expect(
      planGraphOutline(createArgs(provider, { now: clock.now })),
    ).rejects.toEqual(new GraphPlannerError("budget_exhausted"));
    expect(calls).toBe(1);
  });

  it("取消 reason 优先于 Provider 的迟到结果", async () => {
    const deferred = createDeferred<unknown>();
    const controller = new AbortController();
    const reason = new Error("用户取消");
    const provider: LLMProvider = {
      id: "deferred-provider",
      structured: () => deferred.promise,
    };

    const pending = planGraphOutline(
      createArgs(provider, { signal: controller.signal }),
    );
    controller.abort(reason);
    deferred.resolve(createOutline());

    await expect(pending).rejects.toBe(reason);
  });

  it("诊断观察器与未知错误保持程序错误语义", async () => {
    const observerError = new Error("诊断出口失败");
    await expect(
      planGraphOutline(
        createArgs(new FakeLLMProvider([{ invalid: true }]), {
          onValidationDiagnostic: () => {
            throw observerError;
          },
        }),
      ),
    ).rejects.toBe(observerError);

    const programmerError = new Error("programmer-error");
    await expect(
      planGraphOutline(
        createArgs(new FakeLLMProvider([programmerError])),
      ),
    ).rejects.toBe(programmerError);
  });

  it.each([0, 30_001, 1.5, Number.NaN])(
    "timeoutMs=%s 时调用前拒绝",
    async timeoutMs => {
      const provider = new FakeLLMProvider([createOutline()]);
      await expect(
        planGraphOutline(createArgs(provider, { timeoutMs })),
      ).rejects.toThrow(RangeError);
      expect(provider.calls).toHaveLength(0);
    },
  );
});
