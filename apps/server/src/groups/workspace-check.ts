/**
 * 显式组图 SQL 集成验证：只允许回环 wf_d12_test_ 库，不读取 .env，不调用检索或邮件。
 * 使用真实个人／小组服务验证复制事务、版本、笔记历史、删除恢复、收据及解散竞争。
 * 假身份和图标识均属于本轮；清理精确到这些身份／小组，不 DROP 表或数据库。
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { z } from "zod";
import {
  EditableGraphSchema, GroupSyncEventSchema, type EditableGraph, type EditableNote, type GroupGraphRecord, type GroupWorkspaceResponse,
} from "@wayfinder/contracts";
import { appendHistory, createGraphHistory, restoreGraphHistory, storeGraphHistory } from "@wayfinder/contracts/graph-history";

import {
  AccountDatabase, databaseConfigFromUrl, databaseOperation, migrateAccountData, type DatabaseOperation,
} from "../accounts/database.js";
import { createAccountProfileStorage } from "../accounts/profile-storage.js";
import { createWorkspaceStorage } from "../accounts/workspace-storage.js";
import { createGroupEventEncoder } from "../routes/group-response-encoding.js";
import { migrateGroupData } from "./database.js";
import { createGroupStorage } from "./storage.js";
import { readGroupSyncSnapshot } from "./sync.js";
import { createGroupWorkspaceStorage } from "./workspace-storage.js";

type Query = Parameters<Parameters<AccountDatabase["transaction"]>[1]>[0];
class ObservedDatabase extends AccountDatabase {
  beforeQuery: ((sql: string, values: Parameters<Query>[1]) => Promise<void> | void) | undefined;
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
async function awaitGate(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("组图事务屏障未按时到达")), 2_000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
const rejectCode = async (promise: Promise<unknown>, code: string) => { await assert.rejects(promise, { code }); };
const record = (workspace: GroupWorkspaceResponse, id: string): GroupGraphRecord => {
  const found = workspace.graphs.find(value => value.document.id === id);
  assert.ok(found);
  return found;
};
const latest = (workspace: GroupWorkspaceResponse): GroupGraphRecord => {
  const id = workspace.activeOrder.at(-1);
  assert.ok(id);
  return record(workspace, id);
};
const notesOf = (graph: EditableGraph): EditableNote[] => graph.nodes[0]?.notes ?? [];
function withNotes(graph: EditableGraph, notes: EditableNote[]): EditableGraph {
  const [first, ...remaining] = graph.nodes;
  assert.ok(first);
  return EditableGraphSchema.parse({ ...graph, nodes: [{ ...first, notes }, ...remaining] });
}
/** 这里只验证当前图能由组历史重放；本人撤销／重做行为在 WAY-148 单独验证。 */
function assertReplay(value: GroupGraphRecord): void {
  restoreGraphHistory({ version: "history.v1", base: value.history.base, events: value.history.events, redoIds: [] },
    value.document, Math.max(100, value.history.events.length));
}

/** 以正式 RR 快照读取、校验和 gzip 首帧编码为计时边界，排除网络传输和浏览器渲染。 */
async function measureNoteSnapshot(database: AccountDatabase, userId: string, groupId: string, operation: () => DatabaseOperation) {
  const durations: number[] = [];
  let sizes = { documentBytes: 0, storedGraphBytes: 0, historyBytes: 0, frameBytes: 0, gzipBytes: 0 };
  for (let sample = 0; sample <= 7; sample++) {
    const start = performance.now();
    const snapshot = await readGroupSyncSnapshot(database, userId, groupId, operation());
    const event = GroupSyncEventSchema.parse({ type: "snapshot", sequence: 0, ...snapshot, connectionId: "fixture-sync-notes" });
    const frame = `${JSON.stringify(event)}\n`;
    const encoder = createGroupEventEncoder();
    try {
      const gzip = await encoder.encode(frame);
      if (sample > 0) durations.push(performance.now() - start);
      const graph = latest(snapshot.workspace);
      sizes = { documentBytes: Buffer.byteLength(JSON.stringify(graph.document)), storedGraphBytes: Buffer.byteLength(JSON.stringify(graph)),
        historyBytes: Buffer.byteLength(JSON.stringify(graph.history)), frameBytes: Buffer.byteLength(frame), gzipBytes: gzip.byteLength };
    } finally { encoder.destroy(); }
  }
  durations.sort((a, b) => a - b);
  const median = durations[3];
  assert.ok(median !== undefined);
  return { ...sizes, medianMs: Number(median.toFixed(2)) };
}

let database: AccountDatabase | undefined;
const observedDatabases: ObservedDatabase[] = [];
const releaseGates: Array<() => void> = [];
try {
  const raw = process.env.WF_TEST_MYSQL_URL;
  if (!raw) throw new Error("缺少测试配置");
  const config = databaseConfigFromUrl(raw);
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host)
    || !/^wf_d12_test_[A-Za-z0-9_]+$/.test(config.database)) throw new Error("非隔离测试库");
  database = new AccountDatabase(config);
  const db = database, operation = () => databaseOperation(new AbortController().signal, 5_000);
  const runId = randomUUID(), mutation = () => randomUUID();
  const identity = (name: string) => ({ userId: `${name}_${runId}`, sessionId: `session_${name}_${runId}`, email: `${name}@example.com` });
  const owner = identity("fixtureGraphOwner"), member = identity("fixtureGraphMember"), outsider = identity("fixtureGraphOutsider");
  const identities = [owner, member, outsider], groupIds = new Set<string>();
  const groupId = () => { const id = randomUUID(); groupIds.add(id); return id; };
  const groups = createGroupStorage(db, { createId: groupId });
  const workspace = createGroupWorkspaceStorage(db), personal = createWorkspaceStorage(db);
  const profiles = createAccountProfileStorage(db), at = "2026-11-12T00:00:00.000Z";
  const empty = (title: string): EditableGraph => EditableGraphSchema.parse({ version: "workspace.v1", id: randomUUID(),
    title, query: "", language: "zh-CN", presentationMode: "graph", createdAt: at, updatedAt: at, lastRunId: null,
    nodes: [], edges: [], positions: {} });
  const makeGroup = async (name: string) => {
    const result = await groups.write(owner, { action: "create", name, description: "假组图验证", mutationId: mutation() }, operation());
    assert.ok(result.details?.invitationCode);
    await groups.write(member, { action: "join", invitationCode: result.details.invitationCode, mutationId: mutation() }, operation());
    return result.details.group.groupId;
  };
  const observer = () => { const observed = new ObservedDatabase(config); observedDatabases.push(observed); return observed; };
  const groupLockQuery = (sql: string, values: Parameters<Query>[1], target: string) =>
    /^SELECT groupId, ownerUserId, invitationCode, payload FROM wf_groups WHERE groupId = \? FOR UPDATE$/i.test(sql) && values?.[0] === target;
  const userInsert = (sql: string, values: Parameters<Query>[1], prefix: string) =>
    /^INSERT INTO wf_user_data/i.test(sql) && typeof values?.[1] === "string" && values[1].startsWith(prefix);

  await migrateAccountData(db, operation());
  await migrateGroupData(db, operation());
  let cleanupFailed = false;
  try {
    for (const person of identities) await profiles.write(person.userId, "假组图成员", operation());
    const groupA = await makeGroup("组图甲"), groupB = await makeGroup("组图乙");
    // 让外人属于另一独立小组，验证“另组成员”不会获得组甲访问权。
    const externalGroup = await groups.write(outsider, { action: "create", name: "外人的组", description: "", mutationId: mutation() }, operation());
    assert.ok(externalGroup.details);
    groupIds.add(externalGroup.details.group.groupId);
    await rejectCode(workspace.read(outsider.userId, groupA, operation()), "GROUP_FORBIDDEN");
    await rejectCode(workspace.write(outsider.userId, { action: "create", groupId: groupA, document: empty("越权图"), mutationId: mutation() }, operation()), "GROUP_FORBIDDEN");

    const base = EditableGraphSchema.parse({ ...empty("个人原始图"),
      nodes: ["A", "B"].map(id => ({ id, title: id, description: "", nodeType: "primary", layer: 0,
        status: id === "A" ? "edited" : "empty", warnings: [], resources: id === "A" ? [{
          id: "fixture_resource", url: "https://fixture.example/source", canonicalUrl: "https://fixture.example/source",
          domain: "fixture.example", title: "假网页", origin: "manual", sourceType: "user_added", summary: "假说明", whySelected: "", rank: 1,
        }] : [] })), edges: [{ id: "fixture_edge", source: "A", target: "B", type: "related_to" }],
      positions: { B: { x: 20, y: 30 }, A: { x: 40, y: 50 } } });
    const privateNote: EditableNote = { id: "fixture-note", title: "个人学习笔记", description: "只随显式勾选分享",
      markdown: "## 复习\n\n[假资料](https://fixture.example/source?part=2#example)" };
    const personalBase = withNotes(base, [privateNote]);
    let source = { ...personalBase, title: "个人已经编辑的图" };
    let sourceHistory = appendHistory(createGraphHistory(personalBase), personalBase, source,
      { id: randomUUID(), kind: "graph.rename", subject: source.title, active: true, occurredAt: at }, 100);
    let savedSource = (await personal.write(member.userId, { action: "save", expectedRevision: 0, mutationId: mutation(),
      document: source, history: storeGraphHistory(sourceHistory) }, operation())).record;
    const sourceHistoryBeforeCopy = JSON.stringify(savedSource.history);
    const copyInAction = { action: "copyIn" as const, groupId: groupA, sourceGraphId: source.id, sourceRevision: savedSource.revision, mutationId: mutation() };
    const copiedIn = latest((await workspace.write(member.userId, copyInAction, operation())).workspace);
    assert.notEqual(copiedIn.document.id, source.id);
    assert.equal(copiedIn.history.events.length, 0);
    assert.deepEqual(copiedIn.history.redoIdsByUser, {});
    assert.deepEqual(Object.keys(copiedIn.document.positions), ["B", "A"]);
    assert.deepEqual(copiedIn.document.nodes, base.nodes);
    assert.deepEqual(copiedIn.document.edges, source.edges);
    assertReplay(copiedIn);
    assert.equal(JSON.stringify((await personal.read(member.userId, operation())).graphs.find(value => value.document.id === source.id)?.history), sourceHistoryBeforeCopy);
    const repeatedIn = await workspace.write(member.userId, copyInAction, operation());
    assert.equal(repeatedIn.workspace.graphs.length, 1);
    await rejectCode(workspace.write(member.userId, { ...copyInAction, sourceRevision: savedSource.revision + 1 }, operation()), "GROUP_CONFLICT");

    const createDocument = empty("组内第二张图"), createMutation = mutation();
    const created = latest((await workspace.write(owner.userId,
      { action: "create", groupId: groupA, document: createDocument, mutationId: createMutation }, operation())).workspace);
    assert.notEqual(created.document.id, createDocument.id);
    assert.equal((await workspace.read(member.userId, groupA, operation())).activeOrder.length, 2);
    const memberContent = { ...created.document, nodes: base.nodes, edges: base.edges, positions: base.positions };
    const memberEdited = record((await workspace.write(member.userId, { action: "edit", groupId: groupA,
      graphId: created.document.id, expectedRevision: created.revision, before: created.document, after: memberContent,
      kind: "graph.update", subject: "普通成员编辑节点资源连线与布局", mutationId: mutation() }, operation())).workspace, created.document.id);
    assert.deepEqual(memberEdited.document.nodes, base.nodes);
    assert.deepEqual(memberEdited.document.edges, base.edges);
    assert.deepEqual(Object.keys(memberEdited.document.positions), ["B", "A"]);
    assert.equal(memberEdited.history.events[0]?.actorUserId, member.userId);
    assertReplay(memberEdited);
    const changedDocument = { ...copiedIn.document, title: "小组独立修改的图" };
    const edited = record((await workspace.write(owner.userId, { action: "edit", groupId: groupA,
      graphId: copiedIn.document.id, expectedRevision: copiedIn.revision, before: copiedIn.document, after: changedDocument,
      kind: "graph.rename", subject: changedDocument.title, mutationId: mutation() }, operation())).workspace, copiedIn.document.id);
    assert.equal(edited.history.events.length, 1);
    assert.equal(edited.history.events[0]?.actorUserId, owner.userId);
    assert.deepEqual(Object.keys(edited.document.positions), ["B", "A"]);
    assertReplay(edited);
    const beforeMetadataOnly = await workspace.read(member.userId, groupA, operation());
    const metadataOnly = (await workspace.write(member.userId, { action: "edit", groupId: groupA,
      graphId: edited.document.id, expectedRevision: edited.revision, before: edited.document,
      after: { ...edited.document, createdAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-13T00:00:00.000Z" },
      kind: "graph.update", subject: "仅时间字段不产生编辑", mutationId: mutation() }, operation())).workspace;
    assert.equal(metadataOnly.revision, beforeMetadataOnly.revision);
    assert.deepEqual(record(metadataOnly, edited.document.id), edited);
    // WAY-148 允许旧基线重复写入当前同值成为无操作；不同竞争名称才应验证同字段冲突。
    const competingDocument = { ...changedDocument, title: "过期基线竞争的另一个图名" };
    await rejectCode(workspace.write(owner.userId, { action: "edit", groupId: groupA,
      graphId: copiedIn.document.id, expectedRevision: copiedIn.revision, before: copiedIn.document, after: competingDocument,
      kind: "graph.rename", subject: competingDocument.title, mutationId: mutation() }, operation()), "GROUP_CONFLICT");
    assert.equal((await personal.read(member.userId, operation())).graphs.find(value => value.document.id === source.id)?.document.title, source.title);

    const nextSource = { ...source, title: "个人后来独立修改的图" };
    sourceHistory = appendHistory(sourceHistory, source, nextSource,
      { id: randomUUID(), kind: "graph.rename", subject: nextSource.title, active: true, occurredAt: at }, 100);
    source = nextSource;
    savedSource = (await personal.write(member.userId, { action: "save", expectedRevision: savedSource.revision,
      document: source, history: storeGraphHistory(sourceHistory), mutationId: mutation() }, operation())).record;
    assert.equal(record(await workspace.read(member.userId, groupA, operation()), edited.document.id).document.title, edited.document.title);
    await rejectCode(workspace.write(member.userId, { ...copyInAction, mutationId: mutation() }, operation()), "GROUP_CONFLICT");
    savedSource = (await personal.write(member.userId, { action: "delete", graphId: source.id,
      expectedRevision: savedSource.revision, mutationId: mutation() }, operation())).record;
    await rejectCode(workspace.write(member.userId, { ...copyInAction, sourceRevision: savedSource.revision, mutationId: mutation() }, operation()), "GROUP_NOT_FOUND");
    savedSource = (await personal.write(member.userId, { action: "restore", graphId: source.id,
      expectedRevision: savedSource.revision, mutationId: mutation() }, operation())).record;

    // 默认排除已在前面验证，此处显式附带当前版本。组成员只编辑共享副本，个人源仍归原账号。
    const includeNotes = { ...copyInAction, includeNotes: true, sourceRevision: savedSource.revision, mutationId: mutation() };
    await rejectCode(workspace.write(owner.userId, includeNotes, operation()), "GROUP_NOT_FOUND");
    const sharedNote = latest((await workspace.write(member.userId, includeNotes, operation())).workspace);
    assert.deepEqual(notesOf(sharedNote.document), [privateNote]);
    assert.deepEqual(notesOf(sharedNote.history.base.graph), [privateNote]);
    assert.equal(sharedNote.history.events.length, 0);
    const sharedEdit = { action: "edit" as const, groupId: groupA, graphId: sharedNote.document.id,
      expectedRevision: sharedNote.revision, before: sharedNote.document };
    const revisedNote = { ...privateNote, title: "小组的笔记", markdown: `${privateNote.markdown}\n\n小组补了一段。` };
    const editedNote = record((await workspace.write(member.userId, { ...sharedEdit,
      after: withNotes(sharedNote.document, [revisedNote]), kind: "note.edit", subject: revisedNote.title, mutationId: mutation() }, operation())).workspace, sharedNote.document.id);
    assert.deepEqual(notesOf(record(await workspace.read(owner.userId, groupA, operation()), sharedNote.document.id).document), [revisedNote]);
    await rejectCode(workspace.write(owner.userId, { ...sharedEdit, after: withNotes(sharedNote.document, [{ ...privateNote, title: "另一标题" }]),
      kind: "note.edit", subject: "同一字段抢写", mutationId: mutation() }, operation()), "GROUP_CONFLICT");

    const copySharedNote = { action: "copyOut" as const, groupId: groupA, graphId: editedNote.document.id, expectedRevision: editedNote.revision };
    const copyWithoutNote = (await workspace.write(owner.userId, { ...copySharedNote, mutationId: mutation() }, operation())).personalGraph;
    assert.ok(copyWithoutNote);
    assert.deepEqual(notesOf(copyWithoutNote.document), []);
    assert.deepEqual(notesOf(copyWithoutNote.history.base.graph), []);
    const copyWithNote = { ...copySharedNote, includeNotes: true, mutationId: mutation() };
    const includedNote = (await workspace.write(owner.userId, copyWithNote, operation())).personalGraph;
    assert.ok(includedNote);
    assert.notEqual(includedNote.document.id, editedNote.document.id);
    assert.deepEqual(notesOf(includedNote.document), [revisedNote]);
    assert.equal(includedNote.history.events.length, 0);
    assert.deepEqual(notesOf(includedNote.history.base.graph), [revisedNote]);
    const receipt = await workspace.receipt(owner.userId, copyWithNote.mutationId, operation());
    assert.equal(receipt.personalGraphId, includedNote.document.id);

    // 删除与撤销经真实事务写入，作者以当前会话为准。另一成员或另一归属的记录不得被改动。
    const deletedNote = record((await workspace.write(member.userId, { ...sharedEdit, expectedRevision: editedNote.revision,
      before: editedNote.document, after: withNotes(editedNote.document, []), kind: "note.delete", subject: revisedNote.title,
      mutationId: mutation() }, operation())).workspace, sharedNote.document.id);
    assert.deepEqual(notesOf(deletedNote.document), []);
    const deletion = deletedNote.history.events.at(-1);
    assert.ok(deletion);
    assert.equal(deletion.actorUserId, member.userId);
    const undoNote = { action: "undo" as const, groupId: groupA, graphId: sharedNote.document.id,
      expectedRevision: deletedNote.revision, eventId: deletion.id, mutationId: mutation() };
    await rejectCode(workspace.write(owner.userId, undoNote, operation()), "GROUP_FORBIDDEN");
    const restoredNote = record((await workspace.write(member.userId, undoNote, operation())).workspace, sharedNote.document.id);
    assert.deepEqual(notesOf(restoredNote.document), [revisedNote]);
    assertReplay(restoredNote);
    assert.deepEqual((await personal.read(member.userId, operation())).graphs.find(row => row.document.id === source.id), savedSource);
    assert.deepEqual((await personal.read(owner.userId, operation())).graphs.find(row => row.document.id === includedNote.document.id), includedNote);

    const copyOutAction = { action: "copyOut" as const, groupId: groupA, graphId: edited.document.id,
      expectedRevision: edited.revision, mutationId: mutation() };
    const copiedOut = (await workspace.write(member.userId, copyOutAction, operation())).personalGraph;
    assert.ok(copiedOut);
    assert.notEqual(copiedOut.document.id, edited.document.id);
    assert.equal(copiedOut.history.events.length, 0);
    assert.deepEqual(copiedOut.history.redoIds, []);
    assert.deepEqual(Object.keys(copiedOut.document.positions), ["B", "A"]);
    assert.deepEqual(copiedOut.document.nodes, edited.document.nodes);
    const beforeCopyOutRetry = await personal.read(member.userId, operation());
    await workspace.write(member.userId, copyOutAction, operation());
    assert.deepEqual(await personal.read(member.userId, operation()), beforeCopyOutRetry);
    assert.equal((await workspace.receipt(member.userId, copyOutAction.mutationId, operation())).personalGraphId, copiedOut.document.id);
    const changedCopy = { ...copiedOut.document, title: "个人副本的独立修改" };
    const changedCopyHistory = appendHistory(createGraphHistory(copiedOut.document), copiedOut.document, changedCopy,
      { id: randomUUID(), kind: "graph.rename", subject: changedCopy.title, active: true, occurredAt: at }, 100);
    await personal.write(member.userId, { action: "save", document: changedCopy, history: storeGraphHistory(changedCopyHistory),
      expectedRevision: copiedOut.revision, mutationId: mutation() }, operation());
    assert.equal(record(await workspace.read(member.userId, groupA, operation()), edited.document.id).document.title, edited.document.title);

    // 复制写入后故障发生于收据落库，个人副本／组图／元数据必须和收据一起回滚。
    const fault = observer();
    fault.beforeQuery = (sql, values) => { if (userInsert(sql, values, "gw_")) throw new Error("fixture_receipt_interrupted"); };
    const faultWorkspace = createGroupWorkspaceStorage(fault), beforePersonal = await personal.read(member.userId, operation());
    const failedCopyOut = { ...copyOutAction, mutationId: mutation() };
    await rejectCode(faultWorkspace.write(member.userId, failedCopyOut, operation()), "DATABASE_UNAVAILABLE");
    assert.deepEqual(await personal.read(member.userId, operation()), beforePersonal);
    assert.equal((await workspace.receipt(member.userId, failedCopyOut.mutationId, operation())).applied, false);
    const beforeCopyInFailure = await workspace.read(member.userId, groupA, operation());
    const failedCopyIn = { ...copyInAction, sourceRevision: savedSource.revision, mutationId: mutation() };
    await rejectCode(faultWorkspace.write(member.userId, failedCopyIn, operation()), "DATABASE_UNAVAILABLE");
    assert.deepEqual(await workspace.read(member.userId, groupA, operation()), beforeCopyInFailure);
    assert.equal((await workspace.receipt(member.userId, failedCopyIn.mutationId, operation())).applied, false);
    const cancelled = new AbortController(); cancelled.abort();
    await rejectCode(workspace.write(member.userId, { ...copyOutAction, mutationId: mutation() }, databaseOperation(cancelled.signal)), "DATABASE_CANCELLED");

    const originalOrder = [...(await workspace.read(owner.userId, groupA, operation())).activeOrder];
    const deleted = record((await workspace.write(member.userId, { action: "delete", groupId: groupA,
      graphId: edited.document.id, expectedRevision: edited.revision, mutationId: mutation() }, operation())).workspace, edited.document.id);
    assert.equal(deleted.originalIndex, originalOrder.indexOf(edited.document.id));
    assert.deepEqual(deleted.history, edited.history);
    const restored = record((await workspace.write(owner.userId, { action: "restore", groupId: groupA,
      graphId: deleted.document.id, expectedRevision: deleted.revision, mutationId: mutation() }, operation())).workspace, deleted.document.id);
    assert.deepEqual((await workspace.read(owner.userId, groupA, operation())).activeOrder, originalOrder);
    assert.deepEqual(restored.history, edited.history);
    assertReplay(restored);
    assert.deepEqual((await workspace.read(owner.userId, groupB, operation())).deletedIds, []);
    assert.deepEqual((await personal.read(member.userId, operation())).deletedIds, []);
    await rejectCode(workspace.write(member.userId, { action: "edit", groupId: groupB, graphId: edited.document.id,
      expectedRevision: restored.revision, before: restored.document, after: { ...restored.document, title: "跨组误写" },
      kind: "graph.rename", subject: "跨组误写", mutationId: mutation() }, operation()), "GROUP_NOT_FOUND");

    let firstDeleted: GroupGraphRecord | undefined, lastDeleted: GroupGraphRecord | undefined;
    for (let index = 0; index < 101; index++) {
      const temporary = latest((await workspace.write(member.userId, { action: "create", groupId: groupA,
        document: empty(`删除窗口${index}`), mutationId: mutation() }, operation())).workspace);
      lastDeleted = record((await workspace.write(owner.userId, { action: "delete", groupId: groupA,
        graphId: temporary.document.id, expectedRevision: temporary.revision, mutationId: mutation() }, operation())).workspace, temporary.document.id);
      firstDeleted ??= lastDeleted;
    }
    assert.ok(firstDeleted && lastDeleted);
    const afterWindow = await workspace.read(member.userId, groupA, operation());
    assert.equal(afterWindow.deletedIds.length, 100);
    assert.ok(!afterWindow.graphs.some(value => value.document.id === firstDeleted.document.id));
    await rejectCode(workspace.write(member.userId, { action: "restore", groupId: groupA,
      graphId: firstDeleted.document.id, expectedRevision: firstDeleted.revision, mutationId: mutation() }, operation()), "GROUP_CONFLICT");
    await rejectCode(workspace.write(member.userId, { action: "edit", groupId: groupA, graphId: firstDeleted.document.id,
      expectedRevision: firstDeleted.revision, before: firstDeleted.document, after: { ...firstDeleted.document, title: "墓碑不得复活" },
      kind: "graph.rename", subject: "墓碑不得复活", mutationId: mutation() }, operation()), "GROUP_CONFLICT");
    const windowRestored = record((await workspace.write(member.userId, { action: "restore", groupId: groupA,
      graphId: lastDeleted.document.id, expectedRevision: lastDeleted.revision, mutationId: mutation() }, operation())).workspace, lastDeleted.document.id);
    assert.equal(windowRestored.revision, lastDeleted.revision + 1);
    assert.equal((await workspace.read(member.userId, groupA, operation())).activeOrder[lastDeleted.originalIndex ?? -1], windowRestored.document.id);

    // 确认丢失后按本人收据查回；解散不删除个人副本，也不允许 POST 重试再建一份。
    const receiptBefore = await workspace.receipt(member.userId, copyOutAction.mutationId, operation());
    assert.equal(receiptBefore.personalGraphId, copiedOut.document.id);
    assert.equal((await workspace.receipt(outsider.userId, copyOutAction.mutationId, operation())).applied, false);
    const groupBeforeDissolve = await groups.read(owner.userId, groupA, operation());
    await groups.write(owner, { action: "dissolve", groupId: groupA, expectedRevision: groupBeforeDissolve.group.revision, mutationId: mutation() }, operation());
    assert.deepEqual(await workspace.receipt(member.userId, copyOutAction.mutationId, operation()), receiptBefore);
    const personalBeforeRetry = await personal.read(member.userId, operation());
    await rejectCode(workspace.write(member.userId, copyOutAction, operation()), "GROUP_NOT_FOUND");
    assert.deepEqual(await personal.read(member.userId, operation()), personalBeforeRetry);
    await rejectCode(workspace.read(member.userId, groupA, operation()), "GROUP_NOT_FOUND");
    assert.equal(personalBeforeRetry.graphs.find(value => value.document.id === source.id)?.history.events.length, 2);

    // 两个确定性事务屏障覆盖复制／解散的两种提交顺序，不靠 sleep 猜测锁竞争时机。
    for (const copyFirst of [true, false]) {
      const raceGroup = await makeGroup(copyFirst ? "先复制再解散" : "先解散再复制");
      const raceGraph = latest((await workspace.write(member.userId, { action: "create", groupId: raceGroup,
        document: empty("复制竞争假图"), mutationId: mutation() }, operation())).workspace);
      const currentGroup = await groups.read(owner.userId, raceGroup, operation());
      const holder = observer(), waiter = observer(), holderReached = gate(), allowHolder = gate(), waiterIssued = gate();
      releaseGates.push(allowHolder.release);
      holder.beforeQuery = async (sql, values) => {
        const shouldPause = copyFirst ? userInsert(sql, values, "g_")
          : /^DELETE FROM wf_groups WHERE groupId = \?$/i.test(sql) && values?.[0] === raceGroup;
        if (shouldPause) { holderReached.release(); await allowHolder.reached; }
      };
      waiter.issuedQuery = (sql, values) => { if (groupLockQuery(sql, values, raceGroup)) waiterIssued.release(); };
      const copyAction = { action: "copyOut" as const, groupId: raceGroup, graphId: raceGraph.document.id,
        expectedRevision: raceGraph.revision, mutationId: mutation() };
      const dissolveAction = { action: "dissolve" as const, groupId: raceGroup, expectedRevision: currentGroup.group.revision, mutationId: mutation() };
      const personalBeforeRace = await personal.read(member.userId, operation());
      const heldCopy = copyFirst ? observe(createGroupWorkspaceStorage(holder).write(member.userId, copyAction, operation())) : undefined;
      const heldDissolve = copyFirst ? undefined : observe(createGroupStorage(holder).write(owner, dissolveAction, operation()));
      let waitedCopy: ReturnType<typeof observe<Awaited<ReturnType<typeof workspace.write>>>> | undefined;
      let waitedDissolve: ReturnType<typeof observe<Awaited<ReturnType<typeof groups.write>>>> | undefined;
      try {
        await awaitGate(holderReached.reached);
        if (copyFirst) waitedDissolve = observe(createGroupStorage(waiter).write(owner, dissolveAction, operation()));
        else waitedCopy = observe(createGroupWorkspaceStorage(waiter).write(member.userId, copyAction, operation()));
        await awaitGate(waiterIssued.reached);
      } finally { allowHolder.release(); }
      if (copyFirst) {
        assert.ok(heldCopy && waitedDissolve);
        const copyResult = await heldCopy, dissolveResult = await waitedDissolve;
        if (!copyResult.ok) throw copyResult.error;
        if (!dissolveResult.ok) throw dissolveResult.error;
        assert.ok(copyResult.value.personalGraph);
        assert.ok((await personal.read(member.userId, operation())).activeOrder.includes(copyResult.value.personalGraph.document.id));
        assert.equal((await workspace.receipt(member.userId, copyAction.mutationId, operation())).applied, true);
      } else {
        assert.ok(heldDissolve && waitedCopy);
        const dissolveResult = await heldDissolve, copyResult = await waitedCopy;
        if (!dissolveResult.ok) throw dissolveResult.error;
        assert.equal(copyResult.ok, false);
        if (!copyResult.ok) assert.equal(z.object({ code: z.string() }).parse(copyResult.error).code, "GROUP_NOT_FOUND");
        assert.deepEqual(await personal.read(member.userId, operation()), personalBeforeRace);
        assert.equal((await workspace.receipt(member.userId, copyAction.mutationId, operation())).applied, false);
      }
      await rejectCode(workspace.read(member.userId, raceGroup, operation()), "GROUP_NOT_FOUND");
    }

    // 固定同形图及 Markdown 样例，只改变正文和历史。全部通过真实存档和显式复制生成独立组图。
    const longBody = Array.from({ length: 160 }, (_, index) => `${index}. Compare an example and record the useful details.\n`).join("").slice(0, 8_192);
    assert.equal(Buffer.byteLength(longBody), 8_192);
    const largeNote = { ...privateNote, id: "long-note", markdown: longBody };
    const manyNotes = [largeNote, ...Array.from({ length: 7 }, (_, index) => ({ ...privateNote, id: `short-note-${index}`,
      title: `练习 ${index + 1}`, markdown: longBody.slice(index * 100, index * 100 + 1_024) }))];
    const noteSizes: Array<Awaited<ReturnType<typeof measureNoteSnapshot>> & { name: string }> = [];
    for (const [name, notes] of [["baseline", []], ["long", [largeNote]], ["many", manyNotes]] as const) {
      const targetGroup = await makeGroup("笔记存档用量样例");
      const personalSample = withNotes({ ...base, id: randomUUID(), title: "笔记存档用量样例" }, [...notes]);
      const personalRecord = (await personal.write(member.userId, { action: "save", expectedRevision: 0, mutationId: mutation(),
        document: personalSample, history: storeGraphHistory(createGraphHistory(personalSample)) }, operation())).record;
      let sample = latest((await workspace.write(member.userId, { action: "copyIn", includeNotes: notes.length > 0, groupId: targetGroup,
        sourceGraphId: personalSample.id, sourceRevision: personalRecord.revision, mutationId: mutation() }, operation())).workspace);
      noteSizes.push({ name, ...await measureNoteSnapshot(db, member.userId, targetGroup, operation) });
      if (name === "many") {
        for (let index = 1; index <= 12; index++) {
          // 只修改长笔记，另外七条从未编辑，用于区分正文增长和历史累积造成的开销。
          const text = `${longBody.slice(0, -2)}${String(index).padStart(2, "0")}`;
          const after = withNotes(sample.document, [{ ...largeNote, markdown: text }, ...manyNotes.slice(1)]);
          sample = latest((await workspace.write(member.userId, { action: "edit", groupId: targetGroup, graphId: sample.document.id,
            expectedRevision: sample.revision, before: sample.document, after, kind: "note.edit", subject: "修改固定样例", mutationId: mutation() }, operation())).workspace);
        }
        assert.equal(sample.history.events.length, 12);
        assert.deepEqual(notesOf(sample.document).slice(1), manyNotes.slice(1));
        assertReplay(sample);
        noteSizes.push({ name: "many-edited", ...await measureNoteSnapshot(db, member.userId, targetGroup, operation) });
      }
      const revision = (await groups.read(owner.userId, targetGroup, operation())).group.revision;
      await groups.write(owner, { action: "dissolve", groupId: targetGroup, expectedRevision: revision, mutationId: mutation() }, operation());
    }
    const [baseline, long, many, editedMany] = noteSizes;
    assert.ok(baseline && long && many && editedMany);
    assert.ok(baseline.storedGraphBytes < long.storedGraphBytes && long.storedGraphBytes < many.storedGraphBytes);
    assert.equal(editedMany.documentBytes, many.documentBytes);
    assert.ok(editedMany.historyBytes > many.historyBytes && editedMany.frameBytes > many.frameBytes);
    console.info("D13_NOTE_SNAPSHOT_COST", JSON.stringify(noteSizes));
  } finally {
    for (const release of releaseGates) release();
    const cleanup = await Promise.allSettled([
      ...[...groupIds].map(id => db.query(operation(), "DELETE FROM wf_groups WHERE groupId = ?", [id])),
      ...identities.map(person => db.query(operation(), "DELETE FROM wf_user_data WHERE userId = ?", [person.userId])),
    ]);
    cleanupFailed = cleanup.some(result => result.status === "rejected");
  }
  if (cleanupFailed) throw new Error("本轮组图假数据未完全清理");
  console.info("组图真实 SQL：多图／版本／图与历史重放／布局键序／双向空历史复制／笔记隐私及组员改删／源保留与独立编辑／收据幂等／100与101删除恢复／墓碑／组隔离／复制事务回滚／取消／复制与解散双向锁竞争通过");
} catch {
  console.error("组图 SQL 隔离验证失败；核对本地测试配置与组图服务，不输出原始异常或配置");
  process.exitCode = 1;
} finally {
  for (const release of releaseGates) release();
  for (const observed of observedDatabases) await observed.close();
  await database?.close();
}
