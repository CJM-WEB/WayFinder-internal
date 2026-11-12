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
import { selectCurrentGraph } from "../stores/workspace-store.js";
import { activeWorkspaceStore as workspaceStore, workspaceContextStore } from "../stores/workspace-context.js";
import { groupSearch } from "../api/group-search.js";
import { getGroupMessages, groupErrorMessage } from "../i18n/group-messages.js";
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
  const personalResearch = useStore(researchStore, state => state);
  const groupState = useStore(groupSearch.store, state => state);
  const context = useStore(workspaceContextStore, state => state);
  const groupMode = context.kind === "group";
  const groupPreview = groupState.autoApply && groupState.error === null ? null : groupState.preview;
  const applyGroup = (mode: "append" | "replace"): void => {
    if (!context.writable || context.busy || context.failedAction !== null || groupState.applying) return;
    const confirmed = groupState.error === "GROUP_CONFLICT";
    if (confirmed && !window.confirm(getGroupMessages(language).searchConfirm)) return;
    void groupSearch.apply(mode, confirmed);
  };
  const research = groupMode ? { preview: groupPreview, inputError: null, runStore: groupSearch.runStore,
    cancel: groupSearch.cancel, cancelPending: groupSearch.cancelPending, dismiss: groupSearch.dismiss, apply: applyGroup } : personalResearch;
  const currentPreview = (): ResearchPreview | null => {
    if (!groupMode) return researchStore.getState().preview;
    const latest = groupSearch.store.getState(); return latest.autoApply && latest.error === null ? null : latest.preview;
  };
  const { preview,inputError } = research;
  const selectedNodeId = useStore(research.runStore, state => state.selectedNodeId);
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
  // 页面卸载时也释放纯人工图的待检查意图和运行，不依赖前台搜索是否曾加载取消回调。
  useEffect(() => () => { researchStore.getState().cancel(); groupSearch.cancel(); }, []);
  const notice = useMemo(() => !active || suspended ? null : groupMode
    ? groupState.error === null ? null : { message: groupErrorMessage(groupState.error, language) }
    : inputError === null ? null : { message: inputError === "target" ? getMessages(language).research.missingTarget : getMessages(language).research.invalidInput },
  [active,suspended,inputError,language,groupMode,groupState.error]);

  useLayoutEffect(() => {
    const previous = previousGraphId.current;
    previousGraphId.current = graphId;
    if (!groupMode) clearRetiredResearchInput(previous,graphId,personalResearch);
  }, [graphId,personalResearch,groupMode]);
  useLayoutEffect(() => {
    if (requested !== null && previousFocus.current === null && document.activeElement instanceof HTMLElement) previousFocus.current = document.activeElement;
  }, [requested]);
  useLayoutEffect(() => { onVisibilityChange?.(valid); }, [valid,onVisibilityChange]);
  useEffect(() => {
    // 纯人工图首次重搜可能仍停在资格检查，尚无preview可供下面的身份门禁识别。
    if (!active) research.cancelPending();
    // 目标失效时取消；精确核对当前对象，旧 effect 不能误取消后来建立的新预览。
    if ((preview !== null && !valid && currentPreview() === preview) ||
      (!active && inputError !== null && !groupMode && researchStore.getState().inputError === inputError)) research.cancel();
  }, [preview,valid,active,inputError,groupMode]);

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
    if (interactive && shownPreview !== undefined && currentPreview() === shownPreview) {
      research.runStore.getState().selectNode(nodeId);
    }
  }, [interactive,shownPreview,groupMode]);
  if (shown === null) return <InkNotice notice={notice} />;
  const owned = (): boolean => interactive && currentPreview() === shown.preview;
  const close = (): void => {
    if (!owned()) return;
    if (shown.preview.status === "searching") research.cancel();
    else research.dismiss();
  };
  return <><InkNotice notice={notice} /><div className="ink-research-preview" data-ink-overlay data-ink-control data-open={presence.open}
    data-research-status={shown.preview.status} data-research-graph={shown.preview.graphId}
    inert={!interactive} aria-hidden={!interactive}>
    <div className="ink-research-preview__surface" ref={surface} role="dialog"
      aria-label={getMessages(language).research.preview} tabIndex={-1} onKeyDown={event => {
        if (!interactive) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
      }}>
      <ResearchPreviewView language={language} preview={shown.preview} selectedNodeId={shown.selectedNodeId} disabled={!interactive} applyDisabled={groupMode && (!context.writable || context.busy || context.failedAction !== null || groupState.applying)} idPrefix={idPrefix}
        onSelectNode={selectNode}
        onCancel={() => { if (owned()) research.cancel(); }}
        onDismiss={() => { if (owned()) research.dismiss(); }}
        onApply={mode => { if (owned()) research.apply(mode); }} />
    </div>
  </div></>;
}
