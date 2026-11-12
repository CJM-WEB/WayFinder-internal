/** NDJSON路由只使用假订阅，验证初始化拒绝、字段顺序、流式响应与服务关闭清理。 */
import { describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { CLOUD_ACCOUNT_HEADER, GroupSyncEventSchema } from "@wayfinder/contracts";
import { buildServer } from "../app.js";
import { GroupAccessError } from "../groups/errors.js";
import type { GroupSyncRuntime } from "../groups/sync.js";
import { registerGroupSyncRoutes } from "./group-sync.js";

const identity = { userId: "fixture_owner", sessionId: "fixture_session", email: "fixture@example.test" };
const groupId = "fixture_group", origin = "https://group.example";
const headers = { origin, host: "group.example", [CLOUD_ACCOUNT_HEADER]: identity.userId };
const snapshot = GroupSyncEventSchema.parse({ type: "snapshot", sequence: 0,
  details: { group: { groupId, ownerUserId: identity.userId, name: "学习组", description: "", revision: 1 },
    members: [{ userId: identity.userId, nickname: "同学", role: "owner" }], invitationCode: null },
  workspace: { groupId, revision: 1, activeOrder: [], deletedIds: [], graphs: [] }, connectionId: "fixture_connection" });
function fixture() {
  const server = buildServer(), getIdentity = vi.fn(async () => identity as typeof identity | null), controller = new AbortController();
  const closeSubscription = vi.fn(() => controller.abort()), close = vi.fn();
  const open = vi.fn<GroupSyncRuntime["open"]>(async () => ({ signal: controller.signal, close: closeSubscription,
    run: async emit => { await emit(snapshot, controller.signal); await emit({ type: "renew", sequence: 1 }, controller.signal); } }));
  const sync: GroupSyncRuntime = { open, close, authorize: vi.fn(), notifyGroup: vi.fn(), notifyUser: vi.fn() };
  registerGroupSyncRoutes(server, { auth: { getIdentity }, sync, publicOrigin: origin });
  return { server, getIdentity, open, closeSubscription, close, controller };
}

/** 在真实HTTP输出边界扣住首个write回调，模拟socket背压；不伪造zlib的flush完成。 */
function holdFirstWrite(server: ReturnType<typeof buildServer>) {
  let release = (): void => { throw new Error("尚未写入响应"); };
  let written!: () => void;
  const firstWrite = new Promise<void>(resolve => { written = resolve; });
  server.addHook("onRequest", async (_request, reply) => {
    const original = reply.raw.write;
    let first = true;
    vi.spyOn(reply.raw, "write").mockImplementation(((...args: unknown[]) => {
      if (!first) return Reflect.apply(original, reply.raw, args) as boolean;
      first = false;
      const callback = args.at(-1);
      if (typeof callback !== "function") throw new Error("响应写入缺少完成回调");
      release = () => { callback(); };
      const accepted = Reflect.apply(original, reply.raw, args.slice(0, -1)) as boolean;
      written(); return accepted;
    }) as typeof reply.raw.write);
  });
  return { firstWrite, release: () => release() };
}

describe("小组NDJSON路由", () => {
  it("gzip与identity完整事件等价，显式q=0不被通配符覆盖", async () => {
    const f = fixture(), g = fixture();
    try {
      const plain = await f.server.inject({ url: `/api/group-sync?groupId=${groupId}`, headers: { ...headers, "accept-encoding": "gzip;q=0, *;q=1" } });
      const compressed = await g.server.inject({ url: `/api/group-sync?groupId=${groupId}`, headers: { ...headers, "accept-encoding": "gzip" } });
      expect(plain.headers["content-encoding"]).toBeUndefined();
      expect(compressed.headers["content-encoding"]).toBe("gzip");
      expect(compressed.headers.vary).toBe("Accept-Encoding"); expect(compressed.headers["x-accel-buffering"]).toBe("no");
      const decoded = gunzipSync(compressed.rawPayload).toString();
      expect(decoded).toBe(plain.payload);
      expect(decoded.trim().split("\n").map(line => GroupSyncEventSchema.parse(JSON.parse(line) as unknown))).toEqual([snapshot, { type: "renew", sequence: 1 }]);
    } finally { await Promise.all([f.server.close(), g.server.close()]); }
  });

  it.each(["identity", "gzip"])("%s在实际写入回调前不确认emit，背压解除后才继续", async encoding => {
    const f = fixture(), held = holdFirstWrite(f.server);
    let acknowledged = false;
    f.open.mockImplementationOnce(async () => ({ signal: f.controller.signal, close: f.closeSubscription,
      run: async emit => { await emit(snapshot, f.controller.signal); acknowledged = true; } }));
    const response = f.server.inject({ url: `/api/group-sync?groupId=${groupId}`, headers: { ...headers, "accept-encoding": encoding } });
    try {
      // inject为惰性thenable，先订阅再等待被测HTTP写入。
      const completed = response.then(value => value);
      await held.firstWrite; expect(acknowledged).toBe(false);
      held.release(); const result = await completed;
      expect(result.statusCode).toBe(200); expect(acknowledged).toBe(true);
      const decoded = encoding === "gzip" ? gunzipSync(result.rawPayload).toString() : result.payload;
      expect(decoded).toBe(`${JSON.stringify(snapshot)}\n`);
    } finally { f.controller.abort(); await f.server.close(); }
  });

  it.each(["abort", "timeout"])("gzip背压期间%s立即销毁，不能把迟到write标记成功", async mode => {
    const f = fixture(), held = holdFirstWrite(f.server);
    let acknowledged = false;
    if (mode === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.open.mockImplementationOnce(async () => ({ signal: f.controller.signal, close: f.closeSubscription,
      run: async emit => { await emit(snapshot, f.controller.signal); acknowledged = true; } }));
    const completed = f.server.inject({ url: `/api/group-sync?groupId=${groupId}`, headers: { ...headers, "accept-encoding": "gzip" } }).then(value => value, error => error as unknown);
    try {
      await held.firstWrite;
      if (mode === "abort") f.controller.abort();
      else {
        await vi.advanceTimersByTimeAsync(4_999); expect(f.closeSubscription).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      await completed;
      expect(acknowledged).toBe(false); expect(f.closeSubscription).toHaveBeenCalledOnce();
      held.release(); await Promise.resolve(); expect(acknowledged).toBe(false);
    } finally { vi.useRealTimers(); f.controller.abort(); await f.server.close(); }
  });

  it("完整快照和renew按行输出，connectionId在快照末尾，禁用代理缓冲", async () => {
    const f = fixture();
    try {
      const response = await f.server.inject({ url: `/api/group-sync?groupId=${groupId}`, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("application/x-ndjson; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-store"); expect(response.headers["x-accel-buffering"]).toBe("no");
      const events = response.payload.trim().split("\n").map(line => GroupSyncEventSchema.parse(JSON.parse(line) as unknown));
      expect(events).toEqual([snapshot, { type: "renew", sequence: 1 }]);
      expect(Object.keys(events[0] ?? {}).at(-1)).toBe("connectionId");
      expect(f.open.mock.calls[0]?.slice(0, 1)).toEqual([identity]);
      expect(f.open.mock.calls[0]?.[2]).toBe(groupId); expect(f.closeSubscription).toHaveBeenCalledOnce();
    } finally { await f.server.close(); }
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("匿名、跨源和未知查询先拒绝，不启动订阅", async () => {
    const f = fixture();
    try {
      f.getIdentity.mockResolvedValueOnce(null);
      expect((await f.server.inject({ url: `/api/group-sync?groupId=${groupId}`, headers })).statusCode).toBe(401);
      expect((await f.server.inject({ url: `/api/group-sync?groupId=${groupId}`, headers: { ...headers, origin: "https://other.example" } })).statusCode).toBe(403);
      expect((await f.server.inject({ url: "/api/group-sync", headers })).statusCode).toBe(400);
      expect((await f.server.inject({ url: `/api/group-sync?groupId=${groupId}&connectionId=not-in-url`, headers })).statusCode).toBe(400);
      expect(f.open).not.toHaveBeenCalled();
    } finally { await f.server.close(); }
  });

  it("初始成员权限失败仍使用普通JSON固定错误，不抢先发200流式响应", async () => {
    const f = fixture();
    try {
      f.open.mockRejectedValueOnce(new GroupAccessError("GROUP_FORBIDDEN"));
      const response = await f.server.inject({ url: `/api/group-sync?groupId=${groupId}`, headers });
      expect(response.statusCode).toBe(403); expect(response.json()).toEqual({ code: "GROUP_FORBIDDEN" });
      expect(response.headers["content-type"]).toContain("application/json");
      expect(f.closeSubscription).not.toHaveBeenCalled();
    } finally { await f.server.close(); }
  });
});
