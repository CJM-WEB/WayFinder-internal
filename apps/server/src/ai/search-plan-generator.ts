/**
 * 模块职责：一次性生成全图 SearchPlanBundle，并确定性装配公共 GraphPlan。
 *
 * 关键边界：
 * - LLM 只决定 nodeId、单条 Query 与 rankingProfile；预算和 Provider Hint 由代码补齐；
 * - Bundle 必须与 Final Outline Node ID 双射，所有 Query 在全图范围精确唯一；
 * - 不做模糊相似度判断、repair、重试或 fallback；任一失败都在 GraphPlan 发布前结束。
 */
import { performance } from "node:perf_hooks";

import {
  calculateSearchPlanMaxResults,
  GraphPlanSchema,
  RankingProfileSchema,
  type GraphPlan,
  type SearchLanguage,
} from "@wayfinder/contracts";
import { z } from "zod";

import { validateGraphOutline, validateGraphPlan } from "../graph/graph-validator.js";
import {
  GraphOutlineSchema,
  type GraphOutline,
} from "./graph-outline.js";
import {
  assertBoundedLLMTimeout,
  LLMProviderError,
  type LLMProvider,
  type StructuredLLMInput,
} from "./llm-provider.js";
import { SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT } from "./prompts/search-plan-generator.v2.js";

export const SearchPlanBundleItemSchema = z.strictObject({
  nodeId: z.string().min(1),
  // 生产生成边界固定单 Query；公共 SearchPlan Contract 仍兼容历史 1～3 条。
  queries: z.array(z.string().min(1)).length(1),
  rankingProfile: RankingProfileSchema,
});

export const SearchPlanBundleSchema = z.strictObject({
  plans: z.array(SearchPlanBundleItemSchema).min(1).max(8),
});
export type SearchPlanBundle = z.infer<typeof SearchPlanBundleSchema>;

const SEARCH_PLAN_BUNDLE_PROVIDER_SCHEMA: Readonly<Record<string, unknown>> =
  z.toJSONSchema(SearchPlanBundleSchema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw",
    reused: "inline",
  });

export type SearchPlanGenerationErrorKind =
  | "budget_exhausted"
  | "duplicate_query"
  | "empty_query"
  | "final_graph_invalid"
  | "invalid_outline"
  | "node_mapping_invalid"
  | "provider_failure"
  | "schema_validation_failed";

export class SearchPlanGenerationError extends Error {
  public readonly kind: SearchPlanGenerationErrorKind;

  public constructor(kind: SearchPlanGenerationErrorKind) {
    super("SEARCH_PLAN_GENERATION_FAILED");
    this.name = "SearchPlanGenerationError";
    this.kind = kind;
  }
}

export type SearchPlanBundleValidationDiagnostic = Readonly<{
  stage: "search_plan_bundle_schema_validation";
  issueCount: number;
  truncated: boolean;
}>;

export type GenerateSearchPlanBundleInput = Readonly<{
  query: string;
  language: SearchLanguage;
  outline: GraphOutline;
  provider: LLMProvider;
  signal: AbortSignal;
  timeoutMs: number;
  now?: () => number;
  onValidationDiagnostic: (
    diagnostic: SearchPlanBundleValidationDiagnostic,
  ) => void;
}>;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function readRemainingTimeoutMs(
  deadlineAt: number,
  maximumTimeoutMs: number,
  now: () => number,
): number | null {
  const currentTime = now();
  if (!Number.isFinite(currentTime)) {
    throw new TypeError("SearchPlan Generator 时钟必须返回有限数字");
  }
  const remaining = Math.min(
    maximumTimeoutMs,
    Math.ceil(deadlineAt - currentTime),
  );
  return remaining >= 1 ? remaining : null;
}

/**
 * Query 精确比较键严格执行批准顺序；toLowerCase 不读取运行机器 Locale。
 * 语义相似但字面不同的判断只属于 Prompt 与 Golden/Human Eval。
 */
export function normalizeSearchPlanQueryKey(query: string): string {
  return query
    .normalize("NFKC")
    // ECMAScript trim 不包含 Unicode White_Space 的 U+0085，因此显式使用属性匹配。
    .replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "")
    .replace(/\p{White_Space}+/gu, " ")
    .toLowerCase();
}

function parseValidatedOutline(outline: GraphOutline): GraphOutline {
  const parsed = GraphOutlineSchema.safeParse(outline);
  if (!parsed.success || !validateGraphOutline(parsed.data).valid) {
    throw new SearchPlanGenerationError("invalid_outline");
  }
  return parsed.data;
}

/** 同一个双射/Query 门禁同时服务 LLM 输出和防御性装配入口。 */
function assertBundleMatchesOutline(
  outline: GraphOutline,
  bundle: SearchPlanBundle,
): void {
  const outlineNodeIds = new Set(outline.nodes.map(node => node.id));
  const seenNodeIds = new Set<string>();
  const seenQueryKeys = new Set<string>();

  for (const plan of bundle.plans) {
    if (!outlineNodeIds.has(plan.nodeId) || seenNodeIds.has(plan.nodeId)) {
      throw new SearchPlanGenerationError("node_mapping_invalid");
    }
    seenNodeIds.add(plan.nodeId);

    for (const query of plan.queries) {
      const key = normalizeSearchPlanQueryKey(query);
      if (key.length === 0) {
        throw new SearchPlanGenerationError("empty_query");
      }
      if (seenQueryKeys.has(key)) {
        throw new SearchPlanGenerationError("duplicate_query");
      }
      seenQueryKeys.add(key);
    }
  }

  if (
    seenNodeIds.size !== outlineNodeIds.size ||
    bundle.plans.length !== outline.nodes.length
  ) {
    throw new SearchPlanGenerationError("node_mapping_invalid");
  }
}

function createStructuredInput(
  query: string,
  language: SearchLanguage,
  outline: GraphOutline,
): StructuredLLMInput {
  return {
    system: SEARCH_PLAN_GENERATOR_SYSTEM_PROMPT,
    user: JSON.stringify({ query, language, outline }),
    schemaName: "search_plan_bundle",
    schema: SEARCH_PLAN_BUNDLE_PROVIDER_SCHEMA,
  };
}

/** 返回值已通过内部 Schema、Node 双射和全图 Query 精确唯一门禁。 */
export async function generateSearchPlanBundle(
  input: GenerateSearchPlanBundleInput,
): Promise<SearchPlanBundle> {
  assertBoundedLLMTimeout(input.timeoutMs);
  throwIfAborted(input.signal);
  const outline = parseValidatedOutline(input.outline);

  const now = input.now ?? (() => performance.now());
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new TypeError("SearchPlan Generator 时钟必须返回有限数字");
  }
  const deadlineAt = startedAt + input.timeoutMs;
  const timeoutMs = readRemainingTimeoutMs(
    deadlineAt,
    input.timeoutMs,
    now,
  );
  if (timeoutMs === null) {
    throw new SearchPlanGenerationError("budget_exhausted");
  }

  let output: unknown;
  try {
    output = await input.provider.structured(
      createStructuredInput(input.query, input.language, outline),
      { signal: input.signal, timeoutMs },
    );
  } catch (error: unknown) {
    throwIfAborted(input.signal);
    if (isAbortError(error)) {
      throw error;
    }
    if (error instanceof LLMProviderError) {
      throw new SearchPlanGenerationError("provider_failure");
    }
    throw error;
  }

  throwIfAborted(input.signal);
  if (readRemainingTimeoutMs(deadlineAt, input.timeoutMs, now) === null) {
    throw new SearchPlanGenerationError("budget_exhausted");
  }

  const parsed = SearchPlanBundleSchema.safeParse(output);
  if (!parsed.success) {
    input.onValidationDiagnostic({
      stage: "search_plan_bundle_schema_validation",
      issueCount: parsed.error.issues.length,
      truncated: parsed.error.issues.length > 8,
    });
    throw new SearchPlanGenerationError("schema_validation_failed");
  }

  assertBundleMatchesOutline(outline, parsed.data);
  return parsed.data;
}

/**
 * 按 Outline 顺序装配公共 GraphPlan；模型输出顺序不能改变用户可见 Graph 顺序。
 * 最终仍执行公共 Schema 与 Graph Validator，防止内部 Contract 漂移。
 */
export function assembleGraphPlan(
  outlineInput: GraphOutline,
  bundleInput: SearchPlanBundle,
): GraphPlan {
  const outline = parseValidatedOutline(outlineInput);
  const bundle = SearchPlanBundleSchema.parse(bundleInput);
  assertBundleMatchesOutline(outline, bundle);
  const planByNodeId = new Map(bundle.plans.map(plan => [plan.nodeId, plan]));

  const candidate = {
    analysis: outline.analysis,
    nodes: outline.nodes.map(node => {
      const plan = planByNodeId.get(node.id);
      if (plan === undefined) {
        throw new SearchPlanGenerationError("node_mapping_invalid");
      }
      return {
        ...node,
        searchPlan: {
          queries: plan.queries,
          maxResults: calculateSearchPlanMaxResults(plan.queries.length),
          rankingProfile: plan.rankingProfile,
          providerHints: ["general"],
        },
      };
    }),
    edges: outline.edges,
  };

  const parsed = GraphPlanSchema.safeParse(candidate);
  if (!parsed.success || !validateGraphPlan(parsed.data).valid) {
    throw new SearchPlanGenerationError("final_graph_invalid");
  }
  return parsed.data;
}
