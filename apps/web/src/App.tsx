/** 组件职责：组合统一 Omnibox、运行摘要、Graph 结果画布与当前节点的 Resource Panel。 */
import { useStore } from "zustand";
import { useState } from "react";

import { startStreamingSearch } from "./api/search.js";
import { H1StructuredFlatList } from "./components/Evaluation/H1StructuredFlatList.js";
import { GraphView } from "./components/Graph/GraphView.js";
import { Omnibox } from "./components/Omnibox/Omnibox.js";
import { ResourcePanel } from "./components/ResourcePanel/ResourcePanel.js";
import {
  requestSafeUrlOpen,
  type BrowserUrlOpener,
} from "./lib/url.js";
import { graphStore } from "./stores/graph-store.js";
import type {
  H1EvaluationCondition,
  H1EvaluationRoute,
} from "./evaluation/h1-route.js";

/** window 只在 Direct 提交时读取，初始渲染与 AI Search 不会自动打开页面。 */
const openBrowserTab: BrowserUrlOpener = (url, target, features) =>
  window.open(url, target, features);

/** Direct 仍在最终副作用边界重复校验 URL，不能只信任 Omnibox 的路由结果。 */
const openDirectUrl = (url: string): boolean =>
  requestSafeUrlOpen(url, openBrowserTab);

export type AppProps = Readonly<{
  h1Evaluation?: H1EvaluationRoute;
}>;

export function App({ h1Evaluation }: AppProps = {}) {
  const query = useStore(graphStore, state => state.query);
  const storedPresentationMode = useStore(
    graphStore,
    state => state.presentationMode,
  );
  const nodeCount = useStore(graphStore, state => state.nodes.length);
  const isSearching = useStore(graphStore, state => state.isSearching);
  const [h1Condition, setH1Condition] = useState<H1EvaluationCondition>(
    h1Evaluation?.initialCondition ?? "graph",
  );
  const isH1Evaluation = h1Evaluation !== undefined;
  // Analysis 到达前沿用探索式空态；fallback 只影响视图，不写回 Store。
  const presentationMode = storedPresentationMode ?? "graph";
  // H1 必须固定 Graph 条件，避免 Planner compact 模式成为额外实验变量。
  const graphPresentationMode = isH1Evaluation ? "graph" : presentationMode;
  const searchStateLabel = isSearching
    ? "搜索中"
    : query.length > 0
      ? "已完成"
      : "待搜索";

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="app-header__intro">
          <p>Graph is the search result page</p>
          <h1>WayFinder</h1>
        </div>

        <dl className="app-summary" aria-label="搜索摘要">
          <div>
            <dt>当前查询</dt>
            <dd>{query || "尚未开始"}</dd>
          </div>
          <div>
            <dt>搜索状态</dt>
            <dd>{searchStateLabel}</dd>
          </div>
          <div>
            <dt>节点数量</dt>
            <dd>{nodeCount}</dd>
          </div>
        </dl>
      </header>

      <Omnibox
        startSearch={startStreamingSearch}
        openDirectUrl={openDirectUrl}
      />

      {isH1Evaluation ? (
        <section className="h1-evaluation" aria-labelledby="h1-evaluation-title">
          <div>
            <p className="h1-evaluation__eyebrow">Evaluation only</p>
            <h2 id="h1-evaluation-title">H1 呈现评估</h2>
            <p>两个条件共享同一份 Node、Edge、Resource 与 Resource Panel。</p>
          </div>
          <div className="h1-evaluation__conditions" role="group" aria-label="H1 呈现条件">
            <button
              type="button"
              aria-pressed={h1Condition === "graph"}
              onClick={() => setH1Condition("graph")}
            >
              Graph View
            </button>
            <button
              type="button"
              aria-pressed={h1Condition === "structured-flat-list"}
              onClick={() => setH1Condition("structured-flat-list")}
            >
              Structured Flat List
            </button>
          </div>
        </section>
      ) : null}

      <section
        className={`graph-section graph-section--${graphPresentationMode}`}
        aria-labelledby="graph-title"
      >
        <div className="graph-section__header">
          <h2 id="graph-title">搜索结果</h2>
          <p>
            {isH1Evaluation
              ? h1Condition === "graph"
                ? "H1 评估 · Graph View · 选择节点查看资源"
                : "H1 评估 · Structured Flat List · 选择节点查看资源"
              : presentationMode === "compact"
              ? "紧凑结果 · 选择节点查看资源"
              : "滚轮缩放 · 拖动画布 · 选择节点查看资源"}
          </p>
        </div>
        <div
          className={`graph-workspace${
            isH1Evaluation && h1Condition === "structured-flat-list"
              ? " graph-workspace--structured-flat-list"
              : ""
          }`}
          {...(isH1Evaluation
            ? { "data-evaluation-condition": h1Condition }
            : {})}
        >
          {isH1Evaluation && h1Condition === "structured-flat-list" ? (
            <H1StructuredFlatList />
          ) : (
            <GraphView presentationMode={graphPresentationMode} />
          )}
          <ResourcePanel />
        </div>
      </section>
    </main>
  );
}
