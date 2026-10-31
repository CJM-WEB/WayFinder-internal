/**
 * 模块职责：计算 WAY-87 的逐 Query 确定性质量指标，并集中维护 Resource 身份、
 * 重复分组与独立官方来源真值的计算口径。
 *
 * 关键边界：
 * - 只消费公共 GraphPlan / ResultGraph 与 WAY-86 脱敏遥测，不读取文件、环境或 Secret；
 * - 只输出独立事实，不设置阈值、通过率、综合分或发布门禁；
 * - Schema 失败只返回固定 Query、指标、阶段与 Code，不回显 Zod 详情或原始输入；
 * - Resource count 与重复率始终基于完整 ResultGraph，不能使用只含前三项的展示投影。
 */
import { createHash } from "node:crypto";

import {
  AppErrorCodeSchema,
  GraphPlanSchema,
  MAX_RETAINED_RESOURCES_PER_NODE,
  ResultGraphSchema,
  SearchLanguageSchema,
  calculateSearchPlanMaxResults,
  type GraphPlan,
} from "@wayfinder/contracts";
import { z } from "zod";

import { RunLogRecordSchema } from "../observability/run-log.js";

export const QUALITY_METRICS_VERSION = "quality-metrics.v4" as const;

/**
 * Quality Eval 使用的固定生产请求配置。它只参与内存身份计算，不进入新增诊断对象；
 * 若 Provider 或语言策略变化，必须显式升级评估版本，不能把不同条件混为同一身份。
 */
export const QualityEvalPlannedRequestConfigSchema = z.strictObject({
  providerId: z.literal("serpapi_bing"),
  language: SearchLanguageSchema,
});

export type QualityEvalPlannedRequestConfig = Readonly<
  z.infer<typeof QualityEvalPlannedRequestConfigSchema>
>;

export const QUALITY_EVAL_PLANNED_REQUEST_CONFIG = Object.freeze({
  providerId: "serpapi_bing",
  language: "zh-CN",
} as const satisfies QualityEvalPlannedRequestConfig);

const NonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

/**
 * 计划请求诊断只序列化五个聚合安全整数。Query、Node ID、身份 Key 与分组证据
 * 只能存在于计算期间；严格对象会拒绝任何额外身份字段。
 */
export const QualityEvalPlannedRequestDuplicationSchema = z
  .strictObject({
    totalCount: NonNegativeSafeIntegerSchema,
    uniqueCount: NonNegativeSafeIntegerSchema,
    intraNodeDuplicateOccurrenceCount: NonNegativeSafeIntegerSchema,
    crossNodeSharedGroupCount: NonNegativeSafeIntegerSchema,
    crossNodeExtraNodeOccurrenceCount: NonNegativeSafeIntegerSchema,
  })
  .superRefine((diagnostic, context) => {
    if (
      diagnostic.totalCount - diagnostic.uniqueCount !==
      diagnostic.intraNodeDuplicateOccurrenceCount +
        diagnostic.crossNodeExtraNodeOccurrenceCount
    ) {
      context.addIssue({
        code: "custom",
        message: "计划请求重复 occurrence 分解不一致",
      });
    }
    if (
      diagnostic.crossNodeSharedGroupCount >
      diagnostic.crossNodeExtraNodeOccurrenceCount
    ) {
      context.addIssue({
        code: "custom",
        message: "跨 Node 共享组不能多于额外 Node occurrence",
      });
    }
  });

export type QualityEvalPlannedRequestDuplication = Readonly<
  z.infer<typeof QualityEvalPlannedRequestDuplicationSchema>
>;

/** 防止聚合过程在未来放宽 GraphPlan 数量边界后静默越过安全整数范围。 */
function addSafeCount(current: number, value: number): number {
  const next = current + value;
  if (!Number.isSafeInteger(next) || next < 0) {
    throw new RangeError("Quality Eval 计划请求计数超出安全整数范围");
  }
  return next;
}

/**
 * 从完整 Final GraphPlan 构造 planned Search Request identity 并立即聚合。
 *
 * 每个身份组先按 Node 统计 occurrence：同一 Node 的第二次及以后计入 Node 内重复；
 * 每个额外 Node 的第一次计入跨 Node occurrence。两者互斥，避免重复计数。
 */
export function measureQualityEvalPlannedRequestDuplication(
  plan: GraphPlan,
  config: unknown,
): QualityEvalPlannedRequestDuplication {
  const parsedConfig = QualityEvalPlannedRequestConfigSchema.parse(config);
  const nodeOccurrencesByIdentity = new Map<string, Map<string, number>>();
  let totalCount = 0;

  for (const node of plan.nodes) {
    const maxResults = calculateSearchPlanMaxResults(
      node.searchPlan.queries.length,
    );
    for (const query of node.searchPlan.queries) {
      // JSON Tuple 只作为内存 Map Key，避免文本分隔符碰撞；该值绝不返回或持久化。
      const identity = JSON.stringify([
        parsedConfig.providerId,
        "node",
        query,
        maxResults,
        "general",
        plan.analysis.freshnessSensitive,
        parsedConfig.language,
      ]);
      const nodeOccurrences =
        nodeOccurrencesByIdentity.get(identity) ?? new Map<string, number>();
      nodeOccurrences.set(
        node.id,
        addSafeCount(nodeOccurrences.get(node.id) ?? 0, 1),
      );
      nodeOccurrencesByIdentity.set(identity, nodeOccurrences);
      totalCount = addSafeCount(totalCount, 1);
    }
  }

  let intraNodeDuplicateOccurrenceCount = 0;
  let crossNodeSharedGroupCount = 0;
  let crossNodeExtraNodeOccurrenceCount = 0;
  for (const nodeOccurrences of nodeOccurrencesByIdentity.values()) {
    const distinctNodeCount = nodeOccurrences.size;
    const groupTotal = [...nodeOccurrences.values()].reduce(
      (total, count) => addSafeCount(total, count),
      0,
    );
    intraNodeDuplicateOccurrenceCount = addSafeCount(
      intraNodeDuplicateOccurrenceCount,
      groupTotal - distinctNodeCount,
    );
    if (distinctNodeCount > 1) {
      crossNodeSharedGroupCount = addSafeCount(
        crossNodeSharedGroupCount,
        1,
      );
      crossNodeExtraNodeOccurrenceCount = addSafeCount(
        crossNodeExtraNodeOccurrenceCount,
        distinctNodeCount - 1,
      );
    }
  }

  return QualityEvalPlannedRequestDuplicationSchema.parse({
    totalCount,
    uniqueCount: nodeOccurrencesByIdentity.size,
    intraNodeDuplicateOccurrenceCount,
    crossNodeSharedGroupCount,
    crossNodeExtraNodeOccurrenceCount,
  });
}

const QualityEvalCallCountsSchema = RunLogRecordSchema.shape.counts.pick({
  logicalSearchCalls: true,
  logicalExtractCalls: true,
  extractUrlCount: true,
  logicalLlmCalls: true,
  searchHttpAttempts: true,
  extractHttpAttempts: true,
});

const QualityEvalVersionSchema = RunLogRecordSchema.shape.versions.pick({
  rankFusion: true,
});

export const QualityEvalTelemetrySchema = RunLogRecordSchema.pick({
  timingsMs: true,
  planningStages: true,
  ranking: true,
  tokens: true,
  estimatedCost: true,
}).extend({
  counts: QualityEvalCallCountsSchema,
  versions: QualityEvalVersionSchema,
  /** 历史报告不能从总计 Token 反推分阶段事实，显式保留 null。 */
  planningStages: RunLogRecordSchema.shape.planningStages.nullable(),
});

export const QualityEvalOfficialSourceSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("notApplicable") }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.literal("noResources"),
  }),
  z.strictObject({ status: z.literal("noneDetected") }),
  z.strictObject({
    status: z.literal("detected"),
    rank: z.number().int().min(1).max(MAX_RETAINED_RESOURCES_PER_NODE),
  }),
]);

export const QualityEvalDuplicateResourceSchema = z.strictObject({
  canonicalUrlFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  occurrences: z
    .array(
      z.strictObject({
        nodeId: z.string().min(1),
        rank: z.number().int().min(1).max(MAX_RETAINED_RESOURCES_PER_NODE),
      }),
    )
    .min(2),
});

const QualityEvalNodeMetricsSchema = z.strictObject({
  nodeId: z.string().min(1),
  resourceCount: z
    .number()
    .int()
    .min(0)
    .max(MAX_RETAINED_RESOURCES_PER_NODE),
  officialSource: QualityEvalOfficialSourceSchema,
});

const DuplicateRateSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("measured"),
    duplicateOccurrences: z.number().int().min(0),
    totalOccurrences: z.number().int().min(1),
    value: z.number().finite().min(0).max(1),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.literal("noResources"),
  }),
]);

const DeadlineComplianceSchema = z.strictObject({
  status: z.enum(["within", "exceeded"]),
});

export const QualityEvalMetricsSchema = z.strictObject({
  version: z.literal(QUALITY_METRICS_VERSION),
  schemaValidity: z.literal("valid"),
  nodeCount: z.number().int().min(1),
  resourceCount: z.number().int().min(0),
  plannedRequestDuplication: QualityEvalPlannedRequestDuplicationSchema,
  duplicateRate: DuplicateRateSchema,
  officialSource: QualityEvalOfficialSourceSchema,
  deadlineCompliance: DeadlineComplianceSchema,
});

export const QualityEvalMetricFailureSchema = z.strictObject({
  queryId: z.union([z.string().regex(/^wfq-\d{3}$/u), z.literal("unknown")]),
  metric: z.enum([
    "schemaValidity",
    "nodeCount",
    "deadlineCompliance",
    "metricsProjection",
    "execution",
  ]),
  stage: z.enum([
    "streamEvent",
    "graphPlan",
    "resultGraph",
    "runLog",
    "runDeadline",
    "metricsProjection",
    "pipeline",
  ]),
  code: z.union([
    AppErrorCodeSchema,
    z.enum([
      "schema_invalid",
      "node_identity_mismatch",
      "policy_invalid",
      "cancelled",
      "unexpected_internal_error",
      "terminal_event_invalid",
      "plan_event_invalid",
      "telemetry_unavailable",
    ]),
  ]),
});

const MeasuredQualityEvalMetricsSchema = z.strictObject({
  status: z.literal("measured"),
  metrics: QualityEvalMetricsSchema,
  nodeMetrics: z.array(QualityEvalNodeMetricsSchema).min(1),
  duplicateResources: z.array(QualityEvalDuplicateResourceSchema),
});

const FailedQualityEvalMetricsSchema = z.strictObject({
  status: z.literal("failed"),
  failure: QualityEvalMetricFailureSchema,
});

const QualityEvalMetricMeasurementSchema = z.discriminatedUnion(
  "status",
  [MeasuredQualityEvalMetricsSchema, FailedQualityEvalMetricsSchema],
);

export type QualityEvalMetricFailure = Readonly<
  z.infer<typeof QualityEvalMetricFailureSchema>
>;
export type QualityEvalMetricMeasurement = Readonly<
  z.infer<typeof QualityEvalMetricMeasurementSchema>
>;

export type MeasureQualityEvalMetricsInput = Readonly<{
  queryId: string;
  plan: unknown;
  result: unknown;
  telemetry: unknown;
  expectedOfficialDomains: readonly string[];
  runDeadlineMs: number;
  plannedRequestConfig?: unknown;
}>;

function readFailureQueryId(value: string): string {
  return /^wfq-\d{3}$/u.test(value) ? value : "unknown";
}

export function createQualityEvalMetricFailure(
  queryId: string,
  metric: QualityEvalMetricFailure["metric"],
  stage: QualityEvalMetricFailure["stage"],
  code: QualityEvalMetricFailure["code"],
): QualityEvalMetricFailure {
  return QualityEvalMetricFailureSchema.parse({
    queryId: readFailureQueryId(queryId),
    metric,
    stage,
    code,
  });
}

function createFailedMeasurement(
  queryId: string,
  metric: QualityEvalMetricFailure["metric"],
  stage: QualityEvalMetricFailure["stage"],
  code: QualityEvalMetricFailure["code"],
): QualityEvalMetricMeasurement {
  return QualityEvalMetricMeasurementSchema.parse({
    status: "failed",
    failure: createQualityEvalMetricFailure(queryId, metric, stage, code),
  });
}

/**
 * URL 中的 userinfo、Query 与 Fragment 可能携带凭据或跟踪标识；Eval 身份只保留
 * scheme、host、port 与 pathname。该函数同时供 Resource 投影和重复率复用。
 */
export function redactQualityEvalResourceUrl(value: string): string {
  const parsed = new URL(value);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function fingerprintQualityEvalCanonicalUrl(value: string): string {
  return createHash("sha256")
    .update(redactQualityEvalResourceUrl(value))
    .digest("hex");
}

function aggregateOfficialSource(
  nodeMetrics: readonly z.infer<typeof QualityEvalNodeMetricsSchema>[],
  expectedOfficialDomains: readonly string[],
): z.infer<typeof QualityEvalOfficialSourceSchema> {
  if (expectedOfficialDomains.length === 0) {
    return { status: "notApplicable" };
  }
  const detectedRanks = nodeMetrics.flatMap(node =>
    node.officialSource.status === "detected"
      ? [node.officialSource.rank]
      : [],
  );
  if (detectedRanks.length > 0) {
    return { status: "detected", rank: Math.min(...detectedRanks) };
  }
  return nodeMetrics.every(
    node => node.officialSource.status === "unavailable",
  )
    ? { status: "unavailable", reason: "noResources" }
    : { status: "noneDetected" };
}

/**
 * 对一个已结束 Query 的内存事实执行一次确定性投影。调用方只接收成功指标或固定失败码，
 * 原始 Schema 诊断与输入对象不会进入返回值。
 */
export function measureQualityEvalMetrics(
  input: MeasureQualityEvalMetricsInput,
): QualityEvalMetricMeasurement {
  const parsedPlan = GraphPlanSchema.safeParse(input.plan);
  if (!parsedPlan.success) {
    return createFailedMeasurement(
      input.queryId,
      "schemaValidity",
      "graphPlan",
      "schema_invalid",
    );
  }
  const parsedResult = ResultGraphSchema.safeParse(input.result);
  if (!parsedResult.success) {
    return createFailedMeasurement(
      input.queryId,
      "schemaValidity",
      "resultGraph",
      "schema_invalid",
    );
  }
  const parsedTelemetry = QualityEvalTelemetrySchema.safeParse(input.telemetry);
  if (!parsedTelemetry.success) {
    return createFailedMeasurement(
      input.queryId,
      "schemaValidity",
      "runLog",
      "schema_invalid",
    );
  }
  if (!Number.isInteger(input.runDeadlineMs) || input.runDeadlineMs <= 0) {
    return createFailedMeasurement(
      input.queryId,
      "metricsProjection",
      "metricsProjection",
      "policy_invalid",
    );
  }

  let plannedRequestDuplication: QualityEvalPlannedRequestDuplication;
  try {
    plannedRequestDuplication =
      measureQualityEvalPlannedRequestDuplication(
        parsedPlan.data,
        input.plannedRequestConfig ?? QUALITY_EVAL_PLANNED_REQUEST_CONFIG,
      );
  } catch {
    return createFailedMeasurement(
      input.queryId,
      "metricsProjection",
      "metricsProjection",
      "policy_invalid",
    );
  }

  const planNodeIds = parsedPlan.data.nodes.map(node => node.id);
  const resultNodeIds = parsedResult.data.graph.nodes.map(node => node.id);
  if (
    planNodeIds.length !== resultNodeIds.length ||
    planNodeIds.some((nodeId, index) => nodeId !== resultNodeIds[index])
  ) {
    return createFailedMeasurement(
      input.queryId,
      "nodeCount",
      "resultGraph",
      "node_identity_mismatch",
    );
  }

  const occurrencesByCanonicalUrl = new Map<
    string,
    Array<{ nodeId: string; rank: number }>
  >();
  let deadlineErrorObserved = false;
  const nodeMetrics = parsedResult.data.graph.nodes.map(node => {
    let officialRank: number | null = null;
    if (
      node.status === "failed" &&
      node.error.code === "RUN_DEADLINE_EXCEEDED"
    ) {
      deadlineErrorObserved = true;
    }
    for (const resource of node.resources) {
      // 重复身份使用生产 canonicalUrl 原值；证据序列化时才脱敏并指纹化。
      const current =
        occurrencesByCanonicalUrl.get(resource.canonicalUrl) ?? [];
      current.push({ nodeId: node.id, rank: resource.rank });
      occurrencesByCanonicalUrl.set(resource.canonicalUrl, current);
      if (
        input.expectedOfficialDomains.some(
          expectedDomain =>
            resource.domain === expectedDomain ||
            resource.domain.endsWith(`.${expectedDomain}`),
        ) &&
        (officialRank === null || resource.rank < officialRank)
      ) {
        officialRank = resource.rank;
      }
    }
    return {
      nodeId: node.id,
      resourceCount: node.resources.length,
      officialSource:
        input.expectedOfficialDomains.length === 0
          ? { status: "notApplicable" as const }
          : node.resources.length === 0
            ? { status: "unavailable" as const, reason: "noResources" as const }
            : officialRank === null
              ? { status: "noneDetected" as const }
              : { status: "detected" as const, rank: officialRank },
    };
  });
  const duplicateResources = [...occurrencesByCanonicalUrl.entries()]
    .filter(([, values]) => values.length > 1)
    .map(([canonicalUrl, values]) => ({
        canonicalUrlFingerprint:
          fingerprintQualityEvalCanonicalUrl(canonicalUrl),
        occurrences: values,
      }))
    .sort((left, right) =>
      left.canonicalUrlFingerprint.localeCompare(
        right.canonicalUrlFingerprint,
      ),
    );
  const resourceCount = nodeMetrics.reduce(
    (total, node) => total + node.resourceCount,
    0,
  );
  const duplicateOccurrences = duplicateResources.reduce(
    (total, duplicate) => total + duplicate.occurrences.length - 1,
    0,
  );
  const totalMs = parsedTelemetry.data.timingsMs.total;

  return QualityEvalMetricMeasurementSchema.parse({
    status: "measured",
    metrics: {
      version: QUALITY_METRICS_VERSION,
      schemaValidity: "valid",
      nodeCount: parsedPlan.data.nodes.length,
      resourceCount,
      plannedRequestDuplication,
      duplicateRate:
        resourceCount === 0
          ? { status: "unavailable", reason: "noResources" }
          : {
              status: "measured",
              duplicateOccurrences,
              totalOccurrences: resourceCount,
              value: duplicateOccurrences / resourceCount,
            },
      officialSource: aggregateOfficialSource(
        nodeMetrics,
        input.expectedOfficialDomains,
      ),
      deadlineCompliance: {
        status:
          deadlineErrorObserved || totalMs > input.runDeadlineMs
            ? "exceeded"
            : "within",
      },
    },
    nodeMetrics,
    duplicateResources,
  });
}
