/**
 * 模块职责：定义业务代码依赖的 LLM Structured Output（结构化输出）端口。
 *
 * 关键边界：
 * - Provider 输出始终是 `unknown`；后续业务阶段必须通过对应 Zod Schema 收窄。
 * - 每次调用必须同时携带父 AbortSignal（取消信号）与有界 timeout（超时）。
 * - Adapter 只能抛出这里定义的脱敏错误，不能把 Provider 响应正文带入业务层。
 */
/** 当前所有 LLM Structured Output 阶段共用的单次调用硬上限。 */
export const MAX_LLM_CALL_TIMEOUT_MS = 15_000 as const;

/** Provider Structured Output 所需的最小、SDK 无关输入。 */
export type StructuredLLMInput = Readonly<{
  system: string;
  user: string;
  schemaName: string;
  schema: Readonly<Record<string, unknown>>;
}>;

/**
 * timeoutMs 是调用方按阶段剩余预算与 Run 剩余预算计算出的当前剩余额度；进程级
 * 并发装饰器还必须扣除取得真实 Provider 槽位前的排队时间。Port 只冻结最终传入的
 * 单次调用不能超过共享 LLM 硬上限。
 */
export type LLMCallOptions = Readonly<{
  signal: AbortSignal;
  timeoutMs: number;
}>;

/** Planner、Reviser 与 Reranker 只依赖此端口，不接触具体 Provider SDK。 */
export interface LLMProvider {
  readonly id: string;

  structured(
    input: StructuredLLMInput,
    options: LLMCallOptions,
  ): Promise<unknown>;
}

/** Adapter 可向业务层公开的稳定失败分类。 */
export type LLMProviderErrorKind =
  | "invalid_response"
  | "provider_failure"
  | "rate_limited"
  | "timeout";

/**
 * Provider 原始 Error 可能包含响应正文、请求标识或私有字段，因此不能保留 cause。
 * 更详细但已脱敏的诊断信息应由未来 Run Log 在 Adapter 内记录。
 */
export class LLMProviderError extends Error {
  public readonly kind: LLMProviderErrorKind;
  public readonly retryable: boolean;

  public constructor(kind: LLMProviderErrorKind, retryable: boolean) {
    super("LLM Provider 调用失败");
    this.name = "LLMProviderError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

/** 在任何外部调用发生前拒绝无界、非整数或越过批准硬上限的 timeout。 */
export function assertBoundedLLMTimeout(timeoutMs: number): void {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_LLM_CALL_TIMEOUT_MS
  ) {
    throw new RangeError(
      `LLM timeoutMs 必须是 1 到 ${MAX_LLM_CALL_TIMEOUT_MS} 的整数`,
    );
  }
}
