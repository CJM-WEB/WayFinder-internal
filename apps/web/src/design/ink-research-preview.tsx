/**
 * 模块职责：为既有重搜预览提供墨迹页覆盖层，完整保留退场内容，不复制临时 Run 或应用逻辑。
 * 所有权：离开探索、切图或删除目标才取消；查看历史仅挂起呈现，请求与结果继续保留。
 */
import type { SearchLanguage } from "@wayfinder/contracts";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";

import { researchStore, type ResearchPreview } from "../api/research.js";
import { ResearchPreviewView } from "../components/Workspace/WorkspaceResearchPreview.js";
import { getMessages } from "../i18n/messages.js";
import { selectCurrentGraph, workspaceStore } from "../stores/workspace-store.js";
import { useInkPresence } from "./ink-presence.js";
import { InkNotice } from "./ink-notice.js";
import "./ink-research-preview.css";

export type InkResearchPreviewProps = Readonly<{
  language: SearchLanguage;
  active?: boolean;
  suspended?: boolean;
  /** 报告有效预览的存在，挂起期间仍为 true，供主图隔离编辑与隐藏主资源条。 */
  onVisibilityChange?: (open: boolean) => void;
}>;
type PreviewSnapshot = Readonly<{ preview: ResearchPreview; selectedNodeId: string | null }>;
const EXIT_MS = 420;
const FOCUSABLE = "button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";

/** 导航只清理尚无预览的旧输入提示；整份状态身份防止旧提交阶段误取消新请求或同码新错误。 */
export function clearRetiredResearchInput(previousGraphId: string | null, graphId: string | null, snapshot: ReturnType<typeof researchStore.getState>): void {
  if (previousGraphId !== graphId && snapshot.preview === null && snapshot.inputError !== null && researchStore.getState() === snapshot) snapshot.cancel();
}

export default function InkResearchPreview({ language, active = true, suspended = false, onVisibilityChange }: InkResearchPreviewProps) {
  const research = useStore(researchStore, state => state);
  const { preview,inputError } = research;
  const selectedNodeId = useStore(researchStore.getState().runStore, state => state.selectedNodeId);
  const documentGraph = useStore(workspaceStore, selectCurrentGraph);
  const graphId = documentGraph?.id ?? null;
  const previousGraphId = useRef(graphId);
  const valid = preview !== null && active && documentGraph?.id === preview.graphId &&
    (preview.nodeId === null || documentGraph.nodes.some(node => node.id === preview.nodeId));
  const requested = useMemo<PreviewSnapshot | null>(() => !valid || suspended || preview === null ? null
    : { preview,selectedNodeId }, [valid,suspended,preview,selectedNodeId]);
  const presence = useInkPresence(requested,EXIT_MS);
  const surface = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const idPrefix = `ink-research-${useId().replaceAll(":", "")}-`;
  const notice = useMemo(() => !active || suspended || inputError === null ? null
    : { message: inputError === "target" ? getMessages(language).research.missingTarget : getMessages(language).research.invalidInput },
  [active,suspended,inputError,language]);

  useLayoutEffect(() => {
    const previous = previousGraphId.current;
    previousGraphId.current = graphId;
    clearRetiredResearchInput(previous,graphId,research);
  }, [graphId,research]);
  useLayoutEffect(() => {
    if (requested !== null && previousFocus.current === null && document.activeElement instanceof HTMLElement) previousFocus.current = document.activeElement;
  }, [requested]);
  useLayoutEffect(() => { onVisibilityChange?.(valid); }, [valid,onVisibilityChange]);
  useEffect(() => {
    // 目标失效时取消；精确核对当前对象，旧 effect 不能误取消后来建立的新预览。
    if ((preview !== null && !valid && researchStore.getState().preview === preview) ||
      (!active && inputError !== null && researchStore.getState().inputError === inputError)) researchStore.getState().cancel();
  }, [preview,valid,active,inputError]);

  const present = presence.value !== null;
  useEffect(() => {
    if (present) return;
    const frame = requestAnimationFrame(() => {
      const target = previousFocus.current;
      if (target?.isConnected && target.closest("[inert]") === null) target.focus({ preventScroll: true });
      previousFocus.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [present]);
  useEffect(() => {
    if (!presence.open) return;
    (surface.current?.querySelector<HTMLElement>(FOCUSABLE) ?? surface.current)?.focus({ preventScroll: true });
  }, [presence.open]);

  const shown = presence.value;
  const shownPreview = shown?.preview;
  const interactive = presence.open && valid && !suspended && shownPreview === preview;
  /** 受控选择仅依赖预览身份与交互门禁，不能因 selectedNodeId 更新而重放旧选择事件。 */
  const selectNode = useCallback((nodeId: string | null): void => {
    if (interactive && shownPreview !== undefined && researchStore.getState().preview === shownPreview) {
      researchStore.getState().runStore.getState().selectNode(nodeId);
    }
  }, [interactive,shownPreview]);
  if (shown === null) return <InkNotice notice={notice} />;
  const owned = (): boolean => interactive && researchStore.getState().preview === shown.preview;
  const close = (): void => {
    if (!owned()) return;
    if (shown.preview.status === "searching") researchStore.getState().cancel();
    else researchStore.getState().dismiss();
  };
  return <><InkNotice notice={notice} /><div className="ink-research-preview" data-ink-overlay data-ink-control data-open={presence.open}
    data-research-status={shown.preview.status} data-research-graph={shown.preview.graphId}
    inert={!interactive} aria-hidden={!interactive}>
    <div className="ink-research-preview__surface" ref={surface} role="dialog"
      aria-label={getMessages(language).research.preview} tabIndex={-1} onKeyDown={event => {
        if (!interactive) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
      }}>
      <ResearchPreviewView language={language} preview={shown.preview} selectedNodeId={shown.selectedNodeId} disabled={!interactive} idPrefix={idPrefix}
        onSelectNode={selectNode}
        onCancel={() => { if (owned()) researchStore.getState().cancel(); }}
        onDismiss={() => { if (owned()) researchStore.getState().dismiss(); }}
        onApply={mode => { if (owned()) researchStore.getState().apply(mode); }} />
    </div>
  </div></>;
}
