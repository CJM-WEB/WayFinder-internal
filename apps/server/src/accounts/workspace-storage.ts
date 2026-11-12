/**
 * 模块职责：在现有用户数据表中原子保存云端图、完整历史、删除栈和逐图版本。
 * 并发边界：新建／删除／恢复先锁用户顺序行，再锁图；普通保存只锁图并比较预期版本。
 * 清理只移除超限删除图的正文，轻量墓碑永久阻止旧设备或同 ID 新建复活该图。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CloudGraphRecordSchema, CloudGraphWriteRequestSchema, CloudGraphWriteResponseSchema,
  CloudWorkspaceResponseSchema, UserIdSchema,
  CloudWorkspaceImportRequestSchema,
  type CloudGraphRecord, type CloudGraphWriteRequest, type CloudGraphWriteResponse,
  type CloudWorkspaceErrorResponse, type CloudWorkspaceResponse,
  type CloudWorkspaceImportRequest,
} from "@wayfinder/contracts";
import { createGraphHistory, remapGraphHistoryIdentity, restoreGraphHistory, storeGraphHistory } from "@wayfinder/contracts/graph-history";

import { AccountDatabase, type DatabaseOperation } from "./database.js";

export class WorkspaceAccessError extends Error {
  constructor(readonly code: CloudWorkspaceErrorResponse["code"]) { super(code); this.name = "WorkspaceAccessError"; }
}
export type WorkspaceStorage = Readonly<{
  read: (userId: string, operation: DatabaseOperation) => Promise<CloudWorkspaceResponse>;
  write: (userId: string, input: CloudGraphWriteRequest, operation: DatabaseOperation) => Promise<CloudGraphWriteResponse>;
  importGuest: (userId: string, input: CloudWorkspaceImportRequest, operation: DatabaseOperation) => Promise<CloudWorkspaceResponse>;
}>;

const META_KEY = "workspace_meta";
const MetaSchema = z.strictObject({
  kind: z.literal("workspace"), activeOrder: z.array(z.string().min(1)), deletedIds: z.array(z.string().min(1)).max(100),
}).refine(value => new Set([...value.activeOrder, ...value.deletedIds]).size === value.activeOrder.length + value.deletedIds.length);
const GraphEnvelopeSchema = z.strictObject({
  // MySQL JSON 会重排对象键；完整记录按字符串封装，保留已有历史算法所需的位置键插入顺序。
  kind: z.literal("graph"), recordJson: z.string().min(1),
  lastMutationId: UserIdSchema, requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const PurgedEnvelopeSchema = z.strictObject({
  kind: z.literal("purged"), graphId: z.string().min(1), revision: z.number().int().positive(),
  lastMutationId: UserIdSchema, requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const EnvelopeSchema = z.discriminatedUnion("kind", [GraphEnvelopeSchema, PurgedEnvelopeSchema]);
/** 收据只保存去重依据及目标身份，不保留正文或历史，不能绕过最近删除100张的清理。 */
const ImportReceiptSchema = z.strictObject({
  kind: z.literal("guestImport"), requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  graphIds: z.array(z.string().min(1)),
});
type Metadata = z.infer<typeof MetaSchema>;
type Envelope = z.infer<typeof PurgedEnvelopeSchema> | (Omit<z.infer<typeof GraphEnvelopeSchema>, "recordJson"> & { record: CloudGraphRecord });
type Query = Parameters<Parameters<AccountDatabase["transaction"]>[1]>[0];
/** 供组图复制组合事务使用：业务拒绝不抛数据库异常，由调用方映射到所属协议。 */
export type CloudGraphCopyResult = Readonly<{ ok: true; record: CloudGraphRecord }>
  | Readonly<{ ok: false; reason: "missing" | "conflict" }>;
type Outcome = Readonly<{ ok: true; value: CloudGraphWriteResponse }> | Readonly<{ ok: false; code: CloudWorkspaceErrorResponse["code"] }>;
type ImportOutcome = Readonly<{ ok: true; value: CloudWorkspaceResponse }> | Readonly<{ ok: false; code: CloudWorkspaceErrorResponse["code"] }>;
const emptyMeta = (): Metadata => ({ kind: "workspace", activeOrder: [], deletedIds: [] });
const graphKey = (id: string): string => `g_${createHash("sha256").update(id).digest("hex")}`;

function payloadRows(value: unknown): unknown[] {
  return z.array(z.object({ payload: z.unknown() })).parse(value).map(row =>
    typeof row.payload === "string" ? JSON.parse(row.payload) as unknown : row.payload);
}
async function load(query: Query, userId: string, key: string, lock: boolean): Promise<unknown | null> {
  const rows = payloadRows(await query(`SELECT payload FROM wf_user_data WHERE userId = ? AND recordId = ?${lock ? " FOR UPDATE" : ""}`, [userId, key]));
  return rows[0] ?? null;
}
async function store(query: Query, userId: string, key: string, payload: unknown): Promise<void> {
  const serialized = JSON.stringify(payload);
  await query("INSERT INTO wf_user_data (userId, recordId, payload) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE payload = ?",
    [userId, key, serialized, serialized]);
}
async function lockMetadata(query: Query, userId: string): Promise<Metadata> {
  // 首次创建也只锁一个稳定用户键，避免两个设备各自生成不同的初始列表。
  await query("INSERT INTO wf_user_data (userId, recordId, payload) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE recordId = recordId",
    [userId, META_KEY, JSON.stringify(emptyMeta())]);
  return MetaSchema.parse(await load(query, userId, META_KEY, true));
}
/** 私有字符串封装只解决存储键序；读取后立即恢复公共记录并执行同一历史重放校验。 */
function decodeEnvelope(value: unknown): Envelope {
  const parsed = EnvelopeSchema.parse(value);
  if (parsed.kind === "purged") return parsed;
  const record = CloudGraphRecordSchema.parse(JSON.parse(parsed.recordJson) as unknown);
  restoreGraphHistory(record.history, record.document, 100);
  return { kind: "graph", record, lastMutationId: parsed.lastMutationId, requestFingerprint: parsed.requestFingerprint };
}
function checkedEnvelope(value: unknown | null, graphId: string): Envelope | null {
  if (value === null) return null;
  const parsed = decodeEnvelope(value);
  if ((parsed.kind === "graph" ? parsed.record.document.id : parsed.graphId) !== graphId) throw new WorkspaceAccessError("WORKSPACE_UNAVAILABLE");
  return parsed;
}
function success(userId: string, record: CloudGraphRecord, meta: Metadata): Outcome {
  return { ok: true, value: CloudGraphWriteResponseSchema.parse({ userId, record,
    activeOrder: meta.activeOrder, deletedIds: meta.deletedIds }) };
}
function envelope(record: CloudGraphRecord, mutationId: string, fingerprint: string): z.infer<typeof GraphEnvelopeSchema> {
  return { kind: "graph", recordJson: JSON.stringify(record), lastMutationId: mutationId, requestFingerprint: fingerprint };
}

/** 同一组合事务锁读个人源图；已删除或版本变化时拒绝，不把旧快照当作用户要复制的内容。 */
export async function readCloudGraphForCopy(query: Query, trustedUserId: string, graphId: string, expectedRevision: number): Promise<CloudGraphCopyResult> {
  const userId = UserIdSchema.parse(trustedUserId);
  const current = checkedEnvelope(await load(query, userId, graphKey(graphId), true), graphId);
  if (current === null || current.kind !== "graph" || current.record.status !== "active") return { ok: false, reason: "missing" };
  if (current.record.revision !== expectedRevision) return { ok: false, reason: "conflict" };
  return { ok: true, record: current.record };
}

/**
 * 只用于人员明确的“当前内容复制”：新身份和空历史，与旧冲突副本／访客导入保留历史的语义分开。
 * 调用方已经锁定小组并持有同一事务；此处再锁个人顺序，不能调用另开事务的公开write造成半份副本。
 */
export async function appendCloudGraphCopy(query: Query, trustedUserId: string, document: CloudGraphRecord["document"], mutationId: string): Promise<CloudGraphCopyResult> {
  const userId = UserIdSchema.parse(trustedUserId), meta = await lockMetadata(query, userId), key = graphKey(document.id);
  if (await load(query, userId, key, true) !== null || [...meta.activeOrder, ...meta.deletedIds].includes(document.id)) return { ok: false, reason: "conflict" };
  const record = CloudGraphRecordSchema.parse({ document, history: storeGraphHistory(createGraphHistory(document)),
    status: "active", originalIndex: null, revision: 1 });
  const fingerprint = createHash("sha256").update(JSON.stringify(["groupContentCopy", userId, mutationId, document.id])).digest("hex");
  await store(query, userId, key, envelope(record, mutationId, fingerprint));
  meta.activeOrder.push(document.id);
  await store(query, userId, META_KEY, MetaSchema.parse(meta));
  return { ok: true, record };
}

/** 普通读取沿用RR快照；导入及其重试使用当前锁读，返回同一事务中的完整结果。 */
async function readSnapshot(query: Query, userId: string, lock = false): Promise<CloudWorkspaceResponse> {
  const rawMeta = await load(query, userId, META_KEY, lock);
  const meta = rawMeta === null ? emptyMeta() : MetaSchema.parse(rawMeta);
  const rows = payloadRows(await query(`SELECT payload FROM wf_user_data WHERE userId = ? AND LEFT(recordId, 2) = 'g_' AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.kind')) = 'graph'${lock ? " FOR UPDATE" : ""}`, [userId]));
  const records = rows.map(row => {
    const parsed = decodeEnvelope(row);
    if (parsed.kind !== "graph") throw new WorkspaceAccessError("WORKSPACE_UNAVAILABLE");
    return parsed.record;
  });
  const ids = [...meta.activeOrder, ...meta.deletedIds];
  if (records.length !== ids.length || ids.some(id => !records.some(record => record.document.id === id))) throw new WorkspaceAccessError("WORKSPACE_UNAVAILABLE");
  for (const record of records) {
    if ((record.status === "active") !== meta.activeOrder.includes(record.document.id)) throw new WorkspaceAccessError("WORKSPACE_UNAVAILABLE");
  }
  return CloudWorkspaceResponseSchema.parse({ userId, activeOrder: meta.activeOrder, deletedIds: meta.deletedIds,
    graphs: ids.map(id => records.find(record => record.document.id === id)) });
}

/** 单张删除和批次导入共用清理：先去正文，永久保留拒绝旧身份写入的轻量墓碑。 */
async function trimDeleted(query: Query, userId: string, meta: Metadata): Promise<void> {
  while (meta.deletedIds.length > 100) {
    const purgedId = meta.deletedIds.shift();
    if (purgedId === undefined) throw new WorkspaceAccessError("WORKSPACE_UNAVAILABLE");
    const oldest = checkedEnvelope(await load(query, userId, graphKey(purgedId), true), purgedId);
    if (oldest?.kind !== "graph" || oldest.record.status !== "deleted") throw new WorkspaceAccessError("WORKSPACE_UNAVAILABLE");
    await store(query, userId, graphKey(purgedId), {
      kind: "purged", graphId: purgedId, revision: oldest.record.revision + 1,
      lastMutationId: oldest.lastMutationId, requestFingerprint: oldest.requestFingerprint,
    });
  }
}

export function createWorkspaceStorage(database: AccountDatabase): WorkspaceStorage {
  return {
    read: async (trustedUserId, operation) => {
      const userId = UserIdSchema.parse(trustedUserId);
      return database.transaction(operation, query => readSnapshot(query, userId), true);
    },
    write: async (trustedUserId, raw, operation) => {
      const userId = UserIdSchema.parse(trustedUserId);
      let input: CloudGraphWriteRequest;
      try {
        input = CloudGraphWriteRequestSchema.parse(raw);
        if (input.action === "save") restoreGraphHistory(input.history, input.document, 100);
      } catch { throw new WorkspaceAccessError("WORKSPACE_INVALID"); }
      const graphId = input.action === "save" ? input.document.id : input.graphId;
      const key = graphKey(graphId), fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const result = await database.transaction<Outcome>(operation, async query => {
        const modifiesOrder = input.action !== "save" || input.expectedRevision === 0;
        const lockedMeta = modifiesOrder ? await lockMetadata(query, userId) : null;
        const current = checkedEnvelope(await load(query, userId, key, true), graphId);
        if (!modifiesOrder && current === null) return { ok: false, code: "WORKSPACE_NOT_FOUND" };
        const meta = lockedMeta ?? MetaSchema.parse(await load(query, userId, META_KEY, false));
        if (current?.kind === "graph" && current.lastMutationId === input.mutationId) {
          return current.requestFingerprint === fingerprint ? success(userId, current.record, meta)
            : { ok: false, code: "WORKSPACE_CONFLICT" };
        }
        if (current?.kind === "purged") return { ok: false, code: "WORKSPACE_CONFLICT" };
        let next: CloudGraphRecord;
        if (input.action === "save") {
          if (input.expectedRevision === 0) {
            if (current !== null) return { ok: false, code: "WORKSPACE_CONFLICT" };
            if (meta.activeOrder.includes(graphId) || meta.deletedIds.includes(graphId)) return { ok: false, code: "WORKSPACE_CONFLICT" };
            meta.activeOrder.push(graphId);
          } else if (current === null) return { ok: false, code: "WORKSPACE_NOT_FOUND" };
          else if (current.record.status !== "active" || current.record.revision !== input.expectedRevision) return { ok: false, code: "WORKSPACE_CONFLICT" };
          next = CloudGraphRecordSchema.parse({ document: input.document, history: input.history,
            revision: input.expectedRevision + 1, status: "active", originalIndex: null });
        } else {
          if (current === null) return { ok: false, code: "WORKSPACE_NOT_FOUND" };
          if (current.record.revision !== input.expectedRevision) return { ok: false, code: "WORKSPACE_CONFLICT" };
          if (input.action === "delete") {
            const index = meta.activeOrder.indexOf(graphId);
            if (current.record.status !== "active" || index < 0) return { ok: false, code: "WORKSPACE_CONFLICT" };
            next = { ...current.record, revision: current.record.revision + 1, status: "deleted", originalIndex: index };
            meta.activeOrder.splice(index, 1); meta.deletedIds.push(graphId);
          } else {
            if (current.record.status !== "deleted" || current.record.originalIndex === null
              || meta.deletedIds.at(-1) !== graphId || meta.activeOrder.includes(graphId)) return { ok: false, code: "WORKSPACE_CONFLICT" };
            meta.activeOrder.splice(current.record.originalIndex, 0, graphId); meta.deletedIds.pop();
            next = { ...current.record, revision: current.record.revision + 1, status: "active", originalIndex: null };
          }
        }
        // 所有前置条件通过后才写入；预期业务冲突返回判别值，避免被数据库层改成未知503。
        await trimDeleted(query, userId, meta);
        await store(query, userId, key, envelope(CloudGraphRecordSchema.parse(next), input.mutationId, fingerprint));
        if (modifiesOrder) await store(query, userId, META_KEY, MetaSchema.parse(meta));
        return success(userId, next, meta);
      });
      if (!result.ok) throw new WorkspaceAccessError(result.code);
      return result.value;
    },
    importGuest: async (trustedUserId, raw, operation) => {
      const userId = UserIdSchema.parse(trustedUserId);
      let input: CloudWorkspaceImportRequest;
      let mapped: Array<{ document: CloudGraphRecord["document"]; history: CloudGraphRecord["history"]; originalIndex: number | null }>;
      try {
        input = CloudWorkspaceImportRequestSchema.parse(raw);
        const sources = [...input.documents.map(value => ({ ...value, originalIndex: null })), ...input.deletedGraphs];
        mapped = sources.map(source => {
          const id = `import_${createHash("sha256").update(JSON.stringify([userId, input.importId, source.document.id])).digest("hex")}`;
          return { ...remapGraphHistoryIdentity(source.document, source.history, id), originalIndex: source.originalIndex };
        });
      } catch { throw new WorkspaceAccessError("WORKSPACE_INVALID"); }
      const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const receiptKey = `i_${createHash("sha256").update(input.importId).digest("hex")}`;
      const result = await database.transaction<ImportOutcome>(operation, async query => {
        const meta = await lockMetadata(query, userId);
        const rawReceipt = await load(query, userId, receiptKey, true);
        if (rawReceipt !== null) {
          const receipt = ImportReceiptSchema.parse(rawReceipt);
          return receipt.requestFingerprint === fingerprint ? { ok: true, value: await readSnapshot(query, userId, true) }
            : { ok: false, code: "WORKSPACE_CONFLICT" };
        }
        // 稳定身份仍可能被其他合法操作占用或已成为墓碑；任何一处碰撞均拒绝整批，不能覆盖。
        for (const source of mapped) {
          if (await load(query, userId, graphKey(source.document.id), true) !== null) return { ok: false, code: "WORKSPACE_CONFLICT" };
        }
        const offset = meta.activeOrder.length;
        for (const source of mapped) {
          const record = CloudGraphRecordSchema.parse({ document: source.document, history: source.history,
            revision: 1, status: source.originalIndex === null ? "active" : "deleted",
            originalIndex: source.originalIndex === null ? null : offset + source.originalIndex });
          await store(query, userId, graphKey(record.document.id), envelope(record, input.importId, fingerprint));
          if (record.status === "active") meta.activeOrder.push(record.document.id);
          else meta.deletedIds.push(record.document.id);
        }
        await trimDeleted(query, userId, meta);
        await store(query, userId, META_KEY, MetaSchema.parse(meta));
        await store(query, userId, receiptKey, ImportReceiptSchema.parse({ kind: "guestImport", requestFingerprint: fingerprint,
          graphIds: mapped.map(source => source.document.id) }));
        return { ok: true, value: await readSnapshot(query, userId, true) };
      });
      if (!result.ok) throw new WorkspaceAccessError(result.code);
      return result.value;
    },
  };
}
