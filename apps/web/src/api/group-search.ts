/**
 * 小组搜索复用原协调器与预览模型；完成结果只通过收据应用，不把运行草图写入共享图。
 * 版本冲突保留预览，只有人员显式确认当前版本才允许重新应用；断线不排队或自动重搜。
 */
import { createStore } from "zustand/vanilla";
import { resolveSearchEngine, type GroupGraphAction, type GroupSearchReceipt, type GroupSearchTarget, type SearchRequest, type CredentialService, type SearchCredentials } from "@wayfinder/contracts";
import { createStartStreamingSearch, type SearchCoordinatorDependencies, type StartStreamingSearchInput } from "./search.js";
import type { ResearchPreview } from "./research.js";
import { prepareSearchCredentials } from "./credentials.js";
import { GroupRequestError } from "./groups.js";
import { createGraphStore } from "../stores/graph-store.js";
import { accountStore } from "../stores/account.js";
import { accountKeysStore } from "../stores/account-keys.js";
import { groupSync, type createGroupSync } from "../stores/group-sync.js";

type ApplyAction = Extract<GroupGraphAction, { action: "applySearch" }>;
type SearchContext = { userId: string; target: GroupSearchTarget; autoApply: boolean; preview: ResearchPreview;
  receipt: GroupSearchReceipt | null; sentConnectionId: string | null; pending: ApplyAction | null };
export type GroupSearchState = { preview: ResearchPreview | null; error: string | null; applying: boolean; autoApply: boolean };
type Dependencies = Pick<SearchCoordinatorDependencies, "fetchImplementation" | "readStreamImplementation" | "createRunId" | "prepareCredentials">;
export function createGroupSearchController(sync: ReturnType<typeof createGroupSync> = groupSync, dependencies: Dependencies = {}) {
  const runStore = createGraphStore(), store = createStore<GroupSearchState>()(() => ({ preview: null, error: null, applying: false, autoApply: false }));
  let intent = 0, active: SearchContext | null = null;
  let preparedCredentials: SearchCredentials | undefined;
  const currentRecord = (context: SearchContext) => sync.store.getState().snapshot?.workspace.graphs
    .find(record => record.document.id === context.target.graphId && record.status === "active");
  const contextHeaders = (context: SearchContext) => {
    const state = sync.store.getState();
    if (state.state !== "online" || state.userId !== context.userId || state.groupId !== context.target.groupId || state.connectionId === null) {
      throw new GroupRequestError("GROUP_OFFLINE");
    }
    const record = currentRecord(context);
    if (record === undefined || context.target.nodeId !== undefined && !record.document.nodes.some(node => node.id === context.target.nodeId)) {
      throw new GroupRequestError("GROUP_NOT_FOUND");
    }
    return { userId: context.userId, connectionId: state.connectionId, target: context.target };
  };
  const clear = (): void => {
    ++intent; active = null; preparedCredentials = undefined; search.cancelPending(); search.cancel();
    store.setState({ preview: null, error: null, applying: false, autoApply: false });
  };
  const apply = async (mode: "append" | "replace", confirmed = false): Promise<boolean> => {
    const context = active;
    if (context === null || context.receipt === null || context.preview.result === null || context.preview.status !== "ready" || store.getState().applying) return false;
    store.setState({ applying: true, error: null });
    try {
      contextHeaders(context);
      const record = currentRecord(context); if (record === undefined) throw new GroupRequestError("GROUP_NOT_FOUND");
      if (context.target.nodeId === undefined && mode !== "replace") return false;
      if (context.pending === null) {
        if (record.revision !== context.target.expectedRevision && !confirmed) throw new GroupRequestError("GROUP_CONFLICT");
        // 布局只在真正应用时加载，首页／只查看组列表不提前拉入Dagre和图画布。
        const projection = context.target.nodeId === undefined ? await import("../stores/workspace-research.js") : null;
        if (active !== context) return false;
        contextHeaders(context);
        const projected = projection === null ? null : projection.applyGraphSearchResult(record.document, context.preview.result);
        context.pending = { action: "applySearch", groupId: context.target.groupId, graphId: context.target.graphId,
          expectedRevision: record.revision, mutationId: crypto.randomUUID(), receipt: context.receipt, result: context.preview.result, mode,
          ...(projected === null ? {} : { positions: projected.positions }),
          ...(record.revision === context.target.expectedRevision ? {} : { confirmedRevision: record.revision }),
        };
      } else if (context.pending.mode !== mode) throw new GroupRequestError("GROUP_UNAVAILABLE");
      const action = context.pending;
      store.setState({ applying: true, error: null });
      await sync.write(action);
      if (active === context) clear(); return true;
    } catch (error: unknown) {
      const code = error instanceof GroupRequestError ? error.code : "GROUP_UNAVAILABLE";
      if (active === context) {
        const receipt = sync.store.getState().lastReceipt;
        if (context.pending !== null && receipt?.mutationId === context.pending.mutationId && receipt.applied) { clear(); return true; }
        // 确认未知保留原请求标识及内容；人员重试同一动作也不能生成第二份搜索应用。
        if (!["GROUP_UNAVAILABLE", "GROUP_OFFLINE"].includes(code)) context.pending = null;
        store.setState({ applying: false, error: code });
      }
      return false;
    } finally { if (active === context) store.setState({ applying: false }); }
  };
  let starting: SearchContext | null = null;
  const search = createStartStreamingSearch({
    ...dependencies, store: runStore,
    // 新组图可在凭据检查后建立，随后只消费这一份检查快照；秘密不留在预览状态中。
    prepareCredentials: signal => {
      const prepared = preparedCredentials; preparedCredentials = undefined;
      return prepared === undefined ? (dependencies.prepareCredentials ?? prepareSearchCredentials)(signal) : Promise.resolve(prepared);
    },
    groupContext: () => {
      if (starting === null) throw new GroupRequestError("GROUP_OFFLINE");
      const context = contextHeaders(starting); starting.sentConnectionId = context.connectionId; return context;
    },
    onStart: (request: SearchRequest) => {
      if (starting === null) return;
      active = starting; active.preview.runId = request.runId;
      store.setState({ preview: active.preview, error: null, applying: false, autoApply: active.autoApply });
    },
    onComplete: (result, receipt) => {
      const context = active; if (context === null || context.preview.runId !== result.runId || receipt === undefined) return;
      const usable = result.graph.nodes.some(node => (context.target.nodeId === undefined || node.id === context.target.nodeId)
        && node.status !== "failed" && node.resources.length > 0);
      context.receipt = receipt; context.preview = { ...context.preview, result, status: usable ? "ready" : "failed" };
      store.setState({ preview: context.preview });
      if (usable && context.autoApply) void apply("replace");
    },
  });
  const unsubscribe = sync.store.subscribe((next, previous) => {
    if (next.userId !== previous.userId || next.groupId !== previous.groupId || next.state === "closed") { clear(); return; }
    if (active === null) return;
    const record = currentRecord(active);
    if (record === undefined || active.target.nodeId !== undefined && !record.document.nodes.some(node => node.id === active?.target.nodeId)) { clear(); return; }
    if (["offline", "reconnecting"].includes(next.state) && active.preview.status === "searching") { clear(); store.setState({ error: "GROUP_OFFLINE" }); }
  });
  return {
    store, runStore, apply, cancel: clear, dismiss: clear,
    cancelPending: (): void => { search.cancelPending(); },
    cancelForCloudKeyChange: (services: readonly CredentialService[]): boolean => {
      if (!search.cancelForCloudKeyChange(services)) return false;
      clear(); return true;
    },
    start: async (target: GroupSearchTarget, input: StartStreamingSearchInput, autoApply = false,
      options: Readonly<{ onStart?: (runId: string) => void; credentials?: SearchCredentials; signal?: AbortSignal }> = {}): Promise<void> => {
      const state = sync.store.getState(); if (state.userId === null) throw new GroupRequestError("ACCOUNT_REQUIRED");
      const context: SearchContext = { userId: state.userId, target, autoApply, receipt: null, sentConnectionId: null, pending: null,
        preview: { graphId: target.graphId, nodeId: target.nodeId ?? null, runId: null, query: input.query,
          language: input.language, engine: resolveSearchEngine(input.language, input.engine), status: "searching", result: null } };
      contextHeaders(context); const current = ++intent; starting = context;
      preparedCredentials = options.credentials;
      try { await search(input, { ...(options.onStart === undefined ? {} : { onStart: options.onStart }), ...(options.signal === undefined ? {} : { signal: options.signal }) }); }
      catch (error: unknown) {
        if (current === intent) {
          const code = error instanceof GroupRequestError ? error.code : "GROUP_UNAVAILABLE";
          if (context.sentConnectionId !== null && ["GROUP_OFFLINE", "ACCOUNT_REQUIRED", "GROUP_FORBIDDEN", "GROUP_NOT_FOUND"].includes(code)) {
            sync.rejectConnection(code, context.sentConnectionId);
          }
          if (active === context && context.preview.status === "searching") {
            context.preview = { ...context.preview, status: "failed" }; store.setState({ preview: context.preview });
          }
          store.setState({ error: code });
        }
        throw error;
      } finally {
        if (starting === context) { starting = null; preparedCredentials = undefined; }
        if (active === context && context.preview.status === "searching") {
          context.preview = { ...context.preview, status: "failed" }; store.setState({ preview: context.preview });
        }
      }
    },
    dispose: (): void => { unsubscribe(); clear(); },
  };
}
export const groupSearch = createGroupSearchController();

/** 仅已加载的单例订阅身份／Key代际，不让首页为清理而提前加载组搜索。 */
accountStore.subscribe((next, previous) => { if (next.epoch !== previous.epoch) groupSearch.cancel(); });
accountKeysStore.subscribe((next, previous) => {
  if (next.generation !== previous.generation) groupSearch.cancelForCloudKeyChange(next.changedServices);
});
