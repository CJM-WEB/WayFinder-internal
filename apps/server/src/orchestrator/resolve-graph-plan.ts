/**
 * 模块职责：在同一个 Run Scope（运行作用域）内连接 Initial Planner（初始规划器）、
 * 可选 Broad Discovery（广泛发现）与 Graph Reviser（图修订器），并只返回最终通过
 * Contract（协议）与 Graph Validator（图校验器）的完整 GraphPlan（图计划）。
 *
 * 关键边界：
 * - plan_first 不执行 Broad Discovery 或 Reviser；evidence_assisted 最多各执行一次；
 * - 所有外部调用复用同一个 Run Signal，阶段预算只取配置上限与 Run 剩余时间较小值；
 * - 仅 BroadDiscoveryError / GraphRevisionError 可保留 Initial Plan，取消与程序错误传播；
 * - 本模块不创建或释放 Deadline Scope，也不启动 Node、发送事件或构造 ResultGraph。
 */
import { GraphPlanSchema, type GraphPlan } from "@wayfinder/contracts";

import {
  GraphRevisionError,
  reviseGraphPlan,
  type GraphRevisionValidationDiagnostic,
} from "../ai/graph-reviser.js";
import {
  planOrCompactFallback,
  type GraphPlannerOutcome,
} from "../ai/graph-planner.js";
import type { GraphPlanValidationDiagnostic } from "../ai/graph-plan-parser.js";
import {
  assertBoundedLLMTimeout,
  type LLMProvider,
} from "../ai/llm-provider.js";
import { validateGraphPlan } from "../graph/graph-validator.js";
import {
  BroadDiscoveryError,
  discoverBroadEvidence,
} from "../search/broad-discovery.js";
import type { SearchProvider } from "../search/provider.js";
import type { AbsoluteRunDeadlineScope } from "./absolute-run-deadline.js";

/** 规划阶段只消费 Scope，不拥有 Timer / Listener 的释放权。 */
export type GraphPlanRunScope = Pick<
  AbsoluteRunDeadlineScope,
  "requirePositiveRemainingMs" | "signal"
>;

export type ResolveValidatedGraphPlanForRunInput = Readonly<{
  /** 已由 SearchRequestSchema trim 并校验的原始 Query。 */
  query: string;
  llmProvider: LLMProvider;
  searchProvider: SearchProvider;
  runScope: GraphPlanRunScope;
  /** Initial Planner 与 Reviser 各自调用时共用的 LLM 阶段上限。 */
  llmStageTimeoutMs: number;
  onPlannerValidationDiagnostic: (
    diagnostic: GraphPlanValidationDiagnostic,
  ) => void;
  onRevisionValidationDiagnostic: (
    diagnostic: GraphRevisionValidationDiagnostic,
  ) => void;
  onPlannerOutcome?: (outcome: GraphPlannerOutcome) => void;
  language?: string;
}>;

function throwRunReasonIfAborted(runScope: GraphPlanRunScope): void {
  if (runScope.signal.aborted) {
    throw runScope.signal.reason;
  }
}

/**
 * 最终防御门禁不再 Repair（修复）内部漂移：Planner / Reviser 已完成批准的安全修复，
 * 此处若仍无效属于程序错误，必须在未来 Node jobs 启动前终止。
 */
export function parseValidatedGraphPlanForRun(plan: unknown): GraphPlan {
  const parsed = GraphPlanSchema.safeParse(plan);
  if (!parsed.success || !validateGraphPlan(parsed.data).valid) {
    // 不附带 Zod Issue、Finding 或 Plan 内容，避免自由文本进入普通错误边界。
    throw new TypeError("Orchestrator GraphPlan 未通过最终校验");
  }
  return parsed.data;
}

/**
 * 解析一次 Run 的最终 GraphPlan。调用方必须在外层 finally 释放 runScope；返回成功
 * 即表示 WAY-63 可以安全读取 Node，但不表示本函数已经启动任何 Node 工作。
 */
export async function resolveValidatedGraphPlanForRun(
  input: ResolveValidatedGraphPlanForRunInput,
): Promise<GraphPlan> {
  assertBoundedLLMTimeout(input.llmStageTimeoutMs);

  const plannerTimeoutMs = Math.min(
    input.llmStageTimeoutMs,
    input.runScope.requirePositiveRemainingMs(),
  );
  const initialPlan = await planOrCompactFallback({
    query: input.query,
    provider: input.llmProvider,
    signal: input.runScope.signal,
    timeoutMs: plannerTimeoutMs,
    onValidationDiagnostic: input.onPlannerValidationDiagnostic,
    ...(input.onPlannerOutcome === undefined
      ? {}
      : { onOutcome: input.onPlannerOutcome }),
  });

  // 防御忽略 Signal 或在 Deadline 后才结算普通错误的 Provider，禁止迟到 fallback 前进。
  input.runScope.requirePositiveRemainingMs();

  let finalPlan = initialPlan;
  if (initialPlan.analysis.strategy === "evidence_assisted") {
    let evidence;
    try {
      evidence = await discoverBroadEvidence({
        analysis: initialPlan.analysis,
        provider: input.searchProvider,
        signal: input.runScope.signal,
        ...(input.language === undefined ? {} : { language: input.language }),
      });
    } catch (error: unknown) {
      throwRunReasonIfAborted(input.runScope);
      if (!(error instanceof BroadDiscoveryError)) {
        throw error;
      }
    }

    if (evidence !== undefined) {
      const revisionTimeoutMs = Math.min(
        input.llmStageTimeoutMs,
        input.runScope.requirePositiveRemainingMs(),
      );
      try {
        finalPlan = await reviseGraphPlan({
          query: input.query,
          initialPlan,
          evidence,
          provider: input.llmProvider,
          signal: input.runScope.signal,
          timeoutMs: revisionTimeoutMs,
          onValidationDiagnostic: input.onRevisionValidationDiagnostic,
        });
      } catch (error: unknown) {
        throwRunReasonIfAborted(input.runScope);
        if (!(error instanceof GraphRevisionError)) {
          throw error;
        }
      }
    }
  }

  // 返回值是后续 Node 启动的唯一入口；过期或无效计划都不能越过这里。
  input.runScope.requirePositiveRemainingMs();
  const validatedPlan = parseValidatedGraphPlanForRun(finalPlan);
  // Validator 是同步阶段，但仍可能跨越绝对截止时间；返回前必须再封闭这一竞态窗口。
  input.runScope.requirePositiveRemainingMs();
  return validatedPlan;
}
