/** 确定性边界检查；普通 CI 只验证配置和拒绝路径，不连接真实数据库。 */
import type { PoolConnection } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";

import { AccountDatabase, databaseConfigFromUrl, databaseOperation, DatabaseError, loadDatabaseConfig } from "./database.js";

describe("账号数据库配置与期限", () => {
  it.each(["INSERT INTO fixture VALUES (1)", null])("时钟已越过绝对期限而Timer未回调时拒绝后续SQL：%s", async statement => {
    const database = new AccountDatabase(databaseConfigFromUrl("mysql://fixture:fake@127.0.0.1:1/wf_test"));
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const sql: string[] = [];
    const connection = {
      query: vi.fn(async (options: { sql: string }) => { sql.push(options.sql); return [[], []]; }),
      destroy: vi.fn(), release: vi.fn(),
    };
    const acquire = vi.spyOn(database.pool, "getConnection").mockResolvedValue(connection as unknown as PoolConnection);
    const controller = new AbortController();
    try {
      await expect(database.transaction({ signal: controller.signal, deadline: 6_000 }, async query => {
        // 只推进读取到的时钟，不等待、不推进Timer，模拟同步编码耗尽剩余预算。
        now = 6_001;
        expect(controller.signal.aborted).toBe(false);
        if (statement !== null) await query(statement);
      })).rejects.toMatchObject({ code: "DATABASE_TIMEOUT" });
      expect(sql).toEqual(["START TRANSACTION"]);
      expect(connection.destroy).toHaveBeenCalled();
      expect(connection.release).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); acquire.mockRestore(); await database.close(); }
  });

  it("解析脱敏配置边界并拒绝 URL 附加参数及不可信数据库名", () => {
    expect(databaseConfigFromUrl("mysql://fixture:fake@127.0.0.1:3306/wf_test").database).toBe("wf_test");
    for (const raw of ["not-a-url", "postgres://secret@host/db", "mysql://fixture:secret@host/db?ssl=false", "mysql://fixture:secret@host/bad-name"]) {
      expect(() => databaseConfigFromUrl(raw)).toThrow("DATABASE_UNAVAILABLE");
      try { databaseConfigFromUrl(raw); } catch (error: unknown) {
        expect(String(error)).not.toContain("secret");
      }
    }
  });

  it("远端必须显式提供可信 CA，证书读取失败只返回固定错误", async () => {
    expect(() => databaseConfigFromUrl("mysql://fixture:fake@remote.example/wf_test")).toThrow("DATABASE_UNAVAILABLE");
    expect(databaseConfigFromUrl("mysql://fixture:fake@remote.example/wf_test", "fixture-ca").ca).toBe("fixture-ca");
    await expect(loadDatabaseConfig({ WAYFINDER_DATABASE_URL: "mysql://fixture:fake@127.0.0.1/wf_test", WAYFINDER_DATABASE_CA_FILE: "missing-fixture-ca" })).rejects.toMatchObject({ message: "DATABASE_UNAVAILABLE" });
  });

  it("取消、耗尽期限和关闭后拒绝操作且不打开连接", async () => {
    const db = new AccountDatabase(databaseConfigFromUrl("mysql://fixture:fake@127.0.0.1:1/wf_test"));
    const controller = new AbortController(); controller.abort();
    await expect(db.query(databaseOperation(controller.signal), "SELECT 1")).rejects.toMatchObject({ code: "DATABASE_CANCELLED" });
    await expect(db.query({ signal: new AbortController().signal, deadline: Date.now() - 1 }, "SELECT 1")).rejects.toMatchObject({ code: "DATABASE_TIMEOUT" });
    await db.close(); await db.close();
    await expect(db.query(databaseOperation(new AbortController().signal), "SELECT 1")).rejects.toBeInstanceOf(DatabaseError);
  });
});
