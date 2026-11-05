/**
 * 页面职责：承载 WayFinder 正式前端“墨迹漫游”，复用项目现有 React 与 Vite。
 * 复用边界：新界面直接使用既有搜索协调器和状态层，不跳转旧展示页，不复制后端协议。
 */
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { XYPosition } from "@xyflow/react";
import { resolveSearchEngine, SearchEngineSchema, type SearchEngine, type SearchLanguage } from "@wayfinder/contracts";

import { resolveEntryLanguage } from "../i18n/entry-language.js";
import { getMessages } from "../i18n/messages.js";
import { createInkReveal, type InkRevealController, type InkTransferEvent } from "./ink-reveal.js";
import { InkSearchHistory } from "./ink-search-history.js";
import type { InkScene } from "./ink-graph-motion.js";
import { startOmniboxSubmission, type InvalidOmniboxInputReason } from "../lib/omnibox-submission.js";
import { requestSafeUrlOpen } from "../lib/url.js";
import { useStore } from "zustand";
import type { StreamingSearch } from "../api/search.js";
import { graphStore } from "../stores/graph-store.js";
import { buildGraphNodeData } from "../components/Graph/graph-labels.js";
import type { GraphNodeData } from "../components/Graph/graph-layout.js";
import type { GraphContextRequest, GraphEditProblem } from "../components/Graph/GraphView.js";
import type { InkActionTarget } from "./ink-workspace-actions.js";
import { InkNotice } from "./ink-notice.js";
import { selectCurrentGraph, workspaceStore } from "../stores/workspace-store.js";
import { moveNode } from "../stores/workspace-edits.js";
import { workspacePersistenceStore } from "../stores/workspace-persistence.js";
import "./ink-study.css";
import "./ink-workspace.css";

const AUTHOR_EMAIL = "cjmweb@outlook.com";
const InkGraph = lazy(() => import("./ink-graph.js"));
const InkResources = lazy(() => import("./ink-resources.js"));
const InkWorkspaceActions = lazy(() => import("./ink-workspace-actions.js"));
const InkResearchPreview = lazy(() => import("./ink-research-preview.js"));
type NodePositions = Readonly<Record<string, XYPosition>>;
type DraftLayout = Readonly<{ runId: string; positions: NodePositions }>;
type LabelTransfer = Readonly<{
  graphId: string; generation: number; moving: boolean;
  labels: Readonly<Record<string, GraphNodeData>>;
}>;
const EMPTY_LABELS: Readonly<Record<string, GraphNodeData>> = {};
// 空图也保持依赖身份稳定，打开控件不能触发一次无意义的场景刷新。
const EMPTY_NODES = [] as const;
const EMPTY_EDGES = [] as const;

export default function InkApp() {
  const stage = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const ink = useRef<InkRevealController | null>(null);
  const searchShell = useRef<HTMLFormElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const graphHost = useRef<HTMLDivElement>(null);
  const loadingStartedAt = useRef(0);
  const exploreButton = useRef<HTMLButtonElement>(null);
  const restoreSearchFocus = useRef(false);
  const restoreHomeFocus = useRef(false);
  const languageControl = useRef<HTMLDivElement>(null);
  const languageButton = useRef<HTMLButtonElement>(null);
  const engineControl = useRef<HTMLDivElement>(null);
  const engineButton = useRef<HTMLButtonElement>(null);
  const latestSubmission = useRef(0);
  const latestSearchIntent = useRef(0);
  const ownedRun = useRef<string | null>(null);
  const searchCoordinator = useRef<StreamingSearch | null>(null);
  const runtime = useStore(graphStore, state => state);
  const currentDocument = useStore(workspaceStore, selectCurrentGraph);
  const documents = useStore(workspaceStore, state => state.documents);
  const selectedNodes = useStore(workspaceStore, state => state.selectedNodeIds);
  const [draftLayouts, setDraftLayouts] = useState<Readonly<Record<string, DraftLayout>>>({});
  const [labelTransfer, setLabelTransfer] = useState<LabelTransfer | null>(null);
  const labelTransferRef = useRef<LabelTransfer | null>(null);
  const visualScene = useRef<InkScene>({ kind: "pointer" });
  const awaitingTransfer = useRef(false);
  const paintedLabels = useRef<Readonly<Record<string, GraphNodeData>>>(EMPTY_LABELS);
  const targetLabels = useRef<Readonly<Record<string, GraphNodeData>>>(EMPTY_LABELS);
  const [animateRunId, setAnimateRunId] = useState<string | null>(null);
  const [showEmptyRecord, setShowEmptyRecord] = useState(false);
  const historySelectionIntent = useRef(0);
  const persistence = useStore(workspacePersistenceStore, state => state);
  const [feedback, setFeedback] = useState<InvalidOmniboxInputReason | "input_failure" | "search_failure" | "graph_failure" | "panel_failure" | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [pendingSearch, setPendingSearch] = useState(false);
  const [openControl, setOpenControl] = useState<"language" | "engine" | null>(null);
  const languageOpen = openControl === "language";
  const engineOpen = openControl === "engine";
  const [engineOverride, setEngineOverride] = useState<SearchEngine>();
  const [phase, setPhase] = useState<"intro" | "morphing" | "ready" | "returning">("intro");
  const entered = phase === "morphing" || phase === "ready";
  const ready = phase === "ready";
  const [historyOpen, setHistoryOpen] = useState(false);
  const [undoOpen, setUndoOpen] = useState(false);
  const [resourcesMounted, setResourcesMounted] = useState(false);
  const [actionsMounted, setActionsMounted] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [actionTarget, setActionTarget] = useState<InkActionTarget | null>(null);
  const [graphProblem, setGraphProblem] = useState<GraphEditProblem>(null);
  const contextIntent = useRef(0);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [language, setLanguage] = useState<SearchLanguage>(
    () => resolveEntryLanguage(window.location.search) ?? "zh-CN",
  );
  // 界面语言即时切换；文档和请求的生成语言、已生成标题说明均保持原始内容。
  const renderLanguage = language;
  const messages = getMessages(renderLanguage);
  const storageBlocked = persistence.status === "loading" || persistence.error === "load";
  const engine = resolveSearchEngine(language, engineOverride);
  const isCurrentRun = currentDocument !== null && runtime.activeRunId !== null && currentDocument.lastRunId === runtime.activeRunId;
  // 完成图从持久文档恢复；未完成/已取消的真实草图仍取原运行，不能把草图伪装成已完成文档。
  const showsDraft = isCurrentRun && runtime.nodes.length > 0 &&
    (runtime.isSearching || (!runtime.hasCompleted && currentDocument.nodes.length === 0));
  const displayedNodes = showsDraft ? runtime.nodes : currentDocument?.nodes ?? EMPTY_NODES;
  const displayedEdges = showsDraft ? runtime.edges : currentDocument?.edges ?? EMPTY_EDGES;
  const nodeLabels = useMemo(() => Object.fromEntries(displayedNodes.map(node => [node.id, buildGraphNodeData(node, renderLanguage)])), [displayedNodes, renderLanguage]);
  // 完成交接沿用原工作区选择规则：没有人工保存选择时保留本 Run 的节点，避免切源时来回清选。
  const displayedSelection = currentDocument === null ? null : selectedNodes[currentDocument.id] !== undefined
    ? selectedNodes[currentDocument.id] ?? null
    : isCurrentRun ? runtime.selectedNodeId
    : currentDocument.presentationMode === "compact"
      ? currentDocument.nodes.find(node => node.status === "ready" || node.status === "partial")?.id ?? null : null;
  const currentDraft = currentDocument === null ? undefined : draftLayouts[currentDocument.id];
  const displayedPositions = useMemo(() => ({ ...currentDocument?.positions,
    ...(currentDraft?.runId === currentDocument?.lastRunId ? currentDraft?.positions : {}),
  }), [currentDocument?.positions, currentDocument?.lastRunId, currentDraft]);
  // 首页隐藏图层；每次开始探索清空选择，历史图仅在主动选择记录后展示。
  const searchState = !entered ? "input" : pendingSearch ? "loading"
    : currentDocument !== null && (displayedNodes.length > 0 ||
      // 已交付后被编辑/撤销为空仍是工作图，不能复活runtime，也不能把重做入口锁在输入态。
      (!(isCurrentRun && runtime.isSearching) && (showEmptyRecord || currentDocument.lastRunId === null || !isCurrentRun || runtime.hasCompleted))) ? "graph"
    : isCurrentRun && runtime.isSearching ? "loading" : "input";
  const acceptsInput = ready && searchState === "input";
  const drawerOpen = historyOpen || undoOpen;
  const movingGraph = labelTransfer?.graphId === currentDocument?.id && labelTransfer?.moving === true;
  const canEdit = ready && searchState === "graph" && !showsDraft && !pendingSearch &&
    !(isCurrentRun && runtime.isSearching) && !storageBlocked && !movingGraph && !drawerOpen && !researchOpen;
  const canCreate = ready && searchState === "input" && !pendingSearch && !storageBlocked && !drawerOpen && !researchOpen;
  const resourceNode = displayedNodes.find(node => node.id === displayedSelection) ?? null;
  const resourcesVisible = searchState === "graph" && !drawerOpen && !movingGraph && !researchOpen && resourceNode !== null;
  const closeResources = useCallback(() => {
    if (showsDraft) graphStore.getState().selectNode(null);
    else workspaceStore.getState().selectNode(null);
  }, [showsDraft]);
  useEffect(() => {
    if (!resourcesVisible || resourcesMounted) return;
    let cancelled = false;
    // 只在首次需要资源时加载；模块失败保留图，不能让新的覆盖层把整页带成空白。
    void import("./ink-resources.js").then(() => { if (!cancelled) setResourcesMounted(true); })
      .catch(() => { if (!cancelled) setFeedback("panel_failure"); });
    return () => { cancelled = true; };
  }, [resourcesVisible, resourcesMounted, resourceNode?.id, currentDocument?.id]);
  const closeActions = useCallback(() => { ++contextIntent.current; setActionTarget(null); }, []);
  const showActions = useCallback(async (request: InkActionTarget): Promise<void> => {
    const intent = ++contextIntent.current;
    try {
      // 菜单与预览一起准备就绪，再允许启动重搜，避免请求已开始却缺少取消入口。
      await Promise.all([import("./ink-workspace-actions.js"), import("./ink-research-preview.js"), import("./ink-graph.js")]);
      if (contextIntent.current !== intent) return;
      setActionsMounted(true); setActionTarget(request);
    } catch { if (contextIntent.current === intent) setFeedback("panel_failure"); }
  }, []);
  const graphContext = useCallback((request: GraphContextRequest): void => {
    if (request.kind !== "node") closeResources();
    else if (showsDraft) graphStore.getState().selectNode(request.nodeId);
    else workspaceStore.getState().selectNode(request.nodeId);
    void showActions({ ...request, graphId: currentDocument?.id ?? null });
  }, [closeResources, showsDraft, currentDocument?.id, showActions]);
  useEffect(() => { closeActions(); setGraphProblem(null); }, [currentDocument?.id, closeActions]);
  const graphNotice = useMemo(() => graphProblem === null || !canEdit ? null : ({ message: graphProblem.message,
    ...(graphProblem.nodeId === null ? {} : { action: <button className="ink-study__pill" onClick={() => workspaceStore.getState().selectNode(graphProblem.nodeId)}>{messages.editor.locateDuplicate}</button> }),
  }), [graphProblem, canEdit, messages.editor.locateDuplicate]);
  useEffect(() => {
    if (!resourcesVisible) return;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // 上层菜单/表单先处理自己的退出，不能让资源的全局监听抢走同一次 Esc。
      if (event.target instanceof Element && event.target.closest("[data-ink-overlay]") !== null &&
          event.target.closest(".ink-resources") === null) return;
      event.preventDefault();
      closeResources();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [resourcesVisible, closeResources]);
  const feedbackMessage = feedback === null ? null
    : feedback === "query" ? messages.omnibox.invalidQuery
    : feedback === "invalid_url" ? messages.omnibox.invalidUrl
    : feedback === "unsupported_protocol" ? messages.omnibox.unsupportedProtocol
    : feedback === "graph_failure" ? messages.inkStudy.graphLoadFailed
    : feedback === "panel_failure" ? messages.inkStudy.panelLoadFailed
    : feedback === "search_failure" ? messages.inkStudy.searchFailed : messages.omnibox.inputFailure;
  const searchMessage = feedbackMessage ?? (entered && isCurrentRun && runtime.runError !== null
    ? messages.inkStudy.searchFailed : null);

  const submitSearch = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!acceptsInput || drawerOpen || storageBlocked) return;
    const submissionNumber = ++latestSubmission.current;
    try {
      // 只替换提交界面：协议校验、取消旧请求、流式事件和图记录保存均继续走既有实现。
      const submission = startOmniboxSubmission(searchInput.current?.value ?? "", async input => {
        // 仅真实搜索才加载既有协调器及其图布局依赖；后来的提交或卸载可撤销尚未发出的请求。
        const intent = ++latestSearchIntent.current;
        loadingStartedAt.current = performance.now();
        setPendingSearch(true);
        setHasSearched(false);
        setShowEmptyRecord(false);
        setOpenControl(null);
        // 图模块同样在发请求前预加载；网络或 CSS 加载失败沿提交错误路径恢复输入，避免计划到达后整页空白。
        const [{ startWorkspaceSearch }] = await Promise.all([
          import("../api/workspace-search.js"), import("./ink-graph.js"),
        ]);
        // 非法输入或 Direct 只改变反馈，不能取消之前已经确认的有效搜索意图。
        if (latestSearchIntent.current !== intent) return;
        searchCoordinator.current = startWorkspaceSearch;
        setPendingSearch(false);
        setHasSearched(true);
        const completion = startWorkspaceSearch(input);
        ownedRun.current = graphStore.getState().activeRunId;
        setAnimateRunId(ownedRun.current);
        return completion;
      }, url => requestSafeUrlOpen(url, (safeUrl, target, features) => window.open(safeUrl, target, features)), language, engine);
      if (submission.kind === "invalid") { setFeedback(submission.reason); return; }
      setFeedback(null);
      if (submission.kind === "direct" && searchInput.current !== null) searchInput.current.value = submission.url;
      if (submission.kind === "ai_search") {
        if (searchInput.current !== null) searchInput.current.value = submission.query;
        void submission.completion.catch(() => {
          if (latestSubmission.current === submissionNumber) {
            setPendingSearch(false);
            setFeedback("search_failure");
          }
        });
      }
    } catch {
      setFeedback("input_failure");
    }
  };

  /** 呈现事务独立于工作区：真实图立即选中，旧字按GPU同一配对跟随，到位后才换目标文案。 */
  const onTransfer = useCallback((event: InkTransferEvent): void => {
    const current = visualScene.current;
    if (current.kind !== "graph" || current.graphId === undefined || current.graphId !== event.graphId) return;
    if (event.kind === "start") {
      const labels: Record<string, GraphNodeData> = {};
      for (const pair of event.pairs) {
        const source = paintedLabels.current[pair.sourceId];
        if (source !== undefined) labels[pair.targetId] = source;
      }
      const next = { graphId: current.graphId, generation: event.generation, moving: true, labels };
      labelTransferRef.current = next;
      awaitingTransfer.current = false;
      // 快速A→B→C的源是B位置上仍在显示的A文字，而不是尚未出现的B目标文案。
      paintedLabels.current = labels;
      setLabelTransfer(next);
    } else {
      const previous = labelTransferRef.current;
      if (previous?.graphId !== event.graphId || previous.generation !== event.generation) return;
      const next = { ...previous, moving: false, labels: EMPTY_LABELS };
      labelTransferRef.current = next;
      paintedLabels.current = targetLabels.current;
      awaitingTransfer.current = false;
      setLabelTransfer(next);
    }
  }, []);

  const setInkScene = useCallback((scene: InkScene): void => {
    const previous = visualScene.current;
    const changed = scene.kind !== previous.kind || (scene.kind === "graph" && previous.kind === "graph" &&
      (scene.graphId !== previous.graphId || scene.startedAt !== previous.startedAt || scene.nodes !== previous.nodes || scene.branches !== previous.branches));
    visualScene.current = scene;
    targetLabels.current = nodeLabels;
    if (scene.kind !== "graph") {
      awaitingTransfer.current = false;
      paintedLabels.current = EMPTY_LABELS;
      // 回程仍用最后一帧旧字淡出；旧complete已被scene所有权挡住，不会中途替换成目标字。
    } else if (changed && scene.resume && ink.current !== null && scene.graphId !== undefined) {
      awaitingTransfer.current = true;
      const next = { graphId: scene.graphId, generation: -1, moving: true, labels: EMPTY_LABELS };
      labelTransferRef.current = next;
      setLabelTransfer(next);
    } else if (changed && (!scene.resume || ink.current === null)) {
      awaitingTransfer.current = false;
      paintedLabels.current = nodeLabels;
      labelTransferRef.current = null;
      setLabelTransfer(null);
    }
    ink.current?.setScene(scene);
  }, [nodeLabels]);

  useLayoutEffect(() => {
    targetLabels.current = nodeLabels;
    if (currentDocument === null || visualScene.current.kind !== "graph" || visualScene.current.graphId !== currentDocument.id || awaitingTransfer.current) return;
    const transfer = labelTransfer?.graphId === currentDocument.id ? labelTransfer : null;
    // 尚未到位的新分裂节点没有可见旧字；快切也不能把它隐藏的目标字当成下一轮源快照。
    const labels = transfer?.moving ? transfer.labels : nodeLabels;
    paintedLabels.current = Object.fromEntries(Object.entries(labels).map(([id, data]) => [id, { ...data, language: renderLanguage }]));
  }, [nodeLabels, labelTransfer, currentDocument?.id, renderLanguage]);

  /** 运行中只能暂存位置；完成文档已含真实节点后，再以同一 graphId/runId 承接坐标。 */
  useEffect(() => {
    const remaining: Record<string, DraftLayout> = {};
    let changed = false;
    for (const [graphId, draft] of Object.entries(draftLayouts)) {
      const document = workspaceStore.getState().documents.find(item => item.id === graphId);
      if (document === undefined || document.lastRunId !== draft.runId) { changed = true; continue; }
      if (document.nodes.length === 0) { remaining[graphId] = draft; continue; }
      let next = document;
      for (const [nodeId, position] of Object.entries(draft.positions)) {
        if (document.nodes.some(node => node.id === nodeId)) next = moveNode(next, nodeId, position);
      }
      workspaceStore.getState().replaceGraph(next);
      changed = true;
    }
    if (changed) setDraftLayouts(remaining);
  }, [documents, draftLayouts]);

  const moveDisplayedNode = useCallback((nodeId: string, position: XYPosition): void => {
    if (currentDocument === null) return;
    const state = workspaceStore.getState();
    const document = state.documents.find(item => item.id === currentDocument.id);
    if (document === undefined) return;
    if (document.nodes.some(node => node.id === nodeId)) state.replaceGraph(moveNode(document, nodeId, position));
    else if (document.lastRunId !== null && document.lastRunId === runtime.activeRunId && runtime.nodes.some(node => node.id === nodeId)) {
      const runId = document.lastRunId;
      setDraftLayouts(previous => {
        const layout = previous[document.id];
        const positions = layout?.runId === runId ? layout.positions : {};
        if (positions[nodeId]?.x === position.x && positions[nodeId]?.y === position.y) return previous;
        return { ...previous, [document.id]: { runId, positions: { ...positions, [nodeId]: position } } };
      });
    }
  }, [currentDocument?.id, runtime.activeRunId, runtime.nodes]);

  useEffect(() => {
    if (searchState === "input") setInkScene({ kind: "pointer" });
    if (searchState === "loading") setInkScene({ kind: "loading", startedAt: loadingStartedAt.current });
    // graph 的屏幕坐标由已挂载的原 GraphView 提供，按需模块就绪前保持加载墨迹。
  }, [searchState, setInkScene]);

  useEffect(() => {
    // 焦点只响应搜索阶段变化；文案/资源同步不能抢走菜单或用户正在操作的控件焦点。
    if (drawerOpen) return;
    const active = document.activeElement;
    if (active !== document.body && !searchShell.current?.contains(active) && !engineControl.current?.contains(active)) return;
    if (searchState === "loading") stopButton.current?.focus({ preventScroll: true });
    else if (searchState === "graph") graphHost.current?.focus({ preventScroll: true });
    else if (ready) searchInput.current?.focus({ preventScroll: true });
  }, [searchState]);

  useEffect(() => {
    // 焦点在变形完成后进入输入框；减弱动态时也要主动重绘文字的新位置。
    ink.current?.refreshTextPosition();
    if (ready && searchState === "input") searchInput.current?.focus({ preventScroll: true });
    if (phase === "intro" && restoreHomeFocus.current) {
      restoreHomeFocus.current = false;
      exploreButton.current?.focus({ preventScroll: true });
    }
  }, [ready, entered, phase]);

  useLayoutEffect(() => {
    // 语言可能在搜索层发生变化；始终用当前文案的实际宽度作为胶囊回程终点。
    if ((phase === "intro" || phase === "returning") && searchShell.current !== null && exploreButton.current !== null) {
      searchShell.current.style.setProperty("--ink-entry-width", `${exploreButton.current.offsetWidth + 2}px`);
    }
  }, [phase, messages.inkStudy.explore]);

  const closeHistory = useCallback((restoreFocus: boolean): void => {
    restoreSearchFocus.current = restoreFocus;
    setHistoryOpen(false);
  }, []);

  const openHistory = useCallback((): void => {
    setOpenControl(null);
    setUndoOpen(false);
    closeActions();
    setHistoryOpen(true);
  }, [closeActions]);
  const openUndo = useCallback((): void => {
    setOpenControl(null); setHistoryOpen(false); closeActions(); setUndoOpen(true);
  }, [closeActions]);
  const closeUndo = useCallback((restoreFocus: boolean): void => {
    restoreSearchFocus.current = restoreFocus; setUndoOpen(false);
  }, []);

  useEffect(() => {
    if (!drawerOpen && ready && restoreSearchFocus.current) {
      restoreSearchFocus.current = false;
      if (searchState === "input") searchInput.current?.focus({ preventScroll: true });
      else if (searchState === "loading") stopButton.current?.focus({ preventScroll: true });
      else stage.current?.querySelector<HTMLButtonElement>(".ink-study__history-toggle")?.focus({ preventScroll: true });
    }
  }, [drawerOpen, ready, searchState]);

  /** 重置本页搜索意图：新建与返回首页共用取消门禁，不清空已保存图。 */
  const resetSearch = (): void => {
    ++latestSubmission.current;
    ++latestSearchIntent.current;
    if (ownedRun.current !== null && graphStore.getState().activeRunId === ownedRun.current) searchCoordinator.current?.cancel();
    ownedRun.current = null;
    setPendingSearch(false);
    setFeedback(null);
    setHasSearched(false);
    setAnimateRunId(null);
    setUndoOpen(false); closeActions();
  };

  const stopSearch = (): void => {
    resetSearch();
    ++historySelectionIntent.current;
    setShowEmptyRecord(false);
    restoreSearchFocus.current = true;
  };

  const newSearch = (): void => {
    if (!ready || storageBlocked) return;
    resetSearch();
    ++historySelectionIntent.current;
    setShowEmptyRecord(false);
    setDraftLayouts({});
    workspaceStore.getState().selectGraph(null);
    if (searchInput.current !== null) searchInput.current.value = "";
    closeHistory(true);
  };

  const returnHome = (): void => {
    resetSearch();
    ++historySelectionIntent.current;
    restoreHomeFocus.current = true;
    restoreSearchFocus.current = false;
    setHistoryOpen(false);
    setOpenControl(null);
    setPhase("returning");
  };

  const restoreHistory = async (graphId: string): Promise<void> => {
    if (storageBlocked) return;
    const intent = ++historySelectionIntent.current;
    try {
      // 冷启动也先加载显示模块；失败时保留原图与原记录，不让 lazy 抛到整页。
      await import("./ink-graph.js");
      if (historySelectionIntent.current !== intent) return;
      const document = workspaceStore.getState().documents.find(item => item.id === graphId);
      if (document === undefined) return;
      // 已在查看同一图时只合上历史，不重置入场时钟或提前揭示尚在生长的节点。
      if (workspaceStore.getState().currentId === graphId && !pendingSearch && searchState !== "input") {
        setFeedback(null);
        closeHistory(true);
        return;
      }
      // 选择历史撤销尚未发出的新查询；已经运行的旧图仍可在后台完成自己的保存。
      ++latestSubmission.current;
      ++latestSearchIntent.current;
      setPendingSearch(false);
      workspaceStore.getState().selectGraph(graphId);
      setShowEmptyRecord(true);
      setAnimateRunId(null);
      setHasSearched(false);
      setFeedback(null);
      closeHistory(true);
    } catch {
      if (historySelectionIntent.current !== intent) return;
      setFeedback("graph_failure");
      closeHistory(true);
    }
  };

  useEffect(() => {
    if (phase !== "morphing" && phase !== "returning") return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finishWithoutMotion = (): void => { if (motion.matches) setPhase(phase === "morphing" ? "ready" : "intro"); };
    // 兼容进入前或过渡中切换系统偏好，不能等待已被取消的 transitionend。
    finishWithoutMotion();
    motion.addEventListener("change", finishWithoutMotion);
    return () => motion.removeEventListener("change", finishWithoutMotion);
  }, [phase]);

  const beginExploring = (): void => {
    if (phase !== "intro") return;
    const shell = searchShell.current;
    if (shell === null) return;
    // 入口只重置当前浏览意图，不删除文档、人工布局或撤销历史；旧图由历史入口主动恢复。
    resetSearch();
    ++historySelectionIntent.current;
    setShowEmptyRecord(false);
    workspaceStore.getState().selectGraph(null);
    if (searchInput.current !== null) searchInput.current.value = "";
    // 将自适应文案宽度冻结为当前像素宽，再过渡到百分比宽度，避免 auto 无法平滑插值。
    shell.style.setProperty("--ink-entry-width", `${shell.getBoundingClientRect().width}px`);
    void shell.offsetWidth;
    setPhase("morphing");
  };

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = window.setTimeout(() => setCopyStatus("idle"), 2400);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  const copyEmail = async (): Promise<void> => {
    setCopyStatus("idle");
    try {
      // 只在人员点击后写入邮箱；权限或安全上下文不满足时明确反馈，不假报成功。
      await navigator.clipboard.writeText(AUTHOR_EMAIL);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  useEffect(() => {
    if (openControl === null) return;
    const control = openControl === "language" ? languageControl : engineControl;
    // 展开层只监听存续期间的外部点击；键盘移出与 Esc 则由控件自身收起。
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !control.current?.contains(event.target)) {
        setOpenControl(null);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [openControl]);

  useEffect(() => {
    if (canvas.current === null || stage.current === null || heading.current === null) return;
    const effect = createInkReveal(canvas.current, stage.current, heading.current, onTransfer);
    ink.current = effect;

    // WebGL 不可用时仍保留标题与探索入口；系统减弱动态偏好由渲染器处理。
    return () => {
      effect?.destroy();
      ink.current = null;
      ++latestSubmission.current;
      ++latestSearchIntent.current;
      ++historySelectionIntent.current;
      // 只取消本页发起且仍拥有的请求，沿用协调器的 AbortSignal 和迟到事件门禁。
      if (ownedRun.current !== null && graphStore.getState().activeRunId === ownedRun.current) searchCoordinator.current?.cancel();
    };
  }, [onTransfer]);

  useEffect(() => {
    // 展示页语言与进入搜索的初值共用同一受校验值，不增加后端语言设置接口。
    document.documentElement.lang = renderLanguage;
    document.title = messages.inkStudy.pageTitle;
  }, [renderLanguage, messages.inkStudy.pageTitle]);

  return (
    <main className="ink-study">
      <section className="ink-study__stage" id="ink-stage" ref={stage}
        data-layer={entered ? "explore" : "intro"} data-search-ready={ready} data-history-open={drawerOpen} data-search-state={searchState}
        onPointerDownCapture={event => {
          // 普通点击也撤销尚未完成的右键模块加载，不能在用户已移到别处后弹出旧菜单。
          if (event.button === 0 && event.target instanceof Element && event.target.closest("[data-ink-overlay]") === null) closeActions();
        }}
        onClick={event => {
          if (!(event.target instanceof Element) || event.defaultPrevented || event.target.closest("[data-ink-overlay]")) return;
          closeActions();
          if (event.target.closest("[data-ink-node], .react-flow")) return;
          if (resourcesVisible) closeResources();
        }}
        onContextMenu={event => {
          if (!canCreate || event.defaultPrevented || !(event.target instanceof Element) || event.target.closest("button, a, input, textarea, [data-ink-overlay]")) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          void showActions({ kind: "pane", graphId: currentDocument?.id ?? null, clientPoint: { x: event.clientX, y: event.clientY },
            flowPoint: { x: event.clientX - bounds.left - 120, y: event.clientY - bounds.top - 56 } });
        }}
        aria-label={messages.inkStudy.stageAria}>
        <h1 className="ink-study__wordmark" ref={heading}>WAYFINDER</h1>
        <canvas className="ink-study__canvas" ref={canvas} aria-hidden="true" />
        <p className="ink-study__tagline">{messages.inkStudy.tagline}</p>

        <header className="ink-study__intro" inert={phase !== "intro"} aria-hidden={phase !== "intro"}>
          <p className="ink-study__statement">{messages.inkStudy.statement}</p>
        </header>

        {/* 同一胶囊先移动伸展，再分裂提交与引擎入口；进入展示态或更换选项均不会搜索。 */}
        <div className="ink-study__search-layer" inert={drawerOpen} aria-hidden={drawerOpen}>
        <form className="ink-study__search" ref={searchShell} data-ink-control
          aria-label={messages.omnibox.formAria} onSubmit={submitSearch}
          onTransitionEnd={event => {
            if (event.target === event.currentTarget && event.propertyName === "width" && phase === "morphing") {
              setPhase("ready");
            }
            if (event.target === event.currentTarget && event.propertyName === "width" && phase === "returning") {
              setPhase("intro");
            }
          }}>
          <div className="ink-study__search-input-shell">
            <button type="button" className="ink-study__pill ink-study__explore" ref={exploreButton}
              inert={phase !== "intro"} aria-hidden={phase !== "intro"}
              onClick={beginExploring}>
              {messages.inkStudy.explore} <span aria-hidden="true">↗</span>
            </button>
            <input type="search" className="ink-study__search-input" ref={searchInput}
              inert={!acceptsInput} aria-hidden={!acceptsInput} aria-label={messages.omnibox.queryLabel}
              aria-describedby={searchMessage === null ? undefined : "ink-search-feedback"}
              onInput={() => setFeedback(null)}
              placeholder={messages.omnibox.queryLabel} />
          </div>
          <button type="submit" className="ink-study__pill ink-study__search-submit" disabled={!acceptsInput || storageBlocked}
            inert={!acceptsInput} aria-hidden={!acceptsInput} aria-label={messages.omnibox.searchButton}>
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 12h15m-6-6 6 6-6 6" />
            </svg>
          </button>
          <button type="button" className="ink-study__pill ink-study__search-stop" ref={stopButton}
            inert={searchState !== "loading"} aria-hidden={searchState !== "loading"}
            aria-label={messages.workspace.cancel} onClick={stopSearch}>
            <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="4" /></svg>
          </button>
        </form>

        <div className="ink-study__engine" ref={engineControl} data-ink-control inert={!acceptsInput} aria-hidden={!acceptsInput}
          onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpenControl(null); }}
          onKeyDown={event => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setOpenControl(null);
            engineButton.current?.focus();
          }}>
          <button type="button" className="ink-study__pill" ref={engineButton}
            aria-label={`${messages.searchEngine.label}：${messages.searchEngine.labels[engine]}`}
            aria-expanded={engineOpen} aria-controls="ink-engine-options"
            onClick={() => setOpenControl(open => open === "engine" ? null : "engine")}>
            <span>{messages.searchEngine.labels[engine]}</span>
            <svg className="ink-study__chevron" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path d="m1 1 4 4 4-4" /></svg>
          </button>
          {engineOpen ? <div className="ink-study__language-options ink-study__engine-options" id="ink-engine-options"
            role="group" aria-label={messages.searchEngine.label}>
            {SearchEngineSchema.options.map(option => <button type="button" key={option} aria-pressed={engine === option}
              onClick={() => {
                setEngineOverride(option);
                setOpenControl(null);
                engineButton.current?.focus();
              }}>
              <span>{messages.searchEngine.labels[option]}</span><span aria-hidden="true">{engine === option ? "✓" : ""}</span>
            </button>)}
            {/* 沿用原引擎选择的地区说明，不能因替换展示而暗示百度支持指定国家定位。 */}
            <p className="ink-engine-note" role="note">{messages.searchEngine.baiduRegionNotice}</p>
          </div> : null}
        </div>
        <div className="ink-study__search-status" data-ink-control>
          {entered && (hasSearched || searchState === "graph" || (isCurrentRun && runtime.isSearching)) ? <div className="ink-study__run-status">
            <span role="status">{isCurrentRun && runtime.isSearching ? messages.app.searchState.searching : `${messages.app.nodeCount} ${displayedNodes.length}`}</span>
          </div> : null}
          {searchMessage === null ? null : <p className="ink-study__search-feedback" id="ink-search-feedback" role="alert">{searchMessage}</p>}
          {persistence.error === null ? null : <div className="ink-study__storage-error" role="alert">
            <span>{persistence.error === "load" ? messages.workspace.loadFailure : messages.workspace.saveFailure}</span>
            <button type="button" className="ink-study__pill" onClick={() => { void persistence.retry(); }}>{messages.workspace.retry}</button>
          </div>}
        </div>
        </div>

        {/* 回程只短暂保留文字层淡出；真实选中图与坐标不因墨迹融合而重置。 */}
        {(searchState === "graph" || (phase === "returning" && displayedNodes.length > 0)) && currentDocument !== null ? <div className="ink-study__graph" ref={graphHost} tabIndex={-1}
          inert={drawerOpen || researchOpen || searchState !== "graph"} aria-hidden={drawerOpen || researchOpen || searchState !== "graph"}
          data-returning={phase === "returning"} data-resuming={!(isCurrentRun && animateRunId === runtime.activeRunId)}
          data-ink-graph-id={currentDocument.id} data-ink-control>
          <Suspense fallback={null}>
            <InkGraph key={currentDocument.id} graphId={currentDocument.id} nodes={displayedNodes} edges={displayedEdges} positions={displayedPositions}
              presentationMode={showsDraft ? runtime.presentationMode ?? currentDocument.presentationMode : currentDocument.presentationMode}
              language={renderLanguage} onScene={setInkScene} onMoveNode={moveDisplayedNode}
              selectedNodeId={displayedSelection}
              onSelectNode={showsDraft ? graphStore.getState().selectNode : workspaceStore.getState().selectNode}
              animate={isCurrentRun && animateRunId === runtime.activeRunId} active={searchState === "graph"}
              onPaneClick={closeResources}
              {...(canEdit && currentDocument !== null ? { editableGraphId: currentDocument.id } : {})}
              onContextRequest={graphContext} onInteractionStart={closeActions} onEditProblem={setGraphProblem}
              transferMoving={labelTransfer?.graphId === currentDocument.id && labelTransfer.moving}
              labelSnapshots={labelTransfer?.graphId === currentDocument.id ? labelTransfer.labels : EMPTY_LABELS} />
          </Suspense>
        </div> : null}
        {resourcesMounted ? <Suspense fallback={null}><InkResources graphId={currentDocument?.id ?? null}
          node={resourceNode} language={renderLanguage} visible={resourcesVisible} editable={canEdit} onClose={closeResources}
          onResourceContext={(resourceId, clientPoint) => {
            if (resourceNode !== null) void showActions({ kind: "resource", graphId: currentDocument?.id ?? null,
              nodeId: resourceNode.id, resourceId, clientPoint });
          }} /></Suspense> : null}
        {actionsMounted ? <Suspense fallback={null}><InkWorkspaceActions target={actionTarget} language={renderLanguage}
          enabled={canEdit} allowCreate={canCreate} active={entered && !drawerOpen && !researchOpen} onClose={closeActions} />
          <InkResearchPreview language={renderLanguage} active={entered} suspended={drawerOpen} onVisibilityChange={setResearchOpen} />
        </Suspense> : null}
        <InkNotice notice={graphNotice} />

        <button type="button" className="ink-study__pill ink-study__back" onClick={returnHome}
          inert={!entered} aria-hidden={!entered} aria-label={messages.inkStudy.backHome}>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 12H5m6-6-6 6 6 6" />
          </svg>
        </button>

        <InkSearchHistory open={historyOpen} available={ready} language={renderLanguage}
          undoOpen={undoOpen} undoDisabled={storageBlocked || showsDraft || pendingSearch || movingGraph || researchOpen || (isCurrentRun && runtime.isSearching)}
          onOpenUndo={openUndo} onCloseUndo={closeUndo}
          onOpen={openHistory} onClose={closeHistory} onNewSearch={newSearch} onSelectGraph={restoreHistory} />

        {/* 披露面板使用普通按钮与自然 Tab 顺序，避免模拟系统下拉框或改变语言协议。 */}
        <div className="ink-study__language" ref={languageControl} data-ink-control
          onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget)) setOpenControl(null);
          }}
          onKeyDown={event => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setOpenControl(null);
            languageButton.current?.focus();
          }}>
          <button type="button" className="ink-study__pill" ref={languageButton}
            aria-label={messages.omnibox.languageLabel} aria-expanded={languageOpen}
            aria-controls="ink-language-options" onClick={() => setOpenControl(open => open === "language" ? null : "language")}>
            <span>language</span>
            <svg className="ink-study__chevron" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
              <path d="m1 1 4 4 4-4" />
            </svg>
          </button>
          {languageOpen && (
            <div className="ink-study__language-options" id="ink-language-options" role="group"
              aria-label={messages.omnibox.languageLabel}>
              {(["zh-CN", "en-US"] as const).map(option => (
                <button type="button" key={option} aria-pressed={language === option}
                  onClick={() => {
                    setLanguage(option);
                    setEngineOverride(undefined);
                    setOpenControl(null);
                    languageButton.current?.focus();
                  }}>
                  <span>{messages.omnibox.languageOptions[option]}</span>
                  <span aria-hidden="true">{language === option ? "✓" : ""}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 悬浮或聚焦展示邮箱；点击仅复制，反馈独立于展开状态并在短暂停留后消失。 */}
        <div className="ink-study__contact-area" data-ink-control>
          <button type="button" className="ink-study__pill ink-study__contact"
            aria-label={messages.inkStudy.contact} aria-describedby="ink-contact-feedback"
            onClick={() => { void copyEmail(); }}>
            <span>{messages.inkStudy.contact}</span>
            <span className="ink-study__contact-email">{AUTHOR_EMAIL}</span>
          </button>
          {/* 状态区常驻按钮外，避免按钮后代语义被扁平化而漏掉辅助技术播报。 */}
          <span className="ink-study__contact-feedback" id="ink-contact-feedback" role="status">
            {copyStatus === "copied" ? messages.inkStudy.emailCopied
              : copyStatus === "failed" ? messages.inkStudy.emailCopyFailed : ""}
          </span>
        </div>
      </section>
    </main>
  );
}
