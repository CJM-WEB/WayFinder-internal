/**
 * 小组抽屉：复用现有信息条／父抽屉，分层呈现小组列表与组内动作。
 * 读取只按当前账号展示；所有组图动作由工作区适配层发送，管理动作复用已追平连接门禁。
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useStore } from "zustand";
import type { GroupAction, GroupDetails, GroupSummary, SearchLanguage } from "@wayfinder/contracts";
import { groupApi, GroupRequestError } from "../api/groups.js";
import { accountStore } from "../stores/account.js";
import { accountProfileStore } from "../stores/account-profile.js";
import { groupSync } from "../stores/group-sync.js";
import { workspaceStore } from "../stores/workspace-store.js";
import { activeWorkspaceStore, workspaceContext, workspaceContextStore } from "../stores/workspace-context.js";
import "./ink-groups.css";
import { getMessages } from "../i18n/messages.js";
import { getGroupMessages, groupConnectionLabel, groupErrorMessage } from "../i18n/group-messages.js";

type Props = { open: boolean; presented: boolean; available: boolean; language: SearchLanguage;
  onClose: (restoreFocus: boolean) => void; onOpenSettings: () => void; onSelectGraph: (id: string) => void | Promise<void>; onNewSearch: () => void };
function GroupCard({ group, details, selected, language, reveal, enter }: { group: GroupSummary; details: GroupDetails | undefined;
  selected: boolean; language: SearchLanguage; reveal: () => void; enter: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const card = useRef<HTMLLIElement>(null), pointerHeld = useRef(false), collapsePending = useRef(false), touchInput = useRef(false);
  // 外部按钮在按下时先获得焦点；等本次点击完成再收起，避免布局移动吞掉点击。
  useEffect(() => {
    let collapseTimer: ReturnType<typeof setTimeout> | undefined;
    const down = (): void => { pointerHeld.current = true; };
    const up = (): void => {
      pointerHeld.current = false;
      if (!collapsePending.current) return;
      collapsePending.current = false;
      collapseTimer = setTimeout(() => {
        if (!card.current?.contains(document.activeElement) && !card.current?.matches(":hover")) setExpanded(false);
      }, 0);
    };
    document.addEventListener("pointerdown", down, true); document.addEventListener("pointerup", up, true); document.addEventListener("pointercancel", up, true);
    return () => {
      clearTimeout(collapseTimer); document.removeEventListener("pointerdown", down, true); document.removeEventListener("pointerup", up, true); document.removeEventListener("pointercancel", up, true);
    };
  }, []);
  const labels = getGroupMessages(language);
  return <li ref={card} className="ink-study__history-record ink-group-record" data-expanded={expanded} data-selected={selected} data-group-id={group.groupId} tabIndex={0}
    aria-label={`${group.name} · ${labels.members}`}
    onPointerDown={event => { touchInput.current = event.pointerType === "touch"; }}
    onPointerUp={event => {
      // 触屏点空白处后把焦点留在信息条；兼容鼠标离开事件不能立即收起刚展开的成员。
      if (event.pointerType === "touch" && !(event.target instanceof Element && event.target.closest("button"))) {
        card.current?.focus({ preventScroll: true }); setExpanded(true); reveal();
      }
    }}
    onMouseEnter={() => { setExpanded(true); reveal(); }} onMouseLeave={event => {
      if (!touchInput.current && !event.currentTarget.matches(":focus-visible") && event.currentTarget.querySelector(":focus-visible") === null) setExpanded(false);
    }} onFocusCapture={() => { setExpanded(true); reveal(); }} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        touchInput.current = false;
        if (pointerHeld.current) collapsePending.current = true;
        else setExpanded(false);
      }
    }}>
    <div className="ink-group-record__heading"><div><h3><button className="ink-study__history-title" type="button" onClick={enter}
      aria-expanded={expanded} aria-label={`${labels.open}：${group.name}`}>{group.name}</button></h3><p>{group.description}</p></div></div>
    <div className="ink-group-record__members" aria-hidden={!expanded} inert={!expanded}><div>
      {details === undefined ? <p>{labels.working}</p> : <ul aria-label={labels.members}>{details.members.map(member => <li key={member.userId}>
        <span>{member.nickname}</span>{member.role === "owner" ? <small>{labels.owner}</small> : null}
      </li>)}</ul>}
    </div></div>
  </li>;
}

export function InkGroups({ open, presented, available, language, onClose, onOpenSettings, onSelectGraph, onNewSearch }: Props) {
  const account = useStore(accountStore, state => state.account), accountEpoch = useStore(accountStore, state => state.epoch);
  const context = useStore(workspaceContextStore, state => state), sync = useStore(groupSync.store, state => state);
  const documents = useStore(activeWorkspaceStore, state => state.documents), currentId = useStore(activeWorkspaceStore, state => state.currentId);
  const personal = useStore(workspaceStore, state => state.documents);
  const labels = getGroupMessages(language), common = getMessages(language);
  const panel = useRef<HTMLElement>(null);
  const profile = useStore(accountProfileStore, state => state);
  const savedNickname = profile.userId === account?.userId ? profile.nickname : null;
  const profileError = profile.userId === account?.userId ? profile.error : null;
  const lifetime = useRef(new AbortController()), requests = useRef(new Map<string, AbortController>());
  // 已确认写入使更早的列表读取作废，避免迟到读取覆盖刚保存的状态。
  const readIntent = useRef(0);
  const operation = useRef<GroupAction | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null), [groups, setGroups] = useState<GroupSummary[]>([]);
  const [details, setDetails] = useState<Record<string, GroupDetails>>({});
  // 返回列表只切换面板视图，保留当前组图；选择其他小组才切换业务上下文。
  const [showList, setShowList] = useState(false);
  const inGroup = context.kind === "group" && !showList;
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<"success" | null>(null);
  const [mode, setMode] = useState<"create" | "join" | "update" | null>(null);
  const [name, setName] = useState(""), [description, setDescription] = useState(""), [invitation, setInvitation] = useState("");
  const [editingGroup, setEditingGroup] = useState<{ groupId: string; revision: number } | null>(null);
  const [source, setSource] = useState("");
  const renameCapture = useRef<ReturnType<typeof workspaceContext.captureEdit>>(null);
  const [renameId, setRenameId] = useState<string | null>(null), [renameTitle, setRenameTitle] = useState("");
  const [copyNotice, setCopyNotice] = useState<"copied" | "failed" | null>(null);
  const browserOnline = typeof navigator === "undefined" || navigator.onLine;
  const scopeMatches = account !== null && loadedFor === account.userId;
  const selected = context.kind === "group" && sync.groupId === context.groupId && sync.userId === account?.userId ? sync.snapshot?.details : undefined;
  const writable = browserOnline && selected !== undefined && context.writable && !context.busy && context.failedAction === null && !busy;
  const owner = selected?.group.ownerUserId === account?.userId;
  const active = open && available;
  const stillCurrent = (userId: string, epoch: number): boolean => accountStore.getState().account?.userId === userId && accountStore.getState().epoch === epoch;
  const fail = (caught: unknown): void => setError(caught instanceof GroupRequestError ? caught.code : "GROUP_UNAVAILABLE");
  const refresh = useCallback(async (): Promise<void> => {
    const identity = accountStore.getState(); if (identity.account === null) return;
    const { userId } = identity.account, epoch = identity.epoch, signal = lifetime.current.signal, currentRead = ++readIntent.current;
    try {
      // 资料读取由共享状态独立报告；设置打开会取消旧读取，不能把该取消误记成小组列表失败。
      const [list] = await Promise.all([groupApi.list(userId, signal), accountProfileStore.getState().refresh(signal).catch(() => {})]);
      if (!stillCurrent(userId, epoch) || signal.aborted || currentRead !== readIntent.current) return;
      setLoadedFor(userId); setGroups(list.groups); setDetails({});
    } catch (caught: unknown) { if (stillCurrent(userId, epoch) && !signal.aborted && currentRead === readIntent.current) fail(caught); }
  }, []);
  useEffect(() => {
    ++readIntent.current; lifetime.current.abort(); lifetime.current = new AbortController(); for (const controller of requests.current.values()) controller.abort(); requests.current.clear();
    operation.current = null; setLoadedFor(null); setGroups([]); setDetails({}); setShowList(false);
    setMode(null); setError(null); setNotice(null); setBusy(false); setCopyNotice(null); setRenameId(null);
    return () => { lifetime.current.abort(); for (const controller of requests.current.values()) controller.abort(); };
  }, [accountEpoch]);
  useEffect(() => { if (active && account !== null) void refresh(); }, [active, account?.userId, accountEpoch, refresh]);
  useEffect(() => {
    if (selected === undefined || !scopeMatches) return;
    setDetails(previous => ({ ...previous, [selected.group.groupId]: selected }));
    setGroups(previous => previous.map(group => group.groupId === selected.group.groupId ? selected.group : group));
  }, [selected, scopeMatches]);
  useEffect(() => { setShowList(false); setRenameId(null); setMode(previous => previous === "update" ? null : previous); setEditingGroup(null); setCopyNotice(null); }, [context.groupId]);
  useEffect(() => { if (open && presented) panel.current?.focus({ preventScroll: true }); }, [open, presented]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event): void => {
      if (!(event.target instanceof Element) || panel.current?.contains(event.target) || event.target.closest(".ink-study__history-dock, [data-ink-group-notice]")) return;
      onClose(false);
    };
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(true); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("focusin", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); document.removeEventListener("keydown", escape); };
  }, [open, onClose]);
  const reveal = async (groupId: string): Promise<void> => {
    if (account === null || !scopeMatches || details[groupId] !== undefined || requests.current.has(groupId)) return;
    const userId = account.userId, epoch = accountEpoch, controller = new AbortController(); requests.current.set(groupId, controller);
    try {
      const value = await groupApi.details(userId, groupId, AbortSignal.any([controller.signal, lifetime.current.signal]));
      if (stillCurrent(userId, epoch) && !controller.signal.aborted) setDetails(previous => ({ ...previous, [groupId]: value }));
    } catch (caught: unknown) { if (stillCurrent(userId, epoch) && !controller.signal.aborted) fail(caught); }
    finally { if (requests.current.get(groupId) === controller) requests.current.delete(groupId); }
  };
  /** 管理动作确认未知时保留原标识；退出／解散可从当前列表核实，不依赖旧连接继续授权。 */
  const manage = async (input: GroupAction): Promise<void> => {
    if (account === null || busy) return;
    if (!browserOnline) { setError("GROUP_OFFLINE"); return; }
    const userId = account.userId, epoch = accountEpoch, key = workspaceContextStore.getState().contextKey; operation.current ??= input;
    const action = operation.current; ++readIntent.current; setBusy(true); setError(null); setNotice(null);
    try {
      const value = action.action === "create" || action.action === "join"
        ? await groupApi.manage(userId, action, lifetime.current.signal) : await groupSync.manage(action);
      if (!stillCurrent(userId, epoch)) return;
      operation.current = null; setGroups(value.groups);
      if (workspaceContextStore.getState().contextKey !== key) return;
      setMode(null); setNotice("success");
      if (action.action === "leave" || action.action === "dissolve") workspaceContext.leaveGroup();
      else if (value.details !== null && (context.kind !== "group" || context.groupId !== value.details.group.groupId)) workspaceContext.enterGroup(userId, value.details.group.groupId);
    } catch (caught: unknown) {
      if (!stillCurrent(userId, epoch)) return;
      const code = caught instanceof GroupRequestError ? caught.code : "GROUP_UNAVAILABLE";
      if (action.action === "leave" || action.action === "dissolve") {
        try {
          const current = await groupApi.list(userId, lifetime.current.signal);
          if (stillCurrent(userId, epoch) && !current.groups.some(group => group.groupId === action.groupId)) {
            operation.current = null; setGroups(current.groups);
            // 旧组的退出确认只能更新列表，不能把后来进入的另一小组也退出。
            if (workspaceContextStore.getState().contextKey === key) { workspaceContext.leaveGroup(); setMode(null); setNotice("success"); }
            return;
          }
        } catch { /* 结果未知保留原动作；不把网络失败说成已经退出或解散。 */ }
      }
      if (!["GROUP_UNAVAILABLE", "GROUP_OFFLINE"].includes(code)) operation.current = null;
      if (workspaceContextStore.getState().contextKey === key) setError(code);
    } finally { if (stillCurrent(userId, epoch)) setBusy(false); }
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault(); if (account === null || busy) return;
    if (mode !== "update" && savedNickname === null) { onOpenSettings(); return; }
    if (operation.current !== null) { void manage(operation.current); return; }
    const mutationId = crypto.randomUUID();
    if (mode === "create" && name.trim()) void manage({ action: "create", name, description, mutationId });
    else if (mode === "join" && invitation.trim()) void manage({ action: "join", invitationCode: invitation.trim(), mutationId });
    else if (mode === "update" && editingGroup !== null && name.trim() && writable) {
      const revision = selected?.group.revision;
      if (revision === undefined) return;
      if (revision !== editingGroup.revision && !window.confirm(labels.conflictConfirm)) return;
      void manage({ action: "update", groupId: editingGroup.groupId, expectedRevision: revision, name, description, mutationId });
    }
  };
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    const epoch = accountEpoch, userId = account?.userId, key = workspaceContextStore.getState().contextKey; if (userId === undefined || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { await action(); if (stillCurrent(userId, epoch) && workspaceContextStore.getState().contextKey === key) setNotice("success"); }
    catch (caught: unknown) { if (stillCurrent(userId, epoch) && workspaceContextStore.getState().contextKey === key) fail(caught); }
    finally { if (stillCurrent(userId, epoch)) setBusy(false); }
  };
  return <section className="ink-study__history-panel ink-groups-panel" ref={panel} tabIndex={-1} id="ink-groups"
    data-active={open} inert={!active} aria-hidden={!active} aria-labelledby="ink-groups-title" data-ink-overlay>
    <header className="ink-study__history-header"><div><h2 id="ink-groups-title">{labels.title}{inGroup ? ` · ${context.groupName ?? labels.working}` : ""}</h2>{inGroup ? null : <span>{scopeMatches ? groups.length : 0}</span>}</div>
      {inGroup ? <button className="ink-study__pill" type="button" onClick={() => { setShowList(true); setMode(null); void refresh(); }}>{labels.backToGroups}</button> : <div className="ink-group-actions"><button className="ink-study__pill" type="button" disabled={busy || !browserOnline || operation.current !== null || profile.loading} onClick={() => {
        if (account === null || savedNickname === null) { onOpenSettings(); return; }
        setMode("create"); setName(""); setDescription(""); setNotice(null);
      }}>{labels.create}</button><button className="ink-study__pill" type="button" disabled={busy || !browserOnline || operation.current !== null || profile.loading} onClick={() => {
        if (account === null || savedNickname === null) { onOpenSettings(); return; }
        setMode("join"); setInvitation(""); setNotice(null);
      }}>{labels.join}</button></div>}</header>
    {account === null ? <div className="ink-study__history-empty"><p>{labels.login}</p><button className="ink-study__pill" type="button" onClick={onOpenSettings}>{labels.settings}</button></div> : <>
      {mode === null ? null : <form className="ink-group-form" onSubmit={submit}>
        {mode === "join" ? <label>{labels.invitation}<input aria-label={labels.invitation} value={invitation} disabled={busy || operation.current !== null} onChange={event => setInvitation(event.target.value)} autoComplete="off" /></label> : <>
          <label>{labels.name}<input aria-label={labels.name} value={name} disabled={busy || operation.current !== null} onChange={event => setName(event.target.value)} /></label>
          <label>{labels.description}<textarea aria-label={labels.description} value={description} disabled={busy || operation.current !== null} onChange={event => setDescription(event.target.value)} /></label></>}
        <div className="ink-group-actions"><button className="ink-study__pill" type="submit" disabled={busy || !browserOnline || (mode !== "update" && savedNickname === null) || (mode === "update" && !writable)
          || (mode === "join" ? !invitation.trim() : !name.trim())}>{busy ? labels.working : operation.current !== null ? labels.retry : mode === "create" ? labels.create : mode === "join" ? labels.join : labels.save}</button>
          <button className="ink-study__pill" type="button" disabled={busy} onClick={() => { setMode(null); }}>{labels.cancel}</button></div>
      </form>}
      {error === null ? null : <p role="alert" data-ink-group-notice>{groupErrorMessage(error, language)}</p>}
      {profileError === null ? null : <p role="alert" data-ink-group-notice>{groupErrorMessage(profileError, language)}</p>}
      {operation.current === null ? null : <div data-ink-group-notice><p>{labels.unknown}</p><button className="ink-study__pill" type="button" disabled={busy}
        onClick={() => { if (operation.current !== null) void manage(operation.current); }}>{labels.retry}</button></div>}
      {context.error === null ? null : <p role="alert">{groupErrorMessage(context.error, language)}</p>}
      {context.failedAction === null ? null : <div className="ink-group-actions" data-ink-group-notice>
        <button className="ink-study__pill" type="button" disabled={context.busy || busy} onClick={() => { void run(() => workspaceContext.retryFailedAction()); }}>{context.failedAction.uncertain ? labels.confirmResult : labels.retry}</button>
        {context.failedAction.action.action !== "edit" || context.error !== "GROUP_CONFLICT" ? null : <button className="ink-study__pill" type="button" disabled={!context.writable || context.busy}
          onClick={() => { if (window.confirm(labels.conflictConfirm)) void workspaceContext.confirmFailedEdit().then(ok => { if (!ok) setError("GROUP_CONSTRAINT"); }).catch(fail); }}>{labels.keepMine}</button>}
        <button className="ink-study__pill" type="button" disabled={context.busy || context.failedAction.uncertain} title={context.failedAction.uncertain ? labels.unknown : undefined} onClick={() => workspaceContext.discardFailedAction()}>{labels.discard}</button>
      </div>}
      {notice === null ? null : <p role="status">{labels.success}</p>}
      {inGroup ? null : <>
        <div className="ink-group-actions"><button className="ink-study__pill" type="button" disabled={busy} onClick={() => { void refresh(); }}>{labels.refresh}</button></div>
        {savedNickname !== null || profile.loading || profileError !== null ? null : <p className="ink-group-nickname-hint">{labels.nicknameHint} <button type="button" className="ink-study__pill" onClick={onOpenSettings}>{labels.nicknameSettings}</button></p>}
        {scopeMatches && groups.length === 0 ? <p className="ink-study__history-empty">{labels.empty}</p> : null}
        <ul className="ink-study__history-list">{(scopeMatches ? groups : []).map(group => <GroupCard key={group.groupId} group={group} details={details[group.groupId]}
          language={language} selected={context.groupId === group.groupId} reveal={() => { void reveal(group.groupId); }} enter={() => {
            setShowList(false); setMode(null); setError(null); setNotice(null);
            // 返回列表保留了当前连接与组图；重进同组只切视图，避免清空快照后重连造成闪屏。
            if (context.kind !== "group" || context.groupId !== group.groupId || context.userId !== account.userId || sync.state !== "online") {
              workspaceContext.enterGroup(account.userId, group.groupId);
            }
          }} />)}</ul>
      </>}
      {!inGroup ? null : <div className="ink-group-workspace" data-group-id={context.groupId}>
        <p role="status" data-group-connection={sync.state}>{groupConnectionLabel(sync.state, language)}</p>
        {sync.state === "online" ? null : <button type="button" className="ink-study__pill" onClick={() => {
          if (account !== null && context.groupId !== null) groupSync.connect(account.userId, context.groupId);
        }}>{labels.reconnect}</button>}
        {/* 初连失败也保留返回个人图，避免移除画布重复入口后困在失联小组。 */}
        <div className="ink-group-actions"><button className="ink-study__pill" type="button" disabled={!writable} onClick={onNewSearch}>{labels.newSearch}</button>
          <button className="ink-study__pill" type="button" onClick={() => { workspaceContext.leaveGroup(); }}>{labels.personal}</button></div>
        {selected === undefined ? null : <>
          <header className="ink-group-selected"><h3>{selected.group.name}</h3><p>{selected.group.description}</p>
            <div className="ink-group-actions">{owner ? <><button className="ink-study__pill" type="button" disabled={!writable || operation.current !== null} onClick={() => {
              setMode("update"); setEditingGroup({ groupId: selected.group.groupId, revision: selected.group.revision }); setName(selected.group.name); setDescription(selected.group.description);
            }}>{labels.edit}</button><button className="ink-study__pill" type="button" disabled={!writable || operation.current !== null} onClick={() => {
              if (window.confirm(labels.dissolveConfirm)) void manage({ action: "dissolve", groupId: selected.group.groupId, expectedRevision: selected.group.revision, mutationId: crypto.randomUUID() });
            }}>{labels.dissolve}</button></> : <button className="ink-study__pill" type="button" disabled={!writable || operation.current !== null} onClick={() => {
              void manage({ action: "leave", groupId: selected.group.groupId, mutationId: crypto.randomUUID() });
            }}>{labels.leave}</button>}</div>
          </header>
          {owner && selected.invitationCode !== null ? <div className="ink-group-form"><label>{labels.invitation}<input aria-label={labels.invitation} value={selected.invitationCode} readOnly /></label>
            <button type="button" className="ink-study__pill" onClick={() => {
              const code = selected.invitationCode; if (code === null) return;
              const userId = account?.userId, epoch = accountEpoch, groupId = selected.group.groupId;
              void (async () => {
                try { await navigator.clipboard.writeText(code); if (userId !== undefined && stillCurrent(userId, epoch) && groupSync.store.getState().groupId === groupId) setCopyNotice("copied"); }
                catch { if (userId !== undefined && stillCurrent(userId, epoch)) setCopyNotice("failed"); }
              })();
            }}>{labels.copyCode}</button>{copyNotice === null ? null : <small role="status">{copyNotice === "copied" ? labels.copied : labels.copyFailed}</small>}</div> : null}
          <ul className="ink-study__history-list">{documents.map(document => <li className="ink-study__history-record" key={document.id}>
            <div className="ink-group-record__heading">{renameId === document.id ? <form className="ink-group-actions" onSubmit={event => {
              event.preventDefault(); if (!writable || !renameTitle.trim()) return;
              const capture = renameCapture.current;
              if (capture !== null) void workspaceContext.commitCaptured(capture, graph => ({ ...graph, title: renameTitle.trim() }), { kind: "graph.rename", subject: document.title })
                .then(ok => { if (ok && renameCapture.current === capture) setRenameId(null); }).catch(() => { /* 草稿与失败状态由上下文保留，表单继续显示供人员处理。 */ });
            }}><input aria-label={labels.renameGraph} value={renameTitle} onChange={event => setRenameTitle(event.target.value)} /><button className="ink-study__pill" type="submit" disabled={!writable}>{labels.save}</button></form>
              : <h3><button className="ink-study__history-title" type="button" aria-current={currentId === document.id ? "true" : undefined} onClick={() => { workspaceContext.selectGraph(document.id); void onSelectGraph(document.id); }}>{document.title}</button></h3>}
              <div className="ink-group-actions"><button className="ink-study__pill" type="button" disabled={!writable} aria-label={`${labels.renameGraph}：${document.title}`}
                onClick={() => { workspaceContext.selectGraph(document.id); renameCapture.current = workspaceContext.captureEdit(document.id); setRenameId(document.id); setRenameTitle(document.title); }}>{common.workspace.rename}</button>
                <button className="ink-study__pill" type="button" disabled={!writable} aria-label={`${labels.deleteGraph}：${document.title}`} onClick={() => activeWorkspaceStore.getState().deleteGraph(document.id)}>{common.workspace.delete}</button>
                <button className="ink-study__pill" type="button" disabled={!writable} onClick={() => { void run(() => workspaceContext.copyOut(document.id)); }}>{labels.copyOut}</button></div></div>
          </li>)}</ul>
          {documents.length === 0 ? <p>{labels.emptyGraphs}</p> : null}
          <div className="ink-group-form"><label>{labels.source}<select aria-label={labels.source} value={source} disabled={!writable} onChange={event => setSource(event.target.value)}>
            <option value="">{personal.length === 0 ? labels.noSource : labels.source}</option>{personal.map(document => <option key={document.id} value={document.id}>{document.title}</option>)}
          </select></label><button className="ink-study__pill" type="button" disabled={!writable || !source} onClick={() => { void run(async () => { const id = await workspaceContext.copyIn(source); await onSelectGraph(id); }); }}>{labels.copyIn}</button></div>
        </>}
      </div>}
    </>}
  </section>;
}
