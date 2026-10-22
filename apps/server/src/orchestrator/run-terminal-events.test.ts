/**
 * 测试职责：冻结 Run 级 Node exactly-once、complete 门禁和无 GraphPlan 失败分流。
 *
 * 重点竞态：Node 终态已同步占位但写入仍受背压时，Deadline Outcome 不能再合成 failed，
 * 最终 ResultGraph 也必须保留先发生的终态。客户端 Reader 与旧 runId 防护属于 WAY-71+。
 */
import {
  GraphPlanSchema,
  ResultGraphNodeSchema,
  type GraphPlan,
  type NodeJobOutcome,
  type ResultGraph,
  type StreamEvent,
  type StreamEventPayload,
} from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import { createDeferred } from "../../../../tests/support/test-infrastructure.mjs";
import type { NodeStreamEventPayload } from "../pipeline/process-node.js";
import { createRunEventWriter } from "../streaming/run-event-writer.js";
import {
  createRunTerminalEventState,
  emitRunFailedWithoutGraphPlan,
  type CompleteRunWithTerminalEventsInput,
} from "./run-terminal-events.js";

const QUERY: ResultGraph["query"] = {
  raw: "学习 TypeScript",
  normalized: "学习 typescript",
  language: "zh-CN",
};

const META: CompleteRunWithTerminalEventsInput["meta"] = {
  createdAt: "2026-10-22T08:00:00Z",
  providersUsed: ["fake-search"],
  timingMs: { total: 180 },
};

function createPlan(nodeIds: readonly string[] = ["node-a"]): GraphPlan {
  return GraphPlanSchema.parse({
    analysis: {
      intent: "learn",
      topic: "TypeScript",
      freshnessSensitive: false,
      ambiguityLevel: "low",
      broadSearchQueries: [],
      strategy: "plan_first",
      presentationMode: "compact",
    },
    nodes: nodeIds.map((id, index) => ({
      id,
      title: `节点 ${id}`,
      description: `处理 ${id}`,
      nodeType: "primary",
      layer: index,
      status: "planned",
      searchPlan: {
        queries: [`query ${id}`],
        maxResults: 20,
        rankingProfile: "knowledge",
        providerHints: ["general"],
      },
    })),
    edges: nodeIds.slice(1).map((id, index) => ({
      id: `edge-${index + 1}`,
      source: nodeIds[index]!,
      target: id,
      type: "recommended_next",
    })),
  });
}

function createResource(nodeId: string) {
  return {
    id: `resource-${nodeId}`,
    title: `资源 ${nodeId}`,
    url: `https://example.com/${nodeId}`,
    canonicalUrl: `https://example.com/${nodeId}`,
    domain: "example.com",
    sourceType: "documentation",
    summary: `${nodeId} 摘要`,
    whySelected: `${nodeId} 与节点相关`,
    rank: 1,
    searchProvider: "fake-search",
  };
}

function terminalPayload(
  nodeId: string,
  status: "ready" | "partial",
): Extract<
  NodeStreamEventPayload,
  { type: "node.ready" | "node.partial" }
> {
  return status === "ready"
    ? {
        type: "node.ready",
        nodeId,
        resources: [createResource(nodeId)],
        warnings: [],
      }
    : {
        type: "node.partial",
        nodeId,
        resources: [createResource(nodeId)],
        warnings: ["RERANK_FAILED"],
      };
}

function successfulOutcome(
  plan: GraphPlan,
  nodeId: string,
  status: "ready" | "partial",
): NodeJobOutcome {
  const planNode = plan.nodes.find(node => node.id === nodeId);
  if (planNode === undefined) throw new TypeError("测试计划缺少 Node");

  return {
    status: "fulfilled",
    nodeId,
    value: ResultGraphNodeSchema.parse({
      ...planNode,
      status,
      resources: [createResource(nodeId)],
      warnings: status === "partial" ? ["RERANK_FAILED"] : [],
    }),
  };
}

function rejectedOutcome(
  nodeId: string,
  code: "SEARCH_PROVIDER_FAILED" | "RERANK_FAILED" =
    "SEARCH_PROVIDER_FAILED",
  retryable = true,
): NodeJobOutcome {
  return {
    status: "rejected",
    nodeId,
    error: Object.assign(new Error("内部 Provider 细节"), {
      code,
      retryable,
    }),
  };
}

function timedOutOutcome(nodeId: string): NodeJobOutcome {
  return {
    status: "timed_out",
    nodeId,
    error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
  };
}

function createRunScope() {
  const controller = new AbortController();
  const deadlineReason = new DOMException(
    "Run deadline exceeded",
    "TimeoutError",
  );
  let clockExpired = false;
  return {
    runScope: {
      signal: controller.signal,
      isDeadlineReason: (reason: unknown) => reason === deadlineReason,
      requirePositiveRemainingMs: () => {
        controller.signal.throwIfAborted();
        if (clockExpired) {
          controller.abort(deadlineReason);
          controller.signal.throwIfAborted();
        }
        return 20_000;
      },
    },
    deadline: () => controller.abort(deadlineReason),
    /** 模拟墙上时钟已过期，但事件循环还没有执行 Timer 回调。 */
    expireWithoutTimer: () => {
      clockExpired = true;
    },
    cancel: (reason: unknown) => controller.abort(reason),
  };
}

function completeInput(outcomes: readonly NodeJobOutcome[]) {
  return { runId: "run-70", query: QUERY, outcomes, meta: META };
}

describe("createRunTerminalEventState", () => {
  it("混合结果中每个 Node 只有一个终态且 complete 最后发送", async () => {
    const plan = createPlan(["node-a", "node-b", "node-c"]);
    const scope = createRunScope();
    const payloads: StreamEventPayload[] = [];
    const state = createRunTerminalEventState({
      plan,
      runScope: scope.runScope,
      emit: async payload => {
        payloads.push(structuredClone(payload));
      },
    });

    await state.emitNode(terminalPayload("node-b", "partial"));
    await state.emitNode({
      type: "node.failed",
      nodeId: "node-c",
      error: { code: "SEARCH_PROVIDER_FAILED", retryable: true },
    });
    await state.emitNode(terminalPayload("node-a", "ready"));
    const result = await state.complete(
      completeInput([
        rejectedOutcome("node-c"),
        successfulOutcome(plan, "node-a", "ready"),
        successfulOutcome(plan, "node-b", "partial"),
      ]),
    );

    expect(payloads.map(payload => payload.type)).toEqual([
      "node.partial",
      "node.failed",
      "node.ready",
      "complete",
    ]);
    expect(result.graph.nodes.map(node => [node.id, node.status])).toEqual([
      ["node-a", "ready"],
      ["node-b", "partial"],
      ["node-c", "failed"],
    ]);
    expect(result.meta.partial).toBe(true);
    expect(payloads.at(-1)).toMatchObject({
      type: "complete",
      data: { finalStatus: "partial", result },
    });
  });

  it("全部 ready 时只发送一个 complete 并派生 complete finalStatus", async () => {
    const plan = createPlan(["node-a", "node-b"]);
    const scope = createRunScope();
    const payloads: StreamEventPayload[] = [];
    const state = createRunTerminalEventState({
      plan,
      runScope: scope.runScope,
      emit: async payload => {
        payloads.push(payload);
      },
    });

    await Promise.all(
      plan.nodes.map(node => state.emitNode(terminalPayload(node.id, "ready"))),
    );
    await state.complete(
      completeInput(
        plan.nodes.map(node => successfulOutcome(plan, node.id, "ready")),
      ),
    );

    expect(payloads.at(-1)).toMatchObject({
      type: "complete",
      data: { finalStatus: "complete" },
    });
    expect(payloads.filter(payload => payload.type === "complete")).toHaveLength(
      1,
    );
  });

  it.each([
    ["重复 ready", terminalPayload("node-a", "ready")],
    [
      "混发 failed",
      {
        type: "node.failed",
        nodeId: "node-a",
        error: { code: "SEARCH_PROVIDER_FAILED", retryable: true },
      } satisfies NodeStreamEventPayload,
    ],
  ])("在底层写入前拒绝同一 Node 的%s", async (_name, duplicate) => {
    const scope = createRunScope();
    const emit = vi.fn(async (payload: StreamEventPayload) => {
      void payload;
    });
    const state = createRunTerminalEventState({
      plan: createPlan(),
      runScope: scope.runScope,
      emit,
    });

    await state.emitNode(terminalPayload("node-a", "ready"));
    await expect(state.emitNode(duplicate)).rejects.toThrow(
      "Node 终态重复：node-a",
    );
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("拒绝未知 Node 且不访问底层 Writer", async () => {
    const scope = createRunScope();
    const emit = vi.fn(async (payload: StreamEventPayload) => {
      void payload;
    });
    const state = createRunTerminalEventState({
      plan: createPlan(),
      runScope: scope.runScope,
      emit,
    });

    await expect(
      state.emitNode(terminalPayload("node-unknown", "ready")),
    ).rejects.toThrow("Node 事件引用了未计划的 Node");
    expect(emit).not.toHaveBeenCalled();
  });

  it("缺少已结算 Node 终态时拒绝 complete", async () => {
    const plan = createPlan();
    const scope = createRunScope();
    const emit = vi.fn(async (payload: StreamEventPayload) => {
      void payload;
    });
    const state = createRunTerminalEventState({
      plan,
      runScope: scope.runScope,
      emit,
    });

    await expect(
      state.complete(
        completeInput([successfulOutcome(plan, "node-a", "ready")]),
      ),
    ).rejects.toThrow("已结算 Node 缺少终态事件：node-a");
    expect(emit).not.toHaveBeenCalled();
  });

  it("只为真正未提交终态的 timed_out Node 合成 failed 后 complete", async () => {
    const plan = createPlan(["node-a", "node-b"]);
    const scope = createRunScope();
    scope.deadline();
    const payloads: StreamEventPayload[] = [];
    const state = createRunTerminalEventState({
      plan,
      runScope: scope.runScope,
      emit: async payload => {
        payloads.push(payload);
      },
    });

    const result = await state.complete(
      completeInput(plan.nodes.map(node => timedOutOutcome(node.id))),
    );

    expect(payloads.map(payload => payload.type)).toEqual([
      "node.failed",
      "node.failed",
      "complete",
    ]);
    expect(
      payloads.slice(0, 2).map(payload =>
        payload.type === "node.failed" ? payload.nodeId : "unexpected",
      ),
    ).toEqual(["node-a", "node-b"]);
    expect(result.graph.nodes.every(node => node.status === "failed")).toBe(
      true,
    );
  });

  it("Deadline 保留已接纳但仍在背压中的 ready，并在其写完后 complete", async () => {
    const plan = createPlan();
    const scope = createRunScope();
    const firstWrite = createDeferred<void>();
    const wireEvents: StreamEvent[] = [];
    const writer = createRunEventWriter({
      runId: "run-70",
      connectionSignal: new AbortController().signal,
      now: () => Date.parse("2026-10-22T08:00:00Z"),
      writeEvent: async event => {
        wireEvents.push(event);
        if (event.type === "node.ready") await firstWrite.promise;
      },
    });
    const state = createRunTerminalEventState({
      plan,
      runScope: scope.runScope,
      emit: writer.emit,
    });

    const readyWrite = state.emitNode(terminalPayload("node-a", "ready"));
    scope.deadline();
    const completion = state.complete(
      completeInput([timedOutOutcome("node-a")]),
    );
    await Promise.resolve();

    expect(wireEvents.map(event => event.type)).toEqual(["node.ready"]);
    firstWrite.resolve();
    await readyWrite;
    const result = await completion;
    await writer.close();

    expect(wireEvents.map(event => event.type)).toEqual([
      "node.ready",
      "complete",
    ]);
    expect(wireEvents.map(event => event.sequence)).toEqual([1, 2]);
    expect(result.graph.nodes[0]?.status).toBe("ready");
    expect(result.meta.partial).toBe(false);
  });

  it("Timer 延迟时拒绝过期 ready，随后只为 timed_out 合成 failed", async () => {
    const scope = createRunScope();
    const payloads: StreamEventPayload[] = [];
    const state = createRunTerminalEventState({
      plan: createPlan(),
      runScope: scope.runScope,
      emit: async payload => {
        payloads.push(payload);
      },
    });
    scope.expireWithoutTimer();

    await expect(
      state.emitNode(terminalPayload("node-a", "ready")),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    const result = await state.complete(
      completeInput([timedOutOutcome("node-a")]),
    );

    expect(payloads.map(payload => payload.type)).toEqual([
      "node.failed",
      "complete",
    ]);
    expect(result.graph.nodes[0]?.status).toBe("failed");
  });

  it.each([
    ["status", "partial" as const],
    ["content", "ready" as const],
  ])("已接纳终态与 observed %s 冲突时拒绝 complete", async (kind, status) => {
    const plan = createPlan();
    const scope = createRunScope();
    const payloads: StreamEventPayload[] = [];
    const state = createRunTerminalEventState({
      plan,
      runScope: scope.runScope,
      emit: async payload => {
        payloads.push(payload);
      },
    });
    await state.emitNode(terminalPayload("node-a", "ready"));
    const conflicting = successfulOutcome(plan, "node-a", status);
    const conflictingValue =
      conflicting.status === "fulfilled"
        ? {
            ...conflicting.value,
            resources:
              kind === "content"
                ? conflicting.value.resources.map((resource, index) =>
                    index === 0
                      ? {
                          ...resource,
                          summary: "与已发送终态不同的摘要",
                        }
                      : resource,
                  )
                : conflicting.value.resources,
            warnings: conflicting.value.warnings,
          }
        : undefined;

    await expect(
      state.complete(
        completeInput([
          conflicting.status === "fulfilled"
            ? {
                ...conflicting,
                value: conflictingValue!,
              }
            : conflicting,
        ]),
      ),
    ).rejects.toThrow("Node");
    expect(payloads.map(payload => payload.type)).toEqual(["node.ready"]);
  });

  it("已接纳 ready 与 observed rejected 类别冲突时拒绝 complete", async () => {
    const scope = createRunScope();
    const payloads: StreamEventPayload[] = [];
    const state = createRunTerminalEventState({
      plan: createPlan(),
      runScope: scope.runScope,
      emit: async payload => {
        payloads.push(payload);
      },
    });
    await state.emitNode(terminalPayload("node-a", "ready"));

    await expect(
      state.complete(completeInput([rejectedOutcome("node-a")])),
    ).rejects.toThrow("Node outcome 与已接受终态冲突：node-a");
    expect(payloads.map(payload => payload.type)).toEqual(["node.ready"]);
  });

  it("已接纳 failed 与 observed 错误内容冲突时拒绝 complete", async () => {
    const scope = createRunScope();
    const payloads: StreamEventPayload[] = [];
    const state = createRunTerminalEventState({
      plan: createPlan(),
      runScope: scope.runScope,
      emit: async payload => {
        payloads.push(payload);
      },
    });
    await state.emitNode({
      type: "node.failed",
      nodeId: "node-a",
      error: { code: "SEARCH_PROVIDER_FAILED", retryable: true },
    });

    await expect(
      state.complete(
        completeInput([rejectedOutcome("node-a", "RERANK_FAILED", false)]),
      ),
    ).rejects.toThrow("Node 错误与已接受终态内容冲突：node-a");
    expect(payloads.map(payload => payload.type)).toEqual(["node.failed"]);
  });

  it("已接纳终态异步写失败时传播原错误且不重试", async () => {
    const plan = createPlan();
    const scope = createRunScope();
    const terminalWrite = createDeferred<void>();
    const writeError = new Error("accepted terminal failed");
    const payloads: StreamEventPayload[] = [];
    const state = createRunTerminalEventState({
      plan,
      runScope: scope.runScope,
      emit: payload => {
        payloads.push(payload);
        return terminalWrite.promise;
      },
    });

    const pendingTerminal = state.emitNode(terminalPayload("node-a", "ready"));
    terminalWrite.reject(writeError);
    await expect(pendingTerminal).rejects.toBe(writeError);
    await expect(
      state.complete(
        completeInput([successfulOutcome(plan, "node-a", "ready")]),
      ),
    ).rejects.toBe(writeError);
    expect(payloads.map(payload => payload.type)).toEqual(["node.ready"]);
  });

  it("complete 异步写失败时传播原错误且不补发", async () => {
    const plan = createPlan();
    const scope = createRunScope();
    const writeError = new Error("complete failed");
    const payloads: StreamEventPayload[] = [];
    const state = createRunTerminalEventState({
      plan,
      runScope: scope.runScope,
      emit: async payload => {
        payloads.push(payload);
        if (payload.type === "complete") throw writeError;
      },
    });
    await state.emitNode(terminalPayload("node-a", "ready"));

    await expect(
      state.complete(
        completeInput([successfulOutcome(plan, "node-a", "ready")]),
      ),
    ).rejects.toBe(writeError);
    expect(payloads.map(payload => payload.type)).toEqual([
      "node.ready",
      "complete",
    ]);
  });

  it("终态背压期间用户取消，解除背压后仍不得 complete", async () => {
    const plan = createPlan();
    const scope = createRunScope();
    const terminalWrite = createDeferred<void>();
    const userReason = new Error("用户在终态背压期间取消");
    const payloads: StreamEventPayload[] = [];
    const state = createRunTerminalEventState({
      plan,
      runScope: scope.runScope,
      emit: payload => {
        payloads.push(payload);
        return payload.type === "node.ready"
          ? terminalWrite.promise
          : Promise.resolve();
      },
    });

    const pendingTerminal = state.emitNode(terminalPayload("node-a", "ready"));
    const completion = state.complete(
      completeInput([successfulOutcome(plan, "node-a", "ready")]),
    );
    scope.cancel(userReason);
    terminalWrite.resolve();

    await pendingTerminal;
    await expect(completion).rejects.toBe(userReason);
    expect(payloads.map(payload => payload.type)).toEqual(["node.ready"]);
  });

  it("Deadline 合成 failed 写入失败时传播原错误且不发送 complete", async () => {
    const scope = createRunScope();
    scope.deadline();
    const writeError = new Error("terminal sink failed");
    const payloads: StreamEventPayload[] = [];
    const state = createRunTerminalEventState({
      plan: createPlan(),
      runScope: scope.runScope,
      emit: async payload => {
        payloads.push(payload);
        throw writeError;
      },
    });

    await expect(
      state.complete(completeInput([timedOutOutcome("node-a")])),
    ).rejects.toBe(writeError);
    expect(payloads.map(payload => payload.type)).toEqual(["node.failed"]);
  });

  it("GraphPlan 后用户取消原样退出且不补 Node 或 Run 终态", async () => {
    const scope = createRunScope();
    const userReason = new DOMException("用户主动停止", "TimeoutError");
    scope.cancel(userReason);
    const emit = vi.fn(async (payload: StreamEventPayload) => {
      void payload;
    });
    const state = createRunTerminalEventState({
      plan: createPlan(),
      runScope: scope.runScope,
      emit,
    });

    await expect(
      state.complete(completeInput([timedOutOutcome("node-a")])),
    ).rejects.toBe(userReason);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("emitRunFailedWithoutGraphPlan", () => {
  it("普通全局失败只发送脱敏 run.failed", async () => {
    const scope = createRunScope();
    const payloads: StreamEventPayload[] = [];

    await emitRunFailedWithoutGraphPlan({
      error: { code: "INVALID_GRAPH", retryable: false },
      runScope: scope.runScope,
      emit: async payload => {
        payloads.push(payload);
      },
    });

    expect(payloads).toEqual([
      {
        type: "run.failed",
        error: { code: "INVALID_GRAPH", retryable: false },
      },
    ]);
  });

  it("无 GraphPlan 的真正 Deadline 映射为可重试 run.failed", async () => {
    const scope = createRunScope();
    scope.deadline();
    const payloads: StreamEventPayload[] = [];

    await emitRunFailedWithoutGraphPlan({
      error: { code: "UNKNOWN", retryable: false },
      runScope: scope.runScope,
      emit: async payload => {
        payloads.push(payload);
      },
    });

    expect(payloads).toEqual([
      {
        type: "run.failed",
        error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
      },
    ]);
  });

  it("Timer 未回调但绝对时间已过时仍映射 Deadline", async () => {
    const scope = createRunScope();
    scope.expireWithoutTimer();
    const payloads: StreamEventPayload[] = [];

    await emitRunFailedWithoutGraphPlan({
      error: { code: "INVALID_GRAPH", retryable: false },
      runScope: scope.runScope,
      emit: async payload => {
        payloads.push(payload);
      },
    });

    expect(payloads).toEqual([
      {
        type: "run.failed",
        error: { code: "RUN_DEADLINE_EXCEEDED", retryable: true },
      },
    ]);
  });

  it("run.failed 异步写失败时传播原错误且不重试", async () => {
    const scope = createRunScope();
    const writeError = new Error("run failed sink error");
    const payloads: StreamEventPayload[] = [];

    await expect(
      emitRunFailedWithoutGraphPlan({
        error: { code: "UNKNOWN", retryable: false },
        runScope: scope.runScope,
        emit: async payload => {
          payloads.push(payload);
          throw writeError;
        },
      }),
    ).rejects.toBe(writeError);
    expect(payloads.map(payload => payload.type)).toEqual(["run.failed"]);
  });

  it("run.failed 背压中先取消时保留用户 reason", async () => {
    const scope = createRunScope();
    const userReason = new DOMException("用户背压期间取消", "AbortError");
    const writeError = new Error("late run.failed sink failure");
    const write = createDeferred<void>();
    const pending = emitRunFailedWithoutGraphPlan({
      error: { code: "UNKNOWN", retryable: false },
      runScope: scope.runScope,
      emit: () => write.promise,
    });

    scope.cancel(userReason);
    write.reject(writeError);

    await expect(pending).rejects.toBe(userReason);
  });

  it("用户携带同名 TimeoutError 时仍原样取消且零事件", async () => {
    const scope = createRunScope();
    const userReason = new DOMException("用户主动停止", "TimeoutError");
    scope.cancel(userReason);
    const emit = vi.fn(async (payload: StreamEventPayload) => {
      void payload;
    });

    await expect(
      emitRunFailedWithoutGraphPlan({
        error: { code: "UNKNOWN", retryable: false },
        runScope: scope.runScope,
        emit,
      }),
    ).rejects.toBe(userReason);
    expect(emit).not.toHaveBeenCalled();
  });

  it("禁止把 REQUEST_ABORTED 伪装成健康流上的 run.failed", async () => {
    const scope = createRunScope();
    const emit = vi.fn(async (payload: StreamEventPayload) => {
      void payload;
    });

    await expect(
      emitRunFailedWithoutGraphPlan({
        error: { code: "REQUEST_ABORTED", retryable: false },
        runScope: scope.runScope,
        emit,
      }),
    ).rejects.toThrow("用户取消不能作为 Streaming run.failed 发送");
    expect(emit).not.toHaveBeenCalled();
  });
});
