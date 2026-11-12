/**
 * 适配层回归：业务错误不被数据库改写、写入后的拒绝先回滚、二进制邀请码仅向创建者公开。
 * 驱动连接使用假实现，真实SQL和生命周期竞态由显式本地数据库检查另验，不在普通CI联网。
 */
import type { PoolConnection } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { AccountDatabase, databaseConfigFromUrl, databaseOperation } from "../accounts/database.js";
import { GroupAccessError } from "./errors.js";
import { createGroupStorage, groupTransaction } from "./storage.js";

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
});
