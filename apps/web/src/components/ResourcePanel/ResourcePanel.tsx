/**
 * 组件职责：展示当前选中 Node 的状态和可交付 Resource（资源），默认显示 Top 3，
 * 并在用户明确点击后展开本轮已经保留的其余结果。
 *
 * 边界：Show More 只改变本地视图，绝不触发第二次 Search；只有用户点击 Open 后
 * 才允许打开已重新校验的 HTTP(S) URL。
 */
import type {
  EditableNode,
  EditableResource,
  Resource,
  SearchLanguage,
  StreamNodeStatus,
} from "@wayfinder/contracts";
import { useState } from "react";
import { useStore } from "zustand";

import { getMessages, type Messages } from "../../i18n/messages.js";
import {
  graphStore,
  selectSelectedNode,
  type GraphStoreNode,
} from "../../stores/graph-store.js";
import {
  requestSafeUrlOpen,
  resolveSafeHttpUrl,
  type BrowserUrlOpener,
} from "../../lib/url.js";

type UnselectedPanelModel = {
  kind: "unselected";
  language: SearchLanguage;
};

type SelectedPanelModel = {
  kind: "selected";
  language: SearchLanguage;
  nodeId: string;
  nodeTitle: string;
  nodeStatus: StreamNodeStatus | EditableNode["status"];
  nodeStatusLabel: string;
  resources: readonly (Resource | EditableResource)[];
  outcomeNotice: OutcomeNotice | null;
  emptyMessage: string | null;
};

type OutcomeNotice = Readonly<{
  kind: "warning" | "error";
  title: string;
  messages: readonly string[];
}>;

export type ResourcePanelModel =
  | UnselectedPanelModel
  | SelectedPanelModel;

/**
 * 只依据判别联合中的终态字段构造提示，不从 Resource 数量反向猜测状态。
 * Warning 与 Error 只暴露公共 Contract 的安全语义，底层 Provider 诊断不得进入 UI。
 */
const buildOutcomeNotice = (
  node: GraphStoreNode | EditableNode,
  messages: Messages["resourcePanel"],
): OutcomeNotice | null => {
  if (node.status === "partial") {
    return {
      kind: "warning",
      title: messages.partialTitle,
      messages: node.warnings.map(code => messages.warningMessages[code]),
    };
  }

  if (node.status === "failed" && node.error !== undefined) {
    return {
      kind: "error",
      title: messages.failedTitle,
      messages: [messages.errorMessages[node.error.code]],
    };
  }

  return null;
};

/**
 * Store 中也可能存在尚未完成的 GraphPlan Node，因此先通过字段收窄再读取 resources。
 * failed Node 按 Contract 必须保留空数组，面板仍展示状态而不是把选择误判为空。
 */
export const buildResourcePanelModel = (
  node: GraphStoreNode | EditableNode | null,
  language: SearchLanguage = "zh-CN",
): ResourcePanelModel => {
  const messages = getMessages(language);

  if (node === null) {
    return { kind: "unselected", language };
  }

  const resources = "resources" in node ? node.resources : [];
  const outcomeNotice = buildOutcomeNotice(node, messages.resourcePanel);
  const emptyMessage =
    resources.length > 0 || outcomeNotice?.kind === "error"
      ? null
      : node.status === "empty" || node.status === "edited"
        ? messages.resourcePanel.emptyNode
        : messages.resourcePanel.processing;

  return {
    kind: "selected",
    language,
    nodeId: node.id,
    nodeTitle: node.title,
    nodeStatus: node.status,
    nodeStatusLabel: messages.graph.statusLabels[node.status],
    resources,
    outcomeNotice,
    emptyMessage,
  };
};

/** sourceType 是 Provider 归一化后的稳定字符串；仅替换分隔符改善可读性，不猜测业务语义。 */
const formatSourceType = (sourceType: string): string =>
  sourceType.replaceAll("_", " ");

/** window 只在点击回调执行时读取，服务端渲染与初始渲染不会自动打开页面。 */
const openBrowserTab: BrowserUrlOpener = (url, target, features) =>
  window.open(url, target, features);

const DEFAULT_VISIBLE_RESOURCE_COUNT = 3;

/** 纯函数冻结默认 Top 3 与本地展开语义；返回值始终保持 retained 排序。 */
export function selectVisibleResources(
  resources: readonly (Resource | EditableResource)[],
  expanded: boolean,
): readonly (Resource | EditableResource)[] {
  return expanded
    ? resources
    : resources.slice(0, DEFAULT_VISIBLE_RESOURCE_COUNT);
}

function SelectedResourcePanel({
  model,
  openResource,
}: {
  model: SelectedPanelModel;
  openResource: BrowserUrlOpener;
}) {
  const [expanded, setExpanded] = useState(false);
  const messages = getMessages(model.language).resourcePanel;
  const visibleResources = selectVisibleResources(model.resources, expanded);
  const hiddenResourceCount = model.resources.length - visibleResources.length;

  return (
    <aside
      className="resource-panel"
      aria-labelledby="resource-panel-title"
      aria-live="polite"
    >
      <header className="resource-panel__header">
        <p className="resource-panel__eyebrow">{messages.selectedNode}</p>
        <div className="resource-panel__title-row">
          <h2 id="resource-panel-title">{model.nodeTitle}</h2>
          <span
            className={`resource-panel__status resource-panel__status--${model.nodeStatus}`}
          >
            {model.nodeStatusLabel}
          </span>
        </div>
        <p>{messages.resourceCount(model.resources.length)}</p>
      </header>

      {model.outcomeNotice === null ? null : (
        <section
          className={`resource-panel__outcome resource-panel__outcome--${model.outcomeNotice.kind}`}
          role={model.outcomeNotice.kind === "error" ? "alert" : "status"}
        >
          <h3>{model.outcomeNotice.title}</h3>
          <ul>
            {model.outcomeNotice.messages.map(message => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </section>
      )}

      {model.resources.length === 0 ? (
        model.emptyMessage === null ? null : (
          <p className="resource-panel__notice" role="status">
            {model.emptyMessage}
          </p>
        )
      ) : (
        <>
          <div
            className="resource-list"
            role="list"
            aria-label={messages.resourceListAria}
          >
            {visibleResources.map(resource => {
              const safeUrl = resolveSafeHttpUrl(resource.url);

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
                      <dt>{messages.domain}</dt>
                      <dd>{resource.domain}</dd>
                    </div>
                    <div>
                      <dt>{messages.sourceType}</dt>
                      <dd>{formatSourceType(resource.sourceType)}</dd>
                    </div>
                  </dl>

                  <section aria-labelledby={`${resource.id}-summary`}>
                    <h4 id={`${resource.id}-summary`}>{messages.aiSummary}</h4>
                    <p>{resource.summary}</p>
                  </section>

                  <section aria-labelledby={`${resource.id}-why-selected`}>
                    <h4 id={`${resource.id}-why-selected`}>
                      {messages.whySelected}
                    </h4>
                    <p>{resource.whySelected}</p>
                  </section>

                  <footer className="resource-card__actions">
                    <button
                      type="button"
                      disabled={safeUrl === null}
                      aria-label={messages.openAria(resource.title)}
                      onClick={() =>
                        requestSafeUrlOpen(resource.url, openResource)
                      }
                    >
                      {messages.open}
                    </button>
                    {safeUrl === null ? (
                      <p role="status">{messages.invalidUrl}</p>
                    ) : null}
                  </footer>
                </article>
              );
            })}
          </div>
          {hiddenResourceCount > 0 ? (
            <button
              className="resource-panel__show-more"
              type="button"
              onClick={() => setExpanded(true)}
            >
              {messages.showMore(hiddenResourceCount)}
            </button>
          ) : null}
        </>
      )}
    </aside>
  );
}

/** 纯展示入口支持注入 opener；key 变化会重建选中面板并重置展开状态。 */
export function ResourcePanelView({
  model,
  openResource = openBrowserTab,
}: {
  model: ResourcePanelModel;
  openResource?: BrowserUrlOpener;
}) {
  if (model.kind === "unselected") {
    const messages = getMessages(model.language).resourcePanel;

    return (
      <aside className="resource-panel resource-panel--empty" aria-live="polite">
        <div>
          <p className="resource-panel__eyebrow">{messages.panelName}</p>
          <h2>{messages.chooseNode}</h2>
          <p>{messages.chooseNodeHint}</p>
        </div>
      </aside>
    );
  }

  return (
    <SelectedResourcePanel
      key={model.nodeId}
      model={model}
      openResource={openResource}
    />
  );
}

/** 容器组件只负责订阅当前选择，避免展示层直接依赖 Store 动作。 */
export function ResourcePanel({ language, node }: {
  language: SearchLanguage;
  node?: GraphStoreNode | EditableNode | null;
}) {
  const runNode = useStore(graphStore, selectSelectedNode);
  const selectedNode = node === undefined ? runNode : node;

  return (
    <ResourcePanelView
      model={buildResourcePanelModel(selectedNode, language)}
    />
  );
}
