/**
 * 模块职责：使用临时 Run 生成重搜预览，用户明确应用后才修改当前工作图。
 * 旧图不接收临时流；取消、迟到结果、切图或删除目标都不能复活或改写其他记录。
 */
import { resolveSearchEngine, type ResultGraph, type SearchEngine, type SearchLanguage } from "@wayfinder/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";

import { createStartStreamingSearch, SearchInputSchema, type SearchCoordinatorDependencies } from "./search.js";
import { startWorkspaceSearch } from "./workspace-search.js";
import { createGraphStore } from "../stores/graph-store.js";
import { fromResultGraph, workspaceStore, type WorkspaceStoreState } from "../stores/workspace-store.js";
import { applyGraphSearchResult, applyNodeSearchResult } from "../stores/workspace-research.js";

export type ResearchPreview = {
  graphId: string;
  nodeId: string | null;
  runId: string | null;
  query: string;
  language: SearchLanguage;
  engine: SearchEngine;
  status: "searching" | "ready" | "failed";
  result: ResultGraph | null;
};
type ResearchState = {
  runStore: ReturnType<typeof createGraphStore>;
  inputError: "query" | "target" | null;
  preview: ResearchPreview | null;
  start: (graphId: string, nodeId?: string, topic?: string, onStart?: () => void) => Promise<void>;
  cancel: () => void;
  cancelPending: () => void;
  dismiss: () => void;
  apply: (mode: "append" | "replace") => void;
};
type ResearchDependencies = Pick<SearchCoordinatorDependencies, "fetchImplementation" | "readStreamImplementation" | "createRunId" | "prepareCredentials">;

export function createResearchStore(
  workspace: StoreApi<WorkspaceStoreState> = workspaceStore,
  dependencies: ResearchDependencies = {},
  cancelForeground: () => void = () => startWorkspaceSearch.cancel(),
  cancelForegroundPending: () => void = () => startWorkspaceSearch.cancelPending(),
) {
  let owner: ResearchPreview | null = null;
  let pendingTarget: { controller: AbortController; graphId: string; nodeId?: string } | null = null;
  const temporaryRun = createGraphStore();
  const store = createStore<ResearchState>(() => ({
    runStore: temporaryRun,
    inputError: null,
    preview: null,
    start: async (graphId, nodeId, topic, onStart): Promise<void> => {
      const graph = workspace.getState().documents.find(document => document.id === graphId);
      const node = nodeId === undefined ? undefined : graph?.nodes.find(item => item.id === nodeId);
      if (graph === undefined || workspace.getState().currentId !== graphId || (nodeId !== undefined && node === undefined)) {
        store.setState({ inputError: "target" });
        return;
      }
      const query = graph.query.trim() || (node === undefined ? topic?.trim() ?? "" : node.title);
      // 与正常搜索复用完整输入校验；必须先通过，再取消任何有效的旧请求或预览。
      const parsed = SearchInputSchema.safeParse({
        query, language: graph.language, engine: resolveSearchEngine(graph.language, node?.engine ?? graph.engine),
        ...(node === undefined ? {} : { nodeSearch: {
          node: { id: node.id, title: node.title, description: node.description }, analysis: graph.analysis ?? null,
        } }),
      });
      if (!parsed.success) {
        store.setState({ inputError: "query" });
        return;
      }
      cancelForegroundPending();
      // 尚未获得配置许可时，仅替换待检查意图，旧运行与预览保持原状。
      pendingTarget?.controller.abort(new DOMException("重搜意图已替换", "AbortError"));
      const intent = { controller: new AbortController(), graphId, ...(nodeId === undefined ? {} : { nodeId }) };
      pendingTarget = intent;
      const context: ResearchPreview = {
        graphId, nodeId: nodeId ?? null, runId: null,
        query: parsed.data.query,
        language: parsed.data.language,
        engine: resolveSearchEngine(graph.language, node?.engine ?? graph.engine),
        status: "searching", result: null,
      };
      try {
        await search(parsed.data, {
          signal: intent.controller.signal,
          onStart: runId => {
            // 此回调与真正Run创建同步发生；取消旧前台和清空旧预览只能在此之后。
            pendingTarget = null;
            cancelForeground();
            context.runId = runId;
            owner = context;
            store.setState({ preview: { ...context }, inputError: null });
            onStart?.();
          },
        });
      } catch {
        // 原始 Provider / 网络异常不进入界面或本地记录，只保留可理解的失败状态。
        if (owner === context && store.getState().preview?.status === "searching") store.setState({ preview: { ...context, status: "failed" } });
      } finally {
        if (pendingTarget === intent) pendingTarget = null;
      }
      if (owner === context && store.getState().preview?.status === "searching") {
        store.setState({ preview: { ...context, status: "failed" } });
      }
    },
    cancel: () => {
      store.getState().cancelPending();
      owner = null;
      search.cancel();
      store.setState({ preview: null, inputError: null });
    },
    cancelPending: () => {
      pendingTarget?.controller.abort(new DOMException("取消重搜意图", "AbortError"));
      pendingTarget = null;
    },
    dismiss: () => store.getState().cancel(),
    apply: mode => {
      const preview = store.getState().preview;
      if (preview?.status !== "ready" || preview.result === null ||
          (preview.nodeId === null && mode === "append")) return;
      const state = workspace.getState();
      const graph = state.documents.find(document => document.id === preview.graphId);
      if (graph === undefined || state.currentId !== preview.graphId) return;
      try {
        const next = preview.nodeId === null
          ? applyGraphSearchResult(graph, preview.result)
          : applyNodeSearchResult(graph, preview.nodeId, preview.result, mode);
        // 应用时再次读取当前图；预览后新增的重复 URL 或删除目标不能被旧预览覆盖。
        if (next === graph) {
          store.setState({ preview: { ...preview, status: "failed" } });
          return;
        }
        // 作用范围表达真实应用意图；同值结果也归本次替换拥有，不能只从前后差异猜测。
        state.replaceGraph(next, preview.nodeId === null
          ? { kind: "graph.search", subject: graph.title, scope: { type: "graph.replace" } }
          : { kind: "node.search", subject: graph.nodes.find(node => node.id === preview.nodeId)?.title ?? graph.title,
            scope: { type: mode === "append" ? "node.append" : "node.replace", nodeId: preview.nodeId } });
        if (preview.nodeId === null) {
          const previewSelection = temporaryRun.getState().selectedNodeId;
          const selected = next.nodes.some(node => node.id === previewSelection) ? previewSelection
            : next.presentationMode === "compact" ? next.nodes.find(node => node.resources.length > 0)?.id ?? null : null;
          state.selectNode(selected);
        }
        store.getState().dismiss();
      } catch {
        store.setState({ preview: { ...preview, status: "failed" } });
      }
    },
  }));
  const search = createStartStreamingSearch({
    ...dependencies,
    store: temporaryRun,
    onComplete: result => {
      const context = owner;
      if (context === null || result.runId !== context.runId) return;
      try {
        fromResultGraph(result, context.graphId);
        const usable = context.nodeId === null
          ? result.graph.nodes.some(node => node.status !== "failed" && node.resources.length > 0)
          : result.graph.nodes.some(node => node.id === context.nodeId && node.status !== "failed" && node.resources.length > 0);
        store.setState({ preview: { ...context, result, status: usable ? "ready" : "failed" } });
      } catch {
        store.setState({ preview: { ...context, status: "failed" } });
      }
    },
  });
  // 切图后再切回也不能复活迟到检查；仅实体失效时撤销，不把普通图编辑误判成取消。
  workspace.subscribe(state => {
    if (pendingTarget === null) return;
    const target = state.documents.find(document => document.id === pendingTarget?.graphId);
    if (state.currentId !== pendingTarget.graphId || target === undefined ||
        (pendingTarget.nodeId !== undefined && !target.nodes.some(node => node.id === pendingTarget?.nodeId))) {
      pendingTarget.controller.abort(new DOMException("重搜目标已失效", "AbortError"));
      pendingTarget = null;
    }
  });
  return store;
}

export const researchStore = createResearchStore();
