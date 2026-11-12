/**
 * 显式小组生命周期验证：仅允许回环、wf_d12_test_ 专用库，全部身份和内容均为假数据。
 * 验证真实服务事务与数据库约束；普通 CI 不运行本入口，也不读取 .env 或生产配置。
 * 所有写入使用本轮唯一身份，最终只清理这些行，不删除其他测试或人员资料。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { z } from "zod";
import type { GroupAction, GroupActionResponse, GroupErrorCode } from "@wayfinder/contracts";

import {
  AccountDatabase, databaseConfigFromUrl, databaseOperation, migrateAccountData, type DatabaseOperation,
} from "../accounts/database.js";
import { createAccountProfileStorage } from "../accounts/profile-storage.js";
import { migrateGroupData } from "./database.js";
import { createGroupStorage } from "./storage.js";

type Query = Parameters<Parameters<AccountDatabase["transaction"]>[1]>[0];

/** 故障在真实事务中发生于成员插入前，前面的真实小组写入必须随事务回滚。 */
class InterruptedMemberDatabase extends AccountDatabase {
  override transaction<T>(operation: DatabaseOperation, action: (query: Query) => Promise<T>, consistentRead = false): Promise<T> {
    return super.transaction(operation, query => action(async (sql, values) => {
      if (/INSERT INTO wf_group_members/i.test(sql)) throw new Error("fixture_member_write_interrupted");
      return query(sql, values);
    }), consistentRead);
  }
}

/**
 * 在真实昵称查询完成后暂停一次加入，让另一成员先提交；不替换查询结果或事务实现。
 * 该屏障固定复现“组锁前的普通读建立旧 RR 快照”竞态，而非依赖随机并发时序。
 */
class PausedNicknameDatabase extends AccountDatabase {
  private markPaused: (() => void) | undefined;
  private releasePaused: (() => void) | undefined;
  private pausedOnce = false;
  readonly reachedNickname = new Promise<void>(resolve => { this.markPaused = resolve; });
  private readonly released = new Promise<void>(resolve => { this.releasePaused = resolve; });

  release(): void { this.releasePaused?.(); }

  override transaction<T>(operation: DatabaseOperation, action: (query: Query) => Promise<T>, consistentRead = false): Promise<T> {
    return super.transaction(operation, query => action(async (sql, values) => {
      const result = await query(sql, values);
      if (!this.pausedOnce && /^SELECT payload FROM wf_user_data WHERE userId = \? AND recordId = \?(?: FOR SHARE)?$/i.test(sql)
        && values?.[1] === "profile") {
        this.pausedOnce = true;
        this.markPaused?.();
        await this.released;
      }
      return result;
    }), consistentRead);
  }
}

/** 在真实 SQL 调用前暂停或发出后观测，用于精确安排解散与成员动作争用同一组锁。 */
class ObservedGroupQueryDatabase extends AccountDatabase {
  beforeQuery: ((sql: string, values: Parameters<Query>[1]) => Promise<void>) | undefined;
  issuedQuery: ((sql: string, values: Parameters<Query>[1]) => void) | undefined;

  override transaction<T>(operation: DatabaseOperation, action: (query: Query) => Promise<T>, consistentRead = false): Promise<T> {
    return super.transaction(operation, query => action(async (sql, values) => {
      await this.beforeQuery?.(sql, values);
      const pending = query(sql, values);
      this.issuedQuery?.(sql, values);
      return pending;
    }), consistentRead);
  }
}

const gate = () => {
  let release: () => void = () => {};
  const reached = new Promise<void>(resolve => { release = resolve; });
  return { reached, release };
};
const observe = <T>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }),
  (error: unknown) => ({ ok: false as const, error }));

/** 屏障必须在有限时间内到达；即使实现路径改变，也不能把显式验证挂起。 */
async function awaitGate(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("事务屏障未在期限内到达")), 2_000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

const details = (response: GroupActionResponse) => {
  assert.ok(response.details);
  return response.details;
};
const rejectCode = async (promise: Promise<unknown>, code: GroupErrorCode | "DATABASE_UNAVAILABLE" | "DATABASE_CANCELLED") => {
  await assert.rejects(promise, { code });
};

let database: AccountDatabase | undefined;
let interrupted: InterruptedMemberDatabase | undefined;
let paused: PausedNicknameDatabase | undefined;
let dissolving: ObservedGroupQueryDatabase | undefined;
let waiting: ObservedGroupQueryDatabase | undefined;
let releaseDelete: (() => void) | undefined;
try {
  const raw = process.env.WF_TEST_MYSQL_URL;
  if (!raw) throw new Error("缺少测试配置");
  const config = databaseConfigFromUrl(raw);
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host)
    || !/^wf_d12_test_[A-Za-z0-9_]+$/.test(config.database)) throw new Error("非隔离测试库");
  database = new AccountDatabase(config);
  const db = database, operation = () => databaseOperation(new AbortController().signal, 5_000);
  const runId = randomUUID();
  const identity = (name: string, email = `${name}@example.com`) => ({
    userId: `${name}_${runId}`, sessionId: `session_${name}_${runId}`, email,
  });
  const ownerA = identity("fixtureOwnerA", "fixture+ownerA@example.com"), ownerB = identity("fixtureOwnerB");
  const member = identity("fixtureMember"), concurrentMember = identity("fixtureConcurrent");
  const outsider = identity("fixtureOutsider"), unnamed = identity("fixtureUnnamed");
  const identities = [ownerA, ownerB, member, concurrentMember, outsider, unnamed];
  const groupIds = new Set<string>();
  const createId = () => { const id = randomUUID(); groupIds.add(id); return id; };
  const suffix = runId.replaceAll("-", "").slice(0, 20), nextSuffix = suffix.slice(0, 19) + (suffix.at(-1) === "A" ? "B" : "A");
  const storage = createGroupStorage(db, { createId, createSuffix: () => suffix });
  const profile = createAccountProfileStorage(db);
  const mutation = () => randomUUID();
  const groupCount = async (groupId: string): Promise<number> => {
    const rows = z.array(z.object({ total: z.number() })).parse(await db.query(operation(),
      "SELECT COUNT(*) AS total FROM wf_groups WHERE groupId = ?", [groupId]));
    return rows[0]?.total ?? 0;
  };
  const userRowCount = async (userId: string): Promise<number> => {
    const rows = z.array(z.object({ total: z.number() })).parse(await db.query(operation(),
      "SELECT COUNT(*) AS total FROM wf_user_data WHERE userId = ?", [userId]));
    return rows[0]?.total ?? 0;
  };

  await migrateAccountData(db, operation());
  await migrateGroupData(db, operation());
  let cleanupFailed = false;
  try {
    for (const person of identities.filter(person => person !== unnamed)) {
      await profile.write(person.userId, person === ownerB ? "另一位成员" : "同名成员", operation());
    }
    await rejectCode(storage.write(unnamed, { action: "create", name: "未命名账号的组", description: "", mutationId: mutation() }, operation()), "NICKNAME_REQUIRED");
    assert.deepEqual(await storage.list(unnamed.userId, operation()), { groups: [] });

    const createAction: GroupAction = { action: "create", name: "共同图资料", description: "假小组说明", mutationId: mutation() };
    const created = details(await storage.write(ownerA, createAction, operation()));
    const groupA = created.group.groupId;
    assert.equal(created.invitationCode, `${ownerA.email}#${suffix}`);
    assert.deepEqual(created.members, [{ userId: ownerA.userId, nickname: "同名成员", role: "owner" }]);
    const invitationA = created.invitationCode;
    assert.ok(invitationA);
    assert.equal(details(await storage.write(ownerA, createAction, operation())).group.groupId, groupA);
    await rejectCode(storage.write(ownerA, { ...createAction, name: "不同内容不能复用同一动作标识" }, operation()), "GROUP_CONFLICT");

    const createActionB: GroupAction = { action: "create", name: "另一组", description: "", mutationId: mutation() };
    const createdB = details(await storage.write(ownerB, createActionB, operation()));
    assert.equal(createdB.invitationCode, `${ownerB.email}#${suffix}`);
    assert.notEqual(createdB.invitationCode, invitationA);
    let suffixAttempts = 0;
    const collisionStorage = createGroupStorage(db, { createId, createSuffix: () => ++suffixAttempts === 1 ? suffix : nextSuffix });
    const sameOwnerGroup = details(await collisionStorage.write(ownerA,
      { action: "create", name: "同一创建者的第二组", description: "", mutationId: mutation() }, operation()));
    assert.equal(suffixAttempts, 2);
    assert.equal(sameOwnerGroup.invitationCode, `${ownerA.email}#${nextSuffix}`);
    let exhaustedAttempts = 0;
    const exhaustedStorage = createGroupStorage(db, { createId, createSuffix: () => { exhaustedAttempts++; return suffix; } });
    await rejectCode(exhaustedStorage.write(ownerA,
      { action: "create", name: "碰撞不无限重试", description: "", mutationId: mutation() }, operation()), "GROUP_CONFLICT");
    assert.equal(exhaustedAttempts, 3);

    await rejectCode(storage.read(outsider.userId, groupA, operation()), "GROUP_FORBIDDEN");
    assert.deepEqual(await storage.list(outsider.userId, operation()), { groups: [] });
    await rejectCode(storage.write(unnamed, { action: "join", invitationCode: invitationA, mutationId: mutation() }, operation()), "NICKNAME_REQUIRED");
    const joinAction: GroupAction = { action: "join", invitationCode: invitationA, mutationId: mutation() };
    const joined = details(await storage.write(member, joinAction, operation()));
    assert.equal(joined.invitationCode, null);
    assert.equal(joined.members.length, 2);
    assert.equal(new Set(joined.members.map(person => person.userId)).size, 2);
    assert.deepEqual(joined.members.map(person => person.nickname), ["同名成员", "同名成员"]);
    assert.equal((await storage.read(member.userId, groupA, operation())).invitationCode, null);
    await Promise.all([0, 1].map(() => storage.write(concurrentMember,
      { action: "join", invitationCode: invitationA, mutationId: mutation() }, operation())));
    assert.equal((await storage.read(ownerA.userId, groupA, operation())).members.filter(person => person.userId === concurrentMember.userId).length, 1);

    // 甲已读昵称但尚未锁组时，乙完成加入；甲随后返回的组版本与成员必须同属最新快照。
    const invitationB = createdB.invitationCode;
    assert.ok(invitationB);
    paused = new PausedNicknameDatabase(config);
    const pausedStorage = createGroupStorage(paused);
    const joiningAfterPause = pausedStorage.write(member,
      { action: "join", invitationCode: invitationB, mutationId: mutation() }, operation());
    // 先连接拒绝处理，防屏障分支失败时遗留未经观察的异步拒绝；最终仍显式取回结果或错误。
    const observedJoin = observe(joiningAfterPause);
    const concurrentJoinBAction: GroupAction = { action: "join", invitationCode: invitationB, mutationId: mutation() };
    try {
      await awaitGate(paused.reachedNickname);
      await storage.write(concurrentMember, concurrentJoinBAction, operation());
    } finally { paused.release(); }
    const observed = await observedJoin;
    if (!observed.ok) throw observed.error;
    const joinedAfterPause = details(observed.value);
    const latestAfterJoin = await storage.read(ownerB.userId, createdB.group.groupId, operation());
    assert.equal(joinedAfterPause.group.revision, latestAfterJoin.group.revision);
    assert.deepEqual(joinedAfterPause.members, latestAfterJoin.members);
    assert.equal(joinedAfterPause.members.length, 3);

    const deniedUpdate: GroupAction = { action: "update", groupId: groupA, name: "越权改名", description: "", expectedRevision: created.group.revision, mutationId: mutation() };
    await rejectCode(storage.write(member, deniedUpdate, operation()), "GROUP_FORBIDDEN");
    await rejectCode(storage.write(member, { action: "dissolve", groupId: groupA, expectedRevision: created.group.revision, mutationId: mutation() }, operation()), "GROUP_FORBIDDEN");
    await rejectCode(storage.write(ownerA, { action: "leave", groupId: groupA, mutationId: mutation() }, operation()), "GROUP_FORBIDDEN");

    const current = await storage.read(ownerA.userId, groupA, operation());
    const updateAction: GroupAction = { action: "update", groupId: groupA, name: "已修改名称", description: "已修改说明", expectedRevision: current.group.revision, mutationId: mutation() };
    const updated = details(await storage.write(ownerA, updateAction, operation()));
    assert.equal(updated.group.revision, current.group.revision + 1);
    assert.equal(updated.group.description, "已修改说明");
    assert.equal(details(await storage.write(ownerA, updateAction, operation())).group.revision, updated.group.revision);
    await rejectCode(storage.write(ownerA, { ...updateAction, mutationId: mutation() }, operation()), "GROUP_CONFLICT");

    const recordId = `contribution_${runId}`;
    await db.query(operation(), "INSERT INTO wf_group_data (groupId, recordId, payload) VALUES (?, ?, ?)",
      [groupA, recordId, JSON.stringify({ text: "退出者已经生效的贡献" })]);
    await storage.write(member, { action: "leave", groupId: groupA, mutationId: mutation() }, operation());
    await rejectCode(storage.read(member.userId, groupA, operation()), "GROUP_FORBIDDEN");
    assert.equal((await storage.write(member, joinAction, operation())).details, null);
    assert.ok(!(await storage.list(member.userId, operation())).groups.some(group => group.groupId === groupA));
    const contributions = z.array(z.object({ payload: z.unknown() })).parse(await db.query(operation(),
      "SELECT payload FROM wf_group_data WHERE groupId = ? AND recordId = ?", [groupA, recordId]));
    assert.equal(contributions.length, 1);

    // 在真实连接和事务中中断第二张表写入，验证无部分小组、成员或幂等收据残留。
    interrupted = new InterruptedMemberDatabase(config);
    const beforeRows = await userRowCount(ownerA.userId);
    const interruptedGroupId = createId();
    const interruptedStorage = createGroupStorage(interrupted, { createId: () => interruptedGroupId, createSuffix: () => "R".repeat(20) });
    await rejectCode(interruptedStorage.write(ownerA,
      { action: "create", name: "事务故障假组", description: "", mutationId: mutation() }, operation()), "DATABASE_UNAVAILABLE");
    assert.equal(await groupCount(interruptedGroupId), 0);
    assert.equal(await userRowCount(ownerA.userId), beforeRows);
    const cancelled = new AbortController(); cancelled.abort();
    await rejectCode(storage.write(ownerA,
      { action: "create", name: "取消不能写入", description: "", mutationId: mutation() }, databaseOperation(cancelled.signal)), "DATABASE_CANCELLED");

    const beforeDissolve = await storage.read(ownerA.userId, groupA, operation());
    await storage.write(ownerA, { action: "dissolve", groupId: groupA, expectedRevision: beforeDissolve.group.revision, mutationId: mutation() }, operation());
    assert.equal(await groupCount(groupA), 0);
    await rejectCode(storage.read(ownerA.userId, groupA, operation()), "GROUP_NOT_FOUND");
    assert.equal((await storage.write(ownerA, createAction, operation())).details, null);
    assert.equal((await storage.write(member, joinAction, operation())).details, null);
    assert.equal(await groupCount(groupA), 0);
    await rejectCode(storage.write(member, { action: "join", invitationCode: invitationA, mutationId: mutation() }, operation()), "GROUP_NOT_FOUND");
    await rejectCode(storage.write(concurrentMember, { action: "join", invitationCode: invitationA, mutationId: mutation() }, operation()), "GROUP_NOT_FOUND");
    assert.equal(await groupCount(createdB.group.groupId), 1);
    assert.equal(await groupCount(sameOwnerGroup.group.groupId), 1);
    for (const table of ["wf_group_members", "wf_group_data"] as const) {
      const rows = z.array(z.object({ total: z.number() })).parse(await db.query(operation(),
        `SELECT COUNT(*) AS total FROM ${table} WHERE groupId = ?`, [groupA]));
      assert.equal(rows[0]?.total, 0);
    }

    // 解散者已持有组锁、尚未 DELETE 时，成员退出真正发出同组 FOR UPDATE 后必须等待。
    // 释放解散事务后，等待者只能拒绝，不能凭锁前的成员身份保留访问或复活任何组数据。
    const groupB = createdB.group.groupId, deleteReached = gate(), allowDelete = gate(), lockIssued = gate();
    releaseDelete = allowDelete.release;
    dissolving = new ObservedGroupQueryDatabase(config);
    dissolving.beforeQuery = async (sql, values) => {
      if (/^DELETE FROM wf_groups WHERE groupId = \?$/i.test(sql) && values?.[0] === groupB) {
        deleteReached.release();
        await allowDelete.reached;
      }
    };
    waiting = new ObservedGroupQueryDatabase(config);
    waiting.issuedQuery = (sql, values) => {
      if (/^SELECT groupId, ownerUserId, invitationCode, payload FROM wf_groups WHERE groupId = \? FOR UPDATE$/i.test(sql)
        && values?.[0] === groupB) lockIssued.release();
    };
    await db.query(operation(), "INSERT INTO wf_group_data (groupId, recordId, payload) VALUES (?, ?, ?)",
      [groupB, `dissolve_${runId}`, JSON.stringify({ text: "解散竞争中的假图" })]);
    const beforeCompetingDissolve = await storage.read(ownerB.userId, groupB, operation());
    const observedDissolve = observe(createGroupStorage(dissolving).write(ownerB,
      { action: "dissolve", groupId: groupB, expectedRevision: beforeCompetingDissolve.group.revision, mutationId: mutation() }, operation()));
    let observedWaiting: ReturnType<typeof observe<GroupActionResponse>> | undefined;
    try {
      await awaitGate(deleteReached.reached);
      observedWaiting = observe(createGroupStorage(waiting).write(member,
        { action: "leave", groupId: groupB, mutationId: mutation() }, operation()));
      await awaitGate(lockIssued.reached);
    } finally { allowDelete.release(); }
    const dissolvedResult = await observedDissolve;
    if (!dissolvedResult.ok) throw dissolvedResult.error;
    assert.equal(dissolvedResult.value.details, null);
    assert.ok(observedWaiting);
    const waitingResult = await observedWaiting;
    assert.equal(waitingResult.ok, false);
    if (!waitingResult.ok) assert.equal(z.object({ code: z.string() }).parse(waitingResult.error).code, "GROUP_NOT_FOUND");
    assert.equal(await groupCount(groupB), 0);
    for (const table of ["wf_group_members", "wf_group_data"] as const) {
      const rows = z.array(z.object({ total: z.number() })).parse(await db.query(operation(),
        `SELECT COUNT(*) AS total FROM ${table} WHERE groupId = ?`, [groupB]));
      assert.equal(rows[0]?.total, 0);
    }
    assert.equal((await storage.write(ownerB, createActionB, operation())).details, null);
    assert.equal((await storage.write(concurrentMember, concurrentJoinBAction, operation())).details, null);
    assert.equal(await groupCount(groupB), 0);
  } finally {
    const cleanup = await Promise.allSettled([
      ...[...groupIds].map(groupId => db.query(operation(), "DELETE FROM wf_groups WHERE groupId = ?", [groupId])),
      ...identities.map(person => db.query(operation(), "DELETE FROM wf_user_data WHERE userId = ?", [person.userId])),
    ]);
    cleanupFailed = cleanup.some(result => result.status === "rejected");
  }
  if (cleanupFailed) throw new Error("本轮假数据未完全清理");
  console.info("小组生命周期真实 SQL：昵称门禁／创建加入读取／角色与重名隔离／邮箱后缀碰撞／幂等冲突／并发加入／昵称读取屏障后的完整成员快照／退出贡献／事务回滚／取消／并发解散与迟到重试通过");
} catch {
  console.error("小组生命周期隔离验证失败；核对本地测试库和服务边界，不输出原始异常或配置");
  process.exitCode = 1;
} finally {
  releaseDelete?.();
  await waiting?.close();
  await dissolving?.close();
  paused?.release();
  await paused?.close();
  await interrupted?.close();
  await database?.close();
}
