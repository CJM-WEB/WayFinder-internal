/** 确定性回归：呈现顺序遵循真实关系且不漏图，不以动画改写公共图或搜索状态。 */
import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNodeCore } from "@wayfinder/contracts";
import { INK_BRANCH_TRAVEL, INK_NODE_FORM, INK_SEED_ARRIVAL, inkEase, planInkGraph } from "./ink-graph-motion.js";

const node = (id: string, nodeType: GraphNodeCore["nodeType"] = "primary") => ({ id, nodeType });
const edge = (id: string, source: string, target: string, type: GraphEdge["type"] = "recommended_next"): GraphEdge => ({ id, source, target, type });

describe("墨迹图的呈现时间表", () => {
  it("同一节点的分支同时出发，目的节点到达后才开始成形", () => {
    const plan = planInkGraph([node("a"), node("b"), node("c")], [edge("ab", "a", "b"), edge("ac", "a", "c")]);
    expect(plan.nodes.find(node => node.id === "a")?.bornAt).toBe(INK_SEED_ARRIVAL);
    expect(plan.branches.map(branch => branch.startAt)).toEqual([INK_SEED_ARRIVAL + INK_NODE_FORM, INK_SEED_ARRIVAL + INK_NODE_FORM]);
    expect(plan.nodes.find(node => node.id === "b")?.bornAt).toBe(INK_SEED_ARRIVAL + INK_NODE_FORM + INK_BRANCH_TRAVEL);
    expect(plan.branches.every(branch => branch.detachAt > branch.arriveAt)).toBe(true);
  });

  it("多根汇合仍按推荐原方向生长，每条真实边只揭示一次", () => {
    const edges = [edge("ac", "a", "c"), edge("bc", "b", "c")];
    const plan = planInkGraph([node("a"), node("b"), node("c")], edges);
    expect(plan.nodes.filter(node => node.seed).map(node => node.id)).toEqual(["a", "b"]);
    expect(plan.branches.map(({ id, source, target }) => ({ id, source, target }))).toEqual(edges.map(({ id, source, target }) => ({ id, source, target })));
    expect(new Set(plan.nodes.map(node => node.id)).size).toBe(3);
  });

  it("反向存储的相关边可从先出现的一端生长，相关环不会重复揭示节点", () => {
    const plan = planInkGraph([node("a"), node("b", "related"), node("c", "related")], [
      edge("ba", "b", "a", "related_to"), edge("bc", "b", "c", "related_to"), edge("ca", "c", "a", "related_to"),
    ]);
    expect(plan.branches.find(edge => edge.id === "ba")).toMatchObject({ source: "a", target: "b" });
    expect(plan.nodes.filter(node => node.seed)).toHaveLength(1);
    expect(plan.nodes).toHaveLength(3);
    expect(new Set(plan.branches.map(edge => edge.id)).size).toBe(3);
  });

  it("不同深度的多根汇合以首次实际到达出生，所有分支不会先于目标露出正式边", () => {
    const plan = planInkGraph([node("a"), node("b"), node("c"), node("d")], [
      edge("ac", "a", "c"), edge("cd", "c", "d"), edge("bd", "b", "d"),
    ]);
    const destination = plan.nodes.find(node => node.id === "d");
    expect(destination?.bornAt).toBe(plan.branches.find(branch => branch.id === "bd")?.arriveAt);
    expect(plan.branches.every(branch => branch.arriveAt >= (plan.nodes.find(node => node.id === branch.target)?.bornAt ?? Infinity))).toBe(true);
  });

  it("孤立节点分别播种，不制造不存在的连线，也不修改输入", () => {
    const nodes = [node("a"), node("b"), node("c")];
    const edges = [edge("ab", "a", "b")];
    const before = JSON.stringify({ nodes, edges });
    const plan = planInkGraph(nodes, edges);
    expect(plan.nodes.find(node => node.id === "c")?.seed).toBe(true);
    expect(plan.branches.map(edge => edge.id)).toEqual(["ab"]);
    expect(JSON.stringify({ nodes, edges })).toBe(before);
    expect(planInkGraph([], [])).toEqual({ nodes: [], branches: [] });
  });

  it("节点数组倒序时仍先播真实根，非连通图的后继不能抢先成为种子", () => {
    const plan = planInkGraph([node("a"), node("c"), node("b")], [edge("bc", "b", "c")]);
    expect(plan.nodes.filter(node => node.seed).map(node => node.id)).toEqual(["a", "b"]);
    expect(plan.nodes.find(node => node.id === "c")?.bornAt).toBe(plan.branches[0]?.arriveAt);
  });

  it("八节点及全部交叉边完整保留，汇合不会只保留遍历树", () => {
    const nodes = Array.from({ length: 8 }, (_, index) => node(String(index)));
    const edges = nodes.flatMap((source, i) => nodes.slice(i + 1).map(target => edge(`${source.id}-${target.id}`, source.id, target.id)));
    const plan = planInkGraph(nodes, edges);
    expect(plan.nodes).toHaveLength(8);
    expect(plan.branches).toHaveLength(28);
    expect(new Set(plan.branches.map(branch => branch.id))).toEqual(new Set(edges.map(edge => edge.id)));
  });
});

it("S 曲线两端夹紧、中心对称，前半加速后半减速", () => {
  expect(inkEase(-1)).toBe(0);
  expect(inkEase(2)).toBe(1);
  expect(inkEase(0.5)).toBeCloseTo(0.5, 4);
  expect(inkEase(0.25)).toBeLessThan(0.25);
  expect(inkEase(0.75)).toBeGreaterThan(0.75);
  expect(inkEase(0.25) + inkEase(0.75)).toBeCloseTo(1, 4);
  const steps = Array.from({ length: 11 }, (_, index) => inkEase(index / 10));
  expect(steps.every((value, index) => index === 0 || value > (steps[index - 1] ?? -1))).toBe(true);
});
