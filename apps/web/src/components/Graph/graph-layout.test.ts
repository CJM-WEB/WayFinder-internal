/**
 * 测试职责：验证 Product Graph（产品图）到 React Flow 的确定性布局与 WAY-74 六态映射。
 *
 * 关键约束：
 * - recommended_next 是 Dagre 主层级的唯一输入。
 * - related_to 只决定 Related Node 的锚点，不能改变主节点坐标。
 * - 布局层不得丢弃或改写任何 Contract Node / Edge。
 */
import { MarkerType } from "@xyflow/react";
import {
  StreamNodeStatusSchema,
  type GraphEdge,
  type ProcessingNodeStatus,
} from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import { pythonResultGraphFixture } from "../../fixtures/python-result-graph.js";
import type { GraphStoreNode } from "../../stores/graph-store.js";
import {
  buildGraphFlowElements,
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
} from "./graph-layout.js";
import { NODE_STATUS_LABELS } from "./graph-labels.js";

const fixtureNodes = pythonResultGraphFixture.graph.nodes;
const fixtureEdges = pythonResultGraphFixture.graph.edges;

const positionById = (
  nodes: ReturnType<typeof buildGraphFlowElements>["nodes"],
) => new Map(nodes.map(node => [node.id, node.position]));

const fixtureNodeById = (nodeId: string): GraphStoreNode => {
  const node = fixtureNodes.find(candidate => candidate.id === nodeId);

  if (node === undefined) {
    throw new Error(`测试 fixture 缺少节点：${nodeId}`);
  }

  return node;
};

/** 从固定 Node Core 派生处理中状态，不复制或伪造终态 Resource。 */
const processingNode = (status: ProcessingNodeStatus): GraphStoreNode => {
  const template = fixtureNodeById("python-introduction");

  return {
    id: `processing-${status}`,
    title: `处理中：${status}`,
    description: template.description,
    nodeType: template.nodeType,
    layer: template.layer,
    searchPlan: template.searchPlan,
    status,
  };
};

const nodesOverlap = (
  first: { x: number; y: number },
  second: { x: number; y: number },
) =>
  first.x < second.x + GRAPH_NODE_WIDTH &&
  first.x + GRAPH_NODE_WIDTH > second.x &&
  first.y < second.y + GRAPH_NODE_HEIGHT &&
  first.y + GRAPH_NODE_HEIGHT > second.y;

describe("Graph layout", () => {
  it("把六种状态映射为独立 class 与中文可访问名称", () => {
    const processingFlows = buildGraphFlowElements(
      [
        processingNode("planned"),
        processingNode("searching"),
        processingNode("filtering"),
      ],
      [],
    ).nodes;
    const terminalFlows = buildGraphFlowElements(fixtureNodes, fixtureEdges)
      .nodes.filter(node =>
        ["ready", "partial", "failed"].includes(node.data.status),
      );
    const flowByStatus = new Map(
      [...processingFlows, ...terminalFlows].map(node => [
        node.data.status,
        node,
      ]),
    );

    for (const status of StreamNodeStatusSchema.options) {
      const node = flowByStatus.get(status);

      expect(node).toBeDefined();
      expect(node?.className).toContain(`graph-node--${status}`);
      expect(node?.ariaLabel).toContain(NODE_STATUS_LABELS[status]);
    }
  });

  it("保留 Python fixture 的全部节点、全部边与有限坐标", () => {
    const result = buildGraphFlowElements(fixtureNodes, fixtureEdges);

    expect(result.nodes.map(node => node.id)).toEqual(
      fixtureNodes.map(node => node.id),
    );
    expect(result.edges.map(edge => edge.id)).toEqual(
      fixtureEdges.map(edge => edge.id),
    );

    for (const node of result.nodes) {
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
  });

  it("让 recommended_next 按自上而下顺序驱动主层级", () => {
    const positions = positionById(
      buildGraphFlowElements(fixtureNodes, fixtureEdges).nodes,
    );

    for (const edge of fixtureEdges) {
      if (edge.type !== "recommended_next") {
        continue;
      }

      const source = positions.get(edge.source);
      const target = positions.get(edge.target);

      expect(source).toBeDefined();
      expect(target).toBeDefined();
      expect(source?.y).toBeLessThan(target?.y ?? Number.NEGATIVE_INFINITY);
    }
  });

  it("related_to 不改变主节点坐标，但仍保留为无箭头虚线边", () => {
    const allElements = buildGraphFlowElements(fixtureNodes, fixtureEdges);
    const recommendedOnly = buildGraphFlowElements(
      fixtureNodes,
      fixtureEdges.filter(edge => edge.type === "recommended_next"),
    );
    const allPositions = positionById(allElements.nodes);
    const recommendedPositions = positionById(recommendedOnly.nodes);

    for (const node of fixtureNodes) {
      if (node.nodeType !== "related") {
        expect(allPositions.get(node.id)).toEqual(
          recommendedPositions.get(node.id),
        );
      }
    }

    const relatedEdge = allElements.edges.find(
      edge => edge.data?.edgeType === "related_to",
    );
    const recommendedEdge = allElements.edges.find(
      edge => edge.data?.edgeType === "recommended_next",
    );

    expect(relatedEdge).toMatchObject({
      type: "default",
      className: "graph-edge graph-edge--related",
    });
    expect(relatedEdge).not.toHaveProperty("markerEnd");
    expect(recommendedEdge).toMatchObject({
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed },
      className: "graph-edge graph-edge--recommended",
    });
  });

  it("按无向语义解析 related_to 锚点并保持确定输出", () => {
    const original = buildGraphFlowElements(fixtureNodes, fixtureEdges);
    const reversedEdges = fixtureEdges.map(edge =>
      edge.type === "related_to"
        ? { ...edge, source: edge.target, target: edge.source }
        : edge,
    );
    const reversed = buildGraphFlowElements(fixtureNodes, reversedEdges);
    const originalPositions = positionById(original.nodes);
    const reversedPositions = positionById(reversed.nodes);
    const relatedNode = fixtureNodes.find(node => node.nodeType === "related");

    expect(relatedNode).toBeDefined();
    expect(originalPositions.get(relatedNode?.id ?? "")).toEqual(
      reversedPositions.get(relatedNode?.id ?? ""),
    );
    expect(buildGraphFlowElements(fixtureNodes, fixtureEdges)).toEqual(original);
  });

  it("在分叉主图中避开同层主节点，防止 Related Node 重叠", () => {
    const primaryTemplate = fixtureNodeById("python-introduction");
    const relatedTemplate = fixtureNodeById("python-third-party-libraries");
    const forkNodes: GraphStoreNode[] = [
      { ...primaryTemplate, id: "root", title: "根节点", layer: 0 },
      { ...primaryTemplate, id: "left", title: "左分支", layer: 1 },
      { ...primaryTemplate, id: "right", title: "右分支", layer: 1 },
      { ...relatedTemplate, id: "related", title: "相关节点", layer: 2 },
    ];
    const forkEdges: GraphEdge[] = [
      {
        id: "root-left",
        source: "root",
        target: "left",
        type: "recommended_next",
      },
      {
        id: "root-right",
        source: "root",
        target: "right",
        type: "recommended_next",
      },
      {
        // Dagre 将 right 分支排在左侧；旧算法从其右侧放置时会撞上 left 分支。
        id: "right-related",
        source: "right",
        target: "related",
        type: "related_to",
      },
    ];
    const positions = positionById(
      buildGraphFlowElements(forkNodes, forkEdges).nodes,
    );
    const relatedPosition = positions.get("related");
    const anchorPosition = positions.get("right");

    expect(relatedPosition).toBeDefined();
    expect(anchorPosition).toBeDefined();
    expect(relatedPosition?.y).not.toBe(anchorPosition?.y);
    for (const nodeId of ["root", "left", "right"]) {
      const mainPosition = positions.get(nodeId);

      expect(mainPosition).toBeDefined();
      expect(
        nodesOverlap(
          relatedPosition ?? { x: 0, y: 0 },
          mainPosition ?? { x: 0, y: 0 },
        ),
      ).toBe(false);
    }
  });
});
