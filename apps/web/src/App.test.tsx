/**
 * 测试职责：验证应用壳层忠实展示 Store 中的 Presentation Mode（展示模式）。
 *
 * 边界约束：这里只检查模式文案与容器，不触发 Compact 自动选择；后者属于 WAY-79。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StreamEventSchema, type PresentationMode } from "@wayfinder/contracts";

vi.mock("zustand", () => ({
  useStore: <State, Selected>(
    store: { getState: () => State },
    selector: (state: State) => Selected,
  ): Selected => selector(store.getState()),
}));

import {
  App,
  applyDocumentLanguage,
  resolveRenderLanguage,
} from "./App.js";
import { pythonResultGraphFixture } from "./fixtures/python-result-graph.js";
import { graphStore } from "./stores/graph-store.js";

const applyPresentationMode = (presentationMode: PresentationMode): void => {
  graphStore
    .getState()
    .startRun({ runId: "run-mode", query: "测试模式", language: "zh-CN" });
  graphStore.getState().applyStreamEvent(
    StreamEventSchema.parse({
      runId: "run-mode",
      sequence: 1,
      protocolVersion: "0.1",
      timestamp: "2026-10-22T00:00:00.000Z",
      type: "query.analysis",
      data: {
        intent: "learn",
        topic: "测试模式",
        freshnessSensitive: false,
        ambiguityLevel: "low",
        presentationMode,
        broadSearchQueries: [],
        strategy: "plan_first",
      },
    }),
  );
};

afterEach(() => {
  graphStore.getState().reset();
});

describe("App Presentation Mode", () => {
  it("已有 Run 锁定 renderLanguage，未开始时才跟随选择器", () => {
    expect(resolveRenderLanguage(null, "en-US")).toBe("en-US");
    expect(resolveRenderLanguage("zh-CN", "en-US")).toBe("zh-CN");
    expect(resolveRenderLanguage("en-US", "zh-CN")).toBe("en-US");
  });

  it("把唯一 renderLanguage 同步到 HTML 根节点", () => {
    const documentElement = { lang: "zh-CN" };

    applyDocumentLanguage(documentElement, "en-US");

    expect(documentElement.lang).toBe("en-US");
  });

  it("入口语言预选搜索语言且不自动创建 Run", () => {
    const markup = renderToStaticMarkup(<App initialLanguage="en-US" />);
    expect(markup).toContain("Search results");
    expect(markup).toContain('<option value="en-US" selected="">');
    expect(graphStore.getState().language).toBeNull();
  });

  it("入口语言不改写既有 Run 的展示语言", () => {
    graphStore.getState().startRun({ runId: "run-entry", query: "原查询", language: "zh-CN" });
    const markup = renderToStaticMarkup(<App initialLanguage="en-US" />);
    expect(markup).toContain("搜索结果");
    expect(markup).toContain('<option value="en-US" selected="">');
    expect(graphStore.getState().language).toBe("zh-CN");
  });

  it("分析到达前以 graph 空态呈现但不写回 Store", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("graph-section--graph");
    expect(markup).toContain("滚轮缩放 · 拖动画布 · 选择节点查看资源");
    expect(markup).not.toContain("H1 呈现评估");
    expect(markup).not.toContain("Structured Flat List");
    expect(graphStore.getState().presentationMode).toBeNull();
  });

  it("compact 使用紧凑容器与对应提示且不自动选择 Node", () => {
    applyPresentationMode("compact");

    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("graph-section--compact");
    expect(markup).toContain("紧凑结果 · 选择节点查看资源");
    expect(graphStore.getState().selectedNodeId).toBeNull();
  });

  it("English Run 统一渲染正式 App、Graph 空态与 Resource Panel 文案", () => {
    graphStore.getState().startRun({
      runId: "run-english",
      query: "What is MySQL?",
      language: "en-US",
    });

    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("Current query");
    expect(markup).toContain("Searching");
    expect(markup).toContain("Search results");
    expect(markup).toContain("No search results to display yet.");
    expect(markup).toContain("Select a node");
    expect(markup).toContain('value="en-US"');
    expect(markup).not.toContain("搜索结果");
  });

  it("H1 Graph 条件固定探索式 Graph，避免 compact 成为额外实验变量", () => {
    applyPresentationMode("compact");
    graphStore.getState().setGraph(pythonResultGraphFixture.graph);

    const markup = renderToStaticMarkup(
      <App h1Evaluation={{ initialCondition: "graph" }} />,
    );

    expect(markup).toContain("graph-section--graph");
    expect(markup).toContain('data-presentation-mode="graph"');
    expect(markup).not.toContain("graph-section--compact");
  });

  it("H1 Flat 条件只替换左侧呈现，并复用同一 Store 与 Resource Panel", () => {
    graphStore.getState().setGraph(pythonResultGraphFixture.graph);
    graphStore.getState().selectNode("python-introduction");
    const nodesBefore = graphStore.getState().nodes;
    const edgesBefore = graphStore.getState().edges;
    const resourcesBefore = pythonResultGraphFixture.graph.nodes[0]?.resources;

    const markup = renderToStaticMarkup(
      <App
        h1Evaluation={{ initialCondition: "structured-flat-list" }}
      />,
    );

    expect(markup).toContain("H1 呈现评估");
    expect(markup).toContain(
      'data-evaluation-condition="structured-flat-list"',
    );
    expect(markup).toContain("Structured Flat List 搜索结果");
    expect(markup).toContain("Python Programming Language");
    expect(graphStore.getState().nodes).toBe(nodesBefore);
    expect(graphStore.getState().edges).toBe(edgesBefore);
    const firstNodeAfter = graphStore.getState().nodes[0];
    expect(
      firstNodeAfter !== undefined && "resources" in firstNodeAfter
        ? firstNodeAfter.resources
        : null,
    ).toBe(resourcesBefore);
  });
});
