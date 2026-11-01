/** 组件职责：组合统一 Omnibox、运行摘要、Graph 结果画布与当前节点的 Resource Panel。 */
import { useStore } from "zustand";
import { useEffect, useState } from "react";
import { resolveSearchEngine, type SearchEngine, type EditableGraph, type SearchLanguage } from "@wayfinder/contracts";

import { startStreamingSearch } from "./api/search.js";
import { researchStore } from "./api/research.js";
import { WorkspaceResearchPreview } from "./components/Workspace/WorkspaceResearchPreview.js";
import { startWorkspaceSearch } from "./api/workspace-search.js";
import { WorkspaceEdgeEditor } from "./components/Workspace/WorkspaceEdgeEditor.js";
import { WorkspaceToolbar } from "./components/Workspace/WorkspaceEditor.js";
import { WorkspaceSidebar } from "./components/Workspace/WorkspaceSidebar.js";
import { selectCurrentGraph, workspaceStore } from "./stores/workspace-store.js";
import { workspacePersistenceStore } from "./stores/workspace-persistence.js";
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
  workspaceEnabled?: boolean;
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

const EMPTY_GRAPH: Pick<EditableGraph, "nodes" | "edges" | "positions"> = {
  nodes: [], edges: [], positions: {},
};

export function App({ h1Evaluation, workspaceEnabled = false }: AppProps = {}) {
  const runtime = useStore(graphStore, state => state);
  const currentDocument = useStore(workspaceStore, selectCurrentGraph);
  const preview = useStore(researchStore, state => state.preview);
  const researchInputError = useStore(researchStore, state => state.inputError);
  const persistence = useStore(workspacePersistenceStore, state => state);
  const useWorkspace = workspaceEnabled && h1Evaluation === undefined;
  // 只有所属记录展示运行草图；后台完成仅保存自己的图，不能把用户切换抢回来。
  const showsRun = useWorkspace && currentDocument !== null &&
    currentDocument.lastRunId === runtime.activeRunId && runtime.isSearching;
  const query = useWorkspace ? currentDocument?.query ?? "" : runtime.query;
  const storedPresentationMode = useWorkspace && !showsRun ? currentDocument?.presentationMode ?? null : runtime.presentationMode;
  const nodeCount = useWorkspace && !showsRun ? currentDocument?.nodes.length ?? 0 : runtime.nodes.length;
  const isSearching = useWorkspace ? showsRun : runtime.isSearching;
  const runLanguage = useWorkspace ? currentDocument?.language ?? null : runtime.language;
  const [selectedLanguage, setSelectedLanguage] =
    useState<SearchLanguage>(runLanguage ?? "zh-CN");
  const [emptyPageEngine, setEmptyPageEngine] = useState<SearchEngine | undefined>();
  // 空页偏好只属于尚未建立记录的下一次搜索；有图缺少偏好时必须回到语言默认，便于撤销。
  const selectedEngine = resolveSearchEngine(selectedLanguage, currentDocument === null ? emptyPageEngine : currentDocument.engine);
  const chooseEngine = (engine: SearchEngine): void => {
    const state = workspaceStore.getState();
    const graph = selectCurrentGraph(state);
    if (!useWorkspace) return;
    if (graph === null) setEmptyPageEngine(engine);
    else if (graph.engine !== engine) state.replaceGraph({ ...graph, engine, updatedAt: new Date().toISOString() });
  };
  const chooseLanguage = (language: SearchLanguage): void => {
    setSelectedLanguage(language);
    // 语言选择确定下一次搜索默认引擎；用户随后仍可独立覆盖，不改既有图的语言或资源来源。
    chooseEngine(resolveSearchEngine(language));
  };
  const selections = useStore(workspaceStore, state => state.selectedNodeIds);
  const selectSavedNode = useStore(workspaceStore, state => state.selectNode);
  const savedGraph = useWorkspace && !showsRun ? currentDocument ?? EMPTY_GRAPH : undefined;
  const selectedNodeId = currentDocument === null ? null : selections[currentDocument.id] !== undefined
    ? selections[currentDocument.id]
    : currentDocument.lastRunId === runtime.activeRunId
      ? runtime.selectedNodeId
      : currentDocument.presentationMode === "compact"
        ? currentDocument.nodes.find(node => node.status === "ready" || node.status === "partial")?.id ?? null
        : null;
  const selectedNode = savedGraph?.nodes.find(node => node.id === selectedNodeId) ?? null;
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
    : query.length > 0 || (useWorkspace && currentDocument !== null && currentDocument.lastRunId !== null)
      ? "complete"
      : "idle";

  // 离开所属图或删除目标即取消临时请求，不能把迟到结果带入另一个记录。
  useEffect(() => {
    if (!useWorkspace || preview === null) return;
    if (currentDocument?.id !== preview.graphId || (preview.nodeId !== null &&
        !currentDocument.nodes.some(node => node.id === preview.nodeId))) researchStore.getState().cancel();
  }, [useWorkspace, currentDocument?.id, currentDocument?.nodes, preview?.graphId, preview?.nodeId]);

  /** lang 属性与实际可见文案共用 renderLanguage，供浏览器和辅助技术正确识别语言。 */
  useEffect(() => {
    applyDocumentLanguage(document.documentElement, renderLanguage);
  }, [renderLanguage]);

  return (
    <main className={`app-shell${useWorkspace ? " app-shell--workspace" : ""}`}>
      {useWorkspace ? <WorkspaceSidebar language={renderLanguage} /> : null}
      <div className="workspace-main">
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

      <fieldset className="workspace-search-controls" disabled={useWorkspace && (persistence.status === "loading" || persistence.error === "load")}>
      <Omnibox
        startSearch={useWorkspace ? input => {
          researchStore.getState().cancel();
          return startWorkspaceSearch(input);
        } : startStreamingSearch}
        openDirectUrl={openDirectUrl}
        language={selectedLanguage}
        renderLanguage={renderLanguage}
        onLanguageChange={chooseLanguage}
        {...(useWorkspace ? { engine: selectedEngine, onEngineChange: chooseEngine } : {})}
      />
      </fieldset>
      {useWorkspace ? <WorkspaceToolbar language={renderLanguage} disabled={showsRun || persistence.status === "loading" || persistence.error === "load"} /> : null}

      {useWorkspace && researchInputError !== null ? <p role="alert" className="workspace-edit-error">
        {researchInputError === "target" ? messages.research.missingTarget : messages.research.invalidInput}
      </p> : null}
      {useWorkspace && !showsRun && currentDocument !== null ? <WorkspaceEdgeEditor
        key={currentDocument.id} graphId={currentDocument.id} language={renderLanguage}
        disabled={persistence.status === "loading" || persistence.error === "load"}
      /> : null}

      {useWorkspace && preview !== null && preview.graphId === currentDocument?.id ? <WorkspaceResearchPreview
        key={preview.runId ?? "pending"} language={renderLanguage}
      /> : null}

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
              : useWorkspace && currentDocument !== null && !showsRun
                ? messages.editor.graphInstructions
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
              key={`graph-${useWorkspace ? currentDocument?.id ?? "empty" : "run"}`}
              presentationMode={graphPresentationMode}
              language={renderLanguage}
              {...(savedGraph === undefined ? {} : {
                graph: savedGraph, selectedNodeId: selectedNodeId ?? null, onSelectNode: selectSavedNode,
                ...(currentDocument === null || persistence.error === "load" ? {} : { editableGraphId: currentDocument.id }),
              })}
            />
          )}
          <ResourcePanel key={`panel-${useWorkspace ? currentDocument?.id ?? "empty" : "run"}`} language={renderLanguage} {...(savedGraph === undefined ? {} : { node: selectedNode, ...(currentDocument === null ? {} : { editableGraphId: currentDocument.id }) })} />
        </div>
      </section>
      </div>
    </main>
  );
}
