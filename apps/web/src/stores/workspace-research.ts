/**
 * 重搜明确应用仍复用共享内容投影；浏览器只补既有Dagre布局，不承担组图权限判断。
 * 网络、预览与取消保持在research协调器，返回快照仍一次进入原replaceGraph历史。
 */
import { EditableGraphSchema, applyGraphSearchResultContent, type EditableGraph, type ResultGraph } from "@wayfinder/contracts";
import { buildGraphFlowElements } from "../components/Graph/graph-layout.js";
export { applyNodeSearchResult } from "@wayfinder/contracts";

export function applyGraphSearchResult(graph: EditableGraph, input: ResultGraph): EditableGraph {
  const generated = applyGraphSearchResultContent(graph, input);
  if (generated === graph) return graph;
  const elements = buildGraphFlowElements(generated.nodes, generated.edges, generated.language);
  return EditableGraphSchema.parse({ ...generated,
    positions: Object.fromEntries(elements.nodes.map(node => [node.id, node.position])),
  });
}
