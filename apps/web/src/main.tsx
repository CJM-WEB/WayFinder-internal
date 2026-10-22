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

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("缺少 React 根容器 #root");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
