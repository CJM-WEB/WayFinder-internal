/** 测试职责：图与撤销/重做一致恢复；旧库兼容，损坏不覆盖，顺序保存失败可重试。 */
import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { WEB_WAIT_TIMEOUT_MS } from "../../test-timing.js";
import { createEmptyGraph, createWorkspaceStore, selectCurrentGraph, selectWorkspaceHistory } from "./workspace-store.js";
import { createDeferred } from "../../../../tests/support/test-infrastructure.mjs";
import { remapGraphHistoryIdentity } from "./workspace-history.js";
import { addNode, addResource, deleteResource, moveNode, updateNode, updateResource } from "./workspace-edits.js";
import {
  captureWorkspaceSnapshot, initializeWorkspacePersistence, type WorkspacePersistenceHandle, type WorkspacePersistenceState,
  type WorkspaceSnapshot, type WorkspaceStorage,
} from "./workspace-persistence.js";

const document = createEmptyGraph("图", "已保存", "zh-CN", "2026-11-01T00:00:00Z");
const createFeedback = () => createStore<WorkspacePersistenceState>(() => ({
  status: "loading", error: null, retry: async () => {},
}));
const snapshot = (store: ReturnType<typeof createWorkspaceStore>): WorkspaceSnapshot => captureWorkspaceSnapshot(store.getState());

describe("本地搜索图持久化", () => {
  it("兼容旧文档且不写回空状态，下一次保存迁入版本化历史", async () => {
    const store = createWorkspaceStore();
    const save = vi.fn(async (snapshot: WorkspaceSnapshot) => { void snapshot; });
    const feedback = createFeedback();
    const stop = await initializeWorkspacePersistence(store, {
      load: async () => ({ documents: [document], currentId: document.id }), save,
    }, feedback);
    expect(store.getState().documents).toEqual([document]);
    expect(store.getState().deletedGraphs).toEqual([]);
    expect(store.getState().histories[document.id]?.events).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    store.getState().renameGraph(document.id, "修改标题");
    await vi.waitFor(() => expect(feedback.getState().status).toBe("ready"), WEB_WAIT_TIMEOUT_MS);
    expect(save.mock.calls[0]?.[0]).toMatchObject({ version: "workspace-storage.v2", histories: { 图: { version: "history.v1", events: [{ kind: "graph.rename" }] } } });
    expect(save.mock.calls[0]?.[0].histories[document.id]).not.toHaveProperty("past");
    expect(save.mock.calls[0]?.[0].histories[document.id]).not.toHaveProperty("future");
    expect(store.getState().histories[document.id]?.past).toHaveLength(1);
    stop();
  });

  it("读取失败时不订阅写入，重试成功后才接纳旧库", async () => {
    const store = createWorkspaceStore();
    const storage: WorkspaceStorage = {
      load: vi.fn().mockRejectedValueOnce(new Error("读取失败")).mockResolvedValue({ documents: [document], currentId: document.id }),
      save: vi.fn(async () => {}),
    };
    const feedback = createFeedback();
    const stop = await initializeWorkspacePersistence(store, storage, feedback);
    expect(feedback.getState().error).toBe("load");
    expect(storage.save).not.toHaveBeenCalled();
    await feedback.getState().retry();
    expect(store.getState().documents).toEqual([document]);
    expect(feedback.getState().status).toBe("ready");
    expect(storage.save).not.toHaveBeenCalled();
    stop();
  });

  it("保存失败不丢内存修改，重试保存最新快照", async () => {
    const store = createWorkspaceStore();
    const save = vi.fn().mockRejectedValueOnce(new Error("空间不足")).mockResolvedValue(undefined);
    const feedback = createFeedback();
    const stop = await initializeWorkspacePersistence(store, { load: async () => null, save }, feedback);
    store.getState().addGraph(document);
    await vi.waitFor(() => expect(feedback.getState().error).toBe("save"), WEB_WAIT_TIMEOUT_MS);
    expect(store.getState().documents).toEqual([document]);
    await feedback.getState().retry();
    expect(save.mock.calls.at(-1)?.[0]).toEqual(snapshot(store));
    expect(feedback.getState().status).toBe("ready");
    stop();
  });

  it("显式persist在存储失败时拒绝，不让调用方把未提交快照报告为成功", async () => {
    const store = createWorkspaceStore(), feedback = createFeedback();
    const saved = { documents: [document], currentId: document.id };
    const save = vi.fn<WorkspaceStorage["save"]>().mockRejectedValueOnce(new Error("假存储故障")).mockResolvedValue(undefined);
    const handle = await initializeWorkspacePersistence(store, { load: async () => saved, save }, feedback);
    await expect(handle.persist()).rejects.toThrow("本地搜索图保存失败");
    expect(feedback.getState()).toMatchObject({ status: "error", error: "save" });
    expect(store.getState().documents).toEqual([document]);
    await feedback.getState().retry();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[0]).toEqual(snapshot(store));
    expect(feedback.getState()).toMatchObject({ status: "ready", error: null });
    handle();
  });

  it("捕获阶段同步失败也转换为脱敏保存错误，订阅不向编辑调用者抛错", async () => {
    const store = createWorkspaceStore(), feedback = createFeedback(), sentinel = "fixture-private-capture-value";
    let captureFails = false;
    const save = vi.fn<WorkspaceStorage["save"]>().mockResolvedValue(undefined);
    const handle = await initializeWorkspacePersistence(store, { load: async () => ({ documents: [document], currentId: document.id }), save }, feedback,
      { captureCloud: () => { if (captureFails) throw new Error(sentinel); return undefined; } });
    captureFails = true;
    // 订阅是编辑之后的副作用；捕获失败不能让已完成的内存编辑向UI抛出原始秘密异常。
    expect(() => store.getState().renameGraph(document.id, "仍保留的内存编辑")).not.toThrow();
    expect(feedback.getState()).toMatchObject({ status: "error", error: "save" });
    const error: unknown = await handle.persist().then(() => { throw new Error("预期拒绝"); }, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error); expect(String(error)).toContain("本地搜索图保存失败");
    expect(String(error)).not.toContain(sentinel); expect(JSON.stringify(error)).not.toContain(sentinel);
    expect(error).not.toHaveProperty("cause"); expect(save).not.toHaveBeenCalled();
    expect(selectCurrentGraph(store.getState())?.title).toBe("仍保留的内存编辑");
    expect(feedback.getState()).toMatchObject({ status: "error", error: "save" });
    handle();
  });

  it.each(["stopped", "isCurrent"] as const)("旧%s句柄不能捕获或写入换号后的全局状态", async boundary => {
    const store = createWorkspaceStore(), feedback = createFeedback();
    let current = true;
    const captureCloud = vi.fn(() => ({ userId: "owner_A" })), save = vi.fn<WorkspaceStorage["save"]>().mockResolvedValue(undefined);
    const handle = await initializeWorkspacePersistence(store, { load: async () => ({ documents: [document], currentId: document.id }), save }, feedback,
      { isCurrent: () => current, captureCloud });
    if (boundary === "stopped") handle(); else current = false;
    const previousFeedback = feedback.getState();
    const other = createEmptyGraph("owner_B_graph", "B的图", "zh-CN");
    store.getState().restoreDocuments([other], other.id);
    await expect(handle.persist()).rejects.toThrow("本地保存身份已失效");
    await handle.flush();
    expect(captureCloud).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    expect(feedback.getState()).toBe(previousFeedback);
    expect(store.getState().documents).toEqual([other]);
    handle();
  });

  it("换号前已捕获的A队列仍可flush到A存档，完成回调不能更新B的保存状态", async () => {
    const store = createWorkspaceStore(), feedback = createFeedback(), first = createDeferred<void>();
    let current = true;
    const save = vi.fn<WorkspaceStorage["save"]>().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
    const captureCloud = vi.fn(() => ({ userId: "owner_A" }));
    const handle = await initializeWorkspacePersistence(store, { load: async () => ({ documents: [document], currentId: document.id }), save }, feedback,
      { isCurrent: () => current, captureCloud });
    const firstPending = handle.persist();
    store.getState().renameGraph(document.id, "A最终标题");
    const captured = snapshot(store);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1), WEB_WAIT_TIMEOUT_MS);
    expect(captureCloud).toHaveBeenCalledTimes(2);
    current = false; handle();
    const other = createEmptyGraph("owner_B_graph", "B的图", "zh-CN");
    store.getState().restoreDocuments([other], other.id);
    feedback.setState({ status: "loading", error: null });
    first.resolve(); await firstPending; await handle.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]?.[0].documents).toEqual([document]);
    expect(save.mock.calls[1]?.[0]).toEqual({ ...captured, cloud: { userId: "owner_A" } });
    expect(captureCloud).toHaveBeenCalledTimes(2);
    expect(feedback.getState()).toMatchObject({ status: "loading", error: null });
    expect(store.getState().documents).toEqual([other]);
  });

  it("首次读取失败后的retry成功才通过onReady交付可用句柄", async () => {
    const store = createWorkspaceStore(), feedback = createFeedback(), onReady = vi.fn<(handle: WorkspacePersistenceHandle) => void>();
    const load = vi.fn<WorkspaceStorage["load"]>().mockRejectedValueOnce(new Error("假读取故障")).mockResolvedValue({ documents: [document], currentId: document.id });
    const save = vi.fn<WorkspaceStorage["save"]>().mockResolvedValue(undefined);
    const handle = await initializeWorkspacePersistence(store, { load, save }, feedback, { onReady });
    expect(onReady).not.toHaveBeenCalled(); expect(feedback.getState().error).toBe("load");
    await feedback.getState().retry();
    expect(onReady).toHaveBeenCalledExactlyOnceWith(handle);
    expect(save).not.toHaveBeenCalled();
    await handle.persist(); expect(save.mock.calls[0]?.[0]).toEqual(snapshot(store));
    handle();
  });

  it("正式入口读取重试只恢复内容与撤销，旧选择须主动恢复且不覆盖旧库", async () => {
    const original = createWorkspaceStore();
    original.getState().addGraph(document);
    original.getState().renameGraph(document.id, "修改标题");
    const saved = structuredClone(snapshot(original));
    const store = createWorkspaceStore(), feedback = createFeedback();
    const save = vi.fn(async () => {});
    const stop = await initializeWorkspacePersistence(store, {
      load: vi.fn().mockRejectedValueOnce(new Error("读取失败")).mockResolvedValue(saved), save,
    }, feedback, { restoreSelection: false });
    expect(feedback.getState().error).toBe("load");
    await feedback.getState().retry();
    expect(feedback.getState().status).toBe("ready");
    expect(store.getState().currentId).toBeNull();
    expect(store.getState().documents).toEqual(original.getState().documents);
    expect(store.getState().histories).toEqual(original.getState().histories);
    expect(save).not.toHaveBeenCalled();
    store.getState().selectGraph(document.id);
    expect(selectCurrentGraph(store.getState())?.title).toBe("修改标题");
    store.getState().undo();
    expect(selectCurrentGraph(store.getState())?.title).toBe(document.title);
    stop();
  });

  it("多个变更按顺序保存，前一事务未完成时不报告最新状态已保存", async () => {
    const store = createWorkspaceStore();
    let release: (() => void) | undefined;
    const firstWrite = new Promise<void>(resolve => { release = resolve; });
    const save = vi.fn().mockImplementationOnce(() => firstWrite).mockResolvedValue(undefined);
    const feedback = createFeedback();
    const stop = await initializeWorkspacePersistence(store, { load: async () => null, save }, feedback);
    store.getState().addGraph(document);
    store.getState().renameGraph(document.id, "最终标题");
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1), WEB_WAIT_TIMEOUT_MS);
    expect(feedback.getState().status).toBe("saving");
    release?.();
    await vi.waitFor(() => expect(feedback.getState().status).toBe("ready"), WEB_WAIT_TIMEOUT_MS);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[0].documents[0].title).toBe("最终标题");
    stop();
  });

  it("刷新恢复选择性撤销和重做，并保留操作标识、时间与不入栈的最新坐标", async () => {
    const original = createWorkspaceStore();
    const initial = addNode(document, "A", "", "节点");
    original.getState().addGraph(initial);
    original.getState().replaceGraph(updateNode(initial, "节点", { title: "B" }));
    const graphB = selectCurrentGraph(original.getState());
    if (graphB === null) throw new Error("缺少测试图");
    original.getState().replaceGraph(updateNode(graphB, "节点", { title: "C" }));
    const events = selectWorkspaceHistory(original.getState());
    if (events[0] === undefined || events[1] === undefined) throw new Error("缺少测试事件");
    original.getState().undoEvent(events[0].id);
    const current = selectCurrentGraph(original.getState());
    if (current === null) throw new Error("缺少当前图");
    original.getState().replaceGraph(moveNode(current, "节点", { x: 456, y: 789 }));
    const saved = structuredClone(snapshot(original));
    const restored = createWorkspaceStore(), feedback = createFeedback();
    const save = vi.fn(async () => {});
    const stop = await initializeWorkspacePersistence(restored, { load: async () => saved, save }, feedback);
    expect(feedback.getState().status).toBe("ready");
    expect(save).not.toHaveBeenCalled();
    expect(selectWorkspaceHistory(restored.getState())).toEqual(selectWorkspaceHistory(original.getState()));
    expect(restored.getState().histories[document.id]?.future).toHaveLength(1);
    expect(restored.getState().undoEvent(events[1].id)).toEqual({ ok: true });
    expect(selectCurrentGraph(restored.getState())?.nodes[0]?.title).toBe("A");
    expect(selectCurrentGraph(restored.getState())?.positions["节点"]).toEqual({ x: 456, y: 789 });
    restored.getState().redo();
    expect(selectCurrentGraph(restored.getState())?.nodes[0]?.title).toBe("C");
    await vi.waitFor(() => expect(feedback.getState().status).toBe("ready"), WEB_WAIT_TIMEOUT_MS);
    expect(save).toHaveBeenCalled();
    stop();
  });

  it("删除恢复跨重载保留完整历史、重做、最新布局和原位置，按最近删除顺序恢复", async () => {
    const original = createWorkspaceStore();
    const first = createEmptyGraph("first", "前图", "zh-CN"), last = createEmptyGraph("last", "后图", "zh-CN");
    const middle = addNode(document, "原节点", "", "节点");
    original.getState().addGraph(first); original.getState().addGraph(middle); original.getState().addGraph(last);
    original.getState().selectGraph(middle.id);
    original.getState().renameGraph(middle.id, "待重做标题"); original.getState().undo();
    const current = selectCurrentGraph(original.getState());
    if (current === null) throw new Error("缺少测试图");
    original.getState().replaceGraph(moveNode(current, "节点", { x: 456, y: 789 }));
    original.getState().deleteGraph(middle.id); original.getState().deleteGraph(last.id);
    const saved = structuredClone(snapshot(original)), restored = createWorkspaceStore(), feedback = createFeedback();
    const save = vi.fn<WorkspaceStorage["save"]>().mockResolvedValue(undefined);
    const handle = await initializeWorkspacePersistence(restored, { load: async () => saved, save }, feedback);
    expect(feedback.getState().status).toBe("ready"); expect(save).not.toHaveBeenCalled();
    expect(restored.getState().deletedGraphs).toEqual(original.getState().deletedGraphs);
    expect(restored.getState().deletedGraphs.map(item => [item.document.id, item.index])).toEqual([[middle.id, 1], [last.id, 1]]);
    restored.getState().restoreDeletedGraph();
    expect(restored.getState().documents.map(item => item.id)).toEqual([first.id, last.id]);
    restored.getState().restoreDeletedGraph();
    expect(restored.getState().documents.map(item => item.id)).toEqual([first.id, middle.id, last.id]);
    expect(restored.getState().histories[middle.id]).toEqual(original.getState().deletedGraphs[0]?.history);
    expect(selectCurrentGraph(restored.getState())?.positions["节点"]).toEqual({ x: 456, y: 789 });
    restored.getState().redo();
    expect(selectCurrentGraph(restored.getState())?.title).toBe("待重做标题");
    expect(selectCurrentGraph(restored.getState())?.positions["节点"]).toEqual({ x: 456, y: 789 });
    await handle.flush(); handle();
  });

  it("最近删除100张可完整重载，第101次删除已淘汰最早记录且不能恢复它", async () => {
    const original = createWorkspaceStore();
    for (let index = 0; index < 101; index++) {
      const id = `deleted_${index}`;
      original.getState().addGraph(createEmptyGraph(id, id, "zh-CN")); original.getState().deleteGraph(id);
    }
    const saved = structuredClone(snapshot(original)), restored = createWorkspaceStore(), feedback = createFeedback();
    expect(saved.deletedGraphs).toHaveLength(100);
    expect(saved.deletedGraphs?.[0]?.document.id).toBe("deleted_1");
    const handle = await initializeWorkspacePersistence(restored, { load: async () => saved, save: async () => {} }, feedback);
    expect(feedback.getState().status).toBe("ready");
    expect(restored.getState().deletedGraphs).toEqual(original.getState().deletedGraphs);
    for (let index = 0; index < 100; index++) restored.getState().restoreDeletedGraph();
    expect(restored.getState().documents).toHaveLength(100);
    expect(restored.getState().documents.some(item => item.id === "deleted_0")).toBe(false);
    expect(restored.getState().currentId).toBe("deleted_1");
    const before = restored.getState(); restored.getState().restoreDeletedGraph();
    expect(restored.getState()).toBe(before);
    await handle.flush(); handle();
  });

  it.each([
    ["超过100张", (item: NonNullable<WorkspaceSnapshot["deletedGraphs"]>[number]) => Array.from({ length: 101 }, (_unused, index) => ({
      ...remapGraphHistoryIdentity(item.document, item.history, `overflow_${index}`), index: item.index,
    }))],
    ["缺失历史", (item: NonNullable<WorkspaceSnapshot["deletedGraphs"]>[number]) => [{ document: item.document, index: item.index }]],
    ["损坏历史", (item: NonNullable<WorkspaceSnapshot["deletedGraphs"]>[number]) => [{ ...item, history: { ...item.history, redoIds: ["missing_event"] } }]],
    ["历史正文不符", (item: NonNullable<WorkspaceSnapshot["deletedGraphs"]>[number]) => [{ ...item, document: { ...item.document, title: "与历史不符" } }]],
    ["负原位置", (item: NonNullable<WorkspaceSnapshot["deletedGraphs"]>[number]) => [{ ...item, index: -1 }]],
    ["小数原位置", (item: NonNullable<WorkspaceSnapshot["deletedGraphs"]>[number]) => [{ ...item, index: 0.5 }]],
    ["重复删除身份", (item: NonNullable<WorkspaceSnapshot["deletedGraphs"]>[number]) => [item, item]],
  ])("删除记录%s时拒绝读取，不伪造历史或覆盖旧库，重试保留真实源", async (_name, corrupt) => {
    const original = createWorkspaceStore();
    original.getState().addGraph(document); original.getState().renameGraph(document.id, "删除前编辑"); original.getState().deleteGraph(document.id);
    const saved = structuredClone(snapshot(original)), item = saved.deletedGraphs?.[0];
    if (item === undefined) throw new Error("缺少删除记录");
    const restored = createWorkspaceStore(), feedback = createFeedback(), save = vi.fn<WorkspaceStorage["save"]>().mockResolvedValue(undefined);
    const handle = await initializeWorkspacePersistence(restored, {
      load: vi.fn<WorkspaceStorage["load"]>().mockResolvedValueOnce({ ...saved, deletedGraphs: corrupt(item) }).mockResolvedValue(saved), save,
    }, feedback);
    expect(feedback.getState().error).toBe("load"); expect(restored.getState().deletedGraphs).toEqual([]);
    expect(restored.getState().documents).toEqual([]); expect(save).not.toHaveBeenCalled();
    await feedback.getState().retry();
    expect(feedback.getState().status).toBe("ready"); expect(restored.getState().deletedGraphs).toEqual(original.getState().deletedGraphs);
    expect(save).not.toHaveBeenCalled(); handle();
  });

  it("活动图与删除记录不能复用身份，读取失败保持旧内存而不覆盖存档", async () => {
    const original = createWorkspaceStore(); original.getState().addGraph(document); original.getState().deleteGraph(document.id);
    const deleted = snapshot(original).deletedGraphs?.[0];
    if (deleted === undefined) throw new Error("缺少删除记录");
    original.getState().addGraph(document);
    const restored = createWorkspaceStore(), feedback = createFeedback(), save = vi.fn<WorkspaceStorage["save"]>().mockResolvedValue(undefined);
    restored.getState().addGraph(createEmptyGraph("memory", "未保存内存", "zh-CN"));
    const previous = restored.getState();
    const handle = await initializeWorkspacePersistence(restored, { load: async () => ({ ...snapshot(original), deletedGraphs: [deleted] }), save }, feedback);
    expect(feedback.getState().error).toBe("load"); expect(restored.getState()).toBe(previous); expect(save).not.toHaveBeenCalled();
    handle();
  });

  it("引擎偏好同时捕获画布坐标时仍是引擎事件，刷新后撤销保留后续拖动", async () => {
    const original = createWorkspaceStore();
    const initial = addNode(document, "节点", "", "节点");
    original.getState().addGraph(initial);
    original.getState().replaceGraph({ ...initial, engine: "google", positions: { 节点: { x: 120, y: 240 } } });
    expect(selectWorkspaceHistory(original.getState())).toMatchObject([{ kind: "engine.change" }]);
    const current = selectCurrentGraph(original.getState());
    if (current === null) throw new Error("缺少当前图");
    original.getState().replaceGraph(moveNode(current, "节点", { x: 480, y: 720 }));
    const restored = createWorkspaceStore(), feedback = createFeedback();
    const stop = await initializeWorkspacePersistence(restored, { load: async () => structuredClone(snapshot(original)), save: async () => {} }, feedback);
    expect(feedback.getState().status).toBe("ready");
    expect(selectWorkspaceHistory(restored.getState())).toMatchObject([{ kind: "engine.change" }]);
    restored.getState().undo();
    expect(selectCurrentGraph(restored.getState())).not.toHaveProperty("engine");
    expect(selectCurrentGraph(restored.getState())?.positions["节点"]).toEqual({ x: 480, y: 720 });
    stop();
  });

  it("超过100步后的折叠依赖基线也可恢复，不把临时资源或过期事件复活", async () => {
    const original = createWorkspaceStore();
    let graph = addNode(document, "节点", "", "节点");
    original.getState().addGraph(graph);
    graph = addResource(graph, "节点", "https://history.example.com/", "资源");
    original.getState().replaceGraph(graph);
    graph = updateResource(graph, "节点", "资源", { summary: "后来说明" });
    original.getState().replaceGraph(graph);
    graph = deleteResource(graph, "节点", "资源");
    original.getState().replaceGraph(graph);
    const first = selectWorkspaceHistory(original.getState())[0];
    if (first === undefined) throw new Error("缺少首条事件");
    original.getState().undoEvent(first.id);
    // 恰好折入“缺失资源的后续编辑”，将消解依赖的删除留在最近100条中，真实覆盖非空Map基线。
    for (let index = 0; index < 99; index++) original.getState().renameGraph(document.id, `编辑${index}`);
    expect(original.getState().histories[document.id]?.base.resources.get("节点")?.has("资源")).toBe(true);
    expect(original.getState().histories[document.id]?.base.manualNodes.has("节点")).toBe(true);
    const restored = createWorkspaceStore(), feedback = createFeedback();
    const stop = await initializeWorkspacePersistence(restored, { load: async () => structuredClone(snapshot(original)), save: async () => {} }, feedback);
    expect(feedback.getState().status).toBe("ready");
    expect(selectWorkspaceHistory(restored.getState())).toHaveLength(100);
    expect(selectWorkspaceHistory(restored.getState())).toEqual(selectWorkspaceHistory(original.getState()));
    for (let index = 0; index < 99; index++) restored.getState().undo();
    expect(selectCurrentGraph(restored.getState())?.title).toBe(document.title);
    expect(selectCurrentGraph(restored.getState())?.nodes[0]?.resources).toEqual([]);
    stop();
  });

  it.each([
    ["未知版本", (saved: WorkspaceSnapshot) => ({ ...saved, version: "未知版本" })],
    ["缺失历史", (saved: WorkspaceSnapshot) => ({ ...saved, histories: {} })],
    ["不存在图的历史", (saved: WorkspaceSnapshot) => ({ ...saved, histories: { ...saved.histories, 其他图: saved.histories[document.id] } })],
    ["错误事件时间", (saved: WorkspaceSnapshot) => ({ ...saved, histories: { 图: { ...saved.histories[document.id], events: [{ ...saved.histories[document.id]?.events[0], occurredAt: "昨天" }] } } })],
    ["重复事件", (saved: WorkspaceSnapshot) => ({ ...saved, histories: { 图: { ...saved.histories[document.id], events: [saved.histories[document.id]?.events[0], saved.histories[document.id]?.events[0]] } } })],
    ["越界数量", (saved: WorkspaceSnapshot) => ({ ...saved, histories: { 图: { ...saved.histories[document.id], events: Array.from({ length: 101 }, () => saved.histories[document.id]?.events[0]) } } })],
    ["无效重做", (saved: WorkspaceSnapshot) => ({ ...saved, histories: { 图: { ...saved.histories[document.id], redoIds: [saved.histories[document.id]?.events[0]?.id] } } })],
    ["当前图与历史不一致", (saved: WorkspaceSnapshot) => ({ ...saved, documents: [{ ...saved.documents[0], title: "并非历史结果" }] })],
    ["基线损坏", (saved: WorkspaceSnapshot) => ({ ...saved, histories: { 图: { ...saved.histories[document.id], base: { ...saved.histories[document.id]?.base, nodes: [["节点", {}]] } } } })],
  ])("%s 时读取失败，不订阅写入、不覆盖旧库，重试可完整恢复", async (_name, corrupt) => {
    const original = createWorkspaceStore();
    original.getState().addGraph(document);
    original.getState().renameGraph(document.id, "改名");
    const saved = structuredClone(snapshot(original)), restored = createWorkspaceStore(), feedback = createFeedback();
    const storage: WorkspaceStorage = { load: vi.fn().mockResolvedValueOnce(corrupt(saved)).mockResolvedValue(saved), save: vi.fn(async () => {}) };
    const stop = await initializeWorkspacePersistence(restored, storage, feedback);
    expect(feedback.getState().error).toBe("load");
    expect(restored.getState().documents).toEqual([]);
    restored.getState().addGraph(createEmptyGraph("内存图", "内存图", "zh-CN"));
    await Promise.resolve();
    expect(storage.save).not.toHaveBeenCalled();
    await feedback.getState().retry();
    expect(feedback.getState().status).toBe("ready");
    expect(selectCurrentGraph(restored.getState())?.title).toBe("改名");
    expect(selectWorkspaceHistory(restored.getState())).toHaveLength(1);
    expect(storage.save).not.toHaveBeenCalled();
    stop();
  });
});
