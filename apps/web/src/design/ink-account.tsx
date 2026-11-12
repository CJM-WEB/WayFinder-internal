/**
 * 账号呈现：认证表单独立弹窗；设置仅承载本人资料、退出与既有云端导入。
 * 秘密边界：密码和验证码只留当前表单，切换步骤、提交、关闭或换号后清空。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { AccountAction, SearchLanguage } from "@wayfinder/contracts";
import { accountStore } from "../stores/account.js";
import { accountProfileStore } from "../stores/account-profile.js";
import { getMessages } from "../i18n/messages.js";
import { getGroupMessages, groupErrorMessage } from "../i18n/group-messages.js";
import { InkCloudSync } from "./ink-cloud-sync.js";
import "./ink-account.css";

type Mode = Exclude<AccountAction["action"], "logout" | "resend">;
type Props = Readonly<{ language: SearchLanguage; onOpenLogin: () => void; active?: boolean }>;

export function InkAccount({ language, onOpenLogin, active = true }: Props) {
  const account = useStore(accountStore, state => state);
  const profile = useStore(accountProfileStore, state => state);
  const text = getMessages(language).account, labels = getGroupMessages(language);
  const [nickname, setNickname] = useState("");
  const [saved, setSaved] = useState(false), [failure, setFailure] = useState(false);
  const [opening, setOpening] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    // 退场保留整块资料布局；业务关闭当帧中止旧读取／保存，不为视觉延长请求寿命。
    if (!active) return;
    setSaved(false); setFailure(false); setOpening(previous => previous + 1);
    const current = accountProfileStore.getState();
    setNickname(current.userId === account.account?.userId ? current.nickname ?? "" : "");
    const controller = new AbortController(); lifetime.current = controller;
    void accountProfileStore.getState().refresh(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [active, account.account?.userId, account.epoch]);
  useEffect(() => { setNickname(profile.userId === account.account?.userId ? profile.nickname ?? "" : ""); }, [profile.userId, profile.nickname, account.account?.userId]);
  const logout = async (): Promise<void> => {
    if (!active) return;
    // 捕获本次打开的生命周期；快速关开后不能拿新 controller 为旧失败放行。
    const signal = lifetime.current?.signal;
    setFailure(false);
    try { await accountStore.getState().submit({ action: "logout" }); }
    catch { if (!signal?.aborted) setFailure(true); }
  };
  return <section className="ink-settings__account" aria-label={text.title} inert={!active}>
    <h3>{text.title}</h3>
    {account.account === null ? <><p className="ink-settings__hint">{text.guest}</p>
      <button type="button" className="ink-study__pill" onClick={onOpenLogin}>{text.actions.login}</button></> : <>
      <p className="ink-settings__hint">{account.account.email}</p>
      <form aria-label={labels.nickname} onSubmit={event => {
        event.preventDefault(); if (!active) return; setSaved(false);
        const signal = lifetime.current?.signal;
        void accountProfileStore.getState().save(nickname, signal).then(() => { if (!signal?.aborted) setSaved(true); }).catch(() => {});
      }}>
        <label>{labels.nickname}<input name="nickname" required value={nickname} disabled={profile.loading}
          onChange={event => { setNickname(event.target.value); setSaved(false); }} /></label>
        <div className="ink-settings__actions"><button type="submit" className="ink-study__pill" disabled={profile.loading || !nickname.trim()}>{labels.saveNickname}</button>
          <button type="button" className="ink-study__pill" disabled={account.busy} onClick={() => { void logout(); }}>{text.actions.logout}</button></div>
        <p className="ink-settings__hint">{labels.nicknameHint}</p>
      </form>
      {profile.error === null ? null : <p className="ink-settings__error" role="alert">{groupErrorMessage(profile.error, language)}</p>}
      {saved ? <p role="status">{labels.success}</p> : null}
    </>}
    {failure ? <p className="ink-settings__error" role="alert">{text.failure}</p> : null}
    {/* 下次打开才重置未提交的导入确认，退场当帧不抽走确认文字或改变高度。 */}
    <InkCloudSync key={opening} language={language} allowImport />
  </section>;
}

/** 原生 modal dialog（模态对话框）负责焦点约束；卸载时关闭，背景不能被键盘或指针操作。 */
export function InkAccountDialog({ language, onClose }: Readonly<{ language: SearchLanguage; onClose: () => void }>) {
  const account = useStore(accountStore, state => state);
  const messages = getMessages(language), text = messages.account;
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [otp, setOtp] = useState("");
  const [notice, setNotice] = useState<string | null>(null), [failure, setFailure] = useState(false);
  const [changing, setChanging] = useState(false), [closing, setClosing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), firstInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const closingIntent = useRef(false), stepIntent = useRef(0), motionIntent = useRef(0);
  const animation = useRef<Animation | null>(null), motion = useRef<MediaQueryList | null>(null);
  const dialogBusy = account.busy || changing || closing;
  /** 原生弹窗保留至退场完成；读同一组 CSS 时间与 S 曲线，不让关闭／切步截断动画。 */
  const animatePanel = async (entering: boolean): Promise<boolean> => {
    const element = dialog.current;
    if (element === null || !mounted.current) return false;
    const current = ++motionIntent.current, style = getComputedStyle(element);
    // 中途关闭从当前画面反向退场，避免先跳到完全展开的位置。
    const from = { opacity: style.opacity, transform: style.transform };
    animation.current?.cancel(); animation.current = null;
    const duration = Number.parseFloat(style.getPropertyValue("--ink-account-motion-duration"));
    if (motion.current?.matches || duration === 0) return true;
    const hidden = { opacity: 0, transform: "translateY(28px) scale(0.94)" };
    const visible = { opacity: 1, transform: "translateY(0) scale(1)" };
    const running = element.animate(entering ? [hidden, visible] : [from, hidden], {
      duration: Number.isFinite(duration) ? duration : 360,
      easing: style.getPropertyValue("--ink-slide-ease").trim() || "cubic-bezier(0.6, 0, 0.4, 1)", fill: "both",
    });
    animation.current = running;
    try { await running.finished; } catch { return false; }
    if (!mounted.current || current !== motionIntent.current) return false;
    if (entering) { running.cancel(); animation.current = null; }
    return true;
  };
  useEffect(() => {
    mounted.current = true; closingIntent.current = false;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)"); motion.current = preference;
    // 运行中切换减少动态，也立即完成当前运动，不继续等待原动画时长。
    const reduce = (): void => { if (preference.matches) animation.current?.finish(); };
    preference.addEventListener("change", reduce);
    const element = dialog.current; element?.showModal(); firstInput.current?.focus();
    void animatePanel(true);
    return () => {
      // 换号或会话失效仍立即隔离，不为退场延迟既有身份代际清理。
      mounted.current = false; ++stepIntent.current; ++motionIntent.current;
      animation.current?.cancel(); animation.current = null; preference.removeEventListener("change", reduce); element?.close();
    };
  }, []);
  // 减少动态可能合并 changing 的更新；步骤变化也须在新 DOM 提交后恢复输入焦点。
  useEffect(() => { if (!changing && !closing) firstInput.current?.focus({ preventScroll: true }); }, [mode, changing, closing]);
  const close = (): void => {
    if (closingIntent.current) return;
    closingIntent.current = true; ++stepIntent.current; setClosing(true); setPassword(""); setOtp("");
    dialog.current?.focus({ preventScroll: true });
    void animatePanel(false).then(finished => {
      // 完成退场后先释放原生模态层，再由父组件卸载并恢复顶栏焦点。
      if (finished && mounted.current) { dialog.current?.close(); onClose(); }
    });
  };
  const switchMode = async (next: Mode, nextNotice: string | null = null): Promise<void> => {
    if (closingIntent.current || !mounted.current) return;
    setPassword(""); setOtp(""); setFailure(false); setNotice(null);
    if (next === mode) { setNotice(nextNotice); return; }
    const current = ++stepIntent.current; setChanging(true); dialog.current?.focus({ preventScroll: true });
    if (!await animatePanel(false) || closingIntent.current || current !== stepIntent.current) return;
    setMode(next); setNotice(nextNotice);
    // 旧面板保持透明，等新步骤完成 DOM 提交后再弹入，避免高度与字段在可见时突变。
    if (!motion.current?.matches) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (!mounted.current || closingIntent.current || current !== stepIntent.current) return;
    if (await animatePanel(true) && mounted.current && !closingIntent.current && current === stepIntent.current) setChanging(false);
  };
  const submit = async (action: AccountAction): Promise<void> => {
    if (closingIntent.current || changing || accountStore.getState().busy) return;
    setNotice(null); setFailure(false);
    try {
      const result = await accountStore.getState().submit(action);
      if (!mounted.current || closingIntent.current) return;
      setPassword(""); setOtp("");
      if (action.action === "login" && result === "account") { close(); return; }
      // 注册提交只进入待验证阶段；服务端确认验证码成功后才展示注册成功，不能把受理邮件说成完成注册。
      if (action.action === "register" || action.action === "resend") await switchMode("verify", text.accepted);
      if (action.action === "recover") await switchMode("reset", text.accepted);
      if (action.action === "verify" || action.action === "reset") await switchMode("login", action.action === "verify" ? text.registered : text.continueLogin);
    } catch { if (mounted.current && !closingIntent.current) { setPassword(""); setOtp(""); setFailure(true); } }
  };
  const action = (): AccountAction => {
    if (mode === "register" || mode === "login") return { action: mode, email, password };
    if (mode === "verify") return { action: mode, email, otp };
    if (mode === "reset") return { action: mode, email, otp, password };
    return { action: mode, email };
  };
  return <dialog ref={dialog} className="ink-account-dialog" tabIndex={-1} aria-labelledby="ink-account-title" data-ink-overlay data-changing={changing} data-closing={closing}
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
      if (event.key !== "Tab") return;
      // 原生模态层隔离背景；显式首尾循环让 Tab 连续留在表单，不移入浏览器工具栏。
      const controls = event.currentTarget.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button:not(:disabled), input:not(:disabled)");
      if (controls.length === 0) { event.preventDefault(); event.currentTarget.focus(); return; }
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }} onClick={event => {
      // 原生 backdrop（遮罩）点击目标也是 dialog；用实际边界区分卡片留白与外部点击。
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}>
    <button type="button" className="ink-account-dialog__close" aria-label={messages.inkStudy.closePanel} disabled={closing} onClick={close}>×</button>
    <div className="ink-account-dialog__content" inert={changing || closing}>
    <header><h2 id="ink-account-title">{text.actions[mode]}</h2></header>
    <form aria-label={text.form} onSubmit={event => { event.preventDefault(); void submit(action()); }}>
      <label>{text.email}<input ref={firstInput} name="email" type="email" autoComplete="email" maxLength={254} required value={email} disabled={dialogBusy} onChange={event => setEmail(event.target.value)} /></label>
      {mode === "login" || mode === "register" || mode === "reset" ? <label>{text.password}<input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} maxLength={128} required value={password} disabled={dialogBusy} onChange={event => setPassword(event.target.value)} /></label> : null}
      {mode === "login" ? <button type="button" className="ink-account-dialog__link ink-account-dialog__forgot" disabled={dialogBusy} onClick={() => { void switchMode("recover"); }}>{text.forgotPassword}</button> : null}
      {mode === "verify" || mode === "reset" ? <label>{text.otp}<input name="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={otp} disabled={dialogBusy} onChange={event => setOtp(event.target.value)} /></label> : null}
      <button type="submit" className="ink-study__pill ink-account-dialog__submit" disabled={dialogBusy}>{text.actions[mode]}</button>
      <div className="ink-account-dialog__navigation">{mode === "login" ? <><span>{text.noAccount}</span><button type="button" className="ink-account-dialog__link" disabled={dialogBusy} onClick={() => { void switchMode("register"); }}>{text.actions.register}</button></>
        : <button type="button" className="ink-account-dialog__link" disabled={dialogBusy} onClick={() => { void switchMode("login"); }}>{text.backLogin}</button>}
        {mode === "verify" ? <button type="button" className="ink-account-dialog__link" disabled={dialogBusy || !email} onClick={() => { void submit({ action: "resend", email }); }}>{text.actions.resend}</button> : null}</div>
    </form>
    {account.busy ? <p role="status">{text.busy}</p> : null}
    {notice === null ? null : <p role="status">{notice}</p>}
    {failure ? <p role="alert">{text.failure}</p> : null}
    </div>
  </dialog>;
}
