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

  it("failed 明确结束加载并展示失败说明", () => {
    const markup = renderToStaticMarkup(
      <GraphNode {...createNodeProps("failed", 0)} />,
    );

    expect(markup).toContain('aria-busy="false"');
    expect(markup).toContain('data-node-status="failed"');
    expect(markup).toContain("×");
    expect(markup).toContain("失败");
    expect(markup).toContain("没有可用资源");
  });
});
