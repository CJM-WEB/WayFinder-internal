/**
 * 测试职责：验证 WAY-27 Graph store 的状态形状和基础生命周期。
 *
 * 范围边界：旧 Run、重复/倒序事件与 complete 后封闭由 WAY-72 实现，
 * 本文件只验证当前 Issue 要求的状态持有与显式更新动作。
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  GraphPlanSchema,
  ResultGraphSchema,
  StreamEventSchema,
} from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import { createGraphStore, selectSelectedNode } from "./graph-store.js";

const graphPlanFixturePath = fileURLToPath(
  new globalThis.URL(
    "../../../../tests/fixtures/contracts/graph-plan.valid.json",
    import.meta.url,
  ),
);

const graphPlan = GraphPlanSchema.parse(
  JSON.parse(fs.readFileSync(graphPlanFixturePath, "utf8")),
);

const resultGraphFixturePath = fileURLToPath(
  new globalThis.URL(
    "../../../../tests/fixtures/contracts/result-graphs.valid.json",
    import.meta.url,
  ),
);

const resultGraphFixtures: unknown = JSON.parse(
  fs.readFileSync(resultGraphFixturePath, "utf8"),
);

if (
  typeof resultGraphFixtures !== "object" ||
  resultGraphFixtures === null ||
  !("ready" in resultGraphFixtures)
) {
  throw new Error("ResultGraph fixture 缺少 ready 样例");
}

const readyResultGraph = ResultGraphSchema.parse(resultGraphFixtures.ready);

/** 基础生命周期测试也通过正式事件推进游标，避免保留绕过 Reducer 的测试入口。 */
const createAnalysisEvent = (runId: string, sequence: number) =>
  StreamEventSchema.parse({
    runId,
    sequence,
    protocolVersion: "0.1",
    timestamp: "2026-10-22T00:00:00.000Z",
    type: "query.analysis",
    data: graphPlan.analysis,
  });

describe("Graph store", () => {
  it("提供空闲且未选中节点的初始状态", () => {
    const state = createGraphStore().getState();

    expect(state.activeRunId).toBeNull();
    expect(state.query).toBe("");
    expect(state.nodes).toEqual([]);
    expect(state.edges).toEqual([]);
    expect(state.selectedNodeId).toBeNull();
    expect(state.isSearching).toBe(false);
    expect(state.lastSequence).toBe(0);
    expect(selectSelectedNode(state)).toBeNull();
  });

  it("开始新 Run 时原子清空旧图、选择与序号", () => {
    const store = createGraphStore();

    store.getState().startRun({ runId: "old-run", query: "old query" });
    store.getState().setGraph(graphPlan);
    store.getState().selectNode(graphPlan.nodes[0]?.id ?? null);
    store.getState().applyStreamEvent(createAnalysisEvent("old-run", 8));

    store.getState().startRun({ runId: "new-run", query: "new query" });

    expect(store.getState()).toMatchObject({
      activeRunId: "new-run",
      query: "new query",
      nodes: [],
      edges: [],
      selectedNodeId: null,
      isSearching: true,
      lastSequence: 0,
    });
  });

  it("保存共享 GraphPlan，并从 selectedNodeId 派生选中节点", () => {
    const store = createGraphStore();
    const node = graphPlan.nodes[0];

    expect(node).toBeDefined();
    store.getState().setGraph(graphPlan);
    store.getState().selectNode(node?.id ?? null);

    expect(store.getState().nodes).toEqual(graphPlan.nodes);
    expect(store.getState().edges).toEqual(graphPlan.edges);
    expect(selectSelectedNode(store.getState())).toEqual(node);
  });

  it("替换图时清除已不存在的选中节点", () => {
    const store = createGraphStore();

    store.getState().setGraph(graphPlan);
    store.getState().selectNode(graphPlan.nodes[0]?.id ?? null);
    store.getState().setGraph({ nodes: [], edges: [] });

    expect(store.getState().selectedNodeId).toBeNull();
    expect(selectSelectedNode(store.getState())).toBeNull();
  });

  it("接受共享 ResultGraph 的最终 Graph 快照", () => {
    const store = createGraphStore();

    store.getState().setGraph(readyResultGraph.graph);

    expect(store.getState().nodes).toEqual(readyResultGraph.graph.nodes);
    expect(store.getState().edges).toEqual(readyResultGraph.graph.edges);
    expect(store.getState().nodes[0]?.status).toBe("ready");
  });

  it("独立记录搜索状态与最后序号", () => {
    const store = createGraphStore();

    store.getState().startRun({ runId: "run-27", query: "WayFinder" });
    store.getState().applyStreamEvent(createAnalysisEvent("run-27", 12));
    store.getState().finishRun();

    expect(store.getState().lastSequence).toBe(12);
    expect(store.getState().isSearching).toBe(false);
  });

  it("reset 恢复完整初始状态", () => {
    const store = createGraphStore();

    store.getState().startRun({ runId: "run-27", query: "WayFinder" });
    store.getState().setGraph(graphPlan);
    store.getState().selectNode(graphPlan.nodes[0]?.id ?? null);
    store.getState().applyStreamEvent(createAnalysisEvent("run-27", 3));
    store.getState().reset();

    expect(store.getState()).toMatchObject({
      activeRunId: null,
      query: "",
      nodes: [],
      edges: [],
      selectedNodeId: null,
      isSearching: false,
      lastSequence: 0,
    });
  });
});
