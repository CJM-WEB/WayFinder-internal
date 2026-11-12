/** 上下文回归：真实个人Store与小组投影隔离，版本冲突及未知确认保留原意图。 */
import { createStore } from "zustand/vanilla";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditableGraph, GroupGraphRecord, GroupSyncEvent } from "@wayfinder/contracts";
import { createWorkspaceContext } from "./workspace-context.js";
import { createEmptyGraph, createWorkspaceStore } from "./workspace-store.js";
import { appendHistory, createGraphHistory, storeGraphHistory } from "./workspace-history.js";
import { createGroupSync } from "./group-sync.js";
import type { AccountState } from "./account.js";
import type { WorkspacePersistenceState } from "./workspace-persistence.js";
import type { CloudWorkspaceState } from "./cloud-workspace.js";
import { createCloudWorkspaceApi } from "../api/cloud-workspace.js";
import { createGroupApi, GroupRequestError } from "../api/groups.js";
import { createGroupSearchController } from "../api/group-search.js";
import { createResearchStore } from "../api/research.js";
import { syncFixture } from "../testing/group-fixture.js";

const at = "2026-11-12T00:00:00.000Z";
const graph = (id = "shared-id", title = "原始标题") => createEmptyGraph(id, title, "zh-CN", at);
const row = (document: EditableGraph, revision = 1): GroupGraphRecord => {
  const history = storeGraphHistory(createGraphHistory(document));
  return { document, revision, status: "active", originalIndex: null,
    history: { version: "groupHistory.v1", base: history.base, events: [], redoIdsByUser: {} } };
};
const snapshot = (...rows: GroupGraphRecord[]): Extract<GroupSyncEvent, { type: "snapshot" }> => {
  const fixture = syncFixture();
  return { ...fixture, workspace: { ...fixture.workspace, graphs: rows, activeOrder: rows.filter(item => item.status === "active").map(item => item.document.id),
    deletedIds: rows.filter(item => item.status === "deleted").map(item => item.document.id) } };
};
const cleanups: (() => void)[] = [];
function setup() {
  const personal = createWorkspaceStore(); personal.getState().addGraph(graph("shared-id", "个人图"));
  const account = createStore<AccountState>(() => ({ account: { userId: "user-fixture", email: "fixture@example.test" },
    scopeUserId: "user-fixture", epoch: 1, busy: false, error: null, refresh: async () => {}, submit: async () => "account" }));
  const persistence = createStore<WorkspacePersistenceState>(() => ({ status: "ready", error: null, retry: async () => {} }));
  const cloud = createStore<CloudWorkspaceState>(() => ({ status: "synced", pending: false, conflicts: [], importing: false,
    retry: vi.fn(async () => {}), reload: async () => {}, copy: async () => {}, importGuest: async () => {} }));
  const actualSync = createGroupSync();
  const sync = { ...actualSync, connect: vi.fn(), disconnect: vi.fn(), write: vi.fn<typeof actualSync.write>() };
  const searchController = createGroupSearchController(sync);
  const search = { ...searchController, start: vi.fn<typeof searchController.start>(), cancel: vi.fn(), cancelPending: vi.fn() };
  const api = { receipt: vi.fn<ReturnType<typeof createGroupApi>["receipt"]>() };
  const cloudApi = { ...createCloudWorkspaceApi(), read: vi.fn<ReturnType<typeof createCloudWorkspaceApi>["read"]>() };
  let nextId = 0;
  const adapter = createWorkspaceContext({ personal, account, persistence, cloud, sync, search, api, cloudApi,
    research: createResearchStore(personal), createId: () => `mutation-${++nextId}` });
  cleanups.push(() => { adapter.dispose(); searchController.dispose(); });
  const receive = (event = snapshot(row(graph()))) => sync.store.setState({ userId: "user-fixture", groupId: "group-fixture", state: "online",
    snapshot: { details: event.details, workspace: event.workspace }, connectionId: event.connectionId });
  const enter = (event = snapshot(row(graph()))) => { adapter.workspaceContext.enterGroup("user-fixture", "group-fixture"); receive(event); };
  return { ...adapter, personal, account, persistence, cloud, cloudApi, api, sync, search, enter, receive };
}
afterEach(() => { cleanups.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); });

describe("个人／小组工作区边界", () => {
  it("同账号个人态重复返回保持上下文及图历史引用，身份代际变化仍强制隔离", async () => {
    const test = setup(), state = test.activeWorkspaceStore.getState();
    const key = test.workspaceContextStore.getState().contextKey, captured = test.workspaceContext.captureEdit("shared-id")!;
    test.workspaceContext.leaveGroup(); test.workspaceContext.leaveGroup();
    expect(test.workspaceContextStore.getState().contextKey).toBe(key);
    expect(test.activeWorkspaceStore.getState().documents).toBe(state.documents);
    expect(test.activeWorkspaceStore.getState().histories).toBe(state.histories);
    expect(test.search.cancel).not.toHaveBeenCalled();
    expect(await test.workspaceContext.commitCaptured(captured, value => ({ ...value, query: "原表单仍有效" }))).toBe(true);
    test.account.setState({ epoch: 2 });
    expect(test.workspaceContextStore.getState().contextKey).not.toBe(key);
    expect(test.activeWorkspaceStore.getState().documents).toEqual([]);
    expect(await test.workspaceContext.commitCaptured(captured, value => value)).toBe(false);
    test.persistence.setState({ status: "loading" }); test.persistence.setState({ status: "ready" });
    const refreshedKey = test.workspaceContextStore.getState().contextKey;
    test.workspaceContext.leaveGroup();
    expect(test.workspaceContextStore.getState().contextKey).toBe(refreshedKey);
  });

  it("小组快照与后台个人云回填互不覆盖，退出恢复最新个人图，代理动作不被镜像覆盖", async () => {
    const test = setup(); test.enter();
    expect(test.activeWorkspaceStore.getState().documents[0]?.title).toBe("原始标题");
    test.personal.getState().renameGraph("shared-id", "后台云更新");
    expect(test.activeWorkspaceStore.getState().documents[0]?.title).toBe("原始标题");
    const before = test.workspaceContext.captureEdit("shared-id")!;
    test.sync.write.mockResolvedValue({ workspace: snapshot(row(graph("shared-id", "小组改名"), 2)).workspace });
    await test.workspaceContext.commitCaptured(before, value => ({ ...value, title: "小组改名" }));
    expect(test.sync.write).toHaveBeenCalledWith(expect.objectContaining({ action: "edit", before: before.document }));
    expect(test.personal.getState().documents[0]?.title).toBe("后台云更新");
    expect(test.activeWorkspaceStore.getState().documents[0]?.title).toBe("原始标题"); // 不乐观伪造确认快照
    test.workspaceContext.leaveGroup();
    expect(test.activeWorkspaceStore.getState().documents[0]?.title).toBe("后台云更新");
    test.activeWorkspaceStore.getState().renameGraph("shared-id", "个人继续编辑");
    expect(test.personal.getState().documents[0]?.title).toBe("个人继续编辑");
  });

  it("小组表单保留打开时before／revision；个人表单仍读取最新图", async () => {
    const test = setup(); test.enter();
    const captured = test.workspaceContext.captureEdit("shared-id")!;
    test.receive(snapshot(row(graph("shared-id", "别人刚改名"), 2)));
    test.sync.write.mockRejectedValueOnce(new GroupRequestError("GROUP_CONFLICT"));
    await expect(test.workspaceContext.commitCaptured(captured, value => ({ ...value, title: "我的草稿" }))).rejects.toThrow("GROUP_CONFLICT");
    expect(test.sync.write).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 1, before: captured.document,
      after: expect.objectContaining({ title: "我的草稿" }) }));
    expect(test.workspaceContextStore.getState().failedAction).toMatchObject({ uncertain: false, error: "GROUP_CONFLICT" });
    test.workspaceContext.leaveGroup();
    const personalCapture = test.workspaceContext.captureEdit("shared-id")!;
    test.personal.getState().renameGraph("shared-id", "较新个人标题");
    await test.workspaceContext.commitCaptured(personalCapture, value => ({ ...value, query: value.title }));
    expect(test.personal.getState().documents[0]).toMatchObject({ title: "较新个人标题", query: "较新个人标题" });
  });

  it("显式确认冲突只重放本次字段差异，保留其他人独立修改；不自动重发", async () => {
    const test = setup(); test.enter(); const capture = test.workspaceContext.captureEdit("shared-id")!;
    test.sync.write.mockRejectedValueOnce(new GroupRequestError("GROUP_CONFLICT"));
    await expect(test.workspaceContext.commitCaptured(capture, value => ({ ...value, title: "我的标题" }))).rejects.toThrow();
    test.receive(snapshot(row({ ...graph("shared-id", "别人标题"), query: "别人查询" }, 2)));
    expect(test.sync.write).toHaveBeenCalledTimes(1);
    test.sync.write.mockResolvedValueOnce({ workspace: snapshot(row(graph())).workspace });
    expect(await test.workspaceContext.confirmFailedEdit()).toBe(true);
    expect(test.sync.write).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 2, mutationId: "mutation-2",
      before: expect.objectContaining({ title: "别人标题" }), after: expect.objectContaining({ title: "我的标题", query: "别人查询" }) }));
  });

  it("未知确认保留原ID，重试先查本人收据；失去组资格后仍能确认个人副本", async () => {
    const test = setup(); test.enter();
    test.sync.write.mockRejectedValueOnce(new GroupRequestError("GROUP_UNAVAILABLE"));
    await expect(test.workspaceContext.copyOut("shared-id")).rejects.toThrow();
    const failed = test.workspaceContextStore.getState().failedAction!;
    expect(test.workspaceContext.discardFailedAction()).toBe(false);
    test.sync.store.setState({ state: "closed", snapshot: null, error: "GROUP_FORBIDDEN" });
    test.api.receipt.mockResolvedValue({ mutationId: failed.action.mutationId, applied: true, groupId: "group-fixture",
      graphId: "shared-id", personalGraphId: "personal-copy" });
    test.cloud.setState({ retry: vi.fn(async () => { test.personal.getState().addGraph(graph("personal-copy")); }) });
    expect(await test.workspaceContext.retryFailedAction()).toBe("personal-copy");
    expect(test.sync.write).toHaveBeenCalledTimes(1);
    expect(test.cloud.getState().retry).toHaveBeenCalledTimes(1);
    expect(test.workspaceContextStore.getState().failedAction).toBeNull();
  });

  it("明确未应用后重发原mutation和正文，不生成第二次创建", async () => {
    const test = setup(); test.enter();
    test.sync.write.mockRejectedValueOnce(new GroupRequestError("GROUP_OFFLINE"));
    await expect(test.workspaceContext.copyOut("shared-id")).rejects.toThrow();
    const original = test.sync.write.mock.calls[0]![0];
    test.api.receipt.mockResolvedValueOnce({ mutationId: original.mutationId, applied: false, groupId: null, graphId: null, personalGraphId: null })
      .mockResolvedValueOnce({ mutationId: original.mutationId, applied: true, groupId: "group-fixture", graphId: "shared-id", personalGraphId: "copy" });
    test.sync.write.mockResolvedValueOnce({ workspace: snapshot(row(graph())).workspace });
    test.cloud.setState({ retry: vi.fn(async () => { test.personal.getState().addGraph(graph("copy")); }) });
    await test.workspaceContext.retryFailedAction();
    expect(test.sync.write.mock.calls[1]![0]).toBe(original);
  });

  it("未知副本操作跨个人图／其他组导航保留原ID，回原组只按收据确认一次", async () => {
    const test = setup(); test.enter(); test.sync.write.mockRejectedValueOnce(new GroupRequestError("GROUP_UNAVAILABLE"));
    await expect(test.workspaceContext.copyOut("shared-id")).rejects.toThrow();
    const original = test.workspaceContextStore.getState().failedAction!.action;
    test.workspaceContext.leaveGroup();
    expect(test.workspaceContextStore.getState().failedAction).toBeNull();
    test.workspaceContext.enterGroup("user-fixture", "another-group");
    expect(test.workspaceContextStore.getState().failedAction).toBeNull();
    test.enter();
    expect(test.workspaceContextStore.getState().failedAction?.action).toBe(original);
    test.api.receipt.mockResolvedValue({ mutationId: original.mutationId, applied: true, groupId: "group-fixture", graphId: "shared-id", personalGraphId: "one-copy" });
    test.cloud.setState({ retry: vi.fn(async () => { test.personal.getState().addGraph(graph("one-copy")); }) });
    expect(await test.workspaceContext.retryFailedAction()).toBe("one-copy");
    expect(test.sync.write).toHaveBeenCalledTimes(1);
    test.workspaceContext.leaveGroup(); test.enter();
    expect(test.workspaceContextStore.getState().failedAction).toBeNull();
  });

  it("导航发生在失败回调之前也冻结归属，换号不泄漏原动作，同账号回来仍可查原ID", async () => {
    const test = setup(); test.enter();
    let fail: (error: unknown) => void = () => {};
    test.sync.write.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const pending = test.workspaceContext.copyOut("shared-id"), rejected = expect(pending).rejects.toThrow("GROUP_UNAVAILABLE");
    const original = test.sync.write.mock.calls[0]![0];
    test.workspaceContext.leaveGroup();
    test.account.setState({ epoch: 2, scopeUserId: "different-user", account: { userId: "different-user", email: "other@example.test" } });
    test.workspaceContext.enterGroup("different-user", "group-fixture");
    expect(test.workspaceContextStore.getState().failedAction).toBeNull();
    fail(new GroupRequestError("GROUP_UNAVAILABLE")); await rejected;
    expect(test.workspaceContextStore.getState().failedAction).toBeNull();
    test.account.setState({ epoch: 3, scopeUserId: "user-fixture", account: { userId: "user-fixture", email: "fixture@example.test" } });
    test.enter();
    expect(test.workspaceContextStore.getState().failedAction).toMatchObject({ action: original, uncertain: true });
    expect(test.sync.write).toHaveBeenCalledTimes(1);
  });

  it.each(["failure", "success"] as const)("原M迟到%s不能复活已确认动作或覆盖新M2", async outcome => {
    const test = setup(); test.enter();
    let finish: () => void = () => {};
    test.sync.write.mockImplementationOnce(() => new Promise((resolve, reject) => {
      finish = () => outcome === "failure" ? reject(new GroupRequestError("GROUP_UNAVAILABLE")) : resolve({ workspace: snapshot(row(graph())).workspace });
    }));
    const oldPending = test.workspaceContext.copyOut("shared-id"), oldRejected = expect(oldPending).rejects.toThrow();
    const oldAction = test.sync.write.mock.calls[0]![0];
    test.workspaceContext.leaveGroup(); test.enter();
    test.api.receipt.mockResolvedValueOnce({ mutationId: oldAction.mutationId, applied: true,
      groupId: "group-fixture", graphId: "shared-id", personalGraphId: "confirmed-copy" });
    test.cloud.setState({ retry: vi.fn(async () => { test.personal.getState().addGraph(graph("confirmed-copy")); }) });
    expect(await test.workspaceContext.retryFailedAction()).toBe("confirmed-copy");
    let failNew: (error: unknown) => void = () => {};
    test.sync.write.mockImplementationOnce(() => new Promise((_resolve, reject) => { failNew = reject; }));
    const newPending = test.workspaceContext.copyOut("shared-id"), newRejected = expect(newPending).rejects.toThrow("GROUP_UNAVAILABLE");
    const newAction = test.sync.write.mock.calls[1]![0];
    finish(); await oldRejected;
    expect(test.workspaceContextStore.getState()).toMatchObject({ busy: true, failedAction: null, error: null });
    test.workspaceContext.leaveGroup(); test.enter();
    expect(test.workspaceContextStore.getState().failedAction?.action).toBe(newAction);
    expect(test.workspaceContextStore.getState().failedAction?.action.mutationId).not.toBe(oldAction.mutationId);
    failNew(new GroupRequestError("GROUP_UNAVAILABLE")); await newRejected;
    expect(test.workspaceContextStore.getState().failedAction?.action).toBe(newAction);
  });

  it.each(["busy", "failed"] as const)("个人云刷新%s未读回副本时不报告成功，保留原收据等待读回", async status => {
    const test = setup(); test.enter();
    test.sync.write.mockResolvedValue({ workspace: snapshot(row(graph())).workspace });
    test.api.receipt.mockResolvedValue({ mutationId: "mutation-1", applied: true, groupId: "group-fixture", graphId: "shared-id", personalGraphId: "pending-copy" });
    test.cloud.setState({ retry: vi.fn(async () => { test.cloud.setState({ status: status === "busy" ? "saving" : "error" }); }) });
    await expect(test.workspaceContext.copyOut("shared-id")).rejects.toThrow("GROUP_UNAVAILABLE");
    expect(test.workspaceContextStore.getState().failedAction).toMatchObject({ uncertain: true, action: { mutationId: "mutation-1" } });
    expect(test.workspaceContext.discardFailedAction()).toBe(false);
    test.cloud.setState({ retry: vi.fn(async () => {
      test.personal.getState().addGraph(graph("pending-copy")); test.cloud.setState({ status: "synced" });
    }) });
    expect(await test.workspaceContext.retryFailedAction()).toBe("pending-copy");
    expect(test.sync.write).toHaveBeenCalledTimes(1);
    expect(test.workspaceContextStore.getState().failedAction).toBeNull();
    expect(test.activeWorkspaceStore.getState().documents.map(document => document.id)).toEqual(["shared-id"]);
  });

  it("创建按本人receipt定位，不能把同时出现的其他人图当成自己新建图", async () => {
    const test = setup(); test.enter(); test.workspaceContext.selectGraph(null);
    test.sync.write.mockImplementationOnce(async () => {
      test.receive(snapshot(row(graph()), row(graph("someone-else")), row(graph("my-server-id"))));
      return { workspace: snapshot(row(graph("someone-else")), row(graph("my-server-id"))).workspace };
    });
    test.api.receipt.mockResolvedValueOnce({ mutationId: "mutation-1", applied: true, groupId: "group-fixture", graphId: "my-server-id", personalGraphId: null });
    expect(await test.workspaceContext.createGraph(graph("untrusted-template-id"))).toBe("my-server-id");
    expect(test.activeWorkspaceStore.getState().currentId).toBe("my-server-id");
    test.receive(snapshot(row(graph()), row(graph("someone-else")), row(graph("my-server-id"), 2)));
    expect(test.activeWorkspaceStore.getState().currentId).toBe("my-server-id");
    expect(test.personal.getState().documents.map(value => value.id)).toEqual(["shared-id"]);
  });

  it.each(["create", "copyIn"] as const)("%s已确认但首个权威快照中被删除，不重发或永久锁住小组", async action => {
    const test = setup(); test.enter();
    const source = test.personal.getState().documents[0]!;
    test.cloudApi.read.mockResolvedValue({ userId: "user-fixture", activeOrder: [source.id], deletedIds: [],
      graphs: [{ ...row(source), history: storeGraphHistory(createGraphHistory(source)) }] });
    test.sync.write.mockResolvedValue({ workspace: snapshot(row(graph())).workspace });
    test.api.receipt.mockImplementation(async (_userId, mutationId) => ({ mutationId, applied: true,
      groupId: "group-fixture", graphId: "new-but-deleted", personalGraphId: null }));
    const pending = action === "create" ? test.workspaceContext.createGraph(graph("template")) : test.workspaceContext.copyIn(source.id);
    const rejected = expect(pending).rejects.toThrow("GROUP_NOT_FOUND");
    for (let count = 0; count < 10; ++count) await Promise.resolve();
    const deleted: GroupGraphRecord = { ...row(graph("new-but-deleted"), 2), status: "deleted", originalIndex: 1 };
    test.receive(snapshot(row(graph()), deleted)); await rejected;
    expect(test.workspaceContextStore.getState()).toMatchObject({ busy: false, failedAction: null, error: "GROUP_NOT_FOUND", writable: true });
    expect(test.activeWorkspaceStore.getState().currentId).toBe("shared-id");
    expect(await test.workspaceContext.retryFailedAction()).toBeNull();
    expect(test.sync.write).toHaveBeenCalledTimes(1);
    test.activeWorkspaceStore.getState().restoreDeletedGraph();
    for (let count = 0; count < 5; ++count) await Promise.resolve();
    expect(test.sync.write).toHaveBeenLastCalledWith(expect.objectContaining({ action: "restore", graphId: "new-but-deleted", mutationId: "mutation-2" }));
    test.workspaceContext.leaveGroup(); test.enter();
    expect(test.workspaceContextStore.getState().failedAction).toBeNull();
  });

  it("复制个人图必须与已确认云内容及布局一致，未保存内容绝不静默降级为旧云副本", async () => {
    const test = setup(); test.enter();
    const document = test.personal.getState().documents[0]!;
    test.cloudApi.read.mockResolvedValueOnce({ userId: "user-fixture", activeOrder: [document.id], deletedIds: [],
      graphs: [{ ...row({ ...document, title: "旧云内容" }), history: storeGraphHistory(createGraphHistory(document)) }] });
    await expect(test.workspaceContext.copyIn(document.id)).rejects.toThrow("GROUP_CONFLICT");
    expect(test.sync.write).not.toHaveBeenCalled();
    test.cloud.setState({ pending: true });
    await expect(test.workspaceContext.copyIn(document.id)).rejects.toThrow("GROUP_CONFLICT");
    expect(test.cloudApi.read).toHaveBeenCalledTimes(1);
  });

  it("切图A→B→A及换组取消旧搜索并拒旧捕获；续租不清除预览", async () => {
    const test = setup(); test.enter(snapshot(row(graph()), row(graph("second"))));
    const captured = test.workspaceContext.captureEdit("shared-id")!;
    test.workspaceContext.selectGraph("second"); test.workspaceContext.selectGraph("shared-id");
    expect(await test.workspaceContext.commitCaptured(captured, value => ({ ...value, title: "旧表单" }))).toBe(false);
    const cancelled = test.search.cancel.mock.calls.length;
    test.sync.store.setState({ state: "syncing" }); test.receive(snapshot(row(graph()), row(graph("second"))));
    expect(test.search.cancel).toHaveBeenCalledTimes(cancelled);
    test.workspaceContext.enterGroup("user-fixture", "another-group");
    expect(await test.workspaceContext.commitCaptured(captured, value => value)).toBe(false);
    expect(test.sync.write).not.toHaveBeenCalled();
  });

  it("用户主动打开新搜索后快照更新保持空选择，重新进入小组才恢复默认首图", () => {
    const test = setup(); test.enter(snapshot(row(graph()), row(graph("second"))));
    expect(test.activeWorkspaceStore.getState().currentId).toBe("shared-id");
    test.workspaceContext.selectGraph(null);
    test.receive(snapshot(row(graph("shared-id", "远端改名"), 2), row(graph("second")), row(graph("remote-new"))));
    expect(test.activeWorkspaceStore.getState().currentId).toBeNull();
    test.sync.store.setState({ state: "syncing" });
    test.receive(snapshot(row(graph()), row(graph("second"))));
    expect(test.activeWorkspaceStore.getState().currentId).toBeNull();
    test.workspaceContext.leaveGroup(); test.enter(snapshot(row(graph()), row(graph("second"))));
    expect(test.activeWorkspaceStore.getState().currentId).toBe("shared-id");
  });

  it("账号代际立即清空组图，新个人命名空间恢复前不显示旧个人图或接受迟到组回调", async () => {
    const test = setup(); test.enter();
    test.account.setState({ epoch: 2, scopeUserId: "other-user", account: null });
    expect(test.workspaceContextStore.getState()).toMatchObject({ kind: "personal", writable: false });
    expect(test.activeWorkspaceStore.getState().documents).toEqual([]);
    test.receive(snapshot(row(graph("late-old-group"))));
    test.personal.getState().renameGraph("shared-id", "迟到旧个人回调");
    expect(test.activeWorkspaceStore.getState().documents).toEqual([]);
    test.persistence.setState({ status: "loading" });
    test.personal.getState().restoreDocuments([graph("new-account")], null);
    test.persistence.setState({ status: "ready" });
    expect(test.activeWorkspaceStore.getState().documents[0]?.id).toBe("new-account");
    expect(test.workspaceContextStore.getState().writable).toBe(true);
  });

  it("等待新图快照时切账号立即取消等待，迟到确认不选择新账号或落入个人Store", async () => {
    const test = setup(); test.enter();
    test.sync.write.mockResolvedValue({ workspace: snapshot(row(graph())).workspace });
    test.api.receipt.mockResolvedValue({ mutationId: "mutation-1", applied: true, groupId: "group-fixture", graphId: "late-new-id", personalGraphId: null });
    const pending = test.workspaceContext.createGraph(graph("template"));
    const rejected = expect(pending).rejects.toThrow("ACCOUNT_REQUIRED");
    for (let count = 0; count < 5; ++count) await Promise.resolve();
    test.account.setState({ epoch: 2, scopeUserId: "other-user", account: null });
    await rejected;
    test.receive(snapshot(row(graph("late-new-id"))));
    expect(test.activeWorkspaceStore.getState().documents).toEqual([]);
    expect(test.personal.getState().documents.map(item => item.id)).toEqual(["shared-id"]);
    expect(test.workspaceContextStore.getState()).toMatchObject({ busy: false, failedAction: null });
  });

  it("离线所有受控图写入均不执行，不创建后台队列或伪造本地更改", async () => {
    const test = setup(); test.enter(); test.sync.store.setState({ state: "offline", connectionId: null });
    const state = test.activeWorkspaceStore.getState(), capture = test.workspaceContext.captureEdit("shared-id")!;
    await expect(test.workspaceContext.commitCaptured(capture, value => ({ ...value, title: "离线改动" }))).rejects.toThrow("GROUP_OFFLINE");
    state.renameGraph("shared-id", "离线改名"); state.deleteGraph("shared-id"); state.redo(); state.undo();
    await Promise.resolve(); await Promise.resolve();
    expect(test.sync.write).not.toHaveBeenCalled();
    expect(test.personal.getState().documents[0]?.title).toBe("个人图");
    expect(test.activeWorkspaceStore.getState().documents[0]?.title).toBe("原始标题");
    expect(test.workspaceContextStore.getState().failedAction).toBeNull();
  });

  it("撤销只展示本人窗口，重做快照来自本人真实事件，不混入其他人队列", () => {
    const test = setup(), before = graph(), first = { ...before, title: "甲改名" }, second = { ...first, query: "乙查询" };
    let history = appendHistory(createGraphHistory(before), before, first, { id: "mine", occurredAt: at, active: false, kind: "graph.rename", subject: "标题" }, 100);
    history = appendHistory(history, first, second, { id: "other", occurredAt: at, active: true, kind: "graph.update", subject: "查询" }, 100);
    // appendHistory不接收撤销状态重建；先保存真实事件，再声明本人事件已撤销并让当前图匹配重放。
    const stored = storeGraphHistory(history), current = { ...before, query: "乙查询" };
    const record: GroupGraphRecord = { ...row(current), history: { version: "groupHistory.v1", base: stored.base,
      events: stored.events.map(event => ({ ...event, active: event.id !== "mine", actorUserId: event.id === "mine" ? "user-fixture" : "other-user", undoable: true })),
      redoIdsByUser: { "user-fixture": ["mine"] } } };
    test.enter(snapshot(record));
    const state = test.activeWorkspaceStore.getState();
    expect(test.selectActiveWorkspaceHistory(state).map(event => event.id)).toEqual(["mine"]);
    expect(state.histories["shared-id"]?.future[0]).toMatchObject({ title: "甲改名", query: "乙查询" });
    expect(test.selectActiveWorkspaceRedoCount(state)).toBe(1);
  });
});
