/**
 * 测试职责：核对新资源条确实保留既有安全/来源/状态语义。
 * 动画时序、真实悬浮和打开次数由浏览器回归验证；此处不伪造浏览器或 Shader 状态。
 */
import type { EditableNode, Resource } from "@wayfinder/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { pythonResultGraphFixture } from "../fixtures/python-result-graph.js";
import { getMessages } from "../i18n/messages.js";
import type { GraphStoreNode } from "../stores/graph-store.js";
import InkResources, { type InkResourcesProps } from "./ink-resources.js";

function readyNode(): GraphStoreNode {
  const source = pythonResultGraphFixture.graph.nodes.find(node => node.status === "ready");
  if (source === undefined || source.status !== "ready" || source.resources[0] === undefined) throw new Error("缺少资源条测试样例");
  return { ...source, resources: Array.from({ length: 4 }, (_, index): Resource => ({
    ...source.resources[0]!, id: `strip-${index}`, title: `原始资源 ${index + 1}`, summary: "保持原网页说明", whySelected: "保持原选用理由",
    url: `https://strip-${index}.example.com/`, canonicalUrl: `https://strip-${index}.example.com/`, domain: `strip-${index}.example.com`, rank: index + 1, engine: "baidu",
  })) };
}

const render = (node: GraphStoreNode | EditableNode | null, extra: Partial<InkResourcesProps> = {}) => renderToStaticMarkup(createElement(InkResources, {
  graphId: "resource-graph", node, language: "zh-CN", visible: true, onClose: () => undefined, ...extra,
}));

describe("墨迹只读资源条", () => {
  it("没有有效选择或不可见时不生成资源交互层", () => {
    expect(render(null)).toBe("");
    expect(render(readyNode(), { graphId: null })).toBe("");
    expect(render(readyNode(), { visible: false })).toBe("");
  });

  it("默认只呈现既有Top 3，保留详情原文与真实来源，切换UI语言不翻译资源", () => {
    const markup = render(readyNode(), { language: "en-US" });
    expect(markup.match(/data-ink-resource=/g)).toHaveLength(3);
    expect(markup).toContain("Show more (1)");
    expect(markup).not.toContain("原始资源 4");
    expect(markup).toContain("原始资源 1");
    expect(markup).toContain("保持原网页说明");
    expect(markup).toContain("保持原选用理由");
    expect(markup).toContain("Baidu");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-ink-overlay="true"');
  });

  it("最终点击边界拒绝无效URL，人工资源不冒用既有引擎来源", () => {
    const source = readyNode();
    if (!("resources" in source) || source.resources[0] === undefined) throw new Error("缺少资源");
    const invalid = render({ ...source, resources: [{ ...source.resources[0], url: "javascript:alert(1)" }] });
    expect(invalid).toContain('class="ink-resources__open" disabled=""');
    expect(invalid).toContain(getMessages("zh-CN").resourcePanel.invalidUrl);
    const manual: EditableNode = { id: "manual", title: "人工节点", description: "", nodeType: "primary", layer: 0, status: "edited", warnings: [], resources: [{
      id: "manual-resource", title: "人工资源", url: "https://manual.example.com/", canonicalUrl: "https://manual.example.com/", domain: "manual.example.com",
      summary: "人工说明", whySelected: "人工理由", rank: 1, origin: "manual", sourceType: "user_added",
    }] };
    const markup = render(manual);
    expect(markup).toContain("用户添加");
    expect(markup).not.toContain("实际搜索引擎");
  });

  it("partial与failed保留公共提示，原始协议错误码不进入呈现", () => {
    const partial = pythonResultGraphFixture.graph.nodes.find(node => node.status === "partial");
    const failed = pythonResultGraphFixture.graph.nodes.find(node => node.status === "failed");
    if (partial === undefined || failed === undefined) throw new Error("缺少结果状态样例");
    expect(render(partial)).toContain("结果部分降级");
    const markup = render(failed);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("节点处理失败");
    expect(markup).not.toContain("SEARCH_PROVIDER_FAILED");
  });
});
