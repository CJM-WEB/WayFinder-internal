/** 同源云图路由只用假身份／存储验证护栏、解析顺序和失败语义，普通CI不连接DB。 */
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { CLOUD_ACCOUNT_HEADER, EditableGraphSchema, type CloudGraphWriteRequest } from "@wayfinder/contracts";
import { createGraphHistory, storeGraphHistory } from "@wayfinder/contracts/graph-history";

import { buildServer } from "../app.js";
import { WorkspaceAccessError, type WorkspaceStorage } from "../accounts/workspace-storage.js";
import { registerWorkspaceRoutes } from "./workspace.js";

const origin = "https://workspace.example", userId = "fixture_user";
const identity = { userId, sessionId: "fixture_session", email: "fixture@example.com" };
const headers = { host: "workspace.example", origin, [CLOUD_ACCOUNT_HEADER]: userId, "content-type": "application/json" };
function request(title = "假图"): CloudGraphWriteRequest {
  const document = EditableGraphSchema.parse({ version: "workspace.v1", id: "fixture_graph", title, query: "",
    language: "zh-CN", presentationMode: "graph", createdAt: "2026-11-11T00:00:00.000Z", updatedAt: "2026-11-11T00:00:00.000Z",
    lastRunId: null, nodes: [], edges: [], positions: {} });
  return { action: "save", document, history: storeGraphHistory(createGraphHistory(document)), expectedRevision: 0, mutationId: "fixture_mutation" };
}
function fixture() {
  const server = buildServer(), getIdentity = vi.fn(async () => identity as typeof identity | null);
  const read = vi.fn<WorkspaceStorage["read"]>(async () => ({ userId, activeOrder: [], deletedIds: [], graphs: [] }));
  const write = vi.fn<WorkspaceStorage["write"]>(async (_id, input) => {
    if (input.action !== "save") throw new Error("假存储只处理保存");
    return { userId, record: { document: input.document, history: input.history, revision: 1, status: "active", originalIndex: null },
      activeOrder: [input.document.id], deletedIds: [] };
  });
  registerWorkspaceRoutes(server, { auth: { getIdentity }, storage: { read, write }, publicOrigin: origin });
  return { server, getIdentity, read, write };
}

describe("云工作区HTTP边界", () => {
  it("会话和预期账号在解析前校验，匿名及错号大坏JSON不会进入存储", async () => {
    const { server, getIdentity, read, write } = fixture();
    const invalid = `{${" ".repeat(1024 * 1024 + 1)}`;
    try {
      getIdentity.mockResolvedValue(null);
      expect((await server.inject({ method: "POST", url: "/api/workspace", headers, payload: invalid })).statusCode).toBe(401);
      getIdentity.mockResolvedValue(identity);
      expect((await server.inject({ method: "POST", url: "/api/workspace", headers: { ...headers, [CLOUD_ACCOUNT_HEADER]: "other_user" }, payload: invalid })).statusCode).toBe(401);
      expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
  it("上传期间会话撤销或重登，写前复核阻止待提交数据", async () => {
    const { server, getIdentity, write } = fixture();
    try {
      getIdentity.mockResolvedValueOnce(identity).mockResolvedValueOnce(null);
      expect((await server.inject({ method: "POST", url: "/api/workspace", headers, payload: request() })).statusCode).toBe(401);
      getIdentity.mockResolvedValueOnce(identity).mockResolvedValueOnce({ ...identity, sessionId: "new_session" });
      expect((await server.inject({ method: "POST", url: "/api/workspace", headers, payload: request() })).statusCode).toBe(401);
      expect(write).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
  it("合法会话的超过1MiB保存到达处理器，不使用框架默认大小额度", async () => {
    const { server, write } = fixture(), input = request("小型字节边界样例" + "x".repeat(600_000));
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(1024 * 1024);
    try {
      const response = await server.inject({ method: "POST", url: "/api/workspace", headers, payload: input });
      expect(response.statusCode).toBe(200); expect(write).toHaveBeenCalledOnce();
      if (input.action !== "save") throw new Error("预期保存");
      expect(response.json().record.document.title).toBe(input.document.title);
    } finally { await server.close(); }
  });
  it("字符串转换或安全JSON解析失败只返回固定错误，不触发存储", async () => {
    const { server, write } = fixture();
    const original = Buffer.prototype.toString;
    const conversion = vi.spyOn(Buffer.prototype, "toString").mockImplementation(function (this: Buffer, encoding, start, end) {
      if (this.includes("fixture-range-failure")) throw new RangeError("fixture private parser detail");
      return original.call(this, encoding, start, end);
    });
    try {
      const response = await server.inject({ method: "POST", url: "/api/workspace", headers, payload: '{"fixture-range-failure":true}' });
      expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ code: "WORKSPACE_INVALID" });
      expect(write).not.toHaveBeenCalled();
    } finally { conversion.mockRestore(); await server.close(); }
  });
  it("Origin及协议严格校验，冲突和内部异常不泄漏正文", async () => {
    const { server, write } = fixture();
    try {
      expect((await server.inject({ url: "/api/workspace", headers: { ...headers, origin: "https://other.example" } })).statusCode).toBe(403);
      expect((await server.inject({ method: "POST", url: "/api/workspace", headers, payload: { ...request(), userId: "other" } })).statusCode).toBe(400);
      expect(write).not.toHaveBeenCalled();
      write.mockRejectedValueOnce(new WorkspaceAccessError("WORKSPACE_CONFLICT"));
      expect((await server.inject({ method: "POST", url: "/api/workspace", headers, payload: request() })).statusCode).toBe(409);
      write.mockRejectedValueOnce(new Error("fixture secret database detail"));
      const response = await server.inject({ method: "POST", url: "/api/workspace", headers, payload: request() });
      expect(response.statusCode).toBe(503); expect(response.json()).toEqual({ code: "WORKSPACE_UNAVAILABLE" });
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally { await server.close(); }
  });
});
