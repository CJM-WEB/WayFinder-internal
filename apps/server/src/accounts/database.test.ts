/** 确定性边界检查；普通 CI 只验证配置和拒绝路径，不连接真实数据库。 */
import { describe, expect, it } from "vitest";

import { AccountDatabase, databaseConfigFromUrl, databaseOperation, DatabaseError, loadDatabaseConfig } from "./database.js";

describe("账号数据库配置与期限", () => {
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
