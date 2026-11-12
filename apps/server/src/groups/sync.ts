/**
 * 模块职责：在现有单实例上管理有限期NDJSON订阅、事务提交后通知和组图写入连接凭据。
 * 权限边界：连接标识只证明已完成首快照且连接仍活跃；真实会话及成员资格持续复核，事务仍独立鉴权。
 * 一致性：订阅先登记再读快照，读取期间通知标脏重读；不持有数据库事务等待网络或下一条消息。
 */
import { randomUUID } from "node:crypto";
import {
  GroupSyncEventSchema, UserIdSchema, type GroupDetails, type GroupErrorCode, type GroupSyncEvent, type GroupWorkspaceResponse,
} from "@wayfinder/contracts";
import type { AccountAuth, AccountIdentity } from "../accounts/auth.js";
import type { AccountDatabase, DatabaseOperation } from "../accounts/database.js";
import { GroupAccessError } from "./errors.js";
import { groupTransaction, loadMemberGroup, readGroupDetailsSnapshot } from "./storage.js";
import { readGroupWorkspaceSnapshot } from "./workspace-storage.js";

export type GroupSyncSnapshot = Readonly<{ details: GroupDetails; workspace: GroupWorkspaceResponse }>;
export type GroupSyncSubscription = Readonly<{
  signal: AbortSignal;
  run: (emit: (event: GroupSyncEvent, signal: AbortSignal) => Promise<void>) => Promise<void>;
  close: () => void;
}>;
export type GroupSyncRuntime = Readonly<{
  open: (identity: AccountIdentity, headers: Headers, groupId: string, signal: AbortSignal) => Promise<GroupSyncSubscription>;
  authorize: (identity: AccountIdentity, groupId: string, connectionId: string, operation: DatabaseOperation) => DatabaseOperation;
  notifyGroup: (groupId: string) => void;
  notifyUser: (userId: string) => void;
  close: () => void;
}>;
type Lease = {
  id: string; identity: AccountIdentity; headers: Headers; groupId: string; controller: AbortController;
  expiresAt: number; ready: boolean; dirty: boolean; sequence: number; renewed: boolean;
  revokedCode?: GroupErrorCode; probing?: Promise<void>; generation: number;
  wake?: () => void; timer?: ReturnType<typeof setTimeout>; detach?: () => void;
};

/** 详情与组图使用同一RR快照和同一个组版本；函数返回后事务立即释放。 */
export function readGroupSyncSnapshot(database: AccountDatabase, userId: string, groupId: string,
  operation: DatabaseOperation): Promise<GroupSyncSnapshot> {
  return groupTransaction(database, operation, async query => {
    const group = await loadMemberGroup(query, UserIdSchema.parse(userId), UserIdSchema.parse(groupId), false);
    const details = await readGroupDetailsSnapshot(query, userId, group);
    const workspace = await readGroupWorkspaceSnapshot(query, group);
    return { details, workspace };
  }, true);
}

/** 未变化心跳与独立权限探测只读取当前成员／详情／组版本，不加载或重放整组图历史。 */
export function readGroupSyncDetails(database: AccountDatabase, userId: string, groupId: string,
  operation: DatabaseOperation): Promise<GroupDetails> {
  return groupTransaction(database, operation, async query => {
    const group = await loadMemberGroup(query, UserIdSchema.parse(userId), UserIdSchema.parse(groupId), false);
    return readGroupDetailsSnapshot(query, userId, group);
  }, true);
}

export function createGroupSync(options: Readonly<{
  auth: Pick<AccountAuth, "getIdentity">;
  readSnapshot: (userId: string, groupId: string, operation: DatabaseOperation) => Promise<GroupSyncSnapshot>;
  readDetails?: (userId: string, groupId: string, operation: DatabaseOperation) => Promise<GroupDetails>;
  leaseMs?: number; heartbeatMs?: number; createId?: () => string;
}>): GroupSyncRuntime {
  const leaseMs = options.leaseMs ?? 30_000, heartbeatMs = options.heartbeatMs ?? 2_000;
  if (!Number.isFinite(leaseMs) || !Number.isFinite(heartbeatMs) || heartbeatMs <= 0 || leaseMs <= heartbeatMs) throw new GroupAccessError("GROUP_UNAVAILABLE");
  const leases = new Map<string, Lease>();
  const revokedCode = (error: unknown): GroupErrorCode | undefined => error instanceof GroupAccessError
    && ["ACCOUNT_REQUIRED", "GROUP_FORBIDDEN", "GROUP_NOT_FOUND"].includes(error.code) ? error.code : undefined;
  let stopped = false;
  const closeLease = (lease: Lease, renewed = false): void => {
    if (lease.controller.signal.aborted) return;
    lease.ready = false; lease.renewed = renewed;
    leases.delete(lease.id); clearTimeout(lease.timer); lease.detach?.();
    // 所有绑定此连接的短写事务同时收到取消；已提交但回执丢失仍通过本人receipt查回。
    lease.controller.abort(); lease.wake?.();
  };
  const operationFor = (lease: Lease): DatabaseOperation => {
    if (lease.controller.signal.aborted || Date.now() >= lease.expiresAt) throw new GroupAccessError("GROUP_OFFLINE");
    return { signal: lease.controller.signal, deadline: Math.min(Date.now() + 5_000, lease.expiresAt) };
  };
  const recheck = async (lease: Lease, operation: DatabaseOperation): Promise<void> => {
    const identity = await options.auth.getIdentity(lease.headers, operation);
    if (identity === null || identity.userId !== lease.identity.userId || identity.sessionId !== lease.identity.sessionId) throw new GroupAccessError("ACCOUNT_REQUIRED");
    operationFor(lease);
  };
  const markDirty = (lease: Lease): void => {
    lease.ready = false; lease.dirty = true; lease.generation++; lease.wake?.();
    // 背压中的旧快照不能阻塞权限撤销；独立复核成员／会话，失效即取消连接、正文输出和短写。
    if (lease.probing === undefined && !lease.controller.signal.aborted) {
      lease.probing = (async () => {
        try {
          for (;;) {
            const generation = lease.generation, operation = operationFor(lease);
            await recheck(lease, operation);
            // 背压时仍独立核验权限，但不用为权限探测再加载一遍即将由主循环读取的大快照。
            if (options.readDetails === undefined) await options.readSnapshot(lease.identity.userId, lease.groupId, operation);
            else await options.readDetails(lease.identity.userId, lease.groupId, operation);
            await recheck(lease, operation);
            if (generation === lease.generation) break;
          }
        } catch (error: unknown) {
          if (!lease.controller.signal.aborted) {
            // 暂时数据库或连接失败只是失联；只有明确身份／成员失效才能清除用户的组内容。
            const code = revokedCode(error);
            if (code !== undefined) lease.revokedCode = code;
            closeLease(lease);
          }
        } finally { delete lease.probing; }
      })();
    }
  };
  const readVerified = async (lease: Lease): Promise<GroupSyncSnapshot> => {
    for (;;) {
      lease.dirty = false;
      const operation = operationFor(lease);
      await recheck(lease, operation);
      const snapshot = await options.readSnapshot(lease.identity.userId, lease.groupId, operation);
      await recheck(lease, operation);
      if (snapshot.details.group.groupId !== lease.groupId || snapshot.workspace.groupId !== lease.groupId
        || snapshot.details.group.revision !== snapshot.workspace.revision) throw new GroupAccessError("GROUP_UNAVAILABLE");
      // 等待读取时到达的提交通知不能被覆盖；先重新对齐再输出，不漏掉快照交接中的写入。
      if (!lease.dirty) return snapshot;
    }
  };
  const waitForChange = async (lease: Lease): Promise<void> => {
    if (lease.dirty || lease.controller.signal.aborted) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => wake(), heartbeatMs);
      const wake = (): void => { clearTimeout(timer); delete lease.wake; resolve(); };
      lease.wake = wake;
      if (lease.dirty || lease.controller.signal.aborted) wake();
    });
  };
  return {
    async open(identity, headers, inputGroupId, signal) {
      if (stopped || signal.aborted) throw new GroupAccessError("GROUP_OFFLINE");
      const id = UserIdSchema.parse(options.createId?.() ?? randomUUID());
      if (leases.has(id)) throw new GroupAccessError("GROUP_UNAVAILABLE");
      const lease: Lease = { id, identity, headers: new Headers(headers), groupId: UserIdSchema.parse(inputGroupId),
        controller: new AbortController(), expiresAt: Date.now() + leaseMs, ready: false, dirty: false, sequence: 0, renewed: false, generation: 0 };
      leases.set(id, lease);
      const abort = (): void => closeLease(lease);
      signal.addEventListener("abort", abort, { once: true }); lease.detach = () => signal.removeEventListener("abort", abort);
      lease.timer = setTimeout(() => closeLease(lease, true), leaseMs);
      let initial: GroupSyncSnapshot;
      try { initial = await readVerified(lease); }
      catch (error: unknown) { closeLease(lease); if (lease.revokedCode !== undefined) throw new GroupAccessError(lease.revokedCode); throw error; }
      return {
        signal: lease.controller.signal,
        close: () => closeLease(lease),
        async run(emit) {
          let snapshot: GroupSyncSnapshot | null = initial, previousSignature: string | null = null;
          try {
            while (!lease.controller.signal.aborted) {
              let unchanged = false;
              if (snapshot === null && !lease.dirty && options.readDetails !== undefined) {
                const operation = operationFor(lease);
                await recheck(lease, operation);
                const details = await options.readDetails(lease.identity.userId, lease.groupId, operation);
                await recheck(lease, operation);
                if (details.group.groupId !== lease.groupId) throw new GroupAccessError("GROUP_UNAVAILABLE");
                // 组版本及成员／昵称每次从新事务读取；漏通知、资料变化和版本变化都必须重新读取完整快照。
                unchanged = !lease.dirty && `${JSON.stringify(details)}:${details.group.revision}` === previousSignature;
              }
              if (!unchanged && (snapshot === null || lease.dirty)) snapshot = await readVerified(lease);
              await recheck(lease, operationFor(lease));
              if (lease.dirty) { snapshot = null; continue; }
              const signature: string | null = snapshot === null ? previousSignature : `${JSON.stringify(snapshot.details)}:${snapshot.workspace.revision}`;
              if (signature !== previousSignature) {
                if (snapshot === null) throw new GroupAccessError("GROUP_UNAVAILABLE");
                // connectionId有意位于完整快照末尾，首帧尚未写完前连接不能被用于写入证明。
                await emit(GroupSyncEventSchema.parse({ type: "snapshot", sequence: lease.sequence++, details: snapshot.details,
                  workspace: snapshot.workspace, connectionId: lease.id }), lease.controller.signal);
                previousSignature = signature;
              } else await emit(GroupSyncEventSchema.parse({ type: "heartbeat", sequence: lease.sequence++ }), lease.controller.signal);
              if (!lease.controller.signal.aborted && !lease.dirty) lease.ready = true;
              snapshot = null;
              await waitForChange(lease);
            }
          } catch (error: unknown) {
            if (!lease.controller.signal.aborted) {
              closeLease(lease);
              const code = revokedCode(error);
              if (code !== undefined) lease.revokedCode = code;
            }
          } finally {
            const renewed = lease.renewed;
            closeLease(lease);
            if (lease.revokedCode !== undefined) await emit(GroupSyncEventSchema.parse({ type: "revoked", code: lease.revokedCode }), lease.controller.signal);
            else if (renewed) await emit(GroupSyncEventSchema.parse({ type: "renew", sequence: lease.sequence++ }), lease.controller.signal);
          }
        },
      };
    },
    authorize(identity, groupId, connectionId, operation) {
      const lease = leases.get(connectionId);
      if (lease === undefined || !lease.ready || lease.controller.signal.aborted || Date.now() >= lease.expiresAt
        || lease.identity.userId !== identity.userId || lease.identity.sessionId !== identity.sessionId || lease.groupId !== groupId) throw new GroupAccessError("GROUP_OFFLINE");
      return { signal: AbortSignal.any([operation.signal, lease.controller.signal]), deadline: Math.min(operation.deadline, lease.expiresAt) };
    },
    notifyGroup: groupId => { for (const lease of leases.values()) if (lease.groupId === groupId) markDirty(lease); },
    // 统一昵称影响该成员所在组的全部观察者；小规模单实例仅刷新现有订阅，不外泄成员关系。
    notifyUser: () => { for (const lease of leases.values()) markDirty(lease); },
    close: () => { stopped = true; for (const lease of [...leases.values()]) closeLease(lease); },
  };
}
