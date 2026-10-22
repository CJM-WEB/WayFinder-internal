/**
 * 测试职责：冻结已校验 GraphPlan 的两条计划事件顺序、同源快照与失败传播。
 *
 * 范围边界：这里只验证 query.analysis → graph.plan；Node 事件与 Run 终态由对应模块负责。
 */
import type { GraphPlan, StreamEventPayload } from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import { emitValidatedPlanEvents } from "./emit-validated-plan-events.js";

function createValidatedPlan(): GraphPlan {
  return {
    analysis: {
      intent: "learn",
      topic: "TypeScript strict mode",
      freshnessSensitive: false,
      ambiguityLevel: "low",
      broadSearchQueries: [],
      strategy: "plan_first",
      presentationMode: "compact",
    },
    nodes: [
      {
        id: "node-001",
        title: "严格模式入口",
        description: "从官方资料理解 TypeScript 严格模式。",
        nodeType: "primary",
        layer: 0,
        searchPlan: {
          queries: ["TypeScript strict mode official"],
          maxResults: 20,
          rankingProfile: "software",
          providerHints: ["general"],
        },
        status: "planned",
      },
    ],
    edges: [],
  };
}

describe("emitValidatedPlanEvents", () => {
  it("先发送同源 Analysis，再发送完整 GraphPlan", async () => {
    const validatedPlan = createValidatedPlan();
    const payloads: StreamEventPayload[] = [];

    await emitValidatedPlanEvents({
      validatedPlan,
      emit: async payload => {
        payloads.push(payload);
      },
    });

    expect(payloads.map(payload => payload.type)).toEqual([
      "query.analysis",
      "graph.plan",
    ]);
    expect(payloads[0]).toMatchObject({
      type: "query.analysis",
      data: validatedPlan.analysis,
    });
    expect(payloads[1]).toMatchObject({
      type: "graph.plan",
      data: validatedPlan,
    });

    if (
      payloads[0]?.type !== "query.analysis" ||
      payloads[1]?.type !== "graph.plan"
    ) {
      throw new TypeError("测试事件类型不符合预期");
    }
    expect(payloads[0].data).toStrictEqual(payloads[1].data.analysis);
  });

  it("等待首条事件并隔离背压期间的源对象变化", async () => {
    const validatedPlan = createValidatedPlan();
    let releaseFirst: (() => void) | undefined;
    const firstWrite = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const payloads: StreamEventPayload[] = [];
    const emit = vi.fn(async (payload: StreamEventPayload) => {
      payloads.push(payload);
      if (payload.type === "query.analysis") {
        await firstWrite;
      }
    });

    const emission = emitValidatedPlanEvents({ validatedPlan, emit });
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
    validatedPlan.analysis.topic = "背压期间的外部修改";
    expect(emit).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await emission;

    expect(emit).toHaveBeenCalledTimes(2);
    if (
      payloads[0]?.type !== "query.analysis" ||
      payloads[1]?.type !== "graph.plan"
    ) {
      throw new TypeError("测试事件类型不符合预期");
    }
    expect(payloads[0].data.topic).toBe("TypeScript strict mode");
    expect(payloads[1].data.analysis).toStrictEqual(payloads[0].data);
  });

  it("最终图校验失败时不发送任何计划事件", async () => {
    const invalidPlan = createValidatedPlan();
    invalidPlan.analysis.presentationMode = "graph";
    const emit = vi.fn(async (payload: StreamEventPayload) => {
      void payload;
    });

    await expect(
      emitValidatedPlanEvents({ validatedPlan: invalidPlan, emit }),
    ).rejects.toThrow("Orchestrator GraphPlan 未通过最终校验");
    expect(emit).not.toHaveBeenCalled();
  });

  it("首条事件失败时传播原错误且不发送 graph.plan", async () => {
    const writeError = new Error("analysis write failed");
    const emit = vi.fn(async (payload: StreamEventPayload) => {
      void payload;
      throw writeError;
    });

    await expect(
      emitValidatedPlanEvents({
        validatedPlan: createValidatedPlan(),
        emit,
      }),
    ).rejects.toBe(writeError);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toMatchObject({ type: "query.analysis" });
  });

  it("graph.plan 写入失败时传播原错误且不重试", async () => {
    const writeError = new Error("graph plan write failed");
    const emit = vi.fn(async (payload: StreamEventPayload) => {
      if (payload.type === "graph.plan") throw writeError;
    });

    await expect(
      emitValidatedPlanEvents({
        validatedPlan: createValidatedPlan(),
        emit,
      }),
    ).rejects.toBe(writeError);
    expect(emit.mock.calls.map(([payload]) => payload.type)).toEqual([
      "query.analysis",
      "graph.plan",
    ]);
  });
});
