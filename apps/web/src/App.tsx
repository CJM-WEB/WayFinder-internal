/** 组件职责：组合统一 Omnibox、运行摘要、Graph 结果画布与当前节点的 Resource Panel。 */
import { useStore } from "zustand";
import { useEffect, useState } from "react";
import type { SearchLanguage } from "@wayfinder/contracts";

import { startStreamingSearch } from "./api/search.js";
import { H1StructuredFlatList } from "./components/Evaluation/H1StructuredFlatList.js";
import { GraphView } from "./components/Graph/GraphView.js";
import { Omnibox } from "./components/Omnibox/Omnibox.js";
import { ResourcePanel } from "./components/ResourcePanel/ResourcePanel.js";
import { getMessages } from "./i18n/messages.js";
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

/**
 * 已开始的 Run 锁定整页展示语言；选择器只决定下一次搜索。
 * 没有 Run 时才直接预览选择语言，避免旧结果与新静态文案组成混合语言页面。
 */
export const resolveRenderLanguage = (
  runLanguage: SearchLanguage | null,
  selectedLanguage: SearchLanguage,
): SearchLanguage => runLanguage ?? selectedLanguage;

/** 独立纯边界便于验证 HTML 根节点语言，不要求测试环境提供完整浏览器 DOM。 */
export const applyDocumentLanguage = (
  documentElement: { lang: string },
  language: SearchLanguage,
): void => {
  documentElement.lang = language;
};

export function App({ h1Evaluation }: AppProps = {}) {
  const query = useStore(graphStore, state => state.query);
  const storedPresentationMode = useStore(
    graphStore,
    state => state.presentationMode,
  );
  const nodeCount = useStore(graphStore, state => state.nodes.length);
  const isSearching = useStore(graphStore, state => state.isSearching);
  const runLanguage = useStore(graphStore, state => state.language);
  const [selectedLanguage, setSelectedLanguage] =
    useState<SearchLanguage>(runLanguage ?? "zh-CN");
  const [h1Condition, setH1Condition] = useState<H1EvaluationCondition>(
    h1Evaluation?.initialCondition ?? "graph",
  );
  const isH1Evaluation = h1Evaluation !== undefined;
  // Analysis 到达前沿用探索式空态；fallback 只影响视图，不写回 Store。
  const presentationMode = storedPresentationMode ?? "graph";
  // H1 必须固定 Graph 条件，避免 Planner compact 模式成为额外实验变量。
  const graphPresentationMode = isH1Evaluation ? "graph" : presentationMode;
  const renderLanguage = resolveRenderLanguage(
    runLanguage,
    selectedLanguage,
  );
  const messages = getMessages(renderLanguage);
  const searchState = isSearching
    ? "searching"
    : query.length > 0
      ? "complete"
      : "idle";

  /** lang 属性与实际可见文案共用 renderLanguage，供浏览器和辅助技术正确识别语言。 */
  useEffect(() => {
    applyDocumentLanguage(document.documentElement, renderLanguage);
  }, [renderLanguage]);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="app-header__intro">
          <p>{messages.app.slogan}</p>
          <h1>WayFinder</h1>
        </div>

        <dl className="app-summary" aria-label={messages.app.summaryAria}>
          <div>
            <dt>{messages.app.currentQuery}</dt>
            <dd>{query || messages.app.notStarted}</dd>
          </div>
          <div>
            <dt>{messages.app.searchStatus}</dt>
            <dd>{messages.app.searchState[searchState]}</dd>
          </div>
          <div>
            <dt>{messages.app.nodeCount}</dt>
            <dd>{nodeCount}</dd>
          </div>
        </dl>
      </header>

      <Omnibox
        startSearch={startStreamingSearch}
        openDirectUrl={openDirectUrl}
        language={selectedLanguage}
        renderLanguage={renderLanguage}
        onLanguageChange={setSelectedLanguage}
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
          <h2 id="graph-title">{messages.app.searchResults}</h2>
          <p>
            {isH1Evaluation
              ? h1Condition === "graph"
                ? "H1 评估 · Graph View · 选择节点查看资源"
                : "H1 评估 · Structured Flat List · 选择节点查看资源"
              : messages.app.resultInstructions[presentationMode]}
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
            <GraphView
              presentationMode={graphPresentationMode}
              language={renderLanguage}
            />
          )}
          <ResourcePanel language={renderLanguage} />
        </div>
      </section>
    </main>
  );
}
