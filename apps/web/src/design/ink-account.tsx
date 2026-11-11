/** 账号表单复用设置抽屉；秘密只留当前表单，关闭/换号/提交后不保存密码或验证码。 */
import { useState } from "react";
import { useStore } from "zustand";
import type { AccountAction, SearchLanguage } from "@wayfinder/contracts";
import { accountStore } from "../stores/account.js";
import { getMessages } from "../i18n/messages.js";

type Mode = Exclude<AccountAction["action"], "logout">;
export function InkAccount({ language }: Readonly<{ language: SearchLanguage }>) {
  const account = useStore(accountStore, state => state);
  const text = getMessages(language).account;
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState(false);
  const submit = async (action: AccountAction): Promise<void> => {
    setNotice(null); setFailure(false);
    try {
      const result = await accountStore.getState().submit(action);
      setPassword(""); setOtp("");
      setNotice(action.action === "verify" || action.action === "reset" ? text.continueLogin : result === "accepted" && action.action !== "logout" ? text.accepted : text.updated);
      if (action.action === "register" || action.action === "resend") setMode("verify");
      if (action.action === "recover") setMode("reset");
      if (action.action === "verify" || action.action === "reset") setMode("login");
    } catch { setPassword(""); setOtp(""); setFailure(true); }
  };
  const action = (): AccountAction => {
    if (mode === "register" || mode === "login") return { action: mode, email, password };
    if (mode === "verify") return { action: mode, email, otp };
    if (mode === "reset") return { action: mode, email, otp, password };
    return { action: mode, email };
  };
  return <section className="ink-settings__account" aria-label={text.title}>
    <h3>{text.title}</h3>
    {account.account === null ? <>
      <p className="ink-settings__hint">{text.guest}</p>
      <div className="ink-settings__choices">
        {(["login", "register", "verify", "recover", "reset"] as const).map(value => <button key={value} type="button" className="ink-study__pill"
          aria-pressed={mode === value} disabled={account.busy} onClick={() => { setMode(value); setPassword(""); setOtp(""); setNotice(null); setFailure(false); }}>{text.actions[value]}</button>)}
      </div>
      <form aria-label={text.form} onSubmit={event => { event.preventDefault(); void submit(action()); }}>
        <label>{text.email}<input name="email" type="email" autoComplete="email" maxLength={254} required value={email} disabled={account.busy} onChange={event => setEmail(event.target.value)} /></label>
        {mode === "login" || mode === "register" || mode === "reset" ? <label>{text.password}<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} maxLength={128} required value={password} disabled={account.busy} onChange={event => setPassword(event.target.value)} /></label> : null}
        {mode === "verify" || mode === "reset" ? <label>{text.otp}<input name="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={otp} disabled={account.busy} onChange={event => setOtp(event.target.value)} /></label> : null}
        <div className="ink-settings__actions"><button type="submit" className="ink-study__pill" disabled={account.busy}>{text.actions[mode]}</button>
          {mode === "verify" ? <button type="button" className="ink-study__pill" disabled={account.busy || !email} onClick={() => { void submit({ action: "resend", email }); }}>{text.actions.resend}</button> : null}</div>
      </form>
    </> : <><p className="ink-settings__hint">{account.account.email}</p>
      <button type="button" className="ink-study__pill" disabled={account.busy} onClick={() => { void submit({ action: "logout" }); }}>{text.actions.logout}</button></>}
    {account.busy ? <p role="status">{text.busy}</p> : null}
    {notice === null ? null : <p className="ink-settings__hint" role="status">{notice}</p>}
    {failure ? <p className="ink-settings__error" role="alert">{text.failure}</p> : null}
  </section>;
}
