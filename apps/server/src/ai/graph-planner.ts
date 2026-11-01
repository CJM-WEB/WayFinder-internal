/**
 * 模块职责：用一次有界 LLM Structured Output 生成第一阶段 GraphOutline（图轮廓）。
 *
 * 关键边界：
 * - 每次调用只访问 Provider 一次，不重试、不 repair，也不生成 compact/raw-query fallback；
 * - Provider 输出先经过内部严格 Schema，再经过确定性 Outline Validator；
 * - 取消与未知程序错误原样传播，预期规划失败只保留稳定、脱敏的分类。
 */
import { performance } from "node:perf_hooks";

import type { SearchLanguage } from "@wayfinder/contracts";
import { z } from "zod";

import { validateGraphOutline } from "../graph/graph-validator.js";
import {
  GraphOutlineSchema,
  GraphOutlineValidationError,
  parseGraphOutlineOutput,
  type GraphOutline,
  type GraphOutlineValidationDiagnostic,
} from "./graph-outline.js";
import {
  assertBoundedLLMTimeout,
  LLMProviderError,
  type LLMProvider,
  type StructuredLLMInput,
} from "./llm-provider.js";
import { GRAPH_PLANNER_SYSTEM_PROMPT } from "./prompts/graph-planner.v3.js";
import { appendTargetLanguageSystemInstruction } from "./prompts/target-language-system-instruction.js";

const GRAPH_OUTLINE_PROVIDER_SCHEMA: Readonly<Record<string, unknown>> =
  z.toJSONSchema(GraphOutlineSchema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw",
    reused: "inline",
  });

export type GraphPlannerErrorKind =
  | "budget_exhausted"
  | "provider_failure"
  | "schema_validation_failed"
  | "semantic_validation_failed";

/** 规划失败不携带 Query、模型输出、Provider 响应或 Validator Finding。 */
export class GraphPlannerError extends Error {
  public readonly kind: GraphPlannerErrorKind;

  public constructor(kind: GraphPlannerErrorKind) {
    super("GRAPH_PLANNER_FAILED");
    this.name = "GraphPlannerError";
    this.kind = kind;
  }
}

export type PlanGraphOutlineInput = Readonly<{
  /** 已由 SearchRequestSchema trim 并校验的原始 Query。 */
  query: string;
  /** 冻结于本次 Run，用于约束 Analysis 与 Node 自产文本。 */
  language: SearchLanguage;
  provider: LLMProvider;
  /** 整次 Run 共享的取消/绝对截止 Signal。 */
  signal: AbortSignal;
  /** 调用方分配的单阶段预算，范围为 1..30000ms。 */
  timeoutMs: number;
  /** 仅供确定性预算测试；生产使用单调时钟。 */
  now?: () => number;
  /** 回调异常属于程序错误，必须原样传播。 */
  onValidationDiagnostic: (
    diagnostic: GraphOutlineValidationDiagnostic,
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
    throw new TypeError("Graph Planner 时钟必须返回有限数字");
  }

  // ceil 保留不足 1ms 的预算；min 防止异常时钟回拨扩大已批准上限。
  const remaining = Math.min(
    maximumTimeoutMs,
    Math.ceil(deadlineAt - currentTime),
  );
  return remaining >= 1 ? remaining : null;
}

function createStructuredInput(
  query: string,
  language: SearchLanguage,
): StructuredLLMInput {
  return {
    system: appendTargetLanguageSystemInstruction(
      GRAPH_PLANNER_SYSTEM_PROMPT,
      language,
    ),
    user: query,
    schemaName: "graph_outline",
    schema: GRAPH_OUTLINE_PROVIDER_SCHEMA,
  };
}

/** 返回值已通过内部 Schema 与全部确定性图结构规则。 */
export async function planGraphOutline(
  input: PlanGraphOutlineInput,
): Promise<GraphOutline> {
  assertBoundedLLMTimeout(input.timeoutMs);
  throwIfAborted(input.signal);

  const now = input.now ?? (() => performance.now());
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new TypeError("Graph Planner 时钟必须返回有限数字");
  }
  const deadlineAt = startedAt + input.timeoutMs;
  const timeoutMs = readRemainingTimeoutMs(
    deadlineAt,
    input.timeoutMs,
    now,
  );
  if (timeoutMs === null) {
    throw new GraphPlannerError("budget_exhausted");
  }

  let output: unknown;
  try {
    output = await input.provider.structured(
      createStructuredInput(input.query, input.language),
      { signal: input.signal, timeoutMs },
    );
  } catch (error: unknown) {
    // 父 Signal 的 reason 比 Provider 的迟到包装错误优先级更高。
    throwIfAborted(input.signal);
    if (isAbortError(error)) {
      throw error;
    }
    if (error instanceof LLMProviderError) {
      throw new GraphPlannerError("provider_failure");
    }
    throw error;
  }

  throwIfAborted(input.signal);
  if (readRemainingTimeoutMs(deadlineAt, input.timeoutMs, now) === null) {
    throw new GraphPlannerError("budget_exhausted");
  }

  let outline: GraphOutline;
  try {
    outline = parseGraphOutlineOutput(output);
  } catch (error: unknown) {
    if (error instanceof GraphOutlineValidationError) {
      input.onValidationDiagnostic(error.diagnostic);
      throw new GraphPlannerError("schema_validation_failed");
    }
    throw error;
  }

  if (!validateGraphOutline(outline).valid) {
    throw new GraphPlannerError("semantic_validation_failed");
  }
  return outline;
}
