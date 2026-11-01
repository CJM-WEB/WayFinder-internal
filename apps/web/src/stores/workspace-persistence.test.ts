/** 测试职责：读取失败不覆盖历史、串行保存最新状态，失败后可重试且不持久化会话历史。 */
import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { createEmptyGraph, createWorkspaceStore } from "./workspace-store.js";
import {
  initializeWorkspacePersistence, type WorkspacePersistenceState,
  type WorkspaceSnapshot, type WorkspaceStorage,
} from "./workspace-persistence.js";

const document = createEmptyGraph("图", "已保存", "zh-CN", "2026-11-01T00:00:00Z");
const createFeedback = () => createStore<WorkspacePersistenceState>(() => ({
  status: "loading", error: null, retry: async () => {},
}));

describe("本地搜索图持久化", () => {
  it("恢复文档不写回空状态，撤销历史不被恢复或写入", async () => {
    const store = createWorkspaceStore();
    const save = vi.fn(async (snapshot: WorkspaceSnapshot) => { void snapshot; });
    const feedback = createFeedback();
    const stop = await initializeWorkspacePersistence(store, {
      load: async () => ({ documents: [document], currentId: document.id }), save,
    }, feedback);
    expect(store.getState().documents).toEqual([document]);
    expect(save).not.toHaveBeenCalled();
    store.getState().renameGraph(document.id, "修改标题");
    await vi.waitFor(() => expect(feedback.getState().status).toBe("ready"));
    expect(Object.keys(save.mock.calls[0]?.[0] ?? {})).toEqual(["documents", "currentId"]);
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
    await vi.waitFor(() => expect(feedback.getState().error).toBe("save"));
    expect(store.getState().documents).toEqual([document]);
    await feedback.getState().retry();
    expect(save.mock.calls.at(-1)?.[0]).toEqual({ documents: [document], currentId: document.id });
    expect(feedback.getState().status).toBe("ready");
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
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(feedback.getState().status).toBe("saving");
    release?.();
    await vi.waitFor(() => expect(feedback.getState().status).toBe("ready"));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[0].documents[0].title).toBe("最终标题");
    stop();
  });
});
