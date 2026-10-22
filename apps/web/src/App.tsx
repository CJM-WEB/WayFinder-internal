/** 组件职责：组合统一 Omnibox、运行摘要、Graph 结果画布与当前节点的 Resource Panel。 */
import { useStore } from "zustand";

import { startStreamingSearch } from "./api/search.js";
import { GraphView } from "./components/Graph/GraphView.js";
import { Omnibox } from "./components/Omnibox/Omnibox.js";
import { ResourcePanel } from "./components/ResourcePanel/ResourcePanel.js";
import {
  requestSafeUrlOpen,
  type BrowserUrlOpener,
} from "./lib/url.js";
import { graphStore } from "./stores/graph-store.js";

/** window 只在 Direct 提交时读取，初始渲染与 AI Search 不会自动打开页面。 */
const openBrowserTab: BrowserUrlOpener = (url, target, features) =>
  window.open(url, target, features);

/** Direct 仍在最终副作用边界重复校验 URL，不能只信任 Omnibox 的路由结果。 */
const openDirectUrl = (url: string): boolean =>
  requestSafeUrlOpen(url, openBrowserTab);

export function App() {
  const query = useStore(graphStore, state => state.query);
  const storedPresentationMode = useStore(
    graphStore,
    state => state.presentationMode,
  );
  const nodeCount = useStore(graphStore, state => state.nodes.length);
  const isSearching = useStore(graphStore, state => state.isSearching);
  // Analysis 到达前沿用探索式空态；fallback 只影响视图，不写回 Store。
  const presentationMode = storedPresentationMode ?? "graph";
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

      <section
        className={`graph-section graph-section--${presentationMode}`}
        aria-labelledby="graph-title"
      >
        <div className="graph-section__header">
          <h2 id="graph-title">搜索结果</h2>
          <p>
            {presentationMode === "compact"
              ? "紧凑结果 · 选择节点查看资源"
              : "滚轮缩放 · 拖动画布 · 选择节点查看资源"}
          </p>
        </div>
        <div className="graph-workspace">
          <GraphView presentationMode={presentationMode} />
          <ResourcePanel />
        </div>
      </section>
    </main>
  );
}
