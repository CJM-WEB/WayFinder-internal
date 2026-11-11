/** 共享历史协议/重放回归：云结构严格，但旧本地恢复接受规则与真实算法保持不变。 */
import { describe, expect, it } from "vitest";
import { EditableGraphSchema, StoredGraphHistoryBaseSchema, StoredGraphHistorySchema, type EditableGraph } from "./index.js";
import { appendHistory, createGraphHistory, redoHistoryEvent, restoreGraphHistory, storeGraphHistory, undoHistoryEvent } from "./graph-history.js";

const graph = (): EditableGraph => EditableGraphSchema.parse({
  version: "workspace.v1", id: "fixture-graph", title: "原图", query: "", language: "zh-CN",
  presentationMode: "graph", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  lastRunId: null, nodes: [], edges: [], positions: {},
});

describe("共享历史持久化协议", () => {
  it("保留100步、选择性撤销及redo分支，经过Schema和JSON恢复仍可重做", () => {
    let current = graph(), history = createGraphHistory(current);
    for (let index = 0; index < 101; index++) {
      const after = { ...current, title: `图${index}` };
      history = appendHistory(history, current, after, { kind: "graph.rename", subject: after.title,
        id: `event-${index}`, active: true, occurredAt: "2026-01-01T00:00:00Z" }, 100);
      current = after;
    }
    const undone = undoHistoryEvent(history, "event-100");
    if (!undone.ok) throw new Error("测试撤销失败");
    const stored = StoredGraphHistorySchema.parse(JSON.parse(JSON.stringify(storeGraphHistory(undone.history))) as unknown);
    expect(stored.events).toHaveLength(100); expect(stored.redoIds).toEqual(["event-100"]);
    expect(Object.isFrozen(stored)).toBe(false); expect(Object.isFrozen(stored.base)).toBe(false);
    const restored = restoreGraphHistory(stored, undone.graph, 100);
    const redone = redoHistoryEvent(restored);
    expect(redone?.ok).toBe(true);
    if (redone?.ok) expect(redone.graph).toEqual(current);
    expect(StoredGraphHistorySchema.safeParse({ ...stored, events: [...stored.events, stored.events[0]] }).success).toBe(false);
  });

  it("中间基线只验证字段形状，最终图约束必须在重放时验证", () => {
    const current = graph(), stored = storeGraphHistory(createGraphHistory(current));
    const intermediate = { ...stored.base.graph, edges: [{ id: "dangling", source: "not-yet-present", target: "later", type: "related_to" }] };
    expect(EditableGraphSchema.safeParse(intermediate).success).toBe(false);
    expect(StoredGraphHistoryBaseSchema.safeParse({ ...stored.base, graph: intermediate }).success).toBe(true);
    expect(() => restoreGraphHistory({ ...stored, base: { ...stored.base, graph: intermediate } }, current, 100)).toThrow();
  });

  it("旧本地恢复仍忽略历史额外字段，云端严格结构拒绝；损坏映射与redo仍拒绝", () => {
    const current = graph(), stored = storeGraphHistory(createGraphHistory(current));
    const legacy = { ...stored, ignoredLegacyField: true };
    expect(() => restoreGraphHistory(legacy, current, 100)).not.toThrow();
    expect(StoredGraphHistorySchema.safeParse(legacy).success).toBe(false);
    expect(() => restoreGraphHistory({ ...stored, redoIds: ["missing-event"] }, current, 100)).toThrow();
    expect(() => restoreGraphHistory({ ...stored, base: { ...stored.base, manualNodes: ["same", "same"] } }, current, 100)).toThrow();
  });
});
