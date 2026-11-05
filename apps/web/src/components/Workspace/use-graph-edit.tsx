/**
 * 模块职责：共享确定性编辑的安全错误分类与提交边界，不承载旧版编辑表单。
 * 失败路径：仅显示已分类的本地化提示，内部异常正文不会泄露到产品界面。
 */
import type { EditableGraph, SearchLanguage } from "@wayfinder/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getMessages } from "../../i18n/messages.js";
import { DuplicateResourceUrlError, InvalidResourceUrlError, InvalidGraphConnectionError } from "../../stores/workspace-edits.js";
import { workspaceStore } from "../../stores/workspace-store.js";

type EditProblem = { message: string; nodeId: string | null };
type EditFailure = Readonly<{ graphId: string | null; kind: "duplicate" | "url" | "connection" | "edit"; nodeId: string | null; nodeTitle?: string }>;

/** 将已分类的输入错误转为本地化提示，不把内部异常正文泄露给界面。 */
export function useGraphEdit(graphId: string | null, language: SearchLanguage) {
  const [failure, setFailure] = useState<EditFailure | null>(null);
  const messages = getMessages(language).editor;
  // 保存安全分类而非冻结某种语言的句子，切换界面语言后错误与定位操作仍一致。
  const problem = useMemo<EditProblem | null>(() => failure === null || failure.graphId !== graphId ? null : ({ nodeId: failure.nodeId,
    message: failure.kind === "duplicate" ? messages.duplicateUrl(failure.nodeTitle ?? "")
      : failure.kind === "url" ? messages.invalidUrl : failure.kind === "connection" ? messages.invalidConnection : messages.editFailure,
  }), [failure, graphId, messages]);
  const clearProblem = useCallback(() => setFailure(null), []);
  useEffect(() => { setFailure(null); }, [graphId]);
  const execute = (operation: () => void): boolean => {
    try {
      operation();
      setFailure(null);
      return true;
    } catch (error: unknown) {
      setFailure(error instanceof DuplicateResourceUrlError
        ? { graphId, kind: "duplicate", nodeTitle: error.nodeTitle, nodeId: error.nodeId }
        : { graphId, kind: error instanceof InvalidResourceUrlError ? "url" : error instanceof InvalidGraphConnectionError ? "connection" : "edit", nodeId: null });
      return false;
    }
  };
  const commit = (edit: (graph: EditableGraph) => EditableGraph): boolean => execute(() => {
    const state = workspaceStore.getState();
    const graph = state.documents.find(document => document.id === graphId);
    if (graph === undefined) throw new Error("搜索图已不存在");
    state.replaceGraph(edit(graph));
  });
  return { problem, execute, commit, clearProblem };
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
