/** 共享历史协议/重放回归：云结构严格，但旧本地恢复接受规则与真实算法保持不变。 */
import { describe, expect, it } from "vitest";
import {
  EditableGraphSchema, StoredGraphHistoryBaseSchema, StoredGraphHistorySchema,
  type EditableGraph, type EditableNode, type EditableNote, type EditableResource,
} from "./index.js";
import { appendHistory, createGraphHistory, redoHistoryEvent, remapGraphHistoryIdentity, restoreGraphHistory, storeGraphHistory, undoHistoryEvent } from "./graph-history.js";
import type { WorkspaceHistoryEvent } from "./graph-history.js";

const graph = (): EditableGraph => EditableGraphSchema.parse({
  version: "workspace.v1", id: "fixture-graph", title: "原图", query: "", language: "zh-CN",
  presentationMode: "graph", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  lastRunId: null, nodes: [], edges: [], positions: {},
});

const emptyNode: EditableNode = {
  id: "same-node", title: "学习节点", description: "", nodeType: "primary", layer: 0,
  status: "empty", resources: [], warnings: [],
};
const note = (id: string, markdown: string): EditableNote => ({ id, title: id, description: "", markdown });
const event = (id: string, kind: WorkspaceHistoryEvent["kind"], scope?: WorkspaceHistoryEvent["scope"]): WorkspaceHistoryEvent => ({
  id, kind, subject: id, active: true, occurredAt: "2026-01-01T00:00:00Z", ...(scope === undefined ? {} : { scope }),
});

describe("共享历史持久化协议", () => {
  it("保留100步、选择性撤销及redo分支，经过Schema和JSON恢复仍可重做", () => {
    let current = EditableGraphSchema.parse({ ...graph(), lastRunId: "original-run",
      nodes: ["A", "B"].map(id => ({ id, title: id, description: "", nodeType: "primary", layer: 0, status: "empty", resources: [], warnings: [] })),
      positions: { B: { x: 1, y: 2 }, A: { x: 3, y: 4 } },
    });
    let history = createGraphHistory(current);
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
    const before = JSON.stringify(stored);
    const copy = remapGraphHistoryIdentity(undone.graph, stored, "copy-graph");
    expect(JSON.stringify(stored)).toBe(before);
    expect(copy.history.events).toHaveLength(100); expect(copy.history.redoIds).toEqual(stored.redoIds);
    expect(copy.document.lastRunId).toBe("original-run");
    expect(Object.keys(copy.document.positions)).toEqual(["B", "A"]);
    expect(copy.document.nodes.map(node => node.id)).toEqual(["A", "B"]);
    expect(copy.history.events.map(event => event.id)).toEqual(stored.events.map(event => event.id));
    const copiedRedo = redoHistoryEvent(restoreGraphHistory(copy.history, copy.document, 100));
    if (!copiedRedo?.ok) throw new Error("副本无法重做");
    expect(copiedRedo.graph).toEqual({ ...current, id: "copy-graph" });
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

describe("笔记按身份选择性撤销", () => {
  it("撤销一条笔记删除时保留其他笔记和资源，并恢复原笔记顺序", () => {
    const first = note("第一条", "读后记录"), second = note("第二条", "旧内容");
    const initial = { ...graph(), nodes: [{ ...emptyNode, notes: [first, second] }] };
    const removed = { ...initial, nodes: [{ ...emptyNode, notes: [second] }] };
    const revised = { ...second, markdown: "后来修改的内容" };
    const edited = { ...initial, nodes: [{ ...emptyNode, notes: [revised] }] };
    const resource: EditableResource = {
      id: "resource", origin: "manual", title: "参考资料", url: "https://example.com/reference",
      canonicalUrl: "https://example.com/reference", domain: "example.com", sourceType: "user_added",
      summary: "", whySelected: "", rank: 1,
    };
    const current = { ...edited, nodes: [{ ...emptyNode, status: "edited" as const, notes: [revised], resources: [resource] }] };
    let history = appendHistory(createGraphHistory(initial), initial, removed, event("remove", "note.delete"), 100);
    history = appendHistory(history, removed, edited, event("edit", "note.edit"), 100);
    history = appendHistory(history, edited, current, event("source", "resource.add"), 100);
    const undone = undoHistoryEvent(history, "remove");
    if (!undone.ok) throw new Error("无法恢复第一条笔记");
    expect(undone.graph.nodes[0]?.notes).toEqual([first, revised]);
    expect(undone.graph.nodes[0]?.resources).toEqual([resource]);
    expect(undone.graph.nodes[0]?.status).toBe("edited");

    // 以实际存档格式往返，重做只影响指定笔记。
    const stored = StoredGraphHistorySchema.parse(JSON.parse(JSON.stringify(storeGraphHistory(undone.history))) as unknown);
    const redone = redoHistoryEvent(restoreGraphHistory(stored, undone.graph, 100));
    expect(redone?.ok).toBe(true);
    if (redone?.ok) expect(redone.graph).toEqual(current);
  });

  it("后续编辑依赖新建笔记，删除后依赖可消解且截断基线可恢复", () => {
    const initial = { ...graph(), nodes: [emptyNode] };
    const first = note("学习记录", "初稿");
    const added = { ...initial, nodes: [{ ...emptyNode, notes: [first] }] };
    const edited = { ...initial, nodes: [{ ...emptyNode, notes: [{ ...first, markdown: "后来更新" }] }] };
    let history = appendHistory(createGraphHistory(initial), initial, added, event("add", "note.add"), 100);
    history = appendHistory(history, added, edited, event("edit", "note.edit"), 100);
    expect(undoHistoryEvent(history, "add")).toEqual({ ok: false, reason: "dependency" });
    history = appendHistory(history, edited, initial, event("remove", "note.delete"), 100);
    const undone = undoHistoryEvent(history, "add");
    if (!undone.ok) throw new Error("已删除笔记不应继续阻断撤销");
    expect(undone.graph).toEqual(initial);

    // 保留删除事件，但把被撤销的新建与后续编辑折入基线，留下待消解的占位笔记。
    const renamed = { ...initial, title: "后来改名" };
    const compacted = appendHistory(undone.history, undone.graph, renamed, event("rename", "graph.rename"), 2);
    const stored = StoredGraphHistorySchema.parse(JSON.parse(JSON.stringify(storeGraphHistory(compacted))) as unknown);
    expect(stored.base.notes).toEqual([[emptyNode.id, [[first.id, { initial: first }]]]]);
    const restored = restoreGraphHistory(stored, renamed, 100);
    expect(undoHistoryEvent(restored, "remove")).toEqual({ ok: false, reason: "dependency" });
    expect(undoHistoryEvent(restored, "rename")).toMatchObject({ ok: true, graph: initial });
  });

  it("全图替换重用节点标识时，撤销不把新代际笔记附到旧节点", () => {
    const oldNote = note("旧记录", "旧节点专属正文");
    const initial = { ...graph(), nodes: [{ ...emptyNode, notes: [oldNote] }] };
    const replacementNode = { ...emptyNode, noteGeneration: "replacement-run" };
    const replaced = { ...initial, lastRunId: "replacement-run", nodes: [replacementNode] };
    const replacement = appendHistory(createGraphHistory(initial), initial, replaced, event("replace", "graph.search", { type: "graph.replace" }), 100);
    expect(undoHistoryEvent(replacement, "replace")).toMatchObject({ ok: true, graph: initial });

    const current = { ...replaced, nodes: [{ ...replacementNode, notes: [note("新记录", "新节点专属正文")] }] };
    const history = appendHistory(replacement, replaced, current, event("new-note", "note.add"), 100);
    expect(undoHistoryEvent(history, "replace")).toEqual({ ok: false, reason: "dependency" });
    const undoneNewNote = undoHistoryEvent(history, "new-note");
    if (!undoneNewNote.ok) throw new Error("无法撤销新节点笔记");
    expect(undoHistoryEvent(undoneNewNote.history, "replace")).toMatchObject({ ok: true, graph: initial });
  });
});
