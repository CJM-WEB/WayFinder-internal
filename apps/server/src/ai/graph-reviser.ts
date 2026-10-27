/**
 * 模块职责：以一次有界 LLM Structured Output（结构化输出）根据 Broad Discovery
 * Evidence 修订完整 GraphPlan，并在返回前重新执行 Contract、Repair 与 Validator。
 *
 * 关键边界：
 * - 一次调用最多访问 Provider 一次，不重试、不循环，也不在本层回退 Initial GraphPlan；
 * - Initial GraphPlan 与网页 Evidence 都是不可信输入，进入 Prompt 前执行确定性白名单投影；
 * - 修订结果不得改变 `analysis`，但可以协同重建 Node、Edge、Node ID 与 SearchPlan；
 * - 只有预期普通失败转换为脱敏 GraphRevisionError；取消与未知程序错误继续传播。
 */
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";

import { GraphPlanSchema } from "@wayfinder/contracts";
import type { CandidateSearchHit, GraphPlan } from "@wayfinder/contracts";
import { z } from "zod";

import { repairGraphPlan } from "../graph/graph-repair.js";
import { validateGraphPlan } from "../graph/graph-validator.js";
import {
  GraphPlanValidationError,
  parseGraphPlanOutput,
} from "./graph-plan-parser.js";
import type { GraphPlanValidationDiagnostic } from "./graph-plan-parser.js";
import {
  assertBoundedLLMTimeout,
  LLMProviderError,
  type LLMProvider,
  type StructuredLLMInput,
} from "./llm-provider.js";
import { GRAPH_REVISER_SYSTEM_PROMPT } from "./prompts/graph-reviser.v1.js";

/** Prompt 投影上限按批准语义使用 Unicode code point（码点），不按 UTF-16 code unit。 */
export const GRAPH_REVISER_MAX_EVIDENCE_QUERY_CODE_POINTS = 200 as const;
export const GRAPH_REVISER_MAX_TITLE_CODE_POINTS = 200 as const;
export const GRAPH_REVISER_MAX_DOMAIN_CODE_POINTS = 253 as const;
export const GRAPH_REVISER_MAX_SNIPPET_CODE_POINTS = 500 as const;
export const GRAPH_REVISER_MAX_PUBLISHED_AT_CODE_POINTS = 64 as const;
export const GRAPH_REVISER_MAX_PAYLOAD_CODE_POINTS = 32_000 as const;

/** WAY-41 的 1～3 条 Query × 每条最多 5 个结果，是 Reviser 可接受的内部调用边界。 */
const GRAPH_REVISER_MAX_EVIDENCE_ITEMS = 15;

/** Provider Schema 与已提交 JSON Schema 使用相同 Zod 转换参数，Contract 仍是唯一事实来源。 */
const GRAPH_PLAN_PROVIDER_SCHEMA: Readonly<Record<string, unknown>> =
  z.toJSONSchema(GraphPlanSchema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw",
    reused: "inline",
  });

export type GraphRevisionErrorKind =
  | "analysis_changed"
  | "budget_exhausted"
  | "input_too_large"
  | "provider_failure"
  | "schema_validation_failed"
  | "semantic_validation_failed";

/**
 * 普通 Revision 失败只保留稳定分类，不保存 cause、Query、Evidence、模型输出或 Validator Finding。
 * WAY-62 只能捕获此类型回退 Initial GraphPlan，不能用宽泛 catch 吞掉程序错误。
 */
export class GraphRevisionError extends Error {
  public readonly kind: GraphRevisionErrorKind;

  public constructor(kind: GraphRevisionErrorKind) {
    super("GRAPH_REVISION_FAILED");
    this.name = "GraphRevisionError";
    this.kind = kind;
  }
}

/** Schema 诊断沿用 Parser 的脱敏结构，并额外标记本次来源，避免与 Planner 混淆。 */
export type GraphRevisionValidationDiagnostic = Readonly<{
  source: "graph_reviser";
  diagnostic: GraphPlanValidationDiagnostic;
}>;

export type ReviseGraphPlanInput = Readonly<{
  /** 已由 SearchRequestSchema trim 并校验的原始 Query。 */
  query: string;
  /** 必须是已通过 Contract 与 Graph Validator 的 evidence_assisted 初始计划。 */
  initialPlan: GraphPlan;
  /** 必须来自 WAY-41 Broad Discovery，仍按网页不可信输入处理。 */
  evidence: readonly CandidateSearchHit[];
  provider: LLMProvider;
  /** 整次 Run 统一的取消/绝对截止信号；本模块不会创建第二个 Run deadline。 */
  signal: AbortSignal;
  /** 调用方分配给 Reviser 的总阶段预算，范围为 1..30000ms。 */
  timeoutMs: number;
  /** 轻量时钟注入只用于确定性预算测试；生产默认使用单调时钟。 */
  now?: () => number;
  /** 回调异常属于程序错误并原样传播，不能被普通 Revision 失败吞掉。 */
  onValidationDiagnostic: (
    diagnostic: GraphRevisionValidationDiagnostic,
  ) => void;
}>;

type PromptEvidence = Readonly<{
  query: string;
  title: string;
  domain: string;
  snippet: string;
  publishedAt?: string | null;
}>;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * 保留指定数量的 Unicode code point；迭代时以原字符串 UTF-16 宽度累计切片位置，
 * 避免把非 BMP 字符截成无效的半个 surrogate pair（代理对）。
 */
function takeCodePoints(value: string, maximum: number): string {
  let count = 0;
  let endIndex = 0;

  for (const codePoint of value) {
    if (count >= maximum) {
      break;
    }
    count += 1;
    endIndex += codePoint.length;
  }

  return value.slice(0, endIndex);
}

/** 达到上限后立即停止计数，避免仅为拒绝超大载荷继续扫描剩余文本。 */
function exceedsCodePointLimit(value: string, maximum: number): boolean {
  let count = 0;
  const iterator = value[Symbol.iterator]();
  let iteration = iterator.next();
  while (!iteration.done) {
    count += 1;
    if (count > maximum) {
      return true;
    }
    iteration = iterator.next();
  }
  return false;
}

function readRequiredEvidenceText(
  evidence: CandidateSearchHit,
  field: "domain" | "query" | "snippet" | "title",
): string {
  const value: unknown = evidence[field];
  if (typeof value !== "string") {
    throw new TypeError("Graph Reviser Evidence 字段无效");
  }
  return value;
}

/**
 * 显式列出 Prompt 白名单；URL、Provider 标识、Rank、Score 与私有 metadata 均不会被复制。
 * 这里不改变公共 CandidateSearchHit Contract，只收紧一次 LLM 调用的内部输入面。
 */
function projectEvidence(evidence: CandidateSearchHit): PromptEvidence {
  const publishedAt: unknown = evidence.publishedAt;
  if (
    publishedAt !== undefined &&
    publishedAt !== null &&
    typeof publishedAt !== "string"
  ) {
    throw new TypeError("Graph Reviser Evidence publishedAt 无效");
  }

  return {
    query: takeCodePoints(
      readRequiredEvidenceText(evidence, "query"),
      GRAPH_REVISER_MAX_EVIDENCE_QUERY_CODE_POINTS,
    ),
    title: takeCodePoints(
      readRequiredEvidenceText(evidence, "title"),
      GRAPH_REVISER_MAX_TITLE_CODE_POINTS,
    ),
    domain: takeCodePoints(
      readRequiredEvidenceText(evidence, "domain"),
      GRAPH_REVISER_MAX_DOMAIN_CODE_POINTS,
    ),
    snippet: takeCodePoints(
      readRequiredEvidenceText(evidence, "snippet"),
      GRAPH_REVISER_MAX_SNIPPET_CODE_POINTS,
    ),
    ...(publishedAt === undefined
      ? {}
      : {
          publishedAt:
            publishedAt === null
              ? null
              : takeCodePoints(
                  publishedAt,
                  GRAPH_REVISER_MAX_PUBLISHED_AT_CODE_POINTS,
                ),
        }),
  };
}

/** 内部调用前重新确认 Initial GraphPlan 未绕过 Contract、Validator 或策略分支。 */
function parseInitialPlan(initialPlan: GraphPlan): GraphPlan {
  const parsed = GraphPlanSchema.safeParse(initialPlan);
  if (
    !parsed.success ||
    parsed.data.analysis.strategy !== "evidence_assisted" ||
    !validateGraphPlan(parsed.data).valid
  ) {
    throw new TypeError(
      "Graph Reviser 需要已验证的 evidence_assisted Initial GraphPlan",
    );
  }
  return parsed.data;
}

function createStructuredInput(
  query: string,
  initialPlan: GraphPlan,
  evidence: readonly CandidateSearchHit[],
): StructuredLLMInput {
  if (evidence.length < 1 || evidence.length > GRAPH_REVISER_MAX_EVIDENCE_ITEMS) {
    throw new TypeError("Graph Reviser Evidence 数量必须为 1 到 15");
  }

  const user = JSON.stringify({
    query,
    initialPlan,
    evidence: evidence.map(projectEvidence),
  });

  if (exceedsCodePointLimit(user, GRAPH_REVISER_MAX_PAYLOAD_CODE_POINTS)) {
    throw new GraphRevisionError("input_too_large");
  }

  return {
    system: GRAPH_REVISER_SYSTEM_PROMPT,
    user,
    schemaName: "graph_plan",
    schema: GRAPH_PLAN_PROVIDER_SCHEMA,
  };
}

function readRemainingTimeoutMs(
  deadlineAt: number,
  maximumTimeoutMs: number,
  now: () => number,
): number | null {
  const currentTime = now();
  if (!Number.isFinite(currentTime)) {
    throw new TypeError("Graph Reviser 时钟必须返回有限数字");
  }

  // ceil 保留不足 1ms 的最后预算；min 防止异常时钟回拨扩大调用方批准的阶段预算。
  const remaining = Math.min(
    maximumTimeoutMs,
    Math.ceil(deadlineAt - currentTime),
  );
  return remaining >= 1 ? remaining : null;
}

/**
 * 执行一次 Graph Revision。成功值已经满足完整 Contract 与确定性 Graph Validator；
 * 普通失败由未来 WAY-62 精确捕获，本函数绝不把 Initial GraphPlan 伪装成修订成功值。
 */
export async function reviseGraphPlan(
  input: ReviseGraphPlanInput,
): Promise<GraphPlan> {
  assertBoundedLLMTimeout(input.timeoutMs);
  throwIfAborted(input.signal);

  const now = input.now ?? (() => performance.now());
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new TypeError("Graph Reviser 时钟必须返回有限数字");
  }
  const deadlineAt = startedAt + input.timeoutMs;

  const initialPlan = parseInitialPlan(input.initialPlan);
  const structuredInput = createStructuredInput(
    input.query,
    initialPlan,
    input.evidence,
  );
  const remainingTimeoutMs = readRemainingTimeoutMs(
    deadlineAt,
    input.timeoutMs,
    now,
  );
  if (remainingTimeoutMs === null) {
    throw new GraphRevisionError("budget_exhausted");
  }

  let output: unknown;
  try {
    output = await input.provider.structured(structuredInput, {
      signal: input.signal,
      timeoutMs: remainingTimeoutMs,
    });
  } catch (error: unknown) {
    // Provider 若在取消后以其他错误结算，统一 Run reason 仍具有最高优先级。
    throwIfAborted(input.signal);
    if (isAbortError(error)) {
      throw error;
    }
    if (error instanceof LLMProviderError) {
      throw new GraphRevisionError("provider_failure");
    }
    throw error;
  }

  // 防御忽略 Signal 或自身 timeout、却在取消/超预算后返回成功值的 Provider。
  throwIfAborted(input.signal);
  if (
    readRemainingTimeoutMs(deadlineAt, input.timeoutMs, now) === null
  ) {
    throw new GraphRevisionError("budget_exhausted");
  }

  let revisedPlan: GraphPlan;
  try {
    revisedPlan = parseGraphPlanOutput(output);
  } catch (error: unknown) {
    if (error instanceof GraphPlanValidationError) {
      input.onValidationDiagnostic({
        source: "graph_reviser",
        diagnostic: error.diagnostic,
      });
      throw new GraphRevisionError("schema_validation_failed");
    }
    throw error;
  }

  if (!isDeepStrictEqual(revisedPlan.analysis, initialPlan.analysis)) {
    throw new GraphRevisionError("analysis_changed");
  }

  const repaired = repairGraphPlan(revisedPlan);
  if (!repaired.validation.valid) {
    throw new GraphRevisionError("semantic_validation_failed");
  }

  return repaired.plan;
}
