/**
 * 显式实时集成验证：回环 HTTP 双客户端＋隔离 MySQL，假可信会话，不读取 .env 或调用真实 Provider。
 * 覆盖原子快照、提交后广播、连接证明、丢确认收据、资格撤销及连接清理。
 * 所有等待有界；断流通过服务端响应关闭事件确认，不用 sleep 猜测证明失效时机。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { z } from "zod";
import type { PoolConnection } from "mysql2/promise";
import type { FastifyInstance } from "fastify";
import {
  CLOUD_ACCOUNT_HEADER, GROUP_CONNECTION_HEADER, EditableGraphSchema, GroupActionResponseSchema,
  GroupErrorResponseSchema, GroupGraphReceiptResponseSchema, GroupGraphWriteResponseSchema, GroupSyncEventSchema,
  UserIdSchema, type GroupGraphAction, type GroupGraphRecord, type GroupSyncEvent,
} from "@wayfinder/contracts";

import { buildServer } from "../app.js";
import type { AccountAuth, AccountIdentity } from "../accounts/auth.js";
import { AccountDatabase, databaseConfigFromUrl, databaseOperation, migrateAccountData, type DatabaseOperation } from "../accounts/database.js";
import { createAccountProfileStorage } from "../accounts/profile-storage.js";
import { registerGroupRoutes } from "../routes/groups.js";
import { registerGroupSyncRoutes } from "../routes/group-sync.js";
import { registerGroupWorkspaceRoutes } from "../routes/group-workspace.js";
import { migrateGroupData } from "./database.js";
import { createGroupStorage } from "./storage.js";
import { createGroupSync, readGroupSyncSnapshot } from "./sync.js";
import { createGroupWorkspaceStorage } from "./workspace-storage.js";

const gate = () => {
  let release: () => void = () => {};
  const reached = new Promise<void>(resolve => { release = resolve; });
  return { reached, release };
};
async function bounded<T>(promise: Promise<T>, milliseconds = 2_000, timeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { timeout?.(); reject(new Error("实时验证等待超时")); }, milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** 观测真实连接租用结束；长连接存活本身不能一直占用数据库事务或池连接。 */
class TrackedDatabase extends AccountDatabase {
  activeOperations = 0;
  private readonly idleWaiters = new Set<() => void>();
  override async withConnection<T>(operation: DatabaseOperation,
    action: (connection: PoolConnection, signal: AbortSignal) => Promise<T>): Promise<T> {
    this.activeOperations++;
    try { return await super.withConnection(operation, action); }
    finally {
      this.activeOperations--;
      if (this.activeOperations === 0) { for (const done of this.idleWaiters) done(); this.idleWaiters.clear(); }
    }
  }
  idle(): Promise<void> {
    return this.activeOperations === 0 ? Promise.resolve() : new Promise(resolve => { this.idleWaiters.add(resolve); });
  }
}

/** 逐行解析真实响应；每次等目标事件使用同一绝对期限，心跳不能无限延长失败等待。 */
class SyncClient {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private sequence: number | undefined;
  private ended = false;
  constructor(response: Response, readonly controller: AbortController, readonly closed: Promise<void>) {
    assert.ok(response.body);
    this.reader = response.body.getReader();
  }
  private async event(deadline: number): Promise<GroupSyncEvent | null> {
    while (!this.ended) {
      const left = deadline - Date.now(); if (left <= 0) throw new Error("实时目标事件未按时到达");
      const newline = this.buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const parsed: unknown = JSON.parse(line), result = GroupSyncEventSchema.parse(parsed);
        if (result.type === "snapshot") assert.equal(Object.keys(parsed as object).at(-1), "connectionId");
        if ("sequence" in result) {
          if (this.sequence !== undefined) assert.equal(result.sequence, this.sequence + 1);
          this.sequence = result.sequence;
        }
        return result;
      }
      const chunk = await bounded(this.reader.read(), left, () => this.controller.abort());
      if (chunk.done) { this.ended = true; assert.equal(this.buffer.trim(), ""); return null; }
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
    return null;
  }
  async snapshot(predicate: (event: Extract<GroupSyncEvent, { type: "snapshot" }>) => boolean = () => true) {
    const deadline = Date.now() + 2_000;
    while (true) {
      const event = await this.event(deadline); assert.ok(event);
      if (event.type === "snapshot" && predicate(event)) {
        assert.equal(event.details.group.revision, event.workspace.revision);
        assert.equal(event.details.group.groupId, event.workspace.groupId);
        return event;
      }
      assert.notEqual(event.type, "revoked"); assert.notEqual(event.type, "renew");
    }
  }
  async revoked(code: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    let revoked = false;
    while (true) {
      const event = await this.event(deadline);
      if (event === null) break;
      assert.notEqual(event.type, "snapshot", "资格失效后不得继续输出小组正文");
      if (event.type === "revoked") { assert.equal(event.code, code); revoked = true; }
    }
    assert.equal(revoked, true);
    await bounded(this.closed);
  }
  async close(): Promise<void> {
    this.controller.abort();
    try { await this.reader.cancel(); } catch { /* 主动取消已关闭的测试流是预期清理路径。 */ }
    await bounded(this.closed);
  }
}

/**
 * 重启专用子进程只提供同步读取；它没有父进程的连接内存，必须从同一隔离库恢复权威快照。
 * 假身份经IPC启动环境传入，仍严格限制回环测试库；退出时关闭流、HTTP和数据库池。
 */
async function runRestartWorker(): Promise<void> {
  let database: AccountDatabase | undefined, server: FastifyInstance | undefined;
  let sync: ReturnType<typeof createGroupSync> | undefined;
  try {
    const raw = process.env.WF_TEST_MYSQL_URL; if (!raw) throw new Error("缺少测试配置");
    const config = databaseConfigFromUrl(raw);
    if (!["127.0.0.1", "localhost", "::1"].includes(config.host)
      || !/^wf_d12_test_[A-Za-z0-9_]+$/.test(config.database)) throw new Error("非隔离测试库");
    const identity = z.strictObject({ userId: UserIdSchema, sessionId: UserIdSchema, email: z.email() })
      .parse(JSON.parse(process.env.WF_SYNC_FIXTURE_IDENTITY ?? "null") as unknown);
    database = new AccountDatabase(config); const db = database;
    const auth: Pick<AccountAuth, "getIdentity"> = { async getIdentity(headers, operation) {
      operation.signal.throwIfAborted(); return headers.get("cookie") === `fixture=${identity.userId}` ? identity : null;
    } };
    sync = createGroupSync({ auth, readSnapshot: (userId, groupId, operation) => readGroupSyncSnapshot(db, userId, groupId, operation),
      heartbeatMs: 100, leaseMs: 5_000 });
    server = buildServer(); registerGroupSyncRoutes(server, { auth, sync, publicOrigin: null });
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    assert.ok(process.send); process.send({ type: "ready", origin });
    await bounded(new Promise<void>(resolve => {
      process.once("message", message => { if (message === "stop") resolve(); });
      process.once("disconnect", resolve);
    }), 10_000);
  } catch {
    console.error("实时重启假进程验证失败，不输出配置或原始异常"); process.exitCode = 1;
  } finally {
    await sync?.close(); await server?.close(); await database?.close();
    if (process.connected) process.disconnect();
  }
}

async function snapshotFromFreshProcess(identity: AccountIdentity, groupId: string) {
  const child = fork(fileURLToPath(import.meta.url), ["--restart-fixture-worker"], {
    env: { ...process.env, WF_SYNC_FIXTURE_IDENTITY: JSON.stringify(identity) }, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exited = new Promise<number | null>(resolve => { child.once("exit", code => resolve(code)); });
  const ready = new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("message", message => {
      const parsed = z.strictObject({ type: z.literal("ready"), origin: z.url() }).safeParse(message);
      if (parsed.success) resolve(parsed.data.origin); else reject(new Error("假进程未返回就绪状态"));
    });
  });
  const controller = new AbortController();
  try {
    assert.notEqual(child.pid, process.pid);
    const origin = await bounded(ready);
    assert.equal(new URL(origin).hostname, "127.0.0.1");
    const response = await bounded(fetch(`${origin}/api/group-sync?groupId=${encodeURIComponent(groupId)}`, {
      headers: { origin, cookie: `fixture=${identity.userId}`, [CLOUD_ACCOUNT_HEADER]: identity.userId }, signal: controller.signal,
    }), 2_000, () => controller.abort());
    assert.equal(response.status, 200);
    const client = new SyncClient(response, controller, exited.then(() => {}));
    const snapshot = await client.snapshot();
    child.send("stop"); await client.close(); assert.equal(await bounded(exited), 0);
    return snapshot;
  } finally {
    controller.abort();
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM"); await bounded(exited);
    }
  }
}

if (process.argv.includes("--restart-fixture-worker")) {
  await runRestartWorker();
} else {

let database: TrackedDatabase | undefined;
let server: FastifyInstance | undefined;
let sync: ReturnType<typeof createGroupSync> | undefined;
const clients: SyncClient[] = [];
let releaseInitialSnapshot: (() => void) | undefined;
try {
  const raw = process.env.WF_TEST_MYSQL_URL;
  if (!raw) throw new Error("缺少测试配置");
  const config = databaseConfigFromUrl(raw);
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host)
    || !/^wf_d12_test_[A-Za-z0-9_]+$/.test(config.database)) throw new Error("非隔离测试库");
  database = new TrackedDatabase(config);
  const db = database, operation = () => databaseOperation(new AbortController().signal, 5_000);
  const runId = randomUUID(), mutation = () => randomUUID();
  const identity = (label: string): AccountIdentity => ({ userId: `${label}_${runId}`, sessionId: `session_${label}_${runId}`, email: `${label}@example.com` });
  const a = identity("fixtureSyncA"), b = identity("fixtureSyncB"), cookieA = `fixture=${a.userId}`, cookieB = `fixture=${b.userId}`;
  const sessions = new Map<string, AccountIdentity>([[cookieA, a], [cookieB, b]]);
  const auth: Pick<AccountAuth, "getIdentity"> = { async getIdentity(headers, operation) {
    operation.signal.throwIfAborted(); return sessions.get(headers.get("cookie") ?? "") ?? null;
  } };
  const groupIds = new Set<string>(), groups = createGroupStorage(db), workspace = createGroupWorkspaceStorage(db);
  const profiles = createAccountProfileStorage(db);
  await migrateAccountData(db, operation()); await migrateGroupData(db, operation());
  let cleanupFailed = false;
  try {
    await profiles.write(a.userId, "实时甲", operation()); await profiles.write(b.userId, "实时乙", operation());
    const made = await groups.write(a, { action: "create", name: "实时同步假组", description: "", mutationId: mutation() }, operation());
    assert.ok(made.details?.invitationCode);
    const groupId = made.details.group.groupId, invitationCode = made.details.invitationCode; groupIds.add(groupId);
    await groups.write(b, { action: "join", invitationCode, mutationId: mutation() }, operation());
    const other = await groups.write(a, { action: "create", name: "连接归属隔离组", description: "", mutationId: mutation() }, operation());
    assert.ok(other.details); const otherGroup = other.details.group.groupId; groupIds.add(otherGroup);
    const empty = EditableGraphSchema.parse({ version: "workspace.v1", id: randomUUID(), title: "实时原始图", query: "", language: "zh-CN",
      presentationMode: "graph", createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", lastRunId: null,
      nodes: [], edges: [], positions: {} });
    const created = await workspace.write(a.userId, { action: "create", groupId, document: empty, mutationId: mutation() }, operation());
    const graphId = created.workspace.activeOrder[0]; assert.ok(graphId);
    const saved = (event: Extract<GroupSyncEvent, { type: "snapshot" }>): GroupGraphRecord => {
      const value = event.workspace.graphs.find(record => record.document.id === graphId); assert.ok(value); return value;
    };
    server = buildServer();
    const closedStreams = new Map<string, ReturnType<typeof gate>>();
    server.addHook("onRequest", async (request, reply) => {
      const id = request.headers["x-fixture-stream-id"];
      if (request.url.startsWith("/api/group-sync?") && typeof id === "string") {
        reply.raw.once("close", () => { closedStreams.get(id)?.release(); });
      }
    });
    const initialReadReached = gate(), continueInitialRead = gate();
    releaseInitialSnapshot = continueInitialRead.release;
    let heldInitialRead = false;
    sync = createGroupSync({ auth, readSnapshot: async (userId, inputGroupId, op) => {
      const result = await readGroupSyncSnapshot(db, userId, inputGroupId, op);
      // 甲初始快照已读完但尚未输出时，让乙先提交；通知不能落在订阅与快照交接的缺口里。
      if (userId === a.userId && inputGroupId === groupId && !heldInitialRead) {
        heldInitialRead = true; initialReadReached.release(); await bounded(continueInitialRead.reached);
      }
      return result;
    },
      leaseMs: 10_000, heartbeatMs: 100 });
    registerGroupSyncRoutes(server, { auth, sync, publicOrigin: null });
    registerGroupWorkspaceRoutes(server, { auth, sync, storage: workspace, publicOrigin: null });
    registerGroupRoutes(server, { auth, sync, storage: groups, publicOrigin: null });
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    const headers = (who: "a" | "b", proof?: string) => ({ origin, cookie: who === "a" ? cookieA : cookieB,
      [CLOUD_ACCOUNT_HEADER]: who === "a" ? a.userId : b.userId, "content-type": "application/json",
      ...(proof === undefined ? {} : { [GROUP_CONNECTION_HEADER]: proof }) });
    const post = (path: string, who: "a" | "b", body: unknown, proof?: string) => fetch(`${origin}${path}`, {
      method: "POST", headers: headers(who, proof), body: JSON.stringify(body), signal: AbortSignal.timeout(2_000),
    });
    const receipt = async (who: "a" | "b", id: string) => {
      const response = await fetch(`${origin}/api/group-receipt?mutationId=${encodeURIComponent(id)}`, { headers: headers(who), signal: AbortSignal.timeout(2_000) });
      assert.equal(response.status, 200); return GroupGraphReceiptResponseSchema.parse(await response.json());
    };
    const denied = async (who: "a" | "b", body: GroupGraphAction, code: string, proof?: string) => {
      const response = await post("/api/group-workspace", who, body, proof);
      assert.equal(GroupErrorResponseSchema.parse(await response.json()).code, code);
      assert.equal(response.status >= 400, true);
      assert.equal((await receipt(who, body.mutationId)).applied, false);
    };
    const open = async (who: "a" | "b") => {
      const id = randomUUID(), closed = gate(), controller = new AbortController(); closedStreams.set(id, closed);
      const response = await bounded(fetch(`${origin}/api/group-sync?groupId=${encodeURIComponent(groupId)}`, {
        headers: { ...headers(who), "x-fixture-stream-id": id }, signal: controller.signal,
      }), 2_000, () => controller.abort());
      assert.equal(response.status, 200); assert.ok(response.headers.get("content-type")?.includes("ndjson"));
      const client = new SyncClient(response, controller, closed.reached); clients.push(client);
      return { client, snapshot: await client.snapshot() };
    };
    const edit = (before: GroupGraphRecord, title: string): GroupGraphAction => ({ action: "edit", groupId, graphId,
      expectedRevision: before.revision, before: before.document, after: { ...before.document, title },
      kind: "graph.rename", subject: title, mutationId: mutation() });

    // 缺证明及错误的账号／小组证明不能借“已有另一条连接”放行写入。
    await denied("a", { action: "create", groupId, document: empty, mutationId: mutation() }, "GROUP_OFFLINE");
    const initialB = await open("b");
    const openingA = open("a").then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    try {
      await bounded(initialReadReached.reached);
      const duringInitial = await post("/api/group-workspace", "b", edit(saved(initialB.snapshot), "初始快照交接期间提交"), initialB.snapshot.connectionId);
      assert.equal(duringInitial.status, 200); GroupGraphWriteResponseSchema.parse(await duringInitial.json());
      initialB.snapshot = await initialB.client.snapshot(event => saved(event).document.title === "初始快照交接期间提交");
    } finally { continueInitialRead.release(); }
    const openedA = await openingA; if (!openedA.ok) throw openedA.error;
    const initialA = openedA.value;
    if (saved(initialA.snapshot).document.title !== "初始快照交接期间提交") {
      initialA.snapshot = await initialA.client.snapshot(event => saved(event).document.title === "初始快照交接期间提交");
    }
    assert.notEqual(initialA.snapshot.connectionId, initialB.snapshot.connectionId);
    assert.deepEqual(initialA.snapshot.workspace, initialB.snapshot.workspace);
    await bounded(db.idle()); assert.equal(db.activeOperations, 0);
    const firstEdit = edit(saved(initialA.snapshot), "双客户端编辑后");
    const firstResponse = await post("/api/group-workspace", "a", firstEdit, initialA.snapshot.connectionId);
    assert.equal(firstResponse.status, 200); GroupGraphWriteResponseSchema.parse(await firstResponse.json());
    const [afterA, afterB] = await Promise.all([
      initialA.client.snapshot(event => saved(event).document.title === "双客户端编辑后"),
      initialB.client.snapshot(event => saved(event).document.title === "双客户端编辑后"),
    ]);
    assert.deepEqual(afterA.workspace, afterB.workspace);
    await denied("a", edit(saved(afterA), "不能借他人证明"), "GROUP_OFFLINE", initialB.snapshot.connectionId);
    await denied("a", { action: "create", groupId: otherGroup, document: empty, mutationId: mutation() }, "GROUP_OFFLINE", initialA.snapshot.connectionId);
    await initialA.client.close();
    await denied("a", edit(saved(afterA), "断流后不能写"), "GROUP_OFFLINE", initialA.snapshot.connectionId);
    const currentA = await open("a");
    assert.notEqual(currentA.snapshot.connectionId, initialA.snapshot.connectionId);
    await denied("a", edit(saved(currentA.snapshot), "旧连接不能借新连接复活"), "GROUP_OFFLINE", initialA.snapshot.connectionId);

    // 已提交但应用不读取确认正文，仍可按本人mutation查回；不得再执行一次来猜测是否成功。
    const lostAck = edit(saved(currentA.snapshot), "确认丢失后的已提交内容");
    const ignored = await post("/api/group-workspace", "b", lostAck, initialB.snapshot.connectionId);
    assert.equal(ignored.status, 200); await ignored.body?.cancel();
    const [ackA, ackB] = await Promise.all([
      currentA.client.snapshot(event => saved(event).document.title === "确认丢失后的已提交内容"),
      initialB.client.snapshot(event => saved(event).document.title === "确认丢失后的已提交内容"),
    ]);
    assert.deepEqual(ackA.workspace, ackB.workspace);
    assert.equal(saved(ackA).history.events.length, saved(currentA.snapshot).history.events.length + 1);
    assert.equal((await receipt("b", lostAck.mutationId)).applied, true);
    assert.equal((await receipt("a", lostAck.mutationId)).applied, false);
    const restartedOnce = await snapshotFromFreshProcess(a, groupId);
    const restartedTwice = await snapshotFromFreshProcess(a, groupId);
    assert.notEqual(restartedOnce.connectionId, restartedTwice.connectionId);
    assert.deepEqual(restartedOnce.workspace, ackA.workspace);
    assert.deepEqual(restartedTwice.workspace, ackA.workspace);

    // 会话撤销在下一次输出前复核，不能把撤销后的新图正文送给旧连接。
    sessions.delete(cookieB);
    const afterRevoke = await post("/api/group-workspace", "a", edit(saved(ackA), "会话撤销后的新内容"), currentA.snapshot.connectionId);
    assert.equal(afterRevoke.status, 200); GroupGraphWriteResponseSchema.parse(await afterRevoke.json());
    const authorizedAfterRevoke = await currentA.client.snapshot(event => saved(event).document.title === "会话撤销后的新内容");
    await initialB.client.revoked("ACCOUNT_REQUIRED");
    sessions.set(cookieB, { ...b, sessionId: `new_session_${runId}` });
    await denied("b", edit(saved(authorizedAfterRevoke), "换会话不能复用证明"), "GROUP_OFFLINE", initialB.snapshot.connectionId);
    const resumedB = await open("b");

    const left = await post("/api/groups", "b", { action: "leave", groupId, mutationId: mutation() }, resumedB.snapshot.connectionId);
    assert.equal(left.status, 200); assert.equal(GroupActionResponseSchema.parse(await left.json()).details, null);
    await resumedB.client.revoked("GROUP_FORBIDDEN");
    await currentA.client.snapshot(event => !event.details.members.some(value => value.userId === b.userId));
    const rejoined = await post("/api/groups", "b", { action: "join", invitationCode, mutationId: mutation() });
    assert.equal(rejoined.status, 200); GroupActionResponseSchema.parse(await rejoined.json());
    const afterJoin = await currentA.client.snapshot(event => event.details.members.some(value => value.userId === b.userId));
    const finalB = await open("b");
    const beforeManagementDenied = await groups.read(a.userId, groupId, operation());
    for (const [who, body] of [
      ["a", { action: "update", groupId, expectedRevision: afterJoin.details.group.revision, name: "无证明不能改名", description: "", mutationId: mutation() }],
      ["b", { action: "leave", groupId, mutationId: mutation() }],
      ["a", { action: "dissolve", groupId, expectedRevision: afterJoin.details.group.revision, mutationId: mutation() }],
    ] as const) {
      const rejected = await post("/api/groups", who, body);
      assert.equal(GroupErrorResponseSchema.parse(await rejected.json()).code, "GROUP_OFFLINE");
      assert.equal(rejected.status >= 400, true);
    }
    assert.deepEqual(await groups.read(a.userId, groupId, operation()), beforeManagementDenied);
    const dissolved = await post("/api/groups", "a", { action: "dissolve", groupId, expectedRevision: afterJoin.details.group.revision, mutationId: mutation() }, currentA.snapshot.connectionId);
    assert.equal(dissolved.status, 200); assert.equal(GroupActionResponseSchema.parse(await dissolved.json()).details, null);
    await Promise.all([currentA.client.revoked("GROUP_NOT_FOUND"), finalB.client.revoked("GROUP_NOT_FOUND")]);
    await denied("a", edit(saved(afterJoin), "解散不能再写"), "GROUP_OFFLINE", currentA.snapshot.connectionId);
    assert.equal((await receipt("b", lostAck.mutationId)).applied, true);
    await bounded(db.idle()); assert.equal(db.activeOperations, 0);
  } finally {
    releaseInitialSnapshot?.();
    const closed = await Promise.allSettled(clients.map(client => client.close()));
    await sync?.close(); await server?.close();
    await bounded(db.idle());
    const cleaned = await Promise.allSettled([
      ...[...groupIds].map(id => db.query(operation(), "DELETE FROM wf_groups WHERE groupId = ?", [id])),
      ...[a, b].map(person => db.query(operation(), "DELETE FROM wf_user_data WHERE userId = ?", [person.userId])),
    ]);
    cleanupFailed = closed.some(value => value.status === "rejected") || cleaned.some(value => value.status === "rejected");
  }
  if (cleanupFailed) throw new Error("实时验证连接或假数据未完全清理");
  console.info("小组实时真实集成：原子快照及初次读取交接无丢变更／双客户端提交后广播／证明归属与断流禁写／丢确认本人收据／独立进程重启后数据库恢复／会话撤销／退出与解散停止正文／数据库连接释放通过");
} catch {
  console.error("小组实时隔离验证失败；核对本地假数据库及同步边界，不输出原始异常或配置");
  process.exitCode = 1;
} finally { releaseInitialSnapshot?.(); await database?.close(); }
}
