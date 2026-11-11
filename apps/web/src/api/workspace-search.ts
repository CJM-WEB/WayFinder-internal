/**
 * 模块职责：把一次新搜索关联到稳定图记录，完成结果单向交付工作区。
 * 浏览旧记录不会调用本入口；运行草图仍由现有 graph-store 管理。
 */
import { resolveSearchEngine, type SearchRequest, type ResultGraph } from "@wayfinder/contracts";

import { createStartStreamingSearch } from "./search.js";
import { buildGraphFlowElements } from "../components/Graph/graph-layout.js";
import { graphStore } from "../stores/graph-store.js";
import { accountStore } from "../stores/account.js";
import { accountKeysStore } from "../stores/account-keys.js";
import {
  createEmptyGraph,
  fromResultGraph,
  workspaceStore,
  type WorkspaceStoreState,
} from "../stores/workspace-store.js";

type Workspace = Readonly<{
  getState: () => WorkspaceStoreState;
}>;

/** 小型交付函数便于回归检查取消、记录删除和切换，不引入第二套运行状态机。 */
export const createWorkspaceSearchHandoff = (
  store: Workspace = workspaceStore,
  createGraphId: () => string = () => crypto.randomUUID(),
) => ({
  onStart(request: SearchRequest): void {
    const document = createEmptyGraph(createGraphId(), request.query, request.language);
    store.getState().addGraph({ ...document, query: request.query, lastRunId: request.runId, engine: resolveSearchEngine(request.language, request.engine) });
  },
  onComplete(result: ResultGraph): void {
    const previous = store.getState().documents.find(document => document.lastRunId === result.runId);
    // 用户已删掉记录时不复活；切到另一图时只更新所属记录，不抢回当前选择。
    if (previous === undefined) return;
    const document = fromResultGraph(result, previous.id);
    const elements = buildGraphFlowElements(document.nodes, document.edges, document.language);
    store.getState().replaceGraph({
      ...document, title: previous.title, createdAt: previous.createdAt,
      ...(previous.engine === undefined ? {} : { engine: previous.engine }),
      positions: Object.fromEntries(elements.nodes.map(node => [node.id, node.position])),
    }, { kind: "graph.search", subject: previous.title, scope: { type: "graph.replace" } });
  },
});

export const startWorkspaceSearch = createStartStreamingSearch({
  store: graphStore,
  ...createWorkspaceSearchHandoff(),
});

/** 单例加载后才订阅，真实换号同步取消旧运行，不改变原来的按需导入。 */
accountStore.subscribe((next, previous) => {
  if (next.epoch !== previous.epoch) { startWorkspaceSearch.cancelPending(); startWorkspaceSearch.cancel(); }
});

accountKeysStore.subscribe((next, previous) => {
  if (next.generation !== previous.generation) startWorkspaceSearch.cancelForCloudKeyChange(next.changedServices);
});
