/**
 * 入口职责：正式根页面只挂载墨迹漫游，内部评估由合法 Query（查询参数）按需隔离加载。
 *
 * 生命周期：先恢复浏览器工作区，再允许正式页面编辑；评估不读取或改写个人记录。
 * 失败路径：缺少 root 容器立即失败；存储读取失败仍交给新版现有提示与重试处理。
 */
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { resolveH1EvaluationRoute } from "./evaluation/h1-route.js";
import { resolveH2EvaluationRoute } from "./evaluation/h2-route.js";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("缺少 React 根容器 #root");
}

const h1Evaluation = resolveH1EvaluationRoute(window.location.search);
const h2Evaluation = resolveH2EvaluationRoute(window.location.search);
let page: ReactNode;

// 评估保持原有实验条件，代码和样式只在显式内部入口加载，不能把旧产品壳带回正式首页。
if (h2Evaluation !== null) {
  const [{ H2EvaluationApp }] = await Promise.all([
    import("./components/Evaluation/H2EvaluationApp.js"),
    import("./components/Evaluation/evaluation.css"),
  ]);
  page = <H2EvaluationApp initialCondition={h2Evaluation.initialCondition} />;
} else if (h1Evaluation !== null) {
  const [{ H1EvaluationApp }] = await Promise.all([
    import("./components/Evaluation/H1EvaluationApp.js"),
    import("./components/Evaluation/evaluation.css"),
    import("@xyflow/react/dist/style.css"),
  ]);
  page = <H1EvaluationApp initialCondition={h1Evaluation.initialCondition} />;
} else {
  const [{ default: InkApp }, { initializeWorkspacePersistence }] = await Promise.all([
    import("./design/ink-study.js"),
    import("./stores/workspace-persistence.js"),
  ]);
  await initializeWorkspacePersistence();
  page = <InkApp />;
}

createRoot(rootElement).render(<StrictMode>{page}</StrictMode>);
