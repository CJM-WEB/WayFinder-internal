/** 身份切换先退订/取消并清空内存，再读取新命名空间；迟到读取不得重新展示旧账号资料。 */
import { graphStore } from "./graph-store.js";
import { workspaceStore, type WorkspaceStoreState } from "./workspace-store.js";
import { credentialSettingsStore } from "./credential-settings.js";
import { accountWorkspaceStorage, captureWorkspaceSnapshot, initializeWorkspacePersistence, workspacePersistenceStore, type WorkspaceStorage } from "./workspace-persistence.js";
import { configureAccountIdentity } from "./account.js";
import { storeGraphHistory } from "./workspace-history.js";
import { createCloudWorkspaceSync, cloudWorkspaceStore } from "./cloud-workspace.js";
import { accountStore } from "./account.js";

export function initializeAccountWorkspace(): void {
  let epoch = 0, stop: Awaited<ReturnType<typeof initializeWorkspacePersistence>> | undefined;
  let cloud: ReturnType<typeof createCloudWorkspaceSync> | undefined;
  let activeStorage: WorkspaceStorage | undefined;
  let activeIdentity: string | null | undefined;
  let activeReady = false;
  type RetainedWorkspace = Pick<WorkspaceStoreState, "documents" | "histories" | "deletedGraphs" | "currentId">;
  const retained = new Map<string | null, { workspace: RetainedWorkspace; cloud: unknown;
    generation: () => number | undefined; flush: () => Promise<void> }>();
  configureAccountIdentity(async userId => {
    const current = ++epoch;
    const previousPersistence = stop, previousCloud = cloud, previousStorage = activeStorage;
    stop?.(); stop = undefined; cloud?.stop(); cloud = undefined;
    // 已加载的运行单例在 epoch 发布时同步取消；此处不能静态导入搜索模块，保持原冷加载边界。
    if (activeIdentity !== undefined && activeReady) {
      const { documents, histories, deletedGraphs, currentId } = workspaceStore.getState();
      retained.set(activeIdentity, { workspace: { documents, histories, deletedGraphs, currentId }, cloud: previousCloud?.metadata(),
        generation: () => previousStorage?.getGeneration?.(), flush: () => previousPersistence?.flush() ?? Promise.resolve() });
    }
    activeIdentity = userId;
    activeReady = false;
    const previous = retained.get(userId);
    graphStore.getState().reset();
    workspaceStore.getState().restoreDocuments([], null);
    credentialSettingsStore.getState().setIdentity(userId);
    workspacePersistenceStore.setState({ status: "loading", error: null });
    const storage = accountWorkspaceStorage(userId, previous?.generation);
    activeStorage = storage;
    // 当前标签保留未成功落盘的编辑与原有删除恢复队列，不因一次换号丢弃；不复制到其他身份。
    const scopedStorage = previous === undefined ? storage : { ...storage, load: async () => {
      await previous.flush();
      return { version: "workspace-storage.v2", documents: previous.workspace.documents, currentId: null,
        histories: Object.fromEntries(Object.entries(previous.workspace.histories).map(([id, history]) => [id, storeGraphHistory(history)])),
        deletedGraphs: previous.workspace.deletedGraphs.map(item => ({ document: item.document, history: storeGraphHistory(item.history), index: item.index })),
        ...(previous.cloud === undefined ? {} : { cloud: previous.cloud }),
      };
    } };
    const scopedCloud = userId === null ? undefined : createCloudWorkspaceSync({ userId, epoch: accountStore.getState().epoch,
      loadGuest: async () => {
        const guest = retained.get(null);
        if (guest === undefined) return accountWorkspaceStorage(null).load();
        await guest.flush();
        return captureWorkspaceSnapshot({ ...workspaceStore.getState(), ...guest.workspace });
      },
    });
    cloud = scopedCloud;
    let cloudStarted = false;
    const unsubscribe = await initializeWorkspacePersistence(workspaceStore, scopedStorage, workspacePersistenceStore,
      { restoreSelection: false, isCurrent: () => epoch === current,
        ...(scopedCloud === undefined ? {} : { captureCloud: scopedCloud.capture, onRestored: scopedCloud.restore }),
        onReady: handle => {
          if (epoch !== current) return;
          activeReady = true;
          if (scopedCloud !== undefined && !cloudStarted) { cloudStarted = true; scopedCloud.start(handle.persist); }
          else if (scopedCloud === undefined) cloudWorkspaceStore.setState({ status: "guest", conflicts: [], importing: false });
        },
      });
    if (epoch === current) {
      stop = unsubscribe;
      activeReady = workspacePersistenceStore.getState().error !== "load";
    } else unsubscribe();
  });
}
