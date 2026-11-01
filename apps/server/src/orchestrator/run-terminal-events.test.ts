/**
 * 测试职责：冻结 WAY-112 连续前缀、全图 URL 所有权、ordinal 发送顺序和 exactly-once 终态。
 *
 * 关键竞态：后序 Node 可以先完成计算，但只有 GraphPlan 连续前缀形成后才能发送终态；
 * 所有权始终按计划/rank，发送顺序只在同批释放项中按真实结算 ordinal。
 */
import {
  GraphPlanSchema,
  ResultGraphNodeSchema,
  type GraphPlan,
  type NodeJobOutcome,
  type Resource,
  type ResultGraph,
  type StreamEventPayload,
} from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import { createDeferred } from "../../../../tests/support/test-infrastructure.mjs";
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

function createResource(
  id: string,
  canonicalUrl: string,
  rank = 1,
): Resource {
  const hostname = new URL(canonicalUrl).hostname;
  return {
    id,
    title: `资源 ${id}`,
    url: canonicalUrl,
    canonicalUrl,
    domain: hostname,
    sourceType: "documentation",
    summary: `${id} 摘要`,
    whySelected: `${id} 与节点相关`,
    rank,
    scores: { relevance: 0.8 },
    searchProvider: "fake-search",
  };
}

function successfulOutcome(
  plan: GraphPlan,
  nodeId: string,
  settlementOrdinal: number,
  resources: readonly Resource[],
  status: "ready" | "partial" = "ready",
): NodeJobOutcome {
  const planNode = plan.nodes.find(node => node.id === nodeId);
  if (planNode === undefined) throw new TypeError("测试计划缺少 Node");
  return {
    status: "fulfilled",
    nodeId,
    settlementOrdinal,
    value: ResultGraphNodeSchema.parse({
      ...planNode,
      status,
      resources,
      warnings: status === "partial" ? ["RERANK_FAILED"] : [],
    }),
  };
}

function rejectedOutcome(
  nodeId: string,
  settlementOrdinal: number,
): NodeJobOutcome {
  return {
    status: "rejected",
    nodeId,
    settlementOrdinal,
    error: Object.assign(new Error("内部 Provider 细节"), {
      code: "SEARCH_PROVIDER_FAILED" as const,
      retryable: true,
    }),
  };
}

function timedOutOutcome(
  nodeId: string,
  settlementOrdinal: number,
): NodeJobOutcome {
  return {
    status: "timed_out",
    nodeId,
    settlementOrdinal,
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
    expireWithoutTimer: () => {
      clockExpired = true;
    },
    cancel: (reason: unknown) => controller.abort(reason),
  };
}

function completeInput(): CompleteRunWithTerminalEventsInput {
  return { runId: "run-112", query: QUERY, meta: META };
}

function terminalPayloads(payloads: readonly StreamEventPayload[]) {
  return payloads.filter(
    (
      payload,
    ): payload is Extract<
      StreamEventPayload,
      { type: "node.ready" | "node.partial" | "node.failed" }
    > =>
      ["node.ready", "node.partial", "node.failed"].includes(payload.type),
  );
}

describe("createRunTerminalEventState", () => {
  it("缓冲后序 Node，并把 URL 所有权与同批 ordinal 发送顺序分离", async () => {
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
    const shared = "https://example.com/shared";
    const bWrite = state.acceptOutcome(
      successfulOutcome(plan, "node-b", 1, [
        createResource("b-shared", shared, 1),
        createResource("b-unique", "https://example.com/b", 2),
      ]),
    );
    await Promise.resolve();
    expect(payloads).toEqual([]);

    const aWrite = state.acceptOutcome(
      successfulOutcome(plan, "node-a", 2, [
        createResource("a-shared", shared),
      ]),
    );
    await Promise.all([aWrite, bWrite]);
    expect(terminalPayloads(payloads).map(payload => payload.nodeId)).toEqual([
      "node-b",
      "node-a",
    ]);
    expect(payloads[0]).toMatchObject({
      type: "node.ready",
      nodeId: "node-b",
      resources: [
        {
          id: "b-unique",
          canonicalUrl: "https://example.com/b",
          rank: 1,
        },
      ],
    });

    await state.acceptOutcome(
      successfulOutcome(plan, "node-c", 3, [
        createResource("c", "https://example.com/c"),
      ]),
    );
    const result = await state.complete(completeInput());
    expect(result.graph.nodes[0]?.resources[0]?.id).toBe("a-shared");
    expect(result.graph.nodes[1]?.resources[0]?.id).toBe("b-unique");
    expect(payloads.at(-1)).toMatchObject({
      type: "complete",
      data: { finalStatus: "complete", result },
    });
  });

  it("交换实际完成顺序只改变终态发送顺序，不改变仲裁 Payload 或最终 Graph", async () => {
    const plan = createPlan(["node-a", "node-b"]);
    const shared = "https://example.com/shared";
    const runOrder = async (order: readonly ["node-a" | "node-b", "node-a" | "node-b"]) => {
      const scope = createRunScope();
      const payloads: StreamEventPayload[] = [];
      const state = createRunTerminalEventState({
        plan,
        runScope: scope.runScope,
        emit: async payload => {
          payloads.push(structuredClone(payload));
        },
      });
      const writes = order.map((nodeId, index) =>
        state.acceptOutcome(
          successfulOutcome(
            plan,
            nodeId,
            index + 1,
            nodeId === "node-a"
              ? [createResource("a-shared", shared)]
              : [
                  createResource("b-shared", shared, 1),
                  createResource("b-unique", "https://example.com/b", 2),
                ],
          ),
        ),
      );
      await Promise.all(writes);
      const result = await state.complete(completeInput());
      const terminalsByNodeId = Object.fromEntries(
        terminalPayloads(payloads)
          .map(payload => [payload.nodeId, payload] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      );
      return {
        result,
        terminalsByNodeId,
        terminalOrder: terminalPayloads(payloads).map(payload => payload.nodeId),
      };
    };

    const planOrder = await runOrder(["node-a", "node-b"]);
    const reverseOrder = await runOrder(["node-b", "node-a"]);

    expect(reverseOrder.result).toEqual(planOrder.result);
    expect(reverseOrder.terminalsByNodeId).toEqual(planOrder.terminalsByNodeId);
    expect(planOrder.terminalOrder).toEqual(["node-a", "node-b"]);
    expect(reverseOrder.terminalOrder).toEqual(["node-b", "node-a"]);
  });

  it.each(["rejected", "timed_out"] as const)(
    "前序 Node %s 时不占 URL，后序 Node 获得所有权",
    async previousStatus => {
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
      const previous =
        previousStatus === "rejected"
          ? rejectedOutcome("node-a", 1)
          : timedOutOutcome("node-a", 1);
      await state.acceptOutcome(previous);
      await state.acceptOutcome(
        successfulOutcome(plan, "node-b", 2, [
          createResource("b-shared", "https://example.com/shared"),
        ]),
      );

      const result = await state.complete(completeInput());
      expect(result.graph.nodes[1]).toMatchObject({
        id: "node-b",
        status: "ready",
        resources: [{ id: "b-shared" }],
      });
      expect(terminalPayloads(payloads)).toHaveLength(2);
    },
  );

  it("删除重复项后重排 rank，并保留 partial、Warning 与其他 Resource 字段", async () => {
    const plan = createPlan(["node-a", "node-b"]);
    const scope = createRunScope();
    const payloads: StreamEventPayload[] = [];
    const state = createRunTerminalEventState({
      plan,
      runScope: scope.runScope,
      emit: async payload => {
        payloads.push(structuredClone(payload));
      },
    });
    const shared = createResource("a-shared", "https://example.com/shared");
    const unique = createResource("b-unique", "https://example.com/unique", 2);
    await state.acceptOutcome(
      successfulOutcome(plan, "node-a", 1, [shared]),
    );
    await state.acceptOutcome(
      successfulOutcome(
        plan,
        "node-b",
        2,
        [
          createResource("b-shared", shared.canonicalUrl, 1),
          unique,
        ],
        "partial",
      ),
    );

    const result = await state.complete(completeInput());
    const node = result.graph.nodes[1];
    expect(node).toMatchObject({
      status: "partial",
      warnings: ["RERANK_FAILED"],
      resources: [{ ...unique, rank: 1 }],
    });
    expect(payloads[1]).toMatchObject({
      type: "node.partial",
      nodeId: "node-b",
      resources: [{ ...unique, rank: 1 }],
      warnings: ["RERANK_FAILED"],
    });
  });

  it(" fulfilled Node 被仲裁清空时生成不可重试的新错误", async () => {
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
    const url = "https://example.com/shared";
    await state.acceptOutcome(
      successfulOutcome(plan, "node-a", 1, [createResource("a", url)]),
    );
    await state.acceptOutcome(
      successfulOutcome(plan, "node-b", 2, [createResource("b", url)]),
    );

    const result = await state.complete(completeInput());
    expect(result.graph.nodes[1]).toMatchObject({
      id: "node-b",
      status: "failed",
      resources: [],
      warnings: [],
      error: {
        code: "NO_UNIQUE_RESOURCE_AVAILABLE",
        retryable: false,
      },
    });
    expect(payloads[1]).toEqual({
      type: "node.failed",
      nodeId: "node-b",
      error: {
        code: "NO_UNIQUE_RESOURCE_AVAILABLE",
        retryable: false,
      },
    });
  });

  it("只比较完整 canonicalUrl，不合并协议、host、Path、斜杠、Query 或语言版本", async () => {
    const plan = createPlan(["node-a", "node-b"]);
    const scope = createRunScope();
    const state = createRunTerminalEventState({
      plan,
      runScope: scope.runScope,
      emit: async () => undefined,
    });
    const firstUrls = [
      "https://example.com/",
      "https://example.com/path",
      "http://example.com/protocol",
      "https://www.example.com/host",
      "https://example.com/query?topic=one",
      "https://example.com/en/",
    ];
    const secondUrls = [
      "https://example.com/1234/",
      "https://example.com/path/",
      "https://example.com/protocol",
      "https://example.com/host",
      "https://example.com/query?topic=two",
      "https://example.com/cn/",
    ];
    await state.acceptOutcome(
      successfulOutcome(
        plan,
        "node-a",
        1,
        firstUrls.map((url, index) => createResource(`a-${index}`, url, index + 1)),
      ),
    );
    await state.acceptOutcome(
      successfulOutcome(
        plan,
        "node-b",
        2,
        secondUrls.map((url, index) => createResource(`b-${index}`, url, index + 1)),
      ),
    );

    const result = await state.complete(completeInput());
    expect(result.graph.nodes[0]?.resources).toHaveLength(6);
    expect(result.graph.nodes[1]?.resources).toHaveLength(6);
  });

  it("在底层写入前拒绝未知 Node、重复 Node 与非法 ordinal", async () => {
    const plan = createPlan(["node-a"]);
    const scope = createRunScope();
    const payloads: StreamEventPayload[] = [];
    const state = createRunTerminalEventState({
      plan,
      runScope: scope.runScope,
      emit: async payload => {
        payloads.push(payload);
      },
    });
    const value = successfulOutcome(plan, "node-a", 1, [
      createResource("a", "https://example.com/a"),
    ]);
    expect(() =>
      state.acceptOutcome({ ...value, settlementOrdinal: 2 }),
    ).toThrow("settlementOrdinal");
    expect(() =>
      state.acceptOutcome({ ...value, nodeId: "node-missing" }),
    ).toThrow("未计划");
    await state.acceptOutcome(value);
    expect(() => state.acceptOutcome(value)).toThrow("重复");
    expect(terminalPayloads(payloads)).toHaveLength(1);
  });

  it("在任何终态副作用前拒绝 fulfilled value 与计划 Node 身份不一致", () => {
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
    const mismatched = {
      ...successfulOutcome(plan, "node-b", 1, [
        createResource("b", "https://example.com/b"),
      ]),
      nodeId: "node-a",
    } satisfies NodeJobOutcome;

    expect(() => state.acceptOutcome(mismatched)).toThrow("身份与计划不一致");
    expect(payloads).toEqual([]);
  });

  it("同批首个终态 Sink 失败时所有已释放 Promise 以原错误拒绝", async () => {
    const plan = createPlan(["node-a", "node-b"]);
    const scope = createRunScope();
    const firstWrite = createDeferred<void>();
    const payloads: StreamEventPayload[] = [];
    const state = createRunTerminalEventState({
      plan,
      runScope: scope.runScope,
      emit: payload => {
        payloads.push(payload);
        return firstWrite.promise;
      },
    });
    const bWrite = state.acceptOutcome(
      successfulOutcome(plan, "node-b", 1, [
        createResource("b", "https://example.com/b"),
      ]),
    );
    const aWrite = state.acceptOutcome(
      successfulOutcome(plan, "node-a", 2, [
        createResource("a", "https://example.com/a"),
      ]),
    );
    const sinkError = new Error("terminal sink failed");
    firstWrite.reject(sinkError);

    await expect(bWrite).rejects.toBe(sinkError);
    await expect(aWrite).rejects.toBe(sinkError);
    await expect(state.complete(completeInput())).rejects.toBe(sinkError);
    expect(payloads).toHaveLength(1);
  });

  it("前序终态 Sink 失败会关闭仍被计划缺口阻塞的后序 Promise", async () => {
    const plan = createPlan(["node-a", "node-b", "node-c"]);
    const scope = createRunScope();
    const firstWrite = createDeferred<void>();
    const state = createRunTerminalEventState({
      plan,
      runScope: scope.runScope,
      emit: () => firstWrite.promise,
    });
    const cWrite = state.acceptOutcome(
      successfulOutcome(plan, "node-c", 1, [
        createResource("c", "https://example.com/c"),
      ]),
    );
    const aWrite = state.acceptOutcome(
      successfulOutcome(plan, "node-a", 2, [
        createResource("a", "https://example.com/a"),
      ]),
    );
    const sinkError = new Error("first terminal sink failed");
    firstWrite.reject(sinkError);

    await expect(aWrite).rejects.toBe(sinkError);
    await expect(cWrite).rejects.toBe(sinkError);
  });

  it("终态背压跨过 Deadline 时保留已占位 Outcome，解除背压后仍可 complete", async () => {
    const plan = createPlan(["node-a"]);
    const scope = createRunScope();
    const terminalWrite = createDeferred<void>();
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
    const accepted = state.acceptOutcome(
      successfulOutcome(plan, "node-a", 1, [
        createResource("a", "https://example.com/a"),
      ]),
    );
    scope.deadline();
    terminalWrite.resolve();
    await accepted;

    const result = await state.complete(completeInput());
    expect(result.graph.nodes[0]?.status).toBe("ready");
    expect(payloads.map(payload => payload.type)).toEqual([
      "node.ready",
      "complete",
    ]);
  });

  it("用户取消后不再接纳 Outcome、终态或 complete", () => {
    const plan = createPlan(["node-a"]);
    const scope = createRunScope();
    const payloads: StreamEventPayload[] = [];
    const state = createRunTerminalEventState({
      plan,
      runScope: scope.runScope,
      emit: async payload => {
        payloads.push(payload);
      },
    });
    const reason = new Error("user cancelled");
    scope.cancel(reason);

    expect(() =>
      state.acceptOutcome(
        successfulOutcome(plan, "node-a", 1, [
          createResource("a", "https://example.com/a"),
        ]),
      ),
    ).toThrow(reason);
    expect(payloads).toEqual([]);
  });

  it("用户取消会用原 reason 关闭尚未形成计划前缀的缓冲 Promise", async () => {
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
    const bWrite = state.acceptOutcome(
      successfulOutcome(plan, "node-b", 1, [
        createResource("b", "https://example.com/b"),
      ]),
    );
    const reason = new Error("user cancelled with buffered outcome");

    scope.cancel(reason);

    await expect(bWrite).rejects.toBe(reason);
    await expect(state.complete(completeInput())).rejects.toBe(reason);
    expect(payloads).toEqual([]);
  });
});

describe("emitRunFailedWithoutGraphPlan", () => {
  it("墙上时钟过期时发送唯一 RUN_DEADLINE_EXCEEDED", async () => {
    const scope = createRunScope();
    const payloads: StreamEventPayload[] = [];
    scope.expireWithoutTimer();
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

  it("用户取消保持原 reason，且不发送 run.failed", async () => {
    const scope = createRunScope();
    const payloads: StreamEventPayload[] = [];
    const reason = new Error("user cancelled");
    scope.cancel(reason);
    await expect(
      emitRunFailedWithoutGraphPlan({
        error: { code: "UNKNOWN", retryable: false },
        runScope: scope.runScope,
        emit: async payload => {
          payloads.push(payload);
        },
      }),
    ).rejects.toBe(reason);
    expect(payloads).toEqual([]);
  });
});
