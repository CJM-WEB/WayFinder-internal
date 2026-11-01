/**
 * 模块职责：把已验证的 SearchLanguage（搜索语言）转换为四个 LLM 阶段共用的
 * Target Language System Instruction（目标语言系统指令）。
 *
 * 安全边界：语言来自公共 Contract，必须进入 System 层；用户 Query、Node 文本与
 * 网页 Evidence 仍是不可信数据，不能覆盖这里的输出语言约束。
 */
import type { SearchLanguage } from "@wayfinder/contracts";

const TARGET_LANGUAGE_INSTRUCTION_BY_LANGUAGE = Object.freeze({
  "zh-CN":
    "Write every model-generated natural-language output field, including analysis topics, node titles and descriptions, search queries, summaries, and selection reasons, in Simplified Chinese. Preserve proper nouns, product names, code, URLs, and source text when translating them would reduce accuracy.",
  "en-US":
    "Write every model-generated natural-language output field, including analysis topics, node titles and descriptions, search queries, summaries, and selection reasons, in American English. Preserve proper nouns, product names, code, URLs, and source text when translating them would reduce accuracy.",
} as const satisfies Readonly<Record<SearchLanguage, string>>);

/**
 * 运行时仍执行显式查表校验，防止内部调用绕过 TypeScript 与 SearchRequestSchema。
 * 返回独立 XML-like 区块，避免与各版本 Prompt 的既有规则或不可信数据混合。
 */
export function createTargetLanguageSystemInstruction(
  language: SearchLanguage,
): string {
  const instruction: string | undefined =
    TARGET_LANGUAGE_INSTRUCTION_BY_LANGUAGE[language];
  if (instruction === undefined) {
    throw new TypeError("Target Language System Instruction 不支持该语言");
  }

  return `<target_language>\n[target_language] ${instruction}\n</target_language>`;
}

/** 只在 System 层追加一次语言区块；调用方不得把返回值放入 user 数据包。 */
export function appendTargetLanguageSystemInstruction(
  systemPrompt: string,
  language: SearchLanguage,
): string {
  return `${systemPrompt}\n\n${createTargetLanguageSystemInstruction(language)}`;
}
