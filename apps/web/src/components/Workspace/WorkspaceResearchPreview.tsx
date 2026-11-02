/**
 * 组件职责：复用现有图与资源展示预览，不复制编辑器，也不在预览阶段写入工作图。
 * 单节点提供追加与替换；全图只提供整体替换，取消与弃用均保留原图。
 */
import type { SearchLanguage } from "@wayfinder/contracts";
import { useMemo } from "react";
import { useStore } from "zustand";

import { researchStore } from "../../api/research.js";
import { getMessages } from "../../i18n/messages.js";
import { fromResultGraph } from "../../stores/workspace-store.js";
import { GraphView } from "../Graph/GraphView.js";
import { ResourcePanelView, buildResourcePanelModel } from "../ResourcePanel/ResourcePanel.js";

export function WorkspaceResearchPreview({ language }: { language: SearchLanguage }) {
  const preview = useStore(researchStore, state => state.preview);
  const runtime = useStore(researchStore.getState().runStore, state => state);
  const document = useMemo(() => {
    if (preview?.result === null || preview?.result === undefined) return null;
    const converted = fromResultGraph(preview.result, preview.graphId);
    return { ...converted, nodes: converted.nodes.map(node => ({ ...node, resources: node.resources.slice(0, 6) })) };
  }, [preview?.result, preview?.graphId]);
  const messages = getMessages(language).research;
  if (preview === null) return null;
  const node = preview.nodeId === null
    ? document?.nodes.find(item => item.id === runtime.selectedNodeId) ?? null
    : document?.nodes.find(item => item.id === preview.nodeId) ?? null;
  return <section className="workspace-research-preview" aria-label={messages.preview}>
    <header>
      <h2>{messages.preview}</h2>
      <p>{messages.queryLabel}：{preview.query}</p>
    </header>
    {preview.status === "searching" ? <>
      <p role="status">{messages.searching}</p>
      <button type="button" onClick={() => researchStore.getState().cancel()}>{messages.cancel}</button>
    </> : preview.status === "failed" ? <>
      <p role="alert">{messages.failure}</p>
      <button type="button" onClick={() => researchStore.getState().dismiss()}>{messages.dismiss}</button>
    </> : <>
      <p>{preview.nodeId === null ? messages.fullHint : messages.nodeHint}</p>
      <div className="workspace-edit-actions">
        <button type="button" onClick={() => researchStore.getState().dismiss()}>{messages.dismiss}</button>
        {preview.nodeId === null ? null : <button type="button" onClick={() => researchStore.getState().apply("append")}>{messages.append}</button>}
        <button type="button" onClick={() => researchStore.getState().apply("replace")}>{messages.replace}</button>
      </div>
      {document === null ? null : <div className={`workspace-preview-content${preview.nodeId === null ? " workspace-preview-content--graph" : ""}`}>
        {preview.nodeId === null ? <GraphView
          flowId={`preview-${preview.runId ?? "pending"}`} language={language} presentationMode={document.presentationMode} graph={document}
          selectedNodeId={runtime.selectedNodeId} onSelectNode={runtime.selectNode}
        /> : null}
        <ResourcePanelView idPrefix={`preview-${preview.runId ?? "pending"}-`} model={buildResourcePanelModel(node, language)} />
      </div>}
    </>}
  </section>;
}
