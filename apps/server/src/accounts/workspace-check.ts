/**
 * 显式云图集成验证：仅允许回环专用测试库，真实 SQL／事务和假邮件，不调用 Provider。
 * 普通 CI 不执行；假账号和图最终按可信测试身份清理，不触及其他记录。
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import {
  CLOUD_ACCOUNT_HEADER, EditableGraphSchema, EditableNodeSchema, type CloudGraphWriteRequest, type EditableGraph,
  type CloudWorkspaceImportRequest,
} from "@wayfinder/contracts";
import { appendHistory, createGraphHistory, redoHistoryEvent, remapGraphHistoryIdentity, restoreGraphHistory, storeGraphHistory, undoHistoryEvent } from "@wayfinder/contracts/graph-history";

import { buildServer } from "../app.js";
import { registerWorkspaceRoutes } from "../routes/workspace.js";
import { createAccountAuth } from "./auth.js";
import { AccountDatabase, databaseConfigFromUrl, databaseOperation, migrateAccountData, type DatabaseOperation } from "./database.js";
import { createWorkspaceStorage } from "./workspace-storage.js";

type Query = Parameters<Parameters<AccountDatabase["transaction"]>[1]>[0];
/** 在实际事务已写图和元数据后触发真正的 SQL 错误，验证整笔回滚而不是模拟成功。 */
class FailingDatabase extends AccountDatabase {
  failAtReceipt = false;
  override transaction<T>(operation: DatabaseOperation, action: (query: Query) => Promise<T>, consistentRead = false): Promise<T> {
    return super.transaction(operation, query => action(async (sql, values = []) => {
      const result = await query(sql, values);
      const key = values[1];
      if (sql.includes("UPDATE payload") && (this.failAtReceipt ? typeof key === "string" && key.startsWith("i_") : key === "workspace_meta")) {
        await query("SELECT fixture_missing_column FROM wf_user_data");
      }
      return result;
    }), consistentRead);
  }
}
/** 在第一次实际读取后允许另一个连接提交，核对服务器默认RC也不会拼接两个时刻的数据。 */
class InterleavedDatabase extends AccountDatabase {
  afterRead: (() => Promise<void>) | undefined;
  override transaction<T>(operation: DatabaseOperation, action: (query: Query) => Promise<T>, consistentRead = false): Promise<T> {
    return super.transaction(operation, query => action(async (sql, values = []) => {
      const result = await query(sql, values);
      if (sql.startsWith("SELECT payload") && this.afterRead !== undefined) {
        const next = this.afterRead; this.afterRead = undefined; await next();
      }
      return result;
    }), consistentRead);
  }
}
const operation = () => databaseOperation(new AbortController().signal);
const graph = (id: string, title = "假图"): EditableGraph => EditableGraphSchema.parse({
  version: "workspace.v1", id, title, query: "", language: "zh-CN", presentationMode: "graph",
  createdAt: "2026-11-11T00:00:00.000Z", updatedAt: "2026-11-11T00:00:00.000Z", lastRunId: null,
  nodes: [], edges: [], positions: {},
});
const save = (document: EditableGraph, expectedRevision = 0): CloudGraphWriteRequest => ({
  action: "save", document, history: storeGraphHistory(createGraphHistory(document)), expectedRevision, mutationId: randomUUID(),
});
const edit = (action: "delete" | "restore", graphId: string, expectedRevision: number): CloudGraphWriteRequest => ({
  action, graphId, expectedRevision, mutationId: randomUUID(),
});
let database: AccountDatabase | undefined, second: AccountDatabase | undefined, failing: FailingDatabase | undefined;
let interleaved: InterleavedDatabase | undefined;
let stage = "配置";
const users: string[] = [], emails: string[] = [];
try {
  const raw = process.env.WF_TEST_MYSQL_URL;
  if (!raw) throw new Error();
  const config = databaseConfigFromUrl(raw);
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host) || !/^wf_d11_test_[A-Za-z0-9_]+$/.test(config.database)) throw new Error();
  database = new AccountDatabase(config); second = new AccountDatabase(config); failing = new FailingDatabase(config);
  interleaved = new InterleavedDatabase({ ...config, connectionLimit: 1 });
  const db = database, storage = createWorkspaceStorage(db), otherConnection = createWorkspaceStorage(second);
  await migrateAccountData(db, operation());
  const messages = new Map<string, string>(), origin = "https://fixture.example";
  const auth = createAccountAuth({ database: db, origin, secret: "fixture-workspace-secret-with-more-than-thirty-two-characters",
    mailer: { sendOTP: async message => { messages.set(message.email, message.otp); } } });
  await auth.migrate(operation()); await auth.initialize(operation());
  let ip = 1;
  const headers = (cookie?: string) => new Headers({ origin, "content-type": "application/json", "x-wayfinder-client-ip": `192.0.2.${ip++}`,
    ...(cookie === undefined ? {} : { cookie }) });
  const cookies: string[] = [];
  for (let index = 0; index < 2; ++index) {
    const email = `wf-workspace-${randomUUID()}@example.com`; emails.push(email);
    await auth.handle({ action: "register", email, password: "fixture-workspace-password" }, headers(), operation());
    const otp = messages.get(email); assert(otp);
    await auth.handle({ action: "verify", email, otp }, headers(), operation());
    const login = await auth.handle({ action: "login", email, password: "fixture-workspace-password" }, headers(), operation());
    const cookie = login.cookies.map(value => value.split(";", 1)[0]).join("; "); cookies.push(cookie);
    const identity = await auth.getIdentity(headers(cookie), operation()); assert(identity); users.push(identity.userId);
  }
  const a = users[0] ?? "", b = users[1] ?? "", id = `图-${randomUUID()}`;
  stage = "归属、创建和幂等";
  const create = save(graph(id));
  const created = await storage.write(a, create, operation());
  assert.deepEqual(await storage.write(a, create, operation()), created);
  await assert.rejects(storage.write(a, { ...save(graph(id, "复用同一请求号改内容")), mutationId: create.mutationId }, operation()), { code: "WORKSPACE_CONFLICT" });
  await storage.write(b, save(graph(id, "另一账号同ID")), operation());
  assert.equal((await storage.read(a, operation())).graphs[0]?.document.title, "假图");
  assert.equal((await storage.read(b, operation())).graphs[0]?.document.title, "另一账号同ID");

  stage = "两连接并发保存、删除和恢复";
  const concurrent = await Promise.allSettled([
    storage.write(a, save(graph(id, "设备A"), 1), operation()), otherConnection.write(a, save(graph(id, "设备B"), 1), operation()),
  ]);
  assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
  let current = (await storage.read(a, operation())).graphs.find(record => record.document.id === id); assert(current);
  const race = await Promise.allSettled([
    storage.write(a, save(graph(id, "并发编辑"), current.revision), operation()),
    otherConnection.write(a, edit("delete", id, current.revision), operation()),
  ]);
  assert.equal(race.filter(result => result.status === "fulfilled").length, 1);
  current = (await storage.read(a, operation())).graphs.find(record => record.document.id === id); assert(current);
  if (current.status === "active") current = (await storage.write(a, edit("delete", id, current.revision), operation())).record;
  const restore = await Promise.allSettled([
    storage.write(a, edit("restore", id, current.revision), operation()), otherConnection.write(a, edit("restore", id, current.revision), operation()),
  ]);
  assert.equal(restore.filter(result => result.status === "fulfilled").length, 1);

  stage = "实际事务故障回滚";
  const beforeFailure = await storage.read(a, operation());
  await assert.rejects(createWorkspaceStorage(failing).write(a, save(graph(`rollback-${randomUUID()}`)), operation()), { message: "DATABASE_UNAVAILABLE" });
  assert.deepEqual(await storage.read(a, operation()), beforeFailure);

  stage = "RC连接上的一致快照";
  await interleaved.query(operation(), "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
  assert(JSON.stringify(await interleaved.query(operation(), "SELECT @@transaction_isolation AS isolationLevel")).includes("READ-COMMITTED"));

  stage = "真实JSON键序、布局和节点增删重放";
  const layoutId = `layout-${randomUUID()}`;
  const node = (id: string) => EditableNodeSchema.parse({ id, title: id, description: "假节点",
    nodeType: "primary", layer: 0, status: "empty", resources: [], warnings: [] });
  let layout = EditableGraphSchema.parse({ ...graph(layoutId), nodes: [node("z")], positions: { z: { x: 9, y: 10 } } });
  let layoutHistory = createGraphHistory(layout);
  const addedA = EditableGraphSchema.parse({ ...layout, nodes: [...layout.nodes, node("a")],
    positions: { ...layout.positions, a: { x: 1, y: 2 } } });
  layoutHistory = appendHistory(layoutHistory, layout, addedA, { kind: "node.add", subject: "a", id: "add_a",
    occurredAt: "2026-11-11T00:00:00.000Z", active: true }, 100);
  layout = addedA;
  const storedLayout = await storage.write(a, { action: "save", document: layout, history: storeGraphHistory(layoutHistory),
    expectedRevision: 0, mutationId: randomUUID() }, operation());
  let layoutRecord = (await storage.read(a, operation())).graphs.find(record => record.document.id === layoutId); assert(layoutRecord);
  assert.deepEqual(Object.keys(layoutRecord.document.positions), ["z", "a"]);
  assert.deepEqual(layoutRecord.history, storedLayout.record.history);
  const afterDatabase = restoreGraphHistory(layoutRecord.history, layoutRecord.document, 100);
  const undoneA = undoHistoryEvent(afterDatabase, "add_a"); assert(undoneA.ok);
  assert.deepEqual(undoneA.graph.nodes.map(value => value.id), ["z"]);
  assert.deepEqual(Object.keys(undoneA.graph.positions), ["z"]);
  await storage.write(a, { action: "save", document: undoneA.graph, history: storeGraphHistory(undoneA.history),
    expectedRevision: layoutRecord.revision, mutationId: randomUUID() }, operation());
  layoutRecord = (await storage.read(a, operation())).graphs.find(record => record.document.id === layoutId); assert(layoutRecord);
  const redoneA = redoHistoryEvent(restoreGraphHistory(layoutRecord.history, layoutRecord.document, 100)); assert(redoneA?.ok);
  assert.deepEqual(redoneA.graph, layout);
  const redoSaved = await storage.write(a, { action: "save", document: redoneA.graph, history: storeGraphHistory(redoneA.history),
    expectedRevision: layoutRecord.revision, mutationId: randomUUID() }, operation());
  layoutHistory = redoneA.history;
  const addedM = EditableGraphSchema.parse({ ...layout, nodes: [...layout.nodes, node("m")],
    positions: { ...layout.positions, m: { x: 4, y: 5 } } });
  layoutHistory = appendHistory(layoutHistory, layout, addedM, { kind: "node.add", subject: "m", id: "add_m",
    occurredAt: "2026-11-11T00:00:01.000Z", active: true }, 100);
  layout = addedM;
  const multiSaved = await storage.write(a, { action: "save", document: layout, history: storeGraphHistory(layoutHistory),
    expectedRevision: redoSaved.record.revision, mutationId: randomUUID() }, operation());
  layoutRecord = (await storage.read(a, operation())).graphs.find(record => record.document.id === layoutId); assert(layoutRecord);
  assert.deepEqual(Object.keys(layoutRecord.document.positions), ["z", "a", "m"]);
  const removedA = EditableGraphSchema.parse({ ...layout, nodes: layout.nodes.filter(value => value.id !== "a"),
    positions: Object.fromEntries(Object.entries(layout.positions).filter(([id]) => id !== "a")) });
  layoutHistory = appendHistory(layoutHistory, layout, removedA, { kind: "node.delete", subject: "a", id: "delete_a",
    occurredAt: "2026-11-11T00:00:02.000Z", active: true }, 100);
  await storage.write(a, { action: "save", document: removedA, history: storeGraphHistory(layoutHistory),
    expectedRevision: multiSaved.record.revision, mutationId: randomUUID() }, operation());
  layoutRecord = (await storage.read(a, operation())).graphs.find(record => record.document.id === layoutId); assert(layoutRecord);
  assert.deepEqual(Object.keys(layoutRecord.document.positions), ["z", "m"]);
  const undoDelete = undoHistoryEvent(restoreGraphHistory(layoutRecord.history, layoutRecord.document, 100), "delete_a"); assert(undoDelete.ok);
  assert.deepEqual(undoDelete.graph, addedM);
  assert.deepEqual(Object.keys(undoDelete.graph.positions), ["z", "a", "m"]);
  const redoDelete = redoHistoryEvent(undoDelete.history); assert(redoDelete?.ok);
  assert.deepEqual(redoDelete.graph, removedA);
  assert.deepEqual(Object.keys(redoDelete.graph.positions), ["z", "m"]);
  const layoutDeleted = await storage.write(a, edit("delete", layoutId, layoutRecord.revision), operation());
  await storage.write(a, edit("restore", layoutId, layoutDeleted.record.revision), operation());
  layoutRecord = (await storage.read(a, operation())).graphs.find(record => record.document.id === layoutId); assert(layoutRecord);
  assert.deepEqual(layoutRecord.document, removedA);
  assert.deepEqual(Object.keys(layoutRecord.document.positions), ["z", "m"]);
  const beforeInterleave = await storage.read(a, operation());
  interleaved.afterRead = async () => { await otherConnection.write(a, save(graph(`interleaved-${randomUUID()}`)), operation()); };
  assert.deepEqual(await createWorkspaceStorage(interleaved).read(a, operation()), beforeInterleave);
  assert.equal((await storage.read(a, operation())).graphs.length, beforeInterleave.graphs.length + 1);
  assert(JSON.stringify(await interleaved.query(operation(), "SELECT @@transaction_isolation AS isolationLevel")).includes("READ-COMMITTED"));

  stage = "100步、重做和损坏拒绝";
  const historyId = `history-${randomUUID()}`;
  let document = graph(historyId), history = createGraphHistory(document);
  for (let index = 0; index < 101; ++index) {
    const next = { ...document, title: `历史${index}` };
    history = appendHistory(history, document, next, { kind: "graph.rename", subject: "假标题", id: `event_${index}`,
      occurredAt: "2026-11-11T00:00:00.000Z", active: true }, 100);
    document = next;
  }
  assert.equal(history.events.length, 100);
  const undone = undoHistoryEvent(history, history.events.at(-1)?.id ?? ""); assert(undone.ok);
  document = undone.graph; history = undone.history;
  const historyRequest: CloudGraphWriteRequest = { action: "save", document, history: storeGraphHistory(history), expectedRevision: 0, mutationId: randomUUID() };
  const historySaved = await storage.write(a, historyRequest, operation());
  assert.deepEqual(historySaved.record.history, historyRequest.history);
  const extra = historyRequest.history.events.at(-1); assert(extra);
  await assert.rejects(storage.write(a, { ...historyRequest, expectedRevision: 1, mutationId: randomUUID(),
    history: { ...historyRequest.history, events: [...historyRequest.history.events, { ...extra, id: "overflow" }] } }, operation()), { code: "WORKSPACE_INVALID" });
  await assert.rejects(storage.write(a, { ...historyRequest, expectedRevision: 1, mutationId: randomUUID(),
    document: { ...document, title: "与历史重放不一致" } }, operation()), { code: "WORKSPACE_INVALID" });
  const deletedHistory = await storage.write(a, edit("delete", historyId, 1), operation());
  const restoredHistory = await storage.write(a, edit("restore", historyId, deletedHistory.record.revision), operation());
  assert.deepEqual(restoredHistory.record.history, historyRequest.history);
  assert.equal(restoredHistory.activeOrder.at(-1), historyId);

  stage = "最近删除100张、顺序和墓碑";
  const deleted: string[] = [];
  for (let index = 0; index < 101; ++index) {
    const graphId = `deleted-${randomUUID()}`; deleted.push(graphId);
    await storage.write(b, save(graph(graphId)), operation());
    await storage.write(b, edit("delete", graphId, 1), operation());
  }
  const workspace = await storage.read(b, operation());
  assert.deepEqual(workspace.deletedIds, deleted.slice(1)); assert.equal(workspace.deletedIds.length, 100);
  const first = deleted[0] ?? "", last = deleted.at(-1) ?? "";
  await assert.rejects(storage.write(b, save(graph(first)), operation()), { code: "WORKSPACE_CONFLICT" });
  await assert.rejects(storage.write(b, edit("restore", first, 2), operation()), { code: "WORKSPACE_CONFLICT" });
  await assert.rejects(storage.write(b, edit("restore", deleted[1] ?? "", 2), operation()), { code: "WORKSPACE_CONFLICT" });
  const restoreRequest = edit("restore", last, 2), restored = await storage.write(b, restoreRequest, operation());
  assert.deepEqual(await storage.write(b, restoreRequest, operation()), restored);
  assert.deepEqual(restored.activeOrder, [id, last]);
  const tombstone = await db.query(operation(), "SELECT payload FROM wf_user_data WHERE userId = ? AND recordId = ?",
    [b, `g_${createHash("sha256").update(first).digest("hex")}`]);
  assert(JSON.stringify(tombstone).includes('"purged"'));
  assert(!JSON.stringify(tombstone).includes('"document"') && !JSON.stringify(tombstone).includes('"history"'));

  stage = "整批访客导入、并发重试和完整身份映射";
  const sourceActive = remapGraphHistoryIdentity(layoutRecord.document, layoutRecord.history, "guest-active");
  const sourceDeleted = remapGraphHistoryIdentity(layoutRecord.document, layoutRecord.history, "guest-deleted-rich");
  const sourceEmpty = (id: string) => { const document = graph(id); return { document, history: storeGraphHistory(createGraphHistory(document)) }; };
  const imported: CloudWorkspaceImportRequest = { action: "import", importId: randomUUID(), documents: [sourceActive],
    deletedGraphs: [{ ...sourceDeleted, originalIndex: 0 }, { ...sourceEmpty("guest-deleted-2"), originalIndex: 1 },
      { ...sourceEmpty("guest-deleted-3"), originalIndex: 0 }] };
  const sourceBytes = JSON.stringify(imported);
  const target = (owner: string, importId: string, sourceId: string) => `import_${createHash("sha256").update(JSON.stringify([owner, importId, sourceId])).digest("hex")}`;
  const importedId = target(b, imported.importId, sourceActive.document.id);
  const importedDeletedIds = imported.deletedGraphs.map(source => target(b, imported.importId, source.document.id));
  const beforeImport = await storage.read(b, operation());
  const [batch, batchRetry] = await Promise.all([
    storage.importGuest(b, imported, operation()), otherConnection.importGuest(b, imported, operation()),
  ]);
  assert.deepEqual(batchRetry, batch);
  assert.deepEqual(batch.activeOrder, [...beforeImport.activeOrder, importedId]);
  assert.equal(batch.deletedIds.length, 100);
  assert.deepEqual(batch.deletedIds.slice(-3), importedDeletedIds);
  const importedRecord = batch.graphs.find(record => record.document.id === importedId); assert(importedRecord);
  assert.deepEqual(importedRecord.document, remapGraphHistoryIdentity(sourceActive.document, sourceActive.history, importedId).document);
  assert.deepEqual(importedRecord.history, remapGraphHistoryIdentity(sourceActive.document, sourceActive.history, importedId).history);
  assert.deepEqual(Object.keys(importedRecord.document.positions), ["z", "m"]);
  assert.equal(batch.graphs.find(record => record.document.id === importedDeletedIds[0])?.originalIndex, beforeImport.activeOrder.length);
  assert.equal(JSON.stringify(imported), sourceBytes);
  const changed = { ...imported, documents: [sourceEmpty("different-source")] };
  await assert.rejects(storage.importGuest(b, changed, operation()), { code: "WORKSPACE_CONFLICT" });
  const restoredImported = await storage.write(b, edit("restore", importedDeletedIds[2] ?? "", 1), operation());
  assert.equal(restoredImported.activeOrder[beforeImport.activeOrder.length], importedDeletedIds[2]);
  const renamed = { ...importedRecord.document, title: "导入后继续编辑" };
  const renamedHistory = appendHistory(restoreGraphHistory(importedRecord.history, importedRecord.document, 100), importedRecord.document, renamed,
    { kind: "graph.rename", subject: "假标题", id: "after_import", occurredAt: "2026-11-11T00:00:03.000Z", active: true }, 100);
  await storage.write(b, { action: "save", document: renamed, history: storeGraphHistory(renamedHistory), expectedRevision: 1, mutationId: randomUUID() }, operation());
  const latestRetry = await storage.importGuest(b, imported, operation());
  assert.equal(latestRetry.graphs.find(record => record.document.id === importedId)?.document.title, renamed.title);
  assert.equal(latestRetry.graphs.find(record => record.document.id === importedId)?.revision, 2);
  assert.equal(latestRetry.graphs.find(record => record.document.id === importedDeletedIds[2])?.status, "active");

  stage = "稳定目标碰撞、全局清理及收据不复活旧数据";
  const collision: CloudWorkspaceImportRequest = { action: "import", importId: randomUUID(), documents: [sourceEmpty("reserved-source")], deletedGraphs: [] };
  const collisionId = target(b, collision.importId, "reserved-source");
  await storage.write(b, save(graph(collisionId, "已存在身份")), operation());
  const beforeCollision = await storage.read(b, operation());
  await assert.rejects(storage.importGuest(b, collision, operation()), { code: "WORKSPACE_CONFLICT" });
  assert.deepEqual(await storage.read(b, operation()), beforeCollision);
  await storage.write(b, edit("delete", collisionId, 1), operation());
  const cleanup: CloudWorkspaceImportRequest = { action: "import", importId: randomUUID(), documents: [],
    deletedGraphs: Array.from({ length: 100 }, (_, index) => ({ ...sourceEmpty(`cleanup-${index}`), originalIndex: 0 })) };
  const afterCleanup = await storage.importGuest(b, cleanup, operation());
  assert.equal(afterCleanup.deletedIds.length, 100);
  assert(!afterCleanup.graphs.some(record => record.document.id === importedDeletedIds[0] || record.document.id === collisionId));
  assert.deepEqual(await storage.importGuest(b, imported, operation()), afterCleanup);
  await assert.rejects(storage.importGuest(b, collision, operation()), { code: "WORKSPACE_CONFLICT" });
  await assert.rejects(storage.write(b, save(graph(importedDeletedIds[0] ?? "")), operation()), { code: "WORKSPACE_CONFLICT" });
  const receiptKey = `i_${createHash("sha256").update(imported.importId).digest("hex")}`;
  const receipt = await db.query(operation(), "SELECT payload FROM wf_user_data WHERE userId = ? AND recordId = ?", [b, receiptKey]);
  assert(JSON.stringify(receipt).includes("requestFingerprint"));
  assert(!JSON.stringify(receipt).includes('"document"') && !JSON.stringify(receipt).includes('"history"'));
  const importedOtherOwner = await storage.importGuest(a, imported, operation());
  assert(importedOtherOwner.activeOrder.includes(target(a, imported.importId, sourceActive.document.id)));
  assert(!importedOtherOwner.activeOrder.includes(importedId));

  stage = "收据写入后实际SQL故障使整批回滚";
  const atomic: CloudWorkspaceImportRequest = { action: "import", importId: randomUUID(), documents: [sourceEmpty("atomic-active")],
    deletedGraphs: [{ ...sourceEmpty("atomic-deleted"), originalIndex: 0 }] };
  const beforeAtomic = await storage.read(a, operation());
  failing.failAtReceipt = true;
  await assert.rejects(createWorkspaceStorage(failing).importGuest(a, atomic, operation()), { message: "DATABASE_UNAVAILABLE" });
  assert.deepEqual(await storage.read(a, operation()), beforeAtomic);
  const failedReceipt = await db.query(operation(), "SELECT payload FROM wf_user_data WHERE userId = ? AND recordId = ?",
    [a, `i_${createHash("sha256").update(atomic.importId).digest("hex")}`]);
  assert.deepEqual(failedReceipt, []);
  assert.equal((await storage.importGuest(a, atomic, operation())).activeOrder.length, beforeAtomic.activeOrder.length + 1);

  stage = "真实Cookie与预期账号护栏";
  const server = buildServer(); registerWorkspaceRoutes(server, { auth, storage, publicOrigin: origin });
  try {
    const goodHeaders = { host: "fixture.example", origin, cookie: cookies[0] ?? "", [CLOUD_ACCOUNT_HEADER]: a };
    assert.equal((await server.inject({ url: "/api/workspace", headers: goodHeaders })).statusCode, 200);
    const before = await storage.read(b, operation());
    const wrongAccount = { ...goodHeaders, cookie: cookies[1] ?? "" };
    assert.equal((await server.inject({ url: "/api/workspace", headers: wrongAccount })).statusCode, 401);
    assert.equal((await server.inject({ method: "POST", url: "/api/workspace", headers: wrongAccount, payload: save(graph("wrong-account")) })).statusCode, 401);
    assert.equal((await server.inject({ method: "POST", url: "/api/workspace", headers: wrongAccount, payload: { ...atomic, importId: randomUUID() } })).statusCode, 401);
    assert.deepEqual(await storage.read(b, operation()), before);
    const httpImport = await server.inject({ method: "POST", url: "/api/workspace", headers: goodHeaders, payload: { ...atomic, importId: randomUUID() } });
    assert.equal(httpImport.statusCode, 200); assert.equal(httpImport.json().userId, a);
    const guestHeaders = { host: "fixture.example", origin, [CLOUD_ACCOUNT_HEADER]: a };
    assert.equal((await server.inject({ url: "/api/workspace", headers: guestHeaders })).statusCode, 401);
    const invalidUser = await server.inject({ method: "POST", url: "/api/workspace", headers: goodHeaders,
      payload: { ...save(graph("foreign-user")), userId: b } });
    assert.equal(invalidUser.statusCode, 400);
  } finally { await server.close(); }
  console.info("MySQL 云图：归属/CAS/事务回滚/RR快照/完整历史及布局/100张墓碑/原子访客导入/并发去重/清理后重试/真实Cookie护栏通过");
} catch {
  console.error(`MySQL 云图隔离验证失败：${stage}；未输出原始异常、账号或图内容`);
  process.exitCode = 1;
} finally {
  if (database !== undefined) {
    for (const userId of users) await database.query(operation(), "DELETE FROM wf_user_data WHERE userId = ?", [userId]);
    for (const email of emails) {
      await database.query(operation(), "DELETE FROM verification WHERE identifier LIKE ?", [`%${email}`]);
      await database.query(operation(), "DELETE FROM `user` WHERE email = ?", [email]);
    }
  }
  await interleaved?.close(); await failing?.close(); await second?.close(); await database?.close();
}
