/**
 * 模块职责：把一次新搜索关联到稳定图记录，完成结果单向交付工作区。
 * 浏览旧记录不会调用本入口；运行草图仍由现有 graph-store 管理。
 */
import type { SearchRequest, ResultGraph } from "@wayfinder/contracts";

import { createStartStreamingSearch } from "./search.js";
import { buildGraphFlowElements } from "../components/Graph/graph-layout.js";
import { graphStore } from "../stores/graph-store.js";
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
    store.getState().addGraph({ ...document, query: request.query, lastRunId: request.runId });
  },
  onComplete(result: ResultGraph): void {
    const previous = store.getState().documents.find(document => document.lastRunId === result.runId);
    // 用户已删掉记录时不复活；切到另一图时只更新所属记录，不抢回当前选择。
    if (previous === undefined) return;
    const document = fromResultGraph(result, previous.id);
    const elements = buildGraphFlowElements(document.nodes, document.edges, document.language);
    store.getState().replaceGraph({
      ...document, title: previous.title, createdAt: previous.createdAt,
      positions: Object.fromEntries(elements.nodes.map(node => [node.id, node.position])),
    });
  },
});

export const startWorkspaceSearch = createStartStreamingSearch({
  store: graphStore,
  ...createWorkspaceSearchHandoff(),
});
