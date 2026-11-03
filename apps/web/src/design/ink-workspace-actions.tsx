/**
 * 模块职责：为既有节点/资源/关系编辑提供右键菜单和轻量表单，不复制编辑或搜索实现。
 * 事务边界：提交时重新读取当前图；草图、换图和失效目标不写入，布局与内容合为一次撤销步骤。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useStore } from "zustand";
import { resolveSearchEngine, SearchEngineSchema, type EditableGraph, type SearchLanguage } from "@wayfinder/contracts";
import type { XYPosition } from "@xyflow/react";
import type { GraphContextRequest } from "../components/Graph/GraphView.js";
import { useGraphEdit } from "../components/Workspace/WorkspaceEditor.js";
import { getMessages } from "../i18n/messages.js";
import { researchStore } from "../api/research.js";
import { addNode, updateNode, deleteNode, addResource, updateResource, deleteResource, moveResource, moveNode,
  deleteEdge, updateEdge } from "../stores/workspace-edits.js";
import { createEmptyGraph, workspaceStore } from "../stores/workspace-store.js";
import { useInkPresence } from "./ink-presence.js";
import { InkNotice } from "./ink-notice.js";
import "./ink-workspace.css";

export type InkActionTarget = (GraphContextRequest | Readonly<{
  kind: "resource"; nodeId: string; resourceId: string; clientPoint: XYPosition;
}>) & Readonly<{ graphId: string | null }>;
type Dialog = Readonly<{
  kind: "node.add" | "node.edit" | "resource.add" | "resource.edit" | "graph.search";
  owner: InkActionTarget; title: string; description: string; url: string; summary: string; whySelected: string;
}>;
type Props = Readonly<{
  target: InkActionTarget | null; language: SearchLanguage; enabled: boolean; allowCreate: boolean;
  active: boolean; onClose: () => void;
}>;

/** 空白处的世界坐标只用于新节点；既有人工坐标永远优先于菜单打开时的测量。 */
function withMeasuredPositions(graph: EditableGraph, target: InkActionTarget): EditableGraph {
  if (!("positions" in target) || target.positions === undefined) return graph;
  const ids = new Set(graph.nodes.map(node => node.id));
  return { ...graph, positions: { ...Object.fromEntries(Object.entries(target.positions).filter(([id]) => ids.has(id))), ...graph.positions } };
}

/** 先确认最新实体仍存在，再物化布局；无效旧菜单不能生成一条只有坐标变化的编辑。 */
function assertTargetExists(graph: EditableGraph, target: InkActionTarget): void {
  if (graph.id !== target.graphId || (target.kind === "edge" && !graph.edges.some(edge => edge.id === target.edgeId))) throw new Error("编辑目标已失效");
  if (target.kind === "node" || target.kind === "resource") {
    const node = graph.nodes.find(item => item.id === target.nodeId);
    if (node === undefined || (target.kind === "resource" && !node.resources.some(resource => resource.id === target.resourceId))) throw new Error("编辑目标已失效");
  }
}

export default function InkWorkspaceActions({ target, language, enabled, allowCreate, active, onClose }: Props) {
  const messages = getMessages(language);
  const currentId = useStore(workspaceStore, state => state.currentId);
  const documents = useStore(workspaceStore, state => state.documents);
  const graph = documents.find(document => document.id === currentId);
  const researching = useStore(researchStore, state => state.preview?.status === "searching");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [fields, setFields] = useState({ title: "", description: "", url: "", summary: "", whySelected: "" });
  const menu = useInkPresence(target);
  const form = useInkPresence(dialog);
  const menuRef = useRef<HTMLDivElement>(null), formRef = useRef<HTMLElement>(null);
  const edit = useGraphEdit(currentId, language);
  const held = menu.value;
  const node = held !== null && "nodeId" in held ? graph?.nodes.find(item => item.id === held.nodeId) : undefined;
  const resource = held?.kind === "resource" ? node?.resources.find(item => item.id === held.resourceId) : undefined;
  const edge = held?.kind === "edge" ? graph?.edges.find(item => item.id === held.edgeId) : undefined;
  const writable = enabled && held?.graphId === currentId && graph !== undefined;
  const nodeEngine = graph === undefined ? null : resolveSearchEngine(graph.language, node?.engine ?? graph.engine);

  useEffect(() => {
    if (!active) { onClose(); setDialog(null); edit.clearProblem(); }
    if (dialog !== null && dialog.owner.graphId !== currentId) setDialog(null);
  }, [active, currentId, dialog?.owner.graphId, onClose, edit.clearProblem]);
  useEffect(() => { if (target === null && dialog === null) edit.clearProblem(); }, [target, dialog, edit.clearProblem]);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (element === null || held === null) return;
    const host = element.closest(".ink-study__stage")?.getBoundingClientRect();
    if (host === undefined) return;
    element.style.left = `${Math.max(12, Math.min(held.clientPoint.x - host.left, host.width - element.offsetWidth - 12))}px`;
    element.style.top = `${Math.max(72, Math.min(held.clientPoint.y - host.top, host.height - element.offsetHeight - 20))}px`;
    if (menu.open) element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [held, menu.open]);
  useLayoutEffect(() => {
    if (form.open) formRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, [form.open]);
  useEffect(() => {
    if (!menu.open && !form.open) return;
    const outside = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      // 提示中的恢复按钮必须完整接收 pointerup/click，不能在 pointerdown 时先被卸载。
      if (event.target instanceof Element && event.target.closest(".ink-workspace-notice") !== null) return;
      if (menu.open && !menuRef.current?.contains(event.target)) onClose();
      if (form.open && !formRef.current?.contains(event.target)) setDialog(null);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose(); setDialog(null);
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [menu.open, form.open, onClose]);

  const commit = (owner: InkActionTarget, operation: (document: EditableGraph) => EditableGraph, preserveLayout = false): boolean => edit.commit(document => {
    if (!enabled || workspaceStore.getState().currentId !== owner.graphId || document.id !== owner.graphId) throw new Error("编辑目标已失效");
    assertTargetExists(document, owner);
    return operation(preserveLayout ? withMeasuredPositions(document, owner) : document);
  });
  const openDialog = (kind: Dialog["kind"]): void => {
    if (held === null) return;
    const next: Dialog = { kind, owner: held, title: kind === "node.add" || kind === "graph.search" ? ""
      : kind === "resource.edit" ? resource?.title ?? "" : node?.title ?? "",
      description: kind === "node.add" ? "" : node?.description ?? "", url: kind === "resource.edit" ? resource?.url ?? "" : "",
      summary: resource?.summary ?? "", whySelected: resource?.whySelected ?? "" };
    setFields(next); setDialog(next); onClose();
  };
  const runAction = (operation: (document: EditableGraph) => EditableGraph, preserveLayout = false): void => {
    if (held !== null && commit(held, operation, preserveLayout)) onClose();
  };
  const startResearch = (nodeId?: string): void => {
    if (!writable || graph === undefined || researching) return;
    if (nodeId === undefined && !graph.query.trim()) { openDialog("graph.search"); return; }
    onClose(); void researchStore.getState().start(graph.id, nodeId);
  };
  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (dialog === null || !active) return;
    const owner = dialog.owner;
    let success = false;
    if (dialog.kind === "node.add") {
      success = edit.execute(() => {
        const state = workspaceStore.getState();
        if (!(enabled || allowCreate) || state.currentId !== owner.graphId) throw new Error("编辑目标已失效");
        const existing = state.documents.find(document => document.id === owner.graphId);
        if (existing !== undefined) assertTargetExists(existing, owner);
        const base = existing === undefined ? createEmptyGraph(crypto.randomUUID(), messages.editor.manualGraphTitle, language) : withMeasuredPositions(existing, owner);
        const id = crypto.randomUUID();
        let next = addNode(base, fields.title.trim(), fields.description, id);
        if (owner.kind === "pane") next = moveNode(next, id, owner.flowPoint);
        // 在修改Store之前完成纯函数校验，失败不能遗留半张新图。
        if (existing === undefined) state.addGraph(base);
        state.replaceGraph(next); state.selectNode(id);
      });
    } else if (dialog.kind === "graph.search") {
      if (enabled && graph?.id === owner.graphId && fields.title.trim()) {
        void researchStore.getState().start(graph.id, undefined, fields.title.trim()); success = true;
      }
    } else if ("nodeId" in owner) {
      const nodeId = owner.nodeId;
      success = commit(owner, document => dialog.kind === "node.edit"
        ? updateNode(document, nodeId, { title: fields.title.trim(), description: fields.description })
        : dialog.kind === "resource.add" ? addResource(document, nodeId, fields.url)
          : owner.kind === "resource" ? updateResource(document, nodeId, owner.resourceId,
            { title: fields.title.trim(), url: fields.url, summary: fields.summary, whySelected: fields.whySelected }) : document);
    }
    if (success) setDialog(null);
  };

  const formTitle = form.value?.kind === "node.add" ? messages.editor.addNode
    : form.value?.kind === "node.edit" ? messages.editor.editNode
      : form.value?.kind === "resource.add" ? messages.editor.addResource
        : form.value?.kind === "resource.edit" ? messages.editor.editResource : messages.research.startGraph;
  const invalid = dialog?.kind === "resource.add" ? !fields.url.trim()
    : dialog?.kind === "resource.edit" ? !fields.title.trim() || !fields.url.trim() : !fields.title.trim();
  const option = (label: string, action: () => void, disabled = !writable, selected?: boolean) =>
    <button type="button" role={selected === undefined ? "menuitem" : "menuitemradio"} aria-checked={selected}
      disabled={disabled} onClick={action}>{label}{selected ? <span aria-hidden="true">✓</span> : null}</button>;
  const notice = useMemo(() => edit.problem === null || !active ? null : ({ message: edit.problem.message,
    ...(edit.problem.nodeId === null ? {} : { action: <button className="ink-study__pill" onClick={() => {
      const state = workspaceStore.getState(), owner = graph?.id;
      if (owner !== undefined && state.currentId === owner && state.documents.find(document => document.id === owner)?.nodes.some(node => node.id === edit.problem?.nodeId)) state.selectNode(edit.problem?.nodeId ?? null);
      onClose(); setDialog(null);
    }}>{messages.editor.locateDuplicate}</button> }),
  }), [edit.problem, active, graph?.id, messages.editor.locateDuplicate, onClose]);

  return <>
    {held === null ? null : <div className="ink-workspace-menu" ref={menuRef} role="menu" aria-label={messages.inkStudy.actionMenu}
      data-open={active && menu.open} inert={!active || !menu.open} aria-hidden={!active || !menu.open} data-ink-control data-ink-overlay
      onContextMenu={event => event.preventDefault()} onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); setDialog(null); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
      {held.kind === "pane" ? <>
        {option(messages.editor.addNode, () => openDialog("node.add"), !(writable || allowCreate))}
        {option(messages.research.startGraph, () => startResearch(), !writable || researching)}
        {graph === undefined ? null : <><div className="ink-workspace-menu__label">{messages.searchEngine.label}</div>
          {SearchEngineSchema.options.map(engine => <div key={engine}>{option(messages.searchEngine.labels[engine],
            () => runAction(document => ({ ...document, engine, updatedAt: new Date().toISOString() })), !writable,
            resolveSearchEngine(graph.language, graph.engine) === engine)}</div>)}</>}
      </> : held.kind === "node" ? <>
        {option(messages.editor.editNode, () => openDialog("node.edit"), !writable || node === undefined)}
        {option(messages.editor.addResource, () => openDialog("resource.add"), !writable || node === undefined)}
        {option(messages.research.startNode, () => startResearch(held.nodeId), !writable || researching || node === undefined)}
        <div className="ink-workspace-menu__label">{messages.searchEngine.nodeLabel}</div>
        {SearchEngineSchema.options.map(engine => <div key={engine}>{option(messages.searchEngine.labels[engine], () => runAction(document => ({
          ...document, updatedAt: new Date().toISOString(), nodes: document.nodes.map(item => item.id === held.nodeId ? { ...item, engine } : item),
        })), !writable || node === undefined, nodeEngine === engine)}</div>)}
        {option(messages.editor.deleteNode, () => runAction(document => deleteNode(document, held.nodeId), true))}
      </> : held.kind === "resource" ? <>
        {option(messages.editor.editResource, () => openDialog("resource.edit"), !writable || resource === undefined)}
        {option(messages.editor.addResource, () => openDialog("resource.add"), !writable || node === undefined)}
        {option(messages.editor.moveUp, () => runAction(document => {
          const resources = document.nodes.find(item => item.id === held.nodeId)?.resources ?? [];
          const index = resources.findIndex(item => item.id === held.resourceId), other = resources[index - 1];
          return other === undefined ? document : moveResource(document, held.nodeId, held.resourceId, other.id);
        }), !writable || resource === undefined || node?.resources[0]?.id === resource.id)}
        {option(messages.editor.moveDown, () => runAction(document => {
          const resources = document.nodes.find(item => item.id === held.nodeId)?.resources ?? [];
          const index = resources.findIndex(item => item.id === held.resourceId), other = resources[index + 1];
          return other === undefined ? document : moveResource(document, held.nodeId, held.resourceId, other.id);
        }), !writable || resource === undefined || node?.resources.at(-1)?.id === resource.id)}
        {option(messages.editor.deleteResource, () => runAction(document => deleteResource(document, held.nodeId, held.resourceId)), !writable || resource === undefined)}
      </> : <>
        <div className="ink-workspace-menu__label">{messages.editor.relationType}</div>
        {(["related_to", "recommended_next"] as const).map(type => <div key={type}>{option(messages.graph.edgeLabels[type],
          () => runAction(document => updateEdge(document, held.edgeId, { type }), true), !writable || edge === undefined, edge?.type === type)}</div>)}
        {option(messages.editor.deleteConnection, () => runAction(document => deleteEdge(document, held.edgeId), true), !writable || edge === undefined)}
      </>}
    </div>}
    {form.value === null ? null : <section className="ink-workspace-form" ref={formRef} role="dialog" aria-label={formTitle}
      data-open={active && form.open} inert={!active || !form.open} aria-hidden={!active || !form.open} data-ink-overlay data-ink-control
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDialog(null); onClose(); } }}>
      <header><h2>{formTitle}</h2><button className="ink-workspace-close" aria-label={messages.inkStudy.closePanel} onClick={() => setDialog(null)}>×</button></header>
      <form onSubmit={save}>
        {form.value.kind !== "resource.add" ? <label>{form.value.kind === "graph.search" ? messages.research.topicLabel
          : form.value.kind === "resource.edit" ? messages.editor.resourceTitle : messages.editor.nodeTitle}
          <input maxLength={form.value.kind === "graph.search" ? 2000 : undefined} value={fields.title} onChange={event => setFields(previous => ({ ...previous, title: event.target.value }))} /></label> : null}
        {form.value.kind.startsWith("node.") ? <label>{messages.editor.nodeDescription}<textarea rows={3} value={fields.description}
          onChange={event => setFields(previous => ({ ...previous, description: event.target.value }))} /></label> : null}
        {form.value.kind.startsWith("resource.") ? <label>{messages.editor.resourceUrl}<input inputMode="url" value={fields.url}
          onChange={event => setFields(previous => ({ ...previous, url: event.target.value }))} /></label> : null}
        {form.value.kind === "resource.edit" ? <>
          <label>{messages.editor.resourceSummary}<textarea rows={3} value={fields.summary} onChange={event => setFields(previous => ({ ...previous, summary: event.target.value }))} /></label>
          <label>{messages.editor.whySelected}<textarea rows={3} value={fields.whySelected} onChange={event => setFields(previous => ({ ...previous, whySelected: event.target.value }))} /></label>
        </> : null}
        {form.value.kind === "graph.search" ? <p className="ink-workspace-hint">{messages.research.topicHint}</p> : null}
        <footer><button type="button" className="ink-study__pill ink-workspace-secondary" onClick={() => setDialog(null)}>{messages.editor.cancel}</button>
          <button type="submit" className="ink-study__pill" disabled={invalid}>{form.value.kind === "graph.search" ? messages.research.startGraph
            : form.value.kind === "node.add" ? messages.editor.addNode : form.value.kind === "node.edit" ? messages.editor.saveNode
              : form.value.kind === "resource.add" ? messages.editor.addResource : messages.editor.saveResource}</button></footer>
      </form>
    </section>}
    <InkNotice notice={notice} />
  </>;
}
