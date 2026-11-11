/** 云同步状态与明确导入入口共用既有胶囊；冲突操作始终由用户选择，Key不在此流程。 */
import { useState } from "react";
import { useStore } from "zustand";
import type { SearchLanguage } from "@wayfinder/contracts";
import { accountStore } from "../stores/account.js";
import { cloudWorkspaceStore } from "../stores/cloud-workspace.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { getMessages } from "../i18n/messages.js";

export function InkCloudSync({ language, allowImport = false }: Readonly<{ language: SearchLanguage; allowImport?: boolean }>) {
  const account = useStore(accountStore, state => state.account);
  const cloud = useStore(cloudWorkspaceStore, state => state);
  const workspace = useStore(workspaceStore, state => state);
  const [confirm, setConfirm] = useState(false);
  const text = getMessages(language).cloud;
  if (account === null) return null;
  return <section className="ink-cloud-sync" aria-label={text.title}>
    <p className="ink-settings__hint" role={cloud.status === "error" || cloud.status === "offline" ? "alert" : "status"}>{text.statuses[cloud.status]}</p>
    {cloud.status === "offline" || cloud.status === "error" ? <button type="button" className="ink-study__pill" onClick={() => { void cloud.retry(); }}>{text.retry}</button> : null}
    {cloud.conflicts.map(id => {
      const title = workspace.documents.find(document => document.id === id)?.title ?? workspace.deletedGraphs.find(item => item.document.id === id)?.document.title ?? id;
      return <div key={id} className="ink-settings__hint"><p>{title} · {text.conflict}</p>
        <div className="ink-settings__actions"><button type="button" className="ink-study__pill" disabled={cloud.status === "loading" || cloud.importing} onClick={() => { void cloud.reload(id); }}>{text.reload}</button>
          <button type="button" className="ink-study__pill" disabled={cloud.status === "loading" || cloud.importing} onClick={() => { void cloud.copy(id); }}>{text.copy}</button></div>
      </div>;
    })}
    {allowImport ? <div className="ink-settings__hint">
      {cloud.pending || cloud.importBlocked ? <p>{text.importBlocked}</p> : null}
      {!confirm ? <button type="button" className="ink-study__pill" disabled={cloud.importing || cloud.pending || cloud.status === "saving" || cloud.status === "loading"} onClick={() => setConfirm(true)}>{text.import}</button> : <>
        <p>{text.importNotice}</p><div className="ink-settings__actions">
          <button type="button" className="ink-study__pill" disabled={cloud.importing || cloud.pending} onClick={() => { void cloud.importGuest().then(() => { if (!cloudWorkspaceStore.getState().importBlocked) setConfirm(false); }); }}>{text.confirmImport}</button>
          <button type="button" className="ink-study__pill" disabled={cloud.importing} onClick={() => setConfirm(false)}>{getMessages(language).settings.cancel}</button>
        </div>
      </>}
    </div> : null}
  </section>;
}
