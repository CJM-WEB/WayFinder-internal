/**
 * 测试职责：冻结 WAY-54 的 Heuristic fallback、精确 Warning 与生命周期传播语义。
 *
 * 关键约束：只有 ResourceRerankError 可以降级；取消、Run Deadline、独立 AbortError
 * 和未知程序错误必须继续向上抛出，空候选不得伪造 partial。
 */
import type {
  GraphNodeCore,
  ResourceCandidate,
} from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import {
  createDeferred,
  FakeLLMProvider,
} from "../../../../tests/support/test-infrastructure.mjs";
import {
  LLMProviderError,
  type LLMProvider,
} from "../ai/llm-provider.js";
import {
  rerankCandidatesWithFallback,
  type RerankCandidatesWithFallbackInput,
} from "./rerank-candidates.js";

function createNode(): GraphNodeCore {
  return {
    id: "typescript-learning",
    title: "TypeScript 学习资料",
    description: "选择准确、清晰且完整的学习资料。",
    nodeType: "primary",
    layer: 0,
    searchPlan: {
      queries: ["TypeScript learning resources"],
      maxResults: 20,
      rankingProfile: "knowledge",
      providerHints: ["general"],
    },
  };
}

function createCandidate(index: number): ResourceCandidate {
  return {
    candidateId: `candidate_${index}`,
    hit: {
      provider: "test-search",
      query: "TypeScript learning resources",
      title: `TypeScript resource ${index}`,
      url: `https://example.com/${index}`,
      canonicalUrl: `https://example.com/${index}`,
      domain: "example.com",
      snippet: `Safe snippet ${index}`,
      providerRank: index,
    },
    heuristicScore: 1 - index / 10,
    heuristicSignals: { providerQuality: 1 - index / 10 },
    ...(index === 1 ? { sourceType: "documentation" } : {}),
  };
}

function createDecision(candidateId: string, score: number) {
  return {
    candidateId,
    scores: {
      relevance: score,
      authority: score,
      clarity: score,
      completeness: score,
      trustSafety: score,
      freshness: score,
    },
    summary: `Summary for ${candidateId}`,
    whySelected: `Why ${candidateId} fits this node`,
  };
}

function createInput(
  provider: LLMProvider,
  overrides: Partial<RerankCandidatesWithFallbackInput> = {},
): RerankCandidatesWithFallbackInput {
  return {
    node: createNode(),
    candidates: [createCandidate(1), createCandidate(2)],
    pages: [],
    provider,
    signal: new AbortController().signal,
    timeoutMs: 12_000,
    ...overrides,
  };
}

describe("rerankCandidatesWithFallback 成功路径", () => {
  it("合并 Decision 后执行三路融合，并保持 Candidate 身份与输入不变", async () => {
    const candidates = [createCandidate(1), createCandidate(2)];
    const snapshot = structuredClone(candidates);
    const provider = new FakeLLMProvider([
      {
        ranking: [
          createDecision("candidate_2", 0.9),
          createDecision("candidate_1", 0.2),
        ],
      },
    ]);

    const outcome = await rerankCandidatesWithFallback(
      createInput(provider, { candidates }),
    );

    expect(outcome.kind).toBe("llm_success");
    expect(outcome.warnings).toEqual([]);
    expect(outcome.candidates.map(candidate => candidate.candidateId)).toEqual([
      "candidate_1",
      "candidate_2",
    ]);
    expect(outcome.candidates[1]).toMatchObject({
      hit: candidates[1]!.hit,
      heuristicScore: candidates[1]!.heuristicScore,
      heuristicSignals: candidates[1]!.heuristicSignals,
      scores: createDecision("candidate_2", 0.9).scores,
      summary: "Summary for candidate_2",
      whySelected: "Why candidate_2 fits this node",
    });
    expect(outcome.candidates[0]?.sourceType).toBe("documentation");
    expect(candidates).toEqual(snapshot);
  });

  it("空候选不调用 LLM，也不产生无 Resource 的 Warning", async () => {
    const provider = new FakeLLMProvider([]);

    await expect(
      rerankCandidatesWithFallback(
        createInput(provider, { candidates: [], pages: [] }),
      ),
    ).resolves.toEqual({
      kind: "llm_success",
      candidates: [],
      warnings: [],
    });
    expect(provider.calls).toHaveLength(0);
  });
});

describe("rerankCandidatesWithFallback 普通失败", () => {
  it("LLM 使用 Provider 顺序，失败时按同集合的 11:2 双路融合", async () => {
    const providerOrdered = [createCandidate(1), createCandidate(2)];
    const heuristicOrdered = [providerOrdered[1]!, providerOrdered[0]!];
    const provider = new FakeLLMProvider([
      new LLMProviderError("provider_failure", true),
    ]);

    const outcome = await rerankCandidatesWithFallback(
      createInput(provider, {
        candidates: providerOrdered,
        fallbackCandidates: heuristicOrdered,
      }),
    );

    expect(outcome.kind).toBe("fallback");
    expect(outcome.candidates).toEqual(providerOrdered);
    expect(outcome.warnings).toEqual(["RERANK_FAILED"]);
  });

  it("拒绝 Provider 与 fallback 使用不同候选集合", async () => {
    const provider = new FakeLLMProvider([]);
    const candidates = [createCandidate(1), createCandidate(2)];

    await expect(
      rerankCandidatesWithFallback(
        createInput(provider, {
          candidates,
          fallbackCandidates: [candidates[0]!],
        }),
      ),
    ).rejects.toThrow("候选集合不一致");
    expect(provider.calls).toHaveLength(0);
  });

  it("拒绝 fallback 复用 Candidate ID 却替换 canonical URL", async () => {
    const provider = new FakeLLMProvider([]);
    const candidates = [createCandidate(1), createCandidate(2)];
    const replacedIdentity = {
      ...candidates[1]!,
      hit: {
        ...candidates[1]!.hit,
        url: "https://attacker.invalid/replaced",
        canonicalUrl: "https://attacker.invalid/replaced",
        domain: "attacker.invalid",
      },
    };

    await expect(
      rerankCandidatesWithFallback(
        createInput(provider, {
          candidates,
          fallbackCandidates: [candidates[0]!, replacedIdentity],
        }),
      ),
    ).rejects.toThrow("候选集合不一致");
    expect(provider.calls).toHaveLength(0);
  });

  it("拒绝 fallback 用重复 Candidate ID 冒充完整集合", async () => {
    const provider = new FakeLLMProvider([]);
    const candidates = [createCandidate(1), createCandidate(2)];

    await expect(
      rerankCandidatesWithFallback(
        createInput(provider, {
          candidates,
          fallbackCandidates: [candidates[0]!, candidates[0]!],
        }),
      ),
    ).rejects.toThrow("候选集合不一致");
    expect(provider.calls).toHaveLength(0);
  });

  it.each([
    [
      "Provider 失败",
      new LLMProviderError("provider_failure", true),
    ],
    ["Schema 非法", { unexpected: "private-provider-payload" }],
    [
      "Candidate 映射非法",
      { ranking: [createDecision("candidate_1", 0.9)] },
    ],
    [
      "Candidate ID 重复",
      {
        ranking: [
          createDecision("candidate_1", 0.9),
          createDecision("candidate_1", 0.8),
        ],
      },
    ],
    [
      "Candidate ID 未知",
      {
        ranking: [
          createDecision("candidate_1", 0.9),
          createDecision("candidate_unknown", 0.8),
        ],
      },
    ],
    [
      "Profile Score 非法",
      {
        ranking: [
          {
            ...createDecision("candidate_1", 0.9),
            scores: { relevance: 0.9 },
          },
          {
            ...createDecision("candidate_2", 0.8),
            scores: { relevance: 0.8 },
          },
        ],
      },
    ],
  ])("%s 回退到 11:2 融合并只产生 RERANK_FAILED", async (_name, response) => {
    const candidates = [createCandidate(1), createCandidate(2)];
    const pages = [
      {
        canonicalUrl: candidates[0]!.hit.canonicalUrl,
        content: "private extracted page content",
      },
    ];
    const provider = new FakeLLMProvider([response]);

    const outcome = await rerankCandidatesWithFallback(
      createInput(provider, { candidates, pages }),
    );

    expect(outcome).toEqual({
      kind: "fallback",
      candidates,
      warnings: ["RERANK_FAILED"],
    });
    expect(outcome.candidates[0]).toBe(candidates[0]);
    expect(outcome.candidates[1]).toBe(candidates[1]);
    expect(JSON.stringify(outcome)).not.toContain("private extracted page content");
    expect(JSON.stringify(outcome)).not.toContain("private-provider-payload");
  });

  it("Reranker 阶段预算耗尽但 Run 仍有效时允许降级", async () => {
    const provider = new FakeLLMProvider([
      {
        ranking: [
          createDecision("candidate_1", 0.9),
          createDecision("candidate_2", 0.8),
        ],
      },
    ]);
    const times = [1_000, 9_000];

    const outcome = await rerankCandidatesWithFallback(
      createInput(provider, {
        timeoutMs: 8_000,
        now: () => times.shift() ?? 9_000,
      }),
    );

    expect(outcome.warnings).toEqual(["RERANK_FAILED"]);
    expect(outcome.kind).toBe("fallback");
    expect(provider.calls).toHaveLength(0);
  });
});

describe("rerankCandidatesWithFallback 生命周期与未知错误", () => {
  it.each([
    ["用户取消", new DOMException("request cancelled", "AbortError")],
    ["Run Deadline", new DOMException("run deadline", "TimeoutError")],
  ])("调用前%s原样传播且不调用 LLM", async (_name, reason) => {
    const controller = new AbortController();
    controller.abort(reason);
    const provider = new FakeLLMProvider([
      {
        ranking: [
          createDecision("candidate_1", 0.9),
          createDecision("candidate_2", 0.8),
        ],
      },
    ]);

    await expect(
      rerankCandidatesWithFallback(
        createInput(provider, { signal: controller.signal }),
      ),
    ).rejects.toBe(reason);
    expect(provider.calls).toHaveLength(0);
  });

  it("调用中取消原样传播，不能转换为 fallback", async () => {
    const deferred = createDeferred<unknown>();
    const controller = new AbortController();
    const reason = new DOMException("run deadline", "TimeoutError");
    const provider = new FakeLLMProvider([deferred.promise]);
    const pending = rerankCandidatesWithFallback(
      createInput(provider, { signal: controller.signal }),
    );

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it.each([
    ["独立 AbortError", new DOMException("provider aborted", "AbortError")],
    ["未知程序错误", new Error("programming failure")],
  ])("未终止 Run 下的%s原样传播", async (_name, error) => {
    const provider = new FakeLLMProvider([error]);

    await expect(
      rerankCandidatesWithFallback(createInput(provider)),
    ).rejects.toBe(error);
  });

  it("无效 timeout 属于调用方错误，不能被包装成 RERANK_FAILED", async () => {
    const provider = new FakeLLMProvider([]);

    await expect(
      rerankCandidatesWithFallback(createInput(provider, { timeoutMs: 0 })),
    ).rejects.toBeInstanceOf(RangeError);
    expect(provider.calls).toHaveLength(0);
  });
});
