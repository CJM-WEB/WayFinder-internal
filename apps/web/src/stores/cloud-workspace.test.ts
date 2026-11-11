/** 云同步确定性矩阵：真实Workspace/历史/持久队列，只有HTTP与磁盘使用明确内存替身。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { CloudGraphRecord, CloudGraphWriteRequest, CloudGraphWriteResponse, CloudWorkspaceResponse } from "@wayfinder/contracts";
import { createGraphHistory, remapGraphHistoryIdentity, storeGraphHistory } from "@wayfinder/contracts/graph-history";
import { CloudWorkspaceError, type CloudWorkspaceApi } from "../api/cloud-workspace.js";
import { createCloudWorkspaceSync, type CloudWorkspaceState } from "./cloud-workspace.js";
import { createEmptyGraph, createWorkspaceStore } from "./workspace-store.js";
import { captureWorkspaceSnapshot, initializeWorkspacePersistence, type WorkspacePersistenceState, type WorkspaceSnapshot } from "./workspace-persistence.js";
import { addNode } from "./workspace-edits.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const graph = (id: string, title = id) => createEmptyGraph(id, title, "zh-CN", "2026-01-01T00:00:00Z");
const row = (id: string, title = id, revision = 1): CloudGraphRecord => {
  const document = graph(id, title);
  return { status: "active", originalIndex: null, revision, document, history: storeGraphHistory(createGraphHistory(document)) };
};
const empty = (): CloudWorkspaceResponse => ({ userId: "fixture-A", graphs: [], activeOrder: [], deletedIds: [] });

async function setup(initial?: WorkspaceSnapshot, initialRemote = empty()) {
  const store = createWorkspaceStore();
  let remote = structuredClone(initialRemote), disk = initial === undefined ? undefined : structuredClone(initial);
  let failDisk = false, failNetwork = false, lostAck = false, counter = 0;
  const receipts = new Map<string, { body: string; response: CloudGraphWriteResponse }>();
  const imports = new Set<string>();
  const api: CloudWorkspaceApi = {
    read: vi.fn(async () => { if (failNetwork) throw new CloudWorkspaceError("WORKSPACE_UNAVAILABLE"); return structuredClone(remote); }),
    write: vi.fn(async (_userId, input) => {
      if (failNetwork) throw new CloudWorkspaceError("WORKSPACE_UNAVAILABLE");
      const persisted = disk?.cloud as { queue?: Array<{ frozen?: CloudGraphWriteRequest }> } | undefined;
      expect(persisted?.queue?.some(value => JSON.stringify(value.frozen) === JSON.stringify(input))).toBe(true);
      const receipt = receipts.get(input.mutationId);
      if (receipt !== undefined) { if (receipt.body !== JSON.stringify(input)) throw new CloudWorkspaceError("WORKSPACE_CONFLICT"); return structuredClone(receipt.response); }
      const id = input.action === "save" ? input.document.id : input.graphId;
      const current = remote.graphs.find(value => value.document.id === id);
      if (input.expectedRevision === 0 ? current !== undefined : current?.revision !== input.expectedRevision) throw new CloudWorkspaceError("WORKSPACE_CONFLICT");
      let record: CloudGraphRecord;
      if (input.action === "save") {
        if (current?.status === "deleted") throw new CloudWorkspaceError("WORKSPACE_CONFLICT");
        record = { status: "active", originalIndex: null, document: input.document, history: input.history, revision: input.expectedRevision + 1 };
        if (current === undefined) remote.activeOrder.push(id);
      } else {
        if (current === undefined) throw new CloudWorkspaceError("WORKSPACE_NOT_FOUND");
        if (input.action === "delete") {
          if (current.status !== "active") throw new CloudWorkspaceError("WORKSPACE_CONFLICT");
          record = { ...current, status: "deleted", originalIndex: remote.activeOrder.indexOf(id), revision: current.revision + 1 };
          remote.activeOrder = remote.activeOrder.filter(value => value !== id); remote.deletedIds.push(id);
        } else {
          if (current.status !== "deleted" || remote.deletedIds.at(-1) !== id) throw new CloudWorkspaceError("WORKSPACE_CONFLICT");
          record = { ...current, status: "active", originalIndex: null, revision: current.revision + 1 };
          remote.activeOrder.splice(current.originalIndex, 0, id); remote.deletedIds.pop();
        }
      }
      remote.graphs = [...remote.graphs.filter(value => value.document.id !== id), record];
      const response = structuredClone({ userId: remote.userId, record, activeOrder: remote.activeOrder, deletedIds: remote.deletedIds });
      receipts.set(input.mutationId, { body: JSON.stringify(input), response });
      if (lostAck) { lostAck = false; throw new CloudWorkspaceError("WORKSPACE_UNAVAILABLE"); }
      return response;
    }),
    import: vi.fn(async (_userId, body) => {
      if (failNetwork) throw new CloudWorkspaceError("WORKSPACE_UNAVAILABLE");
      if (!imports.has(body.importId)) {
        imports.add(body.importId);
        for (const entry of body.documents) {
          const mapped = remapGraphHistoryIdentity(entry.document, entry.history, `import-${body.importId}-${entry.document.id}`);
          remote.graphs.push({ ...mapped, status: "active", originalIndex: null, revision: 1 }); remote.activeOrder.push(mapped.document.id);
        }
        for (const entry of body.deletedGraphs) {
          const mapped = remapGraphHistoryIdentity(entry.document, entry.history, `import-${body.importId}-${entry.document.id}`);
          remote.graphs.push({ ...mapped, status: "deleted", originalIndex: entry.originalIndex, revision: 1 }); remote.deletedIds.push(mapped.document.id);
        }
      }
      if (lostAck) { lostAck = false; throw new CloudWorkspaceError("WORKSPACE_UNAVAILABLE"); }
      return structuredClone(remote);
    }),
  };
  const feedback = createStore<CloudWorkspaceState>(() => ({ status: "guest", conflicts: [], importing: false,
    retry: async () => {}, reload: async () => {}, copy: async () => {}, importGuest: async () => {} }));
  const localFeedback = createStore<WorkspacePersistenceState>(() => ({ status: "loading", error: null, retry: async () => {} }));
  let guest: WorkspaceSnapshot | null = null;
  const sync = createCloudWorkspaceSync({ userId: "fixture-A", epoch: 1, store, api, feedback,
    createId: () => `mutation-${++counter}`, isCurrent: () => true, loadGuest: async () => structuredClone(guest) });
  const handle = await initializeWorkspacePersistence(store, {
    load: async () => disk,
    save: async snapshot => { if (failDisk) throw new Error("fixture-disk-failure"); disk = structuredClone(snapshot); },
  }, localFeedback, { captureCloud: sync.capture, onRestored: sync.restore });
  cleanups.push(() => { sync.stop(); handle(); });
  return { store, feedback, localFeedback, sync, handle, api,
    start: () => sync.start(handle.persist), disk: () => disk,
    remote: () => remote, replaceRemote: (value: CloudWorkspaceResponse) => { remote = value; },
    failDisk: (value: boolean) => { failDisk = value; }, failNetwork: (value: boolean) => { failNetwork = value; },
    loseAck: () => { lostAck = true; }, guest: (value: WorkspaceSnapshot) => { guest = value; }, imports: () => imports.size,
  };
}

describe("账号云同步协调", () => {
  it("本地保存失败绝不HTTP写入，失败后编辑不自动重试；显式重试保留并保存原图", async () => {
    const f = await setup(); f.failDisk(true); f.start();
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("error"));
    f.store.getState().addGraph(graph("g")); await f.handle.flush();
    expect(f.api.write).not.toHaveBeenCalled(); expect(f.store.getState().documents).toHaveLength(1);
    f.failDisk(false); await f.feedback.getState().retry();
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    expect(f.remote().graphs[0]?.document.id).toBe("g");
    f.failNetwork(true); f.store.getState().renameGraph("g", "离线修改");
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("error"));
    const calls = vi.mocked(f.api.write).mock.calls.length;
    f.store.getState().renameGraph("g", "后续仍保留"); await f.handle.flush();
    expect(vi.mocked(f.api.write).mock.calls).toHaveLength(calls);
  });

  it("旧ACK不清新修改，已确认版本用于后续冻结请求", async () => {
    const f = await setup(); f.start(); await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    const write = f.api.write;
    let release!: () => void;
    vi.spyOn(f.api, "write").mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return write(...args); });
    f.store.getState().addGraph(graph("g"));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.store.getState().renameGraph("g", "新修改"); release();
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    expect(f.remote().graphs[0]?.document.title).toBe("新修改");
    expect(f.remote().graphs[0]?.revision).toBe(2);
    expect(f.store.getState().documents[0]?.title).toBe("新修改");
  });

  it("丢ACK后使用同mutationId及body重试，无重复图或历史", async () => {
    const f = await setup(); f.start(); await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    f.loseAck(); f.store.getState().addGraph(graph("g"));
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("error"));
    const first = structuredClone(vi.mocked(f.api.write).mock.calls[0]?.[1]);
    await f.feedback.getState().retry(); await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    expect(vi.mocked(f.api.write).mock.calls[1]?.[1]).toEqual(first);
    expect(f.remote().graphs).toHaveLength(1); expect(f.remote().graphs[0]?.revision).toBe(1);
  });

  it("首次含删除记录按真实原位置同步；待恢复GET和断网不把中间图挪到末尾", async () => {
    const original = createWorkspaceStore(); for (const id of ["A", "B", "C"]) original.getState().addGraph(graph(id));
    original.getState().deleteGraph("B");
    const f = await setup(captureWorkspaceSnapshot(original.getState())); f.start();
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    expect(f.remote().activeOrder).toEqual(["A", "C"]);
    expect(f.remote().graphs.find(value => value.document.id === "B")).toMatchObject({ status: "deleted", originalIndex: 1 });
    f.failNetwork(true); f.store.getState().restoreDeletedGraph();
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("error"));
    expect(f.store.getState().documents.map(value => value.id)).toEqual(["A", "B", "C"]);
    f.failNetwork(false); await f.feedback.getState().retry();
    expect(f.store.getState().documents.map(value => value.id)).toEqual(["A", "B", "C"]);
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    expect(f.remote().activeOrder).toEqual(["A", "B", "C"]);
  });

  it("冲突保本地，另存完整历史副本且不覆盖云端原图", async () => {
    const f = await setup(undefined, { ...empty(), activeOrder: ["g"], graphs: [row("g")] }); f.start();
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    f.replaceRemote({ ...empty(), activeOrder: ["g"], graphs: [row("g", "另一设备", 2)] });
    f.store.getState().renameGraph("g", "我的修改");
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("conflict"));
    expect(f.store.getState().documents[0]?.title).toBe("我的修改");
    await f.feedback.getState().copy("g");
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    expect(f.remote().graphs.find(value => value.document.id === "g")?.document.title).toBe("另一设备");
    const copy = f.remote().graphs.find(value => value.document.id !== "g");
    expect(copy?.document.title).toBe("我的修改"); expect(copy?.history.events).toHaveLength(1);
    expect(copy?.history.events[0]?.before.id).toBe(copy?.document.id);
  });

  it("明确导入包含删除历史，丢ACK重试及再次确认不重复，不修改访客源", async () => {
    const original = createWorkspaceStore(); original.getState().addGraph(graph("guest")); original.getState().renameGraph("guest", "访客修改"); original.getState().deleteGraph("guest");
    const guest = captureWorkspaceSnapshot(original.getState());
    const f = await setup(); f.guest(guest); f.start(); await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    expect(f.api.import).not.toHaveBeenCalled();
    f.loseAck(); await f.feedback.getState().importGuest();
    expect(f.feedback.getState().status).toBe("error");
    const first = structuredClone(vi.mocked(f.api.import).mock.calls[0]?.[1]);
    await f.feedback.getState().retry(); await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    expect(vi.mocked(f.api.import).mock.calls[1]?.[1]).toEqual(first);
    await f.feedback.getState().importGuest();
    expect(f.imports()).toBe(1); expect(f.api.import).toHaveBeenCalledTimes(2);
    expect(f.remote().graphs[0]?.history.events).toHaveLength(1);
    expect(f.remote().deletedIds).toHaveLength(1); expect(guest).toEqual(captureWorkspaceSnapshot(original.getState()));
    expect(JSON.stringify(first)).not.toContain("apiKey");
  });

  it("停止后迟到读取/显式persist都不能捕获新账号数据", async () => {
    const f = await setup();
    let release!: (value: CloudWorkspaceResponse) => void;
    vi.spyOn(f.api, "read").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    f.start(); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const beforeStop = structuredClone(f.disk());
    f.sync.stop(); f.handle(); f.store.getState().addGraph(graph("B-private"));
    await expect(f.handle.persist()).rejects.toThrow("身份已失效");
    release({ ...empty(), activeOrder: ["old-A"], graphs: [row("old-A")] });
    await Promise.resolve(); await Promise.resolve();
    expect(f.store.getState().documents.map(value => value.id)).toEqual(["B-private"]);
    expect(f.disk()).toEqual(beforeStop);
  });

  it("retry旧GET先结束才允许新POST，迟到读取不能回退新确认图", async () => {
    const f = await setup(undefined, { ...empty(), activeOrder: ["g"], graphs: [row("g")] }); f.start();
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    let release!: (value: CloudWorkspaceResponse) => void;
    const stale = structuredClone(f.remote());
    vi.spyOn(f.api, "read").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const retry = f.feedback.getState().retry(); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.store.getState().renameGraph("g", "读期间的新编辑"); await f.handle.flush();
    expect(f.api.write).not.toHaveBeenCalled();
    release(stale); await retry;
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    expect(f.store.getState().documents[0]?.title).toBe("读期间的新编辑"); expect(f.remote().graphs[0]?.document.title).toBe("读期间的新编辑");
  });

  it("冲突重新载入期间的新编辑不被覆盖，导入不会越过未完成结构队列", async () => {
    const f = await setup(undefined, { ...empty(), activeOrder: ["g"], graphs: [row("g")] }); f.start();
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    f.replaceRemote({ ...empty(), activeOrder: ["g"], graphs: [row("g", "远端", 2)] });
    f.store.getState().renameGraph("g", "本地"); await vi.waitFor(() => expect(f.feedback.getState().status).toBe("conflict"));
    await f.feedback.getState().importGuest(); expect(f.api.import).not.toHaveBeenCalled(); expect(f.feedback.getState().importBlocked).toBe(true);
    let release!: (value: CloudWorkspaceResponse) => void;
    vi.spyOn(f.api, "read").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const reload = f.feedback.getState().reload("g"); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.store.getState().renameGraph("g", "重载期间的新编辑"); release(structuredClone(f.remote())); await reload;
    expect(f.store.getState().documents[0]?.title).toBe("重载期间的新编辑"); expect(f.feedback.getState().conflicts).toContain("g");
  });

  it("导入在途不早报同步，期间新编辑保持dirty并在导入之后保存", async () => {
    const guest = createWorkspaceStore(); guest.getState().addGraph(graph("guest"));
    const f = await setup(); f.guest(captureWorkspaceSnapshot(guest.getState())); f.start();
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    const originalImport = f.api.import; let release!: () => void;
    vi.spyOn(f.api, "import").mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return originalImport(...args); });
    const importing = f.feedback.getState().importGuest(); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.store.getState().addGraph(graph("new", "导入期间编辑")); await f.handle.flush();
    expect(f.feedback.getState().status).not.toBe("synced"); expect(f.api.write).not.toHaveBeenCalled();
    release(); await importing; await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    expect(f.store.getState().documents.find(value => value.id === "new")?.title).toBe("导入期间编辑");
    expect(f.remote().graphs).toHaveLength(2);
  });

  it("普通ACK保留合法节点选择，远端已清理的clean删除项不会回填", async () => {
    const document = addNode(graph("g"), "节点", "", "n");
    const active: CloudGraphRecord = { status: "active", originalIndex: null, revision: 1, document, history: storeGraphHistory(createGraphHistory(document)) };
    const removed: CloudGraphRecord = { ...row("old"), status: "deleted", originalIndex: 0 };
    const f = await setup(undefined, { ...empty(), activeOrder: ["g"], deletedIds: ["old"], graphs: [active, removed] }); f.start();
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    f.store.getState().selectGraph("g"); f.store.getState().selectNode("n");
    f.replaceRemote({ ...f.remote(), deletedIds: [], graphs: f.remote().graphs.filter(value => value.document.id !== "old") });
    f.store.getState().renameGraph("g", "正常保存");
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    expect(f.store.getState().selectedNodeIds.g).toBe("n"); expect(f.store.getState().deletedGraphs).toHaveLength(0);
  });

  it("已commit丢ACK后刷新，从耐久冻结队列使用完全相同body恢复且不重复", async () => {
    const first = await setup(); first.start(); await vi.waitFor(() => expect(first.feedback.getState().status).toBe("synced"));
    first.loseAck(); first.store.getState().addGraph(graph("g"));
    await vi.waitFor(() => expect(first.feedback.getState().status).toBe("error"));
    await first.handle.flush(); const disk = structuredClone(first.disk());
    const body = structuredClone(vi.mocked(first.api.write).mock.calls[0]?.[1]);
    first.sync.stop(); first.handle();
    const restored = await setup(disk, first.remote());
    vi.spyOn(restored.api, "read").mockImplementation((...args) => first.api.read(...args));
    vi.spyOn(restored.api, "write").mockImplementation((...args) => {
      expect(args[1]).toEqual(body);
      return first.api.write(...args);
    });
    restored.start(); await vi.waitFor(() => expect(restored.feedback.getState().status).toBe("synced"));
    expect(first.remote().graphs).toHaveLength(1); expect(first.remote().graphs[0]?.revision).toBe(1);
    expect(restored.store.getState().documents[0]?.id).toBe("g");
  });

  it("首次GET失败后明确导入成功也建立ready，后续编辑可正常同步", async () => {
    const f = await setup(); f.failNetwork(true); f.start();
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("error"));
    const guest = createWorkspaceStore(); guest.getState().addGraph(graph("guest")); f.guest(captureWorkspaceSnapshot(guest.getState()));
    f.failNetwork(false); await f.feedback.getState().importGuest();
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    const id = f.store.getState().documents[0]?.id; if (id === undefined) throw new Error("缺少导入图");
    f.store.getState().renameGraph(id, "导入后继续修改");
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    expect(f.remote().graphs[0]?.document.title).toBe("导入后继续修改");
  });

  it("本地同ID但不同的有效冻结save正文视为损坏，不能静默覆盖当前图", async () => {
    const original = await setup(); original.start(); await vi.waitFor(() => expect(original.feedback.getState().status).toBe("synced"));
    original.loseAck(); original.store.getState().addGraph(graph("g"));
    await vi.waitFor(() => expect(original.feedback.getState().status).toBe("error")); await original.handle.flush();
    const disk = structuredClone(original.disk()); if (disk === undefined) throw new Error("缺少耐久快照");
    const metadata = disk.cloud as { queue: Array<{ frozen?: CloudGraphWriteRequest }> };
    const frozen = metadata.queue[0]?.frozen; if (frozen?.action !== "save") throw new Error("缺少冻结请求");
    const altered = graph("g", "损坏的另一份有效内容");
    frozen.document = altered; frozen.history = storeGraphHistory(createGraphHistory(altered));
    const restored = await setup(disk, original.remote());
    expect(restored.localFeedback.getState().error).toBe("load"); expect(restored.api.write).not.toHaveBeenCalled();
  });

  it("捕获/克隆同步失败时不沿用synced，保留新内存图且暂停HTTP", async () => {
    const f = await setup(undefined, { ...empty(), activeOrder: ["g"], graphs: [row("g")] }); f.start();
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    const local = createWorkspaceStore(); local.getState().addGraph(graph("g")); local.getState().renameGraph("g", "尚未保存的新内容");
    const clone = vi.spyOn(globalThis, "structuredClone").mockImplementationOnce(() => { throw new Error("fixture-clone-failure"); });
    expect(() => f.sync.capture(local.getState())).toThrow("WORKSPACE_UNAVAILABLE"); clone.mockRestore();
    f.store.setState({ documents: local.getState().documents, histories: local.getState().histories }); await f.handle.flush();
    expect(f.store.getState().documents[0]?.title).toBe("尚未保存的新内容");
    expect(f.feedback.getState().status).toBe("error"); expect(f.api.write).not.toHaveBeenCalled();
  });

  it("比较阶段入队前失败后，显式retry先重新捕获dirty再GET，不覆盖新标题", async () => {
    const f = await setup(undefined, { ...empty(), activeOrder: ["g"], graphs: [row("g")] }); f.start();
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    const stringify = JSON.stringify;
    let fail = true;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((value: unknown) => {
      if (fail && typeof value === "object" && value !== null && "history" in value && "originalIndex" in value) {
        fail = false; throw new Error("fixture-compare-failure");
      }
      return stringify(value);
    });
    f.store.getState().renameGraph("g", "入队前失败的新内容"); spy.mockRestore();
    expect(f.feedback.getState().status).toBe("error"); expect(f.api.write).not.toHaveBeenCalled();
    await f.feedback.getState().retry(); await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    expect(f.remote().graphs[0]?.document.title).toBe("入队前失败的新内容");
    expect(f.store.getState().documents[0]?.title).toBe("入队前失败的新内容");
  });

  it("GET在途才发生的入队前捕获失败，也必须在merge前补回dirty", async () => {
    const f = await setup(undefined, { ...empty(), activeOrder: ["g"], graphs: [row("g")] }); f.start();
    await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    const stale = structuredClone(f.remote()); let release!: (value: CloudWorkspaceResponse) => void;
    vi.spyOn(f.api, "read").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const retry = f.feedback.getState().retry(); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const stringify = JSON.stringify; let fail = true;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((value: unknown) => {
      if (fail && typeof value === "object" && value !== null && "history" in value && "originalIndex" in value) {
        fail = false; throw new Error("fixture-inflight-compare-failure");
      }
      return stringify(value);
    });
    f.store.getState().renameGraph("g", "GET在途期间的新内容"); spy.mockRestore();
    release(stale); await retry; await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    expect(f.remote().graphs[0]?.document.title).toBe("GET在途期间的新内容");
    expect(f.store.getState().documents[0]?.title).toBe("GET在途期间的新内容");
  });

  it("已导入来源在GET失败后重复确认仍保错误和重试，不能永久停在saving", async () => {
    const guest = createWorkspaceStore(); guest.getState().addGraph(graph("guest"));
    const source = captureWorkspaceSnapshot(guest.getState());
    const f = await setup(); f.guest(source); f.start(); await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    await f.feedback.getState().importGuest(); await vi.waitFor(() => expect(f.feedback.getState().status).toBe("synced"));
    f.failNetwork(true); await f.feedback.getState().retry(); expect(f.feedback.getState().status).toBe("error");
    await f.feedback.getState().importGuest(); expect(f.feedback.getState().status).toBe("error"); expect(f.api.import).toHaveBeenCalledTimes(1);
    const restored = await setup(structuredClone(f.disk()), f.remote()); restored.guest(source); restored.failNetwork(true); restored.start();
    await vi.waitFor(() => expect(restored.feedback.getState().status).toBe("error"));
    await restored.feedback.getState().importGuest(); expect(restored.feedback.getState().status).toBe("error"); expect(restored.api.import).not.toHaveBeenCalled();
    restored.failNetwork(false); await restored.feedback.getState().retry(); await vi.waitFor(() => expect(restored.feedback.getState().status).toBe("synced"));
  });
});
