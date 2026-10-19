/**
 * 组件职责：提供 WAY-27 的最小 React UI shell，并证明组件能够订阅 Graph store。
 *
 * 范围边界：Graph 绘制、Mock 数据、Node 交互和 Resource Panel 由后续 Issue 实现。
 */
import { useStore } from "zustand";

import { graphStore, selectSelectedNode } from "./stores/graph-store.js";

export function App() {
  const query = useStore(graphStore, state => state.query);
  const nodeCount = useStore(graphStore, state => state.nodes.length);
  const isSearching = useStore(graphStore, state => state.isSearching);
  const selectedNode = useStore(graphStore, selectSelectedNode);

  const searchStateLabel = isSearching ? "搜索中" : "空闲";

  return (
    <main>
      <header>
        <h1>WayFinder</h1>
        <p>Graph is the search result page.</p>
      </header>

      <section aria-labelledby="graph-shell-title">
        <h2 id="graph-shell-title">Graph Shell</h2>
        <dl>
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
          <div>
            <dt>选中节点</dt>
            <dd>{selectedNode?.title ?? "未选择"}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
