/**
 * 模块职责：在同一个 Run Scope 内执行失败关闭的两阶段规划并返回完整 GraphPlan。
 *
 * 执行顺序：Graph Planner → Initial Outline 校验 → 可选 Broad/Reviser → Final Outline
 * 校验 → 一次全图 SearchPlan Generation → 确定性装配 → Final GraphPlan 校验。
 * 任一阶段失败都不会保留旧计划、repair、重试或生成 compact/raw-query fallback。
 */
import {
  GraphPlanSchema,
  type AppError,
  type AppErrorCode,
  type GraphPlan,
  type SearchLanguage,
  type SearchEngine,
} from "@wayfinder/contracts";

import {
  GraphOutlineSchema,
  type GraphOutline,
  type GraphOutlineValidationDiagnostic,
} from "../ai/graph-outline.js";
import {
  GraphPlannerError,
  planGraphOutline,
} from "../ai/graph-planner.js";
import {
  GraphRevisionError,
  reviseGraphOutline,
  type GraphRevisionValidationDiagnostic,
} from "../ai/graph-reviser.js";
import {
  SearchPlanGenerationError,
  assembleGraphPlan,
  generateSearchPlanBundle,
  type SearchPlanBundleValidationDiagnostic,
} from "../ai/search-plan-generator.js";
import {
  assertBoundedLLMTimeout,
  type LLMProvider,
} from "../ai/llm-provider.js";
import {
  validateGraphOutline,
  validateGraphPlan,
} from "../graph/graph-validator.js";
import {
  BroadDiscoveryError,
  discoverBroadEvidence,
} from "../search/broad-discovery.js";
import type { SearchProvider } from "../search/provider.js";
import type { AbsoluteRunDeadlineScope } from "./absolute-run-deadline.js";

export type GraphPlanRunScope = Pick<
  AbsoluteRunDeadlineScope,
  "requirePositiveRemainingMs" | "signal"
>;

/** GraphPlan 发布前的预期失败只暴露公共 AppError，不保留阶段输入或原始 cause。 */
export class GraphPlanResolutionError extends Error {
  public readonly appError: AppError;

  public constructor(appError: AppError) {
    super("GRAPH_PLAN_RESOLUTION_FAILED");
    this.name = "GraphPlanResolutionError";
    this.appError = appError;
  }
}

export type ResolveValidatedGraphPlanForRunInput = Readonly<{
  query: string;
  llmProvider: LLMProvider;
  searchProvider: SearchProvider;
  runScope: GraphPlanRunScope;
  /** Planner、Reviser、Generator 分别使用此阶段上限与 Run 剩余时间的较小值。 */
  llmStageTimeoutMs: number;
  onPlannerValidationDiagnostic: (
    diagnostic: GraphOutlineValidationDiagnostic,
  ) => void;
  onRevisionValidationDiagnostic: (
    diagnostic: GraphRevisionValidationDiagnostic,
  ) => void;
  onSearchPlanValidationDiagnostic: (
    diagnostic: SearchPlanBundleValidationDiagnostic,
  ) => void;
  /** 仅记录阶段边界；异常必须 fail-open，且不得接收 Outline / Bundle 内容。 */
  onGraphOutlinePlanningFinished?: () => void;
  onSearchPlanPlanningFinished?: () => void;
  /** 只传递脱敏阶段与稳定 Code；观察器异常必须 fail-open。 */
  onPlanningStageFailed?: (
    stage: "graphOutline" | "searchPlan",
    code: AppErrorCode,
  ) => void;
  language: SearchLanguage;
  engine?: SearchEngine;
}>;

function createResolutionError(
  code: AppError["code"],
  retryable: boolean,
): GraphPlanResolutionError {
  return new GraphPlanResolutionError({ code, retryable });
}

function notifyPlanningObserver(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Run Log 等可观测性旁路不能改变规划结果或错误语义。
  }
}

function notifyPlanningFailure(
  callback: ResolveValidatedGraphPlanForRunInput["onPlanningStageFailed"],
  stage: "graphOutline" | "searchPlan",
  code: AppErrorCode,
): void {
  try {
    callback?.(stage, code);
  } catch {
    // 失败分类日志与阶段计时一样不能改变业务语义。
  }
}

/** 只映射已知阶段错误；诊断观察器与未知程序错误必须继续作为 UNKNOWN 处理。 */
function mapKnownPlanningError(error: unknown): GraphPlanResolutionError | null {
  if (error instanceof GraphPlannerError) {
    return error.kind === "provider_failure" || error.kind === "budget_exhausted"
      ? createResolutionError("PLANNER_FAILED", true)
      : createResolutionError("INVALID_GRAPH", true);
  }
  if (error instanceof GraphRevisionError) {
    return error.kind === "provider_failure" || error.kind === "budget_exhausted"
      ? createResolutionError("PLANNER_FAILED", true)
      : createResolutionError("INVALID_GRAPH", true);
  }
  if (error instanceof SearchPlanGenerationError) {
    return error.kind === "provider_failure" || error.kind === "budget_exhausted"
      ? createResolutionError("PLANNER_FAILED", true)
      : createResolutionError("INVALID_GRAPH", true);
  }
  if (error instanceof BroadDiscoveryError) {
    return createResolutionError("SEARCH_PROVIDER_FAILED", true);
  }
  return null;
}

/** Initial Outline 必须先通过此门禁，之后才允许读取 strategy / broadSearchQueries。 */
export function parseValidatedGraphOutlineForRun(
  outline: unknown,
): GraphOutline {
  const parsed = GraphOutlineSchema.safeParse(outline);
  if (!parsed.success || !validateGraphOutline(parsed.data).valid) {
    throw createResolutionError("INVALID_GRAPH", true);
  }
  return parsed.data;
}

/** 最终公共 GraphPlan 防御门禁也供 Node 终态协调器复用。 */
export function parseValidatedGraphPlanForRun(plan: unknown): GraphPlan {
  const parsed = GraphPlanSchema.safeParse(plan);
  if (!parsed.success || !validateGraphPlan(parsed.data).valid) {
    throw new TypeError("Orchestrator GraphPlan 未通过最终校验");
  }
  return parsed.data;
}

/**
 * 解析一次 Run 的最终 GraphPlan；调用方拥有并负责释放 runScope。
 * 只有完整 Final GraphPlan 返回后，外层才可以发布事件或启动 Node jobs。
 */
export async function resolveValidatedGraphPlanForRun(
  input: ResolveValidatedGraphPlanForRunInput,
): Promise<GraphPlan> {
  assertBoundedLLMTimeout(input.llmStageTimeoutMs);
  let activeStage: "graphOutline" | "searchPlan" = "graphOutline";

  try {
    const initialOutlineCandidate = await planGraphOutline({
      query: input.query,
      language: input.language,
      provider: input.llmProvider,
      signal: input.runScope.signal,
      timeoutMs: Math.min(
        input.llmStageTimeoutMs,
        input.runScope.requirePositiveRemainingMs(),
      ),
      onValidationDiagnostic: input.onPlannerValidationDiagnostic,
    });
    input.runScope.requirePositiveRemainingMs();

    // 防御内部调用被替换或未来重构绕过 Planner 自身校验。
    const initialOutline = parseValidatedGraphOutlineForRun(
      initialOutlineCandidate,
    );
    let finalOutline = initialOutline;

    if (initialOutline.analysis.strategy === "evidence_assisted") {
      const evidence = await discoverBroadEvidence({
        analysis: initialOutline.analysis,
        provider: input.searchProvider,
        signal: input.runScope.signal,
        language: input.language,
        ...(input.engine === undefined ? {} : { engine: input.engine }),
      });
      input.runScope.requirePositiveRemainingMs();

      const revisedOutline = await reviseGraphOutline({
        query: input.query,
        language: input.language,
        initialOutline,
        evidence,
        provider: input.llmProvider,
        signal: input.runScope.signal,
        timeoutMs: Math.min(
          input.llmStageTimeoutMs,
          input.runScope.requirePositiveRemainingMs(),
        ),
        onValidationDiagnostic: input.onRevisionValidationDiagnostic,
      });
      input.runScope.requirePositiveRemainingMs();
      finalOutline = parseValidatedGraphOutlineForRun(revisedOutline);
    }

    notifyPlanningObserver(input.onGraphOutlinePlanningFinished);
    activeStage = "searchPlan";

    // Stage 2 只能看到已经定稿且再次验证过的完整 Outline。
    const bundle = await generateSearchPlanBundle({
      query: input.query,
      language: input.language,
      outline: finalOutline,
      provider: input.llmProvider,
      signal: input.runScope.signal,
      timeoutMs: Math.min(
        input.llmStageTimeoutMs,
        input.runScope.requirePositiveRemainingMs(),
      ),
      onValidationDiagnostic: input.onSearchPlanValidationDiagnostic,
    });
    input.runScope.requirePositiveRemainingMs();

    const candidate = assembleGraphPlan(finalOutline, bundle);
    let validatedPlan: GraphPlan;
    try {
      validatedPlan = parseValidatedGraphPlanForRun(candidate);
    } catch (error: unknown) {
      if (error instanceof TypeError) {
        throw createResolutionError("INVALID_GRAPH", true);
      }
      throw error;
    }
    // 同步装配/Validator 也可能跨过绝对截止时间。
    input.runScope.requirePositiveRemainingMs();
    notifyPlanningObserver(input.onSearchPlanPlanningFinished);
    return validatedPlan;
  } catch (error: unknown) {
    if (input.runScope.signal.aborted) {
      const reason = input.runScope.signal.reason;
      notifyPlanningFailure(
        input.onPlanningStageFailed,
        activeStage,
        reason instanceof Error && reason.name === "TimeoutError"
          ? "RUN_DEADLINE_EXCEEDED"
          : "REQUEST_ABORTED",
      );
      throw reason;
    }
    if (error instanceof GraphPlanResolutionError) {
      notifyPlanningFailure(
        input.onPlanningStageFailed,
        activeStage,
        error.appError.code,
      );
      throw error;
    }
    const mapped = mapKnownPlanningError(error);
    if (mapped !== null) {
      notifyPlanningFailure(
        input.onPlanningStageFailed,
        activeStage,
        mapped.appError.code,
      );
      throw mapped;
    }
    const code: AppErrorCode =
      error instanceof Error && error.name === "TimeoutError"
        ? "RUN_DEADLINE_EXCEEDED"
        : "UNKNOWN";
    notifyPlanningFailure(input.onPlanningStageFailed, activeStage, code);
    throw error;
  }
}
