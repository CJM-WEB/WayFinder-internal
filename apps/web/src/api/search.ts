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
}>;

type ActiveRun = Readonly<{
  /** Controller（控制器）对象身份同时充当当前 Run 的唯一所有权令牌。 */
  controller: AbortController;
}>;

/** 默认 ID 由浏览器原生能力生成，不额外引入运行时依赖。 */
const createDefaultRunId = (): SearchRequest["runId"] =>
  globalThis.crypto.randomUUID();

/**
 * 创建一个串行拥有当前 Controller 的搜索入口。
 * 工厂闭包是所有权边界：只有仍持有当前 Controller 的 Run 才能在 finally 中清理它。
 */
export function createStartStreamingSearch(
  dependencies: SearchCoordinatorDependencies,
): (query: string) => Promise<void> {
  const fetchImplementation =
    dependencies.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  const readStreamImplementation =
    dependencies.readStreamImplementation ?? readSearchEventStream;
  const createRunId = dependencies.createRunId ?? createDefaultRunId;
  let activeRun: ActiveRun | undefined;

  return async (query: string): Promise<void> => {
    /**
     * 先单独校验并规范化 Query，再分配 ID 和取消旧 Run。
     * 这样空白、超长等无效输入不会破坏仍然有效的当前搜索。
     */
    const normalizedQuery = SearchRequestSchema.shape.query.parse(query);
    const request = SearchRequestSchema.parse({
      runId: createRunId(),
      query: normalizedQuery,
    });
    const controller = new AbortController();
    const previousRun = activeRun;

    // Abort 事件同步分发；B 无需等待 A 的网络栈清理即可立即取得 Store 所有权。
    previousRun?.controller.abort(
      new DOMException("新 Query 已开始", "AbortError"),
    );
    activeRun = { controller };
    dependencies.store.getState().startRun(request);

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
        onEvent: event => dependencies.store.getState().applyStreamEvent(event),
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
