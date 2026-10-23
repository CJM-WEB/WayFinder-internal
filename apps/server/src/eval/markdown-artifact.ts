/**
 * 模块职责：把 Eval 工件中的不可信字符串转为只可显示的 Markdown 纯文本。
 *
 * 关键边界：逐 Unicode code point 编码避免 Markdown Link/Image、HTML Tag、
 * Code Fence 或自动外链；该函数只处理呈现注入，不代替 Secret 扫描。
 */
export function encodeMarkdownArtifactText(value: string): string {
  return [...value]
    .map(codePoint => `&#${String(codePoint.codePointAt(0))};`)
    .join("");
}
