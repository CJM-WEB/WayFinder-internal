/**
 * 测试职责：证明 Orchestrator 自身持有 Final GraphPlan 门禁与同步 Deadline 竞态检查。
 */
import { GraphPlanSchema, type GraphPlan } from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("../ai/graph-planner.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../ai/graph-planner.js")>();
  return { ...actual, planGraphOutline: vi.fn(actual.planGraphOutline) };
});

vi.mock("../ai/search-plan-generator.js", async importOriginal => {
  const actual = await importOriginal<
    typeof import("../ai/search-plan-generator.js")
  >();
  return {
    ...actual,
    generateSearchPlanBundle: vi.fn(actual.generateSearchPlanBundle),
    assembleGraphPlan: vi.fn(actual.assembleGraphPlan),
  };
});

vi.mock("../graph/graph-validator.js", async importOriginal => {
  const actual = await importOriginal<
    typeof import("../graph/graph-validator.js")
  >();
  return { ...actual, validateGraphPlan: vi.fn(actual.validateGraphPlan) };
});

import {
  GraphOutlineSchema,
  type GraphOutline,
} from "../ai/graph-outline.js";
import { planGraphOutline } from "../ai/graph-planner.js";
import type { LLMProvider } from "../ai/llm-provider.js";
import {
  SearchPlanBundleSchema,
  assembleGraphPlan,
  generateSearchPlanBundle,
} from "../ai/search-plan-generator.js";
import { validateGraphPlan } from "../graph/graph-validator.js";
import type { SearchProvider } from "../search/provider.js";
import {
  GraphPlanResolutionError,
  resolveValidatedGraphPlanForRun,
  type GraphPlanRunScope,
} from "./resolve-graph-plan.js";

const OUTLINE: GraphOutline = GraphOutlineSchema.parse({
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
      status: "planned",
    },
  ],
  edges: [],
});

const BUNDLE = SearchPlanBundleSchema.parse({
  plans: [
    {
      nodeId: "overview",
      queries: ["NVIDIA 公司概览"],
      rankingProfile: "knowledge",
    },
  ],
});

const PLAN = GraphPlanSchema.parse({
  analysis: OUTLINE.analysis,
  nodes: [
    {
      ...OUTLINE.nodes[0],
      searchPlan: {
        queries: ["NVIDIA 公司概览"],
        maxResults: 20,
        rankingProfile: "knowledge",
        providerHints: ["general"],
      },
    },
  ],
  edges: [],
});

const UNUSED_LLM_PROVIDER: LLMProvider = {
  id: "unused-llm",
  structured: () => Promise.reject(new Error("不应调用真实 LLM")),
};
const UNUSED_SEARCH_PROVIDER: SearchProvider = {
  id: "unused-search",
  capabilities: ["general"],
  search: () => Promise.reject(new Error("plan_first 不应调用 Search")),
};

function resolveWithScope(runScope: GraphPlanRunScope): Promise<GraphPlan> {
  vi.mocked(planGraphOutline).mockResolvedValueOnce(OUTLINE);
  vi.mocked(generateSearchPlanBundle).mockResolvedValueOnce(BUNDLE);
  return resolveValidatedGraphPlanForRun({
    query: "NVIDIA",
    language: "zh-CN",
    llmProvider: UNUSED_LLM_PROVIDER,
    searchProvider: UNUSED_SEARCH_PROVIDER,
    runScope,
    llmStageTimeoutMs: 30_000,
    onPlannerValidationDiagnostic: () => undefined,
    onRevisionValidationDiagnostic: () => undefined,
    onSearchPlanValidationDiagnostic: () => undefined,
  });
}

describe("resolveValidatedGraphPlanForRun Final 门禁", () => {
  it("拒绝装配边界意外返回的 Validator-invalid GraphPlan", async () => {
    const invalid = GraphPlanSchema.parse({
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
    vi.mocked(assembleGraphPlan).mockReturnValueOnce(invalid);
    const runScope: GraphPlanRunScope = {
      signal: new AbortController().signal,
      requirePositiveRemainingMs: () => 40_000,
    };

    await expect(resolveWithScope(runScope)).rejects.toEqual(
      new GraphPlanResolutionError({ code: "INVALID_GRAPH", retryable: true }),
    );
  });

  it("最终 Validator 执行期间跨过 Deadline 时不返回迟到计划", async () => {
    vi.mocked(assembleGraphPlan).mockReturnValueOnce(PLAN);
    const deadlineReason = new DOMException("Run deadline", "TimeoutError");
    let validationCompleted = false;
    vi.mocked(validateGraphPlan).mockImplementationOnce(() => {
      validationCompleted = true;
      return { valid: true, findings: [] };
    });
    const runScope: GraphPlanRunScope = {
      signal: new AbortController().signal,
      requirePositiveRemainingMs: () => {
        if (validationCompleted) throw deadlineReason;
        return 40_000;
      },
    };

    await expect(resolveWithScope(runScope)).rejects.toBe(deadlineReason);
    expect(validateGraphPlan).toHaveBeenCalledOnce();
  });
});
