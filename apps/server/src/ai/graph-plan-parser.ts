/**
 * 模块职责：把 LLMProvider 返回的未知结构收窄为受公共 Contract 保护的 GraphPlan。
 *
 * 安全边界：
 * - 只接受已经由 Provider Structured Output 解码出的值，不从字符串或 Markdown 中提取 JSON。
 * - 失败诊断仅保留白名单化的 issue code/path，并限制数量与路径长度。
 * - 不保存原始模型输出、Zod message、cause，也不执行 Graph 语义修复。
 */
import { GraphPlanSchema } from "@wayfinder/contracts";
import type { GraphPlan } from "@wayfinder/contracts";

export const MAX_GRAPH_PLAN_VALIDATION_ISSUES = 8 as const;
export const MAX_GRAPH_PLAN_VALIDATION_PATH_SEGMENTS = 8 as const;
export const MAX_GRAPH_PLAN_VALIDATION_PATH_SEGMENT_LENGTH = 64 as const;

const GRAPH_PLAN_PATH_FIELDS = new Set([
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
  "searchPlan",
  "status",
  "queries",
  "rankingProfile",
  "providerHints",
  "source",
  "target",
  "type",
]);

type ValidationSourceIssue = Readonly<{
  code: string;
  path: readonly PropertyKey[];
}>;

export type GraphPlanValidationIssueDiagnostic = Readonly<{
  code: string;
  path: readonly string[];
  pathTruncated: boolean;
}>;

export type GraphPlanValidationDiagnostic = Readonly<{
  stage: "graph_plan_schema_validation";
  issueCount: number;
  issues: readonly GraphPlanValidationIssueDiagnostic[];
  truncated: boolean;
}>;

/** 未知路径段可能源自不可信输入，因此只公开固定字段名或数组下标。 */
function sanitizePathSegment(segment: PropertyKey): string {
  if (typeof segment === "number" && Number.isSafeInteger(segment)) {
    return String(segment).slice(
      0,
      MAX_GRAPH_PLAN_VALIDATION_PATH_SEGMENT_LENGTH,
    );
  }

  if (typeof segment === "string" && GRAPH_PLAN_PATH_FIELDS.has(segment)) {
    return segment.slice(0, MAX_GRAPH_PLAN_VALIDATION_PATH_SEGMENT_LENGTH);
  }

  return "[redacted]";
}

/**
 * Zod issue 可能包含输入值、未知字段名和详细英文文案；这里只复制稳定白名单。
 * 截断发生在错误离开解析边界之前，避免后续日志意外放大模型输出。
 */
function createValidationDiagnostic(
  sourceIssues: readonly ValidationSourceIssue[],
): GraphPlanValidationDiagnostic {
  const issues = sourceIssues
    .slice(0, MAX_GRAPH_PLAN_VALIDATION_ISSUES)
    .map(issue => ({
      code: issue.code,
      path: issue.path
        .slice(0, MAX_GRAPH_PLAN_VALIDATION_PATH_SEGMENTS)
        .map(sanitizePathSegment),
      pathTruncated:
        issue.path.length > MAX_GRAPH_PLAN_VALIDATION_PATH_SEGMENTS,
    }));

  return {
    stage: "graph_plan_schema_validation",
    issueCount: sourceIssues.length,
    issues,
    truncated: sourceIssues.length > issues.length,
  };
}

/** 供后续 Run Log 消费的结构化、可序列化且已脱敏的内部错误。 */
export class GraphPlanValidationError extends Error {
  public readonly kind = "schema_validation_failed" as const;
  public readonly diagnostic: GraphPlanValidationDiagnostic;

  public constructor(diagnostic: GraphPlanValidationDiagnostic) {
    super("GraphPlan 输出未通过结构校验");
    this.name = "GraphPlanValidationError";
    this.diagnostic = diagnostic;
  }
}

/**
 * Provider 输出只能在这里由 unknown 收窄；成功值直接来自 Zod，禁止 `as GraphPlan`。
 * Node/Edge ID、端点、DAG 与连通性属于后续 Graph Validator，不在此处修复。
 */
export function parseGraphPlanOutput(output: unknown): GraphPlan {
  const result = GraphPlanSchema.safeParse(output);

  if (!result.success) {
    throw new GraphPlanValidationError(
      createValidationDiagnostic(result.error.issues),
    );
  }

  return result.data;
}
