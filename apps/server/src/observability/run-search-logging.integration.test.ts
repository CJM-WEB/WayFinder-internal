/**
 * 测试职责：用真实 Orchestrator、Cache 与 DeepSeek Adapter 的本地替身证明 Run Log
 * 能按 Run 聚合阶段、调用、Cache、Token 与终态，同时不保存任何原始输入或网页正文。
 */
import {
  GraphPlanSchema,
  type GraphPlan,
  type NormalizedSearchHit,
  type StreamEventPayload,
} from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import { DeepSeekLLMProvider } from "../ai/providers/deepseek-llm-provider.js";
import { createConcurrencyLimitedProviders } from "../orchestrator/provider-concurrency.js";
import { createRunSearchHandler } from "../orchestrator/run-search.js";
import { createMemoryCachedSearchProvider } from "../search/memory-cached-provider.js";
import {
  createFixedClock,
  FakeSearchProvider,
} from "../../../../tests/support/test-infrastructure.mjs";
import type { RunLogRecord } from "./run-log.js";

const PRIVATE_QUERY = "Authorization Bearer private-key Cookie=session-secret";
const PRIVATE_PAGE_BODY = "Provider raw response and full private page body";

function createPlan(): GraphPlan {
  return GraphPlanSchema.parse({
    analysis: {
      intent: "learn",
      topic: PRIVATE_QUERY,
      freshnessSensitive: false,
      ambiguityLevel: "low",
      broadSearchQueries: [],
      strategy: "plan_first",
      presentationMode: "compact",
    },
    nodes: [
      {
        id: "privacy-node",
        title: "Privacy-safe logging",
        description: "Inspect safe metadata",
        nodeType: "primary",
        layer: 0,
        status: "planned",
        searchPlan: {
          queries: [PRIVATE_QUERY],
          maxResults: 20,
          rankingProfile: "knowledge",
          providerHints: ["general"],
        },
      },
    ],
    edges: [],
  });
}

function createRerankOutput() {
  return {
    ranking: [
      {
        candidateId: "candidate_1",
        scores: {
          relevance: 0.9,
          authority: 0.9,
          clarity: 0.9,
          completeness: 0.9,
          trustSafety: 0.9,
          freshness: 0.9,
        },
        summary: "安全摘要",
        whySelected: "与节点目标直接相关",
      },
    ],
  };
}

function createHit(): NormalizedSearchHit {
  const url = "https://private.example/resource";
  return {
    provider: "fake-search",
    query: PRIVATE_QUERY,
    title: PRIVATE_PAGE_BODY,
    url,
    canonicalUrl: url,
    domain: "private.example",
    snippet: PRIVATE_PAGE_BODY,
    providerRank: 1,
    providerScore: 0.9,
    rawMetadata: {
      authorization: "Bearer must-not-log",
      cookie: "session=must-not-log",
    },
  };
}

describe("Run Search Logging Integration", () => {
  it("按顺序记录冷/热 Cache 与完整 Token 聚合，且不保存敏感输入", async () => {
    const clock = createFixedClock("2026-10-22T00:00:00.000Z");
    const plan = createPlan();
    const responses = [
      plan,
      createRerankOutput(),
      plan,
      createRerankOutput(),
    ];
    const hit = createHit();
    const baseSearchProvider = new FakeSearchProvider({
      searchResponses: { [PRIVATE_QUERY]: [hit] },
      extractResponse: [
        {
          canonicalUrl: hit.canonicalUrl,
          content: PRIVATE_PAGE_BODY,
        },
      ],
    });
    const cachedSearchProvider = createMemoryCachedSearchProvider(
      baseSearchProvider,
      { nowMs: clock.now },
    );
    const llmProvider = new DeepSeekLLMProvider({
      apiKey: "test-only-key",
      transport: async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("测试响应耗尽");
        return {
          status: "completed",
          output_text: JSON.stringify(response),
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
          },
        };
      },
    });
    const records: RunLogRecord[] = [];
    const ids = Array.from(
      { length: 6 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    let idIndex = 0;
    const handler = createRunSearchHandler({
      providers: createConcurrencyLimitedProviders({
        searchProvider: cachedSearchProvider,
        llmProvider,
        concurrency: { search: 6, llm: 3 },
      }),
      officialSourcePolicy: { knownRiskyDownloadDomains: [] },
      llmStageTimeoutMs: 30_000,
      rerankTimeoutMs: 24_000,
      normalizeQuery: query => query.normalize("NFKC"),
      onPlannerValidationDiagnostic: () => undefined,
      onRevisionValidationDiagnostic: () => undefined,
      runLogSink: {
        write: async record => {
          records.push(record);
        },
      },
      createRunLogId: () => ids[idIndex++]!,
      now: clock.now,
    });

    for (const runId of ["../../first-secret", "../../second-secret"]) {
      const payloads: StreamEventPayload[] = [];
      await handler({
        input: { runId, query: PRIVATE_QUERY, language: "zh-CN" },
        signal: new AbortController().signal,
        emit: async payload => {
          payloads.push(payload);
        },
      });
      expect(payloads.at(-1)?.type).toBe("complete");
    }

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      outcome: "complete",
      counts: {
        plannedNodes: 1,
        resources: 1,
        logicalSearchCalls: 1,
        logicalExtractCalls: 0,
        logicalLlmCalls: 2,
      },
      cache: {
        search: { hitCount: 0, missCount: 1 },
        extract: { hitCount: 0, missCount: 0 },
      },
      ranking: {
        llmSuccess: {
          nodeCount: 1,
          finalCandidateCount: 1,
          providerTop1OverrideCount: 0,
          heuristicTop1OverrideCount: 0,
          providerTop3FinalOverlapCount: 1,
          heuristicTop3FinalOverlapCount: 1,
          top3ComparisonSlots: 1,
        },
        fallback: {
          nodeCount: 0,
          finalCandidateCount: 0,
          providerTop1OverrideCount: 0,
          heuristicTop1OverrideCount: 0,
          providerTop3FinalOverlapCount: 0,
          heuristicTop3FinalOverlapCount: 0,
          top3ComparisonSlots: 0,
        },
      },
      tokens: {
        status: "complete",
        observations: 2,
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      },
    });
    expect(records[1]).toMatchObject({
      cache: {
        search: { hitCount: 1, missCount: 0 },
        extract: { hitCount: 0, missCount: 0 },
      },
      ranking: {
        llmSuccess: { nodeCount: 1 },
        fallback: { nodeCount: 0 },
      },
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(PRIVATE_QUERY);
    expect(serialized).not.toContain(PRIVATE_PAGE_BODY);
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("test-only-key");
    expect(serialized).not.toContain("../../first-secret");
  });

  it("日志 Sink 失败不改变 Stream 终态或向调用方泄露错误", async () => {
    const clock = createFixedClock("2026-10-22T00:00:00.000Z");
    const plan = createPlan();
    const hit = createHit();
    const payloads: StreamEventPayload[] = [];
    const onRunLogWriteFailure = vi.fn();
    let idIndex = 0;
    const handler = createRunSearchHandler({
      providers: createConcurrencyLimitedProviders({
        searchProvider: new FakeSearchProvider({
          searchResponses: { [PRIVATE_QUERY]: [hit] },
          extractResponse: [
            { canonicalUrl: hit.canonicalUrl, content: PRIVATE_PAGE_BODY },
          ],
        }),
        llmProvider: new DeepSeekLLMProvider({
          apiKey: "test-only-key",
          transport: async request => ({
            status: "completed",
            output_text: JSON.stringify(
              request.text.format.name.includes("graph")
                ? plan
                : createRerankOutput(),
            ),
          }),
        }),
        concurrency: { search: 6, llm: 3 },
      }),
      officialSourcePolicy: { knownRiskyDownloadDomains: [] },
      llmStageTimeoutMs: 30_000,
      rerankTimeoutMs: 24_000,
      normalizeQuery: query => query,
      onPlannerValidationDiagnostic: () => undefined,
      onRevisionValidationDiagnostic: () => undefined,
      runLogSink: {
        write: async () => {
          throw new Error(PRIVATE_PAGE_BODY);
        },
      },
      createRunLogId: () =>
        `00000000-0000-4000-8000-${String(++idIndex).padStart(12, "0")}`,
      onRunLogWriteFailure,
      now: clock.now,
    });

    await expect(
      handler({
        input: {
          runId: "run-safe",
          query: PRIVATE_QUERY,
          language: "zh-CN",
        },
        signal: new AbortController().signal,
        emit: async payload => {
          payloads.push(payload);
        },
      }),
    ).resolves.toBeUndefined();

    expect(payloads.at(-1)?.type).toBe("complete");
    expect(onRunLogWriteFailure).toHaveBeenCalledTimes(1);
  });

  it("日志 Sink 永不结束时也不阻塞用户可见 Run", async () => {
    const clock = createFixedClock("2026-10-22T00:00:00.000Z");
    const plan = createPlan();
    const hit = createHit();
    const payloads: StreamEventPayload[] = [];
    let idIndex = 0;
    const handler = createRunSearchHandler({
      providers: createConcurrencyLimitedProviders({
        searchProvider: new FakeSearchProvider({
          searchResponses: { [PRIVATE_QUERY]: [hit] },
          extractResponse: [
            { canonicalUrl: hit.canonicalUrl, content: PRIVATE_PAGE_BODY },
          ],
        }),
        llmProvider: new DeepSeekLLMProvider({
          apiKey: "test-only-key",
          transport: async request => ({
            status: "completed",
            output_text: JSON.stringify(
              request.text.format.name.includes("graph")
                ? plan
                : createRerankOutput(),
            ),
          }),
        }),
        concurrency: { search: 6, llm: 3 },
      }),
      officialSourcePolicy: { knownRiskyDownloadDomains: [] },
      llmStageTimeoutMs: 30_000,
      rerankTimeoutMs: 24_000,
      normalizeQuery: query => query,
      onPlannerValidationDiagnostic: () => undefined,
      onRevisionValidationDiagnostic: () => undefined,
      runLogSink: {
        write: () => new Promise<void>(() => undefined),
      },
      createRunLogId: () =>
        `00000000-0000-4000-8000-${String(++idIndex).padStart(12, "0")}`,
      now: clock.now,
    });

    const outcome = await Promise.race([
      handler({
        input: {
          runId: "run-safe",
          query: PRIVATE_QUERY,
          language: "zh-CN",
        },
        signal: new AbortController().signal,
        emit: async payload => {
          payloads.push(payload);
        },
      }).then(() => "complete" as const),
      new Promise<"timed-out">(resolve => {
        setTimeout(() => resolve("timed-out"), 100);
      }),
    ]);

    expect(outcome).toBe("complete");
    expect(payloads.at(-1)?.type).toBe("complete");
  });
});
