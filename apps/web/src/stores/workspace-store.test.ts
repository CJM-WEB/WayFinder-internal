/** 测试职责：工作区与搜索运行分离，快照撤销按图隔离，刷新恢复不保留会话历史。 */
import { describe, expect, it } from "vitest";
import { pythonResultGraphFixture } from "../fixtures/python-result-graph.js";
import {
  createEmptyGraph, createWorkspaceStore, fromResultGraph,
  selectCurrentGraph, WORKSPACE_HISTORY_LIMIT,
} from "./workspace-store.js";

const emptyGraph = (id: string) => createEmptyGraph(id, "新搜索", "zh-CN", "2026-11-01T00:00:00Z");

describe("工作区快照", () => {
  it("真实搜索结果单向转换，稳定图身份独立于 runId，失败与来源保持真实", () => {
    const document = fromResultGraph(pythonResultGraphFixture, "固定图标识");
    expect(document.id).toBe("固定图标识");
    expect(document.lastRunId).toBe(pythonResultGraphFixture.runId);
    expect(document.nodes.map(node => node.status)).toEqual(pythonResultGraphFixture.graph.nodes.map(node => node.status));
    const resource = document.nodes.flatMap(node => node.resources)[0];
    expect(resource?.origin).toBe("search");
    expect(resource && "searchProvider" in resource ? resource.searchProvider : null).toBe("mock");
    document.nodes[0]?.resources.splice(0);
    expect(pythonResultGraphFixture.graph.nodes[0]?.resources.length).toBeGreaterThan(0);
  });

  it("每张图编辑、撤销和重做隔离，撤销后的新编辑清除本图重做", () => {
    const store = createWorkspaceStore();
    const actions = store.getState();
    actions.addGraph(emptyGraph("甲"));
    actions.renameGraph("甲", "甲一");
    actions.addGraph(emptyGraph("乙"));
    actions.renameGraph("乙", "乙一");
    actions.undo();
    expect(selectCurrentGraph(store.getState())?.title).toBe("新搜索");
    actions.selectGraph("甲");
    expect(selectCurrentGraph(store.getState())?.title).toBe("甲一");
    actions.undo();
    actions.redo();
    expect(selectCurrentGraph(store.getState())?.title).toBe("甲一");
    actions.undo();
    actions.renameGraph("甲", "甲二");
    actions.redo();
    expect(selectCurrentGraph(store.getState())?.title).toBe("甲二");
    actions.selectGraph("乙");
    actions.redo();
    expect(selectCurrentGraph(store.getState())?.title).toBe("乙一");
  });

  it("会话撤销只保留最近100步", () => {
    const store = createWorkspaceStore();
    const actions = store.getState();
    actions.addGraph(emptyGraph("图"));
    for (let index = 0; index < 105; index += 1) actions.renameGraph("图", `编辑${index}`);
    for (let index = 0; index < WORKSPACE_HISTORY_LIMIT + 1; index += 1) actions.undo();
    expect(selectCurrentGraph(store.getState())?.title).toBe("编辑4");
    for (let index = 0; index < WORKSPACE_HISTORY_LIMIT; index += 1) actions.redo();
    expect(selectCurrentGraph(store.getState())?.title).toBe("编辑104");
  });

  it("删除记录可以恢复完整快照和该图原有历史", () => {
    const store = createWorkspaceStore();
    const actions = store.getState();
    actions.addGraph(emptyGraph("甲"));
    actions.renameGraph("甲", "甲编辑");
    actions.addGraph(emptyGraph("乙"));
    actions.deleteGraph("甲");
    expect(store.getState().documents.map(graph => graph.id)).toEqual(["乙"]);
    actions.restoreDeletedGraph();
    expect(store.getState().documents.map(graph => graph.id)).toEqual(["甲", "乙"]);
    expect(selectCurrentGraph(store.getState())?.title).toBe("甲编辑");
    actions.undo();
    expect(selectCurrentGraph(store.getState())?.title).toBe("新搜索");
  });

  it("写入与恢复均复制快照，外部修改不污染存档或撤销；恢复时清空历史", () => {
    const store = createWorkspaceStore();
    const actions = store.getState();
    const input = emptyGraph("甲");
    actions.addGraph(input);
    input.title = "外部篡改";
    expect(selectCurrentGraph(store.getState())?.title).toBe("新搜索");
    const replacement = { ...emptyGraph("甲"), title: "正式编辑" };
    actions.replaceGraph(replacement);
    replacement.title = "外部修改";
    expect(selectCurrentGraph(store.getState())?.title).toBe("正式编辑");
    actions.restoreDocuments(store.getState().documents, "甲");
    actions.undo();
    expect(selectCurrentGraph(store.getState())?.title).toBe("正式编辑");
    expect(store.getState().histories["甲"]?.past).toHaveLength(0);
  });

  it("非法快照或重复图身份不会破坏当前工作区", () => {
    const store = createWorkspaceStore();
    const actions = store.getState();
    actions.addGraph(emptyGraph("甲"));
    expect(() => actions.addGraph(emptyGraph("甲"))).toThrow();
    expect(() => actions.replaceGraph({ ...emptyGraph("甲"), title: "" })).toThrow();
    expect(() => actions.restoreDocuments([emptyGraph("甲"), emptyGraph("甲")], "甲")).toThrow();
    actions.selectGraph("不存在");
    expect(selectCurrentGraph(store.getState())?.title).toBe("新搜索");
    expect(store.getState().documents).toHaveLength(1);
  });
});

it("选中节点按图隔离且恢复文档不继承会话选择", () => {
  const store = createWorkspaceStore();
  const first = fromResultGraph(pythonResultGraphFixture, "甲");
  const second = fromResultGraph(pythonResultGraphFixture, "乙");
  const nodeId = first.nodes[0]?.id;
  if (nodeId === undefined) throw new Error("缺少测试节点");
  store.getState().addGraph(first);
  store.getState().selectNode(nodeId);
  store.getState().addGraph(second);
  expect(store.getState().selectedNodeIds["乙"]).toBeUndefined();
  store.getState().selectNode(null);
  store.getState().selectGraph("甲");
  expect(store.getState().selectedNodeIds["甲"]).toBe(nodeId);
  store.getState().restoreDocuments(store.getState().documents, "甲");
  expect(store.getState().selectedNodeIds).toEqual({});
});
