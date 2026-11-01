/**
 * 模块职责：提供节点、资源与撤销的最小编辑界面；保存按钮才提交一次快照。
 * 编辑只调用确定性函数与本地状态，不把人工操作转化为 Search / LLM 指令。
 */
import type { EditableGraph, Resource, SearchLanguage } from "@wayfinder/contracts";
import { useEffect, useState } from "react";
import { useStore } from "zustand";

import { getMessages } from "../../i18n/messages.js";
import {
  addNode, addResource, deleteNode, deleteResource, updateNode, updateResource, moveResource,
  DuplicateResourceUrlError, InvalidResourceUrlError,
} from "../../stores/workspace-edits.js";
import { createEmptyGraph, selectCurrentGraph, workspaceStore } from "../../stores/workspace-store.js";

type EditProblem = { message: string; nodeId: string | null };

/** 将已分类的输入错误转为本地化提示，不把内部异常正文泄露给界面。 */
export function useGraphEdit(graphId: string | null, language: SearchLanguage) {
  const [problem, setProblem] = useState<EditProblem | null>(null);
  const messages = getMessages(language).editor;
  const execute = (operation: () => void): boolean => {
    try {
      operation();
      setProblem(null);
      return true;
    } catch (error: unknown) {
      setProblem(error instanceof DuplicateResourceUrlError
        ? { message: messages.duplicateUrl(error.nodeTitle), nodeId: error.nodeId }
        : { message: error instanceof InvalidResourceUrlError ? messages.invalidUrl : messages.editFailure, nodeId: null });
      return false;
    }
  };
  const commit = (edit: (graph: EditableGraph) => EditableGraph): boolean => execute(() => {
    const state = workspaceStore.getState();
    const graph = state.documents.find(document => document.id === graphId);
    if (graph === undefined) throw new Error("搜索图已不存在");
    state.replaceGraph(edit(graph));
  });
  return { problem, execute, commit };
}

export function EditNotice({ problem, language }: { problem: EditProblem | null; language: SearchLanguage }) {
  if (problem === null) return null;
  return <div role="alert" className="workspace-edit-error">
    <p>{problem.message}</p>
    {problem.nodeId === null ? null : <button type="button" onClick={() => workspaceStore.getState().selectNode(problem.nodeId)}>
      {getMessages(language).editor.locateDuplicate}
    </button>}
  </div>;
}

function EditField({ label, value, onChange, multiline = false }: {
  label: string; value: string; onChange: (value: string) => void; multiline?: boolean;
}) {
  return <label className="workspace-edit-field">{label}
    {multiline
      ? <textarea rows={3} value={value} onChange={event => onChange(event.target.value)} />
      : <input value={value} onChange={event => onChange(event.target.value)} />}
  </label>;
}

/** 没有搜索记录时也能先创建空图；首个节点仍作为独立、可撤销的编辑。 */
export function WorkspaceToolbar({ language, disabled }: { language: SearchLanguage; disabled: boolean }) {
  const document = useStore(workspaceStore, selectCurrentGraph);
  const history = useStore(workspaceStore, state => state.histories[state.currentId ?? ""]);
  const [title, setTitle] = useState("");
  const edit = useGraphEdit(document?.id ?? null, language);
  const messages = getMessages(language).editor;
  return <fieldset className="workspace-edit-toolbar" disabled={disabled} aria-label={messages.toolbar}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!title.trim()) return;
      if (edit.execute(() => {
        const state = workspaceStore.getState();
        let graph = selectCurrentGraph(state);
        if (graph === null) {
          graph = createEmptyGraph(crypto.randomUUID(), messages.manualGraphTitle, language);
          state.addGraph(graph);
        }
        const id = crypto.randomUUID();
        state.replaceGraph(addNode(graph, title.trim(), "", id));
        state.selectNode(id);
      })) setTitle("");
    }}>
      <EditField label={messages.newNodeTitle} value={title} onChange={setTitle} />
      <button type="submit" disabled={!title.trim()}>{messages.addNode}</button>
    </form>
    <div className="workspace-edit-actions">
      <button type="button" disabled={!history?.past.length} onClick={() => workspaceStore.getState().undo()}>{messages.undo}</button>
      <button type="button" disabled={!history?.future.length} onClick={() => workspaceStore.getState().redo()}>{messages.redo}</button>
    </div>
    <EditNotice problem={edit.problem} language={language} />
  </fieldset>;
}

/** 标题修改与重新搜索独立，说明可为空；资源只需一个 URL 即可加入。 */
export function NodeEditor({ graphId, nodeId, language }: { graphId: string; nodeId: string; language: SearchLanguage }) {
  const node = useStore(workspaceStore, state => state.documents.find(graph => graph.id === graphId)?.nodes.find(item => item.id === nodeId));
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(node?.title ?? "");
  const [description, setDescription] = useState(node?.description ?? "");
  const [url, setUrl] = useState("");
  const edit = useGraphEdit(graphId, language);
  const messages = getMessages(language).editor;
  useEffect(() => { setTitle(node?.title ?? ""); setDescription(node?.description ?? ""); }, [node?.title, node?.description]);
  if (node === undefined) return null;
  return <section className="workspace-node-editor">
    {editing ? <form onSubmit={event => {
      event.preventDefault();
      if (edit.commit(graph => updateNode(graph, nodeId, { title: title.trim(), description }))) setEditing(false);
    }}>
      <EditField label={messages.nodeTitle} value={title} onChange={setTitle} />
      <EditField label={messages.nodeDescription} value={description} onChange={setDescription} multiline />
      <button type="submit" disabled={!title.trim()}>{messages.saveNode}</button>
      <button type="button" onClick={() => setEditing(false)}>{messages.cancel}</button>
    </form> : <>
      {node.description ? <p>{node.description}</p> : null}
      <button type="button" onClick={() => { setTitle(node.title); setDescription(node.description); setEditing(true); }}>{messages.editNode}</button>
    </>}
    <button type="button" onClick={() => edit.commit(graph => deleteNode(graph, nodeId))}>{messages.deleteNode}</button>
    <form onSubmit={event => {
      event.preventDefault();
      if (edit.commit(graph => addResource(graph, nodeId, url))) setUrl("");
    }}>
      <EditField label={messages.resourceUrl} value={url} onChange={setUrl} />
      <button type="submit" disabled={!url.trim()}>{messages.addResource}</button>
    </form>
    <EditNotice problem={edit.problem} language={language} />
  </section>;
}

/** 每条资源直接编辑或上下移动；键盘按钮与拖拽使用同一个确定性排序函数。 */
export function ResourceEditor({ graphId, nodeId, resource, language }: {
  graphId: string; nodeId: string; resource: Pick<Resource, "id" | "title" | "url" | "summary" | "whySelected">; language: SearchLanguage;
}) {
  const resources = useStore(workspaceStore, state => state.documents.find(graph => graph.id === graphId)?.nodes.find(node => node.id === nodeId)?.resources);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(resource.title);
  const [url, setUrl] = useState(resource.url);
  const [summary, setSummary] = useState(resource.summary);
  const [whySelected, setWhySelected] = useState(resource.whySelected);
  const edit = useGraphEdit(graphId, language);
  const messages = getMessages(language).editor;
  useEffect(() => {
    setTitle(resource.title); setUrl(resource.url); setSummary(resource.summary); setWhySelected(resource.whySelected);
  }, [resource.title, resource.url, resource.summary, resource.whySelected]);
  const index = resources?.findIndex(item => item.id === resource.id) ?? -1;
  const move = (offset: number): void => {
    const target = resources?.[index + offset];
    if (target !== undefined) edit.commit(graph => moveResource(graph, nodeId, resource.id, target.id));
  };
  return <div className="workspace-resource-editor">
    {editing ? <form onSubmit={event => {
      event.preventDefault();
      if (edit.commit(graph => updateResource(graph, nodeId, resource.id, { title: title.trim(), url, summary, whySelected }))) setEditing(false);
    }}>
      <EditField label={messages.resourceTitle} value={title} onChange={setTitle} />
      <EditField label={messages.resourceUrl} value={url} onChange={setUrl} />
      <EditField label={messages.resourceSummary} value={summary} onChange={setSummary} multiline />
      <EditField label={messages.whySelected} value={whySelected} onChange={setWhySelected} multiline />
      <button type="submit" disabled={!title.trim() || !url.trim()}>{messages.saveResource}</button>
      <button type="button" onClick={() => setEditing(false)}>{messages.cancel}</button>
    </form> : <button type="button" onClick={() => {
      // 取消的输入只是本地草稿；再次打开必须以当前已保存内容为准。
      setTitle(resource.title); setUrl(resource.url); setSummary(resource.summary); setWhySelected(resource.whySelected);
      setEditing(true);
    }}>{messages.editResource}</button>}
    <div className="workspace-edit-actions">
      <button type="button" onClick={() => edit.commit(graph => deleteResource(graph, nodeId, resource.id))}>{messages.deleteResource}</button>
      <button type="button" disabled={index <= 0} onClick={() => move(-1)}>{messages.moveUp}</button>
      <button type="button" disabled={index < 0 || index === (resources?.length ?? 0) - 1} onClick={() => move(1)}>{messages.moveDown}</button>
    </div>
    <EditNotice problem={edit.problem} language={language} />
  </div>;
}
