/**
 * 模块职责：以新抽屉呈现已有本地搜索图记录，只读订阅原工作区与持久化状态。
 * 范围边界：本轮不接记录点击，不搜索、不改变当前图，也不复制历史保存逻辑。
 * 交互边界：外点与焦点移出只收起；Esc 和触发按钮关闭时才请求恢复搜索焦点。
 */
import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { resolveSearchEngine, type SearchLanguage } from "@wayfinder/contracts";
import { getMessages } from "../i18n/messages.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { workspacePersistenceStore } from "../stores/workspace-persistence.js";

type Props = Readonly<{
  open: boolean;
  available: boolean;
  language: SearchLanguage;
  onOpen: () => void;
  onClose: (restoreFocus: boolean) => void;
}>;

export function InkSearchHistory({ open, available, language, onOpen, onClose }: Props) {
  const panel = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const documents = useStore(workspaceStore, state => state.documents);
  const persistence = useStore(workspacePersistenceStore, state => state);
  const messages = getMessages(language);

  useEffect(() => {
    if (open) panel.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: Event): void => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !toggle.current?.contains(event.target)) {
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
    <div className="ink-study__history-drawer" data-ink-control inert={!available} aria-hidden={!available}>
      {/* 触发器与只读内容是同级，关闭抽屉时仍可从底边或键盘打开。 */}
      <button type="button" className="ink-study__pill ink-study__history-toggle" ref={toggle}
        aria-label={messages.inkStudy.searchHistory} aria-expanded={open} aria-controls="ink-search-history"
        onClick={() => open ? onClose(true) : onOpen()}>
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V5m-6 6 6-6 6 6" /></svg>
        <span aria-hidden="true">{messages.inkStudy.searchHistory}</span>
      </button>
      <section className="ink-study__history-panel" id="ink-search-history" ref={panel} tabIndex={-1}
        inert={!open} aria-hidden={!open} aria-labelledby="ink-search-history-title">
        <header className="ink-study__history-header">
          <h2 id="ink-search-history-title">{messages.inkStudy.searchHistory}</h2>
          <span>{documents.length}</span>
        </header>
        {documents.length === 0 ? <p className="ink-study__history-empty">{messages.workspace.emptyRecords}</p> : null}
        <ul className="ink-study__history-list">
          {documents.map(document => <li key={document.id}>
            <h3>{document.title}</h3>
            {document.query === document.title ? null : <p>{document.query}</p>}
            <div>
              <span>{messages.searchEngine.labels[resolveSearchEngine(document.language, document.engine)]}</span>
              <span>{messages.app.nodeCount} {document.nodes.length}</span>
            </div>
          </li>)}
        </ul>
        {persistence.error === null ? null : <div className="ink-study__storage-error" role="alert">
          <span>{persistence.error === "load" ? messages.workspace.loadFailure : messages.workspace.saveFailure}</span>
          <button type="button" className="ink-study__pill" onClick={() => { void persistence.retry(); }}>{messages.workspace.retry}</button>
        </div>}
      </section>
    </div>
  );
}
