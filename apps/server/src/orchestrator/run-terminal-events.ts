/**
 * 模块职责：协调已发布 GraphPlan 的 Node 终态与 complete，并提供无计划时的 run.failed 出口。
 *
 * 关键边界：
 * - 每个计划 Node 的终态在首次 await 前原子占位，重复、混发和未知 Node 均先于底层写入拒绝；
 * - Deadline 快照若撞上已经接纳但仍在背压中的终态，保留该终态而不合成第二个 failed；
 * - complete 只在全部终态写入成功后发送；用户取消、Sink 故障和未知程序错误不伪造成 run.failed；
 * - 本模块不启动 Node、不结算 Promise，也不处理客户端 sequence 或旧 runId。
 */
import { isDeepStrictEqual } from "node:util";

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

import type { NodeStreamEventPayload } from "../pipeline/process-node.js";
import type { AbsoluteRunDeadlineScope } from "./absolute-run-deadline.js";
import {
  buildResultGraph,
  type BuildResultGraphInput,
} from "./build-result-graph.js";
import { parseValidatedGraphPlanForRun } from "./resolve-graph-plan.js";

type TerminalNodePayload = Extract<
  NodeStreamEventPayload,
  { type: "node.ready" | "node.partial" | "node.failed" }
>;

type RunLifecycleScope = Pick<
  AbsoluteRunDeadlineScope,
  "isDeadlineReason" | "requirePositiveRemainingMs" | "signal"
>;

type TerminalRecord = {
  readonly payload: TerminalNodePayload;
  readonly outcome: NodeJobOutcome;
  writePromise: Promise<void> | undefined;
};

export type CompleteRunWithTerminalEventsInput = Readonly<{
  runId: ResultGraph["runId"];
  query: ResultGraph["query"];
  outcomes: readonly NodeJobOutcome[];
  meta: BuildResultGraphInput["meta"];
}>;

export type RunTerminalEventState = Readonly<{
  /** 作为 processNode 的唯一 Event Sink，状态事件与终态事件都经过同一 Node 归属门禁。 */
  emitNode: (payload: NodeStreamEventPayload) => Promise<void>;
  /** 协调 Deadline Outcome、构建 ResultGraph，并在全部 Node 终态后发送 complete。 */
  complete: (
    input: CompleteRunWithTerminalEventsInput,
  ) => Promise<ResultGraph>;
}>;

export type CreateRunTerminalEventStateInput = Readonly<{
  /** 必须是已经通过 query.analysis → graph.plan 成功发布的最终计划。 */
  plan: GraphPlan;
  runScope: RunLifecycleScope;
  emit: (payload: StreamEventPayload) => Promise<void>;
}>;

export type EmitRunFailedWithoutGraphPlanInput = Readonly<{
  error: AppError;
  runScope: RunLifecycleScope;
  emit: (payload: StreamEventPayload) => Promise<void>;
}>;

function createRejectedOutcome(
  nodeId: string,
  payload: Extract<TerminalNodePayload, { type: "node.failed" }>,
): NodeJobOutcome {
  if (
    payload.error.code === "RUN_DEADLINE_EXCEEDED" ||
    payload.error.code === "REQUEST_ABORTED"
  ) {
    throw new TypeError("processNode 不能提交 Deadline 或用户取消终态");
  }

  return {
    status: "rejected",
    nodeId,
    error: Object.assign(new Error(payload.error.code), {
      code: payload.error.code,
      retryable: payload.error.retryable,
    }),
  };
}

/** 从已经通过 Event Contract 的终态建立可供 ResultGraph 使用的同源 Outcome。 */
function terminalPayloadToOutcome(
  planNode: GraphPlanNode,
  payload: TerminalNodePayload,
): NodeJobOutcome {
  if (payload.type === "node.failed") {
    return createRejectedOutcome(planNode.id, payload);
  }

  return {
    status: "fulfilled",
    nodeId: planNode.id,
    value: ResultGraphNodeSchema.parse({
      ...planNode,
      status: payload.type === "node.partial" ? "partial" : "ready",
      resources: payload.resources,
      warnings: payload.warnings,
    }),
  };
}

function assertObservedOutcomeMatchesTerminal(
  observed: NodeJobOutcome,
  accepted: NodeJobOutcome,
): void {
  if (observed.status === "timed_out") {
    // Deadline 只看见 Promise 尚未结算；已经同步占位的终态拥有更精确的先发生事实。
    return;
  }

  if (observed.status !== accepted.status) {
    throw new TypeError(`Node outcome 与已接受终态冲突：${observed.nodeId}`);
  }

  if (observed.status === "fulfilled" && accepted.status === "fulfilled") {
    if (!isDeepStrictEqual(observed.value, accepted.value)) {
      throw new TypeError(`Node 结果与已接受终态内容冲突：${observed.nodeId}`);
    }
    return;
  }

  if (observed.status === "rejected" && accepted.status === "rejected") {
    if (
      observed.error.code !== accepted.error.code ||
      observed.error.retryable !== accepted.error.retryable
    ) {
      throw new TypeError(`Node 错误与已接受终态内容冲突：${observed.nodeId}`);
    }
  }
}

/** 用户取消永远原样退出；真正 Deadline 允许进入 Node 收敛或 pre-plan failure。 */
function throwIfUserCancelled(runScope: RunLifecycleScope): void {
  if (
    runScope.signal.aborted &&
    !runScope.isDeadlineReason(runScope.signal.reason)
  ) {
    throw runScope.signal.reason;
  }
}

/**
 * 创建已发布 GraphPlan 的唯一终态账本。
 *
 * 工厂会再次执行最终计划门禁并取得快照，避免调用方随后修改 Node 集合；计划事件本身
 * 必须已由计划事件阶段成功发送，失败路径不能创建本状态并把半条计划流伪装为可完成 Run。
 */
export function createRunTerminalEventState(
  input: CreateRunTerminalEventStateInput,
): RunTerminalEventState {
  const plan = parseValidatedGraphPlanForRun(input.plan);
  const planNodesById = new Map(plan.nodes.map(node => [node.id, node]));
  const terminalByNodeId = new Map<string, TerminalRecord>();
  let phase: "nodes" | "finalizing" | "closed" | "failed" = "nodes";
  let firstWriteError: unknown;

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
      firstWriteError ??= error;
      phase = "failed";
      throw error;
    }

    // 立即安装 rejection 观察器；调用方仍会收到原 Promise 的同一个拒绝原因。
    void writePromise.catch((error: unknown) => {
      firstWriteError ??= error;
      phase = "failed";
    });
    return writePromise;
  };

  const emitNode = async (
    payload: NodeStreamEventPayload,
  ): Promise<void> => {
    assertWritable();
    input.runScope.signal.throwIfAborted();

    const parsed = StreamEventPayloadSchema.parse(payload);
    if (
      parsed.type !== "node.status" &&
      parsed.type !== "node.ready" &&
      parsed.type !== "node.partial" &&
      parsed.type !== "node.failed"
    ) {
      throw new TypeError("Run 终态账本只接受 Node 事件");
    }

    const planNode = planNodesById.get(parsed.nodeId);
    if (planNode === undefined) {
      throw new TypeError(`Node 事件引用了未计划的 Node：${parsed.nodeId}`);
    }

    if (parsed.type === "node.status") {
      if (terminalByNodeId.has(parsed.nodeId)) {
        throw new TypeError(`Node 终态后不能继续发送状态：${parsed.nodeId}`);
      }
      // Timer 回调可能被同步工作延迟；写入前主动读取绝对时钟才能封闭该窗口。
      input.runScope.requirePositiveRemainingMs();
      await writePayload(parsed);
      return;
    }

    if (terminalByNodeId.has(parsed.nodeId)) {
      throw new TypeError(`Node 终态重复：${parsed.nodeId}`);
    }

    const acceptedOutcome = terminalPayloadToOutcome(planNode, parsed);
    // 终态形状与归属均已验证；占位前再读绝对时钟，拒绝 Timer 未回调时的迟到结果。
    input.runScope.requirePositiveRemainingMs();
    // 占位先于底层 Emit 与任何 await，封闭同一轮并发重复及 Deadline 竞态。
    const record: TerminalRecord = {
      payload: parsed,
      outcome: acceptedOutcome,
      writePromise: undefined,
    };
    terminalByNodeId.set(parsed.nodeId, record);
    record.writePromise = writePayload(parsed);
    await record.writePromise;
  };

  const complete = async (
    completion: CompleteRunWithTerminalEventsInput,
  ): Promise<ResultGraph> => {
    assertWritable();
    throwIfUserCancelled(input.runScope);

    // 先复用 Builder 完整验证原 Outcome 双射，任何结构错误都不得产生部分终态副作用。
    buildResultGraph({ ...completion, plan });
    const outcomeByNodeId = new Map(
      completion.outcomes.map(outcome => [outcome.nodeId, outcome]),
    );
    const reconciledOutcomes: NodeJobOutcome[] = [];
    const synthesizedRecords: TerminalRecord[] = [];

    for (const planNode of plan.nodes) {
      const observed = outcomeByNodeId.get(planNode.id);
      if (observed === undefined) {
        // 前置 Builder 已保证不会发生；保留防御分支避免未来重构静默放宽。
        throw new TypeError(`计划 Node 缺少 outcome：${planNode.id}`);
      }

      const accepted = terminalByNodeId.get(planNode.id);
      if (accepted !== undefined) {
        assertObservedOutcomeMatchesTerminal(observed, accepted.outcome);
        reconciledOutcomes.push(accepted.outcome);
        continue;
      }

      if (observed.status !== "timed_out") {
        throw new TypeError(`已结算 Node 缺少终态事件：${planNode.id}`);
      }

      const payload = StreamEventPayloadSchema.parse({
        type: "node.failed",
        nodeId: planNode.id,
        error: observed.error,
      });
      if (payload.type !== "node.failed") {
        throw new TypeError("Deadline 只能合成 node.failed");
      }
      const record: TerminalRecord = {
        payload,
        outcome: observed,
        writePromise: undefined,
      };
      terminalByNodeId.set(planNode.id, record);
      synthesizedRecords.push(record);
      reconciledOutcomes.push(observed);
    }

    const result = buildResultGraph({
      ...completion,
      plan,
      outcomes: reconciledOutcomes,
    });

    // 所有检查与缺失终态占位完成后再封门；迟到 Provider 无法插入合成失败之间。
    phase = "finalizing";
    throwIfUserCancelled(input.runScope);
    for (const record of synthesizedRecords) {
      record.writePromise = writePayload(record.payload);
    }

    const terminalWrites = [...terminalByNodeId.values()].map(record => {
      if (record.writePromise === undefined) {
        throw new TypeError("Node 终态缺少写入 Promise");
      }
      return record.writePromise;
    });
    await Promise.all(terminalWrites);
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

    // 终态在访问底层 Writer 前同步封门，使迟到 Node Event 即刻失败。
    phase = "closed";
    await writePayload(completePayload);
    return result;
  };

  return Object.freeze({ emitNode, complete });
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
    // 与 Node 终态使用同一绝对时钟门禁，不依赖 Timer 已经获得执行权。
    input.runScope.requirePositiveRemainingMs();
  } catch (error: unknown) {
    if (!input.runScope.isDeadlineReason(error)) {
      // 用户取消或 Scope 故障必须保持原始 reason，不能改写为 run.failed。
      throw error;
    }
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
  // Schema 校验期间也可能触发外部取消；接纳终态前再次确认来源。
  throwIfUserCancelled(input.runScope);
  try {
    await input.emit(payload);
  } catch (error: unknown) {
    // 背压期间先发生的用户取消不得被随后的 Writer 错误覆盖。
    throwIfUserCancelled(input.runScope);
    throw error;
  }
}
