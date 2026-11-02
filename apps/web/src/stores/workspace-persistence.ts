/**
 * 模块职责：用浏览器原生 IndexedDB 保存工作区最新文档，不持久化撤销栈或运行状态。
 * 关键阶段：先恢复并校验，再订阅写入；事务提交后才报告保存成功。
 * 失败路径：读取失败不覆盖旧库，保存失败保留内存编辑并允许重试最新快照。
 */
import { EditableGraphSchema } from "@wayfinder/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";
import { workspaceStore, type WorkspaceStoreState } from "./workspace-store.js";

export type WorkspaceSnapshot = Pick<WorkspaceStoreState, "documents" | "currentId">;
export type WorkspaceStorage = {
  load: () => Promise<WorkspaceSnapshot | null>;
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
function parseSnapshot(value: unknown): WorkspaceSnapshot | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null ||
      !("documents" in value) || !("currentId" in value) ||
      (value.currentId !== null && typeof value.currentId !== "string")) {
    throw new Error("本地搜索图格式无效");
  }
  return {
    documents: EditableGraphSchema.array().parse(value.documents),
    currentId: value.currentId,
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
  load: async () => parseSnapshot(await transact("readonly", store => store.get("current"))),
  save: async snapshot => { await transact("readwrite", store => store.put(snapshot, "current")); },
};

export async function initializeWorkspacePersistence(
  store = workspaceStore,
  storage = browserWorkspaceStorage,
  feedback: StoreApi<WorkspacePersistenceState> = workspacePersistenceStore,
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
    const { documents, currentId } = store.getState();
    const snapshot = { documents, currentId };
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
      const snapshot = await storage.load();
      if (stopped) return;
      if (snapshot !== null) store.getState().restoreDocuments(snapshot.documents, snapshot.currentId);
      unsubscribe = store.subscribe((next, previous) => {
        if (next.documents !== previous.documents || next.currentId !== previous.currentId) void save();
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
