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
import { H2EvaluationApp } from "./components/Evaluation/H2EvaluationApp.js";
import { resolveH1EvaluationRoute } from "./evaluation/h1-route.js";
import { resolveH2EvaluationRoute } from "./evaluation/h2-route.js";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("缺少 React 根容器 #root");
}

const h1Evaluation = resolveH1EvaluationRoute(window.location.search);
const h2Evaluation = resolveH2EvaluationRoute(window.location.search);

createRoot(rootElement).render(
  <StrictMode>
    {h2Evaluation === null ? (
      <App {...(h1Evaluation === null ? {} : { h1Evaluation })} />
    ) : (
      <H2EvaluationApp initialCondition={h2Evaluation.initialCondition} />
    )}
  </StrictMode>,
);
