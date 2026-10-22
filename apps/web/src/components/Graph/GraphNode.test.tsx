/**
 * 测试职责：验证六态展示模型确实接入生产 GraphNode（图节点）的可见文本与 ARIA 语义。
 *
 * Handle（连接点）不属于状态展示，测试中替换为空组件，避免依赖 React Flow 画布上下文。
 */
import type { StreamNodeStatus } from "@wayfinder/contracts";
import type { NodeProps } from "@xyflow/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { GraphFlowNode } from "./graph-layout.js";

vi.mock("@xyflow/react", async importOriginal => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();

  return { ...actual, Handle: () => null };
});

import { GraphNode } from "./GraphNode.js";

const createNodeProps = (
  status: StreamNodeStatus,
  resourceCount: number,
): NodeProps<GraphFlowNode> => ({
  id: `node-${status}`,
  type: "wayfinder",
  data: {
    title: `状态 ${status}`,
    nodeType: "primary",
    status,
    resourceCount,
  },
  dragging: false,
  zIndex: 0,
  selectable: true,
  deletable: false,
  selected: false,
  draggable: false,
  isConnectable: false,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
});

describe("GraphNode 渐进状态接线", () => {
  it("searching 输出活动加载语义和独立可见提示", () => {
    const markup = renderToStaticMarkup(
      <GraphNode {...createNodeProps("searching", 0)} />,
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('data-node-status="searching"');
    expect(markup).toContain("↻");
    expect(markup).toContain("检索中");
    expect(markup).toContain("正在检索网页");
  });

  it.each([
    ["ready", 2, "✓", "已就绪", "2 条可用资源"],
    ["partial", 2, "!", "部分完成", "2 条可用资源 · 含降级"],
    ["failed", 0, "×", "失败", "没有可用资源"],
  ] as const)("%s 以独立提示结束加载", (status, count, marker, label, detail) => {
    const markup = renderToStaticMarkup(
      <GraphNode {...createNodeProps(status, count)} />,
    );

    expect(markup).toContain('aria-busy="false"');
    expect(markup).toContain(`data-node-status="${status}"`);
    expect(markup).toContain(marker);
    expect(markup).toContain(label);
    expect(markup).toContain(detail);
  });
});
