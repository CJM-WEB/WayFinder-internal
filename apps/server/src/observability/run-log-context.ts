/**
 * 模块职责：把进程级共享 Provider 的脱敏观察值归属到当前异步 Run。
 *
 * 关键边界：
 * - Run 身份不能进入 SearchProvider / LLMProvider 公共端口，也不能进入 Cache Key；
 * - Context（上下文）只接受固定聚合字段，禁止 Query、URL、正文或原始响应；
 * - 没有活动 Run 或观察器自身失败时直接忽略，绝不能改变 Provider 结果。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type RunLogObservation =
  | Readonly<{
      kind: "cache";
      operation: "search" | "extract";
      hitCount: number;
      missCount: number;
    }>
  | Readonly<{
      kind: "http_attempt";
      operation: "search" | "extract";
    }>
  | Readonly<{
      kind: "token_usage";
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }>;

export type RunLogObserver = (observation: RunLogObservation) => void;

const runLogObserverStorage = new AsyncLocalStorage<RunLogObserver>();

/** 在当前 Run 的全部异步子任务中安装唯一观察器。 */
export function withRunLogObserver<T>(
  observer: RunLogObserver,
  operation: () => T,
): T {
  return runLogObserverStorage.run(observer, operation);
}

/**
 * Provider 与 Cache 只调用这个 fail-open（失败时继续）出口。
 * 即使未来 Recorder 出现缺陷，也不能把可观测性升级为业务失败。
 */
export function observeCurrentRun(observation: RunLogObservation): void {
  try {
    runLogObserverStorage.getStore()?.(observation);
  } catch {
    // Run Log 是旁路能力；观察失败不得影响搜索、提取或模型调用。
  }
}
