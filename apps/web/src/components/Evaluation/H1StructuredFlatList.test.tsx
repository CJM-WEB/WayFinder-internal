/**
 * 测试职责：证明 H1 Flat List 保留同一 Node/Edge/Resource，并只改变呈现与选择交互。
 */
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProcessingNodeStatus } from "@wayfinder/contracts";
import { describe, expect, it, vi } from "vitest";

import { pythonResultGraphFixture } from "../../fixtures/python-result-graph.js";
import type { GraphStoreNode } from "../../stores/graph-store.js";
import {
  buildH1FlatListItems,
  H1StructuredFlatListView,
} from "./H1StructuredFlatList.js";

const fixtureNodes = pythonResultGraphFixture.graph.nodes;
const fixtureEdges = pythonResultGraphFixture.graph.edges;

describe("H1 Structured Flat List", () => {
  it("保留 Node 顺序、对象引用、Resource 引用，并让每条 Edge 恰好出现一次", () => {
    const items = buildH1FlatListItems(fixtureNodes, fixtureEdges);

    expect(items.map(item => item.node.id)).toEqual(
      fixtureNodes.map(node => node.id),
    );
    items.forEach((item, index) => {
      expect(item.node).toBe(fixtureNodes[index]);
      if ("resources" in item.node && "resources" in fixtureNodes[index]!) {
        expect(item.node.resources).toBe(fixtureNodes[index]!.resources);
      }
    });
    expect(
      items.flatMap(item => item.relationships.map(({ edgeId }) => edgeId)),
    ).toEqual(fixtureEdges.map(edge => edge.id));
  });

  it("只展示 Graph 已有的信息，并把两类 Edge 转成文字关系", () => {
    const markup = renderToStaticMarkup(
      <H1StructuredFlatListView
        nodes={fixtureNodes}
        edges={fixtureEdges}
        selectedNodeId="python-basics"
        onSelectNode={() => undefined}
      />,
    );

    for (const node of fixtureNodes) {
      expect(markup).toContain(`data-node-id="${node.id}"`);
      expect(markup).toContain(node.title);
      // Description 不在 Graph Node 上可见，Flat 条件也不能额外增加信息量。
      expect(markup).not.toContain(node.description);
    }
    for (const edge of fixtureEdges) {
      expect(markup).toContain(`data-edge-id="${edge.id}"`);
    }
    expect(markup).toContain("推荐下一步");
    expect(markup).toContain("相关主题");
    expect(markup).toContain('aria-pressed="true"');
  });

  it("点击只把同一个 Node ID 交给共享选择动作", () => {
    const onSelectNode = vi.fn();
    const view = H1StructuredFlatListView({
      nodes: fixtureNodes,
      edges: fixtureEdges,
      selectedNodeId: null,
      onSelectNode,
    });
    if (!isValidElement<{ children: ReactNode }>(view)) {
      throw new Error("Flat List 应返回列表元素");
    }
    const firstItem = Children.toArray(view.props.children)[0];
    if (!isValidElement<{ children: ReactNode }>(firstItem)) {
      throw new Error("Flat List 应包含 Node 列表项");
    }
    const firstButton = Children.toArray(firstItem.props.children)[0];
    if (!isValidElement<{ onClick: () => void }>(firstButton)) {
      throw new Error("Node 列表项应包含选择按钮");
    }

    firstButton.props.onClick();

    expect(onSelectNode).toHaveBeenCalledOnce();
    expect(onSelectNode).toHaveBeenCalledWith(fixtureNodes[0]?.id);
  });

  it("渐进六态复用 Graph 的状态标签且不伪造 Resource", () => {
    const template = fixtureNodes[0]!;
    const createProcessingNode = (
      status: ProcessingNodeStatus,
    ): GraphStoreNode => ({
      id: status,
      title: template.title,
      description: template.description,
      nodeType: template.nodeType,
      layer: template.layer,
      searchPlan: template.searchPlan,
      status,
    });
    const processingNodes = [
      createProcessingNode("planned"),
      createProcessingNode("searching"),
      createProcessingNode("filtering"),
    ];
    const nodes: GraphStoreNode[] = [
      ...processingNodes,
      { ...template, id: "ready", status: "ready", warnings: [] },
      {
        ...template,
        id: "partial",
        status: "partial",
        warnings: ["RERANK_FAILED"],
      },
      {
        ...template,
        id: "failed",
        status: "failed",
        resources: [],
        warnings: [],
        error: { code: "SEARCH_PROVIDER_FAILED", retryable: true },
      },
    ];
    const markup = renderToStaticMarkup(
      <H1StructuredFlatListView
        nodes={nodes}
        edges={[]}
        selectedNodeId={null}
        onSelectNode={() => undefined}
      />,
    );

    for (const status of [
      "planned",
      "searching",
      "filtering",
      "ready",
      "partial",
      "failed",
    ]) {
      expect(markup).toContain(`data-node-status="${status}"`);
    }
  });
});
