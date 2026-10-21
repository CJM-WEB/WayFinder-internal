/**
 * 模块职责：执行 Graph Planner（图规划器）的唯一一次有界结构重试，并在普通失败时
 * 生成可继续真实搜索的 deterministic compact fallback（确定性紧凑降级计划）。
 *
 * 关键边界：
 * - 首次调用与唯一一次重试共享同一个 Planner 阶段预算和父 AbortSignal。
 * - 只有结构输出失败可以重试；普通 Provider 错误直接 fallback。
 * - 所有 Schema-valid 输出统一经过现有确定性 Repair；不采信失败输出的局部字段。
 * - Abort、Run deadline 与未知程序错误必须原样终止，不能伪装成成功 fallback。
 */
import { performance } from "node:perf_hooks";

import {
  calculateSearchPlanMaxResults,
  GraphPlanSchema,
} from "@wayfinder/contracts";
import type { GraphPlan } from "@wayfinder/contracts";
import { z } from "zod";

import { repairGraphPlan } from "../graph/graph-repair.js";
import { validateGraphPlan } from "../graph/graph-validator.js";
import {
  GraphPlanValidationError,
  parseGraphPlanOutput,
} from "./graph-plan-parser.js";
import {
  assertBoundedLLMTimeout,
  LLMProviderError,
  type LLMProvider,
  type StructuredLLMInput,
} from "./llm-provider.js";
import { GRAPH_PLANNER_SYSTEM_PROMPT } from "./prompts/graph-planner.v1.js";

/** Provider Schema 与已提交 JSON Schema 使用相同 Zod 转换参数，仍以 Contract 为唯一事实来源。 */
const GRAPH_PLAN_PROVIDER_SCHEMA: Readonly<Record<string, unknown>> =
  z.toJSONSchema(GraphPlanSchema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw",
    reused: "inline",
  });

type PlannerAttemptOutcome =
  | Readonly<{ kind: "success"; plan: GraphPlan }>
  | Readonly<{
      kind:
        | "budget_exhausted"
        | "provider_failure"
        | "semantic_failure"
        | "structural_failure";
    }>;

export type PlanOrCompactFallbackInput = Readonly<{
  /** 已由 SearchRequestSchema trim 并校验的原始 Query。 */
  query: string;
  provider: LLMProvider;
  /** 整次 Run 共用的父取消信号；deadline 也必须通过此 Signal 传播。 */
  signal: AbortSignal;
  /** 首次调用与重试共享的 Planner 总阶段预算，最大 15 秒。 */
  timeoutMs: number;
  /** 轻量时钟注入只用于确定性预算测试；生产默认使用单调时钟。 */
  now?: () => number;
}>;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createStructuredInput(query: string): StructuredLLMInput {
  return {
    system: GRAPH_PLANNER_SYSTEM_PROMPT,
    user: query,
    schemaName: "graph_plan",
    schema: GRAPH_PLAN_PROVIDER_SCHEMA,
  };
}

/**
 * fallback 字段全部来自人员确认的固定语义；不从失败模型输出中保留 Analysis 或文案，
 * 防止半可信内容改变 freshness、ranking 或后续 Orchestrator 分支。
 */
function createCompactFallback(query: string): GraphPlan {
  const fallback = GraphPlanSchema.parse({
    analysis: {
      intent: "mixed",
      topic: query,
      freshnessSensitive: false,
      ambiguityLevel: "low",
      broadSearchQueries: [],
      strategy: "plan_first",
      presentationMode: "compact",
    },
    nodes: [
      {
        id: "compact-fallback",
        title: query,
        description: query,
        nodeType: "primary",
        layer: 0,
        searchPlan: {
          queries: [query],
          maxResults: calculateSearchPlanMaxResults(1),
          rankingProfile: "general",
          providerHints: ["general"],
        },
        status: "planned",
      },
    ],
    edges: [],
  });

  // Contract 漂移不能把无效 fallback 伪装成成功；这种情况属于程序错误并应显式暴露。
  if (!validateGraphPlan(fallback).valid) {
    throw new Error("compact fallback 未通过 Graph Validator");
  }

  return fallback;
}

function readRemainingTimeoutMs(
  deadlineAt: number,
  maximumTimeoutMs: number,
  now: () => number,
): number | null {
  const currentTime = now();
  if (!Number.isFinite(currentTime)) {
    throw new TypeError("Planner 时钟必须返回有限数字");
  }

  // ceil 保留不足 1ms 的最后预算；上限防止测试时钟或系统墙钟回拨扩大阶段预算。
  const remaining = Math.min(
    maximumTimeoutMs,
    Math.ceil(deadlineAt - currentTime),
  );
  return remaining >= 1 ? remaining : null;
}

async function runPlannerAttempt(
  provider: LLMProvider,
  structuredInput: StructuredLLMInput,
  signal: AbortSignal,
  deadlineAt: number,
  maximumTimeoutMs: number,
  now: () => number,
): Promise<PlannerAttemptOutcome> {
  throwIfAborted(signal);
  const timeoutMs = readRemainingTimeoutMs(
    deadlineAt,
    maximumTimeoutMs,
    now,
  );
  if (timeoutMs === null) {
    return { kind: "budget_exhausted" };
  }

  let output: unknown;
  try {
    output = await provider.structured(structuredInput, {
      signal,
      timeoutMs,
    });
  } catch (error: unknown) {
    // Provider 若在取消后仍以其他错误结算，父 Signal reason 仍具有最高优先级。
    throwIfAborted(signal);
    if (isAbortError(error)) {
      throw error;
    }
    if (error instanceof LLMProviderError) {
      return {
        kind:
          error.kind === "invalid_response"
            ? "structural_failure"
            : "provider_failure",
      };
    }
    throw error;
  }

  // 防御忽略 AbortSignal、却在取消后返回成功值的 Provider 实现。
  throwIfAborted(signal);
  // Provider 即使忽略自身 timeout 并晚返回，也不能突破 Planner 阶段硬预算。
  if (
    readRemainingTimeoutMs(deadlineAt, maximumTimeoutMs, now) === null
  ) {
    return { kind: "budget_exhausted" };
  }

  let plan: GraphPlan;
  try {
    plan = parseGraphPlanOutput(output);
  } catch (error: unknown) {
    if (error instanceof GraphPlanValidationError) {
      return { kind: "structural_failure" };
    }
    throw error;
  }

  const repaired = repairGraphPlan(plan);
  if (!repaired.validation.valid) {
    return { kind: "semantic_failure" };
  }

  return { kind: "success", plan: repaired.plan };
}

/**
 * 执行 Planner，并只允许结构失败触发一次同输入重试。
 * 任何返回的 fallback 仍只是待执行 GraphPlan，后续必须由真实 Search Pipeline 获取网页。
 */
export async function planOrCompactFallback(
  input: PlanOrCompactFallbackInput,
): Promise<GraphPlan> {
  assertBoundedLLMTimeout(input.timeoutMs);
  throwIfAborted(input.signal);

  const now = input.now ?? (() => performance.now());
  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new TypeError("Planner 时钟必须返回有限数字");
  }

  const deadlineAt = startedAt + input.timeoutMs;
  const structuredInput = createStructuredInput(input.query);
  const first = await runPlannerAttempt(
    input.provider,
    structuredInput,
    input.signal,
    deadlineAt,
    input.timeoutMs,
    now,
  );

  if (first.kind === "success") {
    return first.plan;
  }

  if (first.kind === "structural_failure") {
    const second = await runPlannerAttempt(
      input.provider,
      structuredInput,
      input.signal,
      deadlineAt,
      input.timeoutMs,
      now,
    );
    if (second.kind === "success") {
      return second.plan;
    }
  }

  // fallback 虽然不发外部请求，仍不得在用户取消或 Run deadline 后启动新工作。
  throwIfAborted(input.signal);
  return createCompactFallback(input.query);
}
