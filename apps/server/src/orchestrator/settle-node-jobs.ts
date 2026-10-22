/**
 * 模块职责：在唯一 Absolute Run Deadline（绝对运行截止时间）内结算全部 Node job。
 *
 * 关键边界：
 * - 只通过已注册的 Promise 回调记录结算，不探测 Promise 私有状态；
 * - 普通失败、真正 Deadline 与用户取消保持三条独立控制流；
 * - Deadline 回调同步冻结快照，迟到工作只被观察，不能阻塞或改写返回值；
 * - 本模块不构造 failed Node、不生成 ResultGraph，也不发送 StreamEvent。
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
}>;

type OutcomeSlot = {
  readonly nodeId: string;
  outcome: NodeJobOutcome | undefined;
};

type RunTermination =
  | Readonly<{
      kind: "deadline";
      outcomes: readonly NodeJobOutcome[];
    }>
  | Readonly<{
      kind: "cancelled";
      reason: unknown;
    }>;

type SettlementCompletion =
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "fatal"; error: NodeEventEmissionError }>;

const DEADLINE_ERROR = Object.freeze({
  code: "RUN_DEADLINE_EXCEEDED" as const,
  retryable: true as const,
});

/** Deadline 到达的同步回调只读取本模块已经观察到的 Slot，不等待任何 Job。 */
function snapshotAtDeadline(slots: readonly OutcomeSlot[]): NodeJobOutcome[] {
  return slots.map(slot =>
    slot.outcome ?? {
      status: "timed_out",
      nodeId: slot.nodeId,
      error: DEADLINE_ERROR,
    },
  );
}

function collectCompletedOutcomes(
  slots: readonly OutcomeSlot[],
): readonly NodeJobOutcome[] {
  return slots.map(slot => {
    if (slot.outcome === undefined) {
      // Promise.all 已完成却仍缺少 Slot 只能来自内部实现回归，不能伪造成 Timeout。
      throw new TypeError(`Node job ${slot.nodeId} 缺少结算结果`);
    }
    return slot.outcome;
  });
}

/**
 * 按输入顺序返回稳定的 fulfilled / rejected / timed_out Outcome。
 *
 * 真正 Deadline 只由 Run Scope 的私有 reason 身份识别；用户即使传入同名
 * TimeoutError 也会保持原对象向上抛出。截止或取消后，每个 Promise 仍有观察处理器，
 * 因此忽略 Signal 的 Provider 迟到 reject 不会形成 Unhandled Rejection。
 */
export async function settleNodeJobsUntilAbsoluteDeadline(
  jobs: readonly NodeJobTask[],
  input: SettleNodeJobsInput,
): Promise<readonly NodeJobOutcome[]> {
  const slots: OutcomeSlot[] = jobs.map(job => ({
    nodeId: job.nodeId,
    outcome: undefined,
  }));
  let closed = false;
  let firstFatalError: NodeEventEmissionError | undefined;
  let resolveFatal: (completion: SettlementCompletion) => void = () => undefined;
  const fatal = new Promise<SettlementCompletion>(resolve => {
    resolveFatal = resolve;
  });

  /**
   * Timer 回调可能因事件循环阻塞而延后；每个 Job 提交结果前仍须检查同一绝对时间。
   * 若检查触发 Deadline，Signal listener 会同步关闭并冻结所有 Slot。
   */
  const mayCommitOutcome = (): boolean => {
    if (closed) {
      return false;
    }
    try {
      input.runScope.requirePositiveRemainingMs();
    } catch (error: unknown) {
      if (input.runScope.signal.aborted) {
        return false;
      }
      throw error;
    }
    return !closed;
  };

  const observedJobs = jobs.map((job, index) =>
    job.promise.then(
      value => {
        if (mayCommitOutcome()) {
          slots[index]!.outcome = {
            status: "fulfilled",
            nodeId: job.nodeId,
            value,
          };
        }
      },
      (error: unknown) => {
        if (!mayCommitOutcome()) {
          return;
        }
        // Event Sink 故障属于 Run/传输层；截止快照前发生时不能伪装成 Node 失败。
        if (error instanceof NodeEventEmissionError) {
          firstFatalError ??= error;
          resolveFatal({ kind: "fatal", error: firstFatalError });
          return;
        }
        slots[index]!.outcome = {
          status: "rejected",
          nodeId: job.nodeId,
          error: toNodeJobError(error),
        };
      },
    ),
  );
  const allObserved = Promise.all(observedJobs).then(
    (): SettlementCompletion => ({ kind: "completed" }),
  );

  let removeAbortListener = (): void => undefined;
  const termination = new Promise<RunTermination>(resolve => {
    const settleFromAbort = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      const reason = input.runScope.signal.reason;
      if (input.runScope.isDeadlineReason(reason)) {
        resolve({ kind: "deadline", outcomes: snapshotAtDeadline(slots) });
      } else {
        resolve({ kind: "cancelled", reason });
      }
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
    // 让调用前已经 settled 的 Promise 先执行已安装的观察回调，避免把它猜成 pending。
    await Promise.resolve();

    if (firstFatalError !== undefined) {
      throw firstFatalError;
    }
    if (input.runScope.signal.aborted) {
      const aborted = await termination;
      if (aborted.kind === "deadline") {
        return aborted.outcomes;
      }
      throw aborted.reason;
    }
    if (slots.every(slot => slot.outcome !== undefined)) {
      closed = true;
      return collectCompletedOutcomes(slots);
    }

    if (!input.runScope.signal.aborted) {
      // 封闭 Timer 尚未回调但统一时钟已经过期的窗口；本调用不会创建第二个 Timer。
      try {
        input.runScope.requirePositiveRemainingMs();
      } catch (error: unknown) {
        // requirePositiveRemainingMs 会先同步中止 Scope；真正 Deadline 由下方统一消费。
        if (!input.runScope.isDeadlineReason(error)) {
          throw error;
        }
      }
    }

    const result = await Promise.race([
      fatal,
      allObserved,
      termination,
    ]);

    if (result.kind === "deadline") {
      return result.outcomes;
    }
    if (result.kind === "cancelled") {
      throw result.reason;
    }
    if (result.kind === "fatal") {
      throw result.error;
    }

    closed = true;
    return collectCompletedOutcomes(slots);
  } finally {
    closed = true;
    removeAbortListener();
  }
}
