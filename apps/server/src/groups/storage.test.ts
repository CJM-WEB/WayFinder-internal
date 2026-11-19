/**
 * 适配层回归：业务错误不被数据库改写、写入后的拒绝先回滚、二进制邀请码仅向创建者公开。
 * 驱动连接使用假实现，真实SQL和生命周期竞态由显式本地数据库检查另验，不在普通CI联网。
 */
import type { PoolConnection } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { EditableGraphSchema, GroupGraphActionSchema } from "@wayfinder/contracts";
import { createGraphHistory, storeGraphHistory } from "@wayfinder/contracts/graph-history";
import { AccountDatabase, databaseConfigFromUrl, databaseOperation } from "../accounts/database.js";
import { GroupAccessError } from "./errors.js";
import { createGroupStorage, groupTransaction } from "./storage.js";
import { createGroupWorkspaceStorage } from "./workspace-storage.js";

function fixture(rows: (sql: string, values: unknown[]) => unknown = () => []) {
  const database = new AccountDatabase(databaseConfigFromUrl("mysql://fixture:fake@127.0.0.1:1/wf_d12_test_storage"));
  const statements: string[] = [];
  const connection = {
    query: vi.fn(async (options: { sql: string; values?: unknown[] }) => {
      statements.push(options.sql);
      return [rows(options.sql, options.values ?? []), []];
    }), release: vi.fn(), destroy: vi.fn(),
  };
  const acquire = vi.spyOn(database.pool, "getConnection").mockResolvedValue(connection as unknown as PoolConnection);
  return { database, statements, cleanup: async () => { acquire.mockRestore(); await database.close(); } };
}
const operation = () => databaseOperation(new AbortController().signal);

/** 使用真实个人存档和历史形状，确保共享测试不会因笔记夹具本身被协议拒绝而假绿。 */
const note = { id: "fixture-note", title: "个人笔记标题", description: "个人笔记说明", markdown: "个人笔记正文" };
const sourceDocument = () => EditableGraphSchema.parse({
  version: "workspace.v1", id: "source-graph", title: "资料", query: "", language: "zh-CN",
  presentationMode: "graph", createdAt: "2026-11-19T00:00:00.000Z", updatedAt: "2026-11-19T00:00:00.000Z",
  lastRunId: null, nodes: [{ id: "node", title: "节点", description: "", nodeType: "primary", layer: 0, status: "empty",
    resources: [], warnings: [], notes: [note] }], edges: [], positions: {},
});

describe("小组存储适配与事务错误", () => {
  it("写入后业务拒绝回滚保存点并保留明确错误码，不提交部分组状态", async () => {
    const f = fixture();
    try {
      await expect(groupTransaction(f.database, operation(), async query => {
        await query("INSERT INTO fixture_group VALUES (?)", ["fixture"]);
        throw new GroupAccessError("GROUP_CONFLICT");
      })).rejects.toMatchObject({ code: "GROUP_CONFLICT" });
      expect(f.statements).toEqual(["START TRANSACTION", "SAVEPOINT wf_group_action",
        "INSERT INTO fixture_group VALUES (?)", "ROLLBACK TO SAVEPOINT wf_group_action", "COMMIT"]);
    } finally { await f.cleanup(); }
  });

  it("未知SQL或结构异常回滚整笔事务，原始异常不进入公共错误", async () => {
    const f = fixture();
    try {
      await expect(groupTransaction(f.database, operation(), async () => { throw new Error("private fixture detail"); }))
        .rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE", message: "DATABASE_UNAVAILABLE" });
      expect(f.statements).toEqual(["START TRANSACTION", "SAVEPOINT wf_group_action", "ROLLBACK"]);
    } finally { await f.cleanup(); }
  });

  it.each(["owner", "member"])("VARBINARY邀请码只向创建者%s投影，昵称不暴露邮箱", async userId => {
    const group = { groupId: "fixture_group", ownerUserId: "owner", name: "学习组", description: "", revision: 1 };
    const invitationCode = "owner+tag@example.test#Ab123456789012345678";
    const f = fixture(sql => {
      if (sql.startsWith("SELECT groupId,")) return [{ groupId: group.groupId, ownerUserId: "owner", payload: group,
        invitationCode: Buffer.from(invitationCode) }];
      if (sql.startsWith("SELECT userId FROM wf_group_members")) return [{ userId }];
      if (sql.startsWith("SELECT m.userId,")) return [{ userId: "owner", profile: { nickname: "同学" } },
        { userId: "member", profile: '{"nickname":"同学"}' }];
      return [];
    });
    try {
      const result = await createGroupStorage(f.database).read(userId, group.groupId, operation());
      expect(result.invitationCode).toBe(userId === "owner" ? invitationCode : null);
      expect(result.members.map(member => member.nickname)).toEqual(["同学", "同学"]);
      expect(result.members.every(member => !Object.hasOwn(member, "email"))).toBe(true);
      expect(f.statements[0]).toBe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    } finally { await f.cleanup(); }
  });

  it("从个人图复制时组图文档、历史基线和持久化记录均不泄露笔记", async () => {
    const source = sourceDocument();
    const group = { groupId: "fixture_group", ownerUserId: "owner", name: "学习组", description: "", revision: 1 };
    const record = { document: source, history: storeGraphHistory(createGraphHistory(source)),
      revision: 1, status: "active", originalIndex: null };
    const personalEnvelope = { kind: "graph", recordJson: JSON.stringify(record),
      lastMutationId: "source-save", requestFingerprint: "a".repeat(64) };
    const sharedRows = new Map<string, string>();
    const personalGraphWrites: string[] = [];
    // 只替换 SQL 执行层，复制、建空历史、持久化和响应投影均走正式存储入口。
    const f = fixture((sql, values) => {
      const key = String(values[1]);
      if (sql.startsWith("SELECT groupId,")) return [{ groupId: group.groupId, ownerUserId: "owner",
        invitationCode: null, payload: group }];
      if (sql.startsWith("SELECT userId FROM wf_group_members")) return [{ userId: "owner" }];
      if (sql.startsWith("SELECT payload FROM wf_user_data") && key.startsWith("g_")) return [{ payload: personalEnvelope }];
      if (sql.startsWith("INSERT INTO wf_user_data") && key.startsWith("g_")) personalGraphWrites.push(key);
      if (sql.startsWith("INSERT INTO wf_group_data")) sharedRows.set(key, String(values[2]));
      if (sql.startsWith("SELECT payload FROM wf_group_data")) {
        if (sql.includes("LEFT(recordId, 2)")) return [...sharedRows].filter(([id]) => id.startsWith("g_")).map(([, payload]) => ({ payload }));
        const payload = sharedRows.get(key);
        return payload === undefined ? [] : [{ payload }];
      }
      return [];
    });
    try {
      const result = await createGroupWorkspaceStorage(f.database, { createId: () => "group-copy", now: () => source.updatedAt })
        .write("owner", { action: "copyIn", mutationId: "copy-in", groupId: group.groupId,
          sourceGraphId: source.id, sourceRevision: 1 }, operation());
      const copy = result.workspace.graphs[0];
      expect(copy?.document.id).toBe("group-copy");
      expect(copy?.document.nodes.map(node => node.id)).toEqual(["node"]);
      expect(copy?.document.nodes[0]?.notes ?? []).toEqual([]);
      expect(copy?.history.base.graph.nodes[0]?.notes ?? []).toEqual([]);
      expect(copy?.history.events).toEqual([]);
      expect(source.nodes[0]?.notes).toEqual([note]);
      expect(personalGraphWrites).toEqual([]);
      expect([...sharedRows.keys()].some(key => key.startsWith("g_"))).toBe(true);
      for (const privateValue of [note.title, note.description, note.markdown]) {
        expect([...sharedRows.values()].join("\n")).not.toContain(privateValue);
      }
    } finally { await f.cleanup(); }
  });

  it("小组新建与普通编辑协议拒绝夹带个人笔记或笔记历史动作", () => {
    const document = sourceDocument();
    const empty = { ...document, nodes: [] };
    const context = { groupId: "fixture_group", mutationId: "client-edit" };
    const edit = { ...context, action: "edit", graphId: document.id, expectedRevision: 1,
      before: empty, after: empty, kind: "graph.update", subject: "" };
    expect(document.nodes[0]?.notes).toEqual([note]);
    expect(GroupGraphActionSchema.safeParse(edit).success).toBe(true);
    for (const input of [{ ...context, action: "create", document }, { ...edit, before: document },
      { ...edit, after: document }, ...["note.add", "note.edit", "note.delete"].map(kind => ({ ...edit, kind }))]) {
      expect(GroupGraphActionSchema.safeParse(input).success).toBe(false);
    }
  });
});
