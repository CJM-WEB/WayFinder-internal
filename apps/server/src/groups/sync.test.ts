/**
 * 实时状态回归：首帧就绪、丢通知交接、绑定凭据、权限撤销、暂时失联与有限续接。
 * 只使用假会话／快照及受控时钟，不连接数据库或真实Provider；HTTP和SQL由独立集成检查覆盖。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupSyncEvent } from "@wayfinder/contracts";
import type { AccountIdentity } from "../accounts/auth.js";
import { databaseOperation } from "../accounts/database.js";
import { GroupAccessError } from "./errors.js";
import { createGroupSync, type GroupSyncSnapshot } from "./sync.js";

const identity: AccountIdentity = { userId: "owner", sessionId: "session", email: "fixture@example.test" };
const groupId = "fixture_group";
function snapshot(revision = 1): GroupSyncSnapshot {
  return { details: { group: { groupId, ownerUserId: identity.userId, name: "学习组", description: "", revision },
    members: [{ userId: identity.userId, nickname: "同学", role: "owner" }], invitationCode: null },
  workspace: { groupId, revision, activeOrder: [], deletedIds: [], graphs: [] } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
function frames() {
  const values: GroupSyncEvent[] = [], pending: GroupSyncEvent[] = [];
  let waiter: ((value: GroupSyncEvent) => void) | undefined;
  return {
    values,
    emit: async (event: GroupSyncEvent): Promise<void> => {
      values.push(event);
      if (waiter !== undefined) { const resolve = waiter; waiter = undefined; resolve(event); } else pending.push(event);
    },
    next: async (): Promise<GroupSyncEvent> => {
      const value = pending.shift();
      const result = value ?? await new Promise<GroupSyncEvent>(resolve => { waiter = resolve; });
      // 采集器的Promise先唤醒测试，随后run才能完成emit；等这一轮完成再检查ready。
      await Promise.resolve(); return result;
    },
  };
}
function fixture() {
  let current = snapshot(), account: AccountIdentity | null = identity, member = true, nextId = 0;
  const getIdentity = vi.fn(async () => account);
  const readSnapshot = vi.fn(async () => { if (!member) throw new GroupAccessError("GROUP_FORBIDDEN"); return current; });
  const sync = createGroupSync({ auth: { getIdentity }, readSnapshot, leaseMs: 100, heartbeatMs: 20,
    createId: () => `connection_${++nextId}` });
  return { sync, readSnapshot, getIdentity, setSnapshot: (value: GroupSyncSnapshot) => { current = value; },
    revokeSession: () => { account = null; }, revokeMember: () => { member = false; } };
}
afterEach(() => { vi.useRealTimers(); });

describe("有限期小组实时连接", () => {
  it("完整首帧后才ready，凭据绑定账号／会话／组，关闭取消已绑定短事务", async () => {
    vi.useFakeTimers(); const f = fixture(), out = frames();
    const subscription = await f.sync.open(identity, new Headers(), groupId, new AbortController().signal);
    expect(() => f.sync.authorize(identity, groupId, "connection_1", databaseOperation(new AbortController().signal))).toThrow("GROUP_OFFLINE");
    const running = subscription.run(out.emit);
    try {
      const event = await out.next();
      expect(event.type).toBe("snapshot"); expect(Object.keys(event).at(-1)).toBe("connectionId");
      const operation = f.sync.authorize(identity, groupId, "connection_1", databaseOperation(new AbortController().signal));
      for (const [otherIdentity, otherGroup, code] of [[{ ...identity, userId: "other" }, groupId, "connection_1"],
        [{ ...identity, sessionId: "other" }, groupId, "connection_1"], [identity, "other_group", "connection_1"],
        [identity, groupId, "missing"]] as const) {
        expect(() => f.sync.authorize(otherIdentity, otherGroup, code, operation)).toThrow("GROUP_OFFLINE");
      }
      subscription.close(); expect(operation.signal.aborted).toBe(true); await running;
    } finally { f.sync.close(); await running; }
  });

  it("首读进行时已登记订阅，读取期间提交的变化重新对齐后才输出", async () => {
    vi.useFakeTimers(); const f = fixture(), out = frames(), entered = deferred<void>(), release = deferred<GroupSyncSnapshot>();
    f.readSnapshot.mockImplementationOnce(async () => { entered.resolve(); return release.promise; });
    const opening = f.sync.open(identity, new Headers(), groupId, new AbortController().signal);
    await entered.promise; f.setSnapshot(snapshot(2)); f.sync.notifyGroup(groupId); release.resolve(snapshot(1));
    const subscription = await opening, running = subscription.run(out.emit);
    try {
      const event = await out.next(); expect(event.type === "snapshot" && event.workspace.revision).toBe(2);
      expect(f.readSnapshot.mock.calls.length).toBeGreaterThan(1);
    } finally { subscription.close(); await running; f.sync.close(); }
  });

  it("提交通知立即禁用未追平proof，重新输出最新快照后恢复，序号按连接递增", async () => {
    vi.useFakeTimers(); const f = fixture(), out = frames();
    const subscription = await f.sync.open(identity, new Headers(), groupId, new AbortController().signal), running = subscription.run(out.emit);
    try {
      await out.next(); f.setSnapshot(snapshot(2)); f.sync.notifyGroup(groupId);
      expect(() => f.sync.authorize(identity, groupId, "connection_1", databaseOperation(new AbortController().signal))).toThrow("GROUP_OFFLINE");
      const next = await out.next(); expect(next.type === "snapshot" && next.workspace.revision).toBe(2);
      expect(next.type !== "revoked" && next.sequence).toBe(1);
      expect(f.sync.authorize(identity, groupId, "connection_1", databaseOperation(new AbortController().signal)).signal.aborted).toBe(false);
    } finally { subscription.close(); await running; f.sync.close(); }
  });

  it("心跳期间持续核验成员，失效发revoked并取消短写", async () => {
    vi.useFakeTimers(); const f = fixture(), out = frames();
    const subscription = await f.sync.open(identity, new Headers(), groupId, new AbortController().signal), running = subscription.run(out.emit);
    try {
      await out.next();
      const operation = f.sync.authorize(identity, groupId, "connection_1", databaseOperation(new AbortController().signal));
      f.revokeMember(); await vi.advanceTimersByTimeAsync(20); await running;
      expect(out.values.at(-1)).toEqual({ type: "revoked", code: "GROUP_FORBIDDEN" });
      expect(operation.signal.aborted).toBe(true);
    } finally { f.sync.close(); await running; }
  });

  it("首次快照后的暂时数据库故障仅断流、不伪造撤权，新连接可重新恢复", async () => {
    vi.useFakeTimers(); const f = fixture(), out = frames();
    const subscription = await f.sync.open(identity, new Headers(), groupId, new AbortController().signal), running = subscription.run(out.emit);
    await out.next(); f.readSnapshot.mockRejectedValueOnce(new GroupAccessError("GROUP_UNAVAILABLE"));
    f.sync.notifyGroup(groupId); await running;
    expect(out.values.some(event => event.type === "revoked")).toBe(false);
    expect(subscription.signal.aborted).toBe(true);
    const recovered = await f.sync.open(identity, new Headers(), groupId, new AbortController().signal), next = frames(), rerun = recovered.run(next.emit);
    try {
      const event = await next.next(); expect(event.type === "snapshot" && event.connectionId).toBe("connection_2");
      expect(f.sync.authorize(identity, groupId, "connection_2", databaseOperation(new AbortController().signal)).signal.aborted).toBe(false);
    } finally { recovered.close(); f.sync.close(); await rerun; }
  });

  it.each(["session", "member"] as const)("背压中的%s撤销不等待写缓冲完成才关闭正文", async kind => {
    vi.useFakeTimers(); const f = fixture(), entered = deferred<void>(), completed: GroupSyncEvent[] = [];
    const subscription = await f.sync.open(identity, new Headers(), groupId, new AbortController().signal);
    const running = subscription.run(async (event, signal) => {
      if (event.type === "snapshot") {
        entered.resolve(); await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("fixture disconnected")), { once: true });
        });
      }
      completed.push(event);
    });
    try {
      await entered.promise;
      if (kind === "session") f.revokeSession(); else f.revokeMember();
      f.sync.notifyGroup(groupId); await running;
      expect(subscription.signal.aborted).toBe(true);
      expect(completed.some(event => event.type === "snapshot")).toBe(false);
      expect(completed.at(-1)).toEqual({ type: "revoked", code: kind === "session" ? "ACCOUNT_REQUIRED" : "GROUP_FORBIDDEN" });
    } finally { subscription.close(); f.sync.close(); await running; }
  });

  it("租期结束发送正常renew并释放旧proof，而不是无限保活同一连接", async () => {
    vi.useFakeTimers(); const f = fixture(), out = frames();
    const subscription = await f.sync.open(identity, new Headers(), groupId, new AbortController().signal), running = subscription.run(out.emit);
    try {
      await out.next(); await vi.advanceTimersByTimeAsync(101); await running;
      expect(out.values.at(-1)?.type).toBe("renew");
      expect(out.values.filter(event => event.type !== "revoked").map(event => event.sequence)).toEqual(out.values.map((_event, index) => index));
      expect(() => f.sync.authorize(identity, groupId, "connection_1", databaseOperation(new AbortController().signal))).toThrow("GROUP_OFFLINE");
    } finally { f.sync.close(); await running; }
  });

  it("原子快照版本不一致拒绝建连，已取消或已关闭runtime不得恢复旧连接", async () => {
    vi.useFakeTimers(); const f = fixture();
    f.setSnapshot({ ...snapshot(), workspace: { ...snapshot().workspace, revision: 2 } });
    await expect(f.sync.open(identity, new Headers(), groupId, new AbortController().signal)).rejects.toMatchObject({ code: "GROUP_UNAVAILABLE" });
    const controller = new AbortController(); controller.abort();
    await expect(f.sync.open(identity, new Headers(), groupId, controller.signal)).rejects.toMatchObject({ code: "GROUP_OFFLINE" });
    f.sync.close();
    await expect(f.sync.open(identity, new Headers(), groupId, new AbortController().signal)).rejects.toMatchObject({ code: "GROUP_OFFLINE" });
  });
});
