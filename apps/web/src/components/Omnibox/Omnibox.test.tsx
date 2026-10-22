/**
 * 测试职责：冻结 WAY-76/77 的单入口提交、Direct 分流与最小可访问表单结构。
 *
 * 原生 form 负责 Enter 键行为；测试只验证组件没有额外 key handler 所需的第二条提交路径，
 * 并把 trim、空白拒绝和一次调用一个 Run 的确定性边界锁在纯函数上。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Omnibox, startOmniboxSubmission } from "./Omnibox.js";

describe("Omnibox", () => {
  it("提交去除首尾空白后的非空 Query，且只启动一次搜索", async () => {
    const startSearch = vi.fn(async () => undefined);
    const openDirectUrl = vi.fn(() => true);

    const submission = startOmniboxSubmission(
      "  我想学习线性代数  ",
      startSearch,
      openDirectUrl,
    );

    expect(submission.kind).toBe("ai_search");
    if (submission.kind !== "ai_search") {
      throw new Error("非空 Query 应启动搜索");
    }

    await submission.completion;
    expect(submission.query).toBe("我想学习线性代数");
    expect(startSearch).toHaveBeenCalledExactlyOnceWith("我想学习线性代数");
    expect(openDirectUrl).not.toHaveBeenCalled();
  });

  it("纯空白输入不启动搜索", () => {
    const startSearch = vi.fn(async () => undefined);
    const openDirectUrl = vi.fn(() => true);

    const submission = startOmniboxSubmission(
      " \t\n ",
      startSearch,
      openDirectUrl,
    );

    expect(submission).toEqual({ kind: "invalid", reason: "query" });
    expect(startSearch).not.toHaveBeenCalled();
    expect(openDirectUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["https://example.com/docs", "https://example.com/docs"],
    ["  hTtP://EXAMPLE.com:8080/path  ", "http://example.com:8080/path"],
  ])("显式 HTTP(S) URL 只走 Direct 且不创建 Run：%s", (input, expected) => {
    const startSearch = vi.fn(async () => undefined);
    const openDirectUrl = vi.fn(() => true);

    const submission = startOmniboxSubmission(
      input,
      startSearch,
      openDirectUrl,
    );

    expect(submission).toEqual({ kind: "direct", url: expected });
    expect(openDirectUrl).toHaveBeenCalledExactlyOnceWith(expected);
    expect(startSearch).not.toHaveBeenCalled();
  });

  it("合法长 HTTP(S) URL 不受 SearchRequest Query 长度限制", () => {
    const startSearch = vi.fn(async () => undefined);
    const openDirectUrl = vi.fn(() => true);
    const url = `https://example.com/${"a".repeat(2_000)}`;

    expect(startOmniboxSubmission(url, startSearch, openDirectUrl)).toEqual({
      kind: "direct",
      url,
    });
    expect(openDirectUrl).toHaveBeenCalledExactlyOnceWith(url);
    expect(startSearch).not.toHaveBeenCalled();
  });

  it.each([
    ["http://", "invalid_url"],
    ["https:example.com", "invalid_url"],
    ["javascript:alert(1)", "unsupported_protocol"],
    ["data:text/html,unsafe", "unsupported_protocol"],
    ["file:///tmp/example", "unsupported_protocol"],
    ["mailto:user@example.com", "unsupported_protocol"],
    ["vbscript:msgbox(1)", "unsupported_protocol"],
    ["ftp://example.com/file", "unsupported_protocol"],
    ["custom://example.com", "unsupported_protocol"],
  ] as const)("畸形或不支持协议给出明确拒绝且不创建 Run：%s", (input, reason) => {
    const startSearch = vi.fn(async () => undefined);
    const openDirectUrl = vi.fn(() => true);

    expect(
      startOmniboxSubmission(input, startSearch, openDirectUrl),
    ).toEqual({ kind: "invalid", reason });
    expect(startSearch).not.toHaveBeenCalled();
    expect(openDirectUrl).not.toHaveBeenCalled();
  });

  it.each([
    "example.com",
    "//example.com/path",
    "/relative/path",
    "site:github.com WayFinder",
    "custom:payload",
  ])("非显式 URL 保持普通 AI Search：%s", async input => {
    const startSearch = vi.fn(async () => undefined);
    const openDirectUrl = vi.fn(() => true);

    const submission = startOmniboxSubmission(
      input,
      startSearch,
      openDirectUrl,
    );

    expect(submission.kind).toBe("ai_search");
    if (submission.kind !== "ai_search") {
      throw new Error("非显式 URL 应进入 AI Search");
    }
    await submission.completion;
    expect(startSearch).toHaveBeenCalledExactlyOnceWith(input);
    expect(openDirectUrl).not.toHaveBeenCalled();
  });

  it("只渲染一个浏览器式文本入口，不要求模式或额外表单", () => {
    const markup = renderToStaticMarkup(
      <Omnibox
        startSearch={async () => undefined}
        openDirectUrl={() => true}
      />,
    );

    expect(markup).toContain('role="search"');
    expect(markup).toContain('type="search"');
    expect(markup).toContain('type="submit"');
    expect(markup.match(/<input\b/g)).toHaveLength(1);
    expect(markup).not.toContain("<select");
  });
});
