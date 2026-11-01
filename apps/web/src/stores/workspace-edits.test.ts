/** 测试职责：人工编辑不伪造搜索状态，生产 URL 去重与拖拽顺序可以原样撤销恢复。 */
import { describe, expect, it } from "vitest";
import { createEmptyGraph, createWorkspaceStore, fromResultGraph } from "./workspace-store.js";
import { pythonResultGraphFixture } from "../fixtures/python-result-graph.js";
import {
  addNode, addResource, deleteNode, deleteResource, updateNode, updateResource,
  moveResource, DuplicateResourceUrlError, InvalidResourceUrlError,
} from "./workspace-edits.js";

const empty = () => createEmptyGraph("图", "编辑图", "zh-CN", "2026-11-01T00:00:00Z");

describe("确定性人工编辑", () => {
  it("原样保存与不存在的资源操作保留搜索状态且不增加撤销步", () => {
    const store = createWorkspaceStore();
    const graph = fromResultGraph(pythonResultGraphFixture, "图");
    store.getState().addGraph(graph);
    for (const node of graph.nodes) {
      store.getState().replaceGraph(updateNode(graph, node.id, { title: node.title, description: node.description }));
      store.getState().replaceGraph(deleteResource(graph, node.id, "不存在"));
      store.getState().replaceGraph(updateResource(graph, node.id, "不存在", { summary: "不应写入" }));
      for (const resource of node.resources) {
        store.getState().replaceGraph(updateResource(graph, node.id, resource.id, {
          title: resource.title, url: resource.url, summary: resource.summary, whySelected: resource.whySelected,
        }));
      }
    }
    expect(store.getState().documents[0]).toEqual(graph);
    expect(store.getState().histories[graph.id]?.past).toHaveLength(0);
  });

  it("节点与资源可超过初稿上限，资源标题来自域名且说明为空", () => {
    let graph = empty();
    for (let index = 0; index < 12; index += 1) graph = addNode(graph, `节点${index}`, "", `n${index}`);
    for (let index = 0; index < 12; index += 1) graph = addResource(graph, "n0", `https://example.com/${index}`, `r${index}`);
    expect(graph.nodes).toHaveLength(12);
    expect(graph.nodes[0]?.resources.map(resource => resource.rank)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(graph.nodes[0]?.resources[0]).toMatchObject({ origin: "manual", title: "example.com", summary: "", whySelected: "" });
    expect(graph.nodes[0]?.resources[0]).not.toHaveProperty("searchProvider");
  });

  it("全图按生产规范化地址去重，错误携带所在节点；非法 URL 不进入图", () => {
    const graph = addResource(addNode(addNode(empty(), "已有资料", "", "a"), "新节点", "", "b"), "a", "https://EXAMPLE.com:443/page?z=2&utm_source=x&a=1#part", "r");
    try {
      addResource(graph, "b", "https://example.com/page?a=1&z=2");
      throw new Error("应拒绝重复");
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateResourceUrlError);
      expect(error).toMatchObject({ nodeId: "a", nodeTitle: "已有资料" });
    }
    for (const url of ["javascript:alert(1)", "/relative", "not a url"]) {
      expect(() => addResource(graph, "b", url)).toThrow(InvalidResourceUrlError);
    }
    expect(graph.nodes[1]?.resources).toEqual([]);
  });

  it("标题编辑独立，删除节点级联连线与位置，删空资源为正常空态", () => {
    let graph = addNode(addNode(empty(), "甲", "", "a"), "乙", "", "b");
    graph = { ...graph, edges: [{ id: "e", source: "a", target: "b", type: "related_to" }] };
    graph = addResource(graph, "a", "https://example.com/a", "r");
    const renamed = updateNode(graph, "a", { title: "改名", description: "新说明" });
    expect(graph.nodes[0]?.title).toBe("甲");
    expect(renamed.nodes[0]).toMatchObject({ title: "改名", description: "新说明" });
    const cleared = deleteResource(renamed, "a", "r");
    expect(cleared.nodes[0]).toMatchObject({ status: "empty", resources: [], warnings: [] });
    expect(cleared.nodes[0]).not.toHaveProperty("error");
    const removed = deleteNode(cleared, "a");
    expect(removed.edges).toEqual([]);
    expect(removed.positions).not.toHaveProperty("a");
  });

  it("修改说明保留真实搜索来源，换成不同 URL 则不冒用原来源", () => {
    const graph = fromResultGraph(pythonResultGraphFixture, "图");
    const node = graph.nodes.find(item => item.resources.length > 0);
    const resource = node?.resources[0];
    if (node === undefined || resource === undefined) throw new Error("缺少测试资源");
    const changed = updateResource(graph, node.id, resource.id, { summary: "人工说明", whySelected: "人工理由" });
    expect(changed.nodes.find(item => item.id === node.id)?.resources[0]).toMatchObject({ origin: "search", summary: "人工说明" });
    const replaced = updateResource(changed, node.id, resource.id, { url: "https://example.com/new" });
    const manual = replaced.nodes.find(item => item.id === node.id)?.resources[0];
    expect(manual).toMatchObject({ origin: "manual", canonicalUrl: "https://example.com/new" });
    expect(manual).not.toHaveProperty("searchProvider");
  });

  it("直接移动资源数组并重排连续序位，撤销重做恢复内容与顺序", () => {
    const store = createWorkspaceStore();
    let graph = addNode(empty(), "节点", "", "n");
    for (const id of ["a", "b", "c"]) graph = addResource(graph, "n", `https://example.com/${id}`, id);
    store.getState().addGraph(graph);
    store.getState().replaceGraph(moveResource(graph, "n", "c", "a"));
    expect(store.getState().documents[0]?.nodes[0]?.resources.map(resource => resource.id)).toEqual(["c", "a", "b"]);
    expect(store.getState().documents[0]?.nodes[0]?.resources.map(resource => resource.rank)).toEqual([1, 2, 3]);
    store.getState().undo();
    expect(store.getState().documents[0]?.nodes[0]?.resources.map(resource => resource.id)).toEqual(["a", "b", "c"]);
    store.getState().redo();
    expect(store.getState().documents[0]?.nodes[0]?.resources.map(resource => resource.id)).toEqual(["c", "a", "b"]);
  });
});
