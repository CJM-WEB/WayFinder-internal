/**
 * 模块职责：把既有资源展示模型呈现为墨迹页面右侧资源条，保留原生拖拽排序。
 * 业务边界：Top 3、状态、来源和 URL 校验继续复用共享模型；排序复用原编辑事务，不产生搜索。
 * 动效边界：退场立即失去交互，旧内容保留至结束；待展示目标只保留最后一次选择。
 */
import type { EditableNode, EditableNote, EditableResource, Resource, SearchLanguage } from "@wayfinder/contracts";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useStore } from "zustand";

import { buildResourcePanelModel, selectVisibleResources, type ResourcePanelModel } from "../components/ResourcePanel/ResourcePanel.js";
import { useGraphEdit } from "../components/Workspace/use-graph-edit.js";
import { getGroupMessages, groupErrorMessage } from "../i18n/group-messages.js";
import { getMessages } from "../i18n/messages.js";
import { requestSafeUrlOpen, resolveSafeHttpUrl } from "../lib/url.js";
import type { GraphStoreNode } from "../stores/graph-store.js";
import { addNote, moveResource, updateNote } from "../stores/workspace-edits.js";
import { activeWorkspaceStore as workspaceStore, workspaceContext, workspaceContextStore, type CapturedWorkspaceEdit } from "../stores/workspace-context.js";
import { workspacePersistenceStore } from "../stores/workspace-persistence.js";
import { InkNotice } from "./ink-notice.js";
import InkNoteDialog, { type InkNoteRecovery, type InkNoteSession } from "./ink-note-dialog.js";

import "./ink-resources.css";

export type InkResourceClientPoint = Readonly<{ x: number; y: number }>;
export type InkNoteRequest = Readonly<{ graphId: string; nodeId: string; generation: string | undefined; contextKey: string }>;
export type InkResourcesProps = Readonly<{
  graphId: string | null;
  node: GraphStoreNode | EditableNode | null;
  language: SearchLanguage;
  visible: boolean;
  /** 仅已完成且可编辑的当前图允许拖拽；运行草图与退场内容始终只读。 */
  editable?: boolean;
  onClose: () => void;
  onResourceContext?: (resourceId: string, point: InkResourceClientPoint) => void;
  notesEnabled?: boolean;
  noteRequest?: InkNoteRequest | null;
  onNoteRequestHandled?: () => void;
  onNoteContext?: (noteId: string | null, point: InkResourceClientPoint) => void;
  onTabChange?: () => void;
}>;

type SelectedModel = Extract<ResourcePanelModel, { kind: "selected" }>;
type Selection = Readonly<{ owner: string; contextKey: string; node: GraphStoreNode | EditableNode }>;
type Display = Selection & Readonly<{ phase: "preparing" | "entering" | "visible" | "leaving" }>;
type PanelTab = "resources" | "notes";
type NoteEditor = Readonly<{ session: InkNoteSession; owner: string; generation: string | undefined; nodeId: string; capture: CapturedWorkspaceEdit | null }>;
const EMPTY_NOTES: readonly EditableNote[] = [];
const SLIDE_MS = 560;
const STAGGER_MS = 45;

/** 系统偏好只决定视图时间，不改节点状态或资源内容；切回普通动效不重播已显示内容。 */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReduced(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** 每个资源条的上下顺序同时决定入场和反向退场；不根据 rank 重新排列真实数组。 */
const itemStyle = (index: number, count: number): CSSProperties => ({
  "--ink-resource-delay": `${index * STAGGER_MS}ms`,
  "--ink-resource-exit-delay": `${Math.max(0, count - index - 1) * STAGGER_MS}ms`,
} as CSSProperties);

/** 提示跟随真实状态保留，只有上游清除后才退场；没有自动吞掉错误的定时器。 */
function OutcomeNotice({ notice, reduced }: { notice: SelectedModel["outcomeNotice"]; reduced: boolean }) {
  const [retained, setRetained] = useState(notice);
  const [present, setPresent] = useState(notice !== null);
  useLayoutEffect(() => {
    if (notice !== null || reduced) setRetained(notice);
    setPresent(notice !== null);
  }, [notice, reduced]);
  useEffect(() => {
    if (present || retained === null) return;
    const timer = window.setTimeout(() => setRetained(null), SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [present, retained]);
  if (retained === null) return null;
  return <div className="ink-resources__notice-motion" data-present={present} inert={!present} aria-hidden={!present}>
    <section className="ink-resources__notice" data-kind={retained.kind} role={retained.kind === "error" ? "alert" : "status"}>
      <h3>{retained.title}</h3>
      <ul>{retained.messages.map(message => <li key={message}>{message}</li>)}</ul>
    </section>
  </div>;
}

/** 打开主体与展开详情为两个独立按钮，触屏、键盘及右键都不会误触第二次 URL 打开。 */
function ResourceStrip({ resource, language, index, count, editable, onResourceContext }: {
  resource: Resource | EditableResource;
  language: SearchLanguage;
  index: number;
  count: number;
  editable: boolean;
  onResourceContext: InkResourcesProps["onResourceContext"];
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const messages = getMessages(language);
  const safeUrl = resolveSafeHttpUrl(resource.url);
  const manual = "origin" in resource && resource.origin === "manual";
  const source = manual ? messages.editor.manualSource
    : "engine" in resource && resource.engine !== undefined ? messages.searchEngine.labels[resource.engine] : messages.searchEngine.unknownSource;
  const openResource = (): void => { requestSafeUrlOpen(resource.url, (url, target, features) => window.open(url, target, features)); };
  return <article className="ink-resources__item ink-resources__card" role="listitem" data-ink-resource={resource.id}
    draggable={editable} title={editable ? messages.editor.dragResource : undefined}
    style={itemStyle(index, count)} data-details-open={detailsOpen}
    onClick={event => {
      // 详情也属于资源的打开区域；展开按钮和正在选择的文字保留自身交互，避免重复打开。
      if (event.target instanceof Element && event.target.closest("button") === null && !window.getSelection()?.toString()) openResource();
    }}
    onPointerEnter={event => { if (event.pointerType !== "touch") setDetailsOpen(true); }}
    onPointerLeave={event => { if (event.pointerType !== "touch" && event.currentTarget.querySelector(":focus-visible") === null) setDetailsOpen(false); }}
    onFocusCapture={event => { if (event.target.matches(":focus-visible")) setDetailsOpen(true); }}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(":hover")) setDetailsOpen(false); }}
    onContextMenu={event => {
      if (onResourceContext === undefined) return;
      event.preventDefault(); event.stopPropagation();
      onResourceContext(resource.id, { x: event.clientX, y: event.clientY });
    }}>
    <div className="ink-resources__open-area" data-invalid={safeUrl === null}>
      <div className="ink-resources__card-top"><span className="ink-resources__rank">#{resource.rank}</span>
        <h3 className="ink-resources__title">{resource.title}</h3><span aria-hidden="true">↗</span></div>
      <span className="ink-resources__meta"><span>{resource.domain}</span><span aria-label={manual ? messages.resourcePanel.sourceType : messages.searchEngine.sourceLabel}>{source}</span></span>
      <button type="button" className="ink-resources__open" disabled={safeUrl === null}
        aria-label={messages.resourcePanel.openAria(resource.title)}
        onClick={openResource} />
    </div>
    <button type="button" className="ink-resources__details-toggle" aria-expanded={detailsOpen} aria-controls={detailsId}
      onClick={() => setDetailsOpen(open => !open)}>
      {detailsOpen ? messages.inkStudy.hideResourceDetails : messages.inkStudy.showResourceDetails}<span aria-hidden="true">{detailsOpen ? "−" : "+"}</span>
    </button>
    <div className="ink-resources__details" id={detailsId} inert={!detailsOpen} aria-hidden={!detailsOpen}>
      <div className="ink-resources__details-inner">
        <section><h4>{messages.editor.resourceSummary}</h4><p>{resource.summary}</p></section>
        <section><h4>{messages.resourcePanel.whySelected}</h4><p>{resource.whySelected}</p></section>
        <p className="ink-resources__source-type">{messages.resourcePanel.sourceType} · {manual ? messages.editor.manualSource : resource.sourceType.replaceAll("_", " ")}</p>
      </div>
    </div>
    {safeUrl === null ? <p className="ink-resources__invalid" role="status">{messages.resourcePanel.invalidUrl}</p> : null}
  </article>;
}

/** 以图与节点的联合身份重建展开状态，避免两张图重用同一业务 nodeId 时串内容。 */
function ResourceSelection({ model, language, onResourceContext, onMoveResource, onMoveStart }: {
  model: SelectedModel;
  language: SearchLanguage;
  onResourceContext: InkResourcesProps["onResourceContext"];
  onMoveResource: ((sourceId: string, targetId: string) => void) | undefined;
  onMoveStart: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const dragged = useRef<string | null>(null);
  const suppressDragClick = useRef(false);
  const messages = getMessages(language);
  const resources = selectVisibleResources(model.resources, expanded);
  const hiddenCount = model.resources.length - resources.length;
  const count = resources.length + 2 + (hiddenCount > 0 ? 1 : 0);
  return <>
    {resources.length === 0 && model.emptyMessage !== null ? <p className="ink-resources__item ink-resources__empty" role="status" style={itemStyle(1, count)}>{model.emptyMessage}</p> : null}
    <div className="ink-resources__list" role="list" aria-label={messages.resourcePanel.resourceListAria}
      onPointerDownCapture={() => { suppressDragClick.current = false; }}
      onClickCapture={event => {
        // 原生拖动后的释放只完成排序，不能同时打开被拖动或目标条目的网址。
        // 键盘激活的 click.detail 为 0；拖动隔离不得吞掉之后的 Enter / Space。
        if (!suppressDragClick.current || event.detail === 0) return;
        suppressDragClick.current = false;
        event.preventDefault(); event.stopPropagation();
      }}
      onDragStart={event => {
        const sourceId = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-ink-resource]")?.dataset.inkResource : undefined;
        if (onMoveResource === undefined || sourceId === undefined || !model.resources.some(resource => resource.id === sourceId)) {
          event.preventDefault(); return;
        }
        // 本面板私有引用作为排序身份，不接收外部 DataTransfer（拖放数据）伪造的资源 ID。
        dragged.current = sourceId;
        onMoveStart();
        suppressDragClick.current = true;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", sourceId);
        event.stopPropagation();
      }}
      onDragOver={event => {
        if (onMoveResource === undefined || dragged.current === null) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
      }}
      onDrop={event => {
        const sourceId = dragged.current;
        dragged.current = null;
        if (onMoveResource === undefined || sourceId === null) return;
        event.preventDefault(); event.stopPropagation();
        const targetId = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-ink-resource]")?.dataset.inkResource : undefined;
        if (targetId !== undefined && sourceId !== targetId && model.resources.some(resource => resource.id === targetId)) onMoveResource(sourceId, targetId);
      }}
      onDragEnd={() => { dragged.current = null; }}>
      {resources.map((resource, index) => <ResourceStrip key={resource.id} resource={resource} language={language}
        index={index + 1} count={count} editable={onMoveResource !== undefined} onResourceContext={onResourceContext} />)}
    </div>
    {hiddenCount > 0 ? <button type="button" className="ink-resources__item ink-resources__more" style={itemStyle(resources.length + 1, count)}
      onClick={() => setExpanded(true)}>{messages.resourcePanel.showMore(hiddenCount)}<span aria-hidden="true">↓</span></button> : null}
  </>;
}

export default function InkResources({ graphId, node, language, visible, editable = false, onClose, onResourceContext,
  notesEnabled = false, noteRequest = null, onNoteRequestHandled, onNoteContext, onTabChange }: InkResourcesProps) {
  const reduced = useReducedMotion();
  const edit = useGraphEdit(graphId, language);
  const messages = getMessages(language);
  const labels = messages.notes;
  const contextKey = useStore(workspaceContextStore, state => state.contextKey);
  const groupMode = useStore(workspaceContextStore, state => state.kind === "group");
  const failedAction = useStore(workspaceContextStore, state => state.failedAction);
  const groupBusy = useStore(workspaceContextStore, state => state.busy);
  const groupWritable = useStore(workspaceContextStore, state => state.writable);
  const contextWritable = useStore(workspaceContextStore, state => state.kind === "personal" || state.writable && !state.busy && state.failedAction === null);
  const moveCapture = useRef<CapturedWorkspaceEdit | null>(null);
  const generation = node !== null && "noteGeneration" in node ? node.noteGeneration : undefined;
  const requested = useMemo<Selection | null>(() => !visible || graphId === null || node === null ? null
    : { owner: JSON.stringify([contextKey, graphId, node.id, generation]), contextKey, node }, [visible, contextKey, graphId, node, generation]);
  useEffect(() => { moveCapture.current = null; }, [contextKey, graphId, node?.id]);
  const desired = useRef(requested);
  const panel = useRef<HTMLElement>(null);
  const noteAdd = useRef<HTMLButtonElement>(null);
  const tabsId = useId();
  const [display, setDisplay] = useState<Display | null>(() => requested === null ? null : { ...requested, phase: reduced ? "visible" : "preparing" });
  const [selection, setSelection] = useState<{ owner: string; tab: PanelTab } | null>(null);
  const [editor, setEditor] = useState<NoteEditor | null>(null);
  const [returning, setReturning] = useState<NoteEditor | null>(null);
  const model = useMemo(() => buildResourcePanelModel(display?.node ?? null, language), [display?.node, language]);
  const tab = notesEnabled && selection !== null && selection.owner === display?.owner ? selection.tab : "resources";
  const notes = display !== null && "notes" in display.node ? display.node.notes ?? EMPTY_NOTES : EMPTY_NOTES;
  const owner = display?.owner;
  const sameOwner = visible && owner !== undefined && requested?.owner === owner;
  const interactive = sameOwner && display?.phase === "visible";
  const noteWritable = editable && contextWritable;
  const noteCreatable = noteWritable && !groupMode;
  const activeEditor = sameOwner && editor?.owner === owner &&
    (editor.session.isNew || notes.some(note => note.id === editor.session.note.id)) ? editor : null;
  let recovery: InkNoteRecovery | undefined;
  // 只有本编辑器提交的组笔记动作可在遮罩内重试，复用原收据及冲突合并，不产生第二条写入。
  if (groupMode && activeEditor !== null && failedAction?.action.action === "edit" &&
    failedAction.action.kind === "note.edit" && failedAction.action.graphId === graphId) {
    const pending = failedAction.action;
    const noteId = activeEditor.session.note.id;
    const readNote = (document: typeof pending.before) => document.nodes.find(target => target.id === activeEditor.nodeId)
      ?.notes?.find(note => note.id === noteId);
    if (JSON.stringify(readNote(pending.before)) !== JSON.stringify(readNote(pending.after))) {
      const groupLabels = getGroupMessages(language);
      const conflict = !failedAction.uncertain && failedAction.error === "GROUP_CONFLICT";
      const ownsFailure = (): boolean => {
        const latest = workspaceContextStore.getState();
        return latest.contextKey === contextKey && latest.failedAction?.action.mutationId === pending.mutationId;
      };
      recovery = {
        label: failedAction.uncertain ? groupLabels.confirmResult : conflict ? groupLabels.keepMine : groupLabels.retry,
        message: groupErrorMessage(failedAction.error, language),
        disabled: groupBusy || !failedAction.uncertain && !groupWritable,
        commit: async () => {
          if (!ownsFailure()) return false;
          if (conflict) return window.confirm(groupLabels.conflictConfirm) && workspaceContext.confirmFailedEdit();
          await workspaceContext.retryFailedAction();
          return workspaceContextStore.getState().contextKey === contextKey;
        },
        discardLabel: groupLabels.discard,
        ...(failedAction.uncertain ? {} : { discard: () => ownsFailure() && workspaceContext.discardFailedAction() }),
      };
    }
  }
  // 回程先恢复位置，再恢复菜单与键盘交互；新笔记不能打断旧卡的归位。
  const panelInteractive = interactive && activeEditor === null && returning === null;
  const chooseTab = (next: PanelTab): void => {
    if (owner === undefined || next === tab) return;
    onTabChange?.();
    setSelection({ owner, tab: next });
  };

  const openEditor = (note: EditableNote | null, origin: HTMLElement, returnFocus: HTMLElement | null): void => {
    if (!panelInteractive || owner === undefined || node === null || (note === null && !noteCreatable)) return;
    const rect = origin.getBoundingClientRect();
    setSelection({ owner, tab: "notes" });
    setEditor({ owner, generation, nodeId: node.id, capture: edit.captureEdit(), session: {
      note: note ?? { id: crypto.randomUUID(), title: "", description: "", markdown: "" },
      isNew: note === null, returnFocus, origin: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    } });
  };

  // 请求与菜单的被点节点绑定；懒加载、切图或同标识重生成期间不沿用旧意图。
  useLayoutEffect(() => {
    if (selection !== null && display?.owner !== selection.owner) setSelection(null);
    if (editor !== null && activeEditor === null) setEditor(null);
    if (returning !== null && returning.owner !== display?.owner) setReturning(null);
  }, [selection, display?.owner, editor, activeEditor, returning]);
  useEffect(() => {
    if (noteRequest === null) return;
    if (!visible || noteRequest.graphId !== graphId || noteRequest.nodeId !== node?.id ||
      noteRequest.generation !== generation || noteRequest.contextKey !== contextKey) {
      onNoteRequestHandled?.();
      return;
    }
    if (!interactive) return;
    const anchor = tab === "notes" ? noteAdd.current : panel.current?.querySelector<HTMLElement>(".ink-resources__header");
    if (anchor != null) openEditor(null, anchor, noteAdd.current);
    onNoteRequestHandled?.();
  }, [noteRequest, interactive, visible, graphId, node?.id, generation, contextKey, tab]);

  useLayoutEffect(() => {
    const previousRequest = desired.current;
    desired.current = requested;
    if (requested !== null && previousRequest === null) setSelection(null);
    setDisplay(previous => {
      if (reduced) return requested === null ? null : { ...requested, phase: "visible" };
      // 身份变化立即丢弃旧笔记及资源，不能为退场动画跨账号保留内容。
      if (previous !== null && previous.contextKey !== contextKey) return requested === null ? null : { ...requested, phase: "preparing" };
      if (requested === null) return previous === null || previous.phase === "leaving" ? previous : { ...previous, phase: "leaving" };
      if (previous === null) return { ...requested, phase: "preparing" };
      if (previous.owner !== requested.owner) return previous.phase === "leaving" ? previous : { ...previous, phase: "leaving" };
      return { ...requested, phase: previous.phase === "leaving" ? "entering" : previous.phase };
    });
  }, [requested, reduced, contextKey]);

  // 一个呈现事务只读取最后目标；A→B→C 在旧条退出期间不会短暂挂载 B 的资源或定时器。
  const displayedOwner = display?.owner, phase = display?.phase;
  const resourceCount = model.kind === "selected" ? model.resources.length : 0;
  useEffect(() => {
    if (displayedOwner === undefined || phase === "visible" || reduced) return;
    let firstFrame = 0, secondFrame = 0, timer = 0;
    if (phase === "preparing") {
      firstFrame = window.requestAnimationFrame(() => { secondFrame = window.requestAnimationFrame(() => {
        setDisplay(previous => previous?.owner === displayedOwner && previous.phase === "preparing" ? { ...previous, phase: "entering" } : previous);
      }); });
    } else {
      // 退场按实际已展示条目的延迟收尾，不能让 Top 3 等待尚未展开的全部资源。
      const delayProperty = phase === "entering" ? "--ink-resource-delay" : "--ink-resource-exit-delay";
      const delay = Math.max(0, ...[...panel.current?.querySelectorAll<HTMLElement>(".ink-resources__item") ?? []]
        .map(item => Number.parseFloat(item.style.getPropertyValue(delayProperty)) || 0));
      timer = window.setTimeout(() => setDisplay(previous => {
        if (previous?.owner !== displayedOwner || previous.phase !== phase) return previous;
        if (phase === "entering") return { ...previous, phase: "visible" };
        const next = desired.current;
        return next === null ? null : { ...next, phase: "preparing" };
      }), SLIDE_MS + delay);
    }
    return () => { window.cancelAnimationFrame(firstFrame); window.cancelAnimationFrame(secondFrame); window.clearTimeout(timer); };
  }, [displayedOwner, phase, reduced, resourceCount]);

  return <><InkNotice notice={!interactive || edit.problem === null ? null : { message: edit.problem.message }} />
  {display === null || display.contextKey !== contextKey || model.kind !== "selected" ? null : <aside className="ink-resources" ref={panel} data-ink-overlay data-ink-control data-phase={display.phase}
    data-ink-resource-owner={display.owner} data-note-open={activeEditor !== null} aria-label={messages.resourcePanel.panelName}
    inert={!panelInteractive} aria-hidden={!panelInteractive} onKeyDown={event => {
      if (event.key === "Escape" && panelInteractive) { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
    <div className="ink-resources__scroll">
    <OutcomeNotice notice={model.outcomeNotice} reduced={reduced} />
    <header className="ink-resources__item ink-resources__header" style={itemStyle(0, Math.min(resourceCount, 3) + 2)}>
      <div><p>{messages.resourcePanel.selectedNode}</p><h2>{model.nodeTitle}</h2></div>
      <button type="button" className="ink-resources__close" aria-label={messages.inkStudy.closeResources} onClick={onClose}>×</button>
      {notesEnabled ? <div className="ink-resources__tabs" role="tablist" aria-label={messages.resourcePanel.panelName}
        onKeyDown={event => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault(); event.stopPropagation();
          const next = tab === "resources" ? "notes" : "resources";
          chooseTab(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
        }}>
        {(["resources", "notes"] as const).map(kind => <button key={kind} type="button" role="tab" id={`${tabsId}-${kind}`}
          aria-selected={tab === kind} aria-controls={`${tabsId}-panel-${kind}`} tabIndex={tab === kind ? 0 : -1} data-tab={kind}
          onClick={() => chooseTab(kind)}>{kind === "resources" ? labels.resources : labels.tab}</button>)}
      </div> : null}
      {tab === "resources" ? <div className="ink-resources__status"><span data-node-status={model.nodeStatus}>{model.nodeStatusLabel}</span><span>{messages.resourcePanel.resourceCount(model.resources.length)}</span></div> : null}
    </header>
    <div className="ink-resources__modes" data-active={tab}>
    <div className="ink-resources__mode" data-kind="resources" id={`${tabsId}-panel-resources`} role={notesEnabled ? "tabpanel" : undefined}
      aria-labelledby={notesEnabled ? `${tabsId}-resources` : undefined} inert={tab !== "resources"} aria-hidden={tab !== "resources"}>
    <ResourceSelection key={display.owner} model={model} language={language}
      onMoveStart={() => { moveCapture.current = edit.captureEdit(); }}
      onMoveResource={!panelInteractive || tab !== "resources" || !editable || !contextWritable ? undefined : (sourceId, targetId) => {
        // 保留拖动开始时的版本；同字段远端修改交给服务端冲突门禁，不能在drop时隐式重基线。
        if (workspaceStore.getState().currentId !== graphId) return;
        const capture = moveCapture.current; moveCapture.current = null;
        void edit.commitCaptured(capture, graph => moveResource(graph, display.node.id, sourceId, targetId));
      }}
      onResourceContext={onResourceContext} /></div>
    {notesEnabled ? <div className="ink-resources__mode ink-notes" data-kind="notes" role="tabpanel"
      id={`${tabsId}-panel-notes`} aria-labelledby={`${tabsId}-notes`} inert={tab !== "notes"} aria-hidden={tab !== "notes"}
      onContextMenu={event => {
        if (!panelInteractive || !noteCreatable || onNoteContext === undefined) return;
        event.preventDefault(); event.stopPropagation();
        onNoteContext(null, { x: event.clientX, y: event.clientY });
      }}>
      {noteCreatable ? <button type="button" className="ink-resources__more ink-notes__add" ref={noteAdd} data-ink-note-add
        onClick={event => openEditor(null, event.currentTarget, event.currentTarget)}>{labels.add}</button> : null}
      {notes.length === 0 ? <p className="ink-resources__empty" role="status">{labels.empty}</p> :
        <div className="ink-resources__list" role="list" aria-label={labels.tab}>
          {notes.map(note => <article className="ink-resources__item ink-resources__card ink-notes__card" role="listitem"
            data-ink-note={note.id} key={note.id} style={itemStyle(1, 2)}
            data-note-transferred={(activeEditor?.session.note.id === note.id ||
              returning?.owner === owner && returning?.session.note.id === note.id) || undefined}
            onContextMenu={event => {
              if (!panelInteractive || !noteWritable || onNoteContext === undefined) return;
              event.preventDefault(); event.stopPropagation();
              onNoteContext(note.id, { x: event.clientX, y: event.clientY });
            }}>
            <button className="ink-notes__open" type="button" data-ink-note-open
              onClick={event => openEditor(note, event.currentTarget.parentElement ?? event.currentTarget, event.currentTarget)}>
              <span className="ink-resources__title">{note.title.trim() || labels.untitled}</span>
              {note.description === "" ? null : <span className="ink-notes__description">{note.description}</span>}
            </button>
            {noteWritable && onNoteContext !== undefined ? <button className="ink-notes__actions" type="button" aria-label={labels.moreActions}
              onClick={event => {
                const button = event.currentTarget.getBoundingClientRect();
                onNoteContext(note.id, { x: button.left, y: button.bottom });
              }}>⋯</button> : null}
          </article>)}
        </div>}
    </div> : null}
    </div></div>
  </aside>}
  <InkNoteDialog key={contextKey} session={activeEditor?.session ?? null} language={language} writable={noteWritable}
    {...(recovery === undefined ? {} : { recovery })}
    resources={display !== null && "resources" in display.node ? display.node.resources : []}
    onClose={() => { setReturning(activeEditor); setEditor(null); }} onReturn={() => setReturning(null)}
    onSave={async (session, saved) => {
      if (activeEditor?.session !== session || !noteWritable) return false;
      const retrying = workspacePersistenceStore.getState().error === "save";
      const accepted = await edit.commitCaptured(activeEditor.capture, graph => {
        const target = graph.nodes.find(candidate => candidate.id === activeEditor.nodeId);
        if (target === undefined || target.noteGeneration !== activeEditor.generation) throw new Error("笔记目标已失效");
        const { id, ...fields } = saved;
        const exists = target.notes?.some(note => note.id === id) ?? false;
        // 本地写入失败时编辑仍在内存中；以同一笔记 ID 重试，不重复新建或记录同值历史。
        if (exists) return updateNote(graph, target.id, id, fields);
        if (!session.isNew || groupMode) throw new Error("笔记目标已失效");
        return addNote(graph, target.id, fields, id);
      });
      if (!accepted || workspaceContextStore.getState().contextKey !== contextKey) return false;
      // 组图等服务端确认，个人图等本地落盘；断网的个人笔记仍可按原同步队列补交。
      if (groupMode) return true;
      const persistence = workspacePersistenceStore.getState();
      if (retrying && persistence.error === "save") await persistence.retry();
      else await persistence.awaitSave?.();
      return true;
    }} />
  </>;
}
