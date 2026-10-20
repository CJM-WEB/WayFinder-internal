/**
 * 组件职责：展示当前选中 Node 的状态和可交付 Resource（资源）。
 *
 * WAY-32 边界：只有用户点击 Open 后才允许打开已重新校验的 HTTP(S) URL。
 */
import type { Resource, StreamNodeStatus } from "@wayfinder/contracts";
import { useStore } from "zustand";

import { NODE_STATUS_LABELS } from "../Graph/graph-labels.js";
import {
  graphStore,
  selectSelectedNode,
  type GraphStoreNode,
} from "../../stores/graph-store.js";
import {
  requestResourceOpen,
  resolveSafeResourceUrl,
  type ResourceUrlOpener,
} from "./resource-url.js";

type UnselectedPanelModel = {
  kind: "unselected";
};

type SelectedPanelModel = {
  kind: "selected";
  nodeTitle: string;
  nodeStatus: StreamNodeStatus;
  nodeStatusLabel: string;
  resources: readonly Resource[];
  emptyMessage: string | null;
};

export type ResourcePanelModel =
  | UnselectedPanelModel
  | SelectedPanelModel;

/**
 * Store 中也可能存在尚未完成的 GraphPlan Node，因此先通过字段收窄再读取 resources。
 * failed Node 按 Contract 必须保留空数组，面板仍展示状态而不是把选择误判为空。
 */
export const buildResourcePanelModel = (
  node: GraphStoreNode | null,
): ResourcePanelModel => {
  if (node === null) {
    return { kind: "unselected" };
  }

  const resources = "resources" in node ? node.resources : [];
  const emptyMessage =
    resources.length > 0
      ? null
      : node.status === "failed"
        ? "该节点检索失败，暂无可展示的资源。"
        : "该节点仍在处理，资源准备完成后将在此显示。";

  return {
    kind: "selected",
    nodeTitle: node.title,
    nodeStatus: node.status,
    nodeStatusLabel: NODE_STATUS_LABELS[node.status],
    resources,
    emptyMessage,
  };
};

/** sourceType 是 Provider 归一化后的稳定字符串；仅替换分隔符改善可读性，不猜测业务语义。 */
const formatSourceType = (sourceType: string): string =>
  sourceType.replaceAll("_", " ");

/** window 只在点击回调执行时读取，服务端渲染与初始渲染不会自动打开页面。 */
const openBrowserTab: ResourceUrlOpener = (url, target, features) =>
  window.open(url, target, features);

/** 纯展示组件支持注入 opener，便于验证渲染不会产生浏览器副作用。 */
export function ResourcePanelView({
  model,
  openResource = openBrowserTab,
}: {
  model: ResourcePanelModel;
  openResource?: ResourceUrlOpener;
}) {
  if (model.kind === "unselected") {
    return (
      <aside className="resource-panel resource-panel--empty" aria-live="polite">
        <div>
          <p className="resource-panel__eyebrow">Resource Panel</p>
          <h2>选择一个节点</h2>
          <p>你可以自由查看任意节点，不必沿箭头顺序浏览。</p>
        </div>
      </aside>
    );
  }

  return (
    <aside
      className="resource-panel"
      aria-labelledby="resource-panel-title"
      aria-live="polite"
    >
      <header className="resource-panel__header">
        <p className="resource-panel__eyebrow">Selected Node</p>
        <div className="resource-panel__title-row">
          <h2 id="resource-panel-title">{model.nodeTitle}</h2>
          <span
            className={`resource-panel__status resource-panel__status--${model.nodeStatus}`}
          >
            {model.nodeStatusLabel}
          </span>
        </div>
        <p>{model.resources.length} 条可用资源</p>
      </header>

      {model.resources.length === 0 ? (
        <p className="resource-panel__notice">{model.emptyMessage}</p>
      ) : (
        <div className="resource-list" role="list" aria-label="节点资源">
          {model.resources.map(resource => {
            const safeUrl = resolveSafeResourceUrl(resource.url);

            return (
              <article
                className="resource-card"
                role="listitem"
                key={resource.id}
              >
                <header className="resource-card__header">
                  <span className="resource-card__rank">#{resource.rank}</span>
                  <h3>{resource.title}</h3>
                </header>

                <dl className="resource-card__meta">
                  <div>
                    <dt>域名</dt>
                    <dd>{resource.domain}</dd>
                  </div>
                  <div>
                    <dt>来源类型</dt>
                    <dd>{formatSourceType(resource.sourceType)}</dd>
                  </div>
                </dl>

                <section aria-labelledby={`${resource.id}-summary`}>
                  <h4 id={`${resource.id}-summary`}>AI 摘要</h4>
                  <p>{resource.summary}</p>
                </section>

                <section aria-labelledby={`${resource.id}-why-selected`}>
                  <h4 id={`${resource.id}-why-selected`}>入选原因</h4>
                  <p>{resource.whySelected}</p>
                </section>

                <footer className="resource-card__actions">
                  <button
                    type="button"
                    disabled={safeUrl === null}
                    aria-label={`在新标签页打开 ${resource.title}`}
                    onClick={() =>
                      requestResourceOpen(resource.url, openResource)
                    }
                  >
                    Open
                  </button>
                  {safeUrl === null ? (
                    <p role="status">链接不可用：仅支持有效的 HTTP(S) 地址。</p>
                  ) : null}
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </aside>
  );
}

/** 容器组件只负责订阅当前选择，避免展示层直接依赖 Store 动作。 */
export function ResourcePanel() {
  const selectedNode = useStore(graphStore, selectSelectedNode);

  return (
    <ResourcePanelView model={buildResourcePanelModel(selectedNode)} />
  );
}
