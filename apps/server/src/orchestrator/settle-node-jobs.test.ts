/**
 * 测试职责：冻结 Node job 三分结算、Deadline 快照、用户取消来源与迟到工作。
 * 测试只验证内部 Outcome，不重复构造错误 Node 或 ResultGraph。
 */
import {
  ResultGraphNodeSchema,
  type NodeJobOutcome,
  type ResultGraphNode,
} from "@wayfinder/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDeferred,
  type Deferred,
} from "../../../../tests/support/test-infrastructure.mjs";
import { RUN_DEADLINE_MS } from "../config.js";
import {
  NodeEventEmissionError,
  NodeJobError,
} from "../pipeline/process-node.js";
import { createAbsoluteRunDeadline } from "./absolute-run-deadline.js";
import {
  settleNodeJobsUntilAbsoluteDeadline as settleNodeJobsProduction,
} from "./settle-node-jobs.js";
import type { NodeJobTask } from "./start-node-jobs.js";

type TestSettlementInput = Readonly<{
  runScope: Parameters<typeof settleNodeJobsProduction>[1]["runScope"];
  acceptOutcome?: Parameters<
    typeof settleNodeJobsProduction
  >[1]["acceptOutcome"];
  abortRun?: Parameters<typeof settleNodeJobsProduction>[1]["abortRun"];
}>;

/** 旧 Case 默认使用立即成功的终态写入；竞态 Case 可显式覆盖两个新入口。 */
function settleNodeJobsUntilAbsoluteDeadline(
  jobs: readonly NodeJobTask[],
  input: TestSettlementInput,
) {
  return settleNodeJobsProduction(jobs, {
    runScope: input.runScope,
    acceptOutcome: input.acceptOutcome ?? (async () => undefined),
    abortRun: input.abortRun ?? (() => undefined),
  });
}

function createResultNode(nodeId: string): ResultGraphNode {
  return ResultGraphNodeSchema.parse({
    id: nodeId,
    title: `节点 ${nodeId}`,
    description: "Node job 结算测试",
    nodeType: "primary",
    layer: 0,
    searchPlan: {
      queries: [`${nodeId} query`],
      maxResults: 20,
      rankingProfile: "general",
      providerHints: ["general"],
    },
    status: "ready",
    resources: [
      {
        id: `${nodeId}-resource`,
        title: "测试资源",
        url: `https://example.com/${nodeId}`,
        canonicalUrl: `https://example.com/${nodeId}`,
        domain: "example.com",
        sourceType: "documentation",
        summary: "用于验证结算顺序。",
        whySelected: "与当前 Node 直接相关。",
        rank: 1,
        searchProvider: "general",
      },
    ],
    warnings: [],
  });
}

function task<T extends ResultGraphNode>(
  nodeId: string,
  promise: Promise<T>,
): NodeJobTask {
  return { nodeId, promise };
}

describe("settleNodeJobsUntilAbsoluteDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("按输入顺序保留 fulfilled 与 rejected，并保留 NodeJobError 对象", async () => {
    const parent = new AbortController();
    const scope = createAbsoluteRunDeadline({
      parentSignal: parent.signal,
      now: () => Date.now(),
    });
    const addAbortListener = vi.spyOn(scope.signal, "addEventListener");
    const removeAbortListener = vi.spyOn(scope.signal, "removeEventListener");
    const first = createDeferred<ResultGraphNode>();
    const second = createDeferred<ResultGraphNode>();
    const third = createDeferred<ResultGraphNode>();
    const rejection = new NodeJobError("SEARCH_PROVIDER_FAILED", true);
    const settlement = settleNodeJobsUntilAbsoluteDeadline(
      [
        task("node-1", first.promise),
        task("node-2", second.promise),
        task("node-3", third.promise),
      ],
      { runScope: scope },
    );

    third.resolve(createResultNode("node-3"));
    second.reject(rejection);
    first.resolve(createResultNode("node-1"));

    const outcomes = await settlement;
    expect(outcomes.map(outcome => [outcome.nodeId, outcome.status])).toEqual([
      ["node-1", "fulfilled"],
      ["node-2", "rejected"],
      ["node-3", "fulfilled"],
    ]);
    const rejected = outcomes[1];
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.error).toBe(rejection);
    }
    const settlementListener = addAbortListener.mock.calls[0]?.[1];
    expect(settlementListener).toBeTypeOf("function");
    expect(removeAbortListener).toHaveBeenCalledWith(
      "abort",
      settlementListener,
    );

    scope.dispose();
  });

  it("调用前已经 settled 的 Promise 由真实观察回调立即结算", async () => {
    const scope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: () => 0,
    });
    const fulfilledNode = createResultNode("fulfilled");
    const rejectedError = new NodeJobError("SEARCH_PROVIDER_FAILED", true);
    const outcomes = await settleNodeJobsUntilAbsoluteDeadline(
      [
        task("fulfilled", Promise.resolve(fulfilledNode)),
        task("rejected", Promise.reject(rejectedError)),
      ],
      { runScope: scope },
    );

    expect(outcomes[0]).toEqual({
      status: "fulfilled",
      nodeId: "fulfilled",
      settlementOrdinal: 1,
      value: fulfilledNode,
    });
    expect(outcomes[1]).toMatchObject({
      status: "rejected",
      nodeId: "rejected",
      error: rejectedError,
    });
    scope.dispose();
  });

  it("Deadline 只快照未完成任务，且迟到 resolve/reject 不阻塞也不改写结果", async () => {
    const scope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: () => Date.now(),
    });
    const fulfilled = createDeferred<ResultGraphNode>();
    const rejected = createDeferred<ResultGraphNode>();
    const lateResolve = createDeferred<ResultGraphNode>();
    const lateReject = createDeferred<ResultGraphNode>();
    const ordinaryError = new NodeJobError("RERANK_FAILED", true);
    const settlement = settleNodeJobsUntilAbsoluteDeadline(
      [
        task("fulfilled", fulfilled.promise),
        task("rejected", rejected.promise),
        task("late-resolve", lateResolve.promise),
        task("late-reject", lateReject.promise),
      ],
      { runScope: scope },
    );

    fulfilled.resolve(createResultNode("fulfilled"));
    rejected.reject(ordinaryError);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS);
    const outcomes = await settlement;
    expect(outcomes.map(outcome => [outcome.nodeId, outcome.status])).toEqual([
      ["fulfilled", "fulfilled"],
      ["rejected", "rejected"],
      ["late-resolve", "timed_out"],
      ["late-reject", "timed_out"],
    ]);
    expect(
      outcomes.map(outcome => [outcome.nodeId, outcome.settlementOrdinal]),
    ).toEqual([
      ["fulfilled", 1],
      ["rejected", 2],
      ["late-resolve", 3],
      ["late-reject", 4],
    ]);

    lateResolve.resolve(createResultNode("late-resolve"));
    lateReject.reject(new Error("deadline 后迟到失败"));
    await Promise.resolve();
    expect(outcomes[2]).toMatchObject({
      status: "timed_out",
      error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
    });
    expect(outcomes[3]).toMatchObject({
      status: "timed_out",
      error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
    });

    scope.dispose();
  });

  it("用户取消保持 reason 对象，即使它也名为 TimeoutError", async () => {
    const parent = new AbortController();
    const scope = createAbsoluteRunDeadline({
      parentSignal: parent.signal,
      now: () => Date.now(),
    });
    const pending = createDeferred<ResultGraphNode>();
    const settlement = settleNodeJobsUntilAbsoluteDeadline(
      [task("node-1", pending.promise)],
      { runScope: scope },
    );
    const userReason = new DOMException("用户主动取消", "TimeoutError");

    parent.abort(userReason);

    await expect(settlement).rejects.toBe(userReason);
    pending.reject(new Error("取消后迟到失败"));
    await Promise.resolve();
    scope.dispose();
  });

  it("调用前已发生的用户取消仍原样上抛，空任务不会等待 Deadline", async () => {
    const parent = new AbortController();
    const reason = new Error("调用 settlement 前取消");
    parent.abort(reason);
    const cancelledScope = createAbsoluteRunDeadline({
      parentSignal: parent.signal,
      now: () => 0,
    });

    await expect(
      settleNodeJobsUntilAbsoluteDeadline([], { runScope: cancelledScope }),
    ).rejects.toBe(reason);
    cancelledScope.dispose();

    const activeScope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: () => 0,
    });
    await expect(
      settleNodeJobsUntilAbsoluteDeadline([], { runScope: activeScope }),
    ).resolves.toEqual([]);
    activeScope.dispose();
  });

  it("任务因真正 Deadline 同步拒绝时仍按当时 pending 归为 timed_out", async () => {
    const scope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: () => Date.now(),
    });
    const abortResponsive = new Promise<ResultGraphNode>((_resolve, reject) => {
      scope.signal.addEventListener(
        "abort",
        () => reject(scope.signal.reason),
        { once: true },
      );
    });
    const settlement = settleNodeJobsUntilAbsoluteDeadline(
      [task("node-1", abortResponsive)],
      { runScope: scope },
    );

    await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS);

    await expect(settlement).resolves.toEqual([
      {
        status: "timed_out",
        nodeId: "node-1",
        settlementOrdinal: 1,
        error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
      },
    ]);
    scope.dispose();
  });

  it("未知普通 rejection 收敛为 UNKNOWN，而不是 timed_out", async () => {
    const scope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: () => 0,
    });

    const outcomes = await settleNodeJobsUntilAbsoluteDeadline(
      [task("node-1", Promise.reject(new TypeError("内部细节")))],
      { runScope: scope },
    );

    expect(outcomes).toMatchObject([
      {
        status: "rejected",
        nodeId: "node-1",
        error: { code: "UNKNOWN", retryable: false },
      },
    ]);
    scope.dispose();
  });

  it("截止快照前的 Event Sink 故障立即向上传播，不等待其他任务", async () => {
    const scope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: () => Date.now(),
    });
    const addAbortListener = vi.spyOn(scope.signal, "addEventListener");
    const removeAbortListener = vi.spyOn(scope.signal, "removeEventListener");
    const failed = createDeferred<ResultGraphNode>();
    const pending = createDeferred<ResultGraphNode>();
    const eventError = new NodeEventEmissionError();
    const settlement = settleNodeJobsUntilAbsoluteDeadline(
      [task("failed", failed.promise), task("pending", pending.promise)],
      { runScope: scope },
    );

    failed.reject(eventError);

    await expect(settlement).rejects.toBe(eventError);
    const settlementListener = addAbortListener.mock.calls[0]?.[1];
    expect(settlementListener).toBeTypeOf("function");
    expect(removeAbortListener).toHaveBeenCalledWith(
      "abort",
      settlementListener,
    );
    pending.resolve(createResultNode("pending"));
    await Promise.resolve();
    scope.dispose();
  });

  it("按真实完成顺序分配 ordinal，但返回数组仍保持 GraphPlan 顺序", async () => {
    const scope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: () => 0,
    });
    const first = createDeferred<ResultGraphNode>();
    const second = createDeferred<ResultGraphNode>();
    const third = createDeferred<ResultGraphNode>();
    const accepted: NodeJobOutcome[] = [];
    const settlement = settleNodeJobsUntilAbsoluteDeadline(
      [
        task("node-a", first.promise),
        task("node-b", second.promise),
        task("node-c", third.promise),
      ],
      {
        runScope: scope,
        acceptOutcome: async outcome => {
          accepted.push(outcome);
        },
      },
    );

    third.resolve(createResultNode("node-c"));
    first.resolve(createResultNode("node-a"));
    second.resolve(createResultNode("node-b"));
    const outcomes = await settlement;

    expect(accepted.map(outcome => outcome.nodeId)).toEqual([
      "node-c",
      "node-a",
      "node-b",
    ]);
    expect(
      outcomes.map(outcome => [outcome.nodeId, outcome.settlementOrdinal]),
    ).toEqual([
      ["node-a", 2],
      ["node-b", 3],
      ["node-c", 1],
    ]);
    scope.dispose();
  });

  it("协调器终态写入拒绝时以原错误中止共享 Signal 和兄弟 Job", async () => {
    const fatalController = new AbortController();
    const scope = createAbsoluteRunDeadline({
      parentSignal: fatalController.signal,
      now: () => 0,
    });
    const completed = createDeferred<ResultGraphNode>();
    const sibling = createDeferred<ResultGraphNode>();
    const terminalWrite = createDeferred<void>();
    const settlement = settleNodeJobsUntilAbsoluteDeadline(
      [task("completed", completed.promise), task("sibling", sibling.promise)],
      {
        runScope: scope,
        acceptOutcome: () => terminalWrite.promise,
        abortRun: reason => fatalController.abort(reason),
      },
    );
    completed.resolve(createResultNode("completed"));
    await Promise.resolve();
    const sinkError = new Error("terminal sink failed");
    terminalWrite.reject(sinkError);

    await expect(settlement).rejects.toBe(sinkError);
    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBe(sinkError);
    sibling.reject(scope.signal.reason);
    await Promise.resolve();
    scope.dispose();
  });

  it("Timer 尚未回调但统一时钟已过期时同步形成 timed_out 快照", async () => {
    let nowMs = 0;
    const scope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: () => nowMs,
    });
    const pending: Deferred<ResultGraphNode> = createDeferred();
    nowMs = RUN_DEADLINE_MS;

    const outcomes = await settleNodeJobsUntilAbsoluteDeadline(
      [task("node-1", pending.promise)],
      { runScope: scope },
    );

    expect(outcomes).toEqual([
      {
        status: "timed_out",
        nodeId: "node-1",
        settlementOrdinal: 1,
        error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
      },
    ]);
    pending.resolve(createResultNode("node-1"));
    await Promise.resolve();
    scope.dispose();
  });

  it("Job 在绝对时间后才提交结果时由提交门禁归为 timed_out", async () => {
    let nowMs = 0;
    const scope = createAbsoluteRunDeadline({
      parentSignal: new AbortController().signal,
      now: () => nowMs,
    });
    const late = createDeferred<ResultGraphNode>();
    const settlement = settleNodeJobsUntilAbsoluteDeadline(
      [task("node-1", late.promise)],
      { runScope: scope },
    );
    // 先让 Settlement 完成入口检查并进入等待，再模拟事件循环跨过绝对截止点。
    await Promise.resolve();
    nowMs = RUN_DEADLINE_MS;
    late.resolve(createResultNode("node-1"));

    await expect(settlement).resolves.toEqual([
      {
        status: "timed_out",
        nodeId: "node-1",
        settlementOrdinal: 1,
        error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
      },
    ]);
    scope.dispose();
  });
});
