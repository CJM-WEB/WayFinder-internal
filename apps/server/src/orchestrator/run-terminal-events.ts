/**
 * 模块职责：协调已发布 GraphPlan 的 Node 终态、全图 URL 所有权与 complete。
 *
 * 关键边界：
 * - processNode 只发送状态并返回未仲裁 Outcome；本模块是唯一终态提交者；
 * - Outcome 在任何 await 前同步占据 GraphPlan Slot，只有连续前缀可以进入仲裁；
 * - URL 所有权按 GraphPlan / Node rank，终态发送则按同批 settlementOrdinal；
 * - complete 只消费同一批仲裁后 Outcome，增量事件与最终快照不会出现两套事实。
 */
import {
  AppErrorSchema,
  ResultGraphNodeSchema,
  StreamEventPayloadSchema,
  type AppError,
  type GraphPlan,
  type GraphPlanNode,
  type NodeJobOutcome,
  type ResultGraph,
  type StreamEventPayload,
} from "@wayfinder/contracts";

import type { NodeStatusEventPayload } from "../pipeline/process-node.js";
import type { AbsoluteRunDeadlineScope } from "./absolute-run-deadline.js";
import {
  buildResultGraph,
  type BuildResultGraphInput,
} from "./build-result-graph.js";
import { outcomeToResultNode } from "./outcome-to-result-node.js";
import { parseValidatedGraphPlanForRun } from "./resolve-graph-plan.js";

type TerminalNodePayload = Extract<
  StreamEventPayload,
  { type: "node.ready" | "node.partial" | "node.failed" }
>;

type RunLifecycleScope = Pick<
  AbsoluteRunDeadlineScope,
  "isDeadlineReason" | "requirePositiveRemainingMs" | "signal"
>;

type OutcomeSlot = {
  readonly planNode: GraphPlanNode;
  rawOutcome: NodeJobOutcome | undefined;
  acceptedOutcome: NodeJobOutcome | undefined;
  terminalWrite: Promise<void> | undefined;
  resolveTerminalWrite: (() => void) | undefined;
  rejectTerminalWrite: ((error: unknown) => void) | undefined;
};

export type CompleteRunWithTerminalEventsInput = Readonly<{
  runId: ResultGraph["runId"];
  query: ResultGraph["query"];
  meta: BuildResultGraphInput["meta"];
}>;

export type RunTerminalEventState = Readonly<{
  /** processNode 的唯一出口，只允许 searching / filtering。 */
  emitNodeStatus: (payload: NodeStatusEventPayload) => Promise<void>;
  /** Settlement 在首次 await 前调用；返回该 Node 仲裁后终态的真实写入 Promise。 */
  acceptOutcome: (outcome: NodeJobOutcome) => Promise<void>;
  /** 使用已经仲裁且已经安排终态写入的 Outcome 生成唯一 complete。 */
  complete: (
    input: CompleteRunWithTerminalEventsInput,
  ) => Promise<ResultGraph>;
}>;

export type CreateRunTerminalEventStateInput = Readonly<{
  plan: GraphPlan;
  runScope: RunLifecycleScope;
  emit: (payload: StreamEventPayload) => Promise<void>;
}>;

export type EmitRunFailedWithoutGraphPlanInput = Readonly<{
  error: AppError;
  runScope: RunLifecycleScope;
  emit: (payload: StreamEventPayload) => Promise<void>;
}>;

/** 用户取消永远原样退出；真正 Deadline 允许进入 Node 收敛或 pre-plan failure。 */
function throwIfUserCancelled(runScope: RunLifecycleScope): void {
  if (
    runScope.signal.aborted &&
    !runScope.isDeadlineReason(runScope.signal.reason)
  ) {
    throw runScope.signal.reason;
  }
}

function createNoUniqueResourceOutcome(
  outcome: Extract<NodeJobOutcome, { status: "fulfilled" }>,
): NodeJobOutcome {
  return {
    status: "rejected",
    nodeId: outcome.nodeId,
    settlementOrdinal: outcome.settlementOrdinal,
    error: Object.assign(new Error("NO_UNIQUE_RESOURCE_AVAILABLE"), {
      code: "NO_UNIQUE_RESOURCE_AVAILABLE" as const,
      retryable: false,
    }),
  };
}

/**
 * 只对完整 canonicalUrl 做精确 first-seen 仲裁。不同协议、hostname、Path、斜杠、
 * Query 或语言版本都不会在本层被推测为相同页面。
 */
function arbitrateOutcome(
  outcome: NodeJobOutcome,
  ownedCanonicalUrls: Set<string>,
): NodeJobOutcome {
  if (outcome.status !== "fulfilled") return outcome;

  const orderedResources = [...outcome.value.resources].sort(
    (left, right) => left.rank - right.rank,
  );
  const survivingResources = orderedResources.filter(resource => {
    if (ownedCanonicalUrls.has(resource.canonicalUrl)) return false;
    ownedCanonicalUrls.add(resource.canonicalUrl);
    return true;
  });
  if (survivingResources.length === 0) {
    return createNoUniqueResourceOutcome(outcome);
  }

  const value = ResultGraphNodeSchema.parse({
    ...outcome.value,
    resources: survivingResources.map((resource, index) => ({
      ...resource,
      rank: index + 1,
    })),
  });
  if (value.status === "failed") {
    throw new TypeError("全图仲裁不能把非空 Node 转换为 failed");
  }
  return { ...outcome, value };
}

function outcomeToTerminalPayload(
  planNode: GraphPlanNode,
  outcome: NodeJobOutcome,
): TerminalNodePayload {
  const node = outcomeToResultNode(planNode, outcome);
  if (node.status === "failed") {
    return StreamEventPayloadSchema.parse({
      type: "node.failed",
      nodeId: node.id,
      error: node.error,
    }) as TerminalNodePayload;
  }
  return StreamEventPayloadSchema.parse({
    type: node.status === "partial" ? "node.partial" : "node.ready",
    nodeId: node.id,
    resources: node.resources,
    warnings: node.warnings,
  }) as TerminalNodePayload;
}

/**
 * 创建已发布 GraphPlan 的唯一终态账本。计划会再次通过最终 Validator 并被冻结，
 * 避免调用方随后改写 Node 顺序，从而改变 URL 所有权。
 */
export function createRunTerminalEventState(
  input: CreateRunTerminalEventStateInput,
): RunTerminalEventState {
  const plan = parseValidatedGraphPlanForRun(input.plan);
  const slots: OutcomeSlot[] = plan.nodes.map(planNode => ({
    planNode,
    rawOutcome: undefined,
    acceptedOutcome: undefined,
    terminalWrite: undefined,
    resolveTerminalWrite: undefined,
    rejectTerminalWrite: undefined,
  }));
  const slotByNodeId = new Map(slots.map(slot => [slot.planNode.id, slot]));
  const ownedCanonicalUrls = new Set<string>();
  let nextPrefixIndex = 0;
  let lastSettlementOrdinal = 0;
  let writeTail: Promise<void> = Promise.resolve();
  let phase: "nodes" | "finalizing" | "closed" | "failed" = "nodes";
  let firstWriteError: unknown;
  let removeRunAbortListener = (): void => undefined;

  /**
   * 任一非 Deadline 终止都会关闭所有已占位的 deferred，避免后序 Node 因计划前缀
   * 尚未形成而永久悬挂。Deadline 仍由 Settlement 补齐 timed_out 后正常释放前缀。
   */
  const failPending = (error: unknown): void => {
    if (phase === "failed" || phase === "closed") return;
    firstWriteError = error;
    phase = "failed";
    removeRunAbortListener();
    for (const slot of slots) {
      slot.rejectTerminalWrite?.(error);
    }
  };

  const assertWritable = (): void => {
    if (phase === "failed") throw firstWriteError;
    if (phase !== "nodes") {
      throw new TypeError("Run 终态已经开始收敛或完成");
    }
  };

  const writePayload = (payload: StreamEventPayload): Promise<void> => {
    let writePromise: Promise<void>;
    try {
      writePromise = input.emit(payload);
    } catch (error: unknown) {
      failPending(error);
      throw error;
    }
    void writePromise.catch((error: unknown) => {
      failPending(error);
    });
    return writePromise;
  };

  const abortPending = (): void => {
    const reason = input.runScope.signal.reason;
    if (!input.runScope.isDeadlineReason(reason)) {
      failPending(reason);
    }
  };
  if (input.runScope.signal.aborted) {
    abortPending();
  } else {
    input.runScope.signal.addEventListener("abort", abortPending, {
      once: true,
    });
    removeRunAbortListener = () => {
      input.runScope.signal.removeEventListener("abort", abortPending);
    };
  }

  const emitNodeStatus = async (
    payload: NodeStatusEventPayload,
  ): Promise<void> => {
    assertWritable();
    input.runScope.signal.throwIfAborted();
    const parsed = StreamEventPayloadSchema.parse(payload);
    if (parsed.type !== "node.status") {
      throw new TypeError("Run 状态出口只接受 node.status");
    }
    const slot = slotByNodeId.get(parsed.nodeId);
    if (slot === undefined) {
      throw new TypeError(`Node 状态引用了未计划的 Node：${parsed.nodeId}`);
    }
    if (slot.rawOutcome !== undefined) {
      throw new TypeError(`Node 终态后不能继续发送状态：${parsed.nodeId}`);
    }
    input.runScope.requirePositiveRemainingMs();
    await writePayload(parsed);
  };

  /**
   * 一个连续前缀可能由后到的前序 Node 一次释放多个 Slot。先按 GraphPlan/rank完成
   * 全部所有权计算，再按 ordinal 排队写入，不能让发送顺序反向影响所有权。
   */
  const releaseContinuousPrefix = (): void => {
    const released: OutcomeSlot[] = [];
    while (nextPrefixIndex < slots.length) {
      const slot = slots[nextPrefixIndex]!;
      if (slot.rawOutcome === undefined) break;
      slot.acceptedOutcome = arbitrateOutcome(
        slot.rawOutcome,
        ownedCanonicalUrls,
      );
      released.push(slot);
      nextPrefixIndex += 1;
    }

    released.sort(
      (left, right) =>
        left.rawOutcome!.settlementOrdinal -
        right.rawOutcome!.settlementOrdinal,
    );
    for (const slot of released) {
      const accepted = slot.acceptedOutcome;
      if (accepted === undefined) {
        throw new TypeError("已释放 Slot 缺少仲裁结果");
      }
      const payload = outcomeToTerminalPayload(slot.planNode, accepted);
      const scheduledWrite = writeTail.then(() => writePayload(payload));
      writeTail = scheduledWrite;
      void scheduledWrite.then(
        () => slot.resolveTerminalWrite?.(),
        (error: unknown) => slot.rejectTerminalWrite?.(error),
      );
    }
  };

  const acceptOutcome = (outcome: NodeJobOutcome): Promise<void> => {
    assertWritable();
    throwIfUserCancelled(input.runScope);
    const slot = slotByNodeId.get(outcome.nodeId);
    if (slot === undefined) {
      throw new TypeError(`Node outcome 引用了未计划的 Node：${outcome.nodeId}`);
    }
    if (slot.rawOutcome !== undefined) {
      throw new TypeError(`Node outcome 重复：${outcome.nodeId}`);
    }
    if (
      outcome.status === "fulfilled" &&
      outcome.value.id !== slot.planNode.id
    ) {
      throw new TypeError(`fulfilled Node 身份与计划不一致：${outcome.nodeId}`);
    }
    if (
      !Number.isSafeInteger(outcome.settlementOrdinal) ||
      outcome.settlementOrdinal !== lastSettlementOrdinal + 1
    ) {
      throw new TypeError("settlementOrdinal 必须从 1 开始且严格连续递增");
    }

    let resolveTerminalWrite = (): void => undefined;
    let rejectTerminalWrite: (error: unknown) => void = () => undefined;
    const terminalWrite = new Promise<void>((resolve, reject) => {
      resolveTerminalWrite = resolve;
      rejectTerminalWrite = reject;
    });
    // 若后续同步仲裁抛错，调用方拿不到返回值；预先观察原 Promise 可避免未处理拒绝，
    // 同时不改变正常调用方拿到的 terminalWrite 拒绝语义。
    void terminalWrite.catch(() => undefined);
    // Slot 与序号必须在任何异步写入前同步占用，封闭重复终态和 Deadline 竞态。
    lastSettlementOrdinal = outcome.settlementOrdinal;
    slot.rawOutcome = outcome;
    slot.terminalWrite = terminalWrite;
    slot.resolveTerminalWrite = resolveTerminalWrite;
    slot.rejectTerminalWrite = rejectTerminalWrite;
    try {
      releaseContinuousPrefix();
    } catch (error: unknown) {
      failPending(error);
      throw error;
    }
    return terminalWrite;
  };

  const complete = async (
    completion: CompleteRunWithTerminalEventsInput,
  ): Promise<ResultGraph> => {
    try {
      assertWritable();
      throwIfUserCancelled(input.runScope);
      const acceptedOutcomes = slots.map(slot => {
        if (
          slot.acceptedOutcome === undefined ||
          slot.terminalWrite === undefined
        ) {
          throw new TypeError(`计划 Node 尚未完成仲裁：${slot.planNode.id}`);
        }
        return slot.acceptedOutcome;
      });
      const result = buildResultGraph({
        ...completion,
        plan,
        outcomes: acceptedOutcomes,
      });

      phase = "finalizing";
      await Promise.all(slots.map(slot => slot.terminalWrite!));
      throwIfUserCancelled(input.runScope);
      const completePayload = StreamEventPayloadSchema.parse({
        type: "complete",
        data: {
          finalStatus: result.meta.partial ? "partial" : "complete",
          result,
        },
      });
      if (completePayload.type !== "complete") {
        throw new TypeError("Run 收敛只能生成 complete");
      }
      await writePayload(completePayload);
      phase = "closed";
      removeRunAbortListener();
      return result;
    } catch (error: unknown) {
      failPending(error);
      throw error;
    }
  };

  return Object.freeze({ emitNodeStatus, acceptOutcome, complete });
}

/**
 * 在 GraphPlan 尚未形成时发送唯一公共失败。真正 Deadline 与用户取消只能通过
 * Run Scope 私有 reason 身份区分，绝不能读取 Error name 或 message 猜测来源。
 */
export async function emitRunFailedWithoutGraphPlan(
  input: EmitRunFailedWithoutGraphPlanInput,
): Promise<void> {
  let deadlineExpired = false;
  try {
    input.runScope.requirePositiveRemainingMs();
  } catch (error: unknown) {
    if (!input.runScope.isDeadlineReason(error)) throw error;
    deadlineExpired = true;
  }
  throwIfUserCancelled(input.runScope);

  const error = deadlineExpired
    ? { code: "RUN_DEADLINE_EXCEEDED" as const, retryable: true as const }
    : AppErrorSchema.parse(input.error);
  if (error.code === "REQUEST_ABORTED") {
    throw new TypeError("用户取消不能作为 Streaming run.failed 发送");
  }
  const payload = StreamEventPayloadSchema.parse({
    type: "run.failed",
    error,
  });
  throwIfUserCancelled(input.runScope);
  try {
    await input.emit(payload);
  } catch (writeError: unknown) {
    throwIfUserCancelled(input.runScope);
    throw writeError;
  }
}
