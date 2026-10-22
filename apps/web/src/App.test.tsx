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

import { App } from "./App.js";
import { graphStore } from "./stores/graph-store.js";

const applyPresentationMode = (presentationMode: PresentationMode): void => {
  graphStore.getState().startRun({ runId: "run-mode", query: "测试模式" });
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
  it("分析到达前以 graph 空态呈现但不写回 Store", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("graph-section--graph");
    expect(markup).toContain("滚轮缩放 · 拖动画布 · 选择节点查看资源");
    expect(graphStore.getState().presentationMode).toBeNull();
  });

  it("compact 使用紧凑容器与对应提示且不自动选择 Node", () => {
    applyPresentationMode("compact");

    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain("graph-section--compact");
    expect(markup).toContain("紧凑结果 · 选择节点查看资源");
    expect(graphStore.getState().selectedNodeId).toBeNull();
  });
});
