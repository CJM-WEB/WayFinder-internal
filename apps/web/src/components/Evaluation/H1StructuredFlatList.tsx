/**
 * 组件职责：把当前 Product Graph 投影成 H1 实验的纵向 Structured Flat List。
 *
 * 实验边界：
 * - Node 保持 Store 顺序与对象引用，Resource 不复制、不重排；
 * - 每条 Edge 只在 source Node 下转成一次文字关系；
 * - 点击仍写回同一个 selectedNodeId，右侧继续使用生产 Resource Panel。
 */
import type { GraphEdge } from "@wayfinder/contracts";
import { useStore } from "zustand";

import {
  graphStore,
  type GraphStoreNode,
} from "../../stores/graph-store.js";
import {
  buildNodeStatusPresentation,
  NODE_TYPE_LABELS,
} from "../Graph/graph-labels.js";

const EDGE_LABELS: Record<GraphEdge["type"], string> = {
  recommended_next: "推荐下一步",
  related_to: "相关主题",
};

export type H1FlatListRelationship = Readonly<{
  edgeId: GraphEdge["id"];
  edgeType: GraphEdge["type"];
  label: string;
  targetNodeId: GraphEdge["target"];
  targetTitle: string;
}>;

export type H1FlatListItem = Readonly<{
  node: GraphStoreNode;
  relationships: readonly H1FlatListRelationship[];
}>;

/**
 * 纯投影保留输入 Node 引用，并让每条已校验 Edge 恰好出现一次。
 * Contract 已保证端点存在；ID fallback 只让异常快照可诊断，不能静默丢边。
 */
export function buildH1FlatListItems(
  nodes: readonly GraphStoreNode[],
  edges: readonly GraphEdge[],
): readonly H1FlatListItem[] {
  const titleByNodeId = new Map(nodes.map(node => [node.id, node.title]));
  const relationshipsBySource = new Map<
    GraphEdge["source"],
    H1FlatListRelationship[]
  >();

  for (const edge of edges) {
    const relationships = relationshipsBySource.get(edge.source) ?? [];
    relationships.push({
      edgeId: edge.id,
      edgeType: edge.type,
      label: EDGE_LABELS[edge.type],
      targetNodeId: edge.target,
      targetTitle: titleByNodeId.get(edge.target) ?? edge.target,
    });
    relationshipsBySource.set(edge.source, relationships);
  }

  return nodes.map(node => ({
    node,
    relationships: relationshipsBySource.get(node.id) ?? [],
  }));
}

export type H1StructuredFlatListViewProps = Readonly<{
  nodes: readonly GraphStoreNode[];
  edges: readonly GraphEdge[];
  selectedNodeId: GraphStoreNode["id"] | null;
  onSelectNode: (nodeId: GraphStoreNode["id"]) => void;
}>;

/** 纯展示入口便于证明 Flat List 只消费调用方提供的同一份 Graph 快照。 */
export function H1StructuredFlatListView({
  nodes,
  edges,
  selectedNodeId,
  onSelectNode,
}: H1StructuredFlatListViewProps) {
  const items = buildH1FlatListItems(nodes, edges);

  if (items.length === 0) {
    return <p className="h1-flat-list h1-flat-list--empty">暂无可展示的搜索结果。</p>;
  }

  return (
    <ol className="h1-flat-list" aria-label="Structured Flat List 搜索结果">
      {items.map(({ node, relationships }) => {
        const resourceCount = "resources" in node ? node.resources.length : 0;
        const presentation = buildNodeStatusPresentation(
          node.status,
          resourceCount,
        );
        const isSelected = node.id === selectedNodeId;

        return (
          <li
            className={`h1-flat-list__item h1-flat-list__item--${node.status}`}
            data-node-id={node.id}
            data-node-status={node.status}
            key={node.id}
          >
            <button
              className="h1-flat-list__node"
              type="button"
              aria-busy={presentation.isLoading}
              aria-pressed={isSelected}
              onClick={() => onSelectNode(node.id)}
            >
              <span className="h1-flat-list__eyebrow">
                <span>{NODE_TYPE_LABELS[node.nodeType]}</span>
                <span className="h1-flat-list__status">
                  <span aria-hidden="true">{presentation.marker}</span>
                  {presentation.label}
                </span>
              </span>
              <span className="h1-flat-list__title">{node.title}</span>
              <span className="h1-flat-list__detail">{presentation.detail}</span>
            </button>

            {relationships.length === 0 ? null : (
              <ul className="h1-flat-list__relationships" aria-label={`${node.title} 的关系`}>
                {relationships.map(relationship => (
                  <li
                    data-edge-id={relationship.edgeId}
                    data-edge-type={relationship.edgeType}
                    key={relationship.edgeId}
                  >
                    <span>{relationship.label}</span>
                    {relationship.targetTitle}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** 容器只订阅现有 Product Store，不创建实验专用数据副本。 */
export function H1StructuredFlatList() {
  const nodes = useStore(graphStore, state => state.nodes);
  const edges = useStore(graphStore, state => state.edges);
  const selectedNodeId = useStore(graphStore, state => state.selectedNodeId);
  const selectNode = useStore(graphStore, state => state.selectNode);

  return (
    <H1StructuredFlatListView
      nodes={nodes}
      edges={edges}
      selectedNodeId={selectedNodeId}
      onSelectNode={selectNode}
    />
  );
}
