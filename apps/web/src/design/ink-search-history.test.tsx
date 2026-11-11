/** 假备案回归：只在已打开抽屉内显示文本，固定官方链接，空值／关闭时无外部页脚。 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InkSearchHistory } from "./ink-search-history.js";

afterEach(() => vi.unstubAllEnvs());
const render = (open = true) => renderToStaticMarkup(<InkSearchHistory open={open} available language="zh-CN"
  onOpen={() => {}} onClose={() => {}} onNewSearch={() => {}} onSelectGraph={async () => {}}
  undoOpen={false} undoDisabled={false} onOpenUndo={() => {}} onCloseUndo={() => {}}
  settingsOpen={false} onOpenSettings={() => {}} onCloseSettings={() => {}} />);

describe("上拉面板备案显示", () => {
  it("未配置或抽屉关闭时不渲染备案底条", () => {
    vi.stubEnv("VITE_ICP_FILING", " ");
    expect(render()).not.toContain('class="ink-study__history-filing"');
    vi.stubEnv("VITE_ICP_FILING", "假ICP备00000000号");
    expect(render(false)).not.toContain('class="ink-study__history-filing"');
  });
  it("假配置作为转义文本，链接固定且属于抽屉内部", () => {
    vi.stubEnv("VITE_ICP_FILING", '假ICP备00000000号<script>测试</script>');
    const html = render();
    expect(html).toContain('data-has-filing="true"');
    expect(html).toContain('href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("假ICP备00000000号&lt;script&gt;测试&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toMatch(/<footer class="ink-study__history-filing"[^>]*aria-hidden="false"/);
    expect(html.indexOf('class="ink-study__history-filing"')).toBeGreaterThan(html.indexOf('class="ink-study__history-drawer"'));
  });
});
