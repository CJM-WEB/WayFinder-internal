/**
 * 入口职责：把 React 应用挂载到 Vite 提供的浏览器页面。
 *
 * 失败路径：若 HTML 模板缺少 root 容器则立即失败，避免静默渲染空白页面。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";

import { App } from "./App.js";
import { initializeWorkspacePersistence } from "./stores/workspace-persistence.js";
import "./app.css";
import { H2EvaluationApp } from "./components/Evaluation/H2EvaluationApp.js";
import { resolveH1EvaluationRoute } from "./evaluation/h1-route.js";
import { resolveH2EvaluationRoute } from "./evaluation/h2-route.js";
import { resolveEntryLanguage } from "./i18n/entry-language.js";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("缺少 React 根容器 #root");
}

const h1Evaluation = resolveH1EvaluationRoute(window.location.search);
const h2Evaluation = resolveH2EvaluationRoute(window.location.search);
// 仅正常产品入口接收展示页的语言偏好，内部评估条件不受其影响。
const initialLanguage = h1Evaluation === null && h2Evaluation === null
  ? resolveEntryLanguage(window.location.search)
  : null;

// 先完成读取再允许编辑，防止空初始状态覆盖上一次保存的图；评估页不接入个人记录。
if (h1Evaluation === null && h2Evaluation === null) {
  await initializeWorkspacePersistence();
}

createRoot(rootElement).render(
  <StrictMode>
    {h2Evaluation === null ? (
      <App workspaceEnabled={h1Evaluation === null}
        {...(h1Evaluation === null ? {} : { h1Evaluation })}
        {...(initialLanguage === null ? {} : { initialLanguage })} />
    ) : (
      <H2EvaluationApp initialCondition={h2Evaluation.initialCondition} />
    )}
  </StrictMode>,
);
