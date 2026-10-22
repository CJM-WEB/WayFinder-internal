/**
 * 模块职责：组合单次 Streaming Search Run 的完整服务端执行链。
 *
 * 关键边界：
 * - 入口只创建一个 Absolute Run Deadline，规划、Node 和结算共用同一 Signal；
 * - GraphPlan 只在最终校验通过后发布，然后才启动全部 Node job；
 * - 已发布计划的 Deadline 收敛为每 Node failed 与 complete，用户取消和传输故障则原样抛出；
 * - 本模块不创建 Provider、HTTP Writer 或客户端状态，这些由组合根注入。
 */
import type {
  NodeJobOutcome,
  ResultGraph,
} from "@wayfinder/contracts";

import type { GraphPlanValidationDiagnostic } from "../ai/graph-plan-parser.js";
import type { GraphPlannerOutcome } from "../ai/graph-planner.js";
import type { GraphRevisionValidationDiagnostic } from "../ai/graph-reviser.js";
import {
  assertBoundedLLMTimeout,
  type LLMProvider,
} from "../ai/llm-provider.js";
import { RUN_DEADLINE_MS } from "../config.js";
import {
  createRunLogRecorder,
  type RunLogRecorder,
  type RunLogSink,
  type RunProviderOperation,
} from "../observability/run-log.js";
import { withRunLogObserver } from "../observability/run-log-context.js";
import type { OfficialSourcePolicy } from "../pipeline/official-source.js";
import type { SearchStreamHandler } from "../routes/search.js";
import type { SearchProvider } from "../search/provider.js";
import { createAbsoluteRunDeadline } from "./absolute-run-deadline.js";
import { emitValidatedPlanEvents } from "./emit-validated-plan-events.js";
import type { ConcurrencyLimitedProviders } from "./provider-concurrency.js";
import { resolveValidatedGraphPlanForRun } from "./resolve-graph-plan.js";
import {
  createRunTerminalEventState,
  emitRunFailedWithoutGraphPlan,
} from "./run-terminal-events.js";
import { settleNodeJobsUntilAbsoluteDeadline } from "./settle-node-jobs.js";
import { startNodeJobs } from "./start-node-jobs.js";

export type CreateRunSearchHandlerInput = Readonly<{
  /** 必须是进程级共享的并发装饰器，不能每个 Run 重新创建队列。 */
  providers: ConcurrencyLimitedProviders;
  officialSourcePolicy: OfficialSourcePolicy;
  llmStageTimeoutMs: number;
  rerankTimeoutMs: number;
  language: string;
  /** Query 规范化属于组合根策略；本层不猜测 Locale 或搜索习惯。 */
  normalizeQuery: (query: string) => string;
  onPlannerValidationDiagnostic: (
    diagnostic: GraphPlanValidationDiagnostic,
  ) => void;
  onRevisionValidationDiagnostic: (
    diagnostic: GraphRevisionValidationDiagnostic,
  ) => void;
  onPlannerOutcome?: (outcome: GraphPlannerOutcome) => void;
  /** 缺省即完全关闭；Sink 只接收内部严格白名单记录。 */
  runLogSink?: RunLogSink;
  createRunLogId?: () => string;
  /** 固定脱敏失败信号，不接收原始 Error。 */
  onRunLogWriteFailure?: () => void;
  /** 只用于稳定时间快照与确定性测试；生产默认 Date.now。 */
  now?: () => number;
}>;

const DEADLINE_ERROR = Object.freeze({
  code: "RUN_DEADLINE_EXCEEDED" as const,
  retryable: true as const,
});

function createTimedOutOutcomes(
  nodeIds: readonly string[],
): readonly NodeJobOutcome[] {
  return nodeIds.map(nodeId => ({
    status: "timed_out",
    nodeId,
    error: DEADLINE_ERROR,
  }));
}

function readElapsedMs(now: () => number, startedAt: number): number {
  const finishedAt = now();
  if (!Number.isFinite(finishedAt)) {
    throw new TypeError("Run 完成时钟必须返回有限数字");
  }
  // 系统时钟回拨不应制造负耗时；Deadline Scope 自身仍保留历史剩余上限。
  return Math.max(0, finishedAt - startedAt);
}

/** Run Log 的时钟读取必须 fail-open，不能扩大业务时钟的失败面。 */
function readObservedElapsedMs(now: () => number, startedAt: number): number {
  try {
    const finishedAt = now();
    return Number.isFinite(finishedAt) && Number.isFinite(startedAt)
      ? Math.max(0, finishedAt - startedAt)
      : 0;
  } catch {
    return 0;
  }
}

function observeSafely(operation: () => void): void {
  try {
    operation();
  } catch {
    // 可观测性必须始终保持旁路，不能改变 Run 的 Event 或错误语义。
  }
}

/**
 * 在每 Run 最外层统计逻辑调用、等待加执行耗时和安全数量。
 * 包装发生在进程级 Concurrency/Cache 外侧，不读取输入正文或 Provider 私有字段。
 */
function createObservedProviders(
  providers: ConcurrencyLimitedProviders,
  recorder: RunLogRecorder,
  now: () => number,
): ConcurrencyLimitedProviders {
  const observeCall = async <T>(
    operation: RunProviderOperation,
    resultCount: (value: T) => number,
    call: () => Promise<T>,
    extractUrlCount = 0,
  ): Promise<T> => {
    const startedAt = (() => {
      try {
        return now();
      } catch {
        return 0;
      }
    })();
    observeSafely(() =>
      recorder.recordProviderCallStarted(operation, extractUrlCount),
    );
    let observedResultCount = 0;
    try {
      // Context 只包住当前 Provider 调用，避免要求整个 Orchestrator 改变控制结构。
      const value = await withRunLogObserver(recorder.observe, call);
      try {
        observedResultCount = resultCount(value);
      } catch {
        // 非法 Provider 返回值仍由业务层处理；日志计数失败不能覆盖原始结果。
        observedResultCount = 0;
      }
      return value;
    } finally {
      observeSafely(() =>
        recorder.recordProviderCallFinished(
          operation,
          readObservedElapsedMs(now, startedAt),
          observedResultCount,
        ),
      );
    }
  };

  const baseSearchProvider = providers.searchProvider;
  const providerExtract = baseSearchProvider.extract;
  const searchProvider: SearchProvider = {
    id: baseSearchProvider.id,
    capabilities: [...baseSearchProvider.capabilities],
    search: (request, signal) =>
      observeCall(
        "search",
        hits => hits.length,
        () => baseSearchProvider.search(request, signal),
      ),
    ...(providerExtract === undefined
      ? {}
      : {
          extract: (canonicalUrls: string[], signal: AbortSignal) =>
            observeCall(
              "extract",
              pages => pages.length,
              () =>
                providerExtract.call(
                  baseSearchProvider,
                  canonicalUrls,
                  signal,
                ),
              canonicalUrls.length,
            ),
        }),
  };
  const baseLlmProvider = providers.llmProvider;
  const llmProvider: LLMProvider = {
    id: baseLlmProvider.id,
    structured: (structuredInput, options) =>
      observeCall(
        "llm",
        () => 0,
        () => baseLlmProvider.structured(structuredInput, options),
      ),
  };

  return { searchProvider, llmProvider };
}

/**
 * 创建可直接交给 Search Route 的 Handler。所有阶段函数均使用真实生产实现，
 * 仅 Provider、诊断出口、Query 规范化和时钟保留轻量依赖注入。
 */
export function createRunSearchHandler(
  dependencies: CreateRunSearchHandlerInput,
): SearchStreamHandler {
  return async ({ input, signal, emit }) => {
    const now = dependencies.now ?? (() => Date.now());
    const fatalController = new AbortController();
    const runScope = createAbsoluteRunDeadline({
      // Route 取消与 Handler 自身的致命错误均必须能中止所有兄弟 Node。
      parentSignal: AbortSignal.any([signal, fatalController.signal]),
      now,
    });
    const startedAt = runScope.deadlineAt - RUN_DEADLINE_MS;
    let recorder: RunLogRecorder | undefined;
    if (dependencies.runLogSink !== undefined) {
      try {
        recorder = createRunLogRecorder({
          sink: dependencies.runLogSink,
          searchProviderId: dependencies.providers.searchProvider.id,
          llmProviderId: dependencies.providers.llmProvider.id,
          startedAt,
          now,
          ...(dependencies.createRunLogId === undefined
            ? {}
            : { createId: dependencies.createRunLogId }),
          ...(dependencies.onRunLogWriteFailure === undefined
            ? {}
            : { onWriteFailure: dependencies.onRunLogWriteFailure }),
        });
      } catch {
        observeSafely(() => dependencies.onRunLogWriteFailure?.());
      }
    }
    const providers =
      recorder === undefined
        ? dependencies.providers
        : createObservedProviders(dependencies.providers, recorder, now);
    const observedEmit: typeof emit = payload => {
      const writePromise = emit(payload);
      return recorder === undefined
        ? writePromise
        : writePromise.then(() => {
            observeSafely(() => recorder?.recordEvent(payload));
          });
    };
    let planEmissionStarted = false;
    let graphPlanAccepted = false;

    try {
      // Rerank 硬上限在首次外部调用前验证；Query/meta 仍由最终 ResultGraph Contract 守门。
      assertBoundedLLMTimeout(dependencies.rerankTimeoutMs);
      const resultQuery: ResultGraph["query"] = {
        raw: input.query,
        normalized: dependencies.normalizeQuery(input.query),
        language: dependencies.language,
      };
      const plan = await resolveValidatedGraphPlanForRun({
        query: input.query,
        llmProvider: providers.llmProvider,
        searchProvider: providers.searchProvider,
        runScope,
        llmStageTimeoutMs: dependencies.llmStageTimeoutMs,
        onPlannerValidationDiagnostic:
          dependencies.onPlannerValidationDiagnostic,
        onRevisionValidationDiagnostic:
          dependencies.onRevisionValidationDiagnostic,
        ...(dependencies.onPlannerOutcome === undefined
          ? {}
          : { onPlannerOutcome: dependencies.onPlannerOutcome }),
        language: dependencies.language,
      });
      observeSafely(() => recorder?.recordPlan(plan));

      planEmissionStarted = true;
      await emitValidatedPlanEvents({
        validatedPlan: plan,
        emit: payload => {
          // Analysis 与 GraphPlan 分别经历背压；每条接纳前都必须封闭 Timer 延迟窗口。
          runScope.requirePositiveRemainingMs();
          const writePromise = observedEmit(payload);
          if (payload.type === "graph.plan") {
            // Writer.emit 在返回 Promise 前已同步接纳；背压跨过 Deadline 不得否认已公开计划。
            graphPlanAccepted = true;
          }
          return writePromise;
        },
      });

      const terminalEvents = createRunTerminalEventState({
        plan,
        runScope,
        emit: observedEmit,
      });
      let outcomes: readonly NodeJobOutcome[];
      observeSafely(() => recorder?.recordNodeProcessingStarted());
      try {
        const rerankTimeoutMs = Math.min(
          dependencies.rerankTimeoutMs,
          runScope.requirePositiveRemainingMs(),
        );
        const jobs = startNodeJobs({
          plan,
          context: {
            officialSourcePolicy: dependencies.officialSourcePolicy,
            nowMs: startedAt,
            rerankTimeoutMs,
            emit: terminalEvents.emitNode,
            language: dependencies.language,
          },
          providers,
          runScope,
        });
        outcomes = await settleNodeJobsUntilAbsoluteDeadline(jobs, {
          runScope,
        });
      } catch (error: unknown) {
        if (!runScope.isDeadlineReason(error)) {
          throw error;
        }
        // GraphPlan 已上流但首个 Node 还未启动时到期，仍必须补齐每 Node 终态。
        outcomes = createTimedOutOutcomes(plan.nodes.map(node => node.id));
      }

      await terminalEvents.complete({
        runId: input.runId,
        query: resultQuery,
        outcomes,
        meta: {
          createdAt: new Date(startedAt).toISOString(),
          // ResultGraph 现有语义记录用户可见 Resource 的 Search Provider。
          providersUsed: [providers.searchProvider.id],
          timingMs: { total: readElapsedMs(now, startedAt) },
        },
      });
    } catch (error: unknown) {
      if (
        runScope.signal.aborted &&
        !runScope.isDeadlineReason(runScope.signal.reason)
      ) {
        // 用户/连接取消先于背压后到的 Sink 错误，必须保留父 Signal 的原始 reason。
        throw runScope.signal.reason;
      }
      if (
        graphPlanAccepted ||
        (planEmissionStarted && !runScope.isDeadlineReason(error))
      ) {
        // 已接纳 GraphPlan 或计划 Event Sink 失败时，再补 run.failed 会制造互斥语义。
        // 先中止其他 Provider/Queue，再释放 Scope Listener，避免致命错误后留下后台工作。
        fatalController.abort(error);
        throw error;
      }
      // GraphPlan 接纳前的真正 Deadline 仍属于无可用计划的全局失败。
      await emitRunFailedWithoutGraphPlan({
        error: { code: "UNKNOWN", retryable: false },
        runScope,
        emit: observedEmit,
      });
    } finally {
      runScope.dispose();
      observeSafely(() => recorder?.recordInterrupted(signal.aborted));
      // 本地日志不能延长用户可见 Run；finish 自身观察并吸收写入失败。
      void recorder?.finish();
    }
  };
}
