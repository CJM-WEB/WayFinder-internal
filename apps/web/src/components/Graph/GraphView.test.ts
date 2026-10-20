/**
 * 测试职责：冻结 React Flow selection 到业务 Store 选择 ID 的边界语义。
 *
 * 关键约束：点击空白画布产生空 selection 时必须返回 null，防止面板保留陈旧资源。
 */
import { describe, expect, it } from "vitest";

import { pythonResultGraphFixture } from "../../fixtures/python-result-graph.js";
import { buildGraphFlowElements } from "./graph-layout.js";
import {
  applySelectedNodeId,
  resolveSelectedNodeId,
} from "./graph-selection.js";

describe("Graph selection", () => {
  it("空 selection 会清除当前节点", () => {
    expect(resolveSelectedNodeId([])).toBeNull();
  });

  it("多选事件以最后一个节点作为当前节点", () => {
    expect(
      resolveSelectedNodeId([{ id: "first" }, { id: "current" }]),
    ).toBe("current");
  });

  it("同 ID 图快照刷新后仍从 Store 选择派生唯一高亮", () => {
    const elements = buildGraphFlowElements(
      pythonResultGraphFixture.graph.nodes,
      pythonResultGraphFixture.graph.edges,
    );
    const selectedNodeId = "python-installation";
    const firstSnapshot = applySelectedNodeId(
      elements.nodes,
      selectedNodeId,
    );
    const refreshedSnapshot = applySelectedNodeId(
      firstSnapshot.map(node => ({ ...node, selected: false })),
      selectedNodeId,
    );

    expect(
      refreshedSnapshot.filter(node => node.selected).map(node => node.id),
    ).toEqual([selectedNodeId]);
  });
});
