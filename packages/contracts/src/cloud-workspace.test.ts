/** 云端协议边界：只接收动作与版本，账号来源、顺序和历史数量不能由额外字段绕过。 */
import { describe, expect, it } from "vitest";
import {
  CloudGraphRecordSchema, CloudGraphWriteRequestSchema, CloudGraphWriteResponseSchema,
  CloudWorkspaceResponseSchema, EditableGraphSchema, StoredGraphHistorySchema,
} from "./index.js";
import { createGraphHistory, storeGraphHistory } from "./graph-history.js";

const document = EditableGraphSchema.parse({
  version: "workspace.v1", id: "fixture-graph", title: "测试图", query: "", language: "zh-CN",
  presentationMode: "graph", createdAt: "2026-11-11T00:00:00.000Z", updatedAt: "2026-11-11T00:00:00.000Z",
  lastRunId: null, nodes: [], edges: [], positions: {},
});
const history = storeGraphHistory(createGraphHistory(document));
const record = { document, history, revision: 1, status: "active" as const, originalIndex: null };

describe("云工作区公共协议", () => {
  it("新建版本0只用于save，前端身份字段不能进入写入动作", () => {
    const request = { action: "save", document, history, expectedRevision: 0, mutationId: "fixture-save" };
    expect(CloudGraphWriteRequestSchema.safeParse(request).success).toBe(true);
    expect(CloudGraphWriteRequestSchema.safeParse({ ...request, userId: "another-user" }).success).toBe(false);
    expect(CloudGraphWriteRequestSchema.safeParse({ ...request, expectedRevision: -1 }).success).toBe(false);
    expect(CloudGraphWriteRequestSchema.safeParse({ action: "delete", graphId: document.id,
      expectedRevision: 0, mutationId: "fixture-delete" }).success).toBe(false);
  });

  it("保留历史形状及100步边界，拒绝额外秘密字段和101条事件", () => {
    expect(StoredGraphHistorySchema.safeParse(history).success).toBe(true);
    const event = { id: "event", occurredAt: document.updatedAt, active: true, kind: "graph.rename",
      subject: "测试", before: document, after: document };
    expect(StoredGraphHistorySchema.safeParse({ ...history, events: Array.from({ length: 100 }, (_, i) => ({ ...event, id: `event_${i}` })) }).success).toBe(true);
    expect(StoredGraphHistorySchema.safeParse({ ...history, events: Array.from({ length: 101 }, (_, i) => ({ ...event, id: `event_${i}` })) }).success).toBe(false);
    expect(CloudGraphRecordSchema.safeParse({ ...record, apiKey: "fixture-secret" }).success).toBe(false);
    expect(CloudGraphRecordSchema.safeParse({ ...record, status: "deleted" }).success).toBe(false);
  });

  it("工作区记录、活动顺序、删除栈一一对应且不重复", () => {
    const snapshot = { userId: "fixture-user", activeOrder: [document.id], deletedIds: [], graphs: [record] };
    expect(CloudWorkspaceResponseSchema.safeParse(snapshot).success).toBe(true);
    for (const invalid of [{ ...snapshot, activeOrder: [] }, { ...snapshot, deletedIds: [document.id] },
      { ...snapshot, graphs: [record, record] }]) {
      expect(CloudWorkspaceResponseSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("保存回执必须把目标放在对应状态的顺序中", () => {
    const response = { userId: "fixture-user", record, activeOrder: [document.id], deletedIds: [] };
    expect(CloudGraphWriteResponseSchema.safeParse(response).success).toBe(true);
    expect(CloudGraphWriteResponseSchema.safeParse({ ...response, activeOrder: [] }).success).toBe(false);
  });
});
