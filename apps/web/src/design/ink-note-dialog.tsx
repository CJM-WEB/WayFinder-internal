/**
 * 模块职责：在节点笔记条和中央笔记之间往返，集中处理焦点、关闭和一次保存。
 * 上下文校验由工作区负责。失效会话立即隐藏，迟到写入结果不得关闭后来打开的笔记。
 */
import type { EditableNote, EditableResource, SearchLanguage } from "@wayfinder/contracts";
import { lazy, Suspense, useCallback, useId, useLayoutEffect, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import { useInkPresence } from "./ink-presence.js";
import "./ink-note-dialog.css";

export type InkNoteSession = Readonly<{
  note: EditableNote;
  isNew: boolean;
  origin: { x: number; y: number; width: number; height: number };
  returnFocus: HTMLElement | null;
}>;

type Props = Readonly<{
  session: InkNoteSession | null;
  language: SearchLanguage;
  writable: boolean;
  resources: readonly Pick<EditableResource, "title" | "url">[];
  onSave: (session: InkNoteSession, note: EditableNote) => Promise<boolean>;
  onClose: () => void;
  onReturn: () => void;
}>;

const SLIDE_MS = 560;
const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex='0']";
// 只有打开笔记才加载编辑器；图、资源和侧栏首屏不承担正文编辑依赖。
const InkNoteEditor = lazy(() => import("./ink-note-editor.js").catch(() => ({ default: NoteEditorFallback })));
const copy = {
  "zh-CN": { add: "新建笔记", note: "笔记", title: "标题", description: "说明", body: "正文", finish: "完成",
    saving: "正在保存笔记…", retry: "重试保存", loading: "正在加载正文编辑器…", failed: "笔记未保存，草稿已保留。请重试。" },
  "en-US": { add: "New note", note: "Note", title: "Title", description: "Description", body: "Content", finish: "Done",
    saving: "Saving note…", retry: "Retry save", loading: "Loading the note editor…", failed: "The note could not be saved. Your draft is still here. Try again." },
} satisfies Record<SearchLanguage, Record<string, string>>;

type Draft = { owner: InkNoteSession; note: EditableNote; status: "idle" | "saving" | "failed" };

/** 编辑器资源加载失败时继续保留草稿，避免侧栏或画布随模块错误卸载。 */
function NoteEditorFallback({ value, language, editable, metadata, onChange }: ComponentProps<typeof import("./ink-note-editor.js")["default"]>) {
  return <div>
    {metadata}
    <p role="alert">{language === "zh-CN" ? "排版编辑器加载失败，可继续编辑 Markdown 正文。" : "The visual editor could not load. You can still edit the Markdown."}</p>
    <label>{copy[language].body}<textarea value={value} readOnly={!editable} rows={8}
      onChange={event => onChange(event.target.value)} /></label>
  </div>;
}

export default function InkNoteDialog({ session, language, writable, resources, onSave, onClose, onReturn }: Props) {
  const { value: shown, open } = useInkPresence(session, SLIDE_MS);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [paintedOrigin, setPaintedOrigin] = useState<InkNoteSession | null>(null);
  const active = useRef<InkNoteSession | null>(session);
  const saving = useRef<InkNoteSession | null>(null);
  const departing = useRef<InkNoteSession | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const destination = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLFormElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  const bindTitle = useCallback((element: HTMLInputElement | null) => {
    firstInput.current = element;
    if (element !== null && document.activeElement === surface.current) element.focus({ preventScroll: true });
  }, []);
  const id = useId();
  const labels = copy[language];
  const measured = shown !== null && paintedOrigin === shown;
  const live = shown !== null && shown === session && open && measured;
  const heldDraft = draft?.owner === shown ? draft : null;

  useLayoutEffect(() => {
    active.current = session;
    return () => { active.current = null; };
  }, [session]);
  useLayoutEffect(() => {
    if (shown !== null) setDraft(current => current?.owner === shown ? current : { owner: shown, note: shown.note, status: "idle" });
    else {
      const departure = departing.current;
      departing.current = null;
      setDraft(null);
      if (departure === null) return;
      onReturn();
      // 恢复源卡片与焦点在同一次回程结束后进行，避免缩回时显示两个相同的信息条。
      const frame = requestAnimationFrame(() => {
        const target = departure.returnFocus;
        if (target?.isConnected && target.closest("[inert]") === null) target.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [shown]);

  // 用独立的未变形布局盒测量中央终点。关闭时使用同一组起点参数，原路返回且不累积偏差。
  useLayoutEffect(() => {
    const target = destination.current, panel = surface.current;
    if (shown === null || target === null || panel === null) return;
    const { origin } = shown;
    const measure = (): void => {
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const width = Math.max(1, origin.width), height = Math.max(1, origin.height);
      panel.style.setProperty("--ink-note-x", `${origin.x - rect.x}px`);
      panel.style.setProperty("--ink-note-y", `${origin.y - rect.y}px`);
      panel.style.setProperty("--ink-note-scale-x", String(width / rect.width));
      panel.style.setProperty("--ink-note-scale-y", String(height / rect.height));
      // 起点摘要抵消外壳缩放，让合起时的标题尺寸接近原信息条。
      panel.style.setProperty("--ink-note-origin-width", `${width}px`);
      panel.style.setProperty("--ink-note-origin-height", `${height}px`);
    };
    measure();
    // 测量期间不允许过渡；先绘制一帧源矩形，再启用中央展开，防止浏览器合并两个位置。
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let first = 0, second = 0;
    const clear = (): void => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
    const followPreference = (): void => {
      if (!motion.matches) return;
      clear(); setPaintedOrigin(shown);
    };
    if (motion.matches) followPreference();
    else first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setPaintedOrigin(shown)); });
    motion.addEventListener("change", followPreference);
    window.addEventListener("resize", measure);
    return () => {
      clear();
      motion.removeEventListener("change", followPreference);
      window.removeEventListener("resize", measure);
    };
  }, [shown]);

  useLayoutEffect(() => {
    if (!live) {
      if (shown !== null && departing.current === shown) overlay.current?.focus({ preventScroll: true });
      return;
    }
    const focus = (): void => { (firstInput.current ?? surface.current)?.focus({ preventScroll: true }); };
    const contain = (event: FocusEvent): void => {
      if (event.target instanceof Node && !surface.current?.contains(event.target)) focus();
    };
    focus();
    document.addEventListener("focusin", contain);
    return () => document.removeEventListener("focusin", contain);
  }, [live, shown]);

  if (shown === null || (shown !== session && shown !== departing.current)) return null;
  const note = heldDraft?.note ?? shown.note;
  const status = heldDraft?.status ?? "idle";
  // 首次提交已进入工作区历史。落盘失败时保留并冻结本次提交内容，重试同一快照而不再产生编辑事件。
  const canChange = writable && status === "idle";
  const change = (patch: Partial<Pick<EditableNote, "title" | "description" | "markdown">>): void => {
    if (!canChange) return;
    setDraft({ owner: shown, note: { ...note, ...patch }, status: "idle" });
  };
  const metadata = <>
    <label>{labels.title}<input ref={bindTitle} value={note.title} readOnly={!canChange}
      onChange={event => change({ title: event.target.value })} /></label>
    <label>{labels.description}<input value={note.description} readOnly={!canChange}
      onChange={event => change({ description: event.target.value })} /></label>
  </>;
  const close = (): void => {
    departing.current = shown;
    active.current = null;
    onClose();
  };
  const finish = async (): Promise<void> => {
    if (!live || active.current !== shown || saving.current === shown) return;
    if (status === "idle" && note.title === shown.note.title && note.description === shown.note.description && note.markdown === shown.note.markdown) {
      close();
      return;
    }
    if (!writable) {
      setDraft({ owner: shown, note, status: "failed" });
      return;
    }
    saving.current = shown;
    setDraft({ owner: shown, note, status: "saving" });
    try {
      if (await onSave(shown, note)) {
        if (active.current === shown) close();
        return;
      }
    } catch {
      // 失败和普通拒绝走同一路径，保留输入及可重试状态。
    } finally {
      if (saving.current === shown) saving.current = null;
    }
    if (active.current === shown) setDraft({ owner: shown, note, status: "failed" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing) {
      event.preventDefault(); event.stopPropagation(); void finish();
    }
    if (event.key !== "Tab") return;
    if (!live) { event.preventDefault(); event.stopPropagation(); return; }
    const focusable = surface.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    const first = focusable?.[0], last = focusable?.[focusable.length - 1];
    if (first === undefined) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === surface.current)) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  };

  return <div className="ink-note-overlay" ref={overlay} tabIndex={-1} data-ink-overlay data-ink-control
    data-open={live} data-origin-ready={measured} onKeyDown={onKeyDown}
    onPointerDown={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onClick={event => {
      event.stopPropagation();
      if (event.target instanceof Node && !surface.current?.contains(event.target)) void finish();
    }}>
    <div className="ink-note-overlay__destination" ref={destination}>
      <form className="ink-note-dialog" ref={surface} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={id}
        aria-busy={status === "saving"} inert={!live} aria-hidden={!live}
        onSubmit={event => { event.preventDefault(); void finish(); }}>
        <div className="ink-note-dialog__summary" aria-hidden="true">
          <strong>{note.title || (shown.isNew ? labels.add : labels.note)}</strong>
          {note.description ? <p>{note.description}</p> : null}
        </div>
        <div className="ink-note-dialog__contents">
          <header className="ink-note-dialog__header">
            <h2 id={id}>{shown.isNew ? labels.add : labels.note}</h2>
            <button type="submit" className="ink-study__pill" aria-disabled={status === "saving"}>{status === "failed" ? labels.retry : labels.finish}</button>
          </header>
          <Suspense fallback={<p role="status">{labels.loading}</p>}>
            <InkNoteEditor key={note.id} value={note.markdown} language={language} resources={resources} metadata={metadata}
              editable={canChange} onChange={markdown => change({ markdown })} />
          </Suspense>
          <div className="ink-note-dialog__status">
            {status === "saving" ? <p role="status">{labels.saving}</p> : null}
            {status === "failed" ? <p role="alert">{labels.failed}</p> : null}
          </div>
        </div>
      </form>
    </div>
  </div>;
}
