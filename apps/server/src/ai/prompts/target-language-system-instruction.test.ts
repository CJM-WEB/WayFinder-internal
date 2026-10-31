/** 测试职责：冻结两种正式语言的可信 System 指令与未知值失败关闭语义。 */
import type { SearchLanguage } from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import {
  appendTargetLanguageSystemInstruction,
  createTargetLanguageSystemInstruction,
} from "./target-language-system-instruction.js";

describe("Target Language System Instruction", () => {
  it.each([
    ["zh-CN", "Simplified Chinese"],
    ["en-US", "American English"],
  ] as const)("%s 生成唯一目标语言规则", (language, expectedLanguage) => {
    const instruction = createTargetLanguageSystemInstruction(language);

    expect(instruction).toContain("[target_language]");
    expect(instruction).toContain(expectedLanguage);
    expect(instruction).toMatch(/node titles and descriptions, search queries/i);
    expect(instruction).toMatch(/summaries, and selection reasons/i);
    expect(instruction).toMatch(/proper nouns, product names, code, URLs/i);
  });

  it("只在既有 System Prompt 后追加语言区块", () => {
    expect(appendTargetLanguageSystemInstruction("BASE", "en-US")).toMatch(
      /^BASE\n\n<target_language>[\s\S]*American English[\s\S]*<\/target_language>$/,
    );
  });

  it("绕过 Contract 的未知语言在构造 LLM 输入前失败", () => {
    expect(() =>
      createTargetLanguageSystemInstruction("en-GB" as SearchLanguage),
    ).toThrow(TypeError);
  });
});
