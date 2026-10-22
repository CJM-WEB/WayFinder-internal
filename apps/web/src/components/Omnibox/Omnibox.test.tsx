/**
 * 测试职责：冻结 WAY-76 的单入口提交语义与最小可访问表单结构。
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

    const submission = startOmniboxSubmission(
      "  我想学习线性代数  ",
      startSearch,
    );

    expect(submission.kind).toBe("started");
    if (submission.kind !== "started") {
      throw new Error("非空 Query 应启动搜索");
    }

    await submission.completion;
    expect(submission.query).toBe("我想学习线性代数");
    expect(startSearch).toHaveBeenCalledExactlyOnceWith("我想学习线性代数");
  });

  it("纯空白输入不启动搜索", () => {
    const startSearch = vi.fn(async () => undefined);

    const submission = startOmniboxSubmission(" \t\n ", startSearch);

    expect(submission).toEqual({ kind: "invalid" });
    expect(startSearch).not.toHaveBeenCalled();
  });

  it("只渲染一个浏览器式文本入口，不要求模式或额外表单", () => {
    const markup = renderToStaticMarkup(
      <Omnibox startSearch={async () => undefined} />,
    );

    expect(markup).toContain('role="search"');
    expect(markup).toContain('type="search"');
    expect(markup).toContain('type="submit"');
    expect(markup.match(/<input\b/g)).toHaveLength(1);
    expect(markup).not.toContain("<select");
  });
});
