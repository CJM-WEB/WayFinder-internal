/** 身份切换先退订/取消并清空内存，再读取新命名空间；迟到读取不得重新展示旧账号资料。 */
import { graphStore } from "./graph-store.js";
import { workspaceStore, type WorkspaceStoreState } from "./workspace-store.js";
import { credentialSettingsStore } from "./credential-settings.js";
import { accountWorkspaceStorage, initializeWorkspacePersistence, workspacePersistenceStore } from "./workspace-persistence.js";
import { configureAccountIdentity } from "./account.js";
import { storeGraphHistory } from "./workspace-history.js";

export function initializeAccountWorkspace(): void {
  let epoch = 0, stop: (() => void) | undefined;
  let activeIdentity: string | null | undefined;
  let activeReady = false;
  type RetainedWorkspace = Pick<WorkspaceStoreState, "documents" | "histories" | "deletedGraphs" | "currentId">;
  const retained = new Map<string | null, RetainedWorkspace>();
  configureAccountIdentity(async userId => {
    const current = ++epoch;
    stop?.(); stop = undefined;
    // 已加载的运行单例在 epoch 发布时同步取消；此处不能静态导入搜索模块，保持原冷加载边界。
    if (activeIdentity !== undefined && activeReady) {
      const { documents, histories, deletedGraphs, currentId } = workspaceStore.getState();
      retained.set(activeIdentity, { documents, histories, deletedGraphs, currentId });
    }
    activeIdentity = userId;
    activeReady = false;
    const previous = retained.get(userId);
    graphStore.getState().reset();
    workspaceStore.getState().restoreDocuments([], null);
    credentialSettingsStore.getState().setIdentity(userId);
    workspacePersistenceStore.setState({ status: "loading", error: null });
    const storage = accountWorkspaceStorage(userId);
    // 当前标签保留未成功落盘的编辑与原有删除恢复队列，不因一次换号丢弃；不复制到其他身份。
    const scopedStorage = previous === undefined ? storage : { ...storage, load: async () => ({
      version: "workspace-storage.v2", documents: previous.documents, currentId: null,
      histories: Object.fromEntries(Object.entries(previous.histories).map(([id, history]) => [id, storeGraphHistory(history)])),
    }) };
    const unsubscribe = await initializeWorkspacePersistence(workspaceStore, scopedStorage, workspacePersistenceStore,
      { restoreSelection: false, isCurrent: () => epoch === current });
    if (epoch === current) {
      stop = unsubscribe;
      activeReady = workspacePersistenceStore.getState().error !== "load";
      if (previous !== undefined) workspaceStore.setState({ deletedGraphs: previous.deletedGraphs });
    } else unsubscribe();
  });
}
