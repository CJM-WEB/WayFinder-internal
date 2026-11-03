/**
 * 模块职责：保存可编辑搜索图及每张图独立的会话撤销状态。
 * 搜索运行仍由 graph-store 管理；只有明确交付或应用的结果才单向进入工作区。
 * 边界：快照通过 Zod 解析复制，不共享调用方的可变对象；历史不进入持久化文档。
 */
import {
  EditableGraphSchema,
  ResultGraphSchema,
  type EditableGraph,
  type ResultGraph,
  type SearchLanguage,
} from "@wayfinder/contracts";
import { createStore } from "zustand/vanilla";
import {
  appendHistory, createGraphHistory, describeHistory, inferHistoryDescription, redoHistoryEvent,
  sameGraphContent, undoHistoryEvent,
  type GraphHistory, type WorkspaceHistoryDescription, type WorkspaceHistoryEventView, type WorkspaceHistoryResult,
} from "./workspace-history.js";

export type { WorkspaceHistoryDescription, WorkspaceHistoryEvent, WorkspaceHistoryEventView,
  WorkspaceHistoryKind, WorkspaceHistoryBlockedReason, WorkspaceHistoryResult, WorkspaceHistoryScope } from "./workspace-history.js";

export const WORKSPACE_HISTORY_LIMIT = 100;

type DeletedGraph = { document: EditableGraph; index: number; history: GraphHistory };
type WorkspaceData = {
  documents: EditableGraph[];
  currentId: string | null;
  selectedNodeIds: Record<string, string | null>;
  histories: Record<string, GraphHistory>;
  deletedGraphs: DeletedGraph[];
};
type WorkspaceActions = {
  addGraph: (graph: EditableGraph) => void;
  selectGraph: (id: string | null) => void;
  selectNode: (id: string | null) => void;
  replaceGraph: (graph: EditableGraph, description?: WorkspaceHistoryDescription) => void;
  renameGraph: (id: string, title: string) => void;
  deleteGraph: (id: string) => void;
  restoreDeletedGraph: () => void;
  undo: () => void;
  undoEvent: (eventId: string) => WorkspaceHistoryResult;
  redo: () => void;
  restoreDocuments: (documents: EditableGraph[], currentId: string | null) => void;
};
export type WorkspaceStoreState = WorkspaceData & WorkspaceActions;

const initialState = (): WorkspaceData => ({
  documents: [], currentId: null, selectedNodeIds: {}, histories: {}, deletedGraphs: [],
});

/** 空文档不伪造查询、搜索运行或节点；界面负责传入当前语言的记录标题。 */
export const createEmptyGraph = (
  id: string,
  title: string,
  language: SearchLanguage,
  at = new Date().toISOString(),
): EditableGraph => EditableGraphSchema.parse({
  version: "workspace.v1", id, title, query: "", language,
  presentationMode: "graph", createdAt: at, updatedAt: at, lastRunId: null,
  nodes: [], edges: [], positions: {},
});

/** 真实结果只在此边界转换；来源和失败信息保持原样，不让编辑协议反向放宽搜索结果。 */
export const fromResultGraph = (result: ResultGraph, graphId: string): EditableGraph => {
  const validated = ResultGraphSchema.parse(result);
  return EditableGraphSchema.parse({
    version: "workspace.v1",
    id: graphId,
    title: validated.query.raw,
    query: validated.query.raw,
    language: validated.query.language,
    presentationMode: validated.analysis.presentationMode,
    analysis: validated.analysis,
    createdAt: validated.meta.createdAt,
    updatedAt: validated.meta.createdAt,
    lastRunId: validated.runId,
    nodes: validated.graph.nodes.map(node => ({
      ...node,
      resources: node.resources.map(resource => ({ ...resource, origin: "search" as const })),
    })),
    edges: validated.graph.edges,
    positions: {},
  });
};

/** 当前图始终由稳定 ID 查找，不维护会随增删操作失效的数组下标。 */
export const selectCurrentGraph = (state: WorkspaceStoreState): EditableGraph | null =>
  state.documents.find(document => document.id === state.currentId) ?? null;

/** UI 可按原始 history 引用 memo；选择器不泄露实体快照，也不缓存过期阻断判定。 */
export const selectWorkspaceHistory = (state: WorkspaceStoreState): readonly WorkspaceHistoryEventView[] => {
  const history = state.histories[state.currentId ?? ""];
  return history === undefined ? [] : describeHistory(history);
};

type WorkspaceHistoryClock = Readonly<{ now?: () => string; createEventId?: () => string }>;

export const createWorkspaceStore = (clock: WorkspaceHistoryClock = {}) => createStore<WorkspaceStoreState>()((set, get) => ({
  ...initialState(),
  addGraph: input => {
    const document = EditableGraphSchema.parse(input);
    set(state => {
      if (state.documents.some(item => item.id === document.id)) throw new Error("搜索图标识重复");
      return {
        documents: [...state.documents, document], currentId: document.id,
        histories: { ...state.histories, [document.id]: createGraphHistory(document) },
      };
    });
  },
  selectGraph: id => {
    if (id !== null && !get().documents.some(document => document.id === id)) return;
    set({ currentId: id });
  },
  selectNode: id => {
    set(state => {
      const document = selectCurrentGraph(state);
      if (document === null || (id !== null && !document.nodes.some(node => node.id === id))) return state;
      if (state.selectedNodeIds[document.id] === id) return state;
      return { selectedNodeIds: { ...state.selectedNodeIds, [document.id]: id } };
    });
  },
  replaceGraph: (input, description) => {
    const document = EditableGraphSchema.parse(input);
    set(state => {
      const previous = state.documents.find(item => item.id === document.id);
      if (previous === undefined) throw new Error("搜索图不存在");
      if (sameGraphContent(previous, document)) return state;
      const history = state.histories[document.id] ?? createGraphHistory(previous);
      return {
        documents: state.documents.map(item => item.id === document.id ? document : item),
        histories: {
          ...state.histories,
          [document.id]: appendHistory(history, previous, document, {
            ...(description ?? inferHistoryDescription(previous, document)),
            id: clock.createEventId?.() ?? crypto.randomUUID(),
            occurredAt: clock.now?.() ?? new Date().toISOString(), active: true,
          }, WORKSPACE_HISTORY_LIMIT),
        },
      };
    });
  },
  renameGraph: (id, title) => {
    const document = get().documents.find(item => item.id === id);
    if (document === undefined || document.title === title) return;
    get().replaceGraph({ ...document, title, updatedAt: new Date().toISOString() });
  },
  deleteGraph: id => {
    set(state => {
      const index = state.documents.findIndex(document => document.id === id);
      const document = state.documents[index];
      if (document === undefined) return state;
      const documents = state.documents.filter(item => item.id !== id);
      const histories = { ...state.histories };
      delete histories[id];
      return {
        documents, histories,
        currentId: state.currentId === id ? documents[0]?.id ?? null : state.currentId,
        deletedGraphs: [...state.deletedGraphs, {
          document, index, history: state.histories[id] ?? createGraphHistory(document),
        }].slice(-WORKSPACE_HISTORY_LIMIT),
      };
    });
  },
  restoreDeletedGraph: () => {
    set(state => {
      const deleted = state.deletedGraphs.at(-1);
      if (deleted === undefined || state.documents.some(document => document.id === deleted.document.id)) return state;
      const documents = [...state.documents];
      documents.splice(deleted.index, 0, deleted.document);
      return {
        documents, currentId: deleted.document.id,
        histories: { ...state.histories, [deleted.document.id]: deleted.history },
        deletedGraphs: state.deletedGraphs.slice(0, -1),
      };
    });
  },
  undo: () => {
    const state = get();
    const event = state.histories[state.currentId ?? ""]?.events.findLast(item => item.active);
    if (event !== undefined) state.undoEvent(event.id);
  },
  undoEvent: eventId => {
    let outcome: WorkspaceHistoryResult = { ok: false, reason: "missing" };
    set(state => {
      const document = selectCurrentGraph(state);
      if (document === null) return state;
      const history = state.histories[document.id];
      const event = history?.events.find(item => item.id === eventId);
      if (history === undefined || event === undefined) return state;
      if (!event.active) { outcome = { ok: false, reason: "inactive" }; return state; }
      // 每次执行重新读取当前图所属事件；失败既不修改文档，也不改变 Undo/Redo 分支。
      const result = undoHistoryEvent(history, eventId);
      if (!result.ok) { outcome = result; return state; }
      outcome = { ok: true };
      return {
        documents: state.documents.map(item => item.id === document.id ? result.graph : item),
        histories: { ...state.histories, [document.id]: result.history },
      };
    });
    return outcome;
  },
  redo: () => {
    set(state => {
      const document = selectCurrentGraph(state);
      if (document === null) return state;
      const history = state.histories[document.id];
      if (history === undefined) return state;
      const result = redoHistoryEvent(history);
      if (result === null || !result.ok) return state;
      return {
        documents: state.documents.map(item => item.id === document.id ? result.graph : item),
        histories: { ...state.histories, [document.id]: result.history },
      };
    });
  },
  restoreDocuments: (inputs, currentId) => {
    const documents = inputs.map(document => EditableGraphSchema.parse(document));
    if (new Set(documents.map(document => document.id)).size !== documents.length) throw new Error("搜索图标识重复");
    set({
      ...initialState(), documents,
      currentId: documents.some(document => document.id === currentId) ? currentId : documents[0]?.id ?? null,
      histories: Object.fromEntries(documents.map(document => [document.id, createGraphHistory(document)])),
    });
  },
}));

export const workspaceStore = createWorkspaceStore();
