/** 模块职责：用一份原生表单新增、修改或删除连线，复用画布同一套确定性规则。 */
import type { GraphEdge, SearchLanguage } from "@wayfinder/contracts";
import { useEffect, useState } from "react";
import { useStore } from "zustand";

import { getMessages } from "../../i18n/messages.js";
import { addEdge, updateEdge, deleteEdge } from "../../stores/workspace-edits.js";
import { workspaceStore } from "../../stores/workspace-store.js";
import { EditNotice, useGraphEdit } from "./WorkspaceEditor.js";

export function WorkspaceEdgeEditor({ graphId, language, disabled }: {
  graphId: string; language: SearchLanguage; disabled: boolean;
}) {
  const graph = useStore(workspaceStore, state => state.documents.find(document => document.id === graphId));
  const [edgeId, setEdgeId] = useState("");
  const selectedEdge = graph?.edges.find(edge => edge.id === edgeId);
  const firstNode = graph?.nodes[0]?.id ?? "";
  const secondNode = graph?.nodes[1]?.id ?? firstNode;
  const [source, setSource] = useState(firstNode);
  const [target, setTarget] = useState(secondNode);
  const [type, setType] = useState<GraphEdge["type"]>("related_to");
  const edit = useGraphEdit(graphId, language);
  const messages = getMessages(language);
  // 恢复已保存连线时同步表单；节点移动不会清除用户尚未提交的关系选择。
  useEffect(() => {
    setSource(selectedEdge?.source ?? firstNode);
    setTarget(selectedEdge?.target ?? secondNode);
    setType(selectedEdge?.type ?? "related_to");
  }, [edgeId, selectedEdge?.source, selectedEdge?.target, selectedEdge?.type, firstNode, secondNode]);
  if (graph === undefined) return null;
  const nodeName = (id: string): string => graph.nodes.find(node => node.id === id)?.title ?? id;
  return <details className="workspace-edge-editor">
    <summary>{messages.editor.connections(graph.edges.length)}</summary>
    <fieldset disabled={disabled}>
      <label className="workspace-edit-field">{messages.editor.selectConnection}
        <select value={edgeId} onChange={event => setEdgeId(event.target.value)}>
          <option value="">{messages.editor.newConnection}</option>
          {graph.edges.map(edge => <option key={edge.id} value={edge.id}>
            {nodeName(edge.source)} {edge.type === "recommended_next" ? "→" : "↔"} {nodeName(edge.target)} · {messages.graph.edgeLabels[edge.type]}
          </option>)}
        </select>
      </label>
      <form onSubmit={event => {
        event.preventDefault();
        const id = selectedEdge?.id ?? crypto.randomUUID();
        if (edit.commit(current => selectedEdge === undefined
          ? addEdge(current, source, target, type, id)
          : updateEdge(current, selectedEdge.id, { source, target, type }))) setEdgeId(id);
      }}>
        <label className="workspace-edit-field">{messages.editor.sourceNode}
          <select value={source} onChange={event => setSource(event.target.value)}>
            {graph.nodes.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}
          </select>
        </label>
        <label className="workspace-edit-field">{messages.editor.targetNode}
          <select value={target} onChange={event => setTarget(event.target.value)}>
            {graph.nodes.map(node => <option key={node.id} value={node.id}>{node.title}</option>)}
          </select>
        </label>
        <label className="workspace-edit-field">{messages.editor.relationType}
          <select value={type} onChange={event => setType(event.target.value === "recommended_next" ? "recommended_next" : "related_to")}>
            <option value="related_to">{messages.graph.edgeLabels.related_to}</option>
            <option value="recommended_next">{messages.graph.edgeLabels.recommended_next}</option>
          </select>
        </label>
        <button type="submit" disabled={!source || !target}>{selectedEdge === undefined ? messages.editor.addConnection : messages.editor.saveConnection}</button>
        {selectedEdge === undefined ? null : <button type="button" onClick={() => {
          if (edit.commit(current => deleteEdge(current, selectedEdge.id))) setEdgeId("");
        }}>{messages.editor.deleteConnection}</button>}
      </form>
    </fieldset>
    <EditNotice problem={edit.problem} language={language} />
  </details>;
}
