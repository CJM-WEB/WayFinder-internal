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
} from "@wayfinder/contracts";
import { z } from "zod";

import { RunLogRecordSchema } from "../observability/run-log.js";

export const QUALITY_METRICS_VERSION = "quality-metrics.v1" as const;

export const QualityEvalTelemetrySchema = RunLogRecordSchema.pick({
  timingsMs: true,
  tokens: true,
  estimatedCost: true,
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
