/** 测试职责：图与撤销/重做一致恢复；旧库兼容，损坏不覆盖，顺序保存失败可重试。 */
import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { WEB_WAIT_TIMEOUT_MS } from "../../test-timing.js";
import { createEmptyGraph, createWorkspaceStore, selectCurrentGraph, selectWorkspaceHistory } from "./workspace-store.js";
import { storeGraphHistory } from "./workspace-history.js";
import { addNode, addResource, deleteResource, moveNode, updateNode, updateResource } from "./workspace-edits.js";
import {
  initializeWorkspacePersistence, type WorkspacePersistenceState,
  type WorkspaceSnapshot, type WorkspaceStorage,
} from "./workspace-persistence.js";

const document = createEmptyGraph("图", "已保存", "zh-CN", "2026-11-01T00:00:00Z");
const createFeedback = () => createStore<WorkspacePersistenceState>(() => ({
  status: "loading", error: null, retry: async () => {},
}));
const snapshot = (store: ReturnType<typeof createWorkspaceStore>): WorkspaceSnapshot => {
  const { documents, currentId, histories } = store.getState();
  return { version: "workspace-storage.v2", documents, currentId,
    histories: Object.fromEntries(Object.entries(histories).map(([id, history]) => [id, storeGraphHistory(history)])) };
};

describe("本地搜索图持久化", () => {
  it("兼容旧文档且不写回空状态，下一次保存迁入版本化历史", async () => {
    const store = createWorkspaceStore();
    const save = vi.fn(async (snapshot: WorkspaceSnapshot) => { void snapshot; });
    const feedback = createFeedback();
    const stop = await initializeWorkspacePersistence(store, {
      load: async () => ({ documents: [document], currentId: document.id }), save,
    }, feedback);
    expect(store.getState().documents).toEqual([document]);
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
