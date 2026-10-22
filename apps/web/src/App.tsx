/** 组件职责：组合统一 Omnibox、运行摘要、Graph 结果画布与当前节点的 Resource Panel。 */
import { useStore } from "zustand";

import { startStreamingSearch } from "./api/search.js";
import { GraphView } from "./components/Graph/GraphView.js";
import { Omnibox } from "./components/Omnibox/Omnibox.js";
import { ResourcePanel } from "./components/ResourcePanel/ResourcePanel.js";
import { graphStore } from "./stores/graph-store.js";

export function App() {
  const query = useStore(graphStore, state => state.query);
  const nodeCount = useStore(graphStore, state => state.nodes.length);
  const isSearching = useStore(graphStore, state => state.isSearching);
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

      <Omnibox startSearch={startStreamingSearch} />

      <section className="graph-section" aria-labelledby="graph-title">
        <div className="graph-section__header">
          <h2 id="graph-title">搜索结果</h2>
          <p>滚轮缩放 · 拖动画布 · 控件复位</p>
        </div>
        <div className="graph-workspace">
          <GraphView />
          <ResourcePanel />
        </div>
      </section>
    </main>
  );
}
