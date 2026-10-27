/**
 * 模块职责：定义 WAY-86/87/90 Golden / Full Quality Eval（质量评估）的统一版本化接口，
 * 并把完整生产 Search Run 投影成可比较的本地事实与确定性指标工件。
 *
 * 关键边界：
 * - 本模块只处理已冻结数据集、公共 Event/ResultGraph 与内部 Run Log，不读取文件、环境或 Secret；
 * - 报告记录结构、基础事实和独立指标，不设置质量阈值、总分或产品结论；
 * - Top 3 只复制公共 Resource 投影，禁止 Provider 原始响应、Extract 正文和 Error 对象进入结果；
 * - 官方来源排名使用固定 Eval 真值，不用被测生产检测器或 sourceType 自我评分。
 */
import { createHash } from "node:crypto";

import {
  AppErrorCodeSchema,
  GraphPlanSchema,
  MAX_RETAINED_RESOURCES_PER_NODE,
  NodeWarningCodeSchema,
  ResourceSchema,
  StreamEventPayloadSchema,
  type ResultGraph,
  type ResultGraphNode,
  type StreamEventPayload,
} from "@wayfinder/contracts";
import { z } from "zod";

import type { RunLogRecord } from "../observability/run-log.js";
import { classifyFreshness } from "../pipeline/freshness.js";
import type { SearchStreamHandler } from "../routes/search.js";
import {
  QualityEvalDuplicateResourceSchema,
  QualityEvalMetricFailureSchema,
  QualityEvalMetricsSchema,
  QualityEvalOfficialSourceSchema,
  QualityEvalTelemetrySchema,
  createQualityEvalMetricFailure,
  fingerprintQualityEvalCanonicalUrl,
  measureQualityEvalMetrics,
  redactQualityEvalResourceUrl,
  type QualityEvalMetricFailure,
  type QualityEvalMetricMeasurement,
} from "./quality-metrics.js";

export const QUALITY_EVAL_SCHEMA_VERSION = "quality-eval.v5" as const;
export const QUALITY_EVAL_DATASET_VERSION =
  "wayfinder-regression.v1" as const;

export type QualityEvalDatasetKind = "golden" | "full";

const QualityEvalQuerySchema = z.strictObject({
  id: z.string().regex(/^wfq-\d{3}$/u),
  query: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  rationale: z.string().trim().min(1).max(500),
});

export type QualityEvalQuery = Readonly<z.infer<typeof QualityEvalQuerySchema>>;

const GOLDEN_QUERY_IDS = [
  "wfq-001",
  "wfq-006",
  "wfq-009",
  "wfq-012",
  "wfq-013",
  "wfq-015",
] as const;

/**
 * 这是 Eval Ground Truth（评估真值），不是生产 Official Allowlist（官方允许名单）。
 * V0 只对两条固定下载 Query 冻结可独立核验的官方域，避免用被测检测器自我评分。
 */
const FROZEN_OFFICIAL_DOMAINS = {
  "wfq-009": ["code.visualstudio.com"],
  "wfq-010": ["python.org"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const FROZEN_GOLDEN_DEFINITION_FINGERPRINT =
  "8680ee7d11b874ea4825fd87c3484932c4216e5e83dbce9b3252b053a8205b22";
const FROZEN_FULL_DEFINITION_FINGERPRINT =
  "dd30108f58f35123a4f6552e55157072f30eccc3eed9b47799f840c88ebe62f9";

const GoldenQueriesSchema = z
  .array(QualityEvalQuerySchema)
  .length(GOLDEN_QUERY_IDS.length)
  .superRefine((queries, context) => {
    if (
      queries.some((query, index) => query.id !== GOLDEN_QUERY_IDS[index])
    ) {
      context.addIssue({
        code: "custom",
        message: "Golden Query ID 或顺序发生漂移",
      });
    }
  });

const FullQueriesSchema = z
  .array(QualityEvalQuerySchema)
  .length(20)
  .superRefine((queries, context) => {
    const expectedIds = Array.from({ length: 20 }, (_, index) =>
      `wfq-${String(index + 1).padStart(3, "0")}`,
    );
    if (queries.some((query, index) => query.id !== expectedIds[index])) {
      context.addIssue({
        code: "custom",
        message: "Full Query ID 必须按 wfq-001 至 wfq-020 排列",
      });
    }
    if (new Set(queries.map(query => query.query)).size !== queries.length) {
      context.addIssue({ code: "custom", message: "Full Query 文本必须唯一" });
    }
  });

export type QualityEvalDataset = Readonly<{
  version: typeof QUALITY_EVAL_DATASET_VERSION;
  kind: QualityEvalDatasetKind;
  queries: readonly QualityEvalQuery[];
  officialDomainsByQueryId: Readonly<Record<string, readonly string[]>>;
}>;

export type QualityEvalDatasets = Readonly<{
  golden: QualityEvalDataset;
  full: QualityEvalDataset;
}>;

function fingerprintText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprintJson(value: unknown): string {
  return fingerprintText(JSON.stringify(value));
}

/** 只使用稳定配置事实生成比较指纹，不混入时间或 Run ID。 */
export function fingerprintQualityEvalDataset(
  dataset: QualityEvalDataset,
): string {
  return fingerprintJson({
    version: dataset.version,
    kind: dataset.kind,
    queries: dataset.queries,
    officialDomainsByQueryId: dataset.officialDomainsByQueryId,
  });
}

/**
 * 现有 Golden 文件继续保持唯一来源；Full 文件必须逐字段包含相同的六条定义。
 * 交叉校验让两个受 Git 管理的文件不能静默形成两套基线。
 */
export function parseQualityEvalDatasets(
  goldenValue: unknown,
  fullValue: unknown,
): QualityEvalDatasets {
  const golden = GoldenQueriesSchema.parse(goldenValue);
  const full = FullQueriesSchema.parse(fullValue);
  const fullById = new Map(full.map(query => [query.id, query]));

  for (const goldenQuery of golden) {
    const fullQuery = fullById.get(goldenQuery.id);
    if (
      fullQuery === undefined ||
      fullQuery.query !== goldenQuery.query ||
      fullQuery.category !== goldenQuery.category ||
      fullQuery.rationale !== goldenQuery.rationale
    ) {
      throw new TypeError("Golden 与 Full Query 定义不一致");
    }
  }
  if (
    fingerprintJson(golden) !== FROZEN_GOLDEN_DEFINITION_FINGERPRINT ||
    fingerprintJson(full) !== FROZEN_FULL_DEFINITION_FINGERPRINT
  ) {
    throw new TypeError(
      "Query 定义已变化，必须升级 Dataset Version 与冻结指纹",
    );
  }

  return {
    golden: {
      version: QUALITY_EVAL_DATASET_VERSION,
      kind: "golden",
      queries: golden,
      officialDomainsByQueryId: {
        "wfq-009": FROZEN_OFFICIAL_DOMAINS["wfq-009"],
      },
    },
    full: {
      version: QUALITY_EVAL_DATASET_VERSION,
      kind: "full",
      queries: full,
      officialDomainsByQueryId: FROZEN_OFFICIAL_DOMAINS,
    },
  };
}

const QualityEvalFreshnessSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("notApplicable") }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.enum(["noResources", "noDatedResources"]),
  }),
  z.strictObject({
    status: z.literal("measured"),
    buckets: z.strictObject({
      within1Day: z.number().int().min(0).max(3),
      within7Days: z.number().int().min(0).max(3),
      within30Days: z.number().int().min(0).max(3),
      within365Days: z.number().int().min(0).max(3),
      older: z.number().int().min(0).max(3),
      future: z.number().int().min(0).max(3),
    }),
  }),
]);

const QualityEvalNodeSchema = z
  .strictObject({
    id: z.string().min(1),
    status: z.enum(["ready", "partial", "failed"]),
    warnings: z.array(NodeWarningCodeSchema),
    errorCode: AppErrorCodeSchema.nullable(),
    resourceCount: z
      .number()
      .int()
      .min(0)
      .max(MAX_RETAINED_RESOURCES_PER_NODE),
    topResources: z.array(ResourceSchema).max(3),
    officialSource: QualityEvalOfficialSourceSchema,
    diversity: z.strictObject({
      distinctExactDomainCount: z.number().int().min(0).max(3),
    }),
    freshness: QualityEvalFreshnessSchema,
  })
  .superRefine((node, context) => {
    const exactDomainCount = new Set(
      node.topResources.map(resource => resource.domain),
    ).size;
    if (node.diversity.distinctExactDomainCount !== exactDomainCount) {
      context.addIssue({
        code: "custom",
        path: ["diversity", "distinctExactDomainCount"],
        message: "域名多样性计数与 Top Resource 不一致",
      });
    }

  });

export const QualityEvalQueryResultSchema = z
  .strictObject({
    schemaVersion: z.literal(QUALITY_EVAL_SCHEMA_VERSION),
    comparisonKey: z.string().min(1),
    query: QualityEvalQuerySchema,
    executionStatus: z.enum([
      "completed",
      "run_failed",
      "cancelled",
      "unexpected_internal_error",
    ]),
    finalStatus: z.enum(["complete", "partial"]).nullable(),
    errorCode: AppErrorCodeSchema.nullable(),
    freshnessReferenceAt: z.iso.datetime({ offset: true }).nullable(),
    plan: GraphPlanSchema.nullable(),
    nodes: z.array(QualityEvalNodeSchema),
    duplicateResources: z.array(QualityEvalDuplicateResourceSchema),
    metrics: QualityEvalMetricsSchema.nullable(),
    metricFailure: QualityEvalMetricFailureSchema.nullable(),
    telemetry: QualityEvalTelemetrySchema.nullable(),
  })
  .superRefine((result, context) => {
    if (
      result.executionStatus === "completed" &&
      (result.finalStatus === null ||
        result.freshnessReferenceAt === null ||
        result.plan === null ||
        result.telemetry === null ||
        result.metrics === null ||
        result.metricFailure !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "completed 结果必须包含最终状态、计划与遥测",
      });
    }
    if (
      result.executionStatus !== "completed" &&
      (result.finalStatus !== null ||
        result.freshnessReferenceAt !== null ||
        result.plan !== null ||
        result.nodes.length > 0 ||
        result.duplicateResources.length > 0 ||
        result.metrics !== null ||
        result.metricFailure === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "未完成结果不得伪造最终图事实",
      });
    }
    if (
      result.executionStatus === "run_failed" &&
      result.errorCode === null
    ) {
      context.addIssue({
        code: "custom",
        message: "run_failed 必须保留稳定错误码",
      });
    }
    if (
      result.executionStatus !== "run_failed" &&
      result.errorCode !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "只有 run_failed 可以包含 Run 级错误码",
      });
    }
    if (
      result.metricFailure !== null &&
      result.metricFailure.queryId !== result.query.id
    ) {
      context.addIssue({
        code: "custom",
        message: "指标失败必须定位当前 Query",
      });
    }
    if (
      result.executionStatus === "completed" &&
      result.plan !== null &&
      result.freshnessReferenceAt !== null &&
      result.metrics !== null
    ) {
      const planNodeIds = result.plan.nodes.map(node => node.id);
      const projectedNodeIds = result.nodes.map(node => node.id);
      if (
        result.metrics.nodeCount !== planNodeIds.length ||
        projectedNodeIds.length !== planNodeIds.length ||
        projectedNodeIds.some((nodeId, index) => nodeId !== planNodeIds[index])
      ) {
        context.addIssue({
          code: "custom",
          path: ["nodes"],
          message: "Quality Eval Node 投影与 Plan 或指标不一致",
        });
      }
      const planNodeById = new Map(
        result.plan.nodes.map(node => [node.id, node]),
      );
      const referenceMs = Date.parse(result.freshnessReferenceAt);
      for (const [index, node] of result.nodes.entries()) {
        const planNode = planNodeById.get(node.id);
        if (planNode === undefined) {
          context.addIssue({
            code: "custom",
            path: ["nodes", index, "id"],
            message: "新鲜度投影缺少对应 Plan Node",
          });
          continue;
        }
        const expected = readFreshness(
          planNode.searchPlan.rankingProfile === "news" ||
            result.plan.analysis.freshnessSensitive,
          node.topResources,
          referenceMs,
        );
        if (JSON.stringify(node.freshness) !== JSON.stringify(expected)) {
          context.addIssue({
            code: "custom",
            path: ["nodes", index, "freshness"],
            message: "新鲜度投影与 Plan、参考时间或 Top Resource 不一致",
          });
        }
      }
    }
  });

export type QualityEvalQueryResult = Readonly<
  z.infer<typeof QualityEvalQueryResultSchema>
>;

export type EvaluateQualityEvalQueryInput = Readonly<{
  query: QualityEvalQuery;
  runId: string;
  signal: AbortSignal;
  runDeadlineMs: number;
  expectedOfficialDomains: readonly string[];
  handleSearch: SearchStreamHandler;
  readRunLog: () => RunLogRecord | undefined;
}>;

function projectRunLog(record: RunLogRecord | undefined): z.infer<
  typeof QualityEvalTelemetrySchema
> | null {
  if (record === undefined) return null;

  // Run Log 还包含可由 ResultGraph 推导的数量；Eval 只投影 Provider 调用事实，
  // 防止同一事实在报告中出现两套来源并随 Run Log 扩展而隐式漂移。
  const { counts } = record;
  return QualityEvalTelemetrySchema.parse({
    timingsMs: record.timingsMs,
    versions: { rankFusion: record.versions.rankFusion },
    counts: {
      logicalSearchCalls: counts.logicalSearchCalls,
      logicalExtractCalls: counts.logicalExtractCalls,
      extractUrlCount: counts.extractUrlCount,
      logicalLlmCalls: counts.logicalLlmCalls,
      searchHttpAttempts: counts.searchHttpAttempts,
      extractHttpAttempts: counts.extractHttpAttempts,
    },
    ranking: record.ranking,
    tokens: record.tokens,
    estimatedCost: record.estimatedCost,
  });
}

function createBaseResult(
  query: QualityEvalQuery,
  telemetry: z.infer<typeof QualityEvalTelemetrySchema> | null,
): Pick<QualityEvalQueryResult, "schemaVersion" | "comparisonKey" | "query" | "telemetry"> {
  return {
    schemaVersion: QUALITY_EVAL_SCHEMA_VERSION,
    comparisonKey: `${QUALITY_EVAL_DATASET_VERSION}:${query.id}`,
    query,
    telemetry,
  };
}

function createExecutionFailure(
  query: QualityEvalQuery,
  executionStatus:
    | "run_failed"
    | "cancelled"
    | "unexpected_internal_error",
  telemetry: z.infer<typeof QualityEvalTelemetrySchema> | null,
  metricFailure: QualityEvalMetricFailure,
  errorCode: z.infer<typeof AppErrorCodeSchema> | null = null,
): QualityEvalQueryResult {
  return QualityEvalQueryResultSchema.parse({
    ...createBaseResult(query, telemetry),
    executionStatus,
    finalStatus: null,
    errorCode,
    freshnessReferenceAt: null,
    plan: null,
    nodes: [],
    duplicateResources: [],
    metrics: null,
    metricFailure,
  });
}

function readDiversity(
  topResources: readonly ResultGraphNode["resources"][number][],
): z.infer<typeof QualityEvalNodeSchema>["diversity"] {
  return {
    distinctExactDomainCount: new Set(
      topResources.map(resource => resource.domain),
    ).size,
  };
}

/**
 * 新鲜度只投影最终 Top 3 的可观察日期，不从摘要或模型分数推断缺失事实。
 * ResultGraph 已通过公共 Schema；若带日期值仍无法分类，则视为内部投影不变量失败。
 */
function readFreshness(
  applicable: boolean,
  topResources: readonly ResultGraphNode["resources"][number][],
  referenceMs: number,
): z.infer<typeof QualityEvalFreshnessSchema> {
  if (!applicable) return { status: "notApplicable" };

  if (topResources.length === 0) {
    return { status: "unavailable", reason: "noResources" };
  }

  const buckets = {
    within1Day: 0,
    within7Days: 0,
    within30Days: 0,
    within365Days: 0,
    older: 0,
    future: 0,
  };
  let publishedAtCount = 0;
  for (const resource of topResources) {
    if (resource.publishedAt == null) continue;
    const bucket = classifyFreshness(resource.publishedAt, referenceMs);
    if (bucket === "unavailable") {
      throw new TypeError("Quality Eval Resource 日期事实无效");
    }
    buckets[bucket] += 1;
    publishedAtCount += 1;
  }
  if (publishedAtCount === 0) {
    return { status: "unavailable", reason: "noDatedResources" };
  }
  return {
    status: "measured",
    buckets,
  };
}

function projectResource(
  resource: ResultGraphNode["resources"][number],
): z.infer<typeof ResourceSchema> {
  return ResourceSchema.parse({
    ...resource,
    id: `resource_${fingerprintQualityEvalCanonicalUrl(resource.canonicalUrl)}`,
    url: redactQualityEvalResourceUrl(resource.url),
    canonicalUrl: redactQualityEvalResourceUrl(resource.canonicalUrl),
  });
}

type MeasuredNodeMetric = Extract<
  QualityEvalMetricMeasurement,
  { status: "measured" }
>["nodeMetrics"][number];

function projectNodes(
  result: ResultGraph,
  nodeMetrics: readonly MeasuredNodeMetric[],
): z.infer<typeof QualityEvalNodeSchema>[] {
  const referenceMs = Date.parse(result.meta.createdAt);
  return result.graph.nodes.map((node, index) => {
    const nodeMetric = nodeMetrics[index];
    if (nodeMetric === undefined || nodeMetric.nodeId !== node.id) {
      throw new TypeError("Quality Eval Node 指标与结果不一致");
    }
    // 生产 Finalizer 已冻结展示数组顺序；这里保留其前 3 项，不能重排并掩盖顺序回归。
    const topResources = node.resources.slice(0, 3).map(projectResource);
    return QualityEvalNodeSchema.parse({
      id: node.id,
      status: node.status,
      warnings: node.warnings,
      errorCode: node.status === "failed" ? node.error.code : null,
      resourceCount: nodeMetric.resourceCount,
      topResources,
      officialSource: nodeMetric.officialSource,
      diversity: readDiversity(topResources),
      freshness: readFreshness(
        node.searchPlan.rankingProfile === "news" ||
          result.analysis.freshnessSensitive,
        topResources,
        referenceMs,
      ),
    });
  });
}

export type EvaluateQualityEvalDatasetInput = Readonly<{
  dataset: QualityEvalDataset;
  signal: AbortSignal;
  evaluate: (
    query: QualityEvalQuery,
    signal: AbortSignal,
  ) => Promise<QualityEvalQueryResult>;
}>;

/**
 * Suite（套件）严格按数据集顺序串行运行；取消一旦可见便停止启动后续 Query。
 * 逐 Query 指标由纯函数计算；这里不引入通过率、阈值或综合分。
 */
export async function evaluateQualityEvalDataset(
  input: EvaluateQualityEvalDatasetInput,
): Promise<readonly QualityEvalQueryResult[]> {
  const results: QualityEvalQueryResult[] = [];
  for (const query of input.dataset.queries) {
    if (input.signal.aborted) break;
    const result = await input.evaluate(query, input.signal);
    results.push(result);
    if (input.signal.aborted || result.executionStatus === "cancelled") break;
  }
  return results;
}

function findSingleTerminal(
  payloads: readonly StreamEventPayload[],
): Extract<StreamEventPayload, { type: "complete" | "run.failed" }> | null {
  const terminals = payloads.filter(
    (
      payload,
    ): payload is Extract<
      StreamEventPayload,
      { type: "complete" | "run.failed" }
    > => payload.type === "complete" || payload.type === "run.failed",
  );
  return terminals.length === 1 ? terminals[0] ?? null : null;
}

/** 执行单个固定 Query；原始异常只参与分类，绝不进入返回对象。 */
export async function evaluateQualityEvalQuery(
  input: EvaluateQualityEvalQueryInput,
): Promise<QualityEvalQueryResult> {
  const payloads: StreamEventPayload[] = [];
  let streamSchemaInvalid = false;
  try {
    await input.handleSearch({
      input: { runId: input.runId, query: input.query.query },
      signal: input.signal,
      emit: async payload => {
        const parsed = StreamEventPayloadSchema.safeParse(payload);
        if (!parsed.success) {
          streamSchemaInvalid = true;
          throw new TypeError("Quality Eval Stream Event Schema 无效");
        }
        payloads.push(structuredClone(parsed.data));
      },
    });
  } catch {
    const cancelled = input.signal.aborted;
    return createExecutionFailure(
      input.query,
      cancelled ? "cancelled" : "unexpected_internal_error",
      projectRunLog(input.readRunLog()),
      createQualityEvalMetricFailure(
        input.query.id,
        streamSchemaInvalid ? "schemaValidity" : "execution",
        streamSchemaInvalid ? "streamEvent" : "pipeline",
        cancelled
          ? "cancelled"
          : streamSchemaInvalid
            ? "schema_invalid"
            : "unexpected_internal_error",
      ),
    );
  }

  const telemetry = projectRunLog(input.readRunLog());
  const terminal = findSingleTerminal(payloads);
  if (terminal === null) {
    return createExecutionFailure(
      input.query,
      "unexpected_internal_error",
      telemetry,
      createQualityEvalMetricFailure(
        input.query.id,
        "execution",
        "streamEvent",
        "terminal_event_invalid",
      ),
    );
  }
  if (terminal.type === "run.failed") {
    return createExecutionFailure(
      input.query,
      "run_failed",
      telemetry,
      createQualityEvalMetricFailure(
        input.query.id,
        terminal.error.code === "RUN_DEADLINE_EXCEEDED"
          ? "deadlineCompliance"
          : "execution",
        terminal.error.code === "RUN_DEADLINE_EXCEEDED"
          ? "runDeadline"
          : "pipeline",
        terminal.error.code,
      ),
      terminal.error.code,
    );
  }

  const plans = payloads.filter(
    (
      payload,
    ): payload is Extract<StreamEventPayload, { type: "graph.plan" }> =>
      payload.type === "graph.plan",
  );
  if (plans.length !== 1) {
    return createExecutionFailure(
      input.query,
      "unexpected_internal_error",
      telemetry,
      createQualityEvalMetricFailure(
        input.query.id,
        "schemaValidity",
        "graphPlan",
        "plan_event_invalid",
      ),
    );
  }
  if (telemetry === null) {
    return createExecutionFailure(
      input.query,
      "unexpected_internal_error",
      null,
      createQualityEvalMetricFailure(
        input.query.id,
        "deadlineCompliance",
        "runLog",
        "telemetry_unavailable",
      ),
    );
  }

  const finalPlan = plans[0]?.data;
  if (finalPlan === undefined) {
    return createExecutionFailure(
      input.query,
      "unexpected_internal_error",
      telemetry,
      createQualityEvalMetricFailure(
        input.query.id,
        "schemaValidity",
        "graphPlan",
        "plan_event_invalid",
      ),
    );
  }
  const result = terminal.data.result;
  const measurement = measureQualityEvalMetrics({
    queryId: input.query.id,
    plan: finalPlan,
    result,
    telemetry,
    expectedOfficialDomains: input.expectedOfficialDomains,
    runDeadlineMs: input.runDeadlineMs,
  });
  if (measurement.status === "failed") {
    return createExecutionFailure(
      input.query,
      "unexpected_internal_error",
      telemetry,
      measurement.failure,
    );
  }
  return QualityEvalQueryResultSchema.parse({
    ...createBaseResult(input.query, telemetry),
    executionStatus: "completed",
    finalStatus: terminal.data.finalStatus,
    errorCode: null,
    freshnessReferenceAt: result.meta.createdAt,
    plan: finalPlan,
    nodes: projectNodes(result, measurement.nodeMetrics),
    duplicateResources: measurement.duplicateResources,
    metrics: measurement.metrics,
    metricFailure: null,
  });
}
