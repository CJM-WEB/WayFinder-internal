/**
 * 模块职责：按需加载排版式笔记编辑器；在编辑器内部维护选区与组合输入，向上层提交 Markdown。
 * 外部内容始终经过受支持的编辑器结构；链接保留原网址，在用户主动打开时再次校验。
 */
import { Editor, type JSONContent, type MarkdownParseHelpers, type MarkdownRendererHelpers, type MarkdownToken, type RenderContext } from "@tiptap/core";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { isInTable, rowIsHeader, selectedRect } from "@tiptap/pm/tables";
import StarterKit from "@tiptap/starter-kit";
import type { EditableResource, SearchLanguage } from "@wayfinder/contracts";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { requestSafeUrlOpen, resolveSafeHttpUrl } from "../lib/url.js";
import "./ink-note-editor.css";

type Props = Readonly<{
  value: string;
  language: SearchLanguage;
  editable: boolean;
  resources: readonly Pick<EditableResource, "title" | "url">[];
  onChange: (value: string) => void;
  metadata?: ReactNode;
}>;

const text = {
  "zh-CN": {
    body: "正文", toolbar: "笔记格式", heading: "标题级别", paragraph: "正文", levels: ["一级标题", "二级标题", "三级标题"],
    bold: "粗体", bullets: "无序列表", ordered: "有序列表", table: "插入表格", row: "在下方插入行", column: "在右侧插入列",
    deleteRow: "删除行", deleteColumn: "删除列", code: "代码块", link: "链接", insertLink: "插入链接",
    manual: "手动输入", fromResource: "从节点资源选择", resource: "节点资源", choose: "选择资源",
    label: "链接文字", url: "网页地址", cancel: "取消",
    invalidUrl: "链接地址无效，请检查或修改链接。", openingFailed: "浏览器无法打开链接。请重试或检查网址是否已变更。",
  },
  "en-US": {
    body: "Content", toolbar: "Note formatting", heading: "Heading level", paragraph: "Paragraph",
    levels: ["Heading 1", "Heading 2", "Heading 3"],
    bold: "Bold", bullets: "Bullet list", ordered: "Numbered list", table: "Insert table", row: "Insert row below", column: "Insert column to the right",
    deleteRow: "Delete row", deleteColumn: "Delete column", code: "Code block", link: "Link", insertLink: "Insert link",
    manual: "Enter manually", fromResource: "Choose a node resource", resource: "Node resource", choose: "Choose a resource",
    label: "Link text", url: "Web address", cancel: "Cancel",
    invalidUrl: "This link address is invalid. Check or edit it.", openingFailed: "The browser could not open this link. Try again or check whether its address has changed.",
  },
} satisfies Record<SearchLanguage, Record<string, string | readonly string[]>>;
const headings = [1, 2, 3] as const;
const markdownPattern = /(?:^|\n)[^\S\n]*(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|\x60{3}|~{3}|\|)|\*\*[^*]+\*\*|\[[^\]\n]+\]\([^\n]+\)/;
const toolSymbols = { heading: "H", bold: "B", bullets: "", ordered: "", table: "", row: "▤+", column: "▥+",
  deleteRow: "▤−", deleteColumn: "▥−", code: "‹/›", link: "" } as const;

/** 工具栏用图形呈现；按钮保留可读名称与鼠标悬浮说明。 */
function NoteTool({ icon, label, ...props }: ComponentPropsWithRef<"button"> & {
  icon: keyof typeof toolSymbols; label: string;
}) {
  return <button {...props} type="button" className="ink-note-editor__tool" aria-label={label} title={label}>
    <span aria-hidden="true" className="ink-note-editor__icon" data-icon={icon}>{toolSymbols[icon]}</span>
  </button>;
}

/**
 * StarterKit 默认只在 HTML 和编辑命令侧验证链接，Markdown 导入仍会接受 token.href。
 * Markdown 导入、实时渲染和打开动作使用同一校验守卫，DOM 只挂载可打开的地址。
 */
const NoteStarterKit = StarterKit.extend({
  addExtensions() {
    return (this.parent?.() ?? []).map(extension => {
      if (extension.name === "codeBlock") return extension.extend({
        renderMarkdown: (node: JSONContent, helpers: MarkdownRendererHelpers) => {
          const code = helpers.renderChildren(node.content ?? []);
          const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
          // 分隔符必须长于正文的任意连续同字符，否则其中一行代码会意外关闭围栏。
          const tilde = language.includes("\x60");
          let length = 3;
          for (const match of code.matchAll(tilde ? /~+/g : /\x60+/g)) length = Math.max(length, match[0].length + 1);
          const fence = (tilde ? "~" : "\x60").repeat(length);
          return [fence + language, code, fence].join("\n");
        },
      });
      if (extension.name === "paragraph") return extension.extend({
        renderMarkdown(this: { parent?: (node: JSONContent, helpers: MarkdownRendererHelpers, context: RenderContext) => string },
          node: JSONContent, helpers: MarkdownRendererHelpers, context: RenderContext) {
          const rendered = this.parent?.(node, helpers, context) ?? "";
          // 普通段落的字面标记往返后仍应是文字，不能自动变成标题、列表或分隔块。
          return rendered.replace(/^([ \t]{0,3})(#{1,6}|[-+*>])(?=[ \t]|$)/gm, "$1\\$2")
            .replace(/^([ \t]{0,3})([-_*])(?=(?:[ \t]*\2){2,}[ \t]*$)/gm, "$1\\$2")
            .replace(/^([ \t]{0,3}\d{1,9})([.)])(?=[ \t]|$)/gm, "$1\\$2");
        },
      });
      if (extension.name !== "link") return extension;
      return extension.extend({
        parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) => {
          const content = helpers.parseInline(token.tokens ?? []);
          return typeof token.href === "string" && resolveSafeHttpUrl(token.href) !== null
            ? helpers.applyMark("link", content, { href: token.href, title: token.title || null })
            : content;
        },
        renderMarkdown: (node: JSONContent, helpers: MarkdownRendererHelpers) => {
          const content = helpers.renderChildren(node);
          const href: unknown = node.attrs?.href;
          if (typeof href !== "string" || resolveSafeHttpUrl(href) === null) return content;
          // 未加括号保护的右括号会提前结束链接；用 Markdown 的尖括号目的地保留原网址。
          const target = /[\s()<>\\]/.test(href) ? `<${href.replace(/[\\<>]/g, character => `\\${character}`)}>` : href;
          const title = typeof node.attrs?.title === "string" ? node.attrs.title.replace(/[\\"]/g, character => `\\${character}`) : "";
          return `[${content}](${target}${title === "" ? "" : ` "${title}"`})`;
        },
        renderHTML: ({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) => {
          const href = HTMLAttributes.href;
          const safeUrl = resolveSafeHttpUrl(href);
          // 可编辑正文里的后代默认可能被跳过，显式保留链接自身的顺序焦点。
          return safeUrl === null ? ["span", 0] : ["a", {
            href: safeUrl, target: "_blank", rel: "noopener noreferrer", tabindex: "0", "data-ink-note-link": href,
          }, 0];
        },
      });
    });
  },
}).configure({ link: { autolink: false, linkOnPaste: false, openOnClick: false, isAllowedUri: value => resolveSafeHttpUrl(value) !== null } });

/** GFM（GitHub 扩展 Markdown）要求表头；删除原表头时将新的首行提升，避免重开时多出空行。 */
function deleteSelectedRows(editor: Editor | null): void {
  if (editor === null || !isInTable(editor.state)) return;
  const { top, bottom, map, table } = selectedRect(editor.state);
  const command = editor.chain().focus();
  if (top === 0 && bottom === map.height) { command.deleteTable().run(); return; }
  command.deleteRow();
  if (top === 0 && !rowIsHeader(map, table, bottom)) command.toggleHeaderRow();
  command.run();
}

type LinkDraft = {
  mode: "manual" | "resource";
  label: string;
  url: string;
  selection: string;
  range: { from: number; to: number };
  resource: string;
  invalid: boolean;
  closing: boolean;
};

export default function InkNoteEditor({ value, language, editable, resources, onChange, metadata }: Props) {
  const labels = text[language];
  const id = useId();
  const mount = useRef<HTMLDivElement>(null);
  const headingWrap = useRef<HTMLDivElement>(null);
  const headingTrigger = useRef<HTMLButtonElement>(null);
  const linkTrigger = useRef<HTMLButtonElement>(null);
  const linkDialog = useRef<HTMLDialogElement>(null);
  const linkReturn = useRef<"body" | "trigger" | null>(null);
  const address = useRef<HTMLInputElement>(null);
  // 外层用笔记会话重建编辑器；会话内的 Markdown 回显不能覆盖较新的编辑事务或中文组合选区。
  const initialValue = useRef(value);
  const latest = useRef({ editable, onChange, body: labels.body });
  const published = useRef(value);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [, setRevision] = useState(0);
  const [headingOpen, setHeadingOpen] = useState(false);
  const [link, setLink] = useState<LinkDraft | null>(null);
  const [linkError, setLinkError] = useState<"invalidUrl" | "openingFailed" | null>(null);

  useLayoutEffect(() => {
    latest.current = { editable, onChange, body: labels.body };
  }, [editable, onChange, labels.body]);

  useEffect(() => {
    const element = mount.current;
    if (element === null) return;
    const instance: Editor = new Editor({
      element,
      extensions: [NoteStarterKit, TableKit, Markdown.configure({ markedOptions: { gfm: true } })],
      editable: latest.current.editable,
      content: initialValue.current,
      contentType: "markdown",
      editorProps: {
        attributes: { role: "textbox", "aria-multiline": "true", "aria-label": latest.current.body, tabindex: "0" },
        handleDOMEvents: {
          keydown: (_view, event) => {
            if (event.isComposing) return false;
            // 跳过文档的快捷键处理，让 Escape 继续冒泡到负责保存和关闭的对话框。
            if (event.key === "Escape") return true;
            if (event.key !== "Enter") return false;
            const anchor = event.target;
            if (!(anchor instanceof HTMLAnchorElement) || !anchor.hasAttribute("data-ink-note-link")) return false;
            // 焦点在链接上时走点击同一门禁，避免编辑器先把 Enter 作为正文换行处理。
            event.preventDefault();
            if (!event.repeat) anchor.click();
            return true;
          },
        },
        // 浏览器可能同时提供 HTML 与纯文本。只采纳纯文本及支持的 Markdown，避开 HTML 导入及远端附件。
        transformPastedHTML: () => "",
        handlePaste: (view, event): boolean => {
          const clipboard = event.clipboardData;
          if (clipboard === null) return false;
          const plain = clipboard.getData("text/plain");
          if (plain === "") return clipboard.getData("text/html") !== "";
          const body = plain.replace(/\r\n?/g, "\n");
          if (view.state.selection.$from.parent.type.name === "codeBlock") {
            view.dispatch(view.state.tr.insertText(body).scrollIntoView());
            return true;
          }
          if (markdownPattern.test(body)) return instance.commands.insertContent(body, { contentType: "markdown" });
          if (!body.includes("\n")) {
            view.dispatch(view.state.tr.insertText(body).scrollIntoView());
            return true;
          }
          const paragraphs: JSONContent[] = body.split("\n").map(line => ({
            type: "paragraph", ...(line === "" ? {} : { content: [{ type: "text", text: line }] }),
          }));
          return instance.commands.insertContent(paragraphs);
        },
      },
      onTransaction: () => setRevision(revision => revision + 1),
      onUpdate: ({ editor: current }) => {
        const markdown = current.isEmpty ? "" : current.getMarkdown();
        if (published.current === markdown) return;
        published.current = markdown;
        latest.current.onChange(markdown);
      },
    });
    setEditor(instance);
    return () => instance.destroy();
  }, []);

  useEffect(() => {
    if (editor === null) return;
    editor.setEditable(editable, false);
    editor.view.dom.setAttribute("aria-readonly", String(!editable));
    editor.view.dom.setAttribute("aria-label", labels.body);
    if (!editable) { setHeadingOpen(false); setLink(null); }
  }, [editor, editable, labels.body]);

  const linkOpen = link !== null;
  const linkClosing = link?.closing === true;
  useLayoutEffect(() => {
    const dialog = linkDialog.current;
    if (linkOpen && dialog !== null) {
      // 原生模态层将父笔记隔离为不可交互；宿主仍属于父对话框，焦点守卫不会把焦点拉回笔记。
      dialog.showModal();
      address.current?.focus({ preventScroll: true });
      return () => { if (dialog.open) dialog.close(); };
    }
    const target = linkReturn.current;
    linkReturn.current = null;
    // 只有模态层释放后才能恢复父层焦点；成功插入回到正文，取消回到触发图标。
    if (target === "body") editor?.commands.focus();
    else if (target === "trigger") linkTrigger.current?.focus({ preventScroll: true });
  }, [editor, linkOpen]);
  useEffect(() => {
    if (!linkClosing) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finishWithoutMotion = (): void => { if (motion.matches) setLink(null); };
    // 正常由面板的 S 型过渡收尾；浏览器未派发事件时也不能留下遮住父笔记的模态层。
    const fallback = window.setTimeout(() => setLink(null), 330);
    finishWithoutMotion();
    motion.addEventListener("change", finishWithoutMotion);
    return () => { window.clearTimeout(fallback); motion.removeEventListener("change", finishWithoutMotion); };
  }, [linkClosing]);

  const heading = headings.find(level => editor?.isActive("heading", { level })) ?? 0;
  const inTable = editor?.isActive("table") ?? false;
  const ready = editor !== null && editable;
  const showHeadings = headingOpen && ready && !inTable;
  useLayoutEffect(() => {
    if (!showHeadings) return;
    headingWrap.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
    const blockOutside = (event: Event): boolean => {
      if (!(event.target instanceof Node) || headingWrap.current?.contains(event.target)) return false;
      event.preventDefault(); event.stopPropagation(); return true;
    };
    // 捕获指针按下，避免浮层因失焦而提前卸载；再消费完整的点击，不能穿到父笔记触发自动保存。
    const holdFocus = (event: PointerEvent): void => { if (event.button === 0) blockOutside(event); };
    const closeOutside = (event: globalThis.MouseEvent): void => {
      if (blockOutside(event)) { setHeadingOpen(false); headingTrigger.current?.focus({ preventScroll: true }); }
    };
    document.addEventListener("pointerdown", holdFocus, true);
    document.addEventListener("click", closeOutside, true);
    return () => {
      document.removeEventListener("pointerdown", holdFocus, true);
      document.removeEventListener("click", closeOutside, true);
    };
  }, [showHeadings]);

  const formatHeading = (level: 0 | (typeof headings)[number]): void => {
    const command = editor?.chain().focus();
    if (level === 0) command?.setParagraph().run();
    else command?.setHeading({ level }).run();
    setHeadingOpen(false);
  };
  const openLink = (): void => {
    if (editor === null) return;
    const href: unknown = editor.getAttributes("link").href;
    if (typeof href === "string") editor.commands.extendMarkRange("link");
    const { from, to } = editor.state.selection;
    const selection = editor.state.doc.textBetween(from, to, " ");
    setLink({ mode: "manual", label: selection, url: typeof href === "string" ? href : "", selection, range: { from, to }, resource: "", invalid: false, closing: false });
  };
  const closeLink = (target: "body" | "trigger"): void => {
    if (link === null || linkReturn.current !== null) return;
    linkReturn.current = target;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setLink(null);
    else setLink({ ...link, closing: true });
  };
  const insertLink = (): void => {
    if (editor === null || link === null || !editable || linkReturn.current !== null) return;
    const href = link.url.trim();
    if (resolveSafeHttpUrl(href) === null) { setLink({ ...link, invalid: true }); return; }
    const label = link.label.trim() || href;
    // 子窗接管焦点期间正文不可编辑，恢复打开时的范围，再由原有 Markdown 命令插入或更新。
    const command = editor.chain().setTextSelection(link.range);
    const changed = link.selection !== "" && label === link.selection
      ? command.setLink({ href }).run()
      : command.insertContent({ type: "text", text: label, marks: [{ type: "link", attrs: { href } }] }).run();
    if (changed) closeLink("body");
  };
  const onLinkKey = (event: KeyboardEvent<HTMLDialogElement>): void => {
    // DOM 虽然仍在父表单之下，子窗的键盘事件由原生模态层或自己的控件处理。
    event.stopPropagation();
    if (linkClosing) { event.preventDefault(); return; }
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault(); closeLink("trigger");
    } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault(); insertLink();
    }
  };
  const followLink = (event: MouseEvent<HTMLDivElement>): void => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[data-ink-note-link]") : null;
    if (anchor === null) return;
    event.preventDefault();
    try {
      // 只转交用户触发的导航。浏览器返回空句柄可能是来源隔离的正常结果，无法据此判断站点失效。
      const requested = requestSafeUrlOpen(anchor.dataset.inkNoteLink, (url, target, features) => window.open(url, target, features));
      setLinkError(requested ? null : "invalidUrl");
    } catch {
      setLinkError("openingFailed");
    }
  };

  const linkHost = link === null ? null : mount.current?.closest<HTMLElement>(".ink-note-dialog");
  return <div className="ink-note-editor" data-ink-note-editor>
    <div className="ink-note-editor__toolbar" role="toolbar" aria-label={labels.toolbar}>
      <div className="ink-note-editor__heading" ref={headingWrap} onBlur={event => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setHeadingOpen(false);
      }} onKeyDown={event => {
        if (event.key !== "Escape" || !showHeadings || event.nativeEvent.isComposing) return;
        event.preventDefault(); event.stopPropagation(); setHeadingOpen(false); headingTrigger.current?.focus({ preventScroll: true });
      }}>
        <NoteTool icon="heading" label={labels.heading} ref={headingTrigger} disabled={!ready || inTable}
          aria-expanded={showHeadings} aria-controls={showHeadings ? `${id}-headings` : undefined} onClick={() => setHeadingOpen(!showHeadings)} />
        {showHeadings ? <div className="ink-note-editor__heading-options" id={`${id}-headings`} role="group" aria-label={labels.heading}>
          <button type="button" aria-pressed={heading === 0} onClick={() => formatHeading(0)}>{labels.paragraph}</button>
          {headings.map((level, index) => <button key={level} type="button" aria-pressed={heading === level}
            onClick={() => formatHeading(level)}>{labels.levels[index]}</button>)}
        </div> : null}
      </div>
      <NoteTool icon="bold" label={labels.bold} disabled={!ready} aria-pressed={editor?.isActive("bold") ?? false}
        onClick={() => editor?.chain().focus().toggleBold().run()} />
      <NoteTool icon="bullets" label={labels.bullets} disabled={!ready} aria-pressed={editor?.isActive("bulletList") ?? false}
        onClick={() => editor?.chain().focus().toggleBulletList().run()} />
      <NoteTool icon="ordered" label={labels.ordered} disabled={!ready} aria-pressed={editor?.isActive("orderedList") ?? false}
        onClick={() => editor?.chain().focus().toggleOrderedList().run()} />
      <NoteTool icon="table" label={labels.table} disabled={!ready || inTable}
        onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run()} />
      {inTable ? <>
        <NoteTool icon="row" label={labels.row} disabled={!ready} onClick={() => editor?.chain().focus().addRowAfter().run()} />
        <NoteTool icon="column" label={labels.column} disabled={!ready} onClick={() => editor?.chain().focus().addColumnAfter().run()} />
        <NoteTool icon="deleteRow" label={labels.deleteRow} disabled={!ready} onClick={() => deleteSelectedRows(editor)} />
        <NoteTool icon="deleteColumn" label={labels.deleteColumn} disabled={!ready} onClick={() => editor?.chain().focus().deleteColumn().run()} />
      </> : null}
      <NoteTool icon="code" label={labels.code} disabled={!ready || inTable} aria-pressed={editor?.isActive("codeBlock") ?? false}
        onClick={() => editor?.chain().focus().toggleCodeBlock().run()} />
      <NoteTool icon="link" label={labels.link} ref={linkTrigger} disabled={!ready || editor?.isActive("codeBlock")} aria-expanded={linkOpen}
        aria-haspopup="dialog" aria-controls={linkOpen ? id : undefined} onClick={openLink} />
    </div>
    {metadata}
    {link === null || linkHost == null ? null : createPortal(<dialog className="ink-note-editor__link-modal" ref={linkDialog} id={id}
      aria-labelledby={`${id}-label`} data-closing={linkClosing} onKeyDown={onLinkKey} onCancel={event => event.preventDefault()} onClick={event => {
        event.stopPropagation();
        if (event.target === event.currentTarget) closeLink("trigger");
      }}>
      <div className="ink-note-editor__link" onTransitionEnd={event => {
        if (linkClosing && event.target === event.currentTarget && event.propertyName === "opacity"
          && getComputedStyle(event.currentTarget).opacity === "0") setLink(null);
      }}>
        <h3 id={`${id}-label`}>{labels.insertLink}</h3>
        <div className="ink-note-editor__link-controls">
          <button type="button" aria-pressed={link.mode === "manual"}
            onClick={() => setLink({ ...link, mode: "manual" })}>{labels.manual}</button>
          <button type="button" disabled={resources.length === 0} aria-pressed={link.mode === "resource"}
            onClick={() => setLink({ ...link, mode: "resource" })}>{labels.fromResource}</button>
        </div>
        {link.mode !== "resource" ? null : <label>{labels.resource}<select value={link.resource}
          onChange={event => {
            const resource = event.target.value;
            const selected = resource === "" ? undefined : resources[Number(resource)];
            if (selected === undefined) { setLink({ ...link, resource }); return; }
            const previous = link.resource === "" ? undefined : resources[Number(link.resource)];
            setLink({ ...link, resource, url: selected.url, invalid: false,
              label: link.label === "" || link.label === previous?.title ? selected.title : link.label });
          }}>
          <option value="">{labels.choose}</option>
          {resources.map((resource, index) => <option key={resource.url} value={index}>{resource.title || resource.url}</option>)}
        </select></label>}
        <label>{labels.url}<input ref={address} type="text" inputMode="url" value={link.url} aria-invalid={link.invalid}
          onChange={event => setLink({ ...link, url: event.target.value, invalid: false })} /></label>
        <label>{labels.label}<input value={link.label} onChange={event => setLink({ ...link, label: event.target.value })} /></label>
        {link.invalid ? <p role="alert">{labels.invalidUrl}</p> : null}
        <div className="ink-note-editor__link-controls">
          <button type="button" onClick={() => closeLink("trigger")}>{labels.cancel}</button>
          <button type="button" onClick={insertLink}>{labels.insertLink}</button>
        </div>
      </div>
    </dialog>, linkHost)}
    <div className="ink-note-editor__body" ref={mount} onClick={followLink} />
    {linkError === null ? null : <p className="ink-note-editor__link-error" role="alert">{labels[linkError]}</p>}
  </div>;
}
