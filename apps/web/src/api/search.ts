/**
 * 模块职责：把一次合法 Query（查询）协调为唯一 Run（运行），并管理浏览器端取消与流读取生命周期。
 *
 * 关键边界：
 * - 输入必须先通过公共 SearchRequest Contract，非法输入不能中止仍在运行的搜索。
 * - 新 Run 同步取消旧 Run，但不等待旧 fetch、Reader（读取器）或 finally；
 *   旧事件由 Store（状态仓库）的 runId 门禁兜底。
 * - 用户发起的替换取消属于正常控制流，不伪装为服务端 `run.failed`；其余错误保持原始对象上抛。
 */
import {
  SearchRequestSchema,
  type SearchRequest,
  type ResultGraph,
} from "@wayfinder/contracts";

import {
  readSearchEventStream,
  type ReadSearchEventStreamOptions,
} from "../lib/stream.js";
import {
  graphStore,
  type GraphStoreState,
} from "../stores/graph-store.js";

/** 只依赖 Zustand Vanilla Store 的最小能力，便于测试隔离且不复制状态类型。 */
type SearchGraphStore = Readonly<{
  getState: () => GraphStoreState;
}>;

type SearchFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type SearchStreamReader = (
  options: ReadSearchEventStreamOptions,
) => Promise<void>;

export type SearchCoordinatorDependencies = Readonly<{
  store: SearchGraphStore;
  fetchImplementation?: SearchFetch;
  readStreamImplementation?: SearchStreamReader;
  createRunId?: () => SearchRequest["runId"];
  onStart?: (request: SearchRequest) => void;
  onComplete?: (result: ResultGraph) => void;
}>;

type ActiveRun = Readonly<{
  /** Controller（控制器）对象身份同时充当当前 Run 的唯一所有权令牌。 */
  controller: AbortController;
}>;

export type StartStreamingSearchInput = Readonly<
  Pick<SearchRequest, "query" | "language">
>;

/** 无 runId 的 UI 输入仍复用公共 Contract 字段，不在 Web 复制语义。 */
const SearchInputSchema = SearchRequestSchema.pick({
  query: true,
  language: true,
});

/** 默认 ID 由浏览器原生能力生成，不额外引入运行时依赖。 */
const createDefaultRunId = (): SearchRequest["runId"] =>
  globalThis.crypto.randomUUID();

/**
 * 创建一个串行拥有当前 Controller 的搜索入口。
 * 工厂闭包是所有权边界：只有仍持有当前 Controller 的 Run 才能在 finally 中清理它。
 */
export function createStartStreamingSearch(
  dependencies: SearchCoordinatorDependencies,
): (input: StartStreamingSearchInput) => Promise<void> {
  const fetchImplementation =
    dependencies.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  const readStreamImplementation =
    dependencies.readStreamImplementation ?? readSearchEventStream;
  const createRunId = dependencies.createRunId ?? createDefaultRunId;
  let activeRun: ActiveRun | undefined;

  return async (input: StartStreamingSearchInput): Promise<void> => {
    /**
     * 先同时校验 Query 与 language，再分配 ID 和取消旧 Run。
     * 这样任一无效字段都不会破坏仍然有效的当前搜索。
     */
    const validatedInput = SearchInputSchema.parse(input);
    const request = SearchRequestSchema.parse({
      runId: createRunId(),
      ...validatedInput,
    });
    const controller = new AbortController();
    const previousRun = activeRun;

    // Abort 事件同步分发；B 无需等待 A 的网络栈清理即可立即取得 Store 所有权。
    previousRun?.controller.abort(
      new DOMException("新 Query 已开始", "AbortError"),
    );
    activeRun = { controller };
    dependencies.store.getState().startRun(request);
    dependencies.onStart?.(request);

    /** 旧 Reader 结束时只能关闭自己的 Run，不能误关后来接管 Store 的请求。 */
    const closeRunIfActive = (): void => {
      const state = dependencies.store.getState();
      if (state.activeRunId === request.runId && state.isSearching) {
        state.finishRun();
      }
    };

    try {
      const response = await fetchImplementation("/api/search", {
        method: "POST",
        headers: {
          Accept: "application/x-ndjson",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      await readStreamImplementation({
        response,
        signal: controller.signal,
        onEvent: event => {
          const before = dependencies.store.getState();
          // 交付回调只能观察真正被当前 Run 接纳的 complete，过期事件不能写进历史记录。
          const acceptsComplete = event.type === "complete" &&
            before.activeRunId === event.runId && before.isSearching &&
            event.sequence > before.lastSequence && event.data.result.runId === event.runId;
          before.applyStreamEvent(event);
          if (acceptsComplete && event.type === "complete") {
            dependencies.onComplete?.(event.data.result);
          }
        },
        closeRun: closeRunIfActive,
      });
    } catch (error) {
      closeRunIfActive();

      // 仅吸收本协调器确实发出的 Signal（中止信号）；独立 AbortError 仍是需要诊断的真实失败。
      if (controller.signal.aborted) return;
      throw error;
    } finally {
      if (activeRun?.controller === controller) {
        activeRun = undefined;
      }
    }
  };
}

/** 应用级入口；Omnibox 只需调用此函数，不负责 Controller 生命周期。 */
export const startStreamingSearch = createStartStreamingSearch({
  store: graphStore,
});
