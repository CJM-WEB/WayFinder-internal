/** 小组路由使用假身份和假存储，验证可信身份传递、解析顺序及固定错误，不接真实服务。 */
import { describe, expect, it, vi } from "vitest";
import { CLOUD_ACCOUNT_HEADER, GROUP_CONNECTION_HEADER } from "@wayfinder/contracts";
import { buildServer } from "../app.js";
import { GroupAccessError } from "../groups/errors.js";
import type { GroupStorage } from "../groups/storage.js";
import { registerGroupRoutes } from "./groups.js";
import type { GroupSyncRuntime } from "../groups/sync.js";

const identity = { userId: "fixture_owner", email: "owner+tag@example.test", sessionId: "fixture_session" };
const origin = "https://group.example";
const headers = { origin, host: "group.example", [CLOUD_ACCOUNT_HEADER]: identity.userId, "content-type": "application/json" };
const group = { groupId: "fixture_group", ownerUserId: identity.userId, name: "学习小组", description: "资料", revision: 1 };
const details = { group, members: [{ userId: identity.userId, nickname: "小明", role: "owner" as const }], invitationCode: `${identity.email}#${"A".repeat(20)}` };
function fixture() {
  const server = buildServer(), getIdentity = vi.fn(async () => identity as typeof identity | null);
  const list = vi.fn<GroupStorage["list"]>(async () => ({ groups: [group] }));
  const read = vi.fn<GroupStorage["read"]>(async () => details);
  const write = vi.fn<GroupStorage["write"]>(async () => ({ groups: [group], details }));
  const authorize = vi.fn<GroupSyncRuntime["authorize"]>((_identity, _groupId, connectionId, operation) => {
    if (connectionId !== "fixture_connection") throw new GroupAccessError("GROUP_OFFLINE");
    return operation;
  });
  const notifyGroup = vi.fn();
  const sync: GroupSyncRuntime = { authorize, notifyGroup, notifyUser: vi.fn(), close: vi.fn(), open: vi.fn() };
  registerGroupRoutes(server, { auth: { getIdentity }, storage: { list, read, write }, publicOrigin: origin, sync });
  return { server, getIdentity, list, read, write, authorize, notifyGroup };
}

describe("小组HTTP身份边界", () => {
  it("列表／详情按会话账号读取，创建只从可信身份取得邮箱", async () => {
    const f = fixture();
    try {
      const response = await f.server.inject({ url: "/api/groups", headers });
      expect(response.json()).toEqual({ groups: [group] });
      expect(response.headers["cache-control"]).toBe("no-store");
      expect((await f.server.inject({ url: "/api/groups?groupId=fixture_group", headers })).json()).toEqual(details);
      expect(f.read.mock.calls[0]?.slice(0, 2)).toEqual([identity.userId, group.groupId]);
      const input = { action: "create", mutationId: "fixture_create", name: "  学习小组  ", description: "资料" };
      expect((await f.server.inject({ method: "POST", url: "/api/groups", headers, payload: input })).statusCode).toBe(200);
      expect(f.write.mock.calls[0]?.slice(0, 2)).toEqual([identity, { ...input, name: "学习小组" }]);
    } finally { await f.server.close(); }
  });

  it("改组名／退出／解散绑定在线组proof，创建／加入尚无连接可独立执行", async () => {
    const f = fixture();
    try {
      const actions = [{ action: "update", groupId: group.groupId, mutationId: "update", expectedRevision: 1, name: "新组名", description: "" },
        { action: "leave", groupId: group.groupId, mutationId: "leave" },
        { action: "dissolve", groupId: group.groupId, mutationId: "dissolve", expectedRevision: 1 }];
      for (const input of actions) {
        expect((await f.server.inject({ method: "POST", url: "/api/groups", headers, payload: input })).statusCode).toBe(503);
        expect((await f.server.inject({ method: "POST", url: "/api/groups", headers: { ...headers, [GROUP_CONNECTION_HEADER]: "closed" }, payload: input })).statusCode).toBe(503);
      }
      expect(f.write).not.toHaveBeenCalled(); expect(f.notifyGroup).not.toHaveBeenCalled();
      for (const input of actions) expect((await f.server.inject({ method: "POST", url: "/api/groups",
        headers: { ...headers, [GROUP_CONNECTION_HEADER]: "fixture_connection" }, payload: input })).statusCode).toBe(200);
      expect(f.authorize.mock.calls.at(-1)?.slice(0, 3)).toEqual([identity, group.groupId, "fixture_connection"]);
      f.authorize.mockClear();
      for (const input of [{ action: "create", mutationId: "create", name: "组", description: "" },
        { action: "join", mutationId: "join", invitationCode: details.invitationCode }]) {
        expect((await f.server.inject({ method: "POST", url: "/api/groups", headers, payload: input })).statusCode).toBe(200);
      }
      expect(f.authorize).not.toHaveBeenCalled();
    } finally { await f.server.close(); }
  });

  it("身份先于正文解析，匿名／错号／换会话不能写入", async () => {
    const f = fixture();
    try {
      f.getIdentity.mockResolvedValue(null);
      expect((await f.server.inject({ method: "POST", url: "/api/groups", headers, payload: "{" })).statusCode).toBe(401);
      f.getIdentity.mockResolvedValue(identity);
      expect((await f.server.inject({ url: "/api/groups", headers: { ...headers, [CLOUD_ACCOUNT_HEADER]: "other_user" } })).statusCode).toBe(401);
      f.getIdentity.mockResolvedValueOnce(identity).mockResolvedValueOnce({ ...identity, sessionId: "changed_session" });
      expect((await f.server.inject({ method: "POST", url: "/api/groups", headers,
        payload: { action: "leave", groupId: group.groupId, mutationId: "fixture_leave" } })).statusCode).toBe(401);
      expect(f.write).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled();
    } finally { await f.server.close(); }
  });

  it("拒绝跨站、未知查询和伪造创建者邮箱／角色字段", async () => {
    const f = fixture();
    try {
      expect((await f.server.inject({ url: "/api/groups", headers: { ...headers, origin: "https://other.example" } })).statusCode).toBe(403);
      expect((await f.server.inject({ url: "/api/groups?email=private@example.test", headers })).statusCode).toBe(400);
      for (const extra of [{ ownerUserId: "other" }, { email: "other@example.test" }, { role: "owner" }]) {
        expect((await f.server.inject({ method: "POST", url: "/api/groups", headers,
          payload: { action: "create", name: "组", description: "", mutationId: "fixture_create", ...extra } })).statusCode).toBe(400);
      }
      expect(f.write).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled();
    } finally { await f.server.close(); }
  });

  it.each([["GROUP_FORBIDDEN", 403], ["GROUP_NOT_FOUND", 404], ["GROUP_CONFLICT", 409], ["NICKNAME_REQUIRED", 400]] as const)(
    "业务错误%s保持固定HTTP语义", async (code, status) => {
      const f = fixture();
      try {
        f.write.mockRejectedValueOnce(new GroupAccessError(code));
        const response = await f.server.inject({ method: "POST", url: "/api/groups", headers,
          payload: { action: "create", name: "组", description: "", mutationId: "fixture_create" } });
        expect(response.statusCode).toBe(status); expect(response.json()).toEqual({ code });
      } finally { await f.server.close(); }
    });

  it("数据库原始错误和正文解析失败不公开细节", async () => {
    const f = fixture();
    try {
      f.read.mockRejectedValueOnce(new Error("fixture private invitation and database detail"));
      const response = await f.server.inject({ url: "/api/groups?groupId=fixture_group", headers });
      expect(response.statusCode).toBe(503); expect(response.json()).toEqual({ code: "GROUP_UNAVAILABLE" });
      expect((await f.server.inject({ method: "POST", url: "/api/groups", headers, payload: "{" })).statusCode).toBe(400);
    } finally { await f.server.close(); }
  });
});
