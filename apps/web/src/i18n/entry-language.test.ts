/** 回归职责：入口偏好只接受单个明确语言，不把未知 URL 输入送入搜索业务。 */
import { describe, expect, it } from "vitest";
import { resolveEntryLanguage } from "./entry-language.js";

describe("resolveEntryLanguage", () => {
  it.each(["zh-CN", "en-US"] as const)("保留受支持的 %s", language => {
    expect(resolveEntryLanguage(`?language=${language}`)).toBe(language);
  });

  it.each(["", "?language=", "?language=en", "?language=fr-FR", "?language=en-US&language=zh-CN"])(
    "忽略缺失、非法或重复输入 %s", search => {
      expect(resolveEntryLanguage(search)).toBeNull();
    },
  );
});
