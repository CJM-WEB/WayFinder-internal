/**
 * 模块职责：把一次合法 Query（查询）协调为唯一 Run（运行），并管理浏览器端取消与流读取生命周期。
 *
 * 关键边界：
 * - 输入必须先通过公共 SearchRequest Contract，非法输入不能中止仍在运行的搜索。
 * - 凭据检查属于可撤销的搜索意图；只有检查通过才分配运行身份、取消旧Run或交付界面副作用。
 * - 新 Run 同步取消旧 Run，但不等待旧 fetch、Reader（读取器）或 finally；
 *   旧事件由 Store（状态仓库）的 runId 门禁兜底。
 * - 用户发起的替换取消属于正常控制流，不伪装为服务端 `run.failed`；其余错误保持原始对象上抛。
 */
import {
  SearchRequestSchema,
  SearchCredentialsSchema,
  CredentialsErrorResponseSchema,
  SEARCH_CREDENTIALS_HEADER,
  type SearchRequest,
  type SearchCredentials,
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
import { prepareSearchCredentials, CredentialsConfigurationError } from "./credentials.js";
import { credentialSettingsStore } from "../stores/credential-settings.js";

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
  prepareCredentials?: (signal: AbortSignal) => Promise<SearchCredentials>;
  onStart?: (request: SearchRequest) => void;
  onComplete?: (result: ResultGraph) => void;
}>;

type ActiveRun = Readonly<{
  /** Controller（控制器）对象身份同时充当当前 Run 的唯一所有权令牌。 */
  controller: AbortController;
  runId: SearchRequest["runId"];
}>;

export type StartStreamingSearchInput = Readonly<
  Pick<SearchRequest, "query" | "language" | "engine" | "nodeSearch">
>;

/** 无 runId 的 UI 输入仍复用公共 Contract 字段，不在 Web 复制语义。 */
export const SearchInputSchema = SearchRequestSchema.pick({
  query: true,
  language: true,
  engine: true,
  nodeSearch: true,
});

/** 默认 ID 由浏览器原生能力生成，不额外引入运行时依赖。 */
const createDefaultRunId = (): SearchRequest["runId"] =>
  globalThis.crypto.randomUUID();

/**
 * 创建一个串行拥有当前 Controller 的搜索入口。
 * 工厂闭包是所有权边界：只有仍持有当前 Controller 的 Run 才能在 finally 中清理它。
 */
export type StreamingSearchOptions = Readonly<{
  /** 只有凭据检查通过并已创建真实 Run，界面才能清空预览或交付所有权。 */
  onStart?: (runId: string) => void;
  /** 目标切换/删除只撤销本次意图；未通过检查时不能影响旧 Run。 */
  signal?: AbortSignal;
}>;
export type StreamingSearch = ((input: StartStreamingSearchInput, options?: StreamingSearchOptions) => Promise<void>) & {
  cancel: () => void;
  cancelPending: () => void;
};

export function createStartStreamingSearch(
  dependencies: SearchCoordinatorDependencies,
): StreamingSearch {
  const fetchImplementation =
    dependencies.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  const readStreamImplementation =
    dependencies.readStreamImplementation ?? readSearchEventStream;
  const createRunId = dependencies.createRunId ?? createDefaultRunId;
  const prepareCredentials = dependencies.prepareCredentials ?? prepareSearchCredentials;
  let activeRun: ActiveRun | undefined;
  let pending: AbortController | undefined;

  const startSearch = async (input: StartStreamingSearchInput, options: StreamingSearchOptions = {}): Promise<void> => {
    /**
     * 先同时校验 Query 与 language，再检查凭据、分配 ID 和取消旧 Run。
     * 这样任一无效字段都不会破坏仍然有效的当前搜索。
     */
    const validatedInput = SearchInputSchema.parse(input);
    const controller = new AbortController();
    pending?.abort(new DOMException("新搜索意图已开始", "AbortError"));
    pending = controller;
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]);
    let credentials: SearchCredentials;
    try {
      // 固定同一份凭据快照；保存设置不会替换正在检查或运行的请求。
      credentials = SearchCredentialsSchema.parse(await prepareCredentials(signal));
      if (signal.aborted || pending !== controller) return;
    } catch (error) {
      if (signal.aborted || pending !== controller) return;
      throw error;
    } finally {
      if (pending === controller) pending = undefined;
    }
    const request = SearchRequestSchema.parse({
      runId: createRunId(),
      ...validatedInput,
    });
    const previousRun = activeRun;

    // Abort 事件同步分发；B 无需等待 A 的网络栈清理即可立即取得 Store 所有权。
    previousRun?.controller.abort(
      new DOMException("新 Query 已开始", "AbortError"),
    );
    activeRun = { controller, runId: request.runId };
    dependencies.store.getState().startRun(request);
    dependencies.onStart?.(request);
    options.onStart?.(request.runId);

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
          [SEARCH_CREDENTIALS_HEADER]: JSON.stringify(credentials),
        },
        body: JSON.stringify(request),
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
      signal.throwIfAborted();

      // preflight（调用前检查）与POST之间仍可能轮换邀请码；服务端错误只投影公共字段。
      if (!response.ok) {
        const problem = CredentialsErrorResponseSchema.safeParse(await response.json().catch(() => null));
        signal.throwIfAborted();
        if (problem.success) {
          credentialSettingsStore.getState().setNotice(problem.data);
          throw new CredentialsConfigurationError(problem.data);
        }
      }

      await readStreamImplementation({
        response,
        signal,
        onEvent: event => {
          if (signal.aborted || event.runId !== request.runId) return;
          const before = dependencies.store.getState();
          // 交付回调只能观察真正被当前 Run 接纳的 complete，过期事件不能写进历史记录。
          const acceptsComplete = !signal.aborted && event.runId === request.runId && event.type === "complete" &&
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
      if (signal.aborted) return;
      throw error;
    } finally {
      if (activeRun?.controller === controller) {
        activeRun = undefined;
      }
    }
  };
  return Object.assign(startSearch, {
    cancelPending: (): void => {
      pending?.abort(new DOMException("搜索意图已撤销", "AbortError"));
      pending = undefined;
    },
    cancel: (): void => {
      pending?.abort(new DOMException("用户取消搜索", "AbortError"));
      pending = undefined;
      const current = activeRun;
      if (current === undefined) return;
      current.controller.abort(new DOMException("用户取消搜索", "AbortError"));
      if (activeRun?.controller === current.controller) activeRun = undefined;
      const state = dependencies.store.getState();
      if (state.activeRunId === current.runId && state.isSearching) state.finishRun();
    },
  });
}

/** 应用级入口；Omnibox 只需调用此函数，不负责 Controller 生命周期。 */
export const startStreamingSearch = createStartStreamingSearch({
  store: graphStore,
});
