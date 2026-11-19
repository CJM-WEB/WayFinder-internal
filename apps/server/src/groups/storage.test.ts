/**
 * 适配层回归：业务错误不被数据库改写、写入后的拒绝先回滚、二进制邀请码仅向创建者公开。
 * 驱动连接使用假实现，真实SQL和生命周期竞态由显式本地数据库检查另验，不在普通CI联网。
 */
import { createHash } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { EditableGraphSchema, GroupGraphActionSchema } from "@wayfinder/contracts";
import { createGraphHistory, storeGraphHistory } from "@wayfinder/contracts/graph-history";
import { AccountDatabase, databaseConfigFromUrl, databaseOperation } from "../accounts/database.js";
import { GroupAccessError } from "./errors.js";
import { createGroupHistory } from "./history.js";
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

/** 只替换 SQL 执行层，双向复制仍经过实际版本校验、历史重放、写入和回执逻辑。 */
function copyFixture() {
  const graphKey = (id: string): string => `g_${createHash("sha256").update(id).digest("hex")}`;
  const source = sourceDocument(), groupSource = { ...source, id: "shared-source" };
  const group = { groupId: "fixture_group", ownerUserId: "owner", name: "学习组", description: "", revision: 1 };
  const members = new Set(["owner", "member"]);
  const record = { revision: 1, status: "active", originalIndex: null };
  const personalKey = `owner:${graphKey(source.id)}`;
  const groupKey = graphKey(groupSource.id);
  const personalRows = new Map([[personalKey, JSON.stringify({ kind: "graph", lastMutationId: "source-save",
    requestFingerprint: "a".repeat(64), recordJson: JSON.stringify({ ...record, document: source,
      history: storeGraphHistory(createGraphHistory(source)) }) })]]);
  const sharedRows = new Map([["workspace_meta", JSON.stringify({ kind: "workspace", activeOrder: [groupSource.id], deletedIds: [] })],
    [groupKey, JSON.stringify({ kind: "graph", recordJson: JSON.stringify({ ...record, document: groupSource,
      history: createGroupHistory(groupSource) }) })]]);
  let groupPayload = JSON.stringify(group), nextId = 0;
  const f = fixture((sql, values) => {
    const key = String(values[1]), accountKey = `${String(values[0])}:${key}`;
    if (sql.startsWith("SELECT groupId,")) return String(values[0]) === group.groupId ? [{
      groupId: group.groupId, ownerUserId: "owner", invitationCode: null, payload: groupPayload,
    }] : [];
    if (sql.startsWith("SELECT userId FROM wf_group_members")) return members.has(key) ? [{ userId: key }] : [];
    if (sql.startsWith("UPDATE wf_groups")) groupPayload = String(values[0]);
    if (sql.startsWith("SELECT payload FROM wf_user_data")) {
      const payload = personalRows.get(accountKey);
      return payload === undefined ? [] : [{ payload }];
    }
    if (sql.startsWith("INSERT INTO wf_user_data") && (!sql.endsWith("recordId = recordId") || !personalRows.has(accountKey))) {
      personalRows.set(accountKey, String(values[2]));
    }
    if (sql.startsWith("INSERT INTO wf_group_data")) sharedRows.set(key, String(values[2]));
    if (sql.startsWith("SELECT payload FROM wf_group_data")) {
      if (sql.includes("LEFT(recordId, 2)")) return [...sharedRows].filter(([id]) => id.startsWith("g_")).map(([, payload]) => ({ payload }));
      const payload = sharedRows.get(key);
      return payload === undefined ? [] : [{ payload }];
    }
    return [];
  });
  const storage = createGroupWorkspaceStorage(f.database, { createId: () => `copy-${++nextId}`, now: () => source.updatedAt });
  return { storage, cleanup: f.cleanup, source, groupSource, groupId: group.groupId, members,
    personalRows, sharedRows, personalKey, groupKey, graphKey };
}

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

  it.each([undefined, false, true])("个人图复制到组时只按选项附带笔记，源保持不变：%s", async includeNotes => {
    const f = copyFixture(), sourceRow = f.personalRows.get(f.personalKey);
    const action = { action: "copyIn" as const, mutationId: "copy-in", groupId: f.groupId,
      sourceGraphId: f.source.id, sourceRevision: 1, ...(includeNotes === undefined ? {} : { includeNotes }) };
    try {
      const result = await f.storage.write("owner", action, operation());
      const copy = result.workspace.graphs.find(item => item.document.id === "copy-1");
      const notes = includeNotes === true ? [note] : [];
      expect(copy?.document.nodes[0]?.id).toBe("node");
      expect(copy?.document.nodes[0]?.notes ?? []).toEqual(notes);
      expect(copy?.history.base.graph.nodes[0]?.notes ?? []).toEqual(notes);
      expect(copy?.history.events).toEqual([]);
      expect(f.personalRows.get(f.personalKey)).toBe(sourceRow);
      const persisted = f.sharedRows.get(f.graphKey("copy-1"));
      for (const privateValue of [note.title, note.description, note.markdown]) {
        expect(persisted?.includes(privateValue)).toBe(includeNotes === true);
      }
      expect((await f.storage.write("owner", action, operation())).workspace.activeOrder).toEqual([f.groupSource.id, "copy-1"]);
      await expect(f.storage.write("owner", { ...action, includeNotes: includeNotes !== true }, operation()))
        .rejects.toMatchObject({ code: "GROUP_CONFLICT" });
    } finally { await f.cleanup(); }
  });

  it.each([undefined, false, true])("组图按成员及源版本复制给个人，只按选项附带笔记：%s", async includeNotes => {
    const f = copyFixture(), sourceRow = f.sharedRows.get(f.groupKey);
    const action = { action: "copyOut" as const, mutationId: "copy-out", groupId: f.groupId, graphId: f.groupSource.id,
      expectedRevision: 1, ...(includeNotes === undefined ? {} : { includeNotes }) };
    try {
      await expect(f.storage.write("outsider", action, operation())).rejects.toMatchObject({ code: "GROUP_FORBIDDEN" });
      await expect(f.storage.write("member", { ...action, expectedRevision: 2 }, operation())).rejects.toMatchObject({ code: "GROUP_CONFLICT" });
      const result = await f.storage.write("member", action, operation());
      const notes = includeNotes === true ? [note] : [];
      expect(result.personalGraph?.document.id).toBe("copy-1");
      expect(result.personalGraph?.document.nodes[0]?.notes ?? []).toEqual(notes);
      expect(result.personalGraph?.history.base.graph.nodes[0]?.notes ?? []).toEqual(notes);
      expect(result.personalGraph?.history.events).toEqual([]);
      expect(f.sharedRows.get(f.groupKey)).toBe(sourceRow);
      expect(f.personalRows.has(`owner:${f.graphKey("copy-1")}`)).toBe(false);
      const persisted = f.personalRows.get(`member:${f.graphKey("copy-1")}`);
      for (const privateValue of [note.title, note.description, note.markdown]) {
        expect(persisted?.includes(privateValue)).toBe(includeNotes === true);
      }
      await f.storage.write("member", action, operation());
      await expect(f.storage.write("member", { ...action, includeNotes: includeNotes !== true }, operation()))
        .rejects.toMatchObject({ code: "GROUP_CONFLICT" });
      f.members.delete("member");
      await expect(f.storage.write("member", { ...action, mutationId: "revoked-copy" }, operation()))
        .rejects.toMatchObject({ code: "GROUP_FORBIDDEN" });
      expect(await f.storage.receipt("member", action.mutationId, operation())).toMatchObject({ applied: true, personalGraphId: "copy-1" });
      expect([...f.personalRows.keys()].filter(key => key.startsWith("member:g_"))).toEqual([`member:${f.graphKey("copy-1")}`]);
    } finally { await f.cleanup(); }
  });

  it("组员改删副本使用真实版本合并及本人撤销，不写回已同步的个人来源", async () => {
    const f = copyFixture(), sourceRow = f.personalRows.get(f.personalKey);
    const base = f.groupSource;
    const afterNote = (patch: Partial<typeof note>) => EditableGraphSchema.parse({
      ...base, nodes: [{ ...base.nodes[0], notes: [{ ...note, ...patch }] }],
    });
    const edit = { action: "edit" as const, groupId: f.groupId, graphId: base.id, before: base,
      expectedRevision: 1, kind: "note.edit" as const, subject: note.title };
    try {
      await f.storage.write("owner", { ...edit, mutationId: "owner-note", after: afterNote({ title: "组内改名" }) }, operation());
      const merged = await f.storage.write("member", { ...edit, mutationId: "member-note", after: afterNote({ markdown: "组员正文" }) }, operation());
      const row = merged.workspace.graphs[0];
      if (row === undefined || row.history.events[1] === undefined) throw new Error("缺少共享笔记和本人事件");
      expect(row.document.nodes[0]?.notes).toEqual([{ ...note, title: "组内改名", markdown: "组员正文" }]);
      expect(row.history.events.map(event => [event.actorUserId, event.kind])).toEqual([["owner", "note.edit"], ["member", "note.edit"]]);
      const undo = { action: "undo" as const, groupId: f.groupId, graphId: base.id, expectedRevision: row.revision,
        eventId: row.history.events[1].id, mutationId: "note-undo" };
      await expect(f.storage.write("owner", undo, operation())).rejects.toMatchObject({ code: "GROUP_FORBIDDEN" });
      const undone = (await f.storage.write("member", undo, operation())).workspace.graphs[0];
      if (undone === undefined) throw new Error("缺少撤销后的组图");
      expect(undone.document.nodes[0]?.notes).toEqual([{ ...note, title: "组内改名" }]);
      const removed = await f.storage.write("member", { ...edit, kind: "note.delete", mutationId: "note-remove",
        before: undone.document, expectedRevision: undone.revision, after: EditableGraphSchema.parse({
          ...undone.document, nodes: [{ ...undone.document.nodes[0], notes: [] }],
        }) }, operation());
      expect(removed.workspace.graphs[0]?.document.nodes[0]?.notes ?? []).toEqual([]);
      expect(removed.workspace.graphs[0]?.history.events.at(-1)?.kind).toBe("note.delete");
      expect(f.personalRows.get(f.personalKey)).toBe(sourceRow);
    } finally { await f.cleanup(); }
  });

  it("共享协议允许已有笔记的修改和删除，拒绝直接新建与伪造操作种类", () => {
    const document = sourceDocument();
    const context = { groupId: "fixture_group", mutationId: "client-edit" };
    const edit = { ...context, action: "edit", graphId: document.id, expectedRevision: 1,
      before: document, after: document, kind: "note.edit", subject: "" };
    expect(GroupGraphActionSchema.safeParse(edit).success).toBe(true);
    expect(GroupGraphActionSchema.safeParse({ ...edit, kind: "note.delete" }).success).toBe(true);
    expect(GroupGraphActionSchema.safeParse({ ...edit, kind: "note.add" }).success).toBe(false);
    expect(GroupGraphActionSchema.safeParse({ ...context, action: "create", document }).success).toBe(false);
  });
});
