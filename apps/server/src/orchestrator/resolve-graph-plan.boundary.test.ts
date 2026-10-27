/**
 * 测试职责：直接证明 Orchestrator（编排器）主函数持有最终 GraphPlan 门禁，而不是仅由
 * Planner / Reviser 的内部校验偶然保证结果有效；同时冻结 Validator 执行期间的 Deadline 竞态。
 *
 * 这里仅替换已存在的 Planner 与 Validator 模块，不向生产 API 注入测试专用依赖。
 */
import { GraphPlanSchema, type GraphPlan } from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("../ai/graph-planner.js", async importOriginal => {
  const actual = await importOriginal<
    typeof import("../ai/graph-planner.js")
  >();
  return {
    ...actual,
    planOrCompactFallback: vi.fn(actual.planOrCompactFallback),
  };
});

vi.mock("../graph/graph-validator.js", async importOriginal => {
  const actual = await importOriginal<
    typeof import("../graph/graph-validator.js")
  >();
  return {
    ...actual,
    validateGraphPlan: vi.fn(actual.validateGraphPlan),
  };
});

import { planOrCompactFallback } from "../ai/graph-planner.js";
import type { LLMProvider } from "../ai/llm-provider.js";
import { validateGraphPlan } from "../graph/graph-validator.js";
import type { SearchProvider } from "../search/provider.js";
import {
  resolveValidatedGraphPlanForRun,
  type GraphPlanRunScope,
} from "./resolve-graph-plan.js";

const PLAN = GraphPlanSchema.parse({
  analysis: {
    intent: "learn",
    topic: "NVIDIA",
    freshnessSensitive: false,
    ambiguityLevel: "low",
    broadSearchQueries: [],
    strategy: "plan_first",
    presentationMode: "compact",
  },
  nodes: [
    {
      id: "overview",
      title: "NVIDIA 概览",
      description: "了解 NVIDIA",
      nodeType: "primary",
      layer: 0,
      searchPlan: {
        queries: ["NVIDIA"],
        maxResults: 20,
        rankingProfile: "general",
        providerHints: ["general"],
      },
      status: "planned",
    },
  ],
  edges: [],
});

const UNUSED_LLM_PROVIDER: LLMProvider = {
  id: "unused-llm",
  structured: () => Promise.reject(new Error("不应调用真实 LLM Provider")),
};

const UNUSED_SEARCH_PROVIDER: SearchProvider = {
  id: "unused-search",
  capabilities: ["general"],
  search: () => Promise.reject(new Error("plan_first 不应调用 Search Provider")),
};

function resolveWithScope(runScope: GraphPlanRunScope): Promise<GraphPlan> {
  return resolveValidatedGraphPlanForRun({
    query: "NVIDIA",
    llmProvider: UNUSED_LLM_PROVIDER,
    searchProvider: UNUSED_SEARCH_PROVIDER,
    runScope,
    llmStageTimeoutMs: 30_000,
    onPlannerValidationDiagnostic: () => undefined,
    onRevisionValidationDiagnostic: () => undefined,
  });
}

describe("resolveValidatedGraphPlanForRun 最终门禁", () => {
  it("拒绝 Planner 边界意外返回的 Validator-invalid 计划", async () => {
    const invalidPlan = GraphPlanSchema.parse({
      ...PLAN,
      edges: [
        {
          id: "self-edge",
          source: "overview",
          target: "overview",
          type: "recommended_next",
        },
      ],
    });
    vi.mocked(planOrCompactFallback).mockResolvedValueOnce(invalidPlan);
    const runScope: GraphPlanRunScope = {
      signal: new AbortController().signal,
      requirePositiveRemainingMs: () => 40_000,
    };

    await expect(resolveWithScope(runScope)).rejects.toThrow(
      new TypeError("Orchestrator GraphPlan 未通过最终校验"),
    );
  });

  it("Validator 执行期间跨过 Deadline 时不返回迟到计划", async () => {
    vi.mocked(planOrCompactFallback).mockResolvedValueOnce(PLAN);
    const deadlineReason = new DOMException(
      "WayFinder Run 超过 40000ms 绝对截止时间",
      "TimeoutError",
    );
    let validationCompleted = false;
    vi.mocked(validateGraphPlan).mockImplementationOnce(() => {
      validationCompleted = true;
      return { valid: true, findings: [] };
    });
    const runScope: GraphPlanRunScope = {
      signal: new AbortController().signal,
      requirePositiveRemainingMs: () => {
        if (validationCompleted) {
          throw deadlineReason;
        }
        return 40_000;
      },
    };

    await expect(resolveWithScope(runScope)).rejects.toBe(deadlineReason);
    expect(validateGraphPlan).toHaveBeenCalledOnce();
  });
});
