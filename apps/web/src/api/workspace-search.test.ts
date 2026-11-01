/** 测试职责：完成结果只写所属图，记录切换与删除不触发新搜索或复活旧记录。 */
import { describe, expect, it } from "vitest";
import { pythonResultGraphFixture } from "../fixtures/python-result-graph.js";
import { createWorkspaceStore, selectCurrentGraph } from "../stores/workspace-store.js";
import { createWorkspaceSearchHandoff } from "./workspace-search.js";

const request = (runId: string, query: string) => ({ runId, query, language: "zh-CN" as const });

describe("搜索与记录交付", () => {
  it("图身份独立于Run，完成只更新所属记录且不抢回当前图", () => {
    const store = createWorkspaceStore();
    let nextId = 0;
    const handoff = createWorkspaceSearchHandoff(store, () => `图${++nextId}`);
    handoff.onStart(request("运行甲", "Python"));
    handoff.onStart(request("运行乙", "TypeScript"));
    store.getState().selectGraph("图1");
    handoff.onComplete({ ...pythonResultGraphFixture, runId: "运行乙", query: { ...pythonResultGraphFixture.query, raw: "TypeScript", normalized: "TypeScript" } });
    expect(selectCurrentGraph(store.getState())?.id).toBe("图1");
    const second = store.getState().documents[1];
    expect(second?.id).not.toBe(second?.lastRunId);
    expect(second?.nodes).toHaveLength(4);
    expect(Object.keys(second?.positions ?? {})).toHaveLength(4);
    expect(store.getState().documents[0]?.nodes).toEqual([]);
  });

  it("删除后到达的完成不会复活记录，改名也不被完成事件覆盖", () => {
    const store = createWorkspaceStore();
    const handoff = createWorkspaceSearchHandoff(store, () => "图");
    handoff.onStart(request(pythonResultGraphFixture.runId, "Python"));
    store.getState().renameGraph("图", "我的资料");
    handoff.onComplete(pythonResultGraphFixture);
    expect(selectCurrentGraph(store.getState())?.title).toBe("我的资料");
    store.getState().deleteGraph("图");
    handoff.onComplete(pythonResultGraphFixture);
    expect(store.getState().documents).toHaveLength(0);
  });
});

it("完成交付保留最新引擎偏好，不把该偏好重标为旧资源实际来源", () => {
  const store = createWorkspaceStore();
  const handoff = createWorkspaceSearchHandoff(store, () => "图");
  handoff.onStart({ ...request(pythonResultGraphFixture.runId, "Python"), engine: "google" });
  const graph = selectCurrentGraph(store.getState());
  if (graph === null) throw new Error("缺少搜索图");
  expect(graph.engine).toBe("google");
  store.getState().replaceGraph({ ...graph, engine: "baidu" });
  handoff.onComplete({ ...pythonResultGraphFixture, graph: {
    ...pythonResultGraphFixture.graph,
    nodes: pythonResultGraphFixture.graph.nodes.map(node => ({
      ...node, resources: node.resources.map(resource => ({ ...resource, engine: "google" as const })),
    })),
  } });
  const saved = selectCurrentGraph(store.getState());
  expect(saved?.engine).toBe("baidu");
  expect(saved?.nodes[0]?.resources[0]).toMatchObject({ engine: "google", origin: "search" });
});
