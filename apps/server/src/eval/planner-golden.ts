/**
 * 模块职责：执行 WAY-43 单条 Planner Golden Query（黄金查询）的受控规划流程，
 * 生成可机器比较的确定性指标，并保留人工语义审核所需的完整 GraphPlan。
 *
 * 关键边界：
 * - 每条 Query 独占一个最多 40 秒的绝对 Run deadline，所有外部调用共享同一 Signal；
 * - 严格执行 Graph Outline 与全图 SearchPlan 两阶段，可选 Broad/Reviser 只属于第一阶段；
 * - 任一阶段失败都记为失败样本，不保留旧 Plan、不 repair、不生成 fallback；
 * - Evidence、URL、网页正文和原始错误永不进入报告，语义质量不由代码擅自判分。
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { GraphPlanSchema } from "@wayfinder/contracts";
import type { CandidateSearchHit, GraphPlan } from "@wayfinder/contracts";

import {
  GraphOutlineSchema,
  type GraphOutline,
  type GraphOutlineValidationDiagnostic,
} from "../ai/graph-outline.js";
import {
  GraphPlannerError,
  planGraphOutline,
} from "../ai/graph-planner.js";
import {
  GraphRevisionError,
  reviseGraphOutline,
  type GraphRevisionValidationDiagnostic,
} from "../ai/graph-reviser.js";
import {
  SearchPlanGenerationError,
  assembleGraphPlan,
  generateSearchPlanBundle,
  type SearchPlanBundle,
  type SearchPlanBundleValidationDiagnostic,
} from "../ai/search-plan-generator.js";
import {
  MAX_LLM_CALL_TIMEOUT_MS,
  type LLMProvider,
} from "../ai/llm-provider.js";
import { RUN_DEADLINE_MS } from "../config.js";
import {
  validateGraphOutline,
  validateGraphPlan,
} from "../graph/graph-validator.js";
import {
  BroadDiscoveryError,
  discoverBroadEvidence,
} from "../search/broad-discovery.js";
import type { SearchProvider } from "../search/provider.js";
import {
  QUALITY_EVAL_PLANNED_REQUEST_CONFIG,
  measureQualityEvalPlannedRequestDuplication,
  type QualityEvalPlannedRequestDuplication,
} from "./quality-metrics.js";

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

type PlannerGoldenFailure = Readonly<{
  stage:
    | "graph_planner"
    | "broad_discovery"
    | "graph_reviser"
    | "search_plan_generator"
    | "graph_assembly";
  reason: string;
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
  plannedRequestDuplication: QualityEvalPlannedRequestDuplication;
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
  strategy: GraphPlan["analysis"]["strategy"];
  presentationMode: GraphPlan["analysis"]["presentationMode"];
  /** Outline、Bundle 与 Plan 均为报告安全投影；Hash 用于核对原值。 */
  initialOutline: GraphOutline;
  finalOutline: GraphOutline;
  searchPlanBundle: SearchPlanBundle;
  finalPlan: GraphPlan;
  planFingerprints: Readonly<{
    initialOutlineSha256: string;
    finalOutlineSha256: string;
    searchPlanBundleSha256: string;
    finalSha256: string;
  }>;
  reportSanitization: Readonly<{
    evidenceRedactionCount: number;
    urlRedactionCount: number;
    truncatedFieldCount: number;
  }>;
  suggestedOutcome: null;
  validationDiagnostics: Readonly<{
    planner: readonly GraphOutlineValidationDiagnostic[];
    reviser: readonly GraphRevisionValidationDiagnostic[];
    searchPlanGenerator: readonly SearchPlanBundleValidationDiagnostic[];
  }>;
  metrics: PlannerGoldenAutomaticMetrics;
  calls: Readonly<{
    llm: number;
    search: number;
    searchHttpAttempts: number | "unavailable";
    extract: 0;
  }>;
  callsByStage: Readonly<{
    graphOutlinePlanning: Readonly<{ llm: number; search: number }>;
    searchPlanPlanning: Readonly<{ llm: number; search: 0 }>;
  }>;
  timingsMs: Readonly<{
    graphOutlinePlanning: number;
    searchPlanPlanning: number;
    planner: number;
    broadDiscovery: number | null;
    graphReviser: number | null;
    total: number;
  }>;
  tokenUsage: PlannerGoldenTokenUsageSummary;
  tokenUsageByStage: Readonly<{
    graphOutlinePlanning: PlannerGoldenTokenUsageSummary;
    searchPlanPlanning: PlannerGoldenTokenUsageSummary;
  }>;
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
  callsByStage: PlannerGoldenCompletedResult["callsByStage"];
  timingsMs: Readonly<{
    graphOutlinePlanning: number | null;
    searchPlanPlanning: number | null;
    total: number;
  }>;
  tokenUsage: PlannerGoldenTokenUsageSummary;
  tokenUsageByStage: PlannerGoldenCompletedResult["tokenUsageByStage"];
  estimatedCost: Readonly<{
    status: "unavailable";
    reason: "pricing_not_frozen";
  }>;
}>;

export type PlannerGoldenFailedResult = Readonly<{
  query: PlannerGoldenQuery;
  executionStatus: "failed";
  failure: PlannerGoldenFailure;
  suggestedOutcome: "targetedIterate";
  calls: PlannerGoldenInterruptedResult["calls"];
  callsByStage: PlannerGoldenInterruptedResult["callsByStage"];
  timingsMs: PlannerGoldenInterruptedResult["timingsMs"];
  tokenUsage: PlannerGoldenTokenUsageSummary;
  tokenUsageByStage: PlannerGoldenInterruptedResult["tokenUsageByStage"];
  estimatedCost: PlannerGoldenInterruptedResult["estimatedCost"];
}>;

export type PlannerGoldenQueryResult =
  | PlannerGoldenCompletedResult
  | PlannerGoldenFailedResult
  | PlannerGoldenInterruptedResult;

export type EvaluatePlannerGoldenQueryInput = Readonly<{
  query: PlannerGoldenQuery;
  llmProvider: LLMProvider;
  searchProvider: SearchProvider;
  /** Provider 每次完成调用后只追加脱敏聚合 Token；条数不足即整体标记不可用。 */
  readTokenUsages?: () => readonly PlannerGoldenTokenUsage[];
  /** Adapter 的脱敏尝试观察器提供实际 Search HTTP 次数；缺失时标记不可用。 */
  readSearchHttpAttemptCount?: () => number;
  /** 可选父 Signal 用于受控取消；绝对 deadline 仍由本函数单独创建。 */
  signal?: AbortSignal;
  /** 仅允许测试缩短；生产入口固定不传并使用 40 秒。 */
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

function sanitizeGraphOutlineForReport(
  outline: GraphOutline,
  evidenceValues: readonly string[],
): Readonly<{
  outline: GraphOutline;
  nodeIdMap: ReadonlyMap<string, string>;
  summary: ReportSanitization;
}> {
  const summary: ReportSanitization = {
    evidenceRedactionCount: 0,
    urlRedactionCount: 0,
    truncatedFieldCount: 0,
  };
  const usedNodeIds = new Set<string>();
  const nodeIdMap = new Map<string, string>();
  const nodes = outline.nodes.map((node, index) => {
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
    };
  });
  const usedEdgeIds = new Set<string>();
  const edges = outline.edges.map((edge, index) => ({
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
  const projected = GraphOutlineSchema.parse({
    analysis: {
      ...outline.analysis,
      topic: sanitizeReportText(
        outline.analysis.topic,
        200,
        evidenceValues,
        summary,
      ),
      broadSearchQueries: outline.analysis.broadSearchQueries.map(query =>
        sanitizeReportText(query, 200, evidenceValues, summary),
      ),
    },
    nodes,
    edges,
  });
  if (!validateGraphOutline(projected).valid) {
    throw new Error("Golden Eval Outline 报告投影未通过确定性 Validator");
  }
  return { outline: projected, nodeIdMap, summary };
}

function sanitizeSearchPlanBundleForReport(
  bundle: SearchPlanBundle,
  nodeIdMap: ReadonlyMap<string, string>,
  evidenceValues: readonly string[],
): Readonly<{ bundle: SearchPlanBundle; summary: ReportSanitization }> {
  const summary: ReportSanitization = {
    evidenceRedactionCount: 0,
    urlRedactionCount: 0,
    truncatedFieldCount: 0,
  };
  return {
    bundle: {
      plans: bundle.plans.map(plan => ({
        ...plan,
        nodeId: nodeIdMap.get(plan.nodeId) ?? "[REDACTED_NODE]",
        queries: plan.queries.map(query =>
          sanitizeReportText(query, 200, evidenceValues, summary),
        ),
      })),
    },
    summary,
  };
}

function fingerprintValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
    plannedRequestDuplication: measureQualityEvalPlannedRequestDuplication(
      parsed.data,
      QUALITY_EVAL_PLANNED_REQUEST_CONFIG,
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
  const plannerDiagnostics: GraphOutlineValidationDiagnostic[] = [];
  const reviserDiagnostics: GraphRevisionValidationDiagnostic[] = [];
  const searchPlanDiagnostics: SearchPlanBundleValidationDiagnostic[] = [];
  let evidenceValues: readonly string[] = [];
  let activeStage: PlannerGoldenFailure["stage"] = "graph_planner";
  let graphOutlineLlmCalls: number | null = null;
  let graphOutlineSearchCalls: number | null = null;
  let graphOutlinePlanningStartedAt: number | null = null;
  let graphOutlinePlanningTimingMs: number | null = null;
  let searchPlanPlanningStartedAt: number | null = null;

  try {
    signal.throwIfAborted();
    graphOutlinePlanningStartedAt = performance.now();
    const plannerStartedAt = performance.now();
    const initialOutline = await planGraphOutline({
      query: input.query.query,
      provider: llmProvider,
      signal,
      timeoutMs: readRemainingLLMTimeoutMs(deadlineAt, llmStageTimeoutMs),
      onValidationDiagnostic: diagnostic => {
        plannerDiagnostics.push(diagnostic);
      },
    });
    const plannerTimingMs = elapsedSince(plannerStartedAt);
    if (!validateGraphOutline(initialOutline).valid) {
      throw new GraphPlannerError("semantic_validation_failed");
    }

    let finalOutline = initialOutline;
    let broadDiscoveryTimingMs: number | null = null;
    let graphReviserTimingMs: number | null = null;

    if (initialOutline.analysis.strategy === "evidence_assisted") {
      activeStage = "broad_discovery";
      const discoveryStartedAt = performance.now();
      const evidence = await discoverBroadEvidence({
        analysis: initialOutline.analysis,
        provider: searchProvider,
        signal,
        language: "zh-CN",
      });
      evidenceValues = collectEvidenceValues(evidence);
      broadDiscoveryTimingMs = elapsedSince(discoveryStartedAt);

      activeStage = "graph_reviser";
      const reviserStartedAt = performance.now();
      finalOutline = await reviseGraphOutline({
        query: input.query.query,
        initialOutline,
        evidence,
        provider: llmProvider,
        signal,
        timeoutMs: readRemainingLLMTimeoutMs(
          deadlineAt,
          llmStageTimeoutMs,
        ),
        onValidationDiagnostic: diagnostic => {
          reviserDiagnostics.push(diagnostic);
        },
      });
      graphReviserTimingMs = elapsedSince(reviserStartedAt);
      if (!validateGraphOutline(finalOutline).valid) {
        throw new GraphRevisionError("semantic_validation_failed");
      }
    }

    const completedGraphOutlinePlanningTimingMs = elapsedSince(
      graphOutlinePlanningStartedAt,
    );
    graphOutlinePlanningTimingMs = completedGraphOutlinePlanningTimingMs;
    graphOutlineLlmCalls = counters.llm;
    graphOutlineSearchCalls = counters.search;

    activeStage = "search_plan_generator";
    searchPlanPlanningStartedAt = performance.now();
    const searchPlanBundle = await generateSearchPlanBundle({
      query: input.query.query,
      language: "zh-CN",
      outline: finalOutline,
      provider: llmProvider,
      signal,
      timeoutMs: readRemainingLLMTimeoutMs(deadlineAt, llmStageTimeoutMs),
      onValidationDiagnostic: diagnostic => {
        searchPlanDiagnostics.push(diagnostic);
      },
    });

    activeStage = "graph_assembly";
    const finalPlan = assembleGraphPlan(finalOutline, searchPlanBundle);
    signal.throwIfAborted();
    const searchPlanPlanningTimingMs = elapsedSince(
      searchPlanPlanningStartedAt,
    );
    const initialReportOutline = sanitizeGraphOutlineForReport(
      initialOutline,
      [],
    );
    const finalReportOutline = sanitizeGraphOutlineForReport(
      finalOutline,
      evidenceValues,
    );
    const reportBundle = sanitizeSearchPlanBundleForReport(
      searchPlanBundle,
      finalReportOutline.nodeIdMap,
      evidenceValues,
    );
    const finalReportPlan = sanitizeGraphPlanForReport(
      finalPlan,
      evidenceValues,
    );
    const tokenUsages = input.readTokenUsages?.();
    const tokenUsage = summarizeTokenUsage(tokenUsages, counters.llm);
    const stageUsages = tokenUsage.status === "available"
      ? tokenUsages
      : undefined;
    return {
      query: input.query,
      executionStatus: "completed",
      strategy: finalPlan.analysis.strategy,
      presentationMode: finalPlan.analysis.presentationMode,
      initialOutline: initialReportOutline.outline,
      finalOutline: finalReportOutline.outline,
      searchPlanBundle: reportBundle.bundle,
      finalPlan: finalReportPlan.plan,
      planFingerprints: {
        initialOutlineSha256: fingerprintValue(initialOutline),
        finalOutlineSha256: fingerprintValue(finalOutline),
        searchPlanBundleSha256: fingerprintValue(searchPlanBundle),
        finalSha256: fingerprintValue(finalPlan),
      },
      reportSanitization: {
        evidenceRedactionCount:
          initialReportOutline.summary.evidenceRedactionCount +
          finalReportOutline.summary.evidenceRedactionCount +
          reportBundle.summary.evidenceRedactionCount +
          finalReportPlan.summary.evidenceRedactionCount,
        urlRedactionCount:
          initialReportOutline.summary.urlRedactionCount +
          finalReportOutline.summary.urlRedactionCount +
          reportBundle.summary.urlRedactionCount +
          finalReportPlan.summary.urlRedactionCount,
        truncatedFieldCount:
          initialReportOutline.summary.truncatedFieldCount +
          finalReportOutline.summary.truncatedFieldCount +
          reportBundle.summary.truncatedFieldCount +
          finalReportPlan.summary.truncatedFieldCount,
      },
      suggestedOutcome: null,
      validationDiagnostics: {
        planner: plannerDiagnostics,
        reviser: reviserDiagnostics,
        searchPlanGenerator: searchPlanDiagnostics,
      },
      metrics: calculateAutomaticMetrics(finalPlan, finalReportPlan.plan),
      calls: {
        llm: counters.llm,
        search: counters.search,
        searchHttpAttempts: input.readSearchHttpAttemptCount === undefined
          ? ("unavailable" as const)
          : input.readSearchHttpAttemptCount(),
        extract: 0,
      },
      callsByStage: {
        graphOutlinePlanning: {
          llm: graphOutlineLlmCalls,
          search: graphOutlineSearchCalls,
        },
        searchPlanPlanning: {
          llm: counters.llm - graphOutlineLlmCalls,
          search: 0,
        },
      },
      timingsMs: {
        graphOutlinePlanning: completedGraphOutlinePlanningTimingMs,
        searchPlanPlanning: searchPlanPlanningTimingMs,
        planner: plannerTimingMs,
        broadDiscovery: broadDiscoveryTimingMs,
        graphReviser: graphReviserTimingMs,
        total: elapsedSince(startedAt),
      },
      tokenUsage,
      tokenUsageByStage: {
        graphOutlinePlanning: summarizeTokenUsage(
          stageUsages?.slice(0, graphOutlineLlmCalls),
          graphOutlineLlmCalls,
        ),
        searchPlanPlanning: summarizeTokenUsage(
          stageUsages?.slice(graphOutlineLlmCalls),
          counters.llm - graphOutlineLlmCalls,
        ),
      },
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
    const searchHttpAttempts: number | "unavailable" =
      input.readSearchHttpAttemptCount === undefined
        ? "unavailable"
        : input.readSearchHttpAttemptCount();
    const completedGraphOutlineLlmCalls = graphOutlineLlmCalls ?? counters.llm;
    const completedGraphOutlineSearchCalls =
      graphOutlineSearchCalls ?? counters.search;
    const tokenUsages = input.readTokenUsages?.();
    const tokenUsage = summarizeTokenUsage(tokenUsages, counters.llm);
    const stageUsages = tokenUsage.status === "available"
      ? tokenUsages
      : undefined;
    const totalTimingMs = elapsedSince(startedAt);
    const common = {
      query: input.query,
      calls: {
        llm: counters.llm,
        search: counters.search,
        searchHttpAttempts,
        extract: 0 as const,
      },
      callsByStage: {
        graphOutlinePlanning: {
          llm: completedGraphOutlineLlmCalls,
          search: completedGraphOutlineSearchCalls,
        },
        searchPlanPlanning: {
          llm: counters.llm - completedGraphOutlineLlmCalls,
          search: 0 as const,
        },
      },
      timingsMs: {
        graphOutlinePlanning:
          graphOutlinePlanningTimingMs ??
          (graphOutlinePlanningStartedAt === null
            ? null
            : elapsedSince(graphOutlinePlanningStartedAt)),
        searchPlanPlanning:
          searchPlanPlanningStartedAt === null
            ? null
            : elapsedSince(searchPlanPlanningStartedAt),
        total: totalTimingMs,
      },
      tokenUsage,
      tokenUsageByStage: {
        graphOutlinePlanning: summarizeTokenUsage(
          stageUsages?.slice(0, completedGraphOutlineLlmCalls),
          completedGraphOutlineLlmCalls,
        ),
        searchPlanPlanning: summarizeTokenUsage(
          stageUsages?.slice(completedGraphOutlineLlmCalls),
          counters.llm - completedGraphOutlineLlmCalls,
        ),
      },
      estimatedCost: {
        status: "unavailable" as const,
        reason: "pricing_not_frozen" as const,
      },
    };

    if (interrupted) {
      const deadlineExceeded = deadlineSignal.aborted ||
        (input.signal?.aborted !== true &&
          error instanceof Error &&
          error.name === "TimeoutError");
      return {
        ...common,
        executionStatus: deadlineExceeded
          ? "deadline_exceeded"
          : "cancelled",
        suggestedOutcome: null,
      };
    }

    const reason =
      error instanceof GraphPlannerError ||
      error instanceof GraphRevisionError ||
      error instanceof SearchPlanGenerationError
        ? error.kind
        : error instanceof BroadDiscoveryError
          ? "no_evidence"
          : null;
    return {
      ...common,
      executionStatus: "failed",
      failure: {
        stage: activeStage,
        reason: reason ?? "unexpected_internal_error",
      },
      suggestedOutcome: "targetedIterate",
    };
  }
}
