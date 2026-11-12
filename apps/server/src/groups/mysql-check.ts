/**
 * 显式 SQL 集成验证：只接收回环专用测试库配置，不读取 .env 或生产配置。
 * 覆盖迁移幂等、昵称与组分区、邀请码唯一、外键、事务回滚和解散级联所需的真实 SQL 边界。
 * 所有行使用本轮随机标识；清理仅删除这些假数据，普通 CI 不执行本入口。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { z } from "zod";

import {
  AccountDatabase, databaseConfigFromUrl, databaseOperation, migrateAccountData, userDataAccess,
} from "../accounts/database.js";
import { createAccountProfileStorage } from "../accounts/profile-storage.js";
import { migrateGroupData } from "./database.js";

let database: AccountDatabase | undefined;
try {
  const raw = process.env.WF_TEST_MYSQL_URL;
  if (!raw) throw new Error("缺少测试配置");
  const config = databaseConfigFromUrl(raw);
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host)
    || !/^wf_d12_test_[A-Za-z0-9_]+$/.test(config.database)) throw new Error("非隔离测试库");
  database = new AccountDatabase(config);
  const db = database;
  const operation = () => databaseOperation(new AbortController().signal, 5_000);
  const id = randomUUID(), userA = `fixtureA_${id}`, userB = `fixtureB_${id}`;
  const groupA = `groupA_${id}`, groupB = `groupB_${id}`, rollbackGroup = `rollback_${id}`;
  const missingGroup = `missing_${id}`, duplicateGroup = `duplicate_${id}`;
  const suffix = id.replaceAll("-", "").slice(0, 20);
  const invitationA = `fixtureA@example.com#${suffix}`, invitationB = `fixtureB@example.com#${suffix}`;
  const personal = userDataAccess(db, userA), other = userDataAccess(db, userB);
  const profiles = createAccountProfileStorage(db);
  const count = async (table: "wf_groups" | "wf_group_members" | "wf_group_data", groupId: string): Promise<number> => {
    // 表名仅来自本模块的三个固定字面量；归属值始终参数化，调用者无法注入 SQL。
    const result = await db.query(operation(), `SELECT COUNT(*) AS total FROM ${table} WHERE groupId = ?`, [groupId]);
    return z.array(z.object({ total: z.number() })).parse(result)[0]?.total ?? 0;
  };
  const insertGroup = async (groupId: string, ownerUserId: string, invitation: string): Promise<void> => {
    await db.query(operation(), "INSERT INTO wf_groups (groupId, ownerUserId, invitationCode, payload) VALUES (?, ?, ?, ?)",
      [groupId, ownerUserId, invitation, JSON.stringify({ name: "假小组", revision: 1 })]);
  };

  await migrateAccountData(db, operation());
  await personal.put(operation(), id, { text: "既有个人图与🌏", revision: 1 });
  try {
    // 新迁移重复执行后仍保留既有个人记录；不通过重建旧表实现兼容。
    await migrateGroupData(db, operation());
    await migrateAccountData(db, operation());
    await migrateGroupData(db, operation());
    assert.deepEqual(await personal.read(operation(), id), { text: "既有个人图与🌏", revision: 1 });
    assert.equal(await other.read(operation(), id), null);

    assert.deepEqual(await profiles.read(userA, operation()), { userId: userA, nickname: null });
    assert.deepEqual(await profiles.write(userA, "  小组成员  ", operation()), { userId: userA, nickname: "小组成员" });
    assert.deepEqual(await profiles.read(userB, operation()), { userId: userB, nickname: null });
    await profiles.write(userB, "小组成员", operation());
    await profiles.write(userA, "修改后的昵称", operation());
    assert.deepEqual(await profiles.read(userB, operation()), { userId: userB, nickname: "小组成员" });

    // 相同随机后缀、不同创建者邮箱允许并存；完整码相同则由唯一约束拒绝。
    await insertGroup(groupA, userA, invitationA);
    await insertGroup(groupB, userB, invitationB);
    await assert.rejects(insertGroup(duplicateGroup, userA, invitationA), { message: "DATABASE_UNAVAILABLE" });
    assert.equal(await count("wf_groups", duplicateGroup), 0);

    await db.query(operation(), "INSERT INTO wf_group_members (groupId, userId) VALUES (?, ?), (?, ?)",
      [groupA, userA, groupB, userB]);
    await db.query(operation(), "INSERT INTO wf_group_data (groupId, recordId, payload) VALUES (?, ?, ?), (?, ?, ?)",
      [groupA, id, JSON.stringify({ group: "A" }), groupB, id, JSON.stringify({ group: "B" })]);
    const payloads = z.array(z.object({ payload: z.unknown() })).parse(await db.query(operation(),
      "SELECT payload FROM wf_group_data WHERE groupId = ? AND recordId = ?", [groupB, id]));
    const payload = payloads[0]?.payload;
    assert.deepEqual(typeof payload === "string" ? JSON.parse(payload) as unknown : payload, { group: "B" });
    const members = z.array(z.object({ userId: z.string() })).parse(await db.query(operation(),
      "SELECT userId FROM wf_group_members WHERE groupId = ?", [groupA]));
    assert.deepEqual(members, [{ userId: userA }]);

    await assert.rejects(db.query(operation(), "INSERT INTO wf_group_members (groupId, userId) VALUES (?, ?)",
      [missingGroup, userA]), { message: "DATABASE_UNAVAILABLE" });
    await assert.rejects(db.query(operation(), "INSERT INTO wf_group_data (groupId, recordId, payload) VALUES (?, ?, ?)",
      [missingGroup, id, JSON.stringify({ invalid: true })]), { message: "DATABASE_UNAVAILABLE" });

    // 中途失败必须回滚小组、成员及图三处写入，不能留下只有部分关系的假成功。
    await assert.rejects(db.transaction(operation(), async query => {
      await query("INSERT INTO wf_groups (groupId, ownerUserId, invitationCode, payload) VALUES (?, ?, ?, ?)",
        [rollbackGroup, userA, `rollback@example.com#${suffix}`, JSON.stringify({ name: "回滚假组" })]);
      await query("INSERT INTO wf_group_members (groupId, userId) VALUES (?, ?)", [rollbackGroup, userA]);
      await query("INSERT INTO wf_group_data (groupId, recordId, payload) VALUES (?, ?, ?)",
        [rollbackGroup, id, JSON.stringify({ rollback: true })]);
      await query("INSERT INTO wf_groups (groupId, ownerUserId, invitationCode, payload) VALUES (?, ?, ?, ?)",
        [duplicateGroup, userB, invitationB, JSON.stringify({ invalid: true })]);
    }), { message: "DATABASE_UNAVAILABLE" });
    for (const table of ["wf_groups", "wf_group_members", "wf_group_data"] as const) {
      assert.equal(await count(table, rollbackGroup), 0);
    }

    await db.query(operation(), "DELETE FROM wf_groups WHERE groupId = ?", [groupA]);
    assert.equal(await count("wf_group_members", groupA), 0);
    assert.equal(await count("wf_group_data", groupA), 0);
    assert.equal(await count("wf_group_members", groupB), 1);
    assert.equal(await count("wf_group_data", groupB), 1);
    assert.deepEqual(await personal.read(operation(), id), { text: "既有个人图与🌏", revision: 1 });
  } finally {
    // 只清理本轮已知假标识；不 DROP 表／数据库，也不删除其他测试或人员资料。
    for (const groupId of [groupA, groupB, rollbackGroup, duplicateGroup]) {
      await db.query(operation(), "DELETE FROM wf_groups WHERE groupId = ?", [groupId]);
    }
    await personal.remove(operation(), id);
    await personal.remove(operation(), "profile");
    await other.remove(operation(), "profile");
  }
  console.info("小组 MySQL 真实驱动：迁移幂等／个人数据保留／昵称隔离／完整邀请码唯一／外键／组隔离／事务回滚／级联删除通过");
} catch {
  console.error("小组 MySQL 隔离验证失败；核对回环测试配置和迁移，不输出原始异常或配置");
  process.exitCode = 1;
} finally { await database?.close(); }
