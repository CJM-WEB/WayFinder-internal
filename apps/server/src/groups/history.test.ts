/**
 * 小组历史回归：本人窗口与共同因果记录分开，布局和其他成员重做不能因新编辑被抹掉。
 * 完整局部重放继续调用原共享算法；这里验证组包装层不会误用全组100条限制。
 */
import { describe, expect, it } from "vitest";
import { EditableGraphSchema, GroupGraphHistorySchema, type EditableGraph } from "@wayfinder/contracts";
import { sameGraphContent } from "@wayfinder/contracts/graph-history";
import { appendGroupHistory, createGroupHistory, restoreGroupHistory } from "./history.js";

const document = EditableGraphSchema.parse({
  version: "workspace.v1", id: "fixture_graph", title: "资料", query: "", language: "zh-CN", presentationMode: "graph",
  createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z", lastRunId: null,
  nodes: [], edges: [], positions: {},
});
const metadata = (id: string, actorUserId: string) => ({ id, actorUserId, occurredAt: document.updatedAt, kind: "graph.rename" as const, subject: "标题" });
const rename = (graph: EditableGraph, title: string): EditableGraph => ({ ...graph, title });

describe("小组历史作者窗口", () => {
  it("本人第101步只把自己的不可撤销连续前缀折入基线", () => {
    let current = document, history = createGroupHistory(current);
    for (let i = 1; i <= 101; i++) {
      const next = rename(current, `标题${i}`);
      history = appendGroupHistory(history, current, next, metadata(`event_${i}`, "owner"));
      current = next;
    }
    expect(history.events).toHaveLength(100);
    expect(history.base.graph.title).toBe("标题1");
    expect(history.events[0]?.id).toBe("event_2");
    expect(history.events.every(event => event.actorUserId === "owner" && event.undoable)).toBe(true);
    expect(sameGraphContent(restoreGroupHistory(history, current).events.at(-1)?.after ?? document, current)).toBe(true);
  });

  it("另一成员仍保留的早期事件阻止跳跃压缩，不因全组超过100条而丢失", () => {
    let current = rename(document, "甲的修改"), history = appendGroupHistory(createGroupHistory(document), document,
      current, metadata("owner_first", "owner"));
    for (let i = 1; i <= 110; i++) {
      const next = rename(current, `乙的修改${i}`);
      history = appendGroupHistory(history, current, next, metadata(`member_${i}`, "member")); current = next;
    }
    expect(history.events).toHaveLength(111);
    expect(history.events[0]).toMatchObject({ id: "owner_first", actorUserId: "owner", undoable: true });
    expect(history.events.filter(event => event.actorUserId === "member" && event.undoable)).toHaveLength(100);
    expect(history.events.filter(event => event.actorUserId === "member" && !event.undoable)).toHaveLength(10);
    expect(() => restoreGroupHistory(history, current)).not.toThrow();
  });

  it("本人新编辑只结束本人重做分支，其他成员的已撤销事件与队列继续存在", () => {
    const initial = createGroupHistory(document);
    const history = GroupGraphHistorySchema.parse({ ...initial,
      events: [
        { ...metadata("owner_undone", "owner"), active: false, undoable: true, before: document, after: rename(document, "甲") },
        { ...metadata("member_undone", "member"), active: false, undoable: true, before: document, after: rename(document, "乙") },
      ], redoIdsByUser: { owner: ["owner_undone"], member: ["member_undone"] },
    });
    const next = rename(document, "甲的新编辑");
    const result = appendGroupHistory(history, document, next, metadata("owner_new", "owner"));
    expect(result.redoIdsByUser).toEqual({ owner: [], member: ["member_undone"] });
    expect(result.events.some(event => event.id === "owner_undone")).toBe(false);
    expect(result.events.find(event => event.id === "member_undone")).toMatchObject({ active: false, undoable: true });
    expect(() => restoreGroupHistory(result, next)).not.toThrow();
  });

  it("节点布局更新不产生本人事件，也不清除其他成员重做", () => {
    const graph = EditableGraphSchema.parse({ ...document, nodes: [{ id: "node", title: "节点", description: "",
      nodeType: "primary", layer: 0, status: "empty", resources: [], warnings: [] }], positions: { node: { x: 0, y: 0 } } });
    const moved = { ...graph, positions: { node: { x: 20, y: 30 } } };
    const result = appendGroupHistory(createGroupHistory(graph), graph, moved, metadata("not_an_event", "owner"));
    expect(result.events).toEqual([]);
    expect(result.redoIdsByUser).toEqual({});
    expect(result.base.graph.positions.node).toEqual({ x: 20, y: 30 });
    expect(() => restoreGroupHistory(result, moved)).not.toThrow();
  });
});
