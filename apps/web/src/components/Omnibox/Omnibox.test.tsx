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
    expect(startSearch).toHaveBeenCalledExactlyOnceWith({
      query: "我想学习线性代数",
      language: "zh-CN",
    });
    expect(openDirectUrl).not.toHaveBeenCalled();
  });

  it("English 选择确定性透传 en-US，不改写用户 Query", async () => {
    const startSearch = vi.fn(async () => undefined);
    const submission = startOmniboxSubmission(
      "What is MySQL?",
      startSearch,
      vi.fn(() => true),
      "en-US",
    );

    expect(submission.kind).toBe("ai_search");
    if (submission.kind !== "ai_search") {
      throw new Error("English Query 应启动搜索");
    }

    await submission.completion;
    expect(startSearch).toHaveBeenCalledExactlyOnceWith({
      query: "What is MySQL?",
      language: "en-US",
    });
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
    expect(startSearch).toHaveBeenCalledExactlyOnceWith({
      query: input,
      language: "zh-CN",
    });
    expect(openDirectUrl).not.toHaveBeenCalled();
  });

  it("渲染单一搜索入口与两个受控语言选项", () => {
    const markup = renderToStaticMarkup(
      <Omnibox
        startSearch={async () => undefined}
        openDirectUrl={() => true}
        language="zh-CN"
        renderLanguage="zh-CN"
        onLanguageChange={() => undefined}
      />,
    );

    expect(markup).toContain('role="search"');
    expect(markup).toContain('type="search"');
    expect(markup).toContain('type="submit"');
    expect(markup.match(/<input\b/g)).toHaveLength(1);
    expect(markup).toContain(">语言</label>");
    expect(markup.match(/<select\b/g)).toHaveLength(1);
    expect(markup).toContain('<option value="zh-CN" selected="">简体中文</option>');
    expect(markup).toContain('<option value="en-US">English</option>');
  });

  it("选择器值与旧 Run 展示语言分离，避免既有页面混语", () => {
    const markup = renderToStaticMarkup(
      <Omnibox
        startSearch={async () => undefined}
        openDirectUrl={() => true}
        language="en-US"
        renderLanguage="zh-CN"
        onLanguageChange={() => undefined}
      />,
    );

    expect(markup).toContain('<option value="en-US" selected="">English</option>');
    expect(markup).toContain("搜索任意主题");
    expect(markup).not.toContain("Search any topic");
  });

  it("没有旧 Run 时完整渲染 English 自产文案", () => {
    const markup = renderToStaticMarkup(
      <Omnibox
        startSearch={async () => undefined}
        openDirectUrl={() => true}
        language="en-US"
        renderLanguage="en-US"
        onLanguageChange={() => undefined}
      />,
    );

    expect(markup).toContain("Search any topic");
    expect(markup).toContain(">Language</label>");
    expect(markup).toContain(">Search</button>");
  });
});
