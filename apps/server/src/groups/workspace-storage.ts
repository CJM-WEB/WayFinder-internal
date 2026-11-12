/**
 * 模块职责：按小组成员资格保存多图、按组删除恢复，并在同一事务内完成个人↔组内容复制。
 * 锁顺序：操作者稳定行→组→目标记录／个人源或顺序；图和历史以字符串封装保留坐标键顺序。
 * 用户分区的幂等收据不随解散删除，确认丢失后仍可查询个人副本身份，但不能借此读取已失权组内容。
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  EditableGraphSchema, GroupGraphActionSchema, GroupGraphReceiptResponseSchema,
  GroupGraphRecordSchema, GroupGraphWriteResponseSchema, GroupWorkspaceResponseSchema, UserIdSchema,
  type EditableGraph, type GroupGraphAction, type GroupGraphReceiptResponse, type GroupGraphRecord,
  type GroupGraphWriteResponse, type GroupSummary, type GroupWorkspaceResponse,
} from "@wayfinder/contracts";
import { sameGraphContent } from "@wayfinder/contracts/graph-history";
import type { AccountDatabase, DatabaseOperation } from "../accounts/database.js";
import { appendCloudGraphCopy, readCloudGraphForCopy } from "../accounts/workspace-storage.js";
import { GroupAccessError } from "./errors.js";
import { appendGroupHistory, createGroupHistory, redoGroupHistory, restoreGroupHistory, undoGroupHistory } from "./history.js";
import { assertGroupResourceUrls, mergeGroupEdit, normalizeGroupCreate } from "./merge.js";
import { bumpGroupRevision, groupTransaction, loadMemberGroup, lockGroupActor, type GroupQuery } from "./storage.js";

export type GroupWorkspaceStorage = Readonly<{
  read: (userId: string, groupId: string, operation: DatabaseOperation) => Promise<GroupWorkspaceResponse>;
  write: (userId: string, input: GroupGraphAction, operation: DatabaseOperation) => Promise<GroupGraphWriteResponse>;
  receipt: (userId: string, mutationId: string, operation: DatabaseOperation) => Promise<GroupGraphReceiptResponse>;
}>;
const MetaSchema = z.strictObject({ kind: z.literal("workspace"), activeOrder: z.array(z.string().min(1)), deletedIds: z.array(z.string().min(1)).max(100) });
type Meta = z.infer<typeof MetaSchema>;
const EnvelopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("graph"), recordJson: z.string().min(1) }),
  z.strictObject({ kind: z.literal("purged"), graphId: z.string().min(1), revision: z.number().int().positive() }),
]);
const ReceiptSchema = z.strictObject({ kind: z.literal("groupGraphMutation"), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  groupId: UserIdSchema, graphId: z.string().min(1), personalGraphId: z.string().min(1).nullable() });
const META_KEY = "workspace_meta";
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const graphKey = (id: string): string => `g_${digest(id)}`;
const receiptKey = (mutationId: string): string => `gw_${digest(mutationId)}`;
const emptyMeta = (): Meta => ({ kind: "workspace", activeOrder: [], deletedIds: [] });
const jsonValue = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) as unknown : value;

async function load(query: GroupQuery, groupId: string, key: string): Promise<unknown | null> {
  const rows = z.array(z.object({ payload: z.unknown() })).parse(await query("SELECT payload FROM wf_group_data WHERE groupId = ? AND recordId = ?", [groupId, key]));
  return rows.length === 0 ? null : jsonValue(rows[0]?.payload);
}
async function store(query: GroupQuery, groupId: string, key: string, payload: unknown): Promise<void> {
  const serialized = JSON.stringify(payload);
  await query("INSERT INTO wf_group_data (groupId, recordId, payload) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE payload = ?",
    [groupId, key, serialized, serialized]);
}
async function loadMeta(query: GroupQuery, groupId: string): Promise<Meta> {
  const value = await load(query, groupId, META_KEY);
  const meta = value === null ? emptyMeta() : MetaSchema.parse(value);
  const ids = [...meta.activeOrder, ...meta.deletedIds];
  if (new Set(ids).size !== ids.length) throw new Error("小组图顺序身份重复");
  return meta;
}
function decode(value: unknown, graphId: string) {
  const envelope = EnvelopeSchema.parse(value);
  if (envelope.kind === "purged") {
    if (envelope.graphId !== graphId) throw new Error("小组图墓碑身份不一致");
    return { kind: "purged" as const, graphId, revision: envelope.revision };
  }
  const record = GroupGraphRecordSchema.parse(JSON.parse(envelope.recordJson) as unknown);
  if (record.document.id !== graphId) throw new Error("小组图存档身份不一致");
  restoreGroupHistory(record.history, record.document);
  return { kind: "graph" as const, record };
}
async function loadRecord(query: GroupQuery, groupId: string, graphId: string) {
  const value = await load(query, groupId, graphKey(graphId));
  return value === null ? null : decode(value, graphId);
}
async function storeRecord(query: GroupQuery, groupId: string, record: GroupGraphRecord): Promise<void> {
  await store(query, groupId, graphKey(record.document.id), { kind: "graph", recordJson: JSON.stringify(record) });
}

/** 调用方已经核验同一事务内的成员资格；记录、顺序及组版本必须来自同一锁定状态或一致快照。 */
export async function readGroupWorkspaceSnapshot(query: GroupQuery, group: GroupSummary): Promise<GroupWorkspaceResponse> {
  const meta = await loadMeta(query, group.groupId);
  const values = z.array(z.object({ payload: z.unknown() })).parse(await query(
    "SELECT payload FROM wf_group_data WHERE groupId = ? AND LEFT(recordId, 2) = 'g_' AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.kind')) = 'graph'", [group.groupId]));
  const records = values.map(value => {
    const envelope = EnvelopeSchema.parse(jsonValue(value.payload));
    if (envelope.kind !== "graph") throw new Error("小组图记录类型不一致");
    const record = GroupGraphRecordSchema.parse(JSON.parse(envelope.recordJson) as unknown);
    restoreGroupHistory(record.history, record.document);
    return record;
  });
  const ids = [...meta.activeOrder, ...meta.deletedIds];
  if (records.length !== ids.length || ids.some(id => !records.some(record => record.document.id === id))) throw new Error("小组图列表与存档不一致");
  return GroupWorkspaceResponseSchema.parse({ groupId: group.groupId, revision: group.revision,
    activeOrder: meta.activeOrder, deletedIds: meta.deletedIds, graphs: ids.map(id => records.find(record => record.document.id === id)) });
}

async function readReceipt(query: GroupQuery, userId: string, mutationId: string, lock: boolean) {
  const rows = z.array(z.object({ payload: z.unknown() })).parse(await query(
    `SELECT payload FROM wf_user_data WHERE userId = ? AND recordId = ?${lock ? " FOR UPDATE" : ""}`, [userId, receiptKey(mutationId)]));
  return rows.length === 0 ? null : ReceiptSchema.parse(jsonValue(rows[0]?.payload));
}
async function trimDeleted(query: GroupQuery, groupId: string, meta: Meta): Promise<void> {
  while (meta.deletedIds.length > 100) {
    const graphId = meta.deletedIds.shift();
    if (graphId === undefined) throw new Error("小组删除栈缺少身份");
    const old = await loadRecord(query, groupId, graphId);
    if (old?.kind !== "graph" || old.record.status !== "deleted") throw new Error("小组删除栈与记录不一致");
    await store(query, groupId, graphKey(graphId), { kind: "purged", graphId, revision: old.record.revision + 1 });
  }
}

export function createGroupWorkspaceStorage(database: AccountDatabase, options: Readonly<{
  createId?: () => string; now?: () => string;
}> = {}): GroupWorkspaceStorage {
  const now = options.now ?? (() => new Date().toISOString());
  const newDocument = (source: EditableGraph): EditableGraph => {
    const at = now();
    return EditableGraphSchema.parse({ ...source, id: options.createId?.() ?? randomUUID(), createdAt: at, updatedAt: at });
  };
  return {
    read: (trustedUserId, inputGroupId, operation) => groupTransaction(database, operation, async query => {
      const userId = UserIdSchema.parse(trustedUserId), groupId = UserIdSchema.parse(inputGroupId);
      return readGroupWorkspaceSnapshot(query, await loadMemberGroup(query, userId, groupId, false));
    }, true),
    receipt: (trustedUserId, inputMutationId, operation) => groupTransaction(database, operation, async query => {
      const userId = UserIdSchema.parse(trustedUserId), mutationId = UserIdSchema.parse(inputMutationId);
      const value = await readReceipt(query, userId, mutationId, false);
      return GroupGraphReceiptResponseSchema.parse({ mutationId, applied: value !== null,
        groupId: value?.groupId ?? null, graphId: value?.graphId ?? null, personalGraphId: value?.personalGraphId ?? null });
    }, true),
    write: async (trustedUserId, raw, operation) => {
      let input: GroupGraphAction, userId: string;
      try { input = GroupGraphActionSchema.parse(raw); userId = UserIdSchema.parse(trustedUserId); }
      catch { throw new GroupAccessError("GROUP_INVALID"); }
      const fingerprint = digest(JSON.stringify([userId, input]));
      return groupTransaction(database, operation, async query => {
        await lockGroupActor(query, userId);
        const previous = await readReceipt(query, userId, input.mutationId, true);
        if (previous !== null && previous.fingerprint !== fingerprint) throw new GroupAccessError("GROUP_CONFLICT");
        let group = await loadMemberGroup(query, userId, input.groupId);
        if (previous !== null) return GroupGraphWriteResponseSchema.parse({ workspace: await readGroupWorkspaceSnapshot(query, group) });
        const meta = await loadMeta(query, group.groupId);
        let graphId: string, personalGraphId: string | null = null;
        let personalGraph: GroupGraphWriteResponse["personalGraph"];
        let changed = false;
        if (input.action === "create" || input.action === "copyIn") {
          let source: EditableGraph;
          if (input.action === "copyIn") {
            const found = await readCloudGraphForCopy(query, userId, input.sourceGraphId, input.sourceRevision);
            if (!found.ok) throw new GroupAccessError(found.reason === "missing" ? "GROUP_NOT_FOUND" : "GROUP_CONFLICT");
            source = found.record.document;
            // 内容复制保留源的人工／搜索来源，但不能沿用被伪造的canonical或domain绕过实际URL去重。
            assertGroupResourceUrls(source);
          } else source = normalizeGroupCreate(input.document);
          const document = newDocument(source); graphId = document.id;
          if (await loadRecord(query, group.groupId, graphId) !== null || [...meta.activeOrder, ...meta.deletedIds].includes(graphId)) throw new GroupAccessError("GROUP_CONFLICT");
          const record = GroupGraphRecordSchema.parse({ document, history: createGroupHistory(document), revision: 1, status: "active", originalIndex: null });
          await storeRecord(query, group.groupId, record); meta.activeOrder.push(graphId); changed = true;
        } else {
          graphId = input.graphId;
          const found = await loadRecord(query, group.groupId, graphId);
          if (found === null) throw new GroupAccessError("GROUP_NOT_FOUND");
          if (found.kind === "purged") throw new GroupAccessError("GROUP_CONFLICT");
          const current = found.record;
          const latestOperation = input.action === "edit" || input.action === "undo" || input.action === "redo";
          if (input.expectedRevision > current.revision || (!latestOperation && input.expectedRevision !== current.revision)) throw new GroupAccessError("GROUP_CONFLICT");
          if (input.action === "copyOut") {
            if (current.status !== "active") throw new GroupAccessError("GROUP_CONFLICT");
            assertGroupResourceUrls(current.document);
            const copied = await appendCloudGraphCopy(query, userId, newDocument(current.document), input.mutationId);
            if (!copied.ok) throw new GroupAccessError("GROUP_CONFLICT");
            personalGraph = copied.record; personalGraphId = copied.record.document.id;
          } else if (input.action === "edit") {
            if (current.status !== "active") throw new GroupAccessError("GROUP_CONFLICT");
            const sameVersion = input.expectedRevision === current.revision, matchesBefore = sameGraphContent(input.before, current.document);
            // 搜索结果带整体／节点写入意图，必须保留原严格预览门禁；普通旧版本编辑只合并本次差异。
            if ((sameVersion && !matchesBefore) || (input.scope !== undefined && (!sameVersion || !matchesBefore))) throw new GroupAccessError("GROUP_CONFLICT");
            // 搜索作用域同样不得通过客户端填写的canonical/domain绕过实际URL硬边界。
            if (input.scope !== undefined) assertGroupResourceUrls(input.after);
            const merged = input.scope === undefined ? mergeGroupEdit(current.document, input.before, input.after) : input.after;
            const document = EditableGraphSchema.parse({ ...merged, createdAt: current.document.createdAt, updatedAt: now() });
            if (!sameGraphContent(current.document, document)) {
              const history = appendGroupHistory(current.history, current.document, document, { id: randomUUID(), occurredAt: document.updatedAt,
                actorUserId: userId, kind: input.kind, subject: input.subject, ...(input.scope === undefined ? {} : { scope: input.scope }) });
              await storeRecord(query, group.groupId, { ...current, document, history, revision: current.revision + 1 }); changed = true;
            }
          } else if (input.action === "undo" || input.action === "redo") {
            if (current.status !== "active") throw new GroupAccessError("GROUP_CONFLICT");
            const result = input.action === "undo" ? undoGroupHistory(current.history, current.document, userId, input.eventId)
              : redoGroupHistory(current.history, current.document, userId);
            const document = EditableGraphSchema.parse({ ...result.document, updatedAt: now() });
            // 即使后写标题使画面同值，事件活动状态和本人重做已变化，仍须原子保存并提升共享版本。
            await storeRecord(query, group.groupId, { ...current, document, history: result.history, revision: current.revision + 1 }); changed = true;
          } else if (input.action === "delete") {
            const index = meta.activeOrder.indexOf(graphId);
            if (current.status !== "active" || index < 0) throw new GroupAccessError("GROUP_CONFLICT");
            await storeRecord(query, group.groupId, { ...current, revision: current.revision + 1, status: "deleted", originalIndex: index });
            meta.activeOrder.splice(index, 1); meta.deletedIds.push(graphId); await trimDeleted(query, group.groupId, meta); changed = true;
          } else {
            if (current.status !== "deleted" || current.originalIndex === null || meta.deletedIds.at(-1) !== graphId || meta.activeOrder.includes(graphId)) throw new GroupAccessError("GROUP_CONFLICT");
            meta.activeOrder.splice(current.originalIndex, 0, graphId); meta.deletedIds.pop();
            await storeRecord(query, group.groupId, { ...current, revision: current.revision + 1, status: "active", originalIndex: null }); changed = true;
          }
        }
        if (changed) {
          await store(query, group.groupId, META_KEY, MetaSchema.parse(meta));
          group = await bumpGroupRevision(query, group);
        }
        await query("INSERT INTO wf_user_data (userId, recordId, payload) VALUES (?, ?, ?)", [userId, receiptKey(input.mutationId),
          JSON.stringify(ReceiptSchema.parse({ kind: "groupGraphMutation", fingerprint, groupId: group.groupId, graphId, personalGraphId }))]);
        return GroupGraphWriteResponseSchema.parse({ workspace: await readGroupWorkspaceSnapshot(query, group), ...(personalGraph === undefined ? {} : { personalGraph }) });
      });
    },
  };
}
