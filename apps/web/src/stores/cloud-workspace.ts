/**
 * 账号云同步：本地修改永远先保留；网络只串行提交耐久化的冻结意图，回执不覆盖后续编辑。
 * 本模块没有第二个IDB写入器；capture和persist接入现有唯一快照队列，换号后停止所有回调。
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { CloudGraphWriteRequestSchema, CloudWorkspaceImportRequestSchema, EditableGraphSchema, StoredGraphHistorySchema, UserIdSchema,
  type CloudGraphWriteRequest, type CloudWorkspaceResponse, type StoredGraphHistory } from "@wayfinder/contracts";
import { createGraphHistory, remapGraphHistoryIdentity, restoreGraphHistory, storeGraphHistory } from "@wayfinder/contracts/graph-history";
import { CloudWorkspaceError, createCloudWorkspaceApi, type CloudWorkspaceApi } from "../api/cloud-workspace.js";
import { parseWorkspaceSnapshot } from "./workspace-persistence.js";
import { accountStore } from "./account.js";
import { workspaceStore, type WorkspaceStoreState } from "./workspace-store.js";

type LocalRecord = { document: WorkspaceStoreState["documents"][number]; history: StoredGraphHistory; status: "active" | "deleted"; originalIndex: number | null };
type Intent = { mutationId: string; action: CloudGraphWriteRequest["action"]; graphId: string;
  document: LocalRecord["document"]; history: StoredGraphHistory; frozen?: CloudGraphWriteRequest };
type Metadata = { version: "cloud-sync.v1"; initialized: boolean;
  known: Record<string, { revision: number; status: "active" | "deleted" }>;
  queue: Intent[]; conflicts: string[];
  importAttempt?: { body: import("@wayfinder/contracts").CloudWorkspaceImportRequest; fingerprint: string };
  importedFingerprints: string[];
};
/** 私有本地状态不另造Wire协议；嵌入的所有公共对象仍使用Contracts唯一Zod校验。 */
function parseMetadata(value: unknown): Metadata {
  const object = (raw: unknown): Record<string, unknown> => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("本地同步状态无效");
    return raw as Record<string, unknown>;
  };
  const strings = (raw: unknown): string[] => {
    if (!Array.isArray(raw) || raw.some(item => typeof item !== "string" || !item)) throw new Error("本地同步标识无效");
    return raw as string[];
  };
  const raw = object(value);
  if (raw.version !== "cloud-sync.v1" || typeof raw.initialized !== "boolean" || !Array.isArray(raw.queue)) throw new Error("本地同步状态无效");
  const known = Object.fromEntries(Object.entries(object(raw.known)).map(([id, input]) => {
    const row = object(input);
    if (!id || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 1 || (row.status !== "active" && row.status !== "deleted")) throw new Error("本地同步版本无效");
    return [id, { revision: row.revision, status: row.status }];
  })) as Metadata["known"];
  const queue = raw.queue.map(value => {
    const row = object(value);
    if ((row.action !== "save" && row.action !== "delete" && row.action !== "restore") || typeof row.graphId !== "string" || !row.graphId) throw new Error("本地待提交动作无效");
    const document = EditableGraphSchema.parse(row.document), history = StoredGraphHistorySchema.parse(row.history);
    restoreGraphHistory(history, document, 100);
    if (document.id !== row.graphId) throw new Error("本地待提交身份不一致");
    const mutationId = UserIdSchema.parse(row.mutationId);
    const frozen = row.frozen === undefined ? undefined : CloudGraphWriteRequestSchema.parse(row.frozen);
    if (frozen !== undefined && (frozen.mutationId !== mutationId || frozen.action !== row.action || (frozen.action === "save" ? frozen.document.id : frozen.graphId) !== row.graphId)) throw new Error("本地冻结动作不一致");
    if (frozen?.action === "save" && JSON.stringify({ document: frozen.document, history: frozen.history }) !== JSON.stringify({ document, history })) throw new Error("本地冻结内容不一致");
    if (frozen?.action === "save") restoreGraphHistory(frozen.history, frozen.document, 100);
    return { mutationId, action: row.action, graphId: row.graphId, document, history, ...(frozen === undefined ? {} : { frozen }) } as Intent;
  });
  const result: Metadata = { version: "cloud-sync.v1", initialized: raw.initialized, known, queue,
    conflicts: strings(raw.conflicts), importedFingerprints: raw.importedFingerprints === undefined ? [] : strings(raw.importedFingerprints) };
  if (raw.importAttempt !== undefined) {
    const attempt = object(raw.importAttempt);
    if (typeof attempt.fingerprint !== "string") throw new Error("本地导入意图无效");
    result.importAttempt = { body: CloudWorkspaceImportRequestSchema.parse(attempt.body), fingerprint: attempt.fingerprint };
  }
  return result;
}
type CloudStatus = "guest" | "loading" | "saving" | "synced" | "offline" | "error" | "conflict";
export type CloudWorkspaceState = {
  status: CloudStatus; conflicts: string[]; importing: boolean;
  pending?: boolean; importBlocked?: boolean;
  retry: () => Promise<void>; reload: (id: string) => Promise<void>; copy: (id: string) => Promise<void>; importGuest: () => Promise<void>;
};
export const cloudWorkspaceStore = createStore<CloudWorkspaceState>(() => ({ status: "guest", conflicts: [], importing: false,
  retry: async () => {}, reload: async () => {}, copy: async () => {}, importGuest: async () => {} }));

function records(state: WorkspaceStoreState): Map<string, LocalRecord> {
  return new Map<string, LocalRecord>([
    ...state.documents.map(document => [document.id, { document, history: storeGraphHistory(state.histories[document.id] ?? createGraphHistory(document)), status: "active", originalIndex: null }] as const),
    ...state.deletedGraphs.map(item => [item.document.id, { document: item.document, history: storeGraphHistory(item.history), status: "deleted", originalIndex: item.index }] as const),
  ]);
}
const graphId = (intent: Intent): string => intent.graphId;
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export function createCloudWorkspaceSync(options: Readonly<{
  userId: string; epoch: number; store?: StoreApi<WorkspaceStoreState>; api?: CloudWorkspaceApi;
  feedback?: StoreApi<CloudWorkspaceState>; createId?: () => string; loadGuest: () => Promise<unknown>; isCurrent?: () => boolean;
}>) {
  const store = options.store ?? workspaceStore, api = options.api ?? createCloudWorkspaceApi(), feedback = options.feedback ?? cloudWorkspaceStore;
  const createId = options.createId ?? (() => crypto.randomUUID());
  const controller = new AbortController();
  let stopped = false, ready = false, pumping = false, suppress = false, paused = false, importRunning = false;
  let captureFailed = false;
  let pumpFinished = Promise.resolve();
  const resolving = new Set<string>();
  const localSequences = new Map<string, number>();
  let observed: Map<string, LocalRecord> | undefined;
  let metadata: Metadata = { version: "cloud-sync.v1", initialized: false, known: {}, queue: [], conflicts: [], importedFingerprints: [] };
  let persist: () => Promise<void> = async () => { throw new Error("本地队列尚未就绪"); };
  const active = (): boolean => !stopped && !controller.signal.aborted && (options.isCurrent?.() ?? (accountStore.getState().epoch === options.epoch && accountStore.getState().scopeUserId === options.userId));
  let network = Promise.resolve();
  /** 所有读写共用窄串行门禁，旧GET不能晚于本协调器的新POST回执才落入clean状态。 */
  const request = <T>(action: () => Promise<T>): Promise<T> => {
    const pending = network.then(() => {
      if (!active()) throw new CloudWorkspaceError("ACCOUNT_REQUIRED");
      return action();
    });
    network = pending.then(() => {}, () => {});
    return pending;
  };
  const report = (status: CloudStatus): void => { if (active()) feedback.setState({ status, conflicts: [...metadata.conflicts], pending: metadata.queue.length > 0 || metadata.conflicts.length > 0 }); };
  const dirtyIds = (): Set<string> => new Set([...metadata.queue.map(graphId), ...metadata.conflicts]);
  const remember = (id: string, value: Metadata["known"][string]): void => { metadata.known = { ...metadata.known, [id]: value }; };
  const knownRecord = (id: string) => Object.hasOwn(metadata.known, id) ? metadata.known[id] : undefined;
  const failure = (error: unknown): void => {
    paused = true;
    report(typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "error");
    if (active() && error instanceof CloudWorkspaceError && error.code === "ACCOUNT_REQUIRED") void accountStore.getState().refresh().catch(() => {});
  };
  const addConflict = (id: string): void => { if (!metadata.conflicts.includes(id)) metadata.conflicts.push(id); };
  const intent = (action: Intent["action"], record: LocalRecord): Intent => ({ action, mutationId: createId(), graphId: record.document.id, document: record.document, history: record.history });
  const enqueue = (next: Intent): void => {
    const previous = metadata.queue.at(-1);
    if (next.action === "save" && previous?.action === "save" && previous.graphId === next.graphId && previous.frozen === undefined) {
      metadata.queue[metadata.queue.length - 1] = { ...next, mutationId: previous.mutationId };
    } else metadata.queue.push(next);
  };
  const publish = (rows: Map<string, LocalRecord>, activeOrder: string[], deletedOrder: string[]): void => {
    const documents = activeOrder.map(id => rows.get(id)).filter((value): value is LocalRecord => value?.status === "active");
    const deleted = deletedOrder.map(id => rows.get(id)).filter((value): value is LocalRecord => value?.status === "deleted").slice(-100);
    const currentId = store.getState().currentId;
    const selectedNodeIds = Object.fromEntries(Object.entries(store.getState().selectedNodeIds).filter(([id, nodeId]) => {
      const document = documents.find(record => record.document.id === id)?.document;
      return document !== undefined && (nodeId === null || document.nodes.some(node => node.id === nodeId));
    }));
    suppress = true;
    try {
      store.setState({ documents: documents.map(value => value.document),
        histories: Object.fromEntries(documents.map(value => [value.document.id, restoreGraphHistory(value.history, value.document, 100)])),
        deletedGraphs: deleted.map(value => ({ document: value.document, history: restoreGraphHistory(value.history, value.document, 100), index: value.originalIndex ?? 0 })),
        currentId: documents.some(value => value.document.id === currentId) ? currentId : null, selectedNodeIds,
      });
      observed = records(store.getState());
    } finally { suppress = false; }
  };
  const merge = (remote: CloudWorkspaceResponse): void => {
    if (captureFailed) captureLocal(store.getState());
    const local = records(store.getState()), dirty = dirtyIds();
    const remoteRows = new Map(remote.graphs.map(record => [record.document.id, record]));
    if (!metadata.initialized) {
      // 重建本地首次删除之前的顺序，再按删除时间提交，保留原位置而非把删除项附到末尾。
      const initial = [...store.getState().documents.map(document => document.id)];
      for (const item of [...store.getState().deletedGraphs].reverse()) initial.splice(item.index, 0, item.document.id);
      const bootstrap: Intent[] = [], unseen = new Set<string>();
      for (const id of initial) {
        const record = local.get(id); if (record === undefined) continue;
        const cloud = remoteRows.get(id);
        if (cloud !== undefined) {
          remember(id, { revision: cloud.revision, status: cloud.status });
          if (!same({ document: cloud.document, history: cloud.history, status: cloud.status }, { document: record.document, history: record.history, status: record.status })) addConflict(id);
        } else { unseen.add(id); bootstrap.push(intent("save", record)); }
      }
      for (const item of store.getState().deletedGraphs) if (unseen.has(item.document.id)) bootstrap.push(intent("delete", local.get(item.document.id)!));
      metadata.queue = [...bootstrap, ...metadata.queue.filter(item => !unseen.has(item.graphId))];
      metadata.initialized = true;
    }
    const protectedIds = new Set([...dirty, ...dirtyIds()]);
    const merged = new Map<string, LocalRecord>();
    for (const remoteRecord of remote.graphs) {
      const id = remoteRecord.document.id;
      if (!protectedIds.has(id)) {
        merged.set(id, remoteRecord);
        remember(id, { revision: remoteRecord.revision, status: remoteRecord.status });
      }
    }
    for (const [id, record] of local) if (protectedIds.has(id)) merged.set(id, record);
    const remoteOrder = remote.activeOrder.filter(id => merged.get(id)?.status === "active");
    const localOrder = store.getState().documents.map(value => value.id).filter(id => merged.get(id)?.status === "active");
    const structural = metadata.queue.some(item => item.action !== "save" || knownRecord(item.graphId) === undefined)
      || metadata.conflicts.some(id => local.get(id)?.status !== remoteRows.get(id)?.status);
    // 待提交恢复/创建保留本地相邻顺序；不能在GET时把刚恢复的中间图挪到列表末尾。
    const activeOrder = structural ? [...localOrder, ...remoteOrder.filter(id => !localOrder.includes(id))]
      : [...remoteOrder, ...localOrder.filter(id => !remoteOrder.includes(id))];
    const deletedOrder = [...remote.deletedIds.filter(id => merged.get(id)?.status === "deleted" && !protectedIds.has(id)),
      ...store.getState().deletedGraphs.map(value => value.document.id).filter(id => protectedIds.has(id) && merged.has(id))];
    publish(merged, activeOrder, deletedOrder);
  };

  const pump = async (): Promise<void> => {
    if (!active() || !ready || pumping || paused || importRunning || metadata.importAttempt !== undefined) return;
    pumping = true;
    let release = (): void => {};
    pumpFinished = new Promise<void>(resolve => { release = resolve; });
    try {
      while (active() && !paused && !importRunning) {
        const item = metadata.queue.find(value => !metadata.conflicts.includes(value.graphId));
        if (item === undefined) { report(metadata.conflicts.length > 0 ? "conflict" : "synced"); return; }
        report("saving");
        const known = knownRecord(item.graphId);
        if (known === undefined && item.action !== "save") {
          // 本地新图在第一次上传前已删除/恢复，先建立同一身份的完整图再继续结构操作。
          metadata.queue.splice(metadata.queue.indexOf(item), 0, intent("save", { document: item.document, history: item.history, status: "active", originalIndex: null }));
          continue;
        }
        if (item.frozen === undefined) item.frozen = CloudGraphWriteRequestSchema.parse(item.action === "save"
          ? { action: "save", mutationId: item.mutationId, document: item.document, history: item.history, expectedRevision: known?.revision ?? 0 }
          : { action: item.action, mutationId: item.mutationId, graphId: item.graphId, expectedRevision: known?.revision });
        await persist(); // 请求身份和完整body必须先耐久化；失败不能假装已保存而发出新请求。
        if (!active() || importRunning) return;
        try {
          const frozen = item.frozen;
          const result = await request(() => api.write(options.userId, frozen, controller.signal));
          if (!active()) return;
          remember(item.graphId, { revision: result.record.revision, status: result.record.status });
          metadata.queue = metadata.queue.filter(value => value !== item);
          // 先推进已确认版本并耐久化，再读取同一事务快照；只回填clean项，保留后续dirty编辑。
          await persist();
          const remote = await request(() => api.read(options.userId, controller.signal));
          if (!active()) return;
          merge(remote); await persist();
        } catch (error: unknown) {
          if (!active()) return;
          if (error instanceof CloudWorkspaceError && ["WORKSPACE_CONFLICT", "WORKSPACE_NOT_FOUND"].includes(error.code)) { addConflict(item.graphId); await persist(); continue; }
          throw error;
        }
      }
    } catch (error: unknown) { failure(error); }
    finally { pumping = false; release(); }
  };
  const wake = (): void => { if (ready && active() && !paused && !importRunning) queueMicrotask(() => { void pump(); }); };
  const retry = async (): Promise<void> => {
    if (!active() || pumping) return;
    report("loading");
    try {
      // 捕获曾在入队前失败时，重试必须先重新耐久化当前编辑，不能先GET把它误当clean覆盖。
      await persist();
      if (!active()) return;
      const remote = await request(() => api.read(options.userId, controller.signal));
      if (!active()) return;
      merge(remote); ready = true; await persist(); paused = false;
      if (metadata.importAttempt !== undefined) await importGuest(); else await pump();
    } catch (error: unknown) {
      failure(error);
    }
  };
  const reloadRecord = async (id: string, expectedSequence: number): Promise<void> => {
    if (!active()) return;
    const remote = await request(() => api.read(options.userId, controller.signal));
    if (!active()) return;
    if (captureFailed) captureLocal(store.getState());
    if (expectedSequence !== (localSequences.get(id) ?? 0)) {
      addConflict(id); await persist(); report("conflict"); return;
    }
    metadata.queue = metadata.queue.filter(value => value.graphId !== id);
    metadata.conflicts = metadata.conflicts.filter(value => value !== id);
    merge(remote); await persist(); ready = true; paused = false; wake();
  };
  const reload = async (id: string): Promise<void> => {
    if (!active() || resolving.has(id)) return;
    resolving.add(id); report("loading");
    try { await reloadRecord(id, localSequences.get(id) ?? 0); }
    catch (error: unknown) { failure(error); }
    finally { resolving.delete(id); }
  };
  const copy = async (id: string): Promise<void> => {
    const local = records(store.getState()).get(id);
    if (local === undefined || !active() || resolving.has(id)) return;
    resolving.add(id); report("saving");
    const sequence = localSequences.get(id) ?? 0;
    try {
      const remapped = remapGraphHistoryIdentity(local.document, local.history, createId());
      const next = { ...local, ...remapped, status: "active" as const, originalIndex: null };
      const rows = records(store.getState()); rows.set(remapped.document.id, next);
      enqueue(intent("save", next));
      publish(rows, [...store.getState().documents.map(value => value.id), remapped.document.id], store.getState().deletedGraphs.map(value => value.document.id));
      await persist(); await reloadRecord(id, sequence);
    } catch (error: unknown) { failure(error); }
    finally { resolving.delete(id); }
  };
  const importGuest = async (): Promise<void> => {
    if (!active() || importRunning) return;
    if (metadata.importAttempt === undefined && (metadata.queue.length > 0 || metadata.conflicts.length > 0 || pumping)) {
      feedback.setState({ importBlocked: true }); return;
    }
    importRunning = true;
    feedback.setState({ importing: true, importBlocked: false }); report("saving");
    try {
      await pumpFinished;
      if (!active()) return;
      // 新批次先重新捕获旧编辑；捕获曾失败的结构动作不能被导入越过。
      await persist();
      if (!active()) return;
      if (metadata.importAttempt === undefined && (metadata.queue.length > 0 || metadata.conflicts.length > 0)) {
        feedback.setState({ importBlocked: true }); return;
      }
      if (metadata.importAttempt === undefined) {
        const source = parseWorkspaceSnapshot(await options.loadGuest());
        if (!active()) return;
        const body = CloudWorkspaceImportRequestSchema.parse({ action: "import", importId: createId(),
          documents: (source?.documents ?? []).map(document => ({ document, history: storeGraphHistory(source?.histories?.[document.id] === undefined ? createGraphHistory(document) : restoreGraphHistory(source.histories[document.id], document, 100)) })),
          deletedGraphs: (source?.deletedGraphs ?? []).map(value => ({ document: value.document, history: storeGraphHistory(value.history), originalIndex: value.index })),
        });
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ documents: body.documents, deletedGraphs: body.deletedGraphs })));
        if (!active()) return;
        if (captureFailed) captureLocal(store.getState());
        if (metadata.queue.length > 0 || metadata.conflicts.length > 0) { feedback.setState({ importBlocked: true }); return; }
        const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
        if (metadata.importedFingerprints.includes(fingerprint)) {
          // 去重不等于云端读取已恢复；失联时保留明确失败/重试，不能停在虚假的saving。
          if (!ready || paused) throw new CloudWorkspaceError("WORKSPACE_UNAVAILABLE");
          return;
        }
        metadata.importAttempt = { body, fingerprint };
      }
      await persist(); if (!active()) return;
      const attempt = metadata.importAttempt;
      const remote = await request(() => api.import(options.userId, attempt.body, controller.signal));
      if (!active()) return;
      metadata.importedFingerprints.push(attempt.fingerprint); delete metadata.importAttempt;
      merge(remote); await persist(); ready = true; paused = false;
    } catch (error: unknown) { failure(error); }
    finally { importRunning = false; if (active()) { feedback.setState({ importing: false }); wake(); } }
  };
  const captureLocal = (state: WorkspaceStoreState): unknown => {
    try {
      const next = records(state);
      const changes: Intent[] = [], changedIds: string[] = [];
      if (!suppress && observed !== undefined) for (const [id, record] of next) {
        const previous = observed.get(id);
        let change: Intent | undefined;
        if (previous === undefined) change = intent(record.status === "active" ? "save" : "delete", record);
        else if (previous.status !== record.status) change = intent(record.status === "deleted" ? "delete" : "restore", record);
        else if (record.status === "active" && !same(previous, record)) change = intent("save", record);
        if (change !== undefined) { changes.push(change); changedIds.push(id); }
      }
      if (!suppress && observed !== undefined) for (const id of observed.keys()) if (!next.has(id)) changedIds.push(id);
      // 比较全部成功后才统一发布，避免后面图失败时重复入队前面图的删除/恢复。
      for (const change of changes) enqueue(change);
      for (const id of changedIds) localSequences.set(id, (localSequences.get(id) ?? 0) + 1);
      observed = next;
      if (metadata.queue.length > 0 && !paused) { report("saving"); wake(); }
      const captured = structuredClone(metadata);
      captureFailed = false;
      return captured;
    } catch (error: unknown) {
      captureFailed = true;
      failure(error);
      throw new CloudWorkspaceError("WORKSPACE_UNAVAILABLE");
    }
  };

  return {
    restore: (value: unknown, state: WorkspaceStoreState): void => { if (value !== undefined) metadata = parseMetadata(value); observed = records(state); },
    capture: captureLocal,
    metadata: (): unknown => structuredClone(metadata),
    start: (persistLocal: () => Promise<void>): void => {
      if (!active()) return;
      persist = persistLocal;
      feedback.setState({ status: "loading", conflicts: [...metadata.conflicts], importing: false, retry, reload, copy, importGuest });
      void retry();
    },
    stop: (): void => { stopped = true; controller.abort(); },
  };
}
