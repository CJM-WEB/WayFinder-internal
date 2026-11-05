/**
 * 模块职责：用浏览器原生 IndexedDB 一致保存工作区文档与每图撤销/重做，不保存运行状态。
 * 关键阶段：先恢复并校验，再订阅写入；事务提交后才报告保存成功。
 * 失败路径：读取失败不覆盖旧库，保存失败保留内存编辑并允许重试最新快照。
 */
import { EditableGraphSchema } from "@wayfinder/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";
import { workspaceStore, type WorkspaceStoreState } from "./workspace-store.js";
import { storeGraphHistory, type StoredGraphHistory } from "./workspace-history.js";

export type WorkspaceSnapshot = Pick<WorkspaceStoreState, "documents" | "currentId"> & Readonly<{
  version: "workspace-storage.v2";
  histories: Record<string, StoredGraphHistory>;
}>;
export type WorkspaceStorage = {
  load: () => Promise<unknown>;
  save: (snapshot: WorkspaceSnapshot) => Promise<void>;
};
export type WorkspacePersistenceState = {
  status: "loading" | "ready" | "saving" | "error";
  error: "load" | "save" | null;
  retry: () => Promise<void>;
};
export const workspacePersistenceStore = createStore<WorkspacePersistenceState>(() => ({
  status: "loading", error: null, retry: async () => {},
}));

/** IndexedDB 中的数据也按不可信输入处理，所有文档继续复用唯一的 Zod 协议。 */
function parseSnapshot(value: unknown): (Pick<WorkspaceStoreState, "documents" | "currentId"> & { histories?: Record<string, unknown> }) | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || value === null ||
      !("documents" in value) || !("currentId" in value) ||
      (value.currentId !== null && typeof value.currentId !== "string")) {
    throw new Error("本地搜索图格式无效");
  }
  // 旧版只存文档，建立空历史继续使用；新版有历史却缺失版本时不能静默丢弃或覆盖。
  let histories: Record<string, unknown> | undefined;
  if ("version" in value || "histories" in value) {
    if (!("version" in value) || value.version !== "workspace-storage.v2" || !("histories" in value)
        || typeof value.histories !== "object" || value.histories === null || Array.isArray(value.histories)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value.histories))) throw new Error("本地搜索图存储版本或历史格式无效");
    histories = value.histories as Record<string, unknown>;
  }
  return {
    documents: EditableGraphSchema.array().parse(value.documents),
    currentId: value.currentId,
    ...(histories === undefined ? {} : { histories }),
  };
}

/** 每次事务结束即关闭连接，避免页面刷新或其他标签页升级时留下长期占用。 */
async function transact(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open("wayfinder-workspace", 1);
    let blocked = false;
    request.onupgradeneeded = () => { request.result.createObjectStore("workspace"); };
    request.onerror = () => reject(new Error("无法打开本地搜索图"));
    request.onblocked = () => { blocked = true; reject(new Error("本地搜索图被其他页面占用")); };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
  });
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction("workspace", mode);
      const request = operation(transaction.objectStore("workspace"));
      let result: unknown;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = transaction.onerror = () => reject(new Error("本地搜索图事务失败"));
    });
  } finally {
    database.close();
  }
}

/** 只在显式初始化或保存时访问浏览器能力，导入模块不会触碰 IndexedDB。 */
export const browserWorkspaceStorage: WorkspaceStorage = {
  load: async () => transact("readonly", store => store.get("current")),
  save: async snapshot => { await transact("readwrite", store => store.put(snapshot, "current")); },
};

export async function initializeWorkspacePersistence(
  store = workspaceStore,
  storage = browserWorkspaceStorage,
  feedback: StoreApi<WorkspacePersistenceState> = workspacePersistenceStore,
  options: Readonly<{ restoreSelection?: boolean }> = {},
): Promise<() => void> {
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let writes = Promise.resolve();
  let revision = 0;
  const report = (state: Partial<WorkspacePersistenceState>): void => {
    if (!stopped) feedback.setState(state);
  };

  /** 顺序提交快照；较旧事务的回调不能把仍待保存的新状态误报为已保存。 */
  const save = (): Promise<void> => {
    const currentRevision = ++revision;
    const { documents, currentId, histories } = store.getState();
    const snapshot: WorkspaceSnapshot = { version: "workspace-storage.v2", documents, currentId,
      histories: Object.fromEntries(Object.entries(histories).map(([id, history]) => [id, storeGraphHistory(history)])) };
    report({ status: "saving", error: null });
    writes = writes.then(() => storage.save(snapshot)).then(() => {
      if (currentRevision === revision) report({ status: "ready", error: null });
    }).catch(() => {
      if (currentRevision === revision) report({ status: "error", error: "save" });
    });
    return writes;
  };
  const load = async (): Promise<void> => {
    report({ status: "loading", error: null });
    try {
      const snapshot = parseSnapshot(await storage.load());
      if (stopped) return;
      if (snapshot !== null) {
        store.getState().restoreDocuments(snapshot.documents, snapshot.currentId, snapshot.histories);
        // 正式入口只恢复内容，旧选择不能在首次读取或失败重试后自动展示；订阅前清选也不写回旧库。
        if (options.restoreSelection === false) store.getState().selectGraph(null);
      }
      unsubscribe = store.subscribe((next, previous) => {
        if (next.documents !== previous.documents || next.currentId !== previous.currentId || next.histories !== previous.histories) void save();
      });
      report({ status: "ready", error: null });
    } catch {
      report({ status: "error", error: "load" });
    }
  };
  feedback.setState({ retry: async () => {
    if (feedback.getState().error === "load") await load();
    else await save();
  } });
  await load();
  return () => { stopped = true; unsubscribe?.(); };
}
