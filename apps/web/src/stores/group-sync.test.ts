/** 同步状态回归：先追平再写、失联撤权、无动作重放、旧上下文隔离。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupSyncEvent } from "@wayfinder/contracts";
import { awaitGroupOperation, createGroupApi, GroupRequestError } from "../api/groups.js";
import { syncFixture } from "../testing/group-fixture.js";
import { createGroupSync } from "./group-sync.js";
const flush = async () => { for (let i = 0; i < 15; ++i) await Promise.resolve(); };
function setup(timing: Parameters<typeof createGroupSync>[1] = {}) {
  const attempts: { event: (value: GroupSyncEvent) => void; end: () => void; signal: AbortSignal }[] = [];
  const stream = vi.fn<ReturnType<typeof createGroupApi>["stream"]>((_user, _group, signal, event) => {
    let end = () => {}; const pending = new Promise<void>(resolve => { end = resolve; }); attempts.push({ event, signal, end });
    return awaitGroupOperation(pending, signal);
  });
  const api = { ...createGroupApi(), stream, write: vi.fn<ReturnType<typeof createGroupApi>["write"]>(),
    receipt: vi.fn<ReturnType<typeof createGroupApi>["receipt"]>().mockResolvedValue({ mutationId: "mutation", applied: true, groupId: "group-fixture", graphId: "graph", personalGraphId: null }) };
  return { attempts, api, sync: createGroupSync(api, { heartbeatMs: 100, leaseMs: 1000, retryMs: 10, recoveryMs: 200, maxFailures: 3, ...timing }) };
}
const action = { action: "delete" as const, groupId: "group-fixture", graphId: "graph", expectedRevision: 1, mutationId: "mutation" };
afterEach(() => vi.useRealTimers());
describe("小组实时生命周期", () => {
  it("编辑HTTP确认先到时保留原流并短暂禁写，推送追平再放行，不制造重连", async () => {
    const { sync, attempts, api } = setup(); sync.connect("user-fixture", "group-fixture"); attempts[0]!.event(syncFixture());
    api.write.mockResolvedValue({ workspace: syncFixture(1, 2).workspace });
    await sync.write(action);
    expect(sync.store.getState().state).toBe("syncing"); expect(sync.store.getState().snapshot?.workspace.revision).toBe(1);
    await expect(sync.write(action)).rejects.toThrow("GROUP_OFFLINE");
    expect(api.write).toHaveBeenCalledTimes(1); expect(attempts).toHaveLength(1); expect(attempts[0]!.signal.aborted).toBe(false);
    attempts[0]!.event(syncFixture(1, 2)); expect(sync.store.getState().state).toBe("online");
    await sync.write(action); expect(api.write).toHaveBeenCalledTimes(2); sync.disconnect();
  });
  it("推送已先于HTTP追平时不重新禁写，较旧ACK不能把最新快照降级", async () => {
    const { sync, attempts, api } = setup(); sync.connect("user-fixture", "group-fixture"); attempts[0]!.event(syncFixture());
    api.write.mockImplementation(async () => { attempts[0]!.event(syncFixture(1, 3)); return { workspace: syncFixture(1, 2).workspace }; });
    await sync.write(action); expect(sync.store.getState().state).toBe("online");
    expect(sync.store.getState().snapshot?.workspace.revision).toBe(3); expect(attempts).toHaveLength(1); sync.disconnect();
  });
  it("确认版本3后收到在途版本2和心跳仍禁写，只有权威版本3才恢复", async () => {
    const { sync, attempts, api } = setup(); sync.connect("user-fixture", "group-fixture"); attempts[0]!.event(syncFixture());
    api.write.mockResolvedValue({ workspace: syncFixture(2, 3).workspace }); await sync.write(action);
    attempts[0]!.event(syncFixture(1, 2)); attempts[0]!.event({ type: "heartbeat", sequence: 2 });
    expect(sync.store.getState().state).toBe("syncing"); expect(sync.store.getState().snapshot?.workspace.revision).toBe(2);
    await expect(sync.write(action)).rejects.toThrow("GROUP_OFFLINE"); expect(api.write).toHaveBeenCalledTimes(1);
    expect(attempts[0]!.signal.aborted).toBe(false); expect(attempts).toHaveLength(1);
    attempts[0]!.event(syncFixture(3, 3)); expect(sync.store.getState().state).toBe("online"); sync.disconnect();
  });
  it("send完成到write恢复之间切组，旧HTTP确认不能把新组改为正在对齐", async () => {
    const { sync, attempts, api } = setup(); sync.connect("user-fixture", "group-fixture"); attempts[0]!.event(syncFixture());
    let resolveWrite!: (value: Awaited<ReturnType<typeof api.write>>) => void;
    api.write.mockImplementation(() => new Promise(resolve => { resolveWrite = resolve; }));
    const pending = sync.write(action);
    resolveWrite({ workspace: syncFixture(1, 2).workspace });
    // send自己的epoch检查先运行，切组随后发生，最后才恢复外层write这个新增await边界。
    queueMicrotask(() => {
      sync.connect("user-fixture", "another-group");
      const next = syncFixture();
      attempts[1]!.event({ ...next, connectionId: "another-connection", details: { ...next.details,
        group: { ...next.details.group, groupId: "another-group" } }, workspace: { ...next.workspace, groupId: "another-group" } });
    });
    await pending;
    expect(sync.store.getState()).toMatchObject({ groupId: "another-group", state: "online", connectionId: "another-connection" });
    sync.disconnect();
  });
  it("完整快照之前拒写，心跳丢失立即取消写权限，重连追平后恢复", async () => {
    vi.useFakeTimers(); const { sync, attempts, api } = setup(); sync.connect("user-fixture", "group-fixture");
    await expect(sync.write(action)).rejects.toThrow("GROUP_OFFLINE"); expect(api.write).not.toHaveBeenCalled();
    attempts[0]!.event(syncFixture()); expect(sync.store.getState().state).toBe("online");
    await vi.advanceTimersByTimeAsync(100); expect(sync.store.getState().connectionId).toBeNull();
    await expect(sync.write(action)).rejects.toThrow("GROUP_OFFLINE");
    await vi.advanceTimersByTimeAsync(10); attempts[1]!.event(syncFixture(0, 2)); expect(sync.store.getState().state).toBe("online");
    sync.disconnect();
  });
  it("重复消息不续命；缺口心跳禁写，完整新快照可对齐序号缺口", async () => {
    vi.useFakeTimers(); const { sync, attempts } = setup(); sync.connect("user-fixture", "group-fixture"); attempts[0]!.event(syncFixture());
    await vi.advanceTimersByTimeAsync(90); attempts[0]!.event(syncFixture()); await vi.advanceTimersByTimeAsync(10);
    expect(sync.store.getState().state).not.toBe("online"); await vi.advanceTimersByTimeAsync(10);
    attempts[1]!.event(syncFixture()); attempts[1]!.event(syncFixture(5, 2)); expect(sync.store.getState().snapshot?.workspace.revision).toBe(2);
    expect(() => attempts[1]!.event({ type: "heartbeat", sequence: 7 })).toThrow("GROUP_OFFLINE"); sync.disconnect();
  });
  it("正常续租重新追平；异常EOF最多三次，不当正常续租无限循环", async () => {
    vi.useFakeTimers(); const { sync, attempts } = setup(); sync.connect("user-fixture", "group-fixture"); attempts[0]!.event(syncFixture());
    await vi.advanceTimersByTimeAsync(90); attempts[0]!.event({ type: "heartbeat", sequence: 1 });
    await vi.advanceTimersByTimeAsync(90); attempts[0]!.event({ type: "heartbeat", sequence: 2 });
    await vi.advanceTimersByTimeAsync(30); attempts[0]!.event({ type: "renew", sequence: 3 }); await flush(); expect(attempts).toHaveLength(2); expect(sync.store.getState().connectionId).toBeNull();
    attempts[1]!.end(); await flush(); await vi.advanceTimersByTimeAsync(10); attempts[2]!.end(); await flush();
    await vi.advanceTimersByTimeAsync(20); attempts[3]!.end(); await flush(); await vi.advanceTimersByTimeAsync(2000);
    expect(attempts).toHaveLength(4); expect(sync.store.getState().state).toBe("offline"); sync.disconnect();
  });

  it("故障后健康续租结束旧恢复预算；明确拒绝连接后不再发送第二次写入", async () => {
    vi.useFakeTimers(); const { sync, attempts, api } = setup({ leaseMs: 350, recoveryMs: 400 });
    sync.connect("user-fixture", "group-fixture"); attempts[0]!.end(); await flush(); await vi.advanceTimersByTimeAsync(10);
    attempts[1]!.event(syncFixture());
    for (let i = 1; i <= 3; ++i) { await vi.advanceTimersByTimeAsync(90); attempts[1]!.event({ type: "heartbeat", sequence: i }); }
    attempts[1]!.event({ type: "renew", sequence: 4 }); await flush(); attempts[2]!.event(syncFixture());
    for (let i = 1; i <= 2; ++i) { await vi.advanceTimersByTimeAsync(90); attempts[2]!.event({ type: "heartbeat", sequence: i }); }
    expect(sync.store.getState().state).toBe("online");
    api.write.mockRejectedValue(new GroupRequestError("GROUP_OFFLINE")); await expect(sync.write(action)).rejects.toThrow("GROUP_OFFLINE");
    await expect(sync.write(action)).rejects.toThrow("GROUP_OFFLINE"); expect(api.write).toHaveBeenCalledTimes(1);
    expect(sync.store.getState().connectionId).toBeNull(); sync.disconnect();
  });

  it("旧连接迟到的拒绝不能撤销已经追平的新连接", async () => {
    vi.useFakeTimers(); const { sync, attempts, api } = setup(); sync.connect("user-fixture", "group-fixture"); attempts[0]!.event(syncFixture());
    let rejectWrite: (error: unknown) => void = () => {};
    api.write.mockImplementation(() => new Promise((_resolve, reject) => { rejectWrite = reject; }));
    const pending = sync.write(action), rejected = expect(pending).rejects.toThrow("GROUP_OFFLINE");
    for (let i = 1; i <= 3; ++i) { await vi.advanceTimersByTimeAsync(90); attempts[0]!.event({ type: "heartbeat", sequence: i }); }
    attempts[0]!.event({ type: "renew", sequence: 4 }); await flush(); attempts[1]!.event(syncFixture());
    rejectWrite(new GroupRequestError("GROUP_OFFLINE")); await rejected;
    expect(sync.store.getState().state).toBe("online"); expect(attempts[1]!.signal.aborted).toBe(false); sync.disconnect();
  });

  it("持续编辑的快照流也能健康续租；临时服务故障保留只读并重新追平", async () => {
    vi.useFakeTimers(); const { sync, attempts } = setup({ recoveryMs: 400 }); sync.connect("user-fixture", "group-fixture"); attempts[0]!.event(syncFixture());
    for (let i = 1; i <= 3; ++i) { await vi.advanceTimersByTimeAsync(90); attempts[0]!.event(syncFixture(i, i + 1)); }
    attempts[0]!.event({ type: "renew", sequence: 4 }); await flush(); expect(attempts).toHaveLength(2);
    attempts[1]!.event(syncFixture(0, 4)); attempts[1]!.event({ type: "revoked", code: "GROUP_UNAVAILABLE" }); await flush();
    expect(sync.store.getState()).toMatchObject({ state: "offline", connectionId: null }); expect(sync.store.getState().snapshot).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10); attempts[2]!.event(syncFixture(0, 5)); expect(sync.store.getState().state).toBe("online"); sync.disconnect();
  });

  it("既有组管理也需追平连接；首次创建和加入由独立HTTP完成", async () => {
    const { sync, attempts, api } = setup(), manage = vi.spyOn(api, "manage").mockResolvedValue({ groups: [], details: null });
    const input = { action: "update" as const, groupId: "group-fixture", name: "新组名", description: "", expectedRevision: 1, mutationId: "manage" };
    sync.connect("user-fixture", "group-fixture"); await expect(sync.manage(input)).rejects.toThrow("GROUP_OFFLINE"); expect(manage).not.toHaveBeenCalled();
    attempts[0]!.event(syncFixture()); await sync.manage(input); expect(manage).toHaveBeenCalledWith("user-fixture", input, expect.any(AbortSignal), "connection-fixture");
    sync.setNetworkOnline(false); await expect(sync.manage(input)).rejects.toThrow("GROUP_OFFLINE"); expect(manage).toHaveBeenCalledTimes(1); sync.disconnect();
  });
  it("已知浏览器离线时进入组零连接；恢复网络须先取得新快照", async () => {
    const { sync, attempts, api } = setup(); sync.setNetworkOnline(false); sync.connect("user-fixture", "group-fixture");
    expect(attempts).toHaveLength(0); expect(sync.store.getState().state).toBe("offline");
    await expect(sync.write(action)).rejects.toThrow("GROUP_OFFLINE"); expect(api.write).not.toHaveBeenCalled();
    sync.setNetworkOnline(true); expect(attempts).toHaveLength(1); expect(sync.store.getState().state).not.toBe("online");
    attempts[0]!.event(syncFixture()); expect(sync.store.getState().state).toBe("online"); sync.disconnect();
  });
  it("换号和撤销资格清空旧数据，迟到回调不能恢复权限", () => {
    const { sync, attempts } = setup(); sync.connect("user-fixture", "group-fixture"); attempts[0]!.event(syncFixture());
    sync.connect("other-user", "other-group"); attempts[0]!.event(syncFixture(1, 2)); expect(sync.store.getState().snapshot).toBeNull();
    attempts[1]!.event({ type: "revoked", code: "GROUP_FORBIDDEN" }); expect(sync.store.getState()).toMatchObject({ state: "closed", snapshot: null, connectionId: null });
    sync.disconnect();
  });
  it("确认丢失只查原操作收据，绝不自动重放；浏览器离线同步禁写", async () => {
    const { sync, attempts, api } = setup(); sync.connect("user-fixture", "group-fixture"); attempts[0]!.event(syncFixture());
    api.write.mockRejectedValue(new GroupRequestError()); await expect(sync.write(action)).rejects.toThrow("GROUP_UNAVAILABLE");
    expect(sync.store.getState().state).toBe("offline");
    expect(api.write).toHaveBeenCalledTimes(1); expect(api.receipt).toHaveBeenCalledWith("user-fixture", "mutation", expect.any(AbortSignal));
    expect(sync.store.getState().lastReceipt?.applied).toBe(true); sync.setNetworkOnline(false);
    await expect(sync.write(action)).rejects.toThrow("GROUP_OFFLINE"); expect(sync.store.getState().snapshot).not.toBeNull(); sync.disconnect();
  });
});
