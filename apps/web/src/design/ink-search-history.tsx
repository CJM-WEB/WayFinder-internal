/**
 * 模块职责：以新抽屉呈现和管理已有本地搜索图，复用原工作区与持久化操作。
 * 范围边界：选图、重命名、删除均复用工作区，不搜索、不复制保存逻辑；撤销入口另行呈现。
 * 交互边界：外点与焦点移出只收起；Esc 和触发按钮关闭时才请求恢复搜索焦点。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useStore } from "zustand";
import type { SearchLanguage } from "@wayfinder/contracts";
import { getMessages } from "../i18n/messages.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { workspacePersistenceStore } from "../stores/workspace-persistence.js";
import { InkUndoPanel } from "./ink-undo-panel.js";
import { useInkPresence } from "./ink-presence.js";

type Props = Readonly<{
  open: boolean;
  available: boolean;
  language: SearchLanguage;
  onOpen: () => void;
  onClose: (restoreFocus: boolean) => void;
  onNewSearch: () => void;
  onSelectGraph: (graphId: string) => Promise<void>;
  undoOpen: boolean; undoDisabled: boolean;
  onOpenUndo: () => void; onCloseUndo: (restoreFocus: boolean) => void;
}>;

/** 每条记录只维护名称草稿；保存与删除仍走已有操作，存储读取失败时禁用写入。 */
function HistoryRecord({ id, title, language, disabled, onDelete, onSelect, selected, index }: {
  id: string; title: string; language: SearchLanguage; disabled: boolean; onDelete: () => void;
  onSelect: () => void; selected: boolean; index: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const renameButton = useRef<HTMLButtonElement>(null);
  const restoreRenameFocus = useRef(false);
  const messages = getMessages(language).workspace;
  const finishEditing = (): void => {
    restoreRenameFocus.current = true;
    setEditing(false);
  };
  useLayoutEffect(() => {
    // 空白草稿会暂时禁用保存按钮；等退出编辑、按钮重新可用后再恢复焦点。
    if (!editing && restoreRenameFocus.current) {
      restoreRenameFocus.current = false;
      renameButton.current?.focus({ preventScroll: true });
    }
  }, [editing]);
  const saveTitle = (): void => {
    if (disabled || draft.trim().length === 0) return;
    workspaceStore.getState().renameGraph(id, draft.trim());
    finishEditing();
  };

  // 入场错峰只作用于显示顺序，独立 translate 动画不覆盖条目原有的悬浮扩张。
  return <li className="ink-study__history-record ink-history-entry"
    style={{ "--ink-history-delay": `${index * 55}ms` } as CSSProperties}>
    <form onSubmit={event => { event.preventDefault(); saveTitle(); }}>
      {editing ? <input className="ink-study__history-title-input" aria-label={messages.titleLabel}
        autoFocus value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          // 先退出名称编辑，再由下一次 Esc 收起面板，避免同时丢失草稿与上下文。
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finishEditing(); }
        }} /> : <h3 title={title}><button type="button" className="ink-study__history-title" disabled={disabled}
          aria-current={selected ? "true" : undefined} onClick={onSelect}>{title}</button></h3>}
      <div className="ink-study__history-actions">
        <button type="button" className="ink-study__pill" ref={renameButton}
          aria-label={editing ? messages.saveTitle : `${messages.rename}：${title}`}
          disabled={disabled || (editing && draft.trim().length === 0)}
          onClick={() => {
            if (editing) saveTitle();
            else { setDraft(title); setEditing(true); }
          }}>
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z" /></svg>
          {editing ? messages.saveTitle : messages.rename}
        </button>
        {editing ? <button type="button" className="ink-study__pill" onClick={finishEditing}>{messages.cancel}</button>
          : <button type="button" className="ink-study__pill" aria-label={`${messages.delete}：${title}`} disabled={disabled} onClick={onDelete}>
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5" /></svg>
            {messages.delete}
          </button>}
      </div>
    </form>
  </li>;
}

export function InkSearchHistory({ open, available, language, onOpen, onClose, onNewSearch, onSelectGraph,
  undoOpen, undoDisabled, onOpenUndo, onCloseUndo }: Props) {
  const drawer = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [drawerDuration, setDrawerDuration] = useState(0);
  // 业务关闭立即隔离交互；视觉内容沿父抽屉滑完才释放，避免内层提前淡出造成“半路消失”。
  // 读取既有 CSS 时间，保持整块按钮/面板与父 top 的同一条 S 时间线；减少动态由 presence 即时处理。
  useLayoutEffect(() => {
    if (drawer.current === null) return;
    const duration = getComputedStyle(drawer.current).getPropertyValue("--ink-history-duration").trim();
    const milliseconds = Number.parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000);
    setDrawerDuration(Number.isFinite(milliseconds) ? milliseconds : 0);
  }, []);
  const present = useInkPresence(open ? "history" : undoOpen ? "undo" : null, drawerDuration);
  const [dockHovered, setDockHovered] = useState(false);
  const [dockFocused, setDockFocused] = useState(false);
  const dockExpanded = dockHovered || dockFocused;
  const documents = useStore(workspaceStore, state => state.documents);
  const currentId = useStore(workspaceStore, state => state.currentId);
  const persistence = useStore(workspacePersistenceStore, state => state);
  const messages = getMessages(language);
  const disabled = persistence.status === "loading" || persistence.error === "load";

  useEffect(() => {
    // presence 的视觉选择可能比业务开关晚一个提交；等 CSS 可见后再聚焦，不依赖盲等计时。
    if (open && present.value === "history") panel.current?.focus({ preventScroll: true });
  }, [open, present.value]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: Event): void => {
      if (event.target instanceof Element && !panel.current?.contains(event.target) && !event.target.closest(".ink-study__history-dock")) {
        onClose(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose(true);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, onClose]);

  return (
    <div className="ink-study__history-drawer" ref={drawer} data-present-panel={present.value ?? "none"}
      data-ink-control data-ink-overlay inert={!available} aria-hidden={!available}>
      {/* 触发器与内容是同级，关闭抽屉时仍可从底边或键盘打开。 */}
      <div className="ink-study__history-dock" data-expanded={dockExpanded} data-panel-open={present.value !== null}
        onMouseEnter={() => setDockHovered(true)} onMouseLeave={() => setDockHovered(false)}
        onPointerDownCapture={() => setDockFocused(false)}
        onFocusCapture={event => setDockFocused(event.target.matches(":focus-visible"))} onBlur={event => {
          // 两个胶囊之间保留父层命中桥；键盘在按钮间移动时也不提前收拢。
          if (!event.currentTarget.contains(event.relatedTarget)) setDockFocused(false);
        }} onClick={event => {
          // 透明圆角/间隔只补主入口的命中，子按钮事件仍由各自处理，不能误触撤销入口。
          if (event.target === event.currentTarget) { if (open) onClose(true); else onOpen(); }
        }}>
      <button type="button" className="ink-study__pill ink-study__history-toggle" ref={toggle}
        aria-label={messages.inkStudy.searchHistory} aria-expanded={open} aria-controls="ink-search-history"
        onClick={() => open ? onClose(true) : onOpen()}>
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V5m-6 6 6-6 6 6" /></svg>
        <span aria-hidden="true">{messages.inkStudy.searchHistory}</span>
      </button>
      <button type="button" className="ink-study__pill ink-study__undo-toggle" inert={!dockExpanded}
        aria-label={messages.editor.undo} aria-expanded={undoOpen} aria-controls="ink-undo-history"
        onClick={() => undoOpen ? onCloseUndo(true) : onOpenUndo()}>{messages.editor.undo}</button>
      </div>
      <section className="ink-study__history-panel" id="ink-search-history" ref={panel} tabIndex={-1}
        data-active={open}
        inert={!open} aria-hidden={!open} aria-labelledby="ink-search-history-title">
        <header className="ink-study__history-header">
          <div><h2 id="ink-search-history-title">{messages.inkStudy.searchHistory}</h2><span>{documents.length}</span></div>
          <button type="button" className="ink-study__pill" disabled={disabled} onClick={onNewSearch}>
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            {messages.inkStudy.newGraph}
          </button>
        </header>
        {documents.length === 0 ? <p className="ink-study__history-empty">{messages.workspace.emptyRecords}</p> : null}
        <ul className="ink-study__history-list">
          {documents.map((document, index) => <HistoryRecord key={document.id} id={document.id} title={document.title} index={index}
            language={language} disabled={disabled} selected={document.id === currentId}
            onSelect={() => { void onSelectGraph(document.id); }} onDelete={() => {
              workspaceStore.getState().deleteGraph(document.id);
              // 删除按钮即将卸载，将焦点留在面板，避免键盘用户落到隐藏搜索层。
              panel.current?.focus({ preventScroll: true });
            }} />)}
        </ul>
        {persistence.error === null ? <p className="ink-study__history-storage-status" role="status">
          {persistence.status === "loading" ? messages.workspace.loading
            : persistence.status === "saving" ? messages.workspace.saving : messages.workspace.saved}
        </p> : <div className="ink-study__storage-error" role="alert">
          <span>{persistence.error === "load" ? messages.workspace.loadFailure : messages.workspace.saveFailure}</span>
          <button type="button" className="ink-study__pill" onClick={() => { void persistence.retry(); }}>{messages.workspace.retry}</button>
        </div>}
      </section>
      <InkUndoPanel open={undoOpen} presented={present.value === "undo"} available={available}
        disabled={undoDisabled} language={language} onClose={onCloseUndo} />
    </div>
  );
}
