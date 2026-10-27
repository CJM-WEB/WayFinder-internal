/**
 * 模块职责：创建整次搜索唯一的 Absolute Run Deadline（绝对运行截止时间）。
 *
 * 关键边界：
 * - 只创建一个 40 秒 Timer（计时器）与一个共享 AbortSignal（中止信号）；
 * - 父 Signal 的取消原因保持对象身份，Deadline 使用本 Scope（作用域）唯一的原因；
 * - 剩余预算始终从同一个 deadlineAt 计算，任何阶段都不能重新获得 40 秒；
 * - dispose() 必须释放 Timer 与父 Signal Listener（监听器），且可以安全重复调用。
 */
import { RUN_DEADLINE_MS } from "../config.js";

export type AbsoluteRunDeadlineScope = Readonly<{
  /** 使用统一时钟基准计算的绝对截止点，仅供 Orchestrator 内部读取。 */
  deadlineAt: number;
  /** Planner、Broad Search、Reviser 与 Node jobs 必须复用同一对象。 */
  signal: AbortSignal;
  /** 只按本 Scope 唯一 reason 的对象身份识别真正 Run Deadline。 */
  isDeadlineReason: (reason: unknown) => boolean;
  /**
   * 返回当前仍可使用的正整数毫秒预算。
   *
   * 若事件循环阻塞导致 Timer 尚未回调，但当前时钟已经越过 deadlineAt，
   * 本方法会同步中止 Scope 并抛出同一个 Deadline reason，禁止启动新阶段。
   */
  requirePositiveRemainingMs: () => number;
  /** 提前结束 Run 时释放生命周期资源；不会把正常完成伪装成取消。 */
  dispose: () => void;
}>;

export type CreateAbsoluteRunDeadlineInput = Readonly<{
  /** Route 层提供的用户取消 Signal；其 reason 必须原样向下游传播。 */
  parentSignal: AbortSignal;
  /** 仅用于确定性测试；生产代码与后续 settlement 统一使用 Date.now()。 */
  now?: () => number;
}>;

function assertFiniteTime(value: number): void {
  if (!Number.isFinite(value)) {
    throw new TypeError("Run deadline 时钟必须返回有限数字");
  }
}

function createDeadlineReason(): DOMException {
  return new DOMException("Run deadline exceeded", "TimeoutError");
}

/**
 * 创建固定 40 秒的 Run Scope。调用方必须在 runSearch() 入口立即创建，并在
 * finally 中调用 dispose()；阶段代码只能消费返回值，不能另建 Run Deadline。
 */
export function createAbsoluteRunDeadline(
  input: CreateAbsoluteRunDeadlineInput,
): AbsoluteRunDeadlineScope {
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  assertFiniteTime(startedAt);

  const deadlineAt = startedAt + RUN_DEADLINE_MS;
  const controller = new AbortController();
  const deadlineReason = createDeadlineReason();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let parentListenerAttached = false;
  let disposed = false;
  let lastRemainingMs: number = RUN_DEADLINE_MS;

  const removeParentListener = (): void => {
    if (!parentListenerAttached) {
      return;
    }
    input.parentSignal.removeEventListener("abort", abortFromParent);
    parentListenerAttached = false;
  };

  const clearDeadlineTimer = (): void => {
    if (timer === undefined) {
      return;
    }
    clearTimeout(timer);
    timer = undefined;
  };

  /**
   * 第一个终止来源拥有 Signal reason；AbortController 的幂等语义防止随后发生的
   * 父取消或 Deadline 覆盖已确定的生命周期结论。
   */
  const abortScope = (reason: unknown): void => {
    if (controller.signal.aborted) {
      return;
    }
    clearDeadlineTimer();
    removeParentListener();
    controller.abort(reason);
  };

  function abortFromParent(): void {
    abortScope(input.parentSignal.reason);
  }

  if (input.parentSignal.aborted) {
    abortScope(input.parentSignal.reason);
  } else {
    input.parentSignal.addEventListener("abort", abortFromParent, {
      once: true,
    });
    parentListenerAttached = true;
    timer = setTimeout(() => abortScope(deadlineReason), RUN_DEADLINE_MS);
  }

  return Object.freeze({
    deadlineAt,
    signal: controller.signal,
    // 用户取消可以携带同名 TimeoutError；来源只能用私有 reason 的身份判定。
    isDeadlineReason: (reason: unknown) => reason === deadlineReason,
    requirePositiveRemainingMs: () => {
      controller.signal.throwIfAborted();

      const currentTime = now();
      assertFiniteTime(currentTime);
      // ceil 保留不足 1ms 的最后预算；历史下限防止异常时钟回拨恢复已消耗预算。
      const remainingMs = Math.min(
        lastRemainingMs,
        Math.ceil(deadlineAt - currentTime),
      );
      if (remainingMs < 1) {
        abortScope(deadlineReason);
        controller.signal.throwIfAborted();
      }
      lastRemainingMs = remainingMs;
      return remainingMs;
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      clearDeadlineTimer();
      removeParentListener();
    },
  });
}
