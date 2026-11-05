/**
 * 组件职责：订阅 Graph store，并把确定性布局结果交给 React Flow 渲染。
 *
 * 失败路径：Graph 为空时显示明确空态；布局异常不会在此处静默修复 Contract 数据。
 */
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
import type {
  AriaLabelConfig,
  NodeChange,
  NodeTypes,
  ReactFlowInstance,
  XYPosition,
} from "@xyflow/react";
import type {
  GraphEdge,
  PresentationMode,
  SearchLanguage,
} from "@wayfinder/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";

import { addEdge, moveNode, InvalidGraphConnectionError } from "../../stores/workspace-edits.js";
import { EditNotice, useGraphEdit } from "../Workspace/use-graph-edit.js";
import { graphStore } from "../../stores/graph-store.js";
import { getMessages } from "../../i18n/messages.js";
import { GraphNode } from "./GraphNode.js";
import { InkGraphNode } from "../../design/ink-graph-node.js";
import {
  buildGraphFlowElements,
  type GraphFlowEdge,
  type GraphFlowNode,
  type GraphDisplayNode,
  type GraphNodeData,
} from "./graph-layout.js";
import {
  applySelectedNodeId,
  resolveSelectedNodeId,
  resolveSelectedNodeIdFromChanges,
} from "./graph-selection.js";

/** 稳定引用避免 React Flow 在每次渲染时重建 Node Type 注册表。 */
const NODE_TYPES: NodeTypes = {
  wayfinder: GraphNode,
};
const INK_NODE_TYPES: NodeTypes = { wayfinder: InkGraphNode };

/** 先等真实节点测量与首屏视口落定，再让墨迹读取终点，避免换图起飞后又跳位置。 */
function GraphViewportReady({ onReady, empty }: Readonly<{ onReady: () => void; empty: boolean }>) {
  const initialized = useNodesInitialized();
  const { fitView, viewportInitialized } = useReactFlow();
  const delivered = useRef(false);
  useEffect(() => {
    if (delivered.current || (!initialized && !empty) || !viewportInitialized) return;
    let cancelled = false, frame = 0;
    const ready = (): void => {
      if (!cancelled) frame = requestAnimationFrame(() => { delivered.current = true; onReady(); });
    };
    // 空墨迹画布也完成一次视口交接；之后右键加入首节点时保留点击位置，不再次居中。
    if (empty) ready();
    else void fitView({ padding: 0.2 }).then(ready);
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [initialized, viewportInitialized, fitView, onReady, empty]);
  return null;
}

/** 菜单只接收真实身份与坐标快照；具体编辑、表单和搜索仍由页面既有入口承接。 */
type GraphContextBase = Readonly<{
  clientPoint: XYPosition;
  positions?: Readonly<Record<string, XYPosition>>;
}>;
export type GraphContextRequest = GraphContextBase & (
  | Readonly<{ kind: "pane"; flowPoint: XYPosition }>
  | Readonly<{ kind: "node"; nodeId: string }>
  | Readonly<{ kind: "edge"; edgeId: string }>
);
export type GraphEditProblem = ReturnType<typeof useGraphEdit>["problem"];

export type GraphViewProps = Readonly<{
  presentationMode: PresentationMode;
  language: SearchLanguage;
  graph?: Readonly<{ nodes: readonly GraphDisplayNode[]; edges: readonly GraphEdge[]; positions: Readonly<Record<string, XYPosition>> }>;
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string | null) => void;
  editableGraphId?: string;
  flowId?: string;
  /** 墨迹只替换节点皮肤和揭示时机，布局、选择、平移与缩放继续复用同一个画布。 */
  appearance?: "default" | "ink";
  visibleNodeIds?: ReadonlySet<string>;
  visibleEdgeIds?: ReadonlySet<string>;
  revealSettled?: boolean;
  /** 纯视觉恢复期间继续测量布局，暂时阻止透明节点与控件被操作；默认不影响原画布。 */
  interactionReady?: boolean;
  /** 换图只覆盖暂时显示的旧字，不改节点身份、真实结果或编辑数据。 */
  labelSnapshots?: Readonly<Record<string, GraphNodeData>>;
  inkContentState?: "measuring" | "moving" | "ready";
  onLayoutReady?: () => void;
  /** 运行草图尚未进入编辑文档时，位置由调用方承接；已保存图继续复用原编辑入口。 */
  onMoveNode?: (nodeId: string, position: XYPosition) => void;
  onContextRequest?: (request: GraphContextRequest) => void;
  onInteractionStart?: () => void;
  onPaneClick?: () => void;
  onEditProblem?: (problem: GraphEditProblem) => void;
}>;

/** 两种展示模式共用同一 Product Graph；Compact 只改变视图密度，不改写 Node 或 Edge。 */
export function GraphView({ presentationMode, language, graph, selectedNodeId: providedSelection, onSelectNode, editableGraphId, flowId,
  appearance = "default", visibleNodeIds, visibleEdgeIds, revealSettled, interactionReady = true,
  labelSnapshots, inkContentState = "ready", onLayoutReady, onMoveNode,
  onContextRequest, onInteractionStart, onPaneClick, onEditProblem }: GraphViewProps) {
  const runNodes = useStore(graphStore, state => state.nodes);
  const runEdges = useStore(graphStore, state => state.edges);
  const runSelection = useStore(graphStore, state => state.selectedNodeId);
  const selectRunNode = useStore(graphStore, state => state.selectNode);
  const nodes = graph?.nodes ?? runNodes;
  const edges = graph?.edges ?? runEdges;
  const selectedNodeId = providedSelection === undefined ? runSelection : providedSelection;
  const selectNode = onSelectNode ?? selectRunNode;
  const messages = getMessages(language).graph;
  const edit = useGraphEdit(editableGraphId ?? null, language);
  const [dragPosition, setDragPosition] = useState<{ nodeId: string; position: XYPosition } | null>(null);
  const flowInstance = useRef<ReactFlowInstance<GraphFlowNode, GraphFlowEdge> | null>(null);
  const previousNodeCount = useRef(nodes.length);
  // 只在新增节点后调整视口以保证可见，不改写已有人工坐标。
  useEffect(() => {
    const addedNode = nodes.length > previousNodeCount.current;
    previousNodeCount.current = nodes.length;
    if (appearance === "ink" || !addedNode || flowInstance.current === null) return;
    const frame = requestAnimationFrame(() => { void flowInstance.current?.fitView({ padding: 0.2 }); });
    return () => cancelAnimationFrame(frame);
  }, [nodes.length, appearance]);
  useEffect(() => { onEditProblem?.(edit.problem); }, [edit.problem, onEditProblem]);
  const positionsSnapshot = useCallback((): Readonly<Record<string, XYPosition>> | undefined => {
    const current = flowInstance.current;
    return current === null ? undefined : Object.fromEntries(current.getNodes().map(node => [node.id, { ...node.position }]));
  }, []);
  const elements = useMemo(
    () => buildGraphFlowElements(nodes, edges, language, graph?.positions),
    [nodes, edges, language, graph?.positions],
  );
  /** React Flow 的内部可访问性文案也必须与页面唯一展示语言一致。 */
  const ariaLabels = useMemo<Partial<AriaLabelConfig>>(
    () => ({
      "node.a11yDescription.default": messages.nodeSelectionDescription,
      "edge.a11yDescription.default": messages.edgeDescription,
      "controls.ariaLabel": messages.controlsAria,
      "controls.zoomIn.ariaLabel": messages.zoomInAria,
      "controls.zoomOut.ariaLabel": messages.zoomOutAria,
      "controls.fitView.ariaLabel": messages.fitViewAria,
    }),
    [messages],
  );
  /**
   * Flow Node 是 Store 当前快照的同步派生值；不能通过 Effect 复制第二份节点状态，
   * 否则 graph.plan 与增量状态会先绘制一帧旧 Graph。选择也只由业务 ID 派生。
   */
  const flowNodes = useMemo(
    () => applySelectedNodeId(elements.nodes, selectedNodeId).map((node): GraphFlowNode =>
      ({ ...node,
        data: labelSnapshots?.[node.id] === undefined ? node.data : { ...node.data, ...labelSnapshots[node.id], language },
        ...(dragPosition?.nodeId === node.id ? { position: dragPosition.position } : {}),
        // 隐藏 Handle 仍会参与内部近邻查找，因此同时关闭节点级连接，不能只靠透明或 inert。
        ...(appearance !== "ink" ? {} : { connectable: editableGraphId !== undefined && interactionReady && (visibleNodeIds?.has(node.id) ?? true) }),
        // 隐藏内容仍占据布局，供墨迹读取目的地；揭示前不能被鼠标或键盘提前选中。
        ...(visibleNodeIds === undefined ? {} : {
          focusable: visibleNodeIds.has(node.id), selectable: visibleNodeIds.has(node.id),
          style: { ...node.style, visibility: visibleNodeIds.has(node.id) ? "visible" : "hidden" },
          className: `${node.className ?? ""} ${visibleNodeIds.has(node.id) ? "ink-graph-node--visible" : "ink-graph-node--hidden"}`,
        }),
        domAttributes: { ...node.domAttributes,
          ...(visibleNodeIds === undefined ? {} : { "aria-hidden": !visibleNodeIds.has(node.id), inert: !visibleNodeIds.has(node.id) }),
          ...(labelSnapshots?.[node.id] === undefined ? {} : { "data-ink-label-source": "true" }),
        },
      }),
    ),
    [elements.nodes, selectedNodeId, dragPosition, visibleNodeIds, labelSnapshots, language, appearance, editableGraphId, interactionReady],
  );
  const flowEdges = useMemo(() => visibleEdgeIds === undefined ? elements.edges
    : elements.edges.map(edge => ({ ...edge, hidden: !visibleEdgeIds.has(edge.id) })), [elements.edges, visibleEdgeIds]);

  const handleSelectionChange = useCallback(
    ({ nodes: selectedNodes }: { nodes: GraphFlowNode[] }) => {
      // 事件只回写业务 ID；上方同步派生值再统一形成高亮。
      // Store 对同值写入不通知，阻断 React Flow 与 Store 的重复回写环。
      selectNode(resolveSelectedNodeId(selectedNodes));
    },
    [selectNode],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<GraphFlowNode>[]) => {
      /**
       * 键盘 Enter / Space 只产生 select change，不触发 onNodeClick；这里仅提取选择，
       * 测量不进入业务 Store；拖动仅保存临时位置，结束时保存最新布局，不生成撤销事件。
       */
      if (editableGraphId !== undefined || onMoveNode !== undefined) {
        for (const change of changes) {
          if (change.type !== "position" || change.position === undefined) continue;
          const position = change.position;
          if (change.dragging === true) {
            setDragPosition(previous => previous?.nodeId === change.id &&
              previous.position.x === position.x && previous.position.y === position.y
              ? previous : { nodeId: change.id, position });
          } else if (change.dragging === false) {
            // 方向键移动没有 DragStop；明确结束的位移必须同样保存，指针重复结算由同值检查去重。
            if (onMoveNode !== undefined) onMoveNode(change.id, position);
            else edit.commit(graph => moveNode(graph, change.id, position));
            setDragPosition(null);
          }
        }
      }
      const nextSelectedNodeId = resolveSelectedNodeIdFromChanges(
        flowNodes,
        changes,
      );
      if (nextSelectedNodeId !== undefined) {
        selectNode(nextSelectedNodeId);
      }
    },
    [flowNodes, selectNode, editableGraphId, onMoveNode],
  );

  if (elements.nodes.length === 0 && appearance !== "ink") {
    return <p className="graph-empty">{messages.empty}</p>;
  }

  return (
    <div
      className={`graph-canvas graph-canvas--${presentationMode}${appearance === "ink" ? " graph-canvas--ink" : ""}`}
      data-presentation-mode={presentationMode}
      data-reveal-settled={revealSettled}
      data-ink-content-state={appearance === "ink" ? inkContentState : undefined}
      inert={!interactionReady}
      aria-hidden={!interactionReady}
      aria-label={messages.canvasAria[presentationMode]}
    >
      <ReactFlow<GraphFlowNode, GraphFlowEdge>
        {...(flowId === undefined ? {} : { id: flowId })}
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={appearance === "ink" ? INK_NODE_TYPES : NODE_TYPES}
        onInit={instance => { flowInstance.current = instance; }}
        {...(onContextRequest === undefined ? {} : {
          onPaneContextMenu: event => {
            if (!interactionReady || flowInstance.current === null) return;
            event.preventDefault(); event.stopPropagation();
            const clientPoint = { x: event.clientX,y: event.clientY }, positions = positionsSnapshot();
            // API 内部已扣除容器边距并反变换视口；不能再手动减一次 stage 的偏移。
            onContextRequest({ kind: "pane",clientPoint,flowPoint: flowInstance.current.screenToFlowPosition(clientPoint),
              ...(positions === undefined ? {} : { positions }) });
          },
          onNodeContextMenu: (event,node) => {
            if (!interactionReady || (visibleNodeIds !== undefined && !visibleNodeIds.has(node.id))) return;
            event.preventDefault(); event.stopPropagation();
            selectNode(node.id);
            const positions = positionsSnapshot();
            onContextRequest({ kind: "node",nodeId: node.id,clientPoint: { x: event.clientX,y: event.clientY },
              ...(positions === undefined ? {} : { positions }) });
          },
          onEdgeContextMenu: (event,edge) => {
            if (!interactionReady || (visibleEdgeIds !== undefined && !visibleEdgeIds.has(edge.id))) return;
            event.preventDefault(); event.stopPropagation();
            const positions = positionsSnapshot();
            onContextRequest({ kind: "edge",edgeId: edge.id,clientPoint: { x: event.clientX,y: event.clientY },
              ...(positions === undefined ? {} : { positions }) });
          },
        })}
        {...(onInteractionStart === undefined ? {} : {
          onMoveStart: onInteractionStart,onNodeDragStart: onInteractionStart,onConnectStart: onInteractionStart,
        })}
        {...(onPaneClick === undefined ? {} : { onPaneClick: () => { if (interactionReady) onPaneClick(); } })}
        onNodesChange={handleNodesChange}
        onNodeClick={(_event, node) => selectNode(node.id)}
        onNodeDragStop={(_event, node) => {
          if (onMoveNode !== undefined) onMoveNode(node.id, node.position);
          else if (editableGraphId !== undefined) edit.commit(graph => moveNode(graph, node.id, node.position));
          else return;
          setDragPosition(null);
        }}
        onConnect={connection => {
          if (editableGraphId === undefined || !interactionReady) return;
          const type = connection.sourceHandle === "main-source" && connection.targetHandle === "main-target"
            ? "recommended_next"
            : connection.sourceHandle === "related-source" && connection.targetHandle === "related-target"
              ? "related_to" : null;
          edit.commit(graph => {
            if (type === null) throw new InvalidGraphConnectionError();
            // ink 只在连线编辑时承接当前实际布局；只读评估和预览不启用此编辑分支。
            const snapshot = appearance === "ink" ? positionsSnapshot() : undefined;
            const inherited: Record<string, XYPosition> = {};
            if (snapshot !== undefined) for (const node of graph.nodes) {
              const position = snapshot[node.id];
              if (position !== undefined) inherited[node.id] = position;
            }
            const positions = snapshot === undefined ? graph.positions : { ...inherited,...graph.positions };
            return addEdge(positions === graph.positions ? graph : { ...graph,positions }, connection.source, connection.target, type);
          });
        }}
        // React Flow 的键盘选择不触发 onNodeClick，必须从 selection 事件同步 Store。
        onSelectionChange={handleSelectionChange}
        fitView={onLayoutReady === undefined}
        fitViewOptions={{ padding: 0.2 }}
        minZoom={appearance === "ink" ? 0.12 : 0.35}
        maxZoom={1.8}
        nodesDraggable={editableGraphId !== undefined || onMoveNode !== undefined}
        nodesConnectable={editableGraphId !== undefined && interactionReady}
        // 删除统一走显式入口与确定性函数；禁止画布内部先删后与工作区漂移。
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        elementsSelectable
        panOnDrag
        zoomOnScroll
        ariaLabelConfig={ariaLabels}
      >
        {appearance === "ink" ? null : <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />}
        <Controls aria-label={messages.controlsAria} showInteractive={false} />
        {onLayoutReady === undefined ? null : <GraphViewportReady onReady={onLayoutReady} empty={elements.nodes.length === 0} />}
      </ReactFlow>
      {onEditProblem === undefined ? <div className="graph-edit-notice"><EditNotice problem={edit.problem} language={language} /></div> : null}
    </div>
  );
}
