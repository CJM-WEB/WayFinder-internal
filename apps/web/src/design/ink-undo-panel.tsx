/**
 * 模块职责：展示当前图的会话事件；逐条撤销仍由Store的最新依赖/图约束校验决定。
 * 生命周期：面板常驻供抽屉退场，关闭后立即隔离命中；列表不从旧文档时间伪造事件时间。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type { SearchLanguage } from "@wayfinder/contracts";
import { getMessages } from "../i18n/messages.js";
import { selectWorkspaceHistory, workspaceStore } from "../stores/workspace-store.js";
import type { WorkspaceHistoryKind, WorkspaceHistoryResult } from "../stores/workspace-history.js";
import { InkNotice } from "./ink-notice.js";

type Props = Readonly<{ open: boolean; available: boolean; disabled: boolean; language: SearchLanguage; onClose: (restoreFocus: boolean) => void }>;

export function InkUndoPanel({ open, available, disabled, language, onClose }: Props) {
  const panel = useRef<HTMLElement>(null);
  const graphId = useStore(workspaceStore, state => state.currentId);
  const history = useStore(workspaceStore, state => state.histories[state.currentId ?? ""]);
  const deleted = useStore(workspaceStore, state => state.deletedGraphs);
  const messages = getMessages(language);
  const events = useMemo(() => selectWorkspaceHistory(workspaceStore.getState()), [history, graphId]);
  const [failure, setFailure] = useState<Exclude<WorkspaceHistoryResult, { ok: true }>["reason"] | null>(null);
  const names: Record<WorkspaceHistoryKind, string> = {
    "graph.rename": messages.workspace.rename, "graph.update": messages.editor.toolbar, "graph.search": messages.inkStudy.graphResultApplied,
    "node.add": messages.editor.addNode, "node.edit": messages.editor.editNode, "node.delete": messages.editor.deleteNode,
    "node.move": messages.inkStudy.moveNode, "node.search": messages.inkStudy.nodeResultApplied,
    "resource.add": messages.editor.addResource, "resource.edit": messages.editor.editResource, "resource.delete": messages.editor.deleteResource,
    "resource.move": messages.editor.dragResource, "edge.add": messages.editor.addConnection, "edge.edit": messages.editor.saveConnection,
    "edge.delete": messages.editor.deleteConnection, "engine.change": messages.searchEngine.label,
  };
  const reason = (code: string): string => code === "dependency" ? messages.inkStudy.undoDependency
    : code === "constraint" ? messages.inkStudy.undoConstraint : messages.inkStudy.undoUnavailable;
  const date = useMemo(() => new Intl.DateTimeFormat(language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }), [language]);
  const notice = useMemo(() => failure === null || !open ? null : { message: reason(failure) }, [failure, open, language]);
  useEffect(() => { setFailure(null); }, [graphId]);
  useEffect(() => { if (open) panel.current?.focus({ preventScroll: true }); }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event): void => {
      if (!(event.target instanceof Element) || panel.current?.contains(event.target) || event.target.closest(".ink-study__history-dock")) return;
      onClose(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault(); onClose(true);
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("focusin", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); document.removeEventListener("keydown", escape); };
  }, [open, onClose]);
  return <section className="ink-study__history-panel ink-undo-panel" ref={panel} tabIndex={-1} id="ink-undo-history"
    data-active={open} inert={!open || !available} aria-hidden={!open || !available} aria-labelledby="ink-undo-title" data-ink-overlay>
    <header className="ink-study__history-header"><div><h2 id="ink-undo-title">{messages.inkStudy.undoHistory}</h2><span>{events.length}</span></div>
      <div className="ink-undo-actions"><button className="ink-study__pill" type="button" disabled={disabled || !history?.future.length}
        onClick={() => { workspaceStore.getState().redo(); setFailure(null); }}>{messages.editor.redo}</button>
        <button className="ink-study__pill" type="button" disabled={disabled || deleted.length === 0}
          title={deleted.at(-1)?.document.title} onClick={() => { onClose(false); workspaceStore.getState().restoreDeletedGraph(); }}>{messages.inkStudy.restoreGraph}</button></div>
    </header>
    <p className="ink-workspace-hint">{messages.inkStudy.undoHint}</p>
    {events.length === 0 ? <p className="ink-study__history-empty">{messages.inkStudy.emptyUndo}</p> : null}
    <ul className="ink-undo-list">{[...events].reverse().map(event => <li key={event.id} className="ink-undo-event" data-active={event.active} data-ink-undo-event={event.id}>
      <div><h3>{names[event.kind]}</h3><p>{event.subject}</p><time dateTime={event.occurredAt}>{date.format(new Date(event.occurredAt))}</time>
        {event.blockedReason === undefined ? null : <p className="ink-undo-event__reason">{reason(event.blockedReason)}</p>}</div>
      <button className="ink-study__pill" type="button" disabled={disabled || !event.active || event.blockedReason !== undefined}
        aria-label={`${messages.editor.undo}：${names[event.kind]} ${event.subject}`} onClick={() => {
          const result = workspaceStore.getState().undoEvent(event.id);
          setFailure(result.ok ? null : result.reason);
        }}>{event.active ? messages.editor.undo : messages.inkStudy.undone}</button>
    </li>)}</ul>
    <InkNotice notice={notice} />
  </section>;
}
