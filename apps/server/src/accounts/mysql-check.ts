/**
 * 显式 SQL 集成验证：仅允许回环专用测试库，使用假用户/数据，绝不读取生产配置。
 * 普通 CI 不调用本入口；拒绝缺失配置，不能把跳过数据库验证写成成功。
 */
import assert from "node:assert/strict";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { AccountDatabase, databaseConfigFromUrl, databaseOperation, migrateAccountData, userDataAccess } from "./database.js";

let database: AccountDatabase | undefined;
try {
  const raw = process.env.WF_TEST_MYSQL_URL;
  if (!raw) throw new Error("缺少测试配置");
  const config = databaseConfigFromUrl(raw);
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host) || !/^wf_d11_test_[A-Za-z0-9_]+$/.test(config.database)) throw new Error("非隔离测试库");
  database = new AccountDatabase(config);
  const db = database;
  const operation = () => databaseOperation(new AbortController().signal, 5_000);
  await migrateAccountData(db, operation());
  await migrateAccountData(db, operation());
  const id = randomUUID(), a = userDataAccess(db, `fixtureA_${id}`), b = userDataAccess(db, `fixtureB_${id}`);
  try {
    await a.put(operation(), id, { text: "中文与🌏", revision: 1 });
    assert.deepEqual(await a.read(operation(), id), { text: "中文与🌏", revision: 1 });
    assert.equal(await b.read(operation(), id), null);
    await b.remove(operation(), id);
    assert.notEqual(await a.read(operation(), id), null);
    await b.put(operation(), id, { owner: "B" });
    await a.put(operation(), id, { text: "更新", revision: 2 });
    assert.deepEqual(await b.read(operation(), id), { owner: "B" });
    assert.deepEqual(await a.read(operation(), id), { text: "更新", revision: 2 });
    const rollbackId = `rollback_${id}`;
    await assert.rejects(db.transaction(operation(), async query => {
      const values = [`fixtureA_${id}`, rollbackId, JSON.stringify({ rollback: true })];
      await query("INSERT INTO wf_user_data (userId, recordId, payload) VALUES (?, ?, ?)", values);
      await query("INSERT INTO wf_user_data (userId, recordId, payload) VALUES (?, ?, ?)", values);
    }), { message: "DATABASE_UNAVAILABLE" });
    assert.equal(await a.read(operation(), rollbackId), null);
    await assert.rejects(db.query(databaseOperation(new AbortController().signal, 50), "SELECT SLEEP(2)"), { message: "DATABASE_TIMEOUT" });
    const cancelled = new AbortController();
    const pending = db.query(databaseOperation(cancelled.signal), "SELECT SLEEP(2)");
    setTimeout(() => cancelled.abort(), 50);
    await assert.rejects(pending, { message: "DATABASE_CANCELLED" });
    await a.remove(operation(), id);
    assert.equal(await a.read(operation(), id), null);
    // 超时/取消毁掉的连接不能破坏后续池连接和正常操作。
    assert.deepEqual(await b.read(operation(), id), { owner: "B" });
  } finally {
    await a.remove(operation(), id); await b.remove(operation(), id);
  }
  console.info("MySQL 真实驱动：迁移/增删改查/事务回滚/双用户隔离/期限/取消通过");
} catch {
  console.error("MySQL 隔离验证失败；检查回环测试配置及数据库，不输出原始异常或秘密");
  process.exitCode = 1;
} finally { await database?.close(); }
