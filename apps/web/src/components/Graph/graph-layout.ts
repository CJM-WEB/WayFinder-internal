/**
 * 模块职责：把共享 Contract Graph 映射为 React Flow 元素，并计算确定性首屏坐标。
 *
 * 关键约束：
 * - Layout Graph（布局图）只包含非 Related Node 与 recommended_next Edge。
 * - Product Graph（产品图）的全部 Edge 最终都必须渲染，related_to 不能被布局阶段丢弃。
 * - 本模块只负责坐标和视图模型，不在浏览器中修复 DAG、ID 或引用错误。
 */
import { Graph, layout } from "@dagrejs/dagre";
import type { EdgeLabel, GraphLabel, NodeLabel } from "@dagrejs/dagre";
import type {
  EditableNode,
  GraphEdge,
  NodeType,
  SearchLanguage,
  StreamNodeStatus,
} from "@wayfinder/contracts";
import { MarkerType, Position } from "@xyflow/react";
import type { Edge, Node, XYPosition } from "@xyflow/react";

import type { GraphStoreNode } from "../../stores/graph-store.js";
import { getMessages } from "../../i18n/messages.js";

export const GRAPH_NODE_WIDTH = 240;
export const GRAPH_NODE_HEIGHT = 112;

const RELATED_HORIZONTAL_GAP = 88;
const RELATED_VERTICAL_GAP = 32;
const NODE_COLLISION_GAP = 16;

export type GraphDisplayNode = GraphStoreNode | EditableNode;

export type GraphNodeData = {
  title: string;
  nodeType: NodeType;
  status: StreamNodeStatus | EditableNode["status"];
  resourceCount: number;
  language: SearchLanguage;
};

export type GraphFlowNode = Node<GraphNodeData, "wayfinder">;
export type GraphFlowEdge = Edge<
  { edgeType: GraphEdge["type"] },
  "smoothstep" | "default"
>;

export type GraphFlowElements = {
  nodes: GraphFlowNode[];
  edges: GraphFlowEdge[];
};

/** Dagre 返回中心坐标，React Flow 使用左上角坐标，因此必须统一减去半个固定尺寸。 */
const toTopLeftPosition = (node: NodeLabel): XYPosition => ({
  x: (node.x ?? GRAPH_NODE_WIDTH / 2) - GRAPH_NODE_WIDTH / 2,
  y: (node.y ?? GRAPH_NODE_HEIGHT / 2) - GRAPH_NODE_HEIGHT / 2,
});

/**
 * 只计算主结构。Related Node 不进入 Dagre，即使 Product Graph 中存在 related_to，
 * 主节点坐标也必须保持不变。
 */
const layoutMainNodes = (
  nodes: readonly GraphDisplayNode[],
  edges: readonly GraphEdge[],
): Map<string, XYPosition> => {
  const mainNodes = nodes.filter(node => node.nodeType !== "related");
  const mainNodeIds = new Set(mainNodes.map(node => node.id));
  const dagreGraph = new Graph<GraphLabel, NodeLabel, EdgeLabel>({
    directed: true,
  })
    .setGraph({
      rankdir: "TB",
      ranksep: 72,
      nodesep: 44,
      marginx: 32,
      marginy: 32,
    })
    .setDefaultEdgeLabel(() => ({}));

  for (const node of mainNodes) {
    dagreGraph.setNode(node.id, {
      width: GRAPH_NODE_WIDTH,
      height: GRAPH_NODE_HEIGHT,
    });
  }

  for (const edge of edges) {
    if (
      edge.type === "recommended_next" &&
      mainNodeIds.has(edge.source) &&
      mainNodeIds.has(edge.target)
    ) {
      dagreGraph.setEdge(edge.source, edge.target);
    }
  }

  layout(dagreGraph);

  return new Map(
    mainNodes.map(node => [
      node.id,
      toTopLeftPosition(dagreGraph.node(node.id)),
    ]),
  );
};

/** related_to 语义无向；无论 Related Node 位于 source 或 target，都返回另一端主节点。 */
const findRelatedAnchorId = (
  relatedNodeId: string,
  edges: readonly GraphEdge[],
  mainPositions: ReadonlyMap<string, XYPosition>,
): string | undefined => {
  for (const edge of edges) {
    if (edge.type !== "related_to") {
      continue;
    }

    const otherNodeId =
      edge.source === relatedNodeId
        ? edge.target
        : edge.target === relatedNodeId
          ? edge.source
          : undefined;

    if (otherNodeId !== undefined && mainPositions.has(otherNodeId)) {
      return otherNodeId;
    }
  }

  return undefined;
};

/** 固定尺寸节点的基础矩形碰撞检测；额外留白避免两个边框视觉上粘连。 */
const overlapsOccupiedNode = (
  candidate: XYPosition,
  occupiedPositions: readonly XYPosition[],
): boolean =>
  occupiedPositions.some(
    occupied =>
      candidate.x < occupied.x + GRAPH_NODE_WIDTH + NODE_COLLISION_GAP &&
      candidate.x + GRAPH_NODE_WIDTH + NODE_COLLISION_GAP > occupied.x &&
      candidate.y < occupied.y + GRAPH_NODE_HEIGHT + NODE_COLLISION_GAP &&
      candidate.y + GRAPH_NODE_HEIGHT + NODE_COLLISION_GAP > occupied.y,
  );

/**
 * 优先保留“锚点右侧”的探索语义；若与主结构或已放置 Related Node 冲突，
 * 则按固定步长向下移动，直到找到第一个可用位置，确保输出仍然确定。
 */
const avoidNodeOverlap = (
  preferredPosition: XYPosition,
  occupiedPositions: readonly XYPosition[],
): XYPosition => {
  const candidate = { ...preferredPosition };

  while (overlapsOccupiedNode(candidate, occupiedPositions)) {
    candidate.y += GRAPH_NODE_HEIGHT + RELATED_VERTICAL_GAP;
  }

  return candidate;
};

/**
 * Related Node 挂在锚点右侧；同一锚点的后续节点向下错开。
 * 缺少合法锚点时确定性降级到主图右侧的独立列，但不篡改 Contract Edge。
 */
const layoutRelatedNodes = (
  nodes: readonly GraphDisplayNode[],
  edges: readonly GraphEdge[],
  mainPositions: ReadonlyMap<string, XYPosition>,
): Map<string, XYPosition> => {
  const relatedNodes = nodes.filter(node => node.nodeType === "related");
  const relatedCountByAnchor = new Map<string, number>();
  const occupiedPositions = [...mainPositions.values()];
  const fallbackX =
    Math.max(0, ...[...mainPositions.values()].map(position => position.x)) +
    GRAPH_NODE_WIDTH +
    RELATED_HORIZONTAL_GAP;

  return new Map(
    relatedNodes.map((node, fallbackIndex) => {
      const anchorId = findRelatedAnchorId(node.id, edges, mainPositions);
      const anchorPosition =
        anchorId === undefined ? undefined : mainPositions.get(anchorId);

      if (anchorId === undefined || anchorPosition === undefined) {
        const position = avoidNodeOverlap(
          {
            x: fallbackX,
            y: fallbackIndex * (GRAPH_NODE_HEIGHT + RELATED_VERTICAL_GAP),
          },
          occupiedPositions,
        );
        occupiedPositions.push(position);

        return [
          node.id,
          position,
        ];
      }

      const anchorRelatedCount = relatedCountByAnchor.get(anchorId) ?? 0;
      relatedCountByAnchor.set(anchorId, anchorRelatedCount + 1);

      const position = avoidNodeOverlap(
        {
          x:
            anchorPosition.x +
            GRAPH_NODE_WIDTH +
            RELATED_HORIZONTAL_GAP,
          y:
            anchorPosition.y +
            anchorRelatedCount * (GRAPH_NODE_HEIGHT + RELATED_VERTICAL_GAP),
        },
        occupiedPositions,
      );
      occupiedPositions.push(position);

      return [node.id, position];
    }),
  );
};

const toFlowEdge = (
  edge: GraphEdge,
  language: SearchLanguage,
): GraphFlowEdge => {
  const isRecommended = edge.type === "recommended_next";
  const messages = getMessages(language).graph;

  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: isRecommended ? "main-source" : "related-source",
    targetHandle: isRecommended ? "main-target" : "related-target",
    // React Flow 的默认 Edge 即 Bezier 曲线；使用正式 type 名避免运行时回退告警。
    type: isRecommended ? "smoothstep" : "default",
    label: messages.edgeLabels[edge.type],
    ariaLabel: messages.edgeAria[edge.type],
    className: isRecommended
      ? "graph-edge graph-edge--recommended"
      : "graph-edge graph-edge--related",
    // exactOptionalPropertyTypes 下不能显式传 undefined；相关边应彻底省略箭头属性。
    ...(isRecommended
      ? { markerEnd: { type: MarkerType.ArrowClosed } }
      : {}),
    data: { edgeType: edge.type },
  };
};

/** 将当前 Store 快照转换为 React Flow 可直接渲染的完整元素集合。 */
export const buildGraphFlowElements = (
  nodes: readonly GraphDisplayNode[],
  edges: readonly GraphEdge[],
  language: SearchLanguage = "zh-CN",
  savedPositions: Readonly<Record<string, XYPosition>> = {},
): GraphFlowElements => {
  const mainPositions = layoutMainNodes(nodes, edges);
  const relatedPositions = layoutRelatedNodes(nodes, edges, mainPositions);
  const positions = new Map([...mainPositions, ...relatedPositions]);
  const messages = getMessages(language).graph;

  return {
    nodes: nodes.map(node => ({
      id: node.id,
      type: "wayfinder",
      position: savedPositions[node.id] ?? positions.get(node.id) ?? { x: 0, y: 0 },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      ariaLabel: messages.nodeAria(
        node.title,
        messages.statusLabels[node.status],
      ),
      className: `graph-node graph-node--${node.nodeType} graph-node--${node.status}`,
      data: {
        title: node.title,
        nodeType: node.nodeType,
        status: node.status,
        resourceCount: "resources" in node ? node.resources.length : 0,
        language,
      },
    })),
    edges: edges.map(edge => toFlowEdge(edge, language)),
  };
};
