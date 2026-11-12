/** 静态回归：设置语言、默认遮挡、独立表单和读取失败提示；真实确认 / 取消由浏览器旅程验证。 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// 静态渲染明确读取已准备的状态；Zustand默认SSR快照是创建时状态，不能代表本用例的读取失败。
vi.mock("zustand", () => ({
  useStore: <State, Selected>(store: { getState: () => State }, selector: (state: State) => Selected): Selected => selector(store.getState()),
}));

import { CredentialsErrorCodeSchema } from "@wayfinder/contracts";
import { getMessages } from "../i18n/messages.js";
import { credentialSettingsStore } from "../stores/credential-settings.js";
import { InkSettingsPanel } from "./ink-settings.js";

const initial = credentialSettingsStore.getState();
afterEach(() => credentialSettingsStore.setState(initial));
const render = (language: "zh-CN" | "en-US", error: "read" | "save" | null = null) => {
  credentialSettingsStore.setState({ error, notice: null, preferences: {
    deepseek: { source: "own", apiKey: "fake-personal-llm" },
    serpapi: { source: "own", apiKey: "fake-personal-search" },
  } });
  return renderToStaticMarkup(<InkSettingsPanel open presented language={language} onClose={() => undefined} />);
};

describe("凭据设置呈现", () => {
  it("两个服务独立保存，默认遮挡Key且不把输入放到图编辑表单", () => {
    const html = render("zh-CN");
    expect(html).toContain('aria-label="DeepSeek 设置"');
    expect(html).toContain('aria-label="SerpAPI 设置"');
    // 登录移入独立弹窗；设置只保留两项默认遮挡的 Key 和明确登录入口。
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-label="邮箱账号"');
    expect(html).toContain("登录");
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('maxLength="4096"');
    expect(html.match(/保存设置/g)).toHaveLength(2);
    expect(html).toContain(getMessages("zh-CN").settings.ownHint);
    expect(html).not.toContain("ink-workspace-form");
  });

  it("English覆盖设置与每个公共前置错误，不翻译服务名", () => {
    const html = render("en-US");
    expect(html).toContain("DeepSeek"); expect(html).toContain("SerpAPI");
    expect(html).toContain("Your API key"); expect(html).toContain("Author trial");
    expect(html).not.toContain(getMessages("zh-CN").settings.own);
    for (const code of CredentialsErrorCodeSchema.options) {
      expect(getMessages("zh-CN").settings.problems[code]).toBeTruthy();
      expect(getMessages("en-US").settings.problems[code]).toBeTruthy();
    }
  });

  it("读取失败保留明确重试入口和禁用保存，不宣称已保存", () => {
    const html = render("zh-CN", "read");
    expect(html).toContain(getMessages("zh-CN").settings.readFailure);
    expect(html).toContain(getMessages("zh-CN").settings.retry);
    expect(html).not.toContain(getMessages("zh-CN").settings.saved);
    expect(html.match(/type="submit"[^>]*disabled=""/g)).toHaveLength(2);
  });
});
