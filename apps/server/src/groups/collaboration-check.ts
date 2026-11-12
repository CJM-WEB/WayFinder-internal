/**
 * 显式多人编辑 SQL 回归：只访问回环 wf_d12_test_ 假数据库，不读取 .env 或调用真实检索。
 * 两名成员提交同一旧基线，验证独立字段合并、冲突、本人撤销／重做及各人100步窗口。
 * 失败动作同时核对共享状态和本人收据；所有假身份在结束后精确清理。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import process from "node:process";
import {
  EditableGraphSchema, canonicalizeHttpUrl, type EditableGraph, type EditableNode, type GroupGraphAction,
  type GroupGraphRecord, type GroupWorkspaceResponse,
} from "@wayfinder/contracts";
import { createGraphHistory, storeGraphHistory } from "@wayfinder/contracts/graph-history";

import { AccountDatabase, databaseConfigFromUrl, databaseOperation, migrateAccountData } from "../accounts/database.js";
import { createAccountProfileStorage } from "../accounts/profile-storage.js";
import { createWorkspaceStorage } from "../accounts/workspace-storage.js";
import { migrateGroupData } from "./database.js";
import { restoreGroupHistory } from "./history.js";
import { createGroupStorage } from "./storage.js";
import { createGroupWorkspaceStorage } from "./workspace-storage.js";

const node = (document: EditableGraph, id: string): EditableNode => {
  const found = document.nodes.find(value => value.id === id);
  assert.ok(found);
  return found;
};
const withNode = (document: EditableGraph, id: string, patch: Partial<EditableNode>): EditableGraph =>
  EditableGraphSchema.parse({ ...document, nodes: document.nodes.map(value => value.id === id ? { ...value, ...patch } : value) });
const removeNode = (document: EditableGraph, id: string): EditableGraph => {
  const positions = { ...document.positions }; delete positions[id];
  return EditableGraphSchema.parse({ ...document, nodes: document.nodes.filter(value => value.id !== id),
    edges: document.edges.filter(value => value.source !== id && value.target !== id), positions });
};
const resource = (id: string, url: string) => {
  const canonical = canonicalizeHttpUrl(url); assert.ok(canonical);
  return { id, url, canonicalUrl: canonical.href, domain: canonical.hostname, title: "假资源", summary: "", whySelected: "",
    rank: 1, origin: "manual" as const, sourceType: "user_added" as const };
};
const record = (snapshot: GroupWorkspaceResponse, id: string): GroupGraphRecord => {
  const found = snapshot.graphs.find(value => value.document.id === id); assert.ok(found);
  restoreGroupHistory(found.history, found.document);
  return found;
};

let database: AccountDatabase | undefined;
try {
  const raw = process.env.WF_TEST_MYSQL_URL;
  if (!raw) throw new Error("缺少测试配置");
  const config = databaseConfigFromUrl(raw);
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host)
    || !/^wf_d12_test_[A-Za-z0-9_]+$/.test(config.database)) throw new Error("非隔离测试库");
  database = new AccountDatabase(config);
  const db = database, operation = () => databaseOperation(new AbortController().signal, 5_000);
  const runId = randomUUID(), mutation = () => randomUUID();
  const identity = (label: string) => ({ userId: `${label}_${runId}`, sessionId: `session_${label}_${runId}`, email: `${label}@example.com` });
  const a = identity("fixtureCollaboratorA"), b = identity("fixtureCollaboratorB");
  const groups = createGroupStorage(db), workspace = createGroupWorkspaceStorage(db), profiles = createAccountProfileStorage(db);
  const personal = createWorkspaceStorage(db);
  let groupId: string | undefined;
  const at = "2026-11-12T00:00:00.000Z";
  await migrateAccountData(db, operation()); await migrateGroupData(db, operation());
  let cleanupFailed = false;
  try {
    await profiles.write(a.userId, "甲", operation()); await profiles.write(b.userId, "乙", operation());
    const made = await groups.write(a, { action: "create", name: "多人SQL假组", description: "", mutationId: mutation() }, operation());
    assert.ok(made.details?.invitationCode); groupId = made.details.group.groupId;
    const targetGroup = groupId;
    await groups.write(b, { action: "join", invitationCode: made.details.invitationCode, mutationId: mutation() }, operation());
    const read = async (id: string) => record(await workspace.read(a.userId, targetGroup, operation()), id);
    const create = async (title: string) => {
      const input = EditableGraphSchema.parse({ version: "workspace.v1", id: randomUUID(), title, query: "", language: "zh-CN",
        presentationMode: "graph", createdAt: at, updatedAt: at, lastRunId: null,
        nodes: ["A", "B"].map(id => ({ id, title: id, description: "", nodeType: "primary", layer: 0, status: "empty", resources: [], warnings: [] })),
        edges: [], positions: { B: { x: 20, y: 30 }, A: { x: 40, y: 50 } } });
      const result = await workspace.write(a.userId, { action: "create", groupId: targetGroup, document: input, mutationId: mutation() }, operation());
      const id = result.workspace.activeOrder.at(-1); assert.ok(id);
      return record(result.workspace, id);
    };
    const action = (before: GroupGraphRecord, after: EditableGraph, kind: Extract<GroupGraphAction, { action: "edit" }>["kind"] = "graph.update"): Extract<GroupGraphAction, { action: "edit" }> => ({
      action: "edit", groupId: targetGroup, graphId: before.document.id, expectedRevision: before.revision,
      before: before.document, after, kind, subject: "多人SQL确定性修改", mutationId: mutation(),
    });
    const write = async (userId: string, input: GroupGraphAction) => {
      const result = await workspace.write(userId, input, operation());
      assert.ok("graphId" in input);
      return record(result.workspace, input.graphId);
    };
    const undo = (before: GroupGraphRecord, eventId: string): Extract<GroupGraphAction, { action: "undo" }> => ({
      action: "undo", groupId: targetGroup, graphId: before.document.id, expectedRevision: before.revision, eventId, mutationId: mutation(),
    });
    const redo = (before: GroupGraphRecord): Extract<GroupGraphAction, { action: "redo" }> => ({
      action: "redo", groupId: targetGroup, graphId: before.document.id, expectedRevision: before.revision, mutationId: mutation(),
    });
    const fail = async (userId: string, input: GroupGraphAction, code: string, receiptWasApplied = false) => {
      const before = await workspace.read(a.userId, targetGroup, operation());
      await assert.rejects(workspace.write(userId, input, operation()), { code });
      assert.deepEqual(await workspace.read(a.userId, targetGroup, operation()), before);
      assert.equal((await workspace.receipt(userId, input.mutationId, operation())).applied, receiptWasApplied);
    };
    const lastEvent = (value: GroupGraphRecord, userId: string) => {
      const event = value.history.events.findLast(item => item.actorUserId === userId && item.active && item.undoable);
      assert.ok(event); return event;
    };

    // 普通create与人工编辑一样不信任派生字段；实际相同URL不能借伪canonical绕过去重。
    const normalizationSeed = await create("入库规范化固定样例");
    const claimedSearchResource = { ...resource("claimed_search", "https://fixture.example/create-source#fragment"),
      canonicalUrl: "https://forged.example/create-source", domain: "forged.example", origin: "search" as const,
      searchProvider: "fixture_provider", sourceType: "claimed_official", publishedAt: at, scores: { fixture: 1 } };
    const claimedSearchDocument = withNode({ ...normalizationSeed.document, lastRunId: "fixture_claimed_run" }, "A", { status: "ready", resources: [claimedSearchResource] });
    const normalizedResponse = await workspace.write(a.userId, { action: "create", groupId: targetGroup,
      document: claimedSearchDocument, mutationId: mutation() }, operation());
    const normalizedId = normalizedResponse.workspace.activeOrder.at(-1); assert.ok(normalizedId);
    const normalized = record(normalizedResponse.workspace, normalizedId), normalizedNode = node(normalized.document, "A");
    assert.equal(normalized.document.lastRunId, null);
    assert.equal(normalizedNode.status, "edited"); assert.deepEqual(normalizedNode.warnings, []);
    assert.equal(normalizedNode.resources[0]?.origin, "manual"); assert.equal(normalizedNode.resources[0]?.sourceType, "user_added");
    assert.equal(normalizedNode.resources[0]?.canonicalUrl, "https://fixture.example/create-source");
    assert.equal(normalizedNode.resources[0]?.domain, "fixture.example");
    assert.equal("searchProvider" in normalizedNode.resources[0]!, false);
    assert.equal(normalizedNode.resources[0]?.publishedAt, undefined); assert.equal(normalizedNode.resources[0]?.scores, undefined);
    const derivedRevision = (await workspace.read(a.userId, targetGroup, operation())).revision;
    assert.deepEqual(await write(b.userId, action(normalized, withNode(normalized.document, "A", { status: "ready" }), "node.edit")), normalized);
    assert.deepEqual(await write(b.userId, action(normalized, withNode(normalized.document, "A", { status: "partial", warnings: ["RERANK_FAILED"] }), "node.edit")), normalized);
    assert.equal((await workspace.read(a.userId, targetGroup, operation())).revision, derivedRevision);
    const duplicateCreate = EditableGraphSchema.parse({ ...normalizationSeed.document,
      nodes: normalizationSeed.document.nodes.map(value => ({ ...value, status: "edited", resources: [{
        ...resource(`duplicate_${value.id}`, `https://fixture.example/create-duplicate#${value.id}`),
        canonicalUrl: `https://forged.example/${value.id}`, domain: "forged.example",
      }] })) });
    await fail(a.userId, { action: "create", groupId: targetGroup, document: duplicateCreate, mutationId: mutation() }, "GROUP_CONSTRAINT");

    // 私有旧记录可能只有形状正确；复制遇到实际URL与派生字段不一致须拒绝，不能修改源来蒙混通过。
    const badPrivate = EditableGraphSchema.parse({ ...claimedSearchDocument, id: randomUUID() });
    const badPrivateSaved = (await personal.write(a.userId, { action: "save", document: badPrivate,
      history: storeGraphHistory(createGraphHistory(badPrivate)), expectedRevision: 0, mutationId: mutation() }, operation())).record;
    const beforeBadCopy = await personal.read(a.userId, operation());
    await fail(a.userId, { action: "copyIn", groupId: targetGroup, sourceGraphId: badPrivate.id,
      sourceRevision: badPrivateSaved.revision, mutationId: mutation() }, "GROUP_CONSTRAINT");
    assert.deepEqual(await personal.read(a.userId, operation()), beforeBadCopy);
    const validSearchDocument = withNode({ ...badPrivate, id: randomUUID() }, "A", { resources: [{ ...claimedSearchResource,
      canonicalUrl: "https://fixture.example/create-source", domain: "fixture.example" }] });
    const validSearchSaved = (await personal.write(a.userId, { action: "save", document: validSearchDocument,
      history: storeGraphHistory(createGraphHistory(validSearchDocument)), expectedRevision: 0, mutationId: mutation() }, operation())).record;
    const searchCopied = (await workspace.write(a.userId, { action: "copyIn", groupId: targetGroup, sourceGraphId: validSearchDocument.id,
      sourceRevision: validSearchSaved.revision, mutationId: mutation() }, operation())).workspace;
    const searchCopyId = searchCopied.activeOrder.at(-1); assert.ok(searchCopyId);
    const searchCopy = record(searchCopied, searchCopyId);
    assert.deepEqual(node(searchCopy.document, "A").resources, node(validSearchDocument, "A").resources);
    assert.equal(node(searchCopy.document, "A").status, "ready");
    const invalidScopedResource = { ...node(searchCopy.document, "A").resources[0]!, canonicalUrl: "https://forged.example/scoped", domain: "forged.example" };
    // 公开编辑已不能伪装搜索范围；真实签名结果的URL／CAS在search-check显式回归。
    const invalidScopedAction = { ...action(searchCopy, withNode(searchCopy.document, "A", { resources: [invalidScopedResource] })),
      scope: { type: "graph.replace" } };
    await fail(a.userId, invalidScopedAction, "GROUP_INVALID");
    const copiedBack = (await workspace.write(b.userId, { action: "copyOut", groupId: targetGroup, graphId: searchCopyId,
      expectedRevision: searchCopy.revision, mutationId: mutation() }, operation())).personalGraph;
    assert.ok(copiedBack);
    assert.deepEqual(node(copiedBack.document, "A").resources, node(validSearchDocument, "A").resources);
    assert.equal(node(copiedBack.document, "A").status, "ready");

    // 合法搜索URL可保留大写主机和省略尾斜杠的原始表示；无关编辑不能把搜索状态误变成人工编辑。
    const untouchedSearch = withNode({ ...validSearchDocument, id: randomUUID(), title: "保留原始搜索表示" }, "A", {
      status: "partial", warnings: ["RERANK_FAILED"], resources: [{ ...node(validSearchDocument, "A").resources[0]!,
        url: "https://Fixture.Example", canonicalUrl: "https://fixture.example/", domain: "fixture.example" }],
    });
    const untouchedSaved = (await personal.write(a.userId, { action: "save", document: untouchedSearch,
      history: storeGraphHistory(createGraphHistory(untouchedSearch)), expectedRevision: 0, mutationId: mutation() }, operation())).record;
    const untouchedCopiedResponse = await workspace.write(a.userId, { action: "copyIn", groupId: targetGroup,
      sourceGraphId: untouchedSearch.id, sourceRevision: untouchedSaved.revision, mutationId: mutation() }, operation());
    const untouchedId = untouchedCopiedResponse.workspace.activeOrder.at(-1); assert.ok(untouchedId);
    const untouchedCopied = record(untouchedCopiedResponse.workspace, untouchedId);
    assert.deepEqual(node(untouchedCopied.document, "A"), node(untouchedSearch, "A"));
    const renamedUntouched = await write(a.userId, action(untouchedCopied,
      { ...untouchedCopied.document, title: "仅修改搜索图标题" }, "graph.rename"));
    assert.deepEqual(node(renamedUntouched.document, "A"), node(untouchedSearch, "A"));
    const changedOtherNode = await write(b.userId, action(renamedUntouched,
      withNode(renamedUntouched.document, "B", { description: "只编辑另一个节点" }), "node.edit"));
    assert.deepEqual(node(changedOtherNode.document, "A"), node(untouchedSearch, "A"));
    const untouchedCopiedBack = (await workspace.write(b.userId, { action: "copyOut", groupId: targetGroup,
      graphId: untouchedId, expectedRevision: changedOtherNode.revision, mutationId: mutation() }, operation())).personalGraph;
    assert.ok(untouchedCopiedBack);
    assert.deepEqual(node(untouchedCopiedBack.document, "A"), node(untouchedSearch, "A"));
    assert.deepEqual((await personal.read(a.userId, operation())).graphs.find(value => value.document.id === untouchedSearch.id), untouchedSaved);

    // 同一基线的不同节点、同节点不同字段均可合并；相同字段不覆盖后来者。
    const mergeBase = await create("独立字段合并");
    await write(a.userId, action(mergeBase, withNode(mergeBase.document, "A", { title: "甲改节点A" }), "node.edit"));
    let merged = await write(b.userId, action(mergeBase, withNode(mergeBase.document, "B", { title: "乙改节点B" }), "node.edit"));
    assert.equal(node(merged.document, "A").title, "甲改节点A"); assert.equal(node(merged.document, "B").title, "乙改节点B");
    const sameNodeBase = merged;
    await write(a.userId, action(sameNodeBase, withNode(sameNodeBase.document, "A", { title: "甲再改标题" }), "node.edit"));
    merged = await write(b.userId, action(sameNodeBase, withNode(sameNodeBase.document, "A", { description: "乙补说明" }), "node.edit"));
    assert.equal(node(merged.document, "A").title, "甲再改标题"); assert.equal(node(merged.document, "A").description, "乙补说明");
    await fail(b.userId, action(sameNodeBase, withNode(sameNodeBase.document, "A", { title: "乙并发覆盖标题" }), "node.edit"), "GROUP_CONFLICT");

    const resourceBase = await create("资源独立追加");
    await write(a.userId, action(resourceBase, withNode(resourceBase.document, "A", { status: "edited", resources: [resource("first", "https://fixture.example/first")] }), "resource.add"));
    const appended = await write(b.userId, action(resourceBase, withNode(resourceBase.document, "A", { status: "edited", resources: [resource("second", "https://fixture.example/second")] }), "resource.add"));
    assert.deepEqual(new Set(node(appended.document, "A").resources.map(value => value.id)), new Set(["first", "second"]));
    assert.deepEqual(node(appended.document, "A").resources.map(value => value.rank), [1, 2]);
    const duplicateBase = await create("规范URL组合去重");
    await write(a.userId, action(duplicateBase, withNode(duplicateBase.document, "A", { status: "edited", resources: [resource("canonicalA", "https://fixture.example/same#one")] }), "resource.add"));
    await fail(b.userId, action(duplicateBase, withNode(duplicateBase.document, "B", { status: "edited", resources: [resource("canonicalB", "https://fixture.example/same#two")] }), "resource.add"), "GROUP_CONSTRAINT");
    const dagBase = await create("推荐线组合无环");
    await write(a.userId, action(dagBase, { ...dagBase.document, edges: [{ id: "ab", source: "A", target: "B", type: "recommended_next" }] }, "edge.add"));
    await fail(b.userId, action(dagBase, { ...dagBase.document, edges: [{ id: "ba", source: "B", target: "A", type: "recommended_next" }] }, "edge.add"), "GROUP_CONSTRAINT");
    const deleteBase = await create("删除与编辑冲突");
    await write(b.userId, action(deleteBase, withNode(deleteBase.document, "A", { description: "乙已经写入" }), "node.edit"));
    await fail(a.userId, action(deleteBase, removeNode(deleteBase.document, "A"), "node.delete"), "GROUP_CONFLICT");
    const linkBase = await create("删除与连线冲突");
    await write(b.userId, action(linkBase, { ...linkBase.document, edges: [{ id: "related", source: "A", target: "B", type: "related_to" }] }, "edge.add"));
    await fail(a.userId, action(linkBase, removeNode(linkBase.document, "A"), "node.delete"), "GROUP_DEPENDENCY");
    const removedBase = await create("已删除节点不复活");
    await write(a.userId, action(removedBase, removeNode(removedBase.document, "A"), "node.delete"));
    await fail(b.userId, action(removedBase, withNode(removedBase.document, "A", { title: "迟到修改" }), "node.edit"), "GROUP_CONFLICT");

    // 选择性撤销只作用于本人，后来者的同字段修改保留；无图内容变化的撤销仍保存事件状态。
    const titleBase = await create("原始撤销标题");
    const titleAAction = action(titleBase, { ...titleBase.document, title: "甲标题" }, "graph.rename");
    const titleA = await write(a.userId, titleAAction);
    assert.deepEqual(await write(a.userId, titleAAction), titleA);
    await fail(a.userId, { ...titleAAction, after: { ...titleAAction.after, title: "同标识不同内容" } }, "GROUP_CONFLICT", true);
    const eventA = lastEvent(titleA, a.userId);
    const titleB = await write(b.userId, action(titleA, { ...titleA.document, title: "乙标题" }, "graph.rename"));
    const eventB = lastEvent(titleB, b.userId);
    await fail(a.userId, undo(titleB, eventB.id), "GROUP_FORBIDDEN");
    const undoAAction = undo(titleB, eventA.id);
    const undoA = await write(a.userId, undoAAction);
    assert.equal(undoA.document.title, "乙标题"); assert.equal(undoA.revision, titleB.revision + 1);
    assert.equal(undoA.history.events.find(value => value.id === eventA.id)?.active, false);
    assert.deepEqual(await write(a.userId, undoAAction), undoA);
    await fail(a.userId, undo(undoA, eventA.id), "GROUP_CONFLICT");
    const undoB = await write(b.userId, undo(titleB, eventB.id));
    assert.equal(undoB.document.title, "原始撤销标题");
    const forged = { ...action(undoB, { ...undoB.document, title: "伪造作者" }, "graph.rename"), actorUserId: b.userId } as unknown as GroupGraphAction;
    await fail(a.userId, forged, "GROUP_INVALID");

    const dependencyBase = await create("新增依赖不能撤销");
    const extra: EditableNode = { id: "N", title: "甲新增节点", description: "", nodeType: "primary", layer: 0, status: "empty", resources: [], warnings: [] };
    const added = await write(a.userId, action(dependencyBase, { ...dependencyBase.document, nodes: [...dependencyBase.document.nodes, extra] }, "node.add"));
    const addedEvent = lastEvent(added, a.userId);
    const dependency = await write(b.userId, action(added, withNode(added.document, "N", { description: "乙依赖该节点的编辑" }), "node.edit"));
    await fail(a.userId, undo(dependency, addedEvent.id), "GROUP_DEPENDENCY");

    const redoBase = await create("本人重做隔离");
    const editedA = await write(a.userId, action(redoBase, withNode(redoBase.document, "A", { title: "甲重做标题" }), "node.edit"));
    const redoEventA = lastEvent(editedA, a.userId);
    let redoState = await write(a.userId, undo(editedA, redoEventA.id));
    redoState = await write(b.userId, action(redoState, withNode(redoState.document, "B", { description: "乙不清甲重做" }), "node.edit"));
    assert.deepEqual(redoState.history.redoIdsByUser[a.userId], [redoEventA.id]);
    redoState = await write(a.userId, redo(editedA));
    assert.equal(node(redoState.document, "A").title, "甲重做标题"); assert.equal(node(redoState.document, "B").description, "乙不清甲重做");
    const redoEventB = lastEvent(redoState, b.userId);
    redoState = await write(b.userId, undo(redoState, redoEventB.id));
    redoState = await write(a.userId, undo(redoState, redoEventA.id));
    redoState = await write(a.userId, action(redoState, withNode(redoState.document, "A", { description: "甲的新分支" }), "node.edit"));
    assert.deepEqual(redoState.history.redoIdsByUser[a.userId], []);
    assert.deepEqual(redoState.history.redoIdsByUser[b.userId], [redoEventB.id]);
    await fail(a.userId, redo(redoState), "GROUP_CONFLICT");
    redoState = await write(b.userId, redo(redoState));
    assert.equal(node(redoState.document, "A").description, "甲的新分支");

    const redoDagBase = await create("重做重新检查约束");
    const edgeAdded = await write(a.userId, action(redoDagBase, { ...redoDagBase.document, edges: [{ id: "redo_ab", source: "A", target: "B", type: "recommended_next" }] }, "edge.add"));
    let redoDag = await write(a.userId, undo(edgeAdded, lastEvent(edgeAdded, a.userId).id));
    redoDag = await write(b.userId, action(redoDag, { ...redoDag.document, edges: [{ id: "redo_ba", source: "B", target: "A", type: "recommended_next" }] }, "edge.add"));
    await fail(a.userId, redo(redoDag), "GROUP_CONSTRAINT");
    const layoutBase = await create("布局不占撤销事件");
    const renamedNode = await write(a.userId, action(layoutBase, withNode(layoutBase.document, "A", { title: "甲节点标题" }), "node.edit"));
    const moved = await write(b.userId, action(renamedNode, { ...renamedNode.document,
      positions: { ...renamedNode.document.positions, A: { x: 500, y: 600 } } }));
    assert.equal(moved.history.events.length, renamedNode.history.events.length);
    const layoutUndone = await write(a.userId, undo(renamedNode, lastEvent(renamedNode, a.userId).id));
    assert.deepEqual(layoutUndone.document.positions.A, { x: 500, y: 600 }); assert.equal(node(layoutUndone.document, "A").title, "A");

    const noopAction = action(layoutUndone, { ...layoutUndone.document, updatedAt: "2026-11-13T00:00:00.000Z" });
    assert.deepEqual(await write(a.userId, noopAction), layoutUndone);
    assert.deepEqual(await write(a.userId, noopAction), layoutUndone);
    await fail(a.userId, { ...action(layoutUndone, withNode(layoutUndone.document, "A", { title: "未来版本" }), "node.edit"), expectedRevision: layoutUndone.revision + 100 }, "GROUP_CONFLICT");
    const invalidStaleScope = { ...action(layoutBase, { ...layoutBase.document, title: "过期全图搜索替换" }), scope: { type: "graph.replace" } };
    await fail(a.userId, invalidStaleScope, "GROUP_INVALID");
    const cancelled = new AbortController(); cancelled.abort();
    const cancelledAction = action(layoutUndone, withNode(layoutUndone.document, "A", { title: "已取消修改" }), "node.edit");
    const beforeCancel = await workspace.read(a.userId, targetGroup, operation());
    await assert.rejects(workspace.write(a.userId, cancelledAction, databaseOperation(cancelled.signal)), { code: "DATABASE_CANCELLED" });
    assert.deepEqual(await workspace.read(a.userId, targetGroup, operation()), beforeCancel);
    assert.equal((await workspace.receipt(a.userId, cancelledAction.mutationId, operation())).applied, false);

    // 真实删除101张小图建立墓碑，确保新合并／撤销分支仍不能绕过既有删除恢复生命周期。
    let firstDeleted: GroupGraphRecord | undefined;
    for (let index = 0; index < 101; index++) {
      const temporary = await create(`墓碑窗口${index}`);
      const deleted = await write(a.userId, { action: "delete", groupId: targetGroup, graphId: temporary.document.id,
        expectedRevision: temporary.revision, mutationId: mutation() });
      firstDeleted ??= deleted;
      if (index === 0) await fail(b.userId, action(deleted, { ...deleted.document, title: "已删图迟到修改" }, "graph.rename"), "GROUP_CONFLICT");
    }
    assert.ok(firstDeleted);
    await fail(a.userId, action(firstDeleted, { ...firstDeleted.document, title: "墓碑迟到修改" }, "graph.rename"), "GROUP_CONFLICT");

    // 乙的早期可撤销事件阻挡甲过期前缀折叠；不能为了甲100条窗口抹去乙的事件。
    let window = await create("每人100步独立窗口");
    window = await write(b.userId, action(window, withNode(window.document, "B", { description: "乙最早保留" }), "node.edit"));
    const earlyB = lastEvent(window, b.userId);
    let earlyA: string | undefined;
    for (let index = 0; index < 101; index++) {
      window = await write(a.userId, action(window, withNode(window.document, "A", { description: `甲步骤${index}` }), "node.edit"));
      earlyA ??= lastEvent(window, a.userId).id;
    }
    assert.equal(window.history.events.filter(value => value.actorUserId === a.userId && value.undoable).length, 100);
    assert.equal(window.history.events.find(value => value.id === earlyB.id)?.undoable, true);
    assert.equal(window.history.events.find(value => value.id === earlyA)?.undoable, false);
    assert.ok(window.history.events.some(value => value.id === earlyA));
    assert.ok(earlyA);
    await fail(a.userId, undo(window, earlyA), "GROUP_CONFLICT");
    window = await write(b.userId, undo(window, earlyB.id));
    assert.equal(node(window.document, "A").description, "甲步骤100"); assert.equal(node(window.document, "B").description, "");
    for (let index = 0; index < 101; index++) {
      window = await write(b.userId, action(window, withNode(window.document, "B", { description: `乙步骤${index}` }), "node.edit"));
    }
    assert.equal(window.history.events.filter(value => value.actorUserId === a.userId && value.undoable).length, 100);
    assert.equal(window.history.events.filter(value => value.actorUserId === b.userId && value.undoable).length, 100);
    window = await write(a.userId, undo(window, lastEvent(window, a.userId).id));
    assert.equal(node(window.document, "A").description, "甲步骤99"); assert.equal(node(window.document, "B").description, "乙步骤100");
    const beforeExit = window;
    await groups.write(b, { action: "leave", groupId: targetGroup, mutationId: mutation() }, operation());
    assert.deepEqual((await read(window.document.id)).document, beforeExit.document);
    await fail(b.userId, action(beforeExit, withNode(beforeExit.document, "B", { description: "退出后迟到修改" }), "node.edit"), "GROUP_FORBIDDEN");
  } finally {
    const cleanup = await Promise.allSettled([
      ...(groupId === undefined ? [] : [db.query(operation(), "DELETE FROM wf_groups WHERE groupId = ?", [groupId])]),
      ...[a, b].map(person => db.query(operation(), "DELETE FROM wf_user_data WHERE userId = ?", [person.userId])),
    ]);
    cleanupFailed = cleanup.some(result => result.status === "rejected");
  }
  if (cleanupFailed) throw new Error("本轮协作假数据未完全清理");
  console.info("多人协作真实 SQL：入库来源与URL规范化／派生状态不可伪写／错误复制源拒绝且合法来源保留／未触碰搜索URL字节和状态保持／独立字段合并／同字段冲突／资源URL和DAG／删除依赖／本人撤销重做／双人100与101窗口／布局／幂等／未来与搜索版本／墓碑／取消／退出贡献通过");
} catch {
  console.error("多人协作 SQL 隔离验证失败；核对本地测试库和协作规则，不输出原始异常或配置");
  process.exitCode = 1;
} finally { await database?.close(); }
