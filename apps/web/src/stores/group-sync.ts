/**
 * 单个小组的在线生命周期：完整快照追平后放行，失联立即撤销写权限。
 * 每次上下文切换取消旧流及短写请求；仅重建读取连接，绝不重放用户动作。
 */
import { createStore } from "zustand/vanilla";
import type { GroupAction, GroupConnectionState, GroupDetails, GroupGraphAction, GroupGraphReceiptResponse, GroupSyncEvent, GroupWorkspaceResponse } from "@wayfinder/contracts";
import { awaitGroupOperation, groupApi, GroupRequestError, type GroupApi } from "../api/groups.js";

type SyncSnapshot = { details: GroupDetails; workspace: GroupWorkspaceResponse };
export type GroupSyncState = {
  userId: string | null; groupId: string | null; state: GroupConnectionState; snapshot: SyncSnapshot | null;
  connectionId: string | null; error: string | null; lastReceipt: GroupGraphReceiptResponse | null;
};
const revoked = (code: string): boolean => ["ACCOUNT_REQUIRED", "GROUP_FORBIDDEN", "GROUP_NOT_FOUND"].includes(code);
export function createGroupSync(api: GroupApi = groupApi, timing: Readonly<{
  heartbeatMs?: number; leaseMs?: number; retryMs?: number; maxFailures?: number; recoveryMs?: number;
}> = {}) {
  const heartbeatMs = timing.heartbeatMs ?? 6_000, leaseMs = timing.leaseMs ?? 35_000;
  const retryMs = timing.retryMs ?? 250, maxFailures = timing.maxFailures ?? 3, recoveryMs = timing.recoveryMs ?? 40_000;
  let writableUntil = 0;
  let epoch = 0, lifetime: AbortController | undefined, connection: AbortController | undefined;
  const store = createStore<GroupSyncState>()(() => ({ userId: null, groupId: null, state: "closed", snapshot: null,
    connectionId: null, error: null, lastReceipt: null }));
  const stop = (clear: boolean): void => {
    ++epoch; writableUntil = 0; lifetime?.abort(); connection?.abort(); lifetime = undefined; connection = undefined;
    store.setState({ state: clear ? "closed" : "offline", connectionId: null, ...(clear ? { userId: null, groupId: null, snapshot: null, lastReceipt: null, error: null } : {}) });
  };
  /** 搜索等同源动作遇到明确连接拒绝时共用撤权；迟到旧证明不能关闭新连接。 */
  const rejectConnection = (code: string, expectedConnectionId: string): void => {
    if (store.getState().connectionId !== expectedConnectionId) return;
    if (revoked(code)) { stop(true); store.setState({ error: code }); }
    else if (["GROUP_UNAVAILABLE", "GROUP_OFFLINE"].includes(code)) {
      store.setState({ state: "offline", connectionId: null, error: code }); connection?.abort();
    }
  };
  const connect = (userId: string, groupId: string): void => {
    const previous = store.getState();
    const sameContext = previous.userId === userId && previous.groupId === groupId;
    const retained = sameContext ? previous.snapshot : null;
    // 同组手动重连只撤销写权限，不能经临时空身份误清已完成的搜索预览。
    stop(!sameContext); const current = epoch; lifetime = new AbortController(); const active = lifetime;
    store.setState({ userId, groupId, state: "connecting", snapshot: retained, error: null });
    const run = async (): Promise<void> => {
      let failures = 0, failedAt: number | null = null;
      while (current === epoch && !active.signal.aborted) {
        connection = new AbortController(); const attempt = connection;
        const attemptExpires = Date.now() + Math.min(leaseMs, failedAt === null ? leaseMs : Math.max(1, recoveryMs - (Date.now() - failedAt)));
        const signal = AbortSignal.any([active.signal, attempt.signal, AbortSignal.timeout(Math.max(1, attemptExpires - Date.now()))]);
        const attemptStartedAt = Date.now();
        let liveMessageCount = 0;
        let sequence = -1, connectionId: string | null = null, renewed = false, terminal = false;
        let heartbeat: ReturnType<typeof setTimeout> | undefined;
        let validUntil = Date.now() + heartbeatMs;
        const arm = (): void => {
          clearTimeout(heartbeat); validUntil = Date.now() + heartbeatMs;
          writableUntil = Math.min(validUntil, attemptExpires);
          heartbeat = setTimeout(() => {
            if (current === epoch) store.setState({ state: "offline", connectionId: null, error: "GROUP_OFFLINE" });
            attempt.abort();
          }, heartbeatMs);
        };
        store.setState({ state: failures > 0 ? "reconnecting" : "syncing", connectionId: null }); arm();
        const fail = (): never => {
          store.setState({ state: "offline", connectionId: null, error: "GROUP_OFFLINE" }); attempt.abort();
          throw new GroupRequestError("GROUP_OFFLINE");
        };
        const receive = (event: GroupSyncEvent): void => {
          if (current !== epoch || signal.aborted) return;
          // 同步解析可能阻塞计时器，绝对心跳期限仍必须先于任何恢复在线的回调检查。
          if (Date.now() >= validUntil || Date.now() >= attemptExpires) fail();
          if (event.type === "revoked") {
            terminal = revoked(event.code);
            store.setState({ state: terminal ? "closed" : "offline", connectionId: null, error: event.code,
              ...(terminal ? { snapshot: null } : {}) }); attempt.abort(); return;
          }
          if (event.sequence <= sequence) return; // 重复和迟到消息不能刷新存活期限。
          if (event.type !== "snapshot" && (connectionId === null || event.sequence !== sequence + 1)) {
            fail();
          }
          if (event.type === "snapshot") {
            if (connectionId !== null && event.connectionId !== connectionId) fail();
            const known = store.getState().snapshot;
            if (known !== null && event.workspace.revision < known.workspace.revision) fail();
            connectionId = event.connectionId;
            store.setState({ snapshot: { details: event.details, workspace: event.workspace }, connectionId, state: "online", error: null });
          }
          if (event.type === "heartbeat" || event.type === "snapshot" && sequence >= 0) ++liveMessageCount;
          sequence = event.sequence; arm();
          if (event.type === "renew") {
            // 只有持续收到有效消息的正常租期才结束一次故障恢复预算；snapshot→EOF不能重置重试次数。
            if (liveMessageCount < 2 || Date.now() - attemptStartedAt < heartbeatMs * 2) fail();
            renewed = true; store.setState({ state: "syncing", connectionId: null }); attempt.abort();
          }
        };
        try {
          await api.stream(userId, groupId, signal, receive);
        } catch (error: unknown) {
          if (current !== epoch || active.signal.aborted) return;
          const code = error instanceof GroupRequestError ? error.code : "GROUP_UNAVAILABLE";
          if (revoked(code)) { terminal = true; store.setState({ snapshot: null, error: code }); }
        } finally { clearTimeout(heartbeat); }
        if (current !== epoch || active.signal.aborted) return;
        store.setState({ state: terminal ? "closed" : "offline", connectionId: null }); attempt.abort();
        if (terminal) return;
        if (renewed) { failures = 0; failedAt = null; continue; } // 有限租期正常换接；异常EOF不能进入本分支。
        ++failures; failedAt ??= Date.now();
        store.setState({ error: "GROUP_OFFLINE" });
        if (failures >= maxFailures || Date.now() - failedAt >= recoveryMs) return;
        const remaining = recoveryMs - (Date.now() - failedAt);
        try {
          await awaitGroupOperation(new Promise<void>(resolve => {
            const timer = setTimeout(resolve, Math.min(retryMs * failures, remaining));
            active.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
          }), active.signal);
        } catch { return; }
        if (Date.now() - failedAt >= recoveryMs) return;
      }
    };
    void run();
  };
  /** 现有组管理与图动作共享在线门禁；组图确认丢失才查询专用收据。 */
  const send = async <T>(groupId: string, execute: (userId: string, connectionId: string, signal: AbortSignal) => Promise<T>, mutationId?: string): Promise<T> => {
    const state = store.getState(), current = epoch, lease = connection;
    if (Date.now() >= writableUntil || state.state !== "online" || state.connectionId === null || state.userId === null || state.groupId !== groupId || lease === undefined || lease.signal.aborted) {
      throw new GroupRequestError("GROUP_OFFLINE");
    }
    try {
      const result = await execute(state.userId, state.connectionId, lease.signal);
      if (current !== epoch) throw new GroupRequestError("ACCOUNT_REQUIRED");
      return result;
    }
    catch (error: unknown) {
      const code = error instanceof GroupRequestError ? error.code : "GROUP_UNAVAILABLE";
      if (current === epoch && connection === lease) rejectConnection(code, state.connectionId);
      // 确认丢失仅查询原mutationId；不换ID、不重放。收据不返回组内容，也不恢复写权限。
      if (mutationId !== undefined && ["GROUP_UNAVAILABLE", "GROUP_OFFLINE"].includes(code)) {
        try {
          const receipt = await api.receipt(state.userId, mutationId, AbortSignal.timeout(10_000));
          if (current === epoch) store.setState({ lastReceipt: receipt });
        } catch { /* 原动作结果仍未知，保留原错误供界面提示手动检查。 */ }
      }
      throw error;
    }
  };
  return {
    store, connect, rejectConnection,
    disconnect: (): void => stop(true),
    /** 浏览器失联只作提前禁写；恢复网络仍须重新鉴权和取得快照。 */
    setNetworkOnline: (online: boolean): void => {
      const { userId, groupId } = store.getState();
      if (!online) stop(false); else if (userId !== null && groupId !== null) connect(userId, groupId);
    },
    write: (input: GroupGraphAction) => send(input.groupId, (userId, connectionId, signal) => api.write(userId, input, connectionId, signal), input.mutationId),
    manage: (input: Exclude<GroupAction, { action: "create" | "join" }>) => send(input.groupId,
      (userId, connectionId, signal) => api.manage(userId, input, signal, connectionId)),
  };
}
export const groupSync = createGroupSync();
