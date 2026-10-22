/**
 * 测试职责：冻结 LLMProvider Port 的 timeout 边界与错误脱敏投影。
 *
 * 这里不调用真实 LLM；普通 CI 只验证确定性、无 Secret 的端口语义。
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  assertBoundedLLMTimeout,
  LLMProviderError,
  MAX_LLM_CALL_TIMEOUT_MS,
} from "./llm-provider.js";
import type {
  LLMCallOptions,
  LLMProvider,
  StructuredLLMInput,
} from "./llm-provider.js";

describe("LLMProvider Port", () => {
  it("冻结 SDK 无关的结构化调用签名", () => {
    expectTypeOf<LLMProvider["structured"]>().toEqualTypeOf<
      (
        input: StructuredLLMInput,
        options: LLMCallOptions,
      ) => Promise<unknown>
    >();
  });

  it.each([1, 8_000, MAX_LLM_CALL_TIMEOUT_MS])(
    "接受批准范围内的 timeoutMs：%s",
    timeoutMs => {
      expect(() => assertBoundedLLMTimeout(timeoutMs)).not.toThrow();
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 15_001])(
    "在外部调用前拒绝无界或非法 timeoutMs：%s",
    timeoutMs => {
      expect(() => assertBoundedLLMTimeout(timeoutMs)).toThrow(RangeError);
    },
  );
});

describe("LLM Provider 脱敏错误", () => {
  it("只保留稳定分类与 retryable，不保存 Provider 私有响应", () => {
    const privateSentinel = "provider-private-response";
    const providerError = new LLMProviderError("rate_limited", true);

    expect(providerError).toMatchObject({
      name: "LLMProviderError",
      message: "LLM Provider 调用失败",
      kind: "rate_limited",
      retryable: true,
    });
    expect(JSON.stringify(providerError)).not.toContain(privateSentinel);
    expect("cause" in providerError).toBe(false);
  });
});
