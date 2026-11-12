/**
 * 组件职责：复用现有图与资源展示预览，不复制编辑器，也不在预览阶段写入工作图。
 * 单节点提供追加与替换；全图只提供整体替换，取消与弃用均保留原图。
 */
import type { SearchLanguage } from "@wayfinder/contracts";
import { useMemo } from "react";

import type { ResearchPreview } from "../../api/research.js";
import { getMessages } from "../../i18n/messages.js";
import { fromResultGraph } from "../../stores/workspace-store.js";
import { GraphView } from "../Graph/GraphView.js";
import { ResourcePanelView, buildResourcePanelModel } from "../ResourcePanel/ResourcePanel.js";

export type ResearchPreviewViewProps = Readonly<{
  language: SearchLanguage;
  preview: ResearchPreview;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  onCancel: () => void;
  onDismiss: () => void;
  onApply: (mode: "append" | "replace") => void;
  disabled?: boolean;
  applyDisabled?: boolean;
  idPrefix?: string;
}>;

/** 退场仍保留受控画布，但禁用阶段不能回写临时选择；空操作也保持稳定身份。 */
const ignoreSelection = (): void => {};

/** 纯呈现入口共享原图/资源模型；操作由调用方绑定原 store，不复制搜索、校验或应用流程。 */
export function ResearchPreviewView({ language, preview, selectedNodeId, onSelectNode, onCancel, onDismiss, onApply,
  disabled = false, applyDisabled = false, idPrefix = "" }: ResearchPreviewViewProps) {
  const document = useMemo(() => {
    if (preview.result === null) return null;
    const converted = fromResultGraph(preview.result, preview.graphId);
    return { ...converted, nodes: converted.nodes.map(node => ({ ...node, resources: node.resources.slice(0, 6) })) };
  }, [preview.result, preview.graphId]);
  const messages = getMessages(language).research;
  const node = preview.nodeId === null
    ? document?.nodes.find(item => item.id === selectedNodeId) ?? null
    : document?.nodes.find(item => item.id === preview.nodeId) ?? null;
  const prefix = `${idPrefix}preview-${preview.runId ?? "pending"}`;
  return <section className="workspace-research-preview" aria-label={messages.preview} inert={disabled}>
    <header>
      <h2>{messages.preview}</h2>
      <p>{messages.queryLabel}：{preview.query}</p>
    </header>
    {preview.status === "searching" ? <>
      <p role="status">{messages.searching}</p>
      <button type="button" disabled={disabled} onClick={() => { if (!disabled) onCancel(); }}>{messages.cancel}</button>
    </> : preview.status === "failed" ? <>
      <p role="alert">{messages.failure}</p>
      <button type="button" disabled={disabled} onClick={() => { if (!disabled) onDismiss(); }}>{messages.dismiss}</button>
    </> : <>
      <p>{preview.nodeId === null ? messages.fullHint : messages.nodeHint}</p>
      <div className="workspace-edit-actions">
        <button type="button" disabled={disabled} onClick={() => { if (!disabled) onDismiss(); }}>{messages.dismiss}</button>
        {preview.nodeId === null ? null : <button type="button" disabled={disabled || applyDisabled} onClick={() => { if (!disabled && !applyDisabled) onApply("append"); }}>{messages.append}</button>}
        <button type="button" disabled={disabled || applyDisabled} onClick={() => { if (!disabled && !applyDisabled) onApply("replace"); }}>{messages.replace}</button>
      </div>
      {document === null ? null : <div className={`workspace-preview-content${preview.nodeId === null ? " workspace-preview-content--graph" : ""}`}>
        {preview.nodeId === null ? <GraphView
          flowId={prefix} language={language} presentationMode={document.presentationMode} graph={document} interactionReady={!disabled}
          // React Flow 的选择监听依赖回调身份；选择变化不能重绑监听并重放上一帧选择。
          selectedNodeId={selectedNodeId} onSelectNode={disabled ? ignoreSelection : onSelectNode}
        /> : null}
        <ResourcePanelView idPrefix={`${prefix}-`} model={buildResourcePanelModel(node, language)}
          {...(disabled ? { openResource: () => null } : {})} />
      </div>}
    </>}
  </section>;
}
