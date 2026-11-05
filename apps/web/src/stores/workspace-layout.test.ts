/** 测试职责：布局与连线只修改确定性图数据；移动不入撤销，连线编辑仍可撤销且保留最新布局。 */
import { describe, expect, it } from "vitest";
import { createEmptyGraph, createWorkspaceStore } from "./workspace-store.js";
import { addNode, addEdge, updateEdge, deleteEdge, moveNode, InvalidGraphConnectionError } from "./workspace-edits.js";

const graph = () => addNode(addNode(addNode(createEmptyGraph("图", "布局", "zh-CN"), "甲", "", "a"), "乙", "", "b"), "独立", "", "c");

describe("人工布局与连线", () => {
  it("拖动保存但不入撤销，撤销与重做连线不回退最新位置", () => {
    const store = createWorkspaceStore();
    const initial = graph();
    store.getState().addGraph(initial);
    const moved = moveNode(initial, "a", { x: -123, y: 456 });
    store.getState().replaceGraph(moved);
    expect(store.getState().documents[0]?.positions).toEqual({ ...initial.positions, a: { x: -123, y: 456 } });
    expect(store.getState().histories[initial.id]?.events).toHaveLength(0);
    expect(store.getState().histories[initial.id]?.past).toHaveLength(0);
    store.getState().undo();
    expect(store.getState().documents[0]).toEqual(moved);
    store.getState().replaceGraph(addEdge(moved, "a", "b", "related_to", "e1"));
    expect(store.getState().histories[initial.id]?.past).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().documents[0]?.edges).toHaveLength(0);
    expect(store.getState().documents[0]?.positions).toEqual(moved.positions);
    store.getState().redo();
    expect(store.getState().documents[0]?.edges[0]?.id).toBe("e1");
    expect(store.getState().documents[0]?.positions).toEqual(moved.positions);
  });

  it("相关线可成环，人工图可有独立节点，连线修改和删除保留其他内容", () => {
    const initial = graph();
    const first = addEdge(initial, "a", "b", "related_to", "e1");
    const cycle = addEdge(first, "b", "a", "related_to", "e2");
    expect(cycle.edges).toHaveLength(2);
    const changed = updateEdge(cycle, "e1", { target: "c", type: "recommended_next" });
    expect(changed.edges[0]).toMatchObject({ id: "e1", source: "a", target: "c", type: "recommended_next" });
    expect(changed.positions).toEqual(initial.positions);
    expect(deleteEdge(changed, "e2").edges.map(edge => edge.id)).toEqual(["e1"]);
  });

  it("新增或修改推荐线不允许成环，拒绝悬空端点且保持原图", () => {
    const initial = addEdge(graph(), "a", "b", "recommended_next", "e1");
    expect(() => addEdge(initial, "b", "a", "recommended_next")).toThrow(InvalidGraphConnectionError);
    expect(() => addEdge(initial, "b", "不存在", "related_to")).toThrow(InvalidGraphConnectionError);
    const related = addEdge(initial, "b", "a", "related_to", "e2");
    expect(() => updateEdge(related, "e2", { type: "recommended_next" })).toThrow(InvalidGraphConnectionError);
    expect(initial.edges).toHaveLength(1);
  });

  it("同位置与不存在的目标操作不增加撤销步骤", () => {
    const store = createWorkspaceStore();
    const initial = graph();
    store.getState().addGraph(initial);
    const position = initial.positions.a;
    if (position === undefined) throw new Error("缺少初始坐标");
    store.getState().replaceGraph(moveNode(initial, "a", position));
    store.getState().replaceGraph(moveNode(initial, "不存在", { x: 0, y: 0 }));
    store.getState().replaceGraph(deleteEdge(initial, "不存在"));
    expect(store.getState().histories[initial.id]?.past).toHaveLength(0);
  });
});
