/**
 * 模块职责：在唯一 Absolute Run Deadline 内结算 Node 计算，并把每个 Outcome
 * 同步交给终态协调器。
 *
 * 关键边界：
 * - settlementOrdinal 是 1-based、Run 内严格单调且只在这里分配；
 * - Outcome Slot 与协调器入口都在 Job 观察回调的首次 await 前完成；
 * - Deadline 给未结算 Node 按 GraphPlan 顺序追加 ordinal，并等待真实终态写入；
 * - 终态 Sink 失败立即中止共享 Run，不等待兄弟 Node 或 Deadline。
 */
import type { NodeJobOutcome } from "@wayfinder/contracts";

import {
  NodeEventEmissionError,
  toNodeJobError,
} from "../pipeline/process-node.js";
import type { AbsoluteRunDeadlineScope } from "./absolute-run-deadline.js";
import type { NodeJobTask } from "./start-node-jobs.js";

type SettlementRunScope = Pick<
  AbsoluteRunDeadlineScope,
  "isDeadlineReason" | "requirePositiveRemainingMs" | "signal"
>;

export type SettleNodeJobsInput = Readonly<{
  runScope: SettlementRunScope;
  acceptOutcome: (outcome: NodeJobOutcome) => Promise<void>;
  /** 必须同步中止组成 runScope 的内部 Controller。 */
  abortRun: (reason: unknown) => void;
}>;

type OutcomeSlot = {
  readonly nodeId: string;
  outcome: NodeJobOutcome | undefined;
  terminalWrite: Promise<void> | undefined;
};

type RunTermination =
  | Readonly<{
      kind: "deadline";
      outcomes: readonly NodeJobOutcome[];
      terminalWrites: Promise<void>;
    }>
  | Readonly<{
      kind: "cancelled";
      reason: unknown;
    }>;

type SettlementCompletion =
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "fatal"; error: unknown }>;

const DEADLINE_ERROR = Object.freeze({
  code: "RUN_DEADLINE_EXCEEDED" as const,
  retryable: true as const,
});

function collectCompletedOutcomes(
  slots: readonly OutcomeSlot[],
): readonly NodeJobOutcome[] {
  return slots.map(slot => {
    if (slot.outcome === undefined) {
      throw new TypeError(`Node job ${slot.nodeId} 缺少结算结果`);
    }
    return slot.outcome;
  });
}

/**
 * 按输入顺序返回稳定 Outcome；ordinal 单独记录真实结算先后。用户取消不生成 Outcome，
 * 而忽略 Signal 的迟到 Provider 仍保留观察器，避免 Unhandled Rejection。
 */
export async function settleNodeJobsUntilAbsoluteDeadline(
  jobs: readonly NodeJobTask[],
  input: SettleNodeJobsInput,
): Promise<readonly NodeJobOutcome[]> {
  const slots: OutcomeSlot[] = jobs.map(job => ({
    nodeId: job.nodeId,
    outcome: undefined,
    terminalWrite: undefined,
  }));
  let closed = false;
  let nextSettlementOrdinal = 1;
  let firstFatalError: unknown;
  let resolveFatal: (completion: SettlementCompletion) => void = () => undefined;
  const fatal = new Promise<SettlementCompletion>(resolve => {
    resolveFatal = resolve;
  });

  const reportFatal = (error: unknown): void => {
    if (firstFatalError !== undefined) return;
    firstFatalError = error;
    // 先固定 fatal 事实，再同步 Abort；避免 Abort listener 把同一错误抢成用户取消分支。
    resolveFatal({ kind: "fatal", error });
    try {
      input.abortRun(error);
    } catch {
      // Abort 入口不能用第二个异常覆盖真实 Sink / 状态错误。
    }
  };

  const mayCommitOutcome = (): boolean => {
    if (closed) return false;
    try {
      input.runScope.requirePositiveRemainingMs();
    } catch (error: unknown) {
      if (input.runScope.signal.aborted) return false;
      throw error;
    }
    return !closed;
  };

  /** 同步写 Slot 并调用协调器；返回值才是本回调的首次异步等待。 */
  const commitOutcome = (
    index: number,
    outcome: NodeJobOutcome,
  ): Promise<void> => {
    const slot = slots[index]!;
    slot.outcome = outcome;
    let terminalWrite: Promise<void>;
    try {
      terminalWrite = input.acceptOutcome(outcome);
    } catch (error: unknown) {
      reportFatal(error);
      return Promise.resolve();
    }
    slot.terminalWrite = terminalWrite;
    return terminalWrite
      .then(() => {
        if (input.runScope.signal.aborted) return;
        try {
          // Writer 回调可能推进确定性测试时钟或真实事件循环时间；写入完成后立即复查。
          input.runScope.requirePositiveRemainingMs();
        } catch (error: unknown) {
          if (!input.runScope.isDeadlineReason(error)) throw error;
        }
      })
      .catch((error: unknown) => {
        reportFatal(error);
      });
  };

  const observedJobs = jobs.map((job, index) =>
    job.promise.then(
      value => {
        if (!mayCommitOutcome()) return;
        const outcome: NodeJobOutcome = {
          status: "fulfilled",
          nodeId: job.nodeId,
          settlementOrdinal: nextSettlementOrdinal++,
          value,
        };
        return commitOutcome(index, outcome);
      },
      (error: unknown) => {
        if (!mayCommitOutcome()) return;
        if (error instanceof NodeEventEmissionError) {
          reportFatal(error);
          return;
        }
        const outcome: NodeJobOutcome = {
          status: "rejected",
          nodeId: job.nodeId,
          settlementOrdinal: nextSettlementOrdinal++,
          error: toNodeJobError(error),
        };
        return commitOutcome(index, outcome);
      },
    ),
  );
  const allObserved = Promise.all(observedJobs).then(
    (): SettlementCompletion => ({ kind: "completed" }),
  );

  let removeAbortListener = (): void => undefined;
  const termination = new Promise<RunTermination>(resolve => {
    const settleFromAbort = (): void => {
      if (closed) return;
      closed = true;
      const reason = input.runScope.signal.reason;
      if (!input.runScope.isDeadlineReason(reason)) {
        resolve({ kind: "cancelled", reason });
        return;
      }

      // Deadline 同步冻结已有 Slot，并按 GraphPlan 顺序给缺失项追加连续 ordinal。
      for (const [index, slot] of slots.entries()) {
        if (slot.outcome !== undefined) continue;
        const outcome: NodeJobOutcome = {
          status: "timed_out",
          nodeId: slot.nodeId,
          settlementOrdinal: nextSettlementOrdinal++,
          error: DEADLINE_ERROR,
        };
        // closed 只禁止 Job 迟到提交；Deadline 自身仍必须占 Slot 并安排终态写入。
        slot.outcome = outcome;
        try {
          slot.terminalWrite = input.acceptOutcome(outcome);
        } catch (error: unknown) {
          reportFatal(error);
          slot.terminalWrite = Promise.reject(error);
          void slot.terminalWrite.catch(() => undefined);
        }
        void slot.terminalWrite.catch(reportFatal);
        // 显式引用 index，防止未来改为稀疏 Slot 时静默丢失计划顺序。
        void index;
      }
      const outcomes = collectCompletedOutcomes(slots);
      const terminalWrites = Promise.all(
        slots.map(slot => {
          if (slot.terminalWrite === undefined) {
            throw new TypeError(`Node ${slot.nodeId} 缺少终态写入 Promise`);
          }
          return slot.terminalWrite;
        }),
      ).then(() => undefined);
      void terminalWrites.catch(reportFatal);
      resolve({ kind: "deadline", outcomes, terminalWrites });
    };

    if (input.runScope.signal.aborted) {
      settleFromAbort();
      return;
    }
    input.runScope.signal.addEventListener("abort", settleFromAbort, {
      once: true,
    });
    removeAbortListener = () => {
      input.runScope.signal.removeEventListener("abort", settleFromAbort);
    };
  });

  try {
    // 让调用前已 settled 的 Promise 先执行观察回调，ordinal 因此仍由注册顺序稳定产生。
    await Promise.resolve();
    if (firstFatalError !== undefined) throw firstFatalError;
    if (input.runScope.signal.aborted) {
      const aborted = await termination;
      if (aborted.kind === "deadline") {
        await aborted.terminalWrites;
        return aborted.outcomes;
      }
      throw aborted.reason;
    }

    try {
      input.runScope.requirePositiveRemainingMs();
    } catch (error: unknown) {
      if (!input.runScope.isDeadlineReason(error)) throw error;
    }

    const result = await Promise.race([fatal, allObserved, termination]);
    if (result.kind === "deadline") {
      await result.terminalWrites;
      return result.outcomes;
    }
    if (result.kind === "cancelled") throw result.reason;
    if (result.kind === "fatal") throw result.error;

    closed = true;
    return collectCompletedOutcomes(slots);
  } finally {
    closed = true;
    removeAbortListener();
  }
}
