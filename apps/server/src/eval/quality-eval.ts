/**
 * 模块职责：定义 WAY-86 Golden / Full Quality Eval（质量评估）的统一版本化接口，
 * 并把完整生产 Search Run 投影成可比较的本地事实工件。
 *
 * 关键边界：
 * - 本模块只处理已冻结数据集、公共 Event/ResultGraph 与内部 Run Log，不读取文件、环境或 Secret；
 * - 报告记录结构与基础事实，不设置质量阈值、总分或产品结论，避免越界实现 WAY-87；
 * - Top 3 只复制公共 Resource 投影，禁止 Provider 原始响应、Extract 正文和 Error 对象进入结果；
 * - 官方来源排名使用固定 Eval 真值，不用被测生产检测器或 sourceType 自我评分。
 */
import { createHash } from "node:crypto";

import {
  AppErrorCodeSchema,
  GraphPlanSchema,
  NodeWarningCodeSchema,
  ResourceSchema,
  StreamEventPayloadSchema,
  type ResultGraph,
  type ResultGraphNode,
  type StreamEventPayload,
} from "@wayfinder/contracts";
import { z } from "zod";

import {
  RunLogRecordSchema,
  type RunLogRecord,
} from "../observability/run-log.js";
import type { SearchStreamHandler } from "../routes/search.js";

export const QUALITY_EVAL_SCHEMA_VERSION = "quality-eval.v1" as const;
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

const QualityEvalTelemetrySchema = RunLogRecordSchema.pick({
  timingsMs: true,
  tokens: true,
  estimatedCost: true,
});

const OfficialSourceEvidenceSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("notApplicable") }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.literal("noResources"),
  }),
  z.strictObject({ status: z.literal("noneDetected") }),
  z.strictObject({
    status: z.literal("detected"),
    rank: z.number().int().min(1).max(8),
  }),
]);

const QualityEvalNodeSchema = z.strictObject({
  id: z.string().min(1),
  status: z.enum(["ready", "partial", "failed"]),
  warnings: z.array(NodeWarningCodeSchema),
  errorCode: AppErrorCodeSchema.nullable(),
  topResources: z.array(ResourceSchema).max(3),
  officialSource: OfficialSourceEvidenceSchema,
  diversity: z.strictObject({
    distinctExactDomainCount: z.number().int().min(0).max(3),
  }),
});

const DuplicateResourceSchema = z.strictObject({
  canonicalUrlFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  occurrences: z
    .array(
      z.strictObject({
        nodeId: z.string().min(1),
        rank: z.number().int().min(1).max(8),
      }),
    )
    .min(2),
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
    plan: GraphPlanSchema.nullable(),
    nodes: z.array(QualityEvalNodeSchema),
    duplicateResources: z.array(DuplicateResourceSchema),
    telemetry: QualityEvalTelemetrySchema.nullable(),
  })
  .superRefine((result, context) => {
    if (
      result.executionStatus === "completed" &&
      (result.finalStatus === null ||
        result.plan === null ||
        result.telemetry === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "completed 结果必须包含最终状态、计划与遥测",
      });
    }
    if (
      result.executionStatus !== "completed" &&
      (result.finalStatus !== null ||
        result.plan !== null ||
        result.nodes.length > 0 ||
        result.duplicateResources.length > 0)
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
  });

export type QualityEvalQueryResult = Readonly<
  z.infer<typeof QualityEvalQueryResultSchema>
>;

export type EvaluateQualityEvalQueryInput = Readonly<{
  query: QualityEvalQuery;
  runId: string;
  signal: AbortSignal;
  expectedOfficialDomains: readonly string[];
  handleSearch: SearchStreamHandler;
  readRunLog: () => RunLogRecord | undefined;
}>;

function projectRunLog(record: RunLogRecord | undefined): z.infer<
  typeof QualityEvalTelemetrySchema
> | null {
  if (record === undefined) return null;
  return QualityEvalTelemetrySchema.parse({
    timingsMs: record.timingsMs,
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
  executionStatus: "cancelled" | "unexpected_internal_error",
  telemetry: z.infer<typeof QualityEvalTelemetrySchema> | null,
): QualityEvalQueryResult {
  return QualityEvalQueryResultSchema.parse({
    ...createBaseResult(query, telemetry),
    executionStatus,
    finalStatus: null,
    errorCode: null,
    plan: null,
    nodes: [],
    duplicateResources: [],
  });
}

function readOfficialSourceEvidence(
  node: ResultGraphNode,
  expectedOfficialDomains: readonly string[],
): z.infer<typeof OfficialSourceEvidenceSchema> {
  if (expectedOfficialDomains.length === 0) {
    return { status: "notApplicable" };
  }
  if (node.resources.length === 0) {
    return { status: "unavailable", reason: "noResources" };
  }

  const officialRanks = node.resources
    .filter(resource =>
      expectedOfficialDomains.some(
        expectedDomain =>
          resource.domain === expectedDomain ||
          resource.domain.endsWith(`.${expectedDomain}`),
      ),
    )
    .map(resource => resource.rank);
  return officialRanks.length === 0
    ? { status: "noneDetected" }
    : { status: "detected", rank: Math.min(...officialRanks) };
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
 * URL 的 userinfo、query 与 fragment 可能携带凭据或跟踪标识；Eval 只保留
 * 可供人工识别与跨运行比较的 scheme、host、port 与 pathname。
 */
function redactResourceUrl(value: string): string {
  const parsed = new URL(value);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function fingerprintRedactedCanonicalUrl(value: string): string {
  return fingerprintText(redactResourceUrl(value));
}

function projectResource(
  resource: ResultGraphNode["resources"][number],
): z.infer<typeof ResourceSchema> {
  return ResourceSchema.parse({
    ...resource,
    id: `resource_${fingerprintRedactedCanonicalUrl(resource.canonicalUrl)}`,
    url: redactResourceUrl(resource.url),
    canonicalUrl: redactResourceUrl(resource.canonicalUrl),
  });
}

function projectNodes(
  result: ResultGraph,
  expectedOfficialDomains: readonly string[],
): z.infer<typeof QualityEvalNodeSchema>[] {
  return result.graph.nodes.map(node => {
    // 生产 Finalizer 已冻结展示数组顺序；这里保留其前 3 项，不能重排并掩盖顺序回归。
    const topResources = node.resources.slice(0, 3).map(projectResource);
    return QualityEvalNodeSchema.parse({
      id: node.id,
      status: node.status,
      warnings: node.warnings,
      errorCode: node.status === "failed" ? node.error.code : null,
      topResources,
      officialSource: readOfficialSourceEvidence(node, expectedOfficialDomains),
      diversity: readDiversity(topResources),
    });
  });
}

function readDuplicateResources(
  result: ResultGraph,
): z.infer<typeof DuplicateResourceSchema>[] {
  const occurrences = new Map<
    string,
    Array<{ nodeId: string; rank: number }>
  >();
  for (const node of result.graph.nodes) {
    for (const resource of node.resources) {
      const canonicalUrlFingerprint = fingerprintRedactedCanonicalUrl(
        resource.canonicalUrl,
      );
      const current = occurrences.get(canonicalUrlFingerprint) ?? [];
      current.push({
        nodeId: node.id,
        rank: resource.rank,
      });
      occurrences.set(canonicalUrlFingerprint, current);
    }
  }

  return [...occurrences.entries()]
    .filter(([, values]) => values.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([canonicalUrlFingerprint, values]) =>
      DuplicateResourceSchema.parse({
        canonicalUrlFingerprint,
        occurrences: values,
      }),
    );
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
 * 这里只定义编排事实，不计算质量通过率或其他 WAY-87 指标。
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
  try {
    await input.handleSearch({
      input: { runId: input.runId, query: input.query.query },
      signal: input.signal,
      emit: async payload => {
        payloads.push(
          structuredClone(StreamEventPayloadSchema.parse(payload)),
        );
      },
    });
  } catch {
    return createExecutionFailure(
      input.query,
      input.signal.aborted ? "cancelled" : "unexpected_internal_error",
      projectRunLog(input.readRunLog()),
    );
  }

  const telemetry = projectRunLog(input.readRunLog());
  const terminal = findSingleTerminal(payloads);
  if (terminal === null) {
    return createExecutionFailure(
      input.query,
      "unexpected_internal_error",
      telemetry,
    );
  }
  if (terminal.type === "run.failed") {
    return QualityEvalQueryResultSchema.parse({
      ...createBaseResult(input.query, telemetry),
      executionStatus: "run_failed",
      finalStatus: null,
      errorCode: terminal.error.code,
      plan: null,
      nodes: [],
      duplicateResources: [],
    });
  }

  const plans = payloads.filter(
    (
      payload,
    ): payload is Extract<StreamEventPayload, { type: "graph.plan" }> =>
      payload.type === "graph.plan",
  );
  if (plans.length !== 1 || telemetry === null) {
    return createExecutionFailure(
      input.query,
      "unexpected_internal_error",
      telemetry,
    );
  }

  const finalPlan = plans[0]?.data;
  if (finalPlan === undefined) {
    return createExecutionFailure(
      input.query,
      "unexpected_internal_error",
      telemetry,
    );
  }
  const result = terminal.data.result;
  return QualityEvalQueryResultSchema.parse({
    ...createBaseResult(input.query, telemetry),
    executionStatus: "completed",
    finalStatus: terminal.data.finalStatus,
    errorCode: null,
    plan: finalPlan,
    nodes: projectNodes(
      result,
      input.expectedOfficialDomains,
    ),
    duplicateResources: readDuplicateResources(result),
  });
}
