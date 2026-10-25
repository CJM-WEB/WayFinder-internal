/**
 * 测试职责：冻结浏览器外部 URL 的共享安全边界。
 *
 * 关键约束：只接受 Contract 允许的显式绝对 HTTP(S)，且安全 URL 只能触发一次新标签页打开。
 */
import { describe, expect, it, vi } from "vitest";

import { requestSafeUrlOpen, resolveSafeHttpUrl } from "./url.js";

describe("浏览器 URL 安全解析", () => {
  it.each([
    ["https://example.com/docs", "https://example.com/docs"],
    ["http://example.com/resource", "http://example.com/resource"],
    ["hTtPs://example.com/guide", "https://example.com/guide"],
    ["https://example.com/resource ", "https://example.com/resource"],
  ])("接受并规范化显式 HTTP(S) URL：%s", (input, expected) => {
    expect(resolveSafeHttpUrl(input)).toBe(expected);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "blob:https://example.com/unsafe",
    "file:///tmp/resource",
    "ftp://example.com/resource",
    "mailto:user@example.com",
    "//example.com/resource",
    "/relative/resource",
    "example.com/resource",
    " https://example.com/resource",
    "http://",
    "not a url",
  ])("拒绝不安全或畸形 URL：%s", input => {
    expect(resolveSafeHttpUrl(input)).toBeNull();
  });

  it.each([null, undefined, 42, {}, []])("拒绝非字符串输入：%o", input => {
    expect(resolveSafeHttpUrl(input)).toBeNull();
  });
});

describe("浏览器 URL 打开请求", () => {
  it("使用固定安全参数同步打开规范化后的 URL", () => {
    const opener = vi.fn(() => null);

    expect(requestSafeUrlOpen("hTtPs://example.com/guide", opener)).toBe(true);
    expect(opener).toHaveBeenCalledOnce();
    expect(opener).toHaveBeenCalledWith(
      "https://example.com/guide",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it.each([
    "javascript:alert(1)",
    "//example.com/resource",
    "not a url",
    null,
  ])("拒绝 %o 且不调用浏览器 opener", input => {
    const opener = vi.fn(() => null);

    expect(requestSafeUrlOpen(input, opener)).toBe(false);
    expect(opener).not.toHaveBeenCalled();
  });
});
