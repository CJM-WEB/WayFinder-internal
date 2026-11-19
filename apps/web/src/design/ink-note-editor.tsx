/**
 * 模块职责：按需加载排版式笔记编辑器；在编辑器内部维护选区与组合输入，向上层提交 Markdown。
 * 外部内容始终经过受支持的编辑器结构；链接保留用户确认的原网址，打开由独立功能负责。
 */
import { Editor, type JSONContent, type MarkdownParseHelpers, type MarkdownRendererHelpers, type MarkdownToken, type RenderContext } from "@tiptap/core";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { isInTable, rowIsHeader, selectedRect } from "@tiptap/pm/tables";
import StarterKit from "@tiptap/starter-kit";
import type { EditableResource, SearchLanguage } from "@wayfinder/contracts";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { getMessages } from "../i18n/messages.js";
import { resolveSafeHttpUrl } from "../lib/url.js";
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
  },
  "en-US": {
    body: "Content", toolbar: "Note formatting", heading: "Heading level", paragraph: "Paragraph",
    levels: ["Heading 1", "Heading 2", "Heading 3"],
    bold: "Bold", bullets: "Bullet list", ordered: "Numbered list", table: "Insert table", row: "Insert row below", column: "Insert column to the right",
    deleteRow: "Delete row", deleteColumn: "Delete column", code: "Code block", link: "Link", insertLink: "Insert link",
    manual: "Enter manually", fromResource: "Choose a node resource", resource: "Node resource", choose: "Choose a resource",
    label: "Link text", url: "Web address", cancel: "Cancel",
  },
} satisfies Record<SearchLanguage, Record<string, string | readonly string[]>>;
const headings = [1, 2, 3] as const;
const markdownPattern = /(?:^|\n)[^\S\n]*(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|\x60{3}|~{3}|\|)|\*\*[^*]+\*\*|\[[^\]\n]+\]\([^\n]+\)/;

/**
 * StarterKit 默认只在 HTML 和编辑命令侧验证链接，Markdown 导入仍会接受 token.href。
 * 同一校验守卫用于这条导入路径。此阶段只渲染无导航的标记，避免浏览器菜单绕过后续打开门禁。
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
          return typeof href === "string" && resolveSafeHttpUrl(href) !== null
            ? ["span", { "data-ink-note-link": href }, 0]
            : ["span", 0];
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
  resource: string;
  invalid: boolean;
};

export default function InkNoteEditor({ value, language, editable, resources, onChange, metadata }: Props) {
  const labels = text[language];
  const id = useId();
  const mount = useRef<HTMLDivElement>(null);
  const linkTrigger = useRef<HTMLButtonElement>(null);
  const address = useRef<HTMLInputElement>(null);
  // 外层用笔记会话重建编辑器；会话内的 Markdown 回显不能覆盖较新的编辑事务或中文组合选区。
  const initialValue = useRef(value);
  const latest = useRef({ editable, onChange, body: labels.body });
  const published = useRef(value);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [, setRevision] = useState(0);
  const [link, setLink] = useState<LinkDraft | null>(null);

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
    if (!editable) setLink(null);
  }, [editor, editable, labels.body]);

  const linkOpen = link !== null;
  useEffect(() => {
    if (linkOpen) address.current?.focus();
  }, [linkOpen]);

  const heading = headings.find(level => editor?.isActive("heading", { level })) ?? 0;
  const inTable = editor?.isActive("table") ?? false;
  const ready = editor !== null && editable;
  const openLink = (): void => {
    if (editor === null) return;
    const href: unknown = editor.getAttributes("link").href;
    if (typeof href === "string") editor.commands.extendMarkRange("link");
    const { from, to } = editor.state.selection;
    const selection = editor.state.doc.textBetween(from, to, " ");
    setLink({ mode: "manual", label: selection, url: typeof href === "string" ? href : "", selection, resource: "", invalid: false });
  };
  const cancelLink = (): void => { setLink(null); linkTrigger.current?.focus(); };
  const insertLink = (): void => {
    if (editor === null || link === null || !editable) return;
    const href = link.url.trim();
    if (resolveSafeHttpUrl(href) === null) { setLink({ ...link, invalid: true }); return; }
    const label = link.label.trim() || href;
    const command = editor.chain().focus();
    const changed = link.selection !== "" && label === link.selection
      ? command.setLink({ href }).run()
      : command.insertContent({ type: "text", text: label, marks: [{ type: "link", attrs: { href } }] }).run();
    if (changed) setLink(null);
  };
  const onLinkKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); cancelLink();
    } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault(); event.stopPropagation(); insertLink();
    }
  };

  return <div className="ink-note-editor" data-ink-note-editor>
    <div className="ink-note-editor__toolbar" role="toolbar" aria-label={labels.toolbar}>
      <select tabIndex={0} aria-label={labels.heading} disabled={!ready || inTable}
        value={heading} onChange={event => {
          const level = headings.find(item => String(item) === event.target.value);
          const command = editor?.chain().focus();
          if (level === undefined) command?.setParagraph().run();
          else command?.setHeading({ level }).run();
        }}>
        <option value={0}>{labels.paragraph}</option>
        {headings.map((level, index) => <option key={level} value={level}>{labels.levels[index]}</option>)}
      </select>
      <button type="button" disabled={!ready} aria-pressed={editor?.isActive("bold") ?? false}
        onClick={() => editor?.chain().focus().toggleBold().run()}>{labels.bold}</button>
      <button type="button" disabled={!ready} aria-pressed={editor?.isActive("bulletList") ?? false}
        onClick={() => editor?.chain().focus().toggleBulletList().run()}>{labels.bullets}</button>
      <button type="button" disabled={!ready} aria-pressed={editor?.isActive("orderedList") ?? false}
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}>{labels.ordered}</button>
      <button type="button" disabled={!ready || inTable}
        onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run()}>{labels.table}</button>
      {inTable ? <>
        <button type="button" disabled={!ready} onClick={() => editor?.chain().focus().addRowAfter().run()}>{labels.row}</button>
        <button type="button" disabled={!ready} onClick={() => editor?.chain().focus().addColumnAfter().run()}>{labels.column}</button>
        <button type="button" disabled={!ready} onClick={() => deleteSelectedRows(editor)}>{labels.deleteRow}</button>
        <button type="button" disabled={!ready} onClick={() => editor?.chain().focus().deleteColumn().run()}>{labels.deleteColumn}</button>
      </> : null}
      <button type="button" disabled={!ready || inTable} aria-pressed={editor?.isActive("codeBlock") ?? false}
        onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>{labels.code}</button>
      <button type="button" ref={linkTrigger} disabled={!ready || editor?.isActive("codeBlock")} aria-expanded={linkOpen}
        aria-controls={linkOpen ? id : undefined} onClick={linkOpen ? cancelLink : openLink}>{labels.link}</button>
    </div>
    {metadata}
    {link === null ? null : <div className="ink-note-editor__link" id={id} role="group" aria-label={labels.insertLink} onKeyDown={onLinkKey}>
      <div className="ink-note-editor__link-controls">
        <button type="button" aria-pressed={link.mode === "manual"}
          onClick={() => setLink({ ...link, mode: "manual" })}>{labels.manual}</button>
        <button type="button" disabled={resources.length === 0} aria-pressed={link.mode === "resource"}
          onClick={() => setLink({ ...link, mode: "resource" })}>{labels.fromResource}</button>
      </div>
      {link.mode !== "resource" ? null : <label>{labels.resource}<select tabIndex={0} value={link.resource}
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
      {link.invalid ? <p role="alert">{getMessages(language).editor.invalidUrl}</p> : null}
      <div className="ink-note-editor__link-controls">
        <button type="button" onClick={cancelLink}>{labels.cancel}</button>
        <button type="button" onClick={insertLink}>{labels.insertLink}</button>
      </div>
    </div>}
    <div className="ink-note-editor__body" ref={mount} />
  </div>;
}
