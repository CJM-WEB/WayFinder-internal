/**
 * 模块职责：把动态授权检查纳入已经收窄的 LLM 阶段预算。
 * 队列等待已由并发层扣除；这里继续扣除读配置耗时，不能让必然过期的阶段发起付费调用。
 */
import { performance } from "node:perf_hooks";

import {
  assertBoundedLLMTimeout, LLMProviderError,
  type LLMCallOptions, type LLMProvider, type StructuredLLMInput,
} from "../ai/llm-provider.js";

export async function callAuthorizedLLM(
  provider: LLMProvider,
  input: StructuredLLMInput,
  options: LLMCallOptions,
  authorize: (signal: AbortSignal) => Promise<void>,
  now: () => number = () => performance.now(),
): Promise<unknown> {
  options.signal.throwIfAborted();
  assertBoundedLLMTimeout(options.timeoutMs);
  const startedAt = now();
  if (!Number.isFinite(startedAt)) throw new TypeError("LLM 授权时钟必须有限");
  const deadlineAt = startedAt + options.timeoutMs;
  await authorize(options.signal);
  options.signal.throwIfAborted();
  const current = now();
  if (!Number.isFinite(current)) throw new TypeError("LLM 授权时钟必须有限");
  const timeoutMs = Math.min(options.timeoutMs, Math.floor(deadlineAt - current));
  if (timeoutMs < 1) throw new LLMProviderError("timeout", true);
  const result = await provider.structured(input, { ...options, timeoutMs });
  await authorize(options.signal);
  options.signal.throwIfAborted();
  return result;
}
