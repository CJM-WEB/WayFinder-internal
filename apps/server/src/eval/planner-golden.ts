/**
 * 模块职责：执行 WAY-43 单条 Planner Golden Query（黄金查询）的受控规划流程，
 * 生成可机器比较的确定性指标，并保留人工语义审核所需的完整 GraphPlan。
 *
 * 关键边界：
 * - 每条 Query 独占一个最多 20 秒的绝对 Run deadline，所有外部调用共享同一 Signal；
 * - 只在模型实际选择 evidence_assisted 时执行一次 Broad Discovery 与一次 Reviser；
 * - 预期普通失败可以回退 Initial Plan，但必须显式记录且建议 targetedIterate；
 * - Evidence、URL、网页正文和原始错误永不进入报告，语义质量不由代码擅自判分。
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { GraphPlanSchema } from "@wayfinder/contracts";
import type { CandidateSearchHit, GraphPlan } from "@wayfinder/contracts";

import { GraphRevisionError, reviseGraphPlan } from "../ai/graph-reviser.js";
import {
  planOrCompactFallback,
  type GraphPlannerOutcome,
} from "../ai/graph-planner.js";
import type { GraphPlanValidationDiagnostic } from "../ai/graph-plan-parser.js";
import {
  MAX_LLM_CALL_TIMEOUT_MS,
  type LLMProvider,
} from "../ai/llm-provider.js";
import { RUN_DEADLINE_MS } from "../config.js";
import { validateGraphPlan } from "../graph/graph-validator.js";
import {
  BroadDiscoveryError,
  discoverBroadEvidence,
} from "../search/broad-discovery.js";
import type { SearchProvider } from "../search/provider.js";

export const PLANNER_GOLDEN_RUN_DEADLINE_MS = RUN_DEADLINE_MS;

export type PlannerGoldenQuery = Readonly<{
  id: string;
  query: string;
  category: string;
  rationale: string;
}>;

export type PlannerGoldenTokenUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}>;

type PlannerGoldenFallback =
  | Readonly<{
      stage: "planner";
      reason: Extract<GraphPlannerOutcome, { kind: "compact_fallback" }>["reason"];
    }>
  | Readonly<{ stage: "broad_discovery"; reason: "no_evidence" }>
  | Readonly<{
      stage: "graph_reviser";
      reason: GraphRevisionError["kind"];
    }>;

type PlannerGoldenTokenUsageSummary =
  | Readonly<{
      status: "available";
      callCount: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "missing_or_invalid_provider_usage";
    }>;

export type PlannerGoldenAutomaticMetrics = Readonly<{
  schemaValid: true;
  validatorValid: true;
  dagValid: true;
  nodeCount: number;
  edgeCount: number;
  nodeTypeCounts: Readonly<{
    primary: number;
    related: number;
    disambiguation: number;
  }>;
  edgeCoverage: number;
  literalDuplicateNodeIdGroups: readonly (readonly string[])[];
  searchPlans: readonly Readonly<{
    nodeId: string;
    queryCount: number;
    maxResults: number;
    rankingProfile: GraphPlan["nodes"][number]["searchPlan"]["rankingProfile"];
    providerHints: readonly string[];
  }>[];
}>;

export type PlannerGoldenCompletedResult = Readonly<{
  query: PlannerGoldenQuery;
  executionStatus: "completed";
  /** Planner 自身回退时没有可归因于模型的 Strategy / Presentation Mode。 */
  strategy: GraphPlan["analysis"]["strategy"] | null;
  presentationMode: GraphPlan["analysis"]["presentationMode"] | null;
  /** 两份 Plan 均为报告安全投影；Hash 用于核对未投影原值是否变化。 */
  initialPlan: GraphPlan;
  finalPlan: GraphPlan;
  planFingerprints: Readonly<{
    initialSha256: string;
    finalSha256: string;
  }>;
  reportSanitization: Readonly<{
    evidenceRedactionCount: number;
    urlRedactionCount: number;
    truncatedFieldCount: number;
  }>;
  fallback: PlannerGoldenFallback | null;
  suggestedOutcome: "targetedIterate" | null;
  validationDiagnostics: readonly GraphPlanValidationDiagnostic[];
  metrics: PlannerGoldenAutomaticMetrics;
  calls: Readonly<{
    llm: number;
    search: number;
    searchHttpAttempts: number | "unavailable";
    extract: 0;
  }>;
  timingsMs: Readonly<{
    planner: number;
    broadDiscovery: number | null;
    graphReviser: number | null;
    total: number;
  }>;
  tokenUsage: PlannerGoldenTokenUsageSummary;
  estimatedCost: Readonly<{
    status: "unavailable";
    reason: "pricing_not_frozen";
  }>;
  resourceMetrics: Readonly<{
    status: "notApplicable";
    reason: "planner_only_baseline";
  }>;
}>;

export type PlannerGoldenInterruptedResult = Readonly<{
  query: PlannerGoldenQuery;
  executionStatus: "cancelled" | "deadline_exceeded";
  suggestedOutcome: null;
  calls: Readonly<{
    llm: number;
    search: number;
    searchHttpAttempts: number | "unavailable";
    extract: 0;
  }>;
  totalTimingMs: number;
  tokenUsage: PlannerGoldenTokenUsageSummary;
  estimatedCost: Readonly<{
    status: "unavailable";
    reason: "pricing_not_frozen";
  }>;
}>;

export type PlannerGoldenQueryResult =
  | PlannerGoldenCompletedResult
  | PlannerGoldenInterruptedResult;

export type EvaluatePlannerGoldenQueryInput = Readonly<{
  query: PlannerGoldenQuery;
  llmProvider: LLMProvider;
  searchProvider: SearchProvider;
  /** Provider 每次完成调用后只追加脱敏聚合 Token；条数不足即整体标记不可用。 */
  readTokenUsages?: () => readonly PlannerGoldenTokenUsage[];
  /** Tavily Adapter 的脱敏尝试观察器提供实际 HTTP 次数；其他 Provider 可标记不可用。 */
  readSearchHttpAttemptCount?: () => number;
  /** 可选父 Signal 用于受控取消；绝对 deadline 仍由本函数单独创建。 */
  signal?: AbortSignal;
  /** 仅允许测试缩短；生产入口固定不传并使用 20 秒。 */
  runDeadlineMs?: number;
  /** Initial Planner 与 Reviser 共用的单阶段 LLM 上限；生产传入已校验配置。 */
  llmStageTimeoutMs?: number;
}>;

type CallCounters = {
  llm: number;
  search: number;
};

function assertRunDeadline(runDeadlineMs: number): void {
  if (
    !Number.isInteger(runDeadlineMs) ||
    runDeadlineMs < 1 ||
    runDeadlineMs > PLANNER_GOLDEN_RUN_DEADLINE_MS
  ) {
    throw new RangeError(
      `Golden Run deadline 必须是 1 到 ${PLANNER_GOLDEN_RUN_DEADLINE_MS} 的整数`,
    );
  }
}

function assertLLMStageTimeout(timeoutMs: number): void {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_LLM_CALL_TIMEOUT_MS
  ) {
    throw new RangeError(
      `Golden LLM 阶段 timeout 必须是 1 到 ${MAX_LLM_CALL_TIMEOUT_MS} 的整数`,
    );
  }
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

/** 包装端口只计逻辑调用；不读取输入、输出或 Provider 私有错误。 */
function measureLLMProvider(
  provider: LLMProvider,
  counters: CallCounters,
): LLMProvider {
  return {
    id: provider.id,
    structured: async (structuredInput, options) => {
      counters.llm += 1;
      return provider.structured(structuredInput, options);
    },
  };
}

/** Search 计数按业务调用记录；Provider 内部有界 HTTP Retry 不冒充新的逻辑 Search。 */
function measureSearchProvider(
  provider: SearchProvider,
  counters: CallCounters,
): SearchProvider {
  return {
    id: provider.id,
    capabilities: [...provider.capabilities],
    search: async (request, signal) => {
      counters.search += 1;
      return provider.search(request, signal);
    },
  };
}

function summarizeTokenUsage(
  usages: readonly PlannerGoldenTokenUsage[] | undefined,
  llmCalls: number,
): PlannerGoldenTokenUsageSummary {
  if (usages === undefined || usages.length !== llmCalls) {
    return {
      status: "unavailable",
      reason: "missing_or_invalid_provider_usage",
    };
  }

  return usages.reduce<Extract<PlannerGoldenTokenUsageSummary, { status: "available" }>>(
    (summary, usage) => ({
      status: "available",
      callCount: summary.callCount + 1,
      inputTokens: summary.inputTokens + usage.inputTokens,
      outputTokens: summary.outputTokens + usage.outputTokens,
      totalTokens: summary.totalTokens + usage.totalTokens,
    }),
    {
      status: "available",
      callCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  );
}

function readRemainingLLMTimeoutMs(
  deadlineAt: number,
  llmStageTimeoutMs: number,
): number {
  const remaining = Math.min(
    llmStageTimeoutMs,
    Math.ceil(deadlineAt - performance.now()),
  );
  if (remaining < 1) {
    throw new DOMException("Golden Run 已超过绝对截止时间", "TimeoutError");
  }
  return remaining;
}

type ReportSanitization = {
  evidenceRedactionCount: number;
  urlRedactionCount: number;
  truncatedFieldCount: number;
};

const REPORT_URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;

/**
 * 报告保留人工评审所需语义，但删除已知 Evidence 原文、URL、控制字符并限制长度。
 * Markdown 主动内容在渲染层另行全部实体化，JSON 中这里只保存惰性纯数据。
 */
function sanitizeReportText(
  value: string,
  maximumCodePoints: number,
  evidenceValues: readonly string[],
  summary: ReportSanitization,
): string {
  let sanitized = value;
  for (const evidenceValue of evidenceValues) {
    if (evidenceValue.length === 0 || !sanitized.includes(evidenceValue)) {
      continue;
    }
    const occurrences = sanitized.split(evidenceValue).length - 1;
    summary.evidenceRedactionCount += occurrences;
    sanitized = sanitized.replaceAll(evidenceValue, "[EVIDENCE_REDACTED]");
  }

  sanitized = sanitized.replace(REPORT_URL_PATTERN, () => {
    summary.urlRedactionCount += 1;
    return "[URL_REDACTED]";
  });
  sanitized = [...sanitized]
    .map(codePoint => {
      const value = codePoint.codePointAt(0) ?? 0;
      const allowedWhitespace = value === 9 || value === 10 || value === 13;
      return (!allowedWhitespace && value <= 31) || value === 127
        ? " "
        : codePoint;
    })
    .join("")
    .trim();
  if (sanitized.length === 0) {
    sanitized = "[REDACTED]";
  }

  const codePoints = [...sanitized];
  if (codePoints.length > maximumCodePoints) {
    summary.truncatedFieldCount += 1;
    return `${codePoints.slice(0, maximumCodePoints).join("")}…`;
  }
  return sanitized;
}

function uniqueSanitizedId(
  value: string,
  index: number,
  used: Set<string>,
  evidenceValues: readonly string[],
  summary: ReportSanitization,
): string {
  const base = sanitizeReportText(value, 128, evidenceValues, summary);
  let candidate = base;
  let suffix = index + 1;
  while (used.has(candidate)) {
    candidate = `${base.slice(0, 112)}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function sanitizeGraphPlanForReport(
  plan: GraphPlan,
  evidenceValues: readonly string[],
): Readonly<{ plan: GraphPlan; summary: ReportSanitization }> {
  const summary: ReportSanitization = {
    evidenceRedactionCount: 0,
    urlRedactionCount: 0,
    truncatedFieldCount: 0,
  };
  const usedNodeIds = new Set<string>();
  const nodeIdMap = new Map<string, string>();
  const nodes = plan.nodes.map((node, index) => {
    const id = uniqueSanitizedId(
      node.id,
      index,
      usedNodeIds,
      evidenceValues,
      summary,
    );
    nodeIdMap.set(node.id, id);
    return {
      ...node,
      id,
      title: sanitizeReportText(node.title, 200, evidenceValues, summary),
      description: sanitizeReportText(
        node.description,
        500,
        evidenceValues,
        summary,
      ),
      searchPlan: {
        ...node.searchPlan,
        queries: node.searchPlan.queries.map(query =>
          sanitizeReportText(query, 200, evidenceValues, summary),
        ),
        providerHints: [...node.searchPlan.providerHints],
      },
    };
  });
  const usedEdgeIds = new Set<string>();
  const edges = plan.edges.map((edge, index) => ({
    ...edge,
    id: uniqueSanitizedId(
      edge.id,
      index,
      usedEdgeIds,
      evidenceValues,
      summary,
    ),
    source: nodeIdMap.get(edge.source) ?? "[REDACTED_SOURCE]",
    target: nodeIdMap.get(edge.target) ?? "[REDACTED_TARGET]",
  }));
  const projected = GraphPlanSchema.parse({
    analysis: {
      ...plan.analysis,
      topic: sanitizeReportText(
        plan.analysis.topic,
        200,
        evidenceValues,
        summary,
      ),
      broadSearchQueries: plan.analysis.broadSearchQueries.map(query =>
        sanitizeReportText(query, 200, evidenceValues, summary),
      ),
    },
    nodes,
    edges,
  });
  if (!validateGraphPlan(projected).valid) {
    throw new Error("Golden Eval 报告安全投影未通过确定性 Validator");
  }
  return { plan: projected, summary };
}

function fingerprintGraphPlan(plan: GraphPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

function collectEvidenceValues(
  evidence: readonly CandidateSearchHit[],
): readonly string[] {
  return [
    ...new Set(
      evidence.flatMap(hit => [
        hit.title,
        hit.url,
        hit.canonicalUrl,
        hit.domain,
        hit.snippet,
        ...(hit.publishedAt === undefined || hit.publishedAt === null
          ? []
          : [hit.publishedAt]),
      ]),
    ),
  ].sort((left, right) => right.length - left.length);
}

function normalizedTitle(title: string): string {
  return title.normalize("NFKC").trim().replaceAll(/\s+/g, " ").toLowerCase();
}

/** 字面重复只作为确定性线索；语义重复仍由人工审核，绝不由标题规则替代。 */
function findLiteralDuplicateNodeIdGroups(
  plan: GraphPlan,
): readonly (readonly string[])[] {
  const nodeIdsByTitle = new Map<string, string[]>();
  for (const node of plan.nodes) {
    const title = normalizedTitle(node.title);
    const nodeIds = nodeIdsByTitle.get(title) ?? [];
    nodeIds.push(node.id);
    nodeIdsByTitle.set(title, nodeIds);
  }
  return [...nodeIdsByTitle.values()].filter(nodeIds => nodeIds.length > 1);
}

function calculateAutomaticMetrics(
  plan: GraphPlan,
  reportPlan: GraphPlan,
): PlannerGoldenAutomaticMetrics {
  const parsed = GraphPlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new Error("Golden Eval 内部 GraphPlan 未通过公共 Schema");
  }
  const parsedReportPlan = GraphPlanSchema.safeParse(reportPlan);
  if (
    !parsedReportPlan.success ||
    parsedReportPlan.data.nodes.length !== parsed.data.nodes.length
  ) {
    throw new Error("Golden Eval 报告 Plan 与原始 Plan 不一致");
  }

  const validation = validateGraphPlan(parsed.data);
  if (!validation.valid) {
    throw new Error("Golden Eval 内部 GraphPlan 未通过确定性 Validator");
  }

  const participatingNodeIds = new Set<string>();
  for (const edge of parsed.data.edges) {
    participatingNodeIds.add(edge.source);
    participatingNodeIds.add(edge.target);
  }

  return {
    schemaValid: true,
    validatorValid: true,
    // Validator 已确定 recommended_next 无环；显式字段供报告直接核对七点门禁。
    dagValid: true,
    nodeCount: parsed.data.nodes.length,
    edgeCount: parsed.data.edges.length,
    nodeTypeCounts: {
      primary: parsed.data.nodes.filter(node => node.nodeType === "primary").length,
      related: parsed.data.nodes.filter(node => node.nodeType === "related").length,
      disambiguation: parsed.data.nodes.filter(
        node => node.nodeType === "disambiguation",
      ).length,
    },
    edgeCoverage:
      Math.round(
        (participatingNodeIds.size / parsed.data.nodes.length) * 10_000,
      ) / 10_000,
    // 重复判断必须使用原始标题；输出 ID 则复用报告投影，避免原始 ID 泄漏或错配。
    literalDuplicateNodeIdGroups: findLiteralDuplicateNodeIdGroups(
      parsed.data,
    ).map(nodeIds =>
      nodeIds.map(nodeId => {
        const nodeIndex = parsed.data.nodes.findIndex(node => node.id === nodeId);
        const reportNode = parsedReportPlan.data.nodes[nodeIndex];
        if (reportNode === undefined) {
          throw new Error("Golden Eval 指标无法映射报告 Node ID");
        }
        return reportNode.id;
      }),
    ),
    searchPlans: parsed.data.nodes.map((node, index) => ({
      nodeId: parsedReportPlan.data.nodes[index]?.id ?? "[REDACTED_NODE]",
      queryCount: node.searchPlan.queries.length,
      maxResults: node.searchPlan.maxResults,
      rankingProfile: node.searchPlan.rankingProfile,
      providerHints: [...node.searchPlan.providerHints],
    })),
  };
}

function isAbortLike(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/**
 * 执行一条 Query。正常结果只表示 Engineering Correct（工程正确）；没有回退时也必须
 * 等待人工填写语义评分，不能由自动指标宣称 Product Good（产品质量良好）。
 */
export async function evaluatePlannerGoldenQuery(
  input: EvaluatePlannerGoldenQueryInput,
): Promise<PlannerGoldenQueryResult> {
  const runDeadlineMs = input.runDeadlineMs ?? PLANNER_GOLDEN_RUN_DEADLINE_MS;
  const llmStageTimeoutMs =
    input.llmStageTimeoutMs ?? MAX_LLM_CALL_TIMEOUT_MS;
  assertRunDeadline(runDeadlineMs);
  assertLLMStageTimeout(llmStageTimeoutMs);

  const startedAt = performance.now();
  const deadlineAt = startedAt + runDeadlineMs;
  const deadlineSignal = AbortSignal.timeout(runDeadlineMs);
  const signal =
    input.signal === undefined
      ? deadlineSignal
      : AbortSignal.any([input.signal, deadlineSignal]);
  const counters: CallCounters = { llm: 0, search: 0 };
  const llmProvider = measureLLMProvider(input.llmProvider, counters);
  const searchProvider = measureSearchProvider(input.searchProvider, counters);
  const validationDiagnostics: GraphPlanValidationDiagnostic[] = [];
  let evidenceValues: readonly string[] = [];
  let plannerOutcome: GraphPlannerOutcome | undefined;

  try {
    const plannerStartedAt = performance.now();
    const initialPlan = await planOrCompactFallback({
      query: input.query.query,
      provider: llmProvider,
      signal,
      timeoutMs: readRemainingLLMTimeoutMs(deadlineAt, llmStageTimeoutMs),
      onValidationDiagnostic: diagnostic => {
        validationDiagnostics.push(diagnostic);
      },
      onOutcome: outcome => {
        plannerOutcome = outcome;
      },
    });
    const plannerTimingMs = elapsedSince(plannerStartedAt);
    if (plannerOutcome === undefined) {
      throw new Error("Golden Eval 未收到 Planner 结果观察");
    }

    let finalPlan = initialPlan;
    let broadDiscoveryTimingMs: number | null = null;
    let graphReviserTimingMs: number | null = null;
    let fallback: PlannerGoldenFallback | null =
      plannerOutcome.kind === "compact_fallback"
        ? {
            stage: "planner",
            reason: plannerOutcome.reason,
          }
        : null;

    if (
      plannerOutcome.kind === "success" &&
      initialPlan.analysis.strategy === "evidence_assisted"
    ) {
      const discoveryStartedAt = performance.now();
      try {
        const evidence = await discoverBroadEvidence({
          analysis: initialPlan.analysis,
          provider: searchProvider,
          signal,
        });
        evidenceValues = collectEvidenceValues(evidence);
        broadDiscoveryTimingMs = elapsedSince(discoveryStartedAt);

        const reviserStartedAt = performance.now();
        try {
          finalPlan = await reviseGraphPlan({
            query: input.query.query,
            initialPlan,
            evidence,
            provider: llmProvider,
            signal,
            timeoutMs: readRemainingLLMTimeoutMs(
              deadlineAt,
              llmStageTimeoutMs,
            ),
            onValidationDiagnostic: ({ diagnostic }) => {
              validationDiagnostics.push(diagnostic);
            },
          });
          graphReviserTimingMs = elapsedSince(reviserStartedAt);
        } catch (error: unknown) {
          graphReviserTimingMs = elapsedSince(reviserStartedAt);
          if (error instanceof GraphRevisionError) {
            fallback = { stage: "graph_reviser", reason: error.kind };
          } else {
            throw error;
          }
        }
      } catch (error: unknown) {
        broadDiscoveryTimingMs = elapsedSince(discoveryStartedAt);
        if (error instanceof BroadDiscoveryError) {
          fallback = { stage: "broad_discovery", reason: "no_evidence" };
        } else {
          throw error;
        }
      }
    }

    signal.throwIfAborted();
    const initialReportPlan = sanitizeGraphPlanForReport(initialPlan, []);
    const finalReportPlan = sanitizeGraphPlanForReport(
      finalPlan,
      evidenceValues,
    );
    const plannerUsedFallback = fallback?.stage === "planner";
    return {
      query: input.query,
      executionStatus: "completed",
      strategy: plannerUsedFallback ? null : finalPlan.analysis.strategy,
      presentationMode: plannerUsedFallback
        ? null
        : finalPlan.analysis.presentationMode,
      initialPlan: initialReportPlan.plan,
      finalPlan: finalReportPlan.plan,
      planFingerprints: {
        initialSha256: fingerprintGraphPlan(initialPlan),
        finalSha256: fingerprintGraphPlan(finalPlan),
      },
      reportSanitization: {
        evidenceRedactionCount:
          initialReportPlan.summary.evidenceRedactionCount +
          finalReportPlan.summary.evidenceRedactionCount,
        urlRedactionCount:
          initialReportPlan.summary.urlRedactionCount +
          finalReportPlan.summary.urlRedactionCount,
        truncatedFieldCount:
          initialReportPlan.summary.truncatedFieldCount +
          finalReportPlan.summary.truncatedFieldCount,
      },
      fallback,
      suggestedOutcome: fallback === null ? null : "targetedIterate",
      validationDiagnostics,
      metrics: calculateAutomaticMetrics(finalPlan, finalReportPlan.plan),
      calls: {
        llm: counters.llm,
        search: counters.search,
        searchHttpAttempts:
          input.readSearchHttpAttemptCount?.() ?? "unavailable",
        extract: 0,
      },
      timingsMs: {
        planner: plannerTimingMs,
        broadDiscovery: broadDiscoveryTimingMs,
        graphReviser: graphReviserTimingMs,
        total: elapsedSince(startedAt),
      },
      tokenUsage: summarizeTokenUsage(input.readTokenUsages?.(), counters.llm),
      estimatedCost: {
        status: "unavailable",
        reason: "pricing_not_frozen",
      },
      resourceMetrics: {
        status: "notApplicable",
        reason: "planner_only_baseline",
      },
    };
  } catch (error: unknown) {
    const interrupted = signal.aborted || isAbortLike(error);
    if (!interrupted) {
      throw error;
    }

    const deadlineExceeded = deadlineSignal.aborted ||
      (error instanceof Error && error.name === "TimeoutError");
    return {
      query: input.query,
      executionStatus: deadlineExceeded ? "deadline_exceeded" : "cancelled",
      suggestedOutcome: null,
      calls: {
        llm: counters.llm,
        search: counters.search,
        searchHttpAttempts:
          input.readSearchHttpAttemptCount?.() ?? "unavailable",
        extract: 0,
      },
      totalTimingMs: elapsedSince(startedAt),
      tokenUsage: summarizeTokenUsage(input.readTokenUsages?.(), counters.llm),
      estimatedCost: {
        status: "unavailable",
        reason: "pricing_not_frozen",
      },
    };
  }
}
