/**
 * 测试职责：用生产编排与固定 Provider 替身验证单节点重搜范围、预算、日志和取消。
 * 测试不读取环境文件，不调用真实搜索或模型；人工图仅提交选中目标，不限制原图节点数。
 */
import {
  SearchRequestSchema,
  type NormalizedSearchHit,
  type QueryAnalysis,
  type StreamEventPayload,
} from "@wayfinder/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDeferred, createFixedClock } from "../../../../tests/support/test-infrastructure.mjs";
import type { LLMProvider } from "../ai/llm-provider.js";
import type { RunLogRecord } from "../observability/run-log.js";
import type { SearchProvider } from "../search/provider.js";
import { createConcurrencyLimitedProviders } from "./provider-concurrency.js";
import { createRunSearchHandler } from "./run-search.js";

const TARGET_ID = "8094ac90-75b6-4a8d-badf-74c294b37a22";
const TARGET_TITLE = "NVIDIA 驱动安装说明";
const SEARCH_QUERY = "NVIDIA graphics driver installation documentation";
const SAVED_ANALYSIS: QueryAnalysis = {
  intent: "news", topic: "NVIDIA", freshnessSensitive: true, ambiguityLevel: "high",
  strategy: "evidence_assisted", broadSearchQueries: ["NVIDIA latest"], presentationMode: "graph",
};
const BUNDLE = { plans: [{ nodeId: TARGET_ID, queries: [SEARCH_QUERY], rankingProfile: "software" }] };

function request(analysis: QueryAnalysis | null = SAVED_ANALYSIS) {
  return SearchRequestSchema.parse({
    runId: "node-search-run", query: "NVIDIA", language: "zh-CN", engine: "google",
    nodeSearch: { node: { id: TARGET_ID, title: TARGET_TITLE, description: "" }, analysis },
  });
}

function hits(count: number): NormalizedSearchHit[] {
  return Array.from({ length: count }, (_, index) => ({
    provider: "fixture-search", engine: "google", query: SEARCH_QUERY,
    title: `Driver document ${index}`, snippet: "NVIDIA driver installation documentation.",
    url: `https://docs-${index}.example.com/driver`, canonicalUrl: `https://docs-${index}.example.com/driver`,
    domain: `docs-${index}.example.com`, providerRank: index + 1, rawMetadata: {},
  }));
}

function rerank(count: number) {
  return { ranking: Array.from({ length: count }, (_, index) => ({
    candidateId: `candidate_${index + 1}`,
    scores: { relevance: 0.9, authority: 0.9, clarity: 0.9, completeness: 0.9, trustSafety: 0.9, freshness: 0.9 },
    summary: "安装文档。", whySelected: "与节点安装需求相关。",
  })) };
}

function handlerFor(
  structured: LLMProvider["structured"],
  search: SearchProvider["search"],
  records: RunLogRecord[] = [],
  now?: () => number,
) {
  return createRunSearchHandler({
    providers: createConcurrencyLimitedProviders({
      searchProvider: { id: "fixture-search", capabilities: ["general"], search },
      llmProvider: { id: "fixture-llm", structured }, concurrency: { search: 1, llm: 1 },
      ...(now === undefined ? {} : { now }),
    }),
    officialSourcePolicy: { knownRiskyDownloadDomains: [] },
    llmStageTimeoutMs: 30_000, rerankTimeoutMs: 24_000, normalizeQuery: value => value,
    onPlannerValidationDiagnostic: () => undefined,
    onRevisionValidationDiagnostic: () => undefined,
    onSearchPlanValidationDiagnostic: () => undefined,
    runLogSink: { write: async record => { records.push(record); } },
    ...(now === undefined ? {} : { now }),
  });
}

afterEach(() => vi.useRealTimers());

describe("单节点重搜生产编排", () => {
  it("真实分析跳过全图 Planner，以当前标题生成唯一查询、只搜索目标并最多交付六项", async () => {
    const structured = vi.fn<LLMProvider["structured"]>().mockResolvedValueOnce(BUNDLE).mockResolvedValueOnce(rerank(6));
    const search = vi.fn<SearchProvider["search"]>().mockResolvedValue(hits(7));
    const records: RunLogRecord[] = [];
    const payloads: StreamEventPayload[] = [];
    const input = request();
    const original = structuredClone(input);
    await handlerFor(structured, search, records)({ input, signal: new AbortController().signal, emit: async payload => { payloads.push(payload); } });

    expect(structured.mock.calls.map(([value]) => value.schemaName)).toEqual(["search_plan_bundle", "resource_rerank"]);
    const generation: unknown = JSON.parse(structured.mock.calls[0]?.[0].user ?? "null");
    expect(generation).toMatchObject({
      query: "NVIDIA", language: "zh-CN",
      outline: {
        analysis: { intent: "news", topic: "NVIDIA", freshnessSensitive: true, presentationMode: "compact", strategy: "plan_first", broadSearchQueries: [] },
        nodes: [{ id: TARGET_ID, title: TARGET_TITLE, description: TARGET_TITLE }], edges: [],
      },
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toMatchObject({ kind: "node", nodeId: TARGET_ID, query: SEARCH_QUERY, maxResults: 20, engine: "google", freshnessSensitive: true });
    const completion = payloads.find(payload => payload.type === "complete");
    if (completion?.type !== "complete") throw new Error("缺少完成结果");
    expect(completion.data.result.graph.nodes).toHaveLength(1);
    expect(completion.data.result.graph.nodes[0]?.id).toBe(TARGET_ID);
    expect(completion.data.result.graph.nodes[0]?.resources).toHaveLength(6);
    expect(input).toEqual(original);
    expect(records[0]?.planningStages.graphOutline.logicalLlmCalls).toBe(0);
    expect(records[0]?.planningStages.searchPlan.logicalLlmCalls).toBe(1);
  });

  it("缺失分析时复用 Planner 取得真实事实，但不采用其节点或执行 Broad / Reviser", async () => {
    const outline = {
      analysis: { ...SAVED_ANALYSIS, presentationMode: "compact" },
      nodes: [{ id: "unused-planner-node", title: "原主题", description: "原主题分析", nodeType: "primary", layer: 0, status: "planned" }], edges: [],
    };
    const structured = vi.fn<LLMProvider["structured"]>().mockResolvedValueOnce(outline).mockResolvedValueOnce(BUNDLE).mockResolvedValueOnce(rerank(1));
    const search = vi.fn<SearchProvider["search"]>().mockResolvedValue(hits(1));
    const payloads: StreamEventPayload[] = [];
    await handlerFor(structured, search)({ input: request(null), signal: new AbortController().signal, emit: async payload => { payloads.push(payload); } });
    expect(structured.mock.calls.map(([value]) => value.schemaName)).toEqual(["graph_outline", "search_plan_bundle", "resource_rerank"]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toMatchObject({ kind: "node", nodeId: TARGET_ID, freshnessSensitive: true });
    const plan = payloads.find(payload => payload.type === "graph.plan");
    expect(plan?.type === "graph.plan" ? plan.data.nodes.map(node => node.id) : []).toEqual([TARGET_ID]);
  });

  it.each(["deadline", "cancel"] as const)("%s 终止目标搜索，迟到结果不再发送资源或终态", async mode => {
    vi.useFakeTimers();
    const clock = createFixedClock(1_000);
    const entered = createDeferred<void>();
    const late = createDeferred<NormalizedSearchHit[]>();
    const structured = vi.fn<LLMProvider["structured"]>().mockResolvedValueOnce(BUNDLE);
    const search = vi.fn<SearchProvider["search"]>().mockImplementation(async () => { entered.resolve(); return late.promise; });
    const controller = new AbortController();
    const payloads: StreamEventPayload[] = [];
    const running = handlerFor(structured, search, [], clock.now)({ input: request(), signal: controller.signal, emit: async payload => { payloads.push(payload); } });
    // 预先观察拒绝，避免测试自身延后 await 形成未处理拒绝。
    const observed = running.then(() => null, (reason: unknown) => reason);
    await entered.promise;
    if (mode === "deadline") {
      clock.advanceBy(40_000);
      vi.advanceTimersByTime(40_000);
      expect(await observed).toBeNull();
      const failure = payloads.find(payload => payload.type === "node.failed");
      expect(failure?.type === "node.failed" ? failure.error.code : null).toBe("RUN_DEADLINE_EXCEEDED");
    } else {
      const reason = new DOMException("用户弃用重搜", "AbortError");
      controller.abort(reason);
      expect(await observed).toBe(reason);
      expect(payloads.some(payload => payload.type === "complete" || payload.type === "run.failed")).toBe(false);
    }
    const beforeLate = structuredClone(payloads);
    late.resolve(hits(1));
    await Promise.resolve();
    await Promise.resolve();
    expect(payloads).toEqual(beforeLate);
    expect(payloads.some(payload => payload.type === "node.ready" || payload.type === "node.partial")).toBe(false);
    expect(search.mock.calls[0]?.[1].aborted).toBe(true);
  });
});
