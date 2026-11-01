/**
 * 测试职责：离线串联引擎偏好、Broad / Node 请求和实际资源来源，防止中间白名单丢字段。
 * 所有 HTTP 与模型响应均为固定样例，不读取环境配置或访问真实服务。
 */
import type { StreamEventPayload } from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import type { LLMProvider } from "../ai/llm-provider.js";
import { createConcurrencyLimitedProviders } from "../orchestrator/provider-concurrency.js";
import { createRunSearchHandler } from "../orchestrator/run-search.js";
import { SerpApiBingSearchProvider } from "./providers/serpapi-bing.js";

describe("搜索引擎贯穿生产链路", () => {
  it("中文覆盖 Google 时 Broad 与 Node 均保持中国语境，最终资源保留实际 Google 来源", async () => {
    const query = "TypeScript";
    const outline = {
      analysis: {
        intent: "learn", topic: query, freshnessSensitive: false, ambiguityLevel: "low",
        broadSearchQueries: ["TypeScript ecosystem"], strategy: "evidence_assisted", presentationMode: "compact",
      },
      nodes: [{ id: "node", title: "编译器文档", description: "TypeScript 编译器选项", nodeType: "primary", layer: 0, status: "planned" }],
      edges: [],
    };
    const responses: unknown[] = [
      outline, outline,
      { plans: [{ nodeId: "node", queries: ["TypeScript compiler options"], rankingProfile: "knowledge" }] },
      { ranking: [{
        candidateId: "candidate_1",
        scores: { relevance: 0.9, authority: 0.9, clarity: 0.9, completeness: 0.9, trustSafety: 0.9, freshness: 0.9 },
        summary: "编译器文档。", whySelected: "解释编译器配置。",
      }] },
    ];
    const llmInputs: string[] = [];
    const llmProvider: LLMProvider = {
      id: "fixture-llm",
      structured: async input => {
        llmInputs.push(input.user);
        if (responses.length === 0) throw new Error("未预期的模型调用");
        return responses.shift();
      },
    };
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      search_metadata: { status: "Success" },
      organic_results: [{ position: 1, title: "Compiler reference", link: "https://docs.example.com/compiler?utm_source=fixture", snippet: "Compiler options reference." }],
    }), { headers: { "content-type": "application/json" } }));
    const searchProvider = new SerpApiBingSearchProvider({ apiKey: "fixture-key", searchTimeoutMs: 1_000, fetchImplementation });
    const handler = createRunSearchHandler({
      providers: createConcurrencyLimitedProviders({ searchProvider, llmProvider, concurrency: { search: 1, llm: 1 } }),
      officialSourcePolicy: { knownRiskyDownloadDomains: [] },
      llmStageTimeoutMs: 30_000, rerankTimeoutMs: 24_000, normalizeQuery: value => value,
      onPlannerValidationDiagnostic: () => undefined,
      onRevisionValidationDiagnostic: () => undefined,
      onSearchPlanValidationDiagnostic: () => undefined,
    });
    const payloads: StreamEventPayload[] = [];
    await handler({
      input: { runId: "run-engine", query, language: "zh-CN", engine: "google" },
      signal: new AbortController().signal,
      emit: async payload => { payloads.push(payload); },
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    for (const [input] of fetchImplementation.mock.calls) {
      const params = new URL(String(input)).searchParams;
      expect(params.get("engine")).toBe("google");
      expect(params.get("hl")).toBe("zh-cn");
      expect(params.get("gl")).toBe("cn");
      expect(params.has("ct")).toBe(false);
    }
    const completion = payloads.find(payload => payload.type === "complete");
    expect(completion?.type).toBe("complete");
    if (completion?.type !== "complete") throw new Error("未收到完成结果");
    expect(completion.data.result.query.language).toBe("zh-CN");
    expect(completion.data.result.graph.nodes[0]?.resources[0]).toMatchObject({
      searchProvider: "serpapi_bing", engine: "google", canonicalUrl: "https://docs.example.com/compiler",
    });
    expect(llmInputs).toHaveLength(4);
    expect(llmInputs.every(input => !input.includes('"engine"'))).toBe(true);
  });
});
