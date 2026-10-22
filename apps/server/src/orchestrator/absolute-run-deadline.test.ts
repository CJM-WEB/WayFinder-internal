/**
 * 测试职责：冻结唯一 20 秒 Absolute Run Deadline（绝对运行截止时间），
 * 覆盖统一 Signal、单调剩余预算、父取消竞争与 Scope（作用域）资源释放。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RUN_DEADLINE_MS } from "../config.js";
import { createAbsoluteRunDeadline } from "./absolute-run-deadline.js";

describe("createAbsoluteRunDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("立即创建唯一 deadlineAt，并让所有阶段共享同一个 Signal 与递减预算", () => {
    const parent = new AbortController();
    let nowMs = 1_000;
    const now = vi.fn(() => nowMs);
    const scope = createAbsoluteRunDeadline({
      parentSignal: parent.signal,
      now,
    });

    expect(scope.deadlineAt).toBe(1_000 + RUN_DEADLINE_MS);
    expect(now).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    const observedByStages = [
      "planner",
      "broadSearch",
      "reviser",
      "nodeJobs",
    ].map(() => ({
      signal: scope.signal,
      remainingMs: scope.requirePositiveRemainingMs(),
    }));
    expect(observedByStages.map(stage => stage.signal)).toEqual([
      scope.signal,
      scope.signal,
      scope.signal,
      scope.signal,
    ]);
    expect(observedByStages.map(stage => stage.remainingMs)).toEqual([
      20_000,
      20_000,
      20_000,
      20_000,
    ]);

    nowMs = 10_001;
    expect(scope.requirePositiveRemainingMs()).toBe(10_999);
    nowMs = 16_501;
    expect(scope.requirePositiveRemainingMs()).toBe(4_499);
    // 异常测试时钟回拨也不能恢复已经消耗的 Run 预算。
    nowMs = 0;
    expect(scope.requirePositiveRemainingMs()).toBe(4_499);

    scope.dispose();
  });

  it("恰好 20 秒后以稳定 TimeoutError 中止，且先发生的父取消不会被覆盖", async () => {
    const parent = new AbortController();
    const scope = createAbsoluteRunDeadline({
      parentSignal: parent.signal,
      now: () => 0,
    });

    await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS - 1);
    expect(scope.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBeInstanceOf(DOMException);
    expect(scope.signal.reason).toMatchObject({ name: "TimeoutError" });
    const deadlineReason = scope.signal.reason;
    expect(scope.isDeadlineReason(deadlineReason)).toBe(true);
    parent.abort(new Error("late parent cancellation"));
    expect(scope.signal.reason).toBe(deadlineReason);
    expect(vi.getTimerCount()).toBe(0);

    scope.dispose();
  });

  it("父 Signal 已取消或运行中取消时保留同一个 reason 对象", () => {
    const preCancelled = new AbortController();
    const preCancelledReason = new Error("cancel before run");
    preCancelled.abort(preCancelledReason);

    const preCancelledScope = createAbsoluteRunDeadline({
      parentSignal: preCancelled.signal,
      now: () => 0,
    });
    expect(preCancelledScope.signal.aborted).toBe(true);
    expect(preCancelledScope.signal.reason).toBe(preCancelledReason);
    expect(vi.getTimerCount()).toBe(0);

    const activeParent = new AbortController();
    const activeScope = createAbsoluteRunDeadline({
      parentSignal: activeParent.signal,
      now: () => 0,
    });
    const activeReason = new DOMException("new query", "AbortError");
    activeParent.abort(activeReason);

    expect(activeScope.signal.aborted).toBe(true);
    expect(activeScope.signal.reason).toBe(activeReason);
    expect(activeScope.isDeadlineReason(activeReason)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    const timeoutNamedParent = new AbortController();
    const timeoutNamedReason = new DOMException(
      "用户主动取消",
      "TimeoutError",
    );
    timeoutNamedParent.abort(timeoutNamedReason);
    const timeoutNamedScope = createAbsoluteRunDeadline({
      parentSignal: timeoutNamedParent.signal,
      now: () => 0,
    });
    expect(timeoutNamedScope.signal.reason).toBe(timeoutNamedReason);
    expect(timeoutNamedScope.isDeadlineReason(timeoutNamedReason)).toBe(false);

    preCancelledScope.dispose();
    activeScope.dispose();
    timeoutNamedScope.dispose();
  });

  it("时钟已过期但 Timer 尚未回调时同步终止，禁止启动新阶段", () => {
    const parent = new AbortController();
    let nowMs = 0;
    const scope = createAbsoluteRunDeadline({
      parentSignal: parent.signal,
      now: () => nowMs,
    });

    nowMs = RUN_DEADLINE_MS;

    expect(() => scope.requirePositiveRemainingMs()).toThrow(
      expect.objectContaining({ name: "TimeoutError" }),
    );
    expect(scope.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    scope.dispose();
  });

  it("dispose 幂等释放 Timer 与父 Listener，正常完成不会变成取消", async () => {
    const parent = new AbortController();
    const addListener = vi.spyOn(parent.signal, "addEventListener");
    const removeListener = vi.spyOn(parent.signal, "removeEventListener");
    const scope = createAbsoluteRunDeadline({
      parentSignal: parent.signal,
      now: () => 0,
    });
    const registeredListener = addListener.mock.calls[0]?.[1];

    scope.dispose();
    scope.dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith(
      "abort",
      registeredListener,
    );

    await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS);
    parent.abort(new Error("late cancellation"));
    expect(scope.signal.aborted).toBe(false);
  });

  it("拒绝非有限时钟，且不会遗留 Timer 或父 Listener", () => {
    const parent = new AbortController();
    const addListener = vi.spyOn(parent.signal, "addEventListener");

    expect(() =>
      createAbsoluteRunDeadline({
        parentSignal: parent.signal,
        now: () => Number.NaN,
      }),
    ).toThrow(TypeError);
    expect(addListener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
