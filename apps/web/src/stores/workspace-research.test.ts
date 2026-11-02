/** 测试职责：预览应用遵守最新图的去重与覆盖规则，保留来源，整体替换可以一步恢复旧图。 */
import { describe, expect, it } from "vitest";
import { ResultGraphSchema, type Resource } from "@wayfinder/contracts";
import { pythonResultGraphFixture } from "../fixtures/python-result-graph.js";
import { addNode, addResource, updateResource } from "./workspace-edits.js";
import { createEmptyGraph, createWorkspaceStore } from "./workspace-store.js";
import { applyGraphSearchResult, applyNodeSearchResult } from "./workspace-research.js";

function resource(id: string, rank: number, url = `https://new.example.com/${id}`): Resource {
  return {
    id, rank, url, canonicalUrl: url, domain: new URL(url).hostname, title: id,
    sourceType: "documentation", summary: "新网页说明", whySelected: "新选用理由",
    searchProvider: "fixture", engine: "google",
  };
}
function searchResult(resources: Resource[], runId = "新运行") {
  const seed = pythonResultGraphFixture.graph.nodes[0];
  if (seed === undefined) throw new Error("缺少固定节点");
  return ResultGraphSchema.parse({
    ...pythonResultGraphFixture, runId,
    analysis: { ...pythonResultGraphFixture.analysis, presentationMode: "compact", strategy: "plan_first", broadSearchQueries: [] },
    graph: { nodes: [{ ...seed, id: "target", title: "搜索时标题", status: "ready", resources, warnings: [] }], edges: [] },
    meta: { ...pythonResultGraphFixture.meta, partial: false },
  });
}
const original = () => addResource(addNode(createEmptyGraph("图", "记录名", "zh-CN"), "当前标题", "当前说明", "target"), "target", "https://old.example.com/a", "old");

describe("重搜结果应用", () => {
  it("单节点追加保留人工内容与顺序，每次最多6项但累计可超过6，ID与来源保持真实", () => {
    const graph = { ...original(), analysis: { ...pythonResultGraphFixture.analysis, presentationMode: "graph" as const } };
    const result = searchResult(Array.from({ length: 8 }, (_, index) => resource(`r${index}`, index + 1)));
    const next = applyNodeSearchResult(graph, "target", result, "append");
    expect(next.nodes[0]?.resources).toHaveLength(7);
    expect(next.nodes[0]?.resources[0]).toEqual(graph.nodes[0]?.resources[0]);
    expect(next.nodes[0]?.resources.slice(1).every(item => item.origin === "search" && item.engine === "google")).toBe(true);
    expect(next.nodes[0]?.resources.map(item => item.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(next.nodes[0]).toMatchObject({ title: "当前标题", description: "当前说明" });
    expect(next.positions).toEqual(graph.positions);
    expect(next.analysis).toEqual(graph.analysis);
    expect(graph.nodes[0]?.resources).toHaveLength(1);
  });

  it("替换覆盖人工文本，允许本节点旧URL，但过滤其他节点已有URL", () => {
    let graph = addNode(original(), "其他节点", "", "other");
    graph = addResource(graph, "other", "https://other.example.com/b", "other-r");
    graph = updateResource(graph, "target", "old", { summary: "人工说明", whySelected: "人工理由" });
    const result = searchResult([
      resource("same", 1, "https://old.example.com/a"),
      resource("elsewhere", 2, "https://other.example.com/b"),
    ]);
    const next = applyNodeSearchResult(graph, "target", result, "replace");
    expect(next.nodes[0]?.resources).toHaveLength(1);
    expect(next.nodes[0]?.resources[0]).toMatchObject({ summary: "新网页说明", whySelected: "新选用理由", rank: 1 });
    expect(next.nodes[1]).toEqual(graph.nodes[1]);
    expect(next.edges).toEqual(graph.edges);
  });

  it("应用时重新检查预览后新增的URL，不额外补位或覆盖旧内容", () => {
    const graph = original();
    const result = searchResult([resource("r", 1)]);
    const editedAfterPreview = addResource(graph, "target", "https://new.example.com/r", "manual-new");
    expect(applyNodeSearchResult(editedAfterPreview, "target", result, "append")).toBe(editedAfterPreview);
    const otherOwns = addResource(addNode(graph, "其他", "", "other"), "other", "https://new.example.com/r", "manual-new");
    expect(applyNodeSearchResult(otherOwns, "target", result, "replace")).toBe(otherOwns);
  });

  it("跨运行候选ID重用不会覆盖旧资源，重复应用不产生重复", () => {
    const graph = original();
    const first = applyNodeSearchResult(graph, "target", searchResult([resource("r", 1)], "run"), "append");
    const second = applyNodeSearchResult(first, "target", searchResult([resource("r", 1, "https://new.example.com/another")], "run"), "append");
    const ids = second.nodes[0]?.resources.map(item => item.id);
    expect(new Set(ids).size).toBe(3);
    expect(applyNodeSearchResult(second, "target", searchResult([resource("r", 1)], "run"), "append")).toBe(second);
  });

  it("全图整体替换不与旧图去重，可一次撤销恢复完整人工图", () => {
    const store = createWorkspaceStore();
    const graph = { ...original(), engine: "baidu" as const, positions: { target: { x: -125, y: 456 } } };
    store.getState().addGraph(graph);
    const result = searchResult([resource("same", 1, "https://old.example.com/a")]);
    store.getState().replaceGraph(applyGraphSearchResult(graph, result));
    expect(store.getState().documents[0]).toMatchObject({ id: graph.id, title: graph.title, engine: "baidu" });
    expect(store.getState().documents[0]?.nodes[0]?.title).toBe("搜索时标题");
    expect(store.getState().histories[graph.id]?.past).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().documents[0]).toEqual(graph);
    store.getState().redo();
    expect(store.getState().documents[0]?.nodes[0]?.resources[0]?.summary).toBe("新网页说明");
  });

  it("目标消失或失败、全图无可用结果时保留原图", () => {
    const graph = original();
    const result = searchResult([resource("r", 1)]);
    expect(applyNodeSearchResult(graph, "不存在", result, "append")).toBe(graph);
    const seed = result.graph.nodes[0];
    const failed = ResultGraphSchema.parse({
      ...result, graph: { nodes: [{ ...seed, status: "failed", resources: [], warnings: [], error: { code: "SEARCH_PROVIDER_FAILED", retryable: true } }], edges: [] },
      meta: { ...result.meta, partial: true },
    });
    expect(applyNodeSearchResult(graph, "target", failed, "replace")).toBe(graph);
    expect(applyGraphSearchResult(graph, failed)).toBe(graph);
  });
});
