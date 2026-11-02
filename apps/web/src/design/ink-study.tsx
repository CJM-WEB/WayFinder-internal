/**
 * 页面职责：独立承载墨迹揭字视觉试验，复用项目现有 React 与 Vite。
 * 复用边界：新界面直接使用既有搜索协调器和状态层，不跳转旧展示页，不复制后端协议。
 */
import { StrictMode, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { resolveSearchEngine, SearchEngineSchema, type SearchEngine, type SearchLanguage } from "@wayfinder/contracts";

import { resolveEntryLanguage } from "../i18n/entry-language.js";
import { getMessages } from "../i18n/messages.js";
import { createInkReveal, type InkRevealController } from "./ink-reveal.js";
import { InkSearchHistory } from "./ink-search-history.js";
import { startOmniboxSubmission, type InvalidOmniboxInputReason } from "../components/Omnibox/Omnibox.js";
import { requestSafeUrlOpen } from "../lib/url.js";
import { useStore } from "zustand";
import type { StreamingSearch } from "../api/search.js";
import { graphStore } from "../stores/graph-store.js";
import { initializeWorkspacePersistence, workspacePersistenceStore } from "../stores/workspace-persistence.js";
import "./ink-study.css";

const AUTHOR_EMAIL = "cjmweb@outlook.com";

function InkStudy() {
  const stage = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const ink = useRef<InkRevealController | null>(null);
  const searchShell = useRef<HTMLFormElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
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
  const persistence = useStore(workspacePersistenceStore, state => state);
  const [feedback, setFeedback] = useState<InvalidOmniboxInputReason | "input_failure" | "search_failure" | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [openControl, setOpenControl] = useState<"language" | "engine" | null>(null);
  const languageOpen = openControl === "language";
  const engineOpen = openControl === "engine";
  const [engineOverride, setEngineOverride] = useState<SearchEngine>();
  const [phase, setPhase] = useState<"intro" | "morphing" | "ready" | "returning">("intro");
  const entered = phase === "morphing" || phase === "ready";
  const ready = phase === "ready";
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [language, setLanguage] = useState<SearchLanguage>(
    () => resolveEntryLanguage(window.location.search) ?? "zh-CN",
  );
  const renderLanguage = hasSearched ? runtime.language ?? language : language;
  const messages = getMessages(renderLanguage);
  const storageBlocked = persistence.status === "loading" || persistence.error === "load";
  const engine = resolveSearchEngine(language, engineOverride);
  const feedbackMessage = feedback === null ? null
    : feedback === "query" ? messages.omnibox.invalidQuery
    : feedback === "invalid_url" ? messages.omnibox.invalidUrl
    : feedback === "unsupported_protocol" ? messages.omnibox.unsupportedProtocol
    : feedback === "search_failure" ? messages.inkStudy.searchFailed : messages.omnibox.inputFailure;
  const searchMessage = feedbackMessage ?? (hasSearched && runtime.runError !== null
    ? messages.inkStudy.searchFailed : null);

  const submitSearch = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!ready || historyOpen || storageBlocked) return;
    const submissionNumber = ++latestSubmission.current;
    try {
      // 只替换提交界面：协议校验、取消旧请求、流式事件和图记录保存均继续走既有实现。
      const submission = startOmniboxSubmission(searchInput.current?.value ?? "", async input => {
        // 仅真实搜索才加载既有协调器及其图布局依赖；后来的提交或卸载可撤销尚未发出的请求。
        const intent = ++latestSearchIntent.current;
        const { startWorkspaceSearch } = await import("../api/workspace-search.js");
        // 非法输入或 Direct 只改变反馈，不能取消之前已经确认的有效搜索意图。
        if (latestSearchIntent.current !== intent) return;
        searchCoordinator.current = startWorkspaceSearch;
        setHasSearched(true);
        const completion = startWorkspaceSearch(input);
        ownedRun.current = graphStore.getState().activeRunId;
        return completion;
      }, url => requestSafeUrlOpen(url, (safeUrl, target, features) => window.open(safeUrl, target, features)), language, engine);
      if (submission.kind === "invalid") { setFeedback(submission.reason); return; }
      setFeedback(null);
      if (submission.kind === "direct" && searchInput.current !== null) searchInput.current.value = submission.url;
      if (submission.kind === "ai_search") {
        if (searchInput.current !== null) searchInput.current.value = submission.query;
        void submission.completion.catch(() => {
          if (latestSubmission.current === submissionNumber) setFeedback("search_failure");
        });
      }
    } catch {
      setFeedback("input_failure");
    }
  };

  useEffect(() => {
    // 焦点在变形完成后进入输入框；减弱动态时也要主动重绘文字的新位置。
    ink.current?.refreshTextPosition();
    if (ready) searchInput.current?.focus({ preventScroll: true });
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
    setHistoryOpen(true);
  }, []);

  useEffect(() => {
    if (!historyOpen && ready && restoreSearchFocus.current) {
      restoreSearchFocus.current = false;
      searchInput.current?.focus({ preventScroll: true });
    }
  }, [historyOpen, ready]);

  const returnHome = (): void => {
    ++latestSubmission.current;
    ++latestSearchIntent.current;
    if (ownedRun.current !== null && graphStore.getState().activeRunId === ownedRun.current) searchCoordinator.current?.cancel();
    restoreHomeFocus.current = true;
    restoreSearchFocus.current = false;
    setHistoryOpen(false);
    setOpenControl(null);
    setFeedback(null);
    setHasSearched(false);
    setPhase("returning");
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
    const effect = createInkReveal(canvas.current, stage.current, heading.current);
    ink.current = effect;

    // WebGL 不可用时仍保留标题与探索入口；系统减弱动态偏好由渲染器处理。
    return () => {
      effect?.destroy();
      ink.current = null;
      ++latestSubmission.current;
      ++latestSearchIntent.current;
      // 只取消本页发起且仍拥有的请求，沿用协调器的 AbortSignal 和迟到事件门禁。
      if (ownedRun.current !== null && graphStore.getState().activeRunId === ownedRun.current) searchCoordinator.current?.cancel();
    };
  }, []);

  useEffect(() => {
    // 展示页语言与进入搜索的初值共用同一受校验值，不增加后端语言设置接口。
    document.documentElement.lang = renderLanguage;
    document.title = messages.inkStudy.pageTitle;
  }, [renderLanguage, messages.inkStudy.pageTitle]);

  return (
    <main className="ink-study">
      <section className="ink-study__stage" id="ink-stage" ref={stage}
        data-layer={entered ? "explore" : "intro"} data-search-ready={ready} data-history-open={historyOpen}
        aria-label={messages.inkStudy.stageAria}>
        <h1 className="ink-study__wordmark" ref={heading}>WAYFINDER</h1>
        <canvas className="ink-study__canvas" ref={canvas} aria-hidden="true" />
        <p className="ink-study__tagline">{messages.inkStudy.tagline}</p>

        <header className="ink-study__intro" inert={phase !== "intro"} aria-hidden={phase !== "intro"}>
          <p className="ink-study__statement">{messages.inkStudy.statement}</p>
        </header>

        {/* 同一胶囊先移动伸展，再分裂提交与引擎入口；进入展示态或更换选项均不会搜索。 */}
        <div className="ink-study__search-layer" inert={historyOpen} aria-hidden={historyOpen}>
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
              inert={!ready} aria-hidden={!ready} aria-label={messages.omnibox.queryLabel}
              aria-describedby={searchMessage === null ? undefined : "ink-search-feedback"}
              onInput={() => setFeedback(null)}
              placeholder={messages.omnibox.queryLabel} />
          </div>
          <button type="submit" className="ink-study__pill ink-study__search-submit" disabled={!ready || storageBlocked}
            aria-hidden={!ready} aria-label={messages.omnibox.searchButton}>
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 12h15m-6-6 6 6-6 6" />
            </svg>
          </button>
        </form>

        <div className="ink-study__engine" ref={engineControl} data-ink-control inert={!ready} aria-hidden={!ready}
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
          </div> : null}
          {hasSearched ? <div className="ink-study__run-status">
            <span role="status">{runtime.isSearching ? messages.app.searchState.searching : `${messages.app.nodeCount} ${runtime.nodes.length}`}</span>
            {runtime.isSearching ? <button type="button" className="ink-study__pill"
              onClick={() => {
                ++latestSubmission.current;
                ++latestSearchIntent.current;
                searchCoordinator.current?.cancel();
              }}>{messages.workspace.cancel}</button> : null}
          </div> : null}
          {searchMessage === null ? null : <p className="ink-study__search-feedback" id="ink-search-feedback" role="alert">{searchMessage}</p>}
          {persistence.error === null ? null : <div className="ink-study__storage-error" role="alert">
            <span>{persistence.error === "load" ? messages.workspace.loadFailure : messages.workspace.saveFailure}</span>
            <button type="button" className="ink-study__pill" onClick={() => { void persistence.retry(); }}>{messages.workspace.retry}</button>
          </div>}
        </div>
        </div>

        <button type="button" className="ink-study__pill ink-study__back" onClick={returnHome}
          inert={!entered} aria-hidden={!entered} aria-label={messages.inkStudy.backHome}>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 12H5m6-6-6 6 6 6" />
          </svg>
        </button>

        <InkSearchHistory open={historyOpen} available={ready} language={renderLanguage}
          onOpen={openHistory} onClose={closeHistory} />

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

const root = document.getElementById("root");
if (root === null) throw new Error("墨迹试验页面缺少 React 根容器");
// 沿用原入口的读取顺序；失败由新界面显示并允许重试，不能以空状态覆盖旧记录。
await initializeWorkspacePersistence();
createRoot(root).render(<StrictMode><InkStudy /></StrictMode>);
