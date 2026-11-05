/**
 * 测试职责：保持 H1 原实验的固定 Graph、共享数据、语言与只读工作区边界。
 * 迁移边界：旧产品壳已删除；正式产品由墨迹入口的浏览器回归覆盖。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamEventSchema } from "@wayfinder/contracts";

vi.mock("zustand", () => ({
  useStore: <State, Selected>(store: { getState: () => State }, selector: (state: State) => Selected): Selected => selector(store.getState()),
}));
import { H1EvaluationApp, resolveH1RenderLanguage } from "./H1EvaluationApp.js";
import { pythonResultGraphFixture } from "../../fixtures/python-result-graph.js";
import { graphStore } from "../../stores/graph-store.js";
import { workspaceStore } from "../../stores/workspace-store.js";

afterEach(() => { graphStore.getState().reset(); });

describe("H1 独立内部评估", () => {
  it("只在实验中锁定 Run 语言，尚无 Run 时使用当前选择", () => {
    expect(resolveH1RenderLanguage(null, "en-US")).toBe("en-US");
    expect(resolveH1RenderLanguage("zh-CN", "en-US")).toBe("zh-CN");
    expect(resolveH1RenderLanguage("en-US", "zh-CN")).toBe("en-US");
  });

  it("空态仍明确标注内部实验，不创建运行或读写保存的图", () => {
    const saved = workspaceStore.getState();
    const markup = renderToStaticMarkup(<H1EvaluationApp />);
    expect(markup).toContain("H1 呈现评估");
    expect(markup).toContain('class="graph-section graph-section--graph"');
    expect(markup).toContain('data-evaluation-condition="graph"');
    expect(markup).not.toContain("workspace-sidebar");
    expect(graphStore.getState().activeRunId).toBeNull();
    expect(workspaceStore.getState()).toBe(saved);
  });

  it("即使运行分析选择 compact，H1 Graph 条件仍固定探索图且不写回模式", () => {
    graphStore.getState().startRun({ runId: "run-mode", query: "模式样例", language: "zh-CN" });
    graphStore.getState().applyStreamEvent(StreamEventSchema.parse({
      runId: "run-mode", sequence: 1, protocolVersion: "0.1", timestamp: "2026-10-22T00:00:00.000Z", type: "query.analysis",
      data: { intent: "learn", topic: "模式样例", freshnessSensitive: false, ambiguityLevel: "low", presentationMode: "compact", broadSearchQueries: [], strategy: "plan_first" },
    }));
    graphStore.getState().setGraph(pythonResultGraphFixture.graph);
    const markup = renderToStaticMarkup(<H1EvaluationApp initialCondition="graph" />);
    expect(markup).toContain('data-presentation-mode="graph"');
    expect(markup).not.toContain("graph-section--compact");
    expect(graphStore.getState().presentationMode).toBe("compact");
  });

  it("Flat 条件只替换呈现，保留 Node、Edge、Resource 原引用与选中身份", () => {
    graphStore.getState().setGraph(pythonResultGraphFixture.graph);
    graphStore.getState().selectNode("python-introduction");
    const before = graphStore.getState();
    const resources = pythonResultGraphFixture.graph.nodes[0]?.resources;
    const markup = renderToStaticMarkup(<H1EvaluationApp initialCondition="structured-flat-list" />);
    expect(markup).toContain('data-evaluation-condition="structured-flat-list"');
    expect(markup).toContain("Structured Flat List 搜索结果");
    expect(markup).toContain("Python Programming Language");
    expect(graphStore.getState().nodes).toBe(before.nodes);
    expect(graphStore.getState().edges).toBe(before.edges);
    expect(graphStore.getState().selectedNodeId).toBe(before.selectedNodeId);
    const first = graphStore.getState().nodes[0];
    expect(first !== undefined && "resources" in first ? first.resources : null).toBe(resources);
  });

  it("English Run 保持原实验的统一文案与资源面板", () => {
    graphStore.getState().startRun({ runId: "run-english", query: "What is MySQL?", language: "en-US" });
    const markup = renderToStaticMarkup(<H1EvaluationApp />);
    expect(markup).toContain("Current query");
    expect(markup).toContain("Searching");
    expect(markup).toContain("Search results");
    expect(markup).toContain("No search results to display yet.");
    expect(markup).toContain("Select a node");
    expect(markup).toContain('value="en-US"');
  });
});
