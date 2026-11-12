/** 单服务云Key的独立确认；明文与冻结重试体只存当前组件，关闭或换号即销毁，不进持久化队列。 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { AccountKeyActionSchema, ApiKeySchema, MAX_API_KEY_LENGTH, type AccountKeyAction, type CredentialService, type SearchLanguage } from "@wayfinder/contracts";
import { accountKeysApi, AccountKeysError } from "../api/account-keys.js";
import { accountKeysStore, publishAccountKeys } from "../stores/account-keys.js";
import { accountStore } from "../stores/account.js";
import { readGuestApiKey } from "../stores/credential-settings.js";
import { getMessages } from "../i18n/messages.js";

export function InkCloudKey({ service, language, selected, onChoose, active = true }: Readonly<{
  service: CredentialService; language: SearchLanguage; selected: boolean; onChoose: () => void; active?: boolean;
}>) {
  const keys = useStore(accountKeysStore, state => state);
  const account = useStore(accountStore, state => state);
  const text = getMessages(language).cloudKeys;
  const name = service === "deepseek" ? "DeepSeek" : "SerpAPI";
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState<"save" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = useRef<AccountKeyAction | null>(null);
  const request = useRef<AbortController | null>(null);
  const intent = useRef(0);
  const clearSecrets = (): void => {
    ++intent.current; request.current?.abort(); request.current = null; pending.current = null;
    setDraft("");
  };
  const retire = (): void => { clearSecrets(); setConfirm(null); setBusy(false); setError(null); };
  useEffect(() => () => { ++intent.current; request.current?.abort(); pending.current = null; }, []);
  // 父面板退场时保留外壳，明文／重试体和在途操作仍在关闭当帧清理，迟到结果不能发布。
  useLayoutEffect(() => {
    if (!active) clearSecrets();
    // 确认／状态文字不含秘密，随整个面板退场；下一次打开再重置，避免局部高度提前塌陷。
    else { retire(); setSaved(false); }
  }, [active]);
  if (account.account === null) return null;
  const userId = account.account.userId, epoch = account.epoch;
  const status = keys.summary?.userId === userId ? keys.summary[service] : null;
  const current = (generation: number): boolean => intent.current === generation && accountStore.getState().epoch === epoch && accountStore.getState().scopeUserId === userId;

  const update = async (): Promise<void> => {
    if (!active || confirm === null || busy || request.current !== null || status === null) return;
    const controller = new AbortController(), generation = ++intent.current;
    request.current = controller; setBusy(true); setError(null); setSaved(false);
    try {
      pending.current ??= AccountKeyActionSchema.parse({ action: confirm, service, expectedRevision: status.revision, mutationId: crypto.randomUUID(),
        ...(confirm === "save" ? { apiKey: draft } : {}) });
      const response = await accountKeysApi.write(userId, pending.current, controller.signal);
      if (!current(generation) || controller.signal.aborted) return;
      if (!publishAccountKeys(response, userId, epoch, service)) return;
      pending.current = null; setDraft(""); setConfirm(null); setSaved(true);
    } catch (failure: unknown) {
      if (!current(generation) || controller.signal.aborted) return;
      const problem = failure instanceof AccountKeysError ? failure.problem.code : "KEY_UNAVAILABLE";
      setError(text.problems[problem]);
      if (problem === "ACCOUNT_REQUIRED") void accountStore.getState().refresh().catch(() => {});
      // 网络失败保留当前内存冻结体，重试不会换mutationId；显式取消/关闭仍会清除。
    } finally { if (current(generation)) { request.current = null; setBusy(false); } }
  };
  const reload = async (): Promise<void> => {
    if (!active || busy) return;
    pending.current = null; setConfirm(null); setError(null); setSaved(false);
    const generation = ++intent.current, controller = new AbortController(), keyGeneration = accountKeysStore.getState().generation;
    request.current = controller; setBusy(true);
    try {
      const response = await accountKeysApi.read(userId, controller.signal);
      if (current(generation) && !controller.signal.aborted) publishAccountKeys(response, userId, epoch, undefined, keyGeneration);
    } catch { if (current(generation) && !controller.signal.aborted) setError(text.problems.KEY_UNAVAILABLE); }
    finally { if (current(generation)) { request.current = null; setBusy(false); } }
  };
  return <section className="ink-settings__cloud-key" aria-label={`${name} ${text.title}`} inert={!active}>
    <p className="ink-settings__hint">{text.title} · {status?.configured ? status.mask : text.notConfigured}</p>
    {keys.loading ? <p className="ink-settings__hint">{text.loading}</p> : null}
    {keys.error === null ? null : <p className="ink-settings__error" role="alert">{text.problems[keys.error.code]}</p>}
    <button type="button" className="ink-study__pill" aria-pressed={selected} disabled={busy || keys.loading || keys.error !== null || !status?.configured} onClick={onChoose}>{text.use}</button>
    <label>{`${name} ${text.draft}`}<input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={MAX_API_KEY_LENGTH}
      value={draft} disabled={busy || confirm !== null} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); } }}
      onChange={event => { setDraft(event.target.value); pending.current = null; setSaved(false); setError(null); }} /></label>
    <div className="ink-settings__actions">
      <button type="button" className="ink-study__pill" disabled={busy || confirm !== null} onClick={() => {
        try { setDraft(readGuestApiKey(service)); pending.current = null; setSaved(false); setError(null); }
        catch { setError(text.guestMissing); }
      }}>{text.readGuest}</button>
      <button type="button" className="ink-study__pill" disabled={busy || confirm !== null || status === null || !ApiKeySchema.safeParse(draft).success}
        onClick={() => { pending.current = null; setConfirm("save"); setSaved(false); setError(null); }}>{text.save}</button>
      <button type="button" className="ink-study__pill" disabled={busy || confirm !== null || !status?.configured}
        onClick={() => { pending.current = null; setConfirm("delete"); setSaved(false); setError(null); }}>{text.delete}</button>
      <button type="button" className="ink-study__pill" disabled={busy} onClick={() => { void reload(); }}>{text.reload}</button>
    </div>
    {confirm === null ? null : <div className="ink-settings__hint">
      <p>{confirm === "save" ? text.saveNotice : text.deleteNotice}</p>
      <div className="ink-settings__actions"><button type="button" className="ink-study__pill" disabled={busy} onClick={() => { void update(); }}>{confirm === "save" ? text.confirmSave : text.confirmDelete}</button>
        <button type="button" className="ink-study__pill" onClick={retire}>{getMessages(language).settings.cancel}</button></div>
    </div>}
    {busy ? <p role="status" className="ink-settings__hint">{text.busy}</p> : null}
    {saved ? <p role="status" className="ink-settings__hint">{text.saved}</p> : null}
    {error === null ? null : <p role="alert" className="ink-settings__error">{error}</p>}
  </section>;
}
