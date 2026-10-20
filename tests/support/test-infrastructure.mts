/**
 * 模块职责：提供普通 CI 可复用的确定性测试替身与控制工具。
 *
 * 关键边界：
 * - 所有响应必须由测试显式注入，不能读取 Secret、环境变量或访问网络。
 * - Fake（测试替身）记录调用但不解释业务语义，避免测试基础设施反向冻结生产实现。
 * - AbortSignal 在调用前和等待期间都生效，确保取消路径与真实异步调用一致。
 */
import type {
  ExtractedPage,
  NormalizedSearchHit,
  ProviderSearchRequest,
  SearchCapability,
} from "../../packages/contracts/src/index.js";
import type { SearchProvider } from "../../apps/server/src/search/provider.js";

/** 可同步返回、异步返回或显式失败的单步脚本。 */
type ScriptedResponse<T> = T | PromiseLike<T> | Error;

/** LLM 结构化调用的最小输入形状，不预先绑定未来生产 Provider 接口。 */
export type StructuredLLMInput = {
  system: string;
  user: string;
  schema: unknown;
};

/** 手动控制 Promise（承诺）的测试夹具，用于稳定覆盖等待中取消。 */
export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

export function createDeferred<T>(): Deferred<T> {
  let resolvePromise: Deferred<T>["resolve"] | undefined;
  let rejectPromise: Deferred<T>["reject"] | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  // Promise executor 会在构造期间同步执行；此防御分支只用于保持严格类型完整。
  if (resolvePromise === undefined || rejectPromise === undefined) {
    throw new Error("Deferred 初始化失败");
  }

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

/** 只允许测试显式推进的固定时钟。 */
export type FixedClock = {
  now: () => number;
  nowIso: () => string;
  advanceBy: (milliseconds: number) => void;
};

export function createFixedClock(initialTime: string | number): FixedClock {
  let currentMilliseconds =
    typeof initialTime === "string" ? Date.parse(initialTime) : initialTime;

  if (!Number.isFinite(currentMilliseconds) || currentMilliseconds < 0) {
    throw new Error("固定时钟时间无效");
  }

  return {
    now: () => currentMilliseconds,
    nowIso: () => new Date(currentMilliseconds).toISOString(),
    advanceBy: milliseconds => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new Error("固定时钟推进量无效");
      }

      currentMilliseconds += milliseconds;
    },
  };
}

/** 独立 AbortController（取消控制器）与稳定取消原因。 */
export type AbortFixture = {
  signal: AbortSignal;
  reason: Error;
  abort: () => void;
};

export function createAbortFixture(message = "测试请求已取消"): AbortFixture {
  const controller = new AbortController();
  const reason = new Error(message);
  reason.name = "AbortError";

  return {
    signal: controller.signal,
    reason,
    abort: () => controller.abort(reason),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}

/**
 * 将脚本结果与取消信号竞速。
 * 监听器在任一路径结束后移除，避免长生命周期 signal 累积测试监听器。
 */
function waitForScript<T>(
  response: ScriptedResponse<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (response instanceof Error) {
    return Promise.reject(response);
  }

  const responsePromise = Promise.resolve(response);
  if (signal === undefined) {
    return responsePromise;
  }

  return new Promise<T>((resolve, reject) => {
    const handleAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", handleAbort, { once: true });

    responsePromise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", handleAbort);
    });
  });
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

/** 按顺序消费预设响应的 LLM 测试替身。 */
export class FakeLLMProvider {
  readonly id = "fake-llm";
  readonly calls: Array<{
    input: StructuredLLMInput;
    signal: AbortSignal | undefined;
  }> = [];

  readonly #responses: Array<ScriptedResponse<unknown>>;

  constructor(responses: readonly ScriptedResponse<unknown>[]) {
    this.#responses = [...responses];
  }

  async structured<T>(
    input: StructuredLLMInput,
    signal?: AbortSignal,
  ): Promise<T> {
    // 调用前取消不得消费脚本，否则一次失败会污染后续断言。
    throwIfAborted(signal);
    const response = this.#responses.shift();
    if (response === undefined) {
      throw new Error("FakeLLMProvider 脚本已耗尽");
    }

    // 顶层字段保存调用瞬间的快照；schema 可能是不可克隆的 Zod 实例，只保留其身份引用。
    this.calls.push({ input: { ...input }, signal });
    return cloneValue((await waitForScript(response, signal)) as T);
  }
}

/** Search Fake（搜索测试替身）的显式配置。 */
export type FakeSearchProviderOptions = {
  searchResponses: Readonly<
    Record<string, ScriptedResponse<readonly NormalizedSearchHit[]>>
  >;
  extractResponse?: ScriptedResponse<readonly ExtractedPage[]>;
};

/**
 * 使用 Query（查询）索引固定结果的 Search Provider 测试替身。
 * 同一 Query 可重复读取隔离副本，便于测试重试、缓存和变异隔离。
 */
export class FakeSearchProvider implements SearchProvider {
  readonly id = "fake-search";
  // 数组本身保留可变类型，以结构兼容批准架构中的 SearchProvider Port。
  readonly capabilities: SearchCapability[] = ["general"];
  readonly searchCalls: Array<{
    request: ProviderSearchRequest;
    signal: AbortSignal | undefined;
  }> = [];
  readonly extractCalls: Array<{
    canonicalUrls: readonly string[];
    signal: AbortSignal | undefined;
  }> = [];

  readonly #options: FakeSearchProviderOptions;

  constructor(options: FakeSearchProviderOptions) {
    this.#options = options;
  }

  async search(
    request: ProviderSearchRequest,
    signal?: AbortSignal,
  ): Promise<NormalizedSearchHit[]> {
    throwIfAborted(signal);
    const response = this.#options.searchResponses[request.query];
    if (response === undefined) {
      throw new Error(`FakeSearchProvider 未配置 Query：${request.query}`);
    }

    this.searchCalls.push({ request: cloneValue(request), signal });
    return [...cloneValue(await waitForScript(response, signal))];
  }

  async extract(
    canonicalUrls: readonly string[],
    signal?: AbortSignal,
  ): Promise<ExtractedPage[]> {
    throwIfAborted(signal);
    const response = this.#options.extractResponse;
    if (response === undefined) {
      throw new Error("FakeSearchProvider 未配置 Extract 响应");
    }

    this.extractCalls.push({ canonicalUrls: [...canonicalUrls], signal });
    return [...cloneValue(await waitForScript(response, signal))];
  }
}
