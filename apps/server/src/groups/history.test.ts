/**
 * 小组历史回归：本人窗口与共同因果记录分开，布局和其他成员重做不能因新编辑被抹掉。
 * 完整局部重放继续调用原共享算法；这里验证组包装层不会误用全组100条限制。
 */
import { describe, expect, it } from "vitest";
import { EditableGraphSchema, GroupGraphHistorySchema, type EditableGraph } from "@wayfinder/contracts";
import { sameGraphContent } from "@wayfinder/contracts/graph-history";
import { appendGroupHistory, createGroupHistory, redoGroupHistory, restoreGroupHistory, undoGroupHistory } from "./history.js";

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
    expect(() => undoGroupHistory(history, current, "owner", "event_1")).toThrow("GROUP_CONFLICT");
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
    expect(() => undoGroupHistory(history, current, "member", "member_1")).toThrow("GROUP_CONFLICT");
    const undone = undoGroupHistory(history, current, "owner", "owner_first");
    expect(undone.document.title).toBe("乙的修改110");
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

  it("可信搜索作用域即使当前内容同值，也保留本次明确替换的事件归属", () => {
    const history = appendGroupHistory(createGroupHistory(document), document, document, {
      ...metadata("search_replace", "owner"), kind: "graph.search", scope: { type: "graph.replace" },
    });
    expect(history.events).toHaveLength(1);
    expect(history.events[0]).toMatchObject({ actorUserId: "owner", kind: "graph.search", scope: { type: "graph.replace" }, active: true });
    const undone = undoGroupHistory(history, document, "owner", "search_replace");
    expect(undone.history.redoIdsByUser.owner).toEqual(["search_replace"]);
    expect(undone.document.title).toBe(document.title);
  });
});

const node = (id: string) => ({ id, title: id, description: "", nodeType: "primary" as const, layer: 0,
  status: "empty" as const, resources: [], warnings: [] });

describe("小组本人选择性撤销与重做", () => {
  it("甲改名、乙改名后甲撤销仍保留乙，乙再撤销回到原始内容", () => {
    const first = rename(document, "甲"), second = rename(first, "乙");
    let history = appendGroupHistory(createGroupHistory(document), document, first, metadata("owner_title", "owner"));
    history = appendGroupHistory(history, first, second, metadata("member_title", "member"));
    const ownerUndo = undoGroupHistory(history, second, "owner", "owner_title");
    expect(ownerUndo.document.title).toBe("乙");
    expect(ownerUndo.history.redoIdsByUser.owner).toEqual(["owner_title"]);
    const memberUndo = undoGroupHistory(ownerUndo.history, ownerUndo.document, "member", "member_title");
    expect(memberUndo.document.title).toBe("资料");
    expect(memberUndo.history.redoIdsByUser).toEqual({ owner: ["owner_title"], member: ["member_title"] });
    const ownerRedo = redoGroupHistory(memberUndo.history, memberUndo.document, "owner");
    expect(ownerRedo.document.title).toBe("甲");
    expect(ownerRedo.history.redoIdsByUser.member).toEqual(["member_title"]);
    expect(redoGroupHistory(ownerRedo.history, ownerRedo.document, "member").document.title).toBe("乙");
  });

  it("拒绝撤销他人、缺失或重复事件，失败不改写原历史", () => {
    const next = rename(document, "甲");
    const history = appendGroupHistory(createGroupHistory(document), document, next, metadata("owner_title", "owner"));
    const saved = JSON.stringify(history);
    expect(() => undoGroupHistory(history, next, "member", "owner_title")).toThrow("GROUP_FORBIDDEN");
    expect(() => undoGroupHistory(history, next, "owner", "missing")).toThrow("GROUP_CONFLICT");
    expect(() => redoGroupHistory(history, next, "owner")).toThrow("GROUP_CONFLICT");
    expect(JSON.stringify(history)).toBe(saved);
    const undone = undoGroupHistory(history, next, "owner", "owner_title");
    expect(() => undoGroupHistory(undone.history, undone.document, "owner", "owner_title")).toThrow("GROUP_CONFLICT");
  });

  it("本人新增节点已被他人编辑时，撤销新增被依赖阻断", () => {
    const added = EditableGraphSchema.parse({ ...document, nodes: [node("node")], positions: { node: { x: 0, y: 0 } } });
    const edited = EditableGraphSchema.parse({ ...added, nodes: [{ ...added.nodes[0], description: "乙的贡献", status: "empty" }] });
    let history = appendGroupHistory(createGroupHistory(document), document, added, { ...metadata("owner_add", "owner"), kind: "node.add" });
    history = appendGroupHistory(history, added, edited, { ...metadata("member_edit", "member"), kind: "node.edit" });
    expect(() => undoGroupHistory(history, edited, "owner", "owner_add")).toThrow("GROUP_DEPENDENCY");
    expect(history.events.every(event => event.active)).toBe(true);
  });

  it("他人编辑不清本人重做，重做删除若会破坏新贡献则依赖阻断", () => {
    const initial = EditableGraphSchema.parse({ ...document, nodes: [node("node")], positions: { node: { x: 0, y: 0 } } });
    const deleted = EditableGraphSchema.parse({ ...document });
    let history = appendGroupHistory(createGroupHistory(initial), initial, deleted, { ...metadata("owner_delete", "owner"), kind: "node.delete" });
    const undone = undoGroupHistory(history, deleted, "owner", "owner_delete");
    const edited = EditableGraphSchema.parse({ ...undone.document, nodes: [{ ...undone.document.nodes[0], description: "乙的贡献", status: "empty" }] });
    history = appendGroupHistory(undone.history, undone.document, edited, { ...metadata("member_edit", "member"), kind: "node.edit" });
    expect(history.redoIdsByUser.owner).toEqual(["owner_delete"]);
    expect(() => redoGroupHistory(history, edited, "owner")).toThrow("GROUP_DEPENDENCY");
    expect(history.redoIdsByUser.owner).toEqual(["owner_delete"]);
  });

  it("重做资源会与他人后续资源违反全图URL唯一约束时拒绝", () => {
    const initial = EditableGraphSchema.parse({ ...document, nodes: [node("a"), node("b")] });
    const resource = { id: "resource_a", title: "资料", url: "https://example.test/page", canonicalUrl: "https://example.test/page",
      domain: "example.test", summary: "", whySelected: "", rank: 1, origin: "manual", sourceType: "user_added" };
    const first = EditableGraphSchema.parse({ ...initial, nodes: initial.nodes.map(item => item.id === "a"
      ? { ...item, status: "edited", resources: [resource] } : item) });
    let history = appendGroupHistory(createGroupHistory(initial), initial, first, { ...metadata("owner_resource", "owner"), kind: "resource.add" });
    const undone = undoGroupHistory(history, first, "owner", "owner_resource");
    const second = EditableGraphSchema.parse({ ...undone.document, nodes: undone.document.nodes.map(item => item.id === "b"
      ? { ...item, status: "edited", resources: [{ ...resource, id: "resource_b" }] } : item) });
    history = appendGroupHistory(undone.history, undone.document, second, { ...metadata("member_resource", "member"), kind: "resource.add" });
    expect(() => redoGroupHistory(history, second, "owner")).toThrow("GROUP_CONSTRAINT");
  });

  it("当前本人重做可成功时，不因队列后续删除存在依赖而提前拒绝当前改名", () => {
    const initial = EditableGraphSchema.parse({ ...document, nodes: [node("node")] });
    const renamed = rename(initial, "甲"), deleted = EditableGraphSchema.parse({ ...renamed, nodes: [], positions: {} });
    let history = appendGroupHistory(createGroupHistory(initial), initial, renamed, metadata("owner_title", "owner"));
    history = appendGroupHistory(history, renamed, deleted, { ...metadata("owner_delete", "owner"), kind: "node.delete" });
    const firstUndo = undoGroupHistory(history, deleted, "owner", "owner_delete");
    const secondUndo = undoGroupHistory(firstUndo.history, firstUndo.document, "owner", "owner_title");
    const edited = EditableGraphSchema.parse({ ...secondUndo.document, nodes: [{ ...node("node"), description: "乙的贡献" }] });
    history = appendGroupHistory(secondUndo.history, secondUndo.document, edited, { ...metadata("member_edit", "member"), kind: "node.edit" });
    const firstRedo = redoGroupHistory(history, edited, "owner");
    expect(firstRedo.document.title).toBe("甲");
    expect(firstRedo.document.nodes[0]?.description).toBe("乙的贡献");
    expect(firstRedo.history.redoIdsByUser.owner).toEqual(["owner_delete"]);
    expect(() => redoGroupHistory(firstRedo.history, firstRedo.document, "owner")).toThrow("GROUP_DEPENDENCY");
  });

  it("后续布局在撤销／重做中保留，纯拖动不清本人重做或生成额外事件", () => {
    const initial = EditableGraphSchema.parse({ ...document, nodes: [node("node")], positions: { node: { x: 0, y: 0 } } });
    const renamed = rename(initial, "甲");
    const history = appendGroupHistory(createGroupHistory(initial), initial, renamed, metadata("owner_title", "owner"));
    const undone = undoGroupHistory(history, renamed, "owner", "owner_title");
    const moved = { ...undone.document, positions: { node: { x: 90, y: 80 } } };
    const afterMove = appendGroupHistory(undone.history, undone.document, moved, metadata("layout_not_event", "member"));
    expect(afterMove.events).toHaveLength(1);
    expect(afterMove.redoIdsByUser.owner).toEqual(["owner_title"]);
    const redone = redoGroupHistory(afterMove, moved, "owner");
    expect(redone.document.positions.node).toEqual({ x: 90, y: 80 });
    expect(redone.document.title).toBe("甲");
  });
});
