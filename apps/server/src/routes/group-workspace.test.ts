/** 组图HTTP边界复用假会话／存储，确认归属、收据和大正文不会绕过公共协议。 */
import { describe, expect, it, vi } from "vitest";
import { CLOUD_ACCOUNT_HEADER, EditableGraphSchema, GROUP_CONNECTION_HEADER } from "@wayfinder/contracts";
import { createGraphHistory, storeGraphHistory } from "@wayfinder/contracts/graph-history";
import { buildServer } from "../app.js";
import { GroupAccessError } from "../groups/errors.js";
import type { GroupWorkspaceStorage } from "../groups/workspace-storage.js";
import { registerGroupWorkspaceRoutes } from "./group-workspace.js";
import type { GroupSyncRuntime } from "../groups/sync.js";

const identity = { userId: "fixture_user", sessionId: "fixture_session", email: "fixture@example.test" };
const origin = "https://group.example";
const headers = { origin, host: "group.example", [CLOUD_ACCOUNT_HEADER]: identity.userId,
  [GROUP_CONNECTION_HEADER]: "fixture_connection", "content-type": "application/json" };
const document = EditableGraphSchema.parse({ version: "workspace.v1", id: "fixture_graph", title: "学习图", query: "",
  language: "zh-CN", presentationMode: "graph", createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z",
  lastRunId: null, nodes: [], edges: [], positions: {} });
const groupId = "fixture_group";
const workspace = { groupId, revision: 1, activeOrder: [document.id], deletedIds: [], graphs: [{ document,
  history: { version: "groupHistory.v1" as const, base: storeGraphHistory(createGraphHistory(document)).base, events: [], redoIdsByUser: {} },
  revision: 1, status: "active" as const, originalIndex: null }] };
function fixture() {
  const server = buildServer(), getIdentity = vi.fn(async () => identity as typeof identity | null);
  const read = vi.fn<GroupWorkspaceStorage["read"]>(async () => workspace);
  const write = vi.fn<GroupWorkspaceStorage["write"]>(async () => ({ workspace }));
  const receipt = vi.fn<GroupWorkspaceStorage["receipt"]>(async (_userId, mutationId) => ({ mutationId, applied: false, groupId: null, graphId: null, personalGraphId: null }));
  const authorize = vi.fn<GroupSyncRuntime["authorize"]>((_identity, _groupId, connectionId, operation) => {
    if (connectionId !== "fixture_connection") throw new GroupAccessError("GROUP_OFFLINE");
    return operation;
  });
  const notifyGroup = vi.fn();
  const sync: GroupSyncRuntime = { authorize, notifyGroup, notifyUser: vi.fn(), close: vi.fn(), open: vi.fn() };
  registerGroupWorkspaceRoutes(server, { auth: { getIdentity }, storage: { read, write, receipt }, publicOrigin: origin, sync });
  return { server, getIdentity, read, write, receipt, authorize, notifyGroup };
}

describe("小组图HTTP边界", () => {
  it("快照必须指定组，归属和操作者由已复核会话传递", async () => {
    const f = fixture();
    try {
      const response = await f.server.inject({ url: `/api/group-workspace?groupId=${groupId}`, headers });
      expect(response.json()).toEqual(workspace); expect(response.headers["cache-control"]).toBe("no-store");
      expect(f.read.mock.calls[0]?.slice(0, 2)).toEqual([identity.userId, groupId]);
      expect((await f.server.inject({ url: "/api/group-workspace", headers })).statusCode).toBe(400);
      expect((await f.server.inject({ url: `/api/group-workspace?groupId=${groupId}&userId=other`, headers })).statusCode).toBe(400);
    } finally { await f.server.close(); }
  });

  it("动作不接受作者或历史，编辑前后不能偷换目标身份", async () => {
    const f = fixture();
    try {
      const input = { action: "create", groupId, mutationId: "fixture_create", document };
      expect((await f.server.inject({ method: "POST", url: "/api/group-workspace", headers, payload: input })).statusCode).toBe(200);
      expect(f.write.mock.calls[0]?.slice(0, 2)).toEqual([identity.userId, input]);
      expect(f.authorize.mock.calls[0]?.slice(0, 3)).toEqual([identity, groupId, "fixture_connection"]);
      expect(f.notifyGroup).toHaveBeenCalledWith(groupId);
      f.write.mockClear();
      for (const extra of [{ actorUserId: "other" }, { history: workspace.graphs[0]?.history }]) {
        expect((await f.server.inject({ method: "POST", url: "/api/group-workspace", headers, payload: { ...input, ...extra } })).statusCode).toBe(400);
      }
      expect((await f.server.inject({ method: "POST", url: "/api/group-workspace", headers, payload: {
        action: "edit", groupId, graphId: document.id, expectedRevision: 1, mutationId: "fixture_edit",
        before: document, after: { ...document, id: "other_graph" }, kind: "graph.rename", subject: "图",
      } })).statusCode).toBe(400);
      expect(f.write).not.toHaveBeenCalled();
    } finally { await f.server.close(); }
  });

  it("缺失或失效实时连接不得写入，失败不广播，收据查询仍无需连接凭据", async () => {
    const f = fixture();
    try {
      const input = { action: "create", groupId, mutationId: "fixture_offline", document };
      const withoutProof = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== GROUP_CONNECTION_HEADER));
      expect((await f.server.inject({ method: "POST", url: "/api/group-workspace", headers: withoutProof, payload: input })).statusCode).toBe(503);
      expect((await f.server.inject({ method: "POST", url: "/api/group-workspace", headers: { ...headers, [GROUP_CONNECTION_HEADER]: "closed" }, payload: input })).statusCode).toBe(503);
      expect(f.write).not.toHaveBeenCalled(); expect(f.notifyGroup).not.toHaveBeenCalled();
      expect((await f.server.inject({ url: "/api/group-receipt?mutationId=fixture_offline", headers: withoutProof })).statusCode).toBe(200);
      f.write.mockRejectedValueOnce(new GroupAccessError("GROUP_CONFLICT"));
      expect((await f.server.inject({ method: "POST", url: "/api/group-workspace", headers, payload: input })).statusCode).toBe(409);
      expect(f.notifyGroup).not.toHaveBeenCalled();
    } finally { await f.server.close(); }
  });

  it("收据只按本人操作标识查询，不借此读取源组内容", async () => {
    const f = fixture();
    try {
      const response = await f.server.inject({ url: "/api/group-receipt?mutationId=fixture_copy", headers });
      expect(response.json()).toEqual({ mutationId: "fixture_copy", applied: false, groupId: null, graphId: null, personalGraphId: null });
      expect(f.receipt.mock.calls[0]?.slice(0, 2)).toEqual([identity.userId, "fixture_copy"]);
      expect(f.read).not.toHaveBeenCalled();
      expect((await f.server.inject({ url: `/api/group-receipt?mutationId=fixture_copy&groupId=${groupId}`, headers })).statusCode).toBe(400);
    } finally { await f.server.close(); }
  });

  it("匿名坏JSON在解析前拒绝，错号／换会话及非成员错误不写入", async () => {
    const f = fixture();
    try {
      f.getIdentity.mockResolvedValue(null);
      expect((await f.server.inject({ method: "POST", url: "/api/group-workspace", headers, payload: "{" })).statusCode).toBe(401);
      f.getIdentity.mockResolvedValue(identity);
      expect((await f.server.inject({ url: `/api/group-workspace?groupId=${groupId}`, headers: { ...headers, [CLOUD_ACCOUNT_HEADER]: "other" } })).statusCode).toBe(401);
      f.getIdentity.mockResolvedValueOnce(identity).mockResolvedValueOnce({ ...identity, sessionId: "new_session" });
      expect((await f.server.inject({ method: "POST", url: "/api/group-workspace", headers,
        payload: { action: "create", groupId, mutationId: "fixture_create", document } })).statusCode).toBe(401);
      expect(f.write).not.toHaveBeenCalled();
      f.getIdentity.mockResolvedValue(identity); f.read.mockRejectedValueOnce(new GroupAccessError("GROUP_FORBIDDEN"));
      expect((await f.server.inject({ url: `/api/group-workspace?groupId=${groupId}`, headers })).statusCode).toBe(403);
    } finally { await f.server.close(); }
  });

  it("完整组图超过框架默认1MiB仍到达合法存储边界", async () => {
    const f = fixture();
    try {
      const input = { action: "create", groupId, mutationId: "fixture_large", document: { ...document, title: "图" + "x".repeat(1024 * 1024) } };
      const response = await f.server.inject({ method: "POST", url: "/api/group-workspace", headers, payload: input });
      expect(response.statusCode).toBe(200); expect(f.write).toHaveBeenCalledOnce();
    } finally { await f.server.close(); }
  });
});
