/**
 * 面板职责：分别编辑本浏览器的两项凭据，并以明确确认接入作者体验资格。
 * 所有权：草稿与已保存值分离；异步请求绑定当前弹窗意图，取消、换服务或退场后不保存迟到响应。
 * 隐私：公告只按文本展示；邀请码只留在当前弹窗，浏览器资格由安全 Cookie 承载。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { MAX_API_KEY_LENGTH, MAX_INVITE_CODE_LENGTH, type CredentialService, type SearchLanguage } from "@wayfinder/contracts";

import { credentialsApi, CredentialsConfigurationError } from "../api/credentials.js";
import { getMessages } from "../i18n/messages.js";
import { credentialSettingsStore } from "../stores/credential-settings.js";
import { useInkPresence } from "./ink-presence.js";
import "./ink-settings.css";

type Preferences = ReturnType<typeof credentialSettingsStore.getState>["preferences"];
type Props = Readonly<{ open: boolean; presented: boolean; language: SearchLanguage; onClose: (restoreFocus: boolean) => void }>;
const SERVICES = ["deepseek", "serpapi"] as const;
const SERVICE_NAMES: Readonly<Record<CredentialService, string>> = { deepseek: "DeepSeek", serpapi: "SerpAPI" };

export function InkSettingsPanel({ open, presented, language, onClose }: Props) {
  const settings = useStore(credentialSettingsStore, state => state);
  const messages = getMessages(language);
  const text = messages.settings;
  const [draft, setDraft] = useState<Preferences>(settings.preferences);
  const [visible, setVisible] = useState<Readonly<Record<CredentialService, boolean>>>({ deepseek: false, serpapi: false });
  const [saved, setSaved] = useState<CredentialService | null>(null);
  const [trial, setTrial] = useState<CredentialService | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [trialError, setTrialError] = useState<string | null>(null);
  const trialPresence = useInkPresence(trial);
  const panel = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const intent = useRef(0);
  const request = useRef<AbortController | null>(null);

  const retireTrial = (): void => {
    ++intent.current;
    request.current?.abort(); request.current = null;
    setTrial(null); setInviteCode(""); setBusy(false); setTrialError(null);
  };
  const close = (restoreFocus: boolean): void => { retireTrial(); onClose(restoreFocus); };

  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      setDraft(settings.preferences); setSaved(null); setVisible({ deepseek: false, serpapi: false });
      panel.current?.focus({ preventScroll: true });
    }
    if (!open && wasOpen.current) retireTrial();
    wasOpen.current = open;
  }, [open, settings.preferences]);
  useEffect(() => () => { ++intent.current; request.current?.abort(); }, []);
  useEffect(() => {
    // 抽屉的视觉选择晚于业务开关；真正可见后再聚焦，保持与历史面板一致。
    if (open && presented && trial === null) panel.current?.focus({ preventScroll: true });
  }, [open, presented, trial]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event): void => {
      if (event.target instanceof Element && !panel.current?.contains(event.target) && !event.target.closest(".ink-study__history-dock")) close(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); };
  });
  useEffect(() => {
    if (trial !== null && trialPresence.open) dialog.current?.focus({ preventScroll: true });
  }, [trial, trialPresence.open]);

  const beginTrial = async (service: CredentialService): Promise<void> => {
    retireTrial();
    const current = ++intent.current, controller = new AbortController();
    request.current = controller;
    setTrial(service); setAnnouncement(""); setAvailable(false); setAuthorized(false); setBusy(true);
    try {
      const info = await credentialsApi.fetchSettings(controller.signal);
      if (intent.current !== current || controller.signal.aborted) return;
      setAnnouncement(info.announcement); setAvailable(info.experienceAvailable);
      if (!info.experienceAvailable) { setTrialError(text.unavailable); return; }
      const valid = await credentialsApi.readExperienceStatus(controller.signal);
      if (intent.current === current && !controller.signal.aborted) setAuthorized(valid);
    } catch (error: unknown) {
      if (intent.current !== current || controller.signal.aborted) return;
      setTrialError(error instanceof CredentialsConfigurationError ? text.problems[error.problem.code] : text.unavailable);
    } finally {
      if (intent.current === current && !controller.signal.aborted) setBusy(false);
    }
  };
  const confirmTrial = async (): Promise<void> => {
    const service = trial, current = intent.current, controller = request.current;
    if (service === null || controller === null || busy || !available || settings.error === "read") return;
    setBusy(true); setTrialError(null);
    try {
      let valid = true;
      if (authorized) valid = await credentialsApi.readExperienceStatus(controller.signal);
      else await credentialsApi.verifyExperience(inviteCode, controller.signal);
      if (intent.current !== current || controller.signal.aborted) return;
      if (!valid) { setAuthorized(false); setTrialError(text.problems.EXPERIENCE_REVOKED); return; }
      // 体验确认只切换来源；未保存的own草稿不应阻断合法资格，也不能意外覆盖已保存Key。
      const retainedKey = credentialSettingsStore.getState().preferences[service].apiKey;
      if (!credentialSettingsStore.getState().saveService(service, { source: "author", apiKey: retainedKey })) {
        setTrialError(text.saveFailure); return;
      }
      credentialSettingsStore.getState().clearNotice();
      setDraft(previous => ({ ...previous, [service]: { source: "author", apiKey: retainedKey } }));
      setVisible(previous => ({ ...previous, [service]: false }));
      setSaved(service); retireTrial(); panel.current?.focus({ preventScroll: true });
    } catch (error: unknown) {
      if (intent.current === current && !controller.signal.aborted) {
        setTrialError(error instanceof CredentialsConfigurationError ? text.problems[error.problem.code] : text.unavailable);
      }
    } finally {
      if (intent.current === current && !controller.signal.aborted) setBusy(false);
    }
  };
  const shownTrial = trialPresence.value;
  const interactiveTrial = open && trial !== null && trialPresence.open && trial === shownTrial;

  return <section className="ink-study__history-panel ink-settings" id="ink-settings" ref={panel} tabIndex={-1}
    data-active={open} inert={!open} aria-hidden={!open} aria-labelledby="ink-settings-title"
    onKeyDown={event => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault(); event.stopPropagation();
      if (trial !== null) { retireTrial(); panel.current?.focus({ preventScroll: true }); }
      else close(true);
    }}>
    <div className="ink-settings__content" inert={trial !== null} aria-hidden={trial !== null}>
    <header className="ink-study__history-header"><h2 id="ink-settings-title">{text.title}</h2>
      <button type="button" className="ink-study__pill" onClick={() => close(true)}>{messages.inkStudy.closePanel}</button></header>
    <p className="ink-settings__hint">{text.ownHint}</p>
    {settings.error !== null ? <div className="ink-settings__error" role="alert">
      <span>{settings.error === "read" ? text.readFailure : text.saveFailure}</span>
      {settings.error === "read" ? <button type="button" className="ink-study__pill" onClick={() => {
        if (credentialSettingsStore.getState().reload()) setDraft(credentialSettingsStore.getState().preferences);
      }}>{text.retry}</button> : null}
    </div> : null}
    <div className="ink-settings__services">
      {SERVICES.map(service => <form key={service} className="ink-settings__service" aria-label={`${SERVICE_NAMES[service]} ${text.title}`}
        onSubmit={event => {
          event.preventDefault();
          if (credentialSettingsStore.getState().saveService(service, { source: "own", apiKey: draft[service].apiKey })) {
            credentialSettingsStore.getState().clearNotice();
            setDraft(previous => ({ ...previous, [service]: { ...previous[service], source: "own" } })); setSaved(service);
          }
        }}>
        <h3>{SERVICE_NAMES[service]}</h3>
        <div className="ink-settings__choices" role="group" aria-label={SERVICE_NAMES[service]}>
          <button type="button" className="ink-study__pill" aria-pressed={draft[service].source === "own"}
            disabled={settings.error === "read"} onClick={() => {
              setDraft(previous => ({ ...previous, [service]: { ...previous[service], source: "own" } })); setSaved(null);
            }}>{text.own}</button>
          <button type="button" className="ink-study__pill" aria-pressed={draft[service].source === "author"}
            disabled={settings.error === "read"} onClick={() => { void beginTrial(service); }}>{text.experience}</button>
        </div>
        <label>{`${SERVICE_NAMES[service]} ${text.key}`}<input type={draft[service].source === "own" && visible[service] ? "text" : "password"}
          autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={MAX_API_KEY_LENGTH}
          disabled={draft[service].source !== "own" || settings.error === "read"} value={draft[service].apiKey}
          onChange={event => {
            const apiKey = event.target.value;
            setDraft(previous => ({ ...previous, [service]: { ...previous[service], apiKey } })); setSaved(null);
          }} /></label>
        <div className="ink-settings__actions">
          <button type="button" className="ink-study__pill" disabled={draft[service].source !== "own"}
            onClick={() => setVisible(previous => ({ ...previous, [service]: !previous[service] }))}>{visible[service] ? text.hide : text.show}</button>
          <button type="button" className="ink-study__pill" disabled={draft[service].source !== "own" || settings.error === "read"}
            onClick={() => { setDraft(previous => ({ ...previous, [service]: { ...previous[service], apiKey: "" } })); setSaved(null); }}>{text.clear}</button>
          <button type="submit" className="ink-study__pill" disabled={draft[service].source !== "own" || settings.error === "read"}>{text.save}</button>
        </div>
        {saved === service ? <p role="status">{text.saved}</p> : null}
      </form>)}
    </div>
    </div>
    {shownTrial === null ? null : <div className="ink-settings__trial" data-open={interactiveTrial} data-ink-control data-ink-overlay
      inert={!interactiveTrial} aria-hidden={!interactiveTrial}>
      <div className="ink-settings__trial-surface" ref={dialog} role="dialog" aria-modal="true" tabIndex={-1} aria-label={text.experienceTitle}
        onKeyDown={event => {
          if (event.key !== "Tab" || !interactiveTrial) return;
          const items = dialog.current?.querySelectorAll<HTMLElement>("input:not(:disabled),button:not(:disabled)");
          const first = items?.[0], last = items?.[items.length - 1];
          if (first === undefined || last === undefined) return;
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
            event.preventDefault(); last.focus();
          } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}>
        <h3>{SERVICE_NAMES[shownTrial]} · {text.experienceTitle}</h3>
        <div className="ink-settings__announcement"><h4>{text.announcement}</h4><p>{announcement}</p></div>
        {authorized ? <p className="ink-settings__hint">{text.authorized}</p> : <label>{text.invite}<input
          type="password" autoComplete="off" spellCheck={false} maxLength={MAX_INVITE_CODE_LENGTH} value={inviteCode}
          disabled={busy || !available} onChange={event => setInviteCode(event.target.value)} /></label>}
        <p className="ink-settings__warning">{text.sharedWarning}</p>
        {busy ? <p role="status">{text.loading}</p> : null}
        {trialError === null ? null : <p role="alert" className="ink-settings__error">{trialError}</p>}
        <div className="ink-settings__actions">
          <button type="button" className="ink-study__pill" onClick={() => { retireTrial(); panel.current?.focus({ preventScroll: true }); }}>{text.cancel}</button>
          <button type="button" className="ink-study__pill" disabled={busy || !available || (!authorized && !inviteCode.trim()) || settings.error === "read"}
            onClick={() => { void confirmTrial(); }}>{text.confirm}</button>
        </div>
      </div>
    </div>}
  </section>;
}
