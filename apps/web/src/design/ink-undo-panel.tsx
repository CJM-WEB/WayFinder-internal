/**
 * 模块职责：展示当前图持久保存的可撤销事件；逐条撤销仍由Store的最新依赖/图约束校验决定。
 * 生命周期：面板常驻供抽屉退场，关闭后立即隔离命中；列表不从旧文档时间伪造事件时间。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useStore } from "zustand";
import type { SearchLanguage } from "@wayfinder/contracts";
import { getMessages } from "../i18n/messages.js";
import { workspacePersistenceStore } from "../stores/workspace-persistence.js";
import { activeWorkspaceStore as workspaceStore, workspaceContextStore, selectActiveWorkspaceHistory, selectActiveWorkspaceRedoCount } from "../stores/workspace-context.js";
import type { WorkspaceHistoryEventView, WorkspaceHistoryKind, WorkspaceHistoryResult } from "../stores/workspace-history.js";
import { InkNotice } from "./ink-notice.js";

type Props = Readonly<{ open: boolean; presented: boolean; available: boolean; disabled: boolean; language: SearchLanguage; onClose: (restoreFocus: boolean) => void }>;

/**
 * 条目生命周期：撤销成功立即停止交互，但保留原内容完成向上退场，再卸载 DOM。
 * 内部历史仍留给重做；刷新时已撤销事件初始为 null，不重新闪现或播放退场。
 */
function UndoEvent({ event, index, disabled, name, date, reason, undoLabel, onUndo }: {
  event: WorkspaceHistoryEventView; index: number; disabled: boolean; name: string; date: Intl.DateTimeFormat;
  reason: (code: string) => string; undoLabel: string; onUndo: (id: string) => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  const [held, setHeld] = useState(event.active ? event : null);
  useLayoutEffect(() => {
    if (event.active) { setHeld(event); return; }
    // 折叠从浏览器提交样式时开始。以真实过渡为准，避免定时器先到、邻行尚未到位就卸载。
    const transitions = row.current?.getAnimations() ?? [];
    if (transitions.length === 0) { setHeld(null); return; }
    let current = true, frame = 0;
    void Promise.allSettled(transitions.map(transition => transition.finished)).then(() => {
      // 运行中切换为减少动态会取消过渡，同样可以释放；重做或切图后旧回调不得回写。
      if (current) frame = requestAnimationFrame(() => setHeld(null));
    });
    return () => { current = false; cancelAnimationFrame(frame); };
  }, [event]);
  if (held === null) return null;
  return <li ref={row} className="ink-undo-event ink-history-entry" data-active={event.active} data-leaving={!event.active}
    data-ink-undo-event={event.id} inert={!event.active} aria-hidden={!event.active}
    style={{ "--ink-history-delay": `${index * 55}ms` } as CSSProperties}>
    <div className="ink-undo-event__content"><div><h3>{name}</h3><p>{held.subject}</p><time dateTime={held.occurredAt}>{date.format(new Date(held.occurredAt))}</time>
      {held.blockedReason === undefined ? null : <p className="ink-undo-event__reason">{reason(held.blockedReason)}</p>}</div>
    <button className="ink-study__pill" type="button" disabled={disabled || !event.active || event.blockedReason !== undefined}
      aria-label={`${undoLabel}：${name} ${held.subject}`} onClick={() => onUndo(event.id)}>{undoLabel}</button></div>
  </li>;
}

export function InkUndoPanel({ open, presented, available, disabled, language, onClose }: Props) {
  const panel = useRef<HTMLElement>(null);
  const context = useStore(workspaceContextStore, state => state);
  const redoCount = useStore(workspaceStore, selectActiveWorkspaceRedoCount);
  const graphId = useStore(workspaceStore, state => state.currentId);
  const history = useStore(workspaceStore, state => state.histories[state.currentId ?? ""]);
  const deleted = useStore(workspaceStore, state => state.deletedGraphs);
  const persistence = useStore(workspacePersistenceStore, state => state);
  const messages = getMessages(language);
  const events = useMemo(() => selectActiveWorkspaceHistory(workspaceStore.getState()), [history, graphId, context.contextKey]);
  const activeCount = events.filter(event => event.active).length;
  // 已撤销事件只为重做保留，不占用可见队列的错峰序号，避免剩余条目等待空白行。
  let entryIndex = 0;
  const entries = [...events].reverse().map(event => ({ event, index: event.active ? entryIndex++ : 0 }));
  const [failure, setFailure] = useState<Exclude<WorkspaceHistoryResult, { ok: true }>["reason"] | null>(null);
  const names: Record<WorkspaceHistoryKind, string> = {
    "graph.rename": messages.workspace.rename, "graph.update": messages.editor.toolbar, "graph.search": messages.inkStudy.graphResultApplied,
    "node.add": messages.editor.addNode, "node.edit": messages.editor.editNode, "node.delete": messages.editor.deleteNode,
    "node.search": messages.inkStudy.nodeResultApplied,
    "resource.add": messages.editor.addResource, "resource.edit": messages.editor.editResource, "resource.delete": messages.editor.deleteResource,
    "resource.move": messages.editor.dragResource, "edge.add": messages.editor.addConnection, "edge.edit": messages.editor.saveConnection,
    "edge.delete": messages.editor.deleteConnection, "engine.change": messages.searchEngine.label,
  };
  const reason = (code: string): string => code === "dependency" ? messages.inkStudy.undoDependency
    : code === "constraint" ? messages.inkStudy.undoConstraint : messages.inkStudy.undoUnavailable;
  const date = useMemo(() => new Intl.DateTimeFormat(language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }), [language]);
  // 抽屉打开时搜索层已离屏，保存失败必须在当前可见层保留重试入口。
  const notice = useMemo(() => !open ? null : context.kind !== "group" && persistence.error !== null ? {
    message: persistence.error === "load" ? messages.workspace.loadFailure : messages.workspace.saveFailure,
    action: <button className="ink-study__pill" type="button" onClick={() => { panel.current?.focus({ preventScroll: true }); void persistence.retry(); }}>{messages.workspace.retry}</button>,
  } : failure === null ? null : { message: reason(failure) }, [failure, open, language, persistence.error, persistence.retry, context.kind]);
  useEffect(() => { setFailure(null); }, [graphId]);
  // 父抽屉的视觉选择提交后面板才可聚焦；保持真实可见性和业务开启同时成立。
  useEffect(() => { if (open && presented) panel.current?.focus({ preventScroll: true }); }, [open, presented]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event): void => {
      if (!(event.target instanceof Element) || panel.current?.contains(event.target) || event.target.closest(".ink-study__history-dock, [data-ink-undo-notice]")) return;
      onClose(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault(); onClose(true);
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("focusin", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); document.removeEventListener("keydown", escape); };
  }, [open, onClose]);
  return <><section className="ink-study__history-panel ink-undo-panel" ref={panel} tabIndex={-1} id="ink-undo-history"
    data-active={open} inert={!open || !available} aria-hidden={!open || !available} aria-labelledby="ink-undo-title" data-ink-overlay>
    <header className="ink-study__history-header"><div><h2 id="ink-undo-title">{messages.inkStudy.undoHistory}</h2><span>{activeCount}</span></div>
      <div className="ink-undo-actions"><button className="ink-study__pill" type="button" disabled={disabled || redoCount === 0}
        onClick={() => { workspaceStore.getState().redo(); setFailure(null); }}>{messages.editor.redo}</button>
        <button className="ink-study__pill" type="button" disabled={disabled || deleted.length === 0}
          title={deleted.at(-1)?.document.title} onClick={() => { onClose(false); workspaceStore.getState().restoreDeletedGraph(); }}>{messages.inkStudy.restoreGraph}</button></div>
    </header>
    <p className="ink-workspace-hint">{messages.inkStudy.undoHint}</p>
    <ul className="ink-undo-list">{entries.map(({ event, index }) => <UndoEvent key={event.id}
      event={event} index={index} disabled={disabled} name={context.kind === "group" ? `${names[event.kind]} · ${context.groupName ?? ""}` : names[event.kind]} date={date} reason={reason}
      undoLabel={messages.editor.undo} onUndo={id => {
        const result = workspaceStore.getState().undoEvent(id);
        setFailure(result.ok ? null : result.reason);
        // 成功后按钮将退出命中与焦点序列，将焦点留在抽屉内，避免误触外点关闭逻辑。
        if (result.ok) panel.current?.focus({ preventScroll: true });
      }} />)}</ul>
    {/* 空提示置于列表之后，不把最后一条仍在退场的内容突然向下推移。 */}
    {activeCount === 0 ? <p className="ink-study__history-empty">{messages.inkStudy.emptyUndo}</p> : null}
  </section>
    {/* 提示独立于滚动面板，长队列滚动后仍在顶部可见；其重试不触发外点关闭。 */}
    <div data-ink-undo-notice><InkNotice notice={notice} /></div>
  </>;
}
