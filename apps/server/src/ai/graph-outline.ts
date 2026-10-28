/**
 * 模块职责：定义两阶段规划第一阶段使用的内部 GraphOutline（图轮廓）边界。
 *
 * 关键约束：
 * - 复用公共 GraphPlan 的 Analysis、Node 与 Edge 字段定义，只移除 searchPlan；
 * - Schema 保持严格，禁止模型提前混入第二阶段字段或未声明字段；
 * - 本类型只存在于 Server 内部，不导出到公共 Contract 或 Streaming Event。
 */
import {
  GraphEdgeSchema,
  GraphPlanNodeSchema,
  QueryAnalysisSchema,
} from "@wayfinder/contracts";
import { z } from "zod";

/** Outline Node 保留公共计划节点身份与 planned 状态，但尚未包含检索计划。 */
export const GraphOutlineNodeSchema = GraphPlanNodeSchema.omit({
  searchPlan: true,
});
export type GraphOutlineNode = z.infer<typeof GraphOutlineNodeSchema>;

/**
 * GraphOutline 是第一阶段 LLM 唯一允许返回的根对象。
 * 跨 Node / Edge 的 ID、DAG、数量与连通性继续由确定性 Validator 负责。
 */
export const GraphOutlineSchema = z.strictObject({
  analysis: QueryAnalysisSchema,
  nodes: z.array(GraphOutlineNodeSchema).min(1).max(8),
  edges: z.array(GraphEdgeSchema),
});
export type GraphOutline = z.infer<typeof GraphOutlineSchema>;

export const MAX_GRAPH_OUTLINE_VALIDATION_ISSUES = 8 as const;
const MAX_GRAPH_OUTLINE_PATH_SEGMENTS = 8;
const MAX_GRAPH_OUTLINE_PATH_SEGMENT_LENGTH = 64;

const GRAPH_OUTLINE_PATH_FIELDS = new Set([
  "analysis",
  "nodes",
  "edges",
  "intent",
  "topic",
  "freshnessSensitive",
  "ambiguityLevel",
  "broadSearchQueries",
  "strategy",
  "presentationMode",
  "id",
  "title",
  "description",
  "nodeType",
  "layer",
  "status",
  "source",
  "target",
  "type",
]);

export type GraphOutlineValidationIssueDiagnostic = Readonly<{
  code: string;
  path: readonly string[];
  pathTruncated: boolean;
}>;

/** 诊断只包含稳定 Schema 事实，不复制模型输出、字段值或 Zod 文案。 */
export type GraphOutlineValidationDiagnostic = Readonly<{
  stage: "graph_outline_schema_validation";
  issueCount: number;
  issues: readonly GraphOutlineValidationIssueDiagnostic[];
  truncated: boolean;
}>;

function sanitizePathSegment(segment: PropertyKey): string {
  if (typeof segment === "number" && Number.isSafeInteger(segment)) {
    return String(segment).slice(0, MAX_GRAPH_OUTLINE_PATH_SEGMENT_LENGTH);
  }
  if (typeof segment === "string" && GRAPH_OUTLINE_PATH_FIELDS.has(segment)) {
    return segment.slice(0, MAX_GRAPH_OUTLINE_PATH_SEGMENT_LENGTH);
  }
  return "[redacted]";
}

function createValidationDiagnostic(
  issues: readonly Readonly<{
    code: string;
    path: readonly PropertyKey[];
  }>[],
): GraphOutlineValidationDiagnostic {
  const projectedIssues = issues
    .slice(0, MAX_GRAPH_OUTLINE_VALIDATION_ISSUES)
    .map(issue => ({
      code: issue.code,
      path: issue.path
        .slice(0, MAX_GRAPH_OUTLINE_PATH_SEGMENTS)
        .map(sanitizePathSegment),
      pathTruncated: issue.path.length > MAX_GRAPH_OUTLINE_PATH_SEGMENTS,
    }));

  return {
    stage: "graph_outline_schema_validation",
    issueCount: issues.length,
    issues: projectedIssues,
    truncated: issues.length > projectedIssues.length,
  };
}

/** Provider 输出不可信；错误对象不得保留原始输出或 cause。 */
export class GraphOutlineValidationError extends Error {
  public readonly diagnostic: GraphOutlineValidationDiagnostic;

  public constructor(diagnostic: GraphOutlineValidationDiagnostic) {
    super("GraphOutline 输出未通过结构校验");
    this.name = "GraphOutlineValidationError";
    this.diagnostic = diagnostic;
  }
}

/** 将 Structured Output 的 unknown 结果收窄为内部 GraphOutline。 */
export function parseGraphOutlineOutput(output: unknown): GraphOutline {
  const parsed = GraphOutlineSchema.safeParse(output);
  if (!parsed.success) {
    throw new GraphOutlineValidationError(
      createValidationDiagnostic(parsed.error.issues),
    );
  }
  return parsed.data;
}
