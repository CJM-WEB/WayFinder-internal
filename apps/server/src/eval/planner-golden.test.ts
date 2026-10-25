/**
 * 测试职责：用零网络 Fake Provider 冻结 WAY-43 的双策略编排、回退、Deadline、
 * 自动指标与脱敏报告边界；不评判模型生成文本的主观质量。
 */
import type {
  GraphPlan,
  NormalizedSearchHit,
  ProviderSearchRequest,
} from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import { LLMProviderError } from "../ai/llm-provider.js";
import type {
  LLMCallOptions,
  LLMProvider,
  StructuredLLMInput,
} from "../ai/llm-provider.js";
import type { SearchProvider } from "../search/provider.js";
import {
  evaluatePlannerGoldenQuery,
  type PlannerGoldenQuery,
} from "./planner-golden.js";
import {
  renderCompletedReview,
  summarizeResults,
} from "./run-planner-golden.js";

const GOLDEN_QUERY: PlannerGoldenQuery = {
  id: "wfq-test",
  query: "Python",
  category: "knowledge",
  rationale: "测试固定数据",
};

type LLMResponse =
  | unknown
  | Error
  | ((options: LLMCallOptions) => Promise<unknown>);

class FakeLLMProvider implements LLMProvider {
  public readonly id = "fake-llm";
  readonly #responses: LLMResponse[];

  public constructor(responses: LLMResponse[]) {
    this.#responses = [...responses];
  }

  public async structured(
    _input: StructuredLLMInput,
    options: LLMCallOptions,
  ): Promise<unknown> {
    const response = this.#responses.shift();
    if (response === undefined) {
      throw new Error("Fake LLM 缺少响应");
    }
    if (response instanceof Error) {
      throw response;
    }
    if (typeof response === "function") {
      return response(options);
    }
    return response;
  }
}

class FakeSearchProvider implements SearchProvider {
  public readonly id = "fake-search";
  public readonly capabilities: SearchProvider["capabilities"] = ["general"];
  readonly #createHits: (
    request: ProviderSearchRequest,
  ) => NormalizedSearchHit[];

  public constructor(
    createHits: (
      request: ProviderSearchRequest,
    ) => NormalizedSearchHit[] = createEvidence,
  ) {
    this.#createHits = createHits;
  }

  public async search(
    request: ProviderSearchRequest,
    signal: AbortSignal,
  ): Promise<NormalizedSearchHit[]> {
    signal.throwIfAborted();
    return this.#createHits(request);
  }
}

function createCompactPlan(
  strategy: "evidence_assisted" | "plan_first",
  title = "Python 学习路径",
): GraphPlan {
  return {
    analysis: {
      intent: "learn",
      topic: "Python",
      freshnessSensitive: strategy === "evidence_assisted",
      ambiguityLevel: strategy === "evidence_assisted" ? "medium" : "low",
      broadSearchQueries:
        strategy === "evidence_assisted"
          ? ["Python current ecosystem", "Python official documentation"]
          : [],
      strategy,
      presentationMode: "compact",
    },
    nodes: [
      {
        id: "python-path",
        title,
        description: "浏览 Python 学习资料",
        nodeType: "primary",
        layer: 0,
        searchPlan: {
          queries: ["Python learning path", "Python official tutorial"],
          maxResults: 10,
          rankingProfile: "knowledge",
          providerHints: ["general"],
        },
        status: "planned",
      },
    ],
    edges: [],
  };
}

function createEvidence(request: ProviderSearchRequest): NormalizedSearchHit[] {
  return [
    {
      provider: "fake-search",
      query: request.query,
      title: "PRIVATE_EVIDENCE_TITLE",
      url: "https://private.example/path",
      canonicalUrl: "https://private.example/path",
      domain: "private.example",
      snippet: "PRIVATE_EVIDENCE_SNIPPET",
      providerRank: 1,
      providerScore: 0.9,
      rawMetadata: { privateField: "PRIVATE_PROVIDER_METADATA" },
    },
  ];
}

function createInput(
  llmProvider: LLMProvider,
  overrides: Partial<
    Parameters<typeof evaluatePlannerGoldenQuery>[0]
  > = {},
): Parameters<typeof evaluatePlannerGoldenQuery>[0] {
  return {
    query: GOLDEN_QUERY,
    llmProvider,
    searchProvider: new FakeSearchProvider(),
    ...overrides,
  };
}

describe("Planner Golden 单条 Query 编排", () => {
  it("plan_first 只运行 Planner，并记录自动指标与可用 Token", async () => {
    const plan = createCompactPlan("plan_first");
    const result = await evaluatePlannerGoldenQuery(
      createInput(new FakeLLMProvider([plan]), {
        readTokenUsages: () => [
          { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        ],
      }),
    );

    expect(result).toMatchObject({
      executionStatus: "completed",
      strategy: "plan_first",
      fallback: null,
      suggestedOutcome: null,
      calls: { llm: 1, search: 0, extract: 0 },
      metrics: {
        schemaValid: true,
        validatorValid: true,
        dagValid: true,
        nodeCount: 1,
        edgeCount: 0,
        edgeCoverage: 0,
      },
      tokenUsage: {
        status: "available",
        callCount: 1,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      },
      estimatedCost: {
        status: "unavailable",
        reason: "pricing_not_frozen",
      },
      resourceMetrics: {
        status: "notApplicable",
        reason: "planner_only_baseline",
      },
    });
    if (result.executionStatus !== "completed") {
      throw new Error("测试预期获得已完成结果");
    }
    const review = renderCompletedReview(result);
    expect(review).toContain("必要性 1～5");
    expect(review).toContain("粒度 1～5");
    expect(review).toContain("与其他 Node 不重复 1～5");
    expect(review).toContain("推荐顺序合理性 1～5");
    expect(review).toContain("Related 相关性 1～5");
    expect(review).toContain("SearchPlan 质量 1～5");
  });

  it("evidence_assisted 仅执行一轮 Discovery 与一次 Reviser", async () => {
    const initialPlan = createCompactPlan("evidence_assisted");
    const revisedPlan = createCompactPlan(
      "evidence_assisted",
      "基于当前生态的 Python 学习路径",
    );
    const result = await evaluatePlannerGoldenQuery(
      createInput(new FakeLLMProvider([initialPlan, revisedPlan]), {
        readSearchHttpAttemptCount: () => 2,
        readTokenUsages: () => [
          { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          { inputTokens: 200, outputTokens: 30, totalTokens: 230 },
        ],
      }),
    );

    expect(result).toMatchObject({
      executionStatus: "completed",
      strategy: "evidence_assisted",
      finalPlan: revisedPlan,
      fallback: null,
      calls: {
        llm: 2,
        search: 2,
        searchHttpAttempts: 2,
        extract: 0,
      },
      tokenUsage: {
        status: "available",
        callCount: 2,
        inputTokens: 300,
        outputTokens: 50,
        totalTokens: 350,
      },
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("PRIVATE_EVIDENCE");
    expect(serialized).not.toContain("PRIVATE_PROVIDER_METADATA");
  });

  it("零 Evidence 时保留 Initial Plan 并建议 targetedIterate", async () => {
    const initialPlan = createCompactPlan("evidence_assisted");
    const result = await evaluatePlannerGoldenQuery(
      createInput(new FakeLLMProvider([initialPlan]), {
        searchProvider: new FakeSearchProvider(() => []),
      }),
    );

    expect(result).toMatchObject({
      executionStatus: "completed",
      initialPlan,
      finalPlan: initialPlan,
      fallback: { stage: "broad_discovery", reason: "no_evidence" },
      suggestedOutcome: "targetedIterate",
      calls: { llm: 1, search: 2, extract: 0 },
    });
  });

  it("Reviser 普通失败时保留 Initial Plan，且不吞掉失败分类", async () => {
    const initialPlan = createCompactPlan("evidence_assisted");
    const result = await evaluatePlannerGoldenQuery(
      createInput(
        new FakeLLMProvider([
          initialPlan,
          new LLMProviderError("provider_failure", false),
        ]),
      ),
    );

    expect(result).toMatchObject({
      executionStatus: "completed",
      finalPlan: initialPlan,
      fallback: { stage: "graph_reviser", reason: "provider_failure" },
      suggestedOutcome: "targetedIterate",
      calls: { llm: 2, search: 2, extract: 0 },
    });
  });

  it("Planner compact fallback 不会被报告为正常成功", async () => {
    const result = await evaluatePlannerGoldenQuery(
      createInput(
        new FakeLLMProvider([
          new LLMProviderError("provider_failure", false),
        ]),
      ),
    );

    expect(result).toMatchObject({
      executionStatus: "completed",
      strategy: null,
      presentationMode: null,
      fallback: { stage: "planner", reason: "provider_failure" },
      suggestedOutcome: "targetedIterate",
      calls: { llm: 1, search: 0, extract: 0 },
      tokenUsage: {
        status: "unavailable",
        reason: "missing_or_invalid_provider_usage",
      },
    });
  });

  it("报告投影删除 Evidence 原文、URL，并保留不可逆 Fingerprint", async () => {
    const initialPlan = createCompactPlan("evidence_assisted");
    const unsafeRevisedPlan = createCompactPlan("evidence_assisted");
    const unsafeNode = unsafeRevisedPlan.nodes[0];
    if (unsafeNode === undefined) {
      throw new Error("测试计划必须包含 Node");
    }
    unsafeRevisedPlan.nodes[0] = {
      ...unsafeNode,
      id: "https://private.example/path-PRIVATE_EVIDENCE_TITLE",
      title: "PRIVATE_EVIDENCE_TITLE",
      description:
        "![tracking](https://private.example/path) PRIVATE_EVIDENCE_SNIPPET",
      searchPlan: {
        ...unsafeNode.searchPlan,
        queries: ["https://private.example/path"],
        maxResults: 20,
      },
    };

    const result = await evaluatePlannerGoldenQuery(
      createInput(new FakeLLMProvider([initialPlan, unsafeRevisedPlan])),
    );
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      executionStatus: "completed",
      reportSanitization: {
        evidenceRedactionCount: expect.any(Number),
        urlRedactionCount: expect.any(Number),
      },
      planFingerprints: {
        initialSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        finalSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    expect(serialized).not.toContain("PRIVATE_EVIDENCE");
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("https://");
    if (result.executionStatus !== "completed") {
      throw new Error("测试预期获得已完成结果");
    }
    const review = renderCompletedReview(result);
    expect(review).not.toContain("![");
    expect(review).not.toContain("<img");
    expect(review).not.toContain("https://");
    expect(result.metrics.searchPlans[0]?.nodeId).toBe(
      result.finalPlan.nodes[0]?.id,
    );
  });

  it("Planner fallback 不计入实际 Strategy 覆盖", async () => {
    const plannerFallback = await evaluatePlannerGoldenQuery(
      createInput(
        new FakeLLMProvider([
          new LLMProviderError("provider_failure", false),
        ]),
      ),
    );
    const evidencePlan = createCompactPlan("evidence_assisted");
    const evidenceResult = await evaluatePlannerGoldenQuery(
      createInput(new FakeLLMProvider([evidencePlan, evidencePlan])),
    );

    expect(summarizeResults([plannerFallback, evidenceResult])).toMatchObject({
      observedStrategies: ["evidence_assisted"],
      bothStrategiesObserved: false,
      engineeringDisposition: "insufficientStrategyEvidence",
    });
  });
});

describe("Planner Golden 取消与程序错误边界", () => {
  it("绝对 Deadline 不自动决定四态，并保留最小计数", async () => {
    const waitForAbort = ({ signal }: LLMCallOptions): Promise<unknown> =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });

    const result = await evaluatePlannerGoldenQuery(
      createInput(new FakeLLMProvider([waitForAbort]), {
        runDeadlineMs: 10,
      }),
    );

    expect(result).toMatchObject({
      executionStatus: "deadline_exceeded",
      suggestedOutcome: null,
      calls: { llm: 1, search: 0, extract: 0 },
    });
  });

  it("人员取消不自动决定四态，且取消前不调用 Provider", async () => {
    const controller = new AbortController();
    const reason = new Error("人员取消");
    reason.name = "AbortError";
    controller.abort(reason);

    const result = await evaluatePlannerGoldenQuery(
      createInput(new FakeLLMProvider([createCompactPlan("plan_first")]), {
        signal: controller.signal,
      }),
    );

    expect(result).toMatchObject({
      executionStatus: "cancelled",
      suggestedOutcome: null,
      calls: { llm: 0, search: 0, extract: 0 },
    });
    expect(JSON.stringify(result)).not.toContain("人员取消");
  });

  it("未知程序错误原样抛出，不伪装为受控 Eval 结果", async () => {
    const programmingError = new TypeError("PRIVATE_PROGRAMMING_DETAIL");

    await expect(
      evaluatePlannerGoldenQuery(
        createInput(new FakeLLMProvider([programmingError])),
      ),
    ).rejects.toBe(programmingError);
  });

  it("拒绝突破 20 秒硬上限的测试配置", async () => {
    await expect(
      evaluatePlannerGoldenQuery(
        createInput(new FakeLLMProvider([createCompactPlan("plan_first")]), {
          runDeadlineMs: 20_001,
        }),
      ),
    ).rejects.toThrow(RangeError);
  });

  it("拒绝突破 15 秒硬上限的 LLM 阶段配置", async () => {
    await expect(
      evaluatePlannerGoldenQuery(
        createInput(new FakeLLMProvider([createCompactPlan("plan_first")]), {
          llmStageTimeoutMs: 15_001,
        }),
      ),
    ).rejects.toThrow(RangeError);
  });
});
