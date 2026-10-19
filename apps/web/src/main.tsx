/**
 * 入口职责：把 React 应用挂载到 Vite 提供的浏览器页面。
 *
 * 失败路径：若 HTML 模板缺少 root 容器则立即失败，避免静默渲染空白页面。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";

import { App } from "./App.js";
import "./app.css";
import { pythonResultGraphFixture } from "./fixtures/python-result-graph.js";
import { graphStore } from "./stores/graph-store.js";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("缺少 React 根容器 #root");
}

/**
 * D1 Mock Product（模拟产品）在首屏挂载前一次性装入固定 Graph，确保 fitView 能读取完整节点。
 * 真实 Search Run 与 Streaming 接入属于后续 Issue，此处不制造伪异步流程。
 */
const mockGraphState = graphStore.getState();
mockGraphState.startRun({
  runId: pythonResultGraphFixture.runId,
  query: pythonResultGraphFixture.query.raw,
});
mockGraphState.setGraph(pythonResultGraphFixture.graph);
mockGraphState.finishRun();

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
