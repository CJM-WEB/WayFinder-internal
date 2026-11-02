/** 组件职责：切换本地搜索图记录；记录操作只修改工作区，不触发搜索。 */
import type { SearchLanguage } from "@wayfinder/contracts";
import { useState } from "react";
import { useStore } from "zustand";

import { getMessages } from "../../i18n/messages.js";
import { workspaceStore } from "../../stores/workspace-store.js";
import { workspacePersistenceStore } from "../../stores/workspace-persistence.js";

export function WorkspaceSidebar({ language }: { language: SearchLanguage }) {
  const documents = useStore(workspaceStore, state => state.documents);
  const currentId = useStore(workspaceStore, state => state.currentId);
  const deletedCount = useStore(workspaceStore, state => state.deletedGraphs.length);
  const persistence = useStore(workspacePersistenceStore, state => state);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const messages = getMessages(language).workspace;
  const disabled = persistence.status === "loading" || persistence.error === "load";
  const actions = workspaceStore.getState();

  return (
    <aside className="workspace-sidebar" aria-label={messages.records}>
      <h2>{messages.records}</h2>
      <button type="button" disabled={disabled} onClick={() => actions.selectGraph(null)}>
        {messages.newSearch}
      </button>
      {documents.length === 0 ? <p>{messages.emptyRecords}</p> : null}
      <ul className="workspace-records">
        {documents.map(document => (
          <li key={document.id}>
            <button
              className="workspace-record__select"
              type="button"
              disabled={disabled}
              aria-pressed={document.id === currentId}
              onClick={() => actions.selectGraph(document.id)}
            >
              {document.title}
            </button>
            {editingId === document.id ? (
              <form onSubmit={event => {
                event.preventDefault();
                const trimmed = title.trim();
                if (trimmed.length === 0) return;
                actions.renameGraph(document.id, trimmed);
                setEditingId(null);
              }}>
                <input aria-label={messages.titleLabel} value={title} onChange={event => setTitle(event.target.value)} autoFocus />
                <button type="submit" disabled={disabled || title.trim().length === 0}>{messages.saveTitle}</button>
                <button type="button" onClick={() => setEditingId(null)}>{messages.cancel}</button>
              </form>
            ) : (
              <div className="workspace-record__actions">
                <button type="button" disabled={disabled} onClick={() => { setTitle(document.title); setEditingId(document.id); }}>
                  {messages.rename}
                </button>
                <button type="button" disabled={disabled} onClick={() => actions.deleteGraph(document.id)}>{messages.delete}</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <button type="button" disabled={disabled || deletedCount === 0} onClick={() => actions.restoreDeletedGraph()}>
        {messages.restoreDeleted}
      </button>
      {persistence.error === null ? (
        <p className="workspace-storage-status" role="status">
          {persistence.status === "loading" ? messages.loading : persistence.status === "saving" ? messages.saving : messages.saved}
        </p>
      ) : (
        <div role="alert" className="workspace-storage-error">
          <p>{persistence.error === "load" ? messages.loadFailure : messages.saveFailure}</p>
          <button type="button" onClick={() => { void persistence.retry(); }}>{messages.retry}</button>
        </div>
      )}
    </aside>
  );
}
