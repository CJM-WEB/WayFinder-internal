/** 测试职责：控制授权耗时，验证阶段预算耗尽零付费调用、扣时及原始取消原因。 */
import { describe, expect, it } from "vitest";

import type { LLMProvider } from "../ai/llm-provider.js";
import { callAuthorizedLLM } from "./authorized-llm-call.js";

const input = { system: "固定假指令", user: "固定假查询", schemaName: "test", schema: {} };

describe("LLM 授权剩余预算", () => {
  it("从队列已给出的预算继续扣除授权等待，不把旧时长交给真实Provider", async () => {
    let clock = 0;
    const timeouts: number[] = [];
    const provider: LLMProvider = { id: "fake", structured: async (_input, options) => {
      timeouts.push(options.timeoutMs);
      return { valid: true };
    } };
    let checks = 0;
    const result = await callAuthorizedLLM(provider, input, { signal: new AbortController().signal, timeoutMs: 1000 },
      async () => { if (checks++ === 0) clock += 250; }, () => clock);
    expect(timeouts).toEqual([750]);
    expect(checks).toBe(2);
    expect(result).toEqual({ valid: true });
  });

  it("授权等待耗尽阶段预算，即使全局Run尚有时间也不调用上游", async () => {
    let clock = 0;
    let calls = 0;
    const provider: LLMProvider = { id: "fake", structured: async () => { calls += 1; } };
    await expect(callAuthorizedLLM(provider, input, { signal: new AbortController().signal, timeoutMs: 1000 },
      async () => { clock = 1000; }, () => clock)).rejects.toMatchObject({ kind: "timeout", retryable: true });
    expect(calls).toBe(0);
  });

  it("等待时取消或撤销均保留原原因，且不触发Provider", async () => {
    const controller = new AbortController();
    const reason = new Error("固定假取消原因");
    let calls = 0;
    const provider: LLMProvider = { id: "fake", structured: async () => { calls += 1; } };
    await expect(callAuthorizedLLM(provider, input, { signal: controller.signal, timeoutMs: 1000 },
      async () => { controller.abort(reason); })).rejects.toBe(reason);
    await expect(callAuthorizedLLM(provider, input, { signal: new AbortController().signal, timeoutMs: 1000 },
      async () => { throw reason; })).rejects.toBe(reason);
    expect(calls).toBe(0);
  });

  it("时钟回拨不会扩张调用方预算", async () => {
    let clock = 100;
    const timeouts: number[] = [];
    const provider: LLMProvider = { id: "fake", structured: async (_input, options) => { timeouts.push(options.timeoutMs); } };
    await callAuthorizedLLM(provider, input, { signal: new AbortController().signal, timeoutMs: 1000 },
      async () => { clock = 0; }, () => clock);
    expect(timeouts).toEqual([1000]);
  });
});
