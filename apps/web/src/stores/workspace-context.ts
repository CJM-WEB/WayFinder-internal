/**
 * 工作区上下文：个人Store始终属于原账号持久化；界面只订阅本模块的受控视图。
 * 小组快照不进入个人Store，写入不乐观修改图、不离线排队，未知确认保留原mutationId。
 * 表单与拖拽捕获开始时的图／版本；切账号、切组或切图后的迟到提交不能跨上下文执行。
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { EditableGraphSchema, resolveSearchEngine, type EditableGraph, type GroupGraphAction, type GroupGraphRecord,
  type GroupGraphReceiptResponse, type GroupGraphWriteResponse } from "@wayfinder/contracts";
import { applyGraphDifference, describeHistory, inferHistoryDescription, redoHistoryEvent, restoreGraphHistory,
  sameGraphContent, type GraphHistory, type WorkspaceHistoryDescription } from "./workspace-history.js";
import { workspaceStore, type WorkspaceStoreState } from "./workspace-store.js";
import { groupSync, type createGroupSync } from "./group-sync.js";
import { accountStore, type AccountState } from "./account.js";
import { workspacePersistenceStore, type WorkspacePersistenceState } from "./workspace-persistence.js";
import { cloudWorkspaceStore, type CloudWorkspaceState } from "./cloud-workspace.js";
import { createCloudWorkspaceApi, type CloudWorkspaceApi } from "../api/cloud-workspace.js";
import { groupApi, GroupRequestError, type GroupApi } from "../api/groups.js";
import { groupSearch } from "../api/group-search.js";
import type { researchStore } from "../api/research.js";

export type CapturedWorkspaceEdit = Readonly<{
  contextKey: string; graphId: string; document: EditableGraph; revision: number | null; selectionEpoch: number;
}>;
export type FailedWorkspaceAction = Readonly<{ action: GroupGraphAction; error: string; uncertain: boolean }>;
export type WorkspaceContextState = {
  kind: "personal" | "group"; contextKey: string; userId: string | null; groupId: string | null; groupName: string | null;
  writable: boolean; busy: boolean; error: string | null; failedAction: FailedWorkspaceAction | null;
};
type Dependencies = {
  personal?: StoreApi<WorkspaceStoreState>; sync?: ReturnType<typeof createGroupSync>; account?: StoreApi<AccountState>;
  persistence?: StoreApi<WorkspacePersistenceState>; cloud?: StoreApi<CloudWorkspaceState>; cloudApi?: CloudWorkspaceApi;
  api?: Pick<GroupApi, "receipt">; search?: typeof groupSearch; research?: typeof researchStore; createId?: () => string;
};
const emptyData = () => ({ documents: [], currentId: null, selectedNodeIds: {}, histories: {}, deletedGraphs: [] });
const data = (state: WorkspaceStoreState) => ({ documents: state.documents, currentId: state.currentId,
  selectedNodeIds: state.selectedNodeIds, histories: state.histories, deletedGraphs: state.deletedGraphs });
const errorCode = (error: unknown): string => error instanceof GroupRequestError ? error.code : "GROUP_UNAVAILABLE";

/** 还原完整因果事件，但只给本人派生真实可重做快照；他人的事件仍参与依赖判定。 */
function groupHistory(record: GroupGraphRecord, userId: string): GraphHistory {
  const source = record.history;
  const history = restoreGraphHistory({ version: "history.v1", base: source.base, events: source.events, redoIds: [] },
    record.document, Number.MAX_SAFE_INTEGER);
  const redoIds = source.redoIdsByUser[userId] ?? [];
  let replay = history;
  const future: EditableGraph[] = [];
  for (const id of redoIds) {
    const next = redoHistoryEvent({ ...replay, redoIds: [id] });
    if (next === null || !next.ok) break;
    future.push(next.graph); replay = next.history;
  }
  return { ...history, redoIds: [...redoIds], future };
}

export function createWorkspaceContext(dependencies: Dependencies = {}) {
  const personal = dependencies.personal ?? workspaceStore, sync = dependencies.sync ?? groupSync;
  const account = dependencies.account ?? accountStore, persistence = dependencies.persistence ?? workspacePersistenceStore;
  const cloud = dependencies.cloud ?? cloudWorkspaceStore, cloudApi = dependencies.cloudApi ?? createCloudWorkspaceApi();
  const api = dependencies.api ?? groupApi, search = dependencies.search ?? groupSearch;
  // 首页只加载上下文和同步；个人重搜及Dagre布局沿用原按需加载边界。
  let research = dependencies.research;
  const personalResearch = async (): Promise<typeof researchStore> => {
    research ??= (await import("../api/research.js")).researchStore;
    return research;
  };
  const createId = dependencies.createId ?? (() => crypto.randomUUID());
  let epoch = 0, selectionEpoch = 0, selectionIntent = 0, quarantine = false, sawLoading = false, desiredGraphId: string | null = null;
  let explicitEmptySelection = false;
  // 原动作与组正文只在本标签内存中待核对，不持久化、不自动发送；导航不能丢失唯一去重标识。
  const unresolved = new Map<string, FailedWorkspaceAction>();
  const ownerKey = (userId: string, groupId: string): string => JSON.stringify([userId, groupId]);
  const context = createStore<WorkspaceContextState>()(() => ({ kind: "personal", contextKey: "personal:0",
    userId: account.getState().scopeUserId, groupId: null, groupName: null, writable: persistence.getState().status !== "loading",
    busy: false, error: null, failedAction: null }));
  const record = (id: string) => sync.store.getState().snapshot?.workspace.graphs.find(item => item.document.id === id);
  const assertContext = (key: string): void => {
    const state = context.getState();
    if (state.contextKey !== key || state.kind !== "group" || state.userId !== account.getState().scopeUserId) throw new GroupRequestError("ACCOUNT_REQUIRED");
  };
  const assertWritable = (): WorkspaceContextState => {
    const state = context.getState();
    assertContext(state.contextKey);
    if (!state.writable || state.busy || state.failedAction !== null || sync.store.getState().state !== "online") throw new GroupRequestError("GROUP_OFFLINE");
    return state;
  };
  const publish = (): void => {
    const state = context.getState();
    if (state.kind === "personal") {
      active.setState(quarantine ? emptyData() : data(personal.getState()));
      context.setState({ writable: !quarantine && persistence.getState().status !== "loading" && persistence.getState().error !== "load" });
      return;
    }
    const live = sync.store.getState(), snapshot = live.snapshot;
    if (live.userId !== state.userId || live.groupId !== state.groupId || snapshot === null) {
      active.setState(emptyData()); context.setState({ writable: false, ...(live.error === null ? {} : { error: live.error }) }); return;
    }
    try {
      const rows = new Map(snapshot.workspace.graphs.map(item => [item.document.id, item]));
      const documents = snapshot.workspace.activeOrder.map(id => rows.get(id)!.document);
      const old = active.getState();
      const requestedId = desiredGraphId ?? old.currentId;
      // 明确打开新搜索输入与首次进入的空选择不同；远端快照不能抢回第一张图打断输入。
      const currentId = explicitEmptySelection && desiredGraphId === null ? null
        : documents.some(item => item.id === requestedId) ? requestedId : documents[0]?.id ?? null;
      if (currentId !== old.currentId) ++selectionEpoch;
      if (desiredGraphId !== null && desiredGraphId === currentId) { desiredGraphId = null; explicitEmptySelection = false; }
      const histories = Object.fromEntries(snapshot.workspace.graphs.map(item => [item.document.id, groupHistory(item, state.userId!)]));
      const selectedNodeIds = Object.fromEntries(documents.map(document => [document.id,
        document.nodes.some(node => node.id === old.selectedNodeIds[document.id]) ? old.selectedNodeIds[document.id] ?? null : null]));
      const deletedGraphs = snapshot.workspace.deletedIds.map(id => {
        const row = rows.get(id)!; return { document: row.document, index: row.originalIndex ?? 0, history: histories[id]! };
      });
      active.setState({ documents, currentId, selectedNodeIds, histories, deletedGraphs });
      context.setState({ groupName: snapshot.details.group.name, writable: live.state === "online",
        ...(live.error === null ? {} : { error: live.error }) });
    } catch { active.setState(emptyData()); context.setState({ writable: false, error: "GROUP_UNAVAILABLE" }); }
  };
  const receipt = async (action: GroupGraphAction, key: string): Promise<GroupGraphReceiptResponse> => {
    assertContext(key);
    const userId = context.getState().userId!;
    const result = await api.receipt(userId, action.mutationId, AbortSignal.timeout(10_000));
    assertContext(key); return result;
  };
  /** 新图只能按本人收据定位；等待权威快照，不从并发列表差集猜测标识。 */
  const awaitGraph = async (id: string, key: string): Promise<void> => {
    desiredGraphId = id;
    if (record(id)?.status === "deleted") { desiredGraphId = null; throw new GroupRequestError("GROUP_NOT_FOUND"); }
    if (record(id)?.status === "active") { desiredGraphId = null; selectGraph(id); return; }
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { clearTimeout(timer); unsubscribeSync(); unsubscribeContext(); };
      const check = (): void => {
        if (context.getState().contextKey !== key) { cleanup(); reject(new GroupRequestError("ACCOUNT_REQUIRED")); }
        else if (record(id)?.status === "deleted") {
          desiredGraphId = null; cleanup(); reject(new GroupRequestError("GROUP_NOT_FOUND"));
        }
        else if (record(id)?.status === "active") { cleanup(); publish(); resolve(); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new GroupRequestError("GROUP_UNAVAILABLE")); }, 5_000);
      const unsubscribeSync = sync.store.subscribe(check), unsubscribeContext = context.subscribe(check);
    });
  };
  const perform = async (action: GroupGraphAction, retry = false): Promise<string | null> => {
    const state = context.getState(), key = state.contextKey, startedSelection = selectionIntent;
    if (retry) {
      assertContext(key);
      // 收据属于本人账号，不依赖仍在线或仍有组资格；先确认旧动作，再决定能否发起短写。
      if (state.busy) throw new GroupRequestError("GROUP_OFFLINE");
    } else assertWritable();
    const ownership = ownerKey(state.userId!, action.groupId);
    // 先冻结归属再发请求：失败回调可能在用户已经回个人图、换组或换号后才到达。
    unresolved.set(ownership, { action, error: "GROUP_UNAVAILABLE", uncertain: true });
    const ownsEntry = (): boolean => unresolved.get(ownership)?.action.mutationId === action.mutationId;
    context.setState({ busy: true, error: null });
    let applied = false, confirmedGraphId: string | null = null;
    try {
      let acknowledgement: GroupGraphReceiptResponse | null = retry ? await receipt(action, key) : null;
      let result: GroupGraphWriteResponse | null = null;
      if (!acknowledgement?.applied) {
        if (!context.getState().writable) throw new GroupRequestError("GROUP_OFFLINE");
        try { result = await sync.write(action); applied = true; }
        catch (error: unknown) {
          const known = sync.store.getState().lastReceipt;
          if (known?.mutationId === action.mutationId && known.applied) { acknowledgement = known; applied = true; }
          else throw error;
        }
      } else applied = true;
      assertContext(key);
      if (["create", "copyIn", "copyOut"].includes(action.action) && !acknowledgement?.applied) acknowledgement = await receipt(action, key);
      let id: string | null = null;
      if (action.action === "copyOut") {
        id = result?.personalGraph?.document.id ?? acknowledgement?.personalGraphId ?? null;
        if (id === null) throw new GroupRequestError("GROUP_UNAVAILABLE");
        await cloud.getState().retry(); assertContext(key);
        // 原云同步retry可能忙时直接返回，或只发布错误而不抛异常；必须核对实际个人Store。
        // 已提交但尚未读回仍保留原ID，后续只查收据／刷新，不再复制第二份。
        if (!personal.getState().documents.some(document => document.id === id)) throw new GroupRequestError("GROUP_UNAVAILABLE");
      } else if (action.action === "create" || action.action === "copyIn") {
        id = acknowledgement?.graphId ?? null;
        if (id === null) throw new GroupRequestError("GROUP_UNAVAILABLE");
        confirmedGraphId = id;
        if (record(id)?.status === "deleted") throw new GroupRequestError("GROUP_NOT_FOUND");
        if (selectionIntent === startedSelection) {
          desiredGraphId = id;
          if (sync.store.getState().state !== "closed") await awaitGraph(id, key);
        }
      }
      // 旧连接的迟到完成不能删除已核对动作之后产生的新意图。
      if (ownsEntry()) { unresolved.delete(ownership); context.setState({ failedAction: null, error: null }); }
      return id;
    } catch (error: unknown) {
      const code = errorCode(error), failure = { action, error: code,
        uncertain: applied || ["ACCOUNT_REQUIRED", "GROUP_OFFLINE", "GROUP_UNAVAILABLE"].includes(code) };
      // 已有本人收据且权威图已删除是确定结果；提示删除，但不能把整个组永久锁在待确认中。
      const deleted = applied && confirmedGraphId !== null && code === "GROUP_NOT_FOUND" && record(confirmedGraphId)?.status === "deleted";
      // 同ID的重试可能已确认并清理，或已有M2；旧M回调只能更新仍归自己持有的条目。
      if (ownsEntry()) {
        if (deleted) { unresolved.delete(ownership); if (desiredGraphId === confirmedGraphId) desiredGraphId = null; }
        else unresolved.set(ownership, failure);
        const current = context.getState();
        if (current.kind === "group" && current.userId === state.userId && current.groupId === action.groupId) {
          context.setState({ error: code, failedAction: deleted ? null : failure });
        }
      }
      throw error;
    } finally { if (context.getState().contextKey === key) context.setState({ busy: false }); }
  };
  const detached = (pending: Promise<unknown>): void => { void pending.catch(() => {}); };
  const captureEdit = (graphId: string): CapturedWorkspaceEdit | null => {
    const state = context.getState(), document = active.getState().documents.find(item => item.id === graphId);
    if (document === undefined || active.getState().currentId !== graphId) return null;
    const revision = state.kind === "group" ? record(graphId)?.revision ?? null : null;
    if (state.kind === "group" && revision === null) return null;
    return { contextKey: state.contextKey, graphId, document: structuredClone(document), revision, selectionEpoch };
  };
  const commitCaptured = async (capture: CapturedWorkspaceEdit, edit: (graph: EditableGraph) => EditableGraph,
    description?: WorkspaceHistoryDescription): Promise<boolean> => {
    const state = context.getState();
    if (state.contextKey !== capture.contextKey || active.getState().currentId !== capture.graphId || selectionEpoch !== capture.selectionEpoch) return false;
    if (state.kind === "personal") {
      const latest = personal.getState().documents.find(item => item.id === capture.graphId);
      if (latest === undefined || quarantine) return false;
      personal.getState().replaceGraph(edit(latest), description); return true;
    }
    const after = EditableGraphSchema.parse(edit(capture.document));
    if (sameGraphContent(capture.document, after)) return true;
    const inferred = description ?? inferHistoryDescription(capture.document, after);
    if (inferred.scope !== undefined || inferred.kind === "graph.search" || inferred.kind === "node.search") throw new GroupRequestError("GROUP_INVALID");
    await perform({ action: "edit", groupId: state.groupId!, graphId: capture.graphId, expectedRevision: capture.revision!,
      mutationId: createId(), before: capture.document, after, kind: inferred.kind, subject: inferred.subject });
    return true;
  };
  const targetAction = (action: "delete" | "restore" | "redo" | "undo", graphId: string, eventId?: string): void => {
    const state = context.getState(), row = record(graphId);
    if (row === undefined) return;
    const target = { groupId: state.groupId!, graphId, expectedRevision: row.revision, mutationId: createId() };
    detached(perform(action === "undo" ? { ...target, action, eventId: eventId! } : { ...target, action }));
  };
  const selectGraph = (id: string | null): void => {
    if (active.getState().currentId !== id) { ++selectionEpoch; ++selectionIntent; }
    if (context.getState().kind === "personal") { personal.getState().selectGraph(id); return; }
    if (id !== null && !active.getState().documents.some(item => item.id === id)) return;
    explicitEmptySelection = id === null;
    if (active.getState().currentId !== id) { desiredGraphId = null; search.cancel(); }
    active.setState({ currentId: id });
  };
  // 仅初始构建复用个人数据；动作始终是以下显式代理，后续镜像不能覆盖它们。
  const active = createStore<WorkspaceStoreState>()(() => ({ ...data(personal.getState()),
    addGraph: graph => {
      if (context.getState().kind === "personal") personal.getState().addGraph(graph);
      else detached(perform({ action: "create", groupId: context.getState().groupId!, document: graph, mutationId: createId() }));
    }, selectGraph,
    selectNode: id => {
      if (context.getState().kind === "personal") { personal.getState().selectNode(id); return; }
      const state = active.getState(), graph = state.documents.find(item => item.id === state.currentId);
      if (graph === undefined || id !== null && !graph.nodes.some(node => node.id === id)) return;
      if (state.selectedNodeIds[graph.id] !== id) search.cancel();
      active.setState({ selectedNodeIds: { ...state.selectedNodeIds, [graph.id]: id } });
    },
    replaceGraph: (graph, description) => {
      if (context.getState().kind === "personal") { personal.getState().replaceGraph(graph, description); return; }
      const capture = captureEdit(graph.id); if (capture === null) throw new GroupRequestError("GROUP_NOT_FOUND");
      detached(commitCaptured(capture, () => graph, description));
    },
    renameGraph: (id, title) => {
      if (context.getState().kind === "personal") { personal.getState().renameGraph(id, title); return; }
      const capture = captureEdit(id); if (capture !== null) detached(commitCaptured(capture, graph => ({ ...graph, title, updatedAt: new Date().toISOString() })));
    },
    deleteGraph: id => context.getState().kind === "personal" ? personal.getState().deleteGraph(id) : targetAction("delete", id),
    restoreDeletedGraph: () => {
      if (context.getState().kind === "personal") { personal.getState().restoreDeletedGraph(); return; }
      const row = active.getState().deletedGraphs.at(-1); if (row !== undefined) targetAction("restore", row.document.id);
    },
    undo: () => {
      if (context.getState().kind === "personal") { personal.getState().undo(); return; }
      const state = active.getState(), row = record(state.currentId ?? ""), userId = context.getState().userId;
      const event = row?.history.events.findLast(item => item.actorUserId === userId && item.undoable && item.active);
      if (row !== undefined && event !== undefined) targetAction("undo", row.document.id, event.id);
    },
    undoEvent: eventId => {
      if (context.getState().kind === "personal") return personal.getState().undoEvent(eventId);
      const row = record(active.getState().currentId ?? "");
      const event = row?.history.events.find(item => item.id === eventId && item.actorUserId === context.getState().userId && item.undoable);
      if (event === undefined || row === undefined) return { ok: false, reason: "missing" };
      if (!event.active) return { ok: false, reason: "inactive" };
      if (!context.getState().writable || context.getState().busy || context.getState().failedAction !== null) return { ok: false, reason: "constraint" };
      targetAction("undo", row.document.id, eventId); return { ok: true };
    },
    redo: () => {
      if (context.getState().kind === "personal") { personal.getState().redo(); return; }
      const id = active.getState().currentId;
      if (id !== null && active.getState().histories[id]?.future.length) targetAction("redo", id);
    },
    restoreDocuments: (documents, currentId, histories) => {
      if (context.getState().kind !== "personal" || quarantine) throw new GroupRequestError("GROUP_FORBIDDEN");
      personal.getState().restoreDocuments(documents, currentId, histories);
    },
  }));
  const leaveGroup = (): void => {
    const current = context.getState();
    // 个人界面的返回首页／新搜索也会调用此入口；同账号重复调用不能重建画布或清掉布局草稿。
    // 身份订阅先设quarantine，必须绕过此幂等分支以撤销旧账号捕获与迟到回调。
    if (current.kind === "personal" && current.userId === account.getState().scopeUserId && !quarantine) return;
    ++epoch; desiredGraphId = null; explicitEmptySelection = false; search.cancel(); sync.disconnect();
    context.setState({ kind: "personal", contextKey: `personal:${epoch}`, userId: account.getState().scopeUserId,
      groupId: null, groupName: null, busy: false, error: null, failedAction: null }); publish();
  };
  const unsubscribePersonal = personal.subscribe(() => { if (context.getState().kind === "personal") publish(); });
  const unsubscribeSync = sync.store.subscribe((next, previous) => {
    if (context.getState().kind !== "group") return;
    if (next.snapshot !== previous.snapshot || next.state !== previous.state || next.error !== previous.error) {
      const old = active.getState(), selected = old.selectedNodeIds[old.currentId ?? ""];
      publish();
      const current = active.getState();
      if (current.currentId !== old.currentId || current.selectedNodeIds[current.currentId ?? ""] !== selected) search.cancel();
    }
  });
  const unsubscribeAccount = account.subscribe((next, previous) => {
    if (next.epoch === previous.epoch && next.scopeUserId === previous.scopeUserId) return;
    quarantine = true; sawLoading = false; leaveGroup();
  });
  const unsubscribePersistence = persistence.subscribe(next => {
    if (quarantine && next.status === "loading") sawLoading = true;
    if (quarantine && sawLoading && next.status !== "loading" && next.error !== "load") quarantine = false;
    if (context.getState().kind === "personal") publish();
  });
  const commands = {
    enterGroup: (userId: string, groupId: string): void => {
      if (account.getState().scopeUserId !== userId || account.getState().account?.userId !== userId) throw new GroupRequestError("ACCOUNT_REQUIRED");
      ++epoch; desiredGraphId = null; explicitEmptySelection = false; search.cancel(); research?.getState().cancel();
      context.setState({ kind: "group", contextKey: `group:${epoch}:${groupId}`, userId, groupId, groupName: null,
        writable: false, busy: false, error: null, failedAction: unresolved.get(ownerKey(userId, groupId)) ?? null });
      active.setState(emptyData()); sync.connect(userId, groupId); publish();
    }, leaveGroup, selectGraph, captureEdit, commitCaptured,
    createGraph: async (template: EditableGraph): Promise<string> => {
      if (context.getState().kind === "personal") { personal.getState().addGraph(template); return template.id; }
      return (await perform({ action: "create", groupId: context.getState().groupId!, document: template, mutationId: createId() }))!;
    },
    copyIn: async (personalGraphId: string): Promise<string> => {
      const state = assertWritable(), key = state.contextKey, local = personal.getState().documents.find(item => item.id === personalGraphId);
      if (local === undefined || cloud.getState().status !== "synced" || cloud.getState().pending || cloud.getState().conflicts.includes(personalGraphId)) throw new GroupRequestError("GROUP_CONFLICT");
      const remote = await cloudApi.read(state.userId!, AbortSignal.timeout(10_000)); assertContext(key);
      const source = remote.graphs.find(item => item.document.id === personalGraphId && item.status === "active");
      const latest = personal.getState().documents.find(item => item.id === personalGraphId);
      // 请求期间继续编辑的个人图不能悄悄复制旧版本；历史无需相等，副本从新基线开始。
      if (source === undefined || latest === undefined || JSON.stringify(source.document) !== JSON.stringify(latest)
        || JSON.stringify(local) !== JSON.stringify(latest) || cloud.getState().pending || cloud.getState().status !== "synced") throw new GroupRequestError("GROUP_CONFLICT");
      return (await perform({ action: "copyIn", groupId: state.groupId!, sourceGraphId: personalGraphId,
        sourceRevision: source.revision, mutationId: createId() }))!;
    },
    copyOut: async (graphId: string): Promise<string> => {
      const state = assertWritable(), row = record(graphId);
      if (row?.status !== "active") throw new GroupRequestError("GROUP_NOT_FOUND");
      return (await perform({ action: "copyOut", groupId: state.groupId!, graphId, expectedRevision: row.revision, mutationId: createId() }))!;
    },
    retryFailedAction: async (): Promise<string | null> => {
      const failed = context.getState().failedAction;
      return failed === null ? null : perform(failed.action, true);
    },
    confirmFailedEdit: async (): Promise<boolean> => {
      const state = context.getState(), failed = state.failedAction;
      if (failed === null || failed.action.action !== "edit" || failed.uncertain) return false;
      const action = failed.action, capture = captureEdit(action.graphId);
      if (capture === null) return false;
      const difference = applyGraphDifference(capture.document, action.before, action.after);
      if (!difference.ok) return false;
      unresolved.delete(ownerKey(state.userId!, action.groupId));
      context.setState({ failedAction: null });
      return commitCaptured(capture, () => ({ ...difference.graph, updatedAt: new Date().toISOString() }), { kind: action.kind, subject: action.subject });
    },
    discardFailedAction: (): boolean => {
      // 未知确认不能通过关闭提示丢掉唯一去重标识；先查原收据，禁止下一次点击换ID复制两份。
      if (context.getState().failedAction?.uncertain) return false;
      const state = context.getState();
      if (state.userId !== null && state.groupId !== null) unresolved.delete(ownerKey(state.userId, state.groupId));
      context.setState({ failedAction: null, error: null }); return true;
    },
    cancelPendingResearch: (): void => {
      if (context.getState().kind === "personal") research?.getState().cancelPending(); else search.cancelPending();
    },
    startResearch: async (graphId: string, nodeId?: string, topic?: string, onStart?: () => void): Promise<void> => {
      if (context.getState().kind === "personal") {
        const key = context.getState().contextKey, loaded = await personalResearch();
        if (context.getState().contextKey !== key || active.getState().currentId !== graphId) return;
        return loaded.getState().start(graphId, nodeId, topic, onStart);
      }
      const state = assertWritable(), row = record(graphId);
      if (active.getState().currentId !== graphId || row?.status !== "active") throw new GroupRequestError("GROUP_NOT_FOUND");
      const graph = row.document, node = graph.nodes.find(item => item.id === nodeId);
      if (nodeId !== undefined && node === undefined) throw new GroupRequestError("GROUP_NOT_FOUND");
      await search.start({ groupId: state.groupId!, graphId, expectedRevision: row.revision, ...(nodeId === undefined ? {} : { nodeId }) },
        { query: graph.query.trim() || (node === undefined ? topic?.trim() ?? "" : node.title), language: graph.language,
          engine: resolveSearchEngine(graph.language, node?.engine ?? graph.engine), ...(node === undefined ? {} : {
            nodeSearch: { node: { id: node.id, title: node.title, description: node.description }, analysis: graph.analysis ?? null } }) }, false,
        { ...(onStart === undefined ? {} : { onStart }) });
    },
  };
  return { activeWorkspaceStore: active, workspaceContextStore: context, workspaceContext: commands,
    selectActiveWorkspaceHistory: (state: WorkspaceStoreState) => {
      const history = state.histories[state.currentId ?? ""]; if (history === undefined) return [];
      const all = describeHistory(history);
      if (context.getState().kind === "personal") return all;
      const own = new Set(record(state.currentId ?? "")?.history.events.filter(event => event.actorUserId === context.getState().userId && event.undoable).map(event => event.id));
      return all.filter(event => own.has(event.id));
    },
    selectActiveWorkspaceRedoCount: (state: WorkspaceStoreState): number => state.histories[state.currentId ?? ""]?.future.length ?? 0,
    dispose: (): void => { unsubscribePersonal(); unsubscribeSync(); unsubscribeAccount(); unsubscribePersistence(); search.cancel(); sync.disconnect(); },
  };
}

const singleton = createWorkspaceContext();
export const { activeWorkspaceStore, workspaceContextStore, workspaceContext, selectActiveWorkspaceHistory, selectActiveWorkspaceRedoCount } = singleton;
