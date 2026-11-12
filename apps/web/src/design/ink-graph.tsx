/**
 * 模块职责：把真实图的生长时间表交给 GPU 与已有 GraphView；不复制结果或延迟归并流式状态。
 * 生命周期：每个 Run 独立挂载，取消或换图时清理计时器；节点状态更新不会重播入场。
 * 无障碍：减少动态时立即展示全图；揭示前的内容不会提前进入交互顺序。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GraphEdge, PresentationMode, SearchLanguage } from "@wayfinder/contracts";
import type { XYPosition } from "@xyflow/react";
import type { GraphDisplayNode, GraphNodeData } from "../components/Graph/graph-layout.js";
import { GraphView, type GraphViewProps } from "../components/Graph/GraphView.js";
import { INK_NODE_FORM, planInkGraph, type InkScene } from "./ink-graph-motion.js";
import "@xyflow/react/dist/style.css";
import "./ink-graph-controls.css";

type Props = Readonly<{
  graphId: string;
  nodes: readonly GraphDisplayNode[]; edges: readonly GraphEdge[];
  language: SearchLanguage; presentationMode: PresentationMode;
  onScene: (scene: InkScene) => void;
  positions: Readonly<Record<string, XYPosition>>;
  onMoveNode: (nodeId: string, position: XYPosition) => void;
  movable?: boolean;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  animate: boolean;
  /** 回程保留不可交互的 DOM 供文字淡出，墨迹场景已交回首页融合。 */
  active?: boolean;
  transferMoving?: boolean;
  labelSnapshots?: Readonly<Record<string, GraphNodeData>>;
}> & Pick<GraphViewProps, "editableGraphId" | "onContextRequest" | "onInteractionStart" | "onPaneClick" | "onEditProblem">;

export default function InkGraph({ graphId, nodes, edges, language, presentationMode, onScene, positions, onMoveNode, selectedNodeId, onSelectNode, animate, active = true, movable = true,
  transferMoving = false, labelSnapshots = {}, editableGraphId, ...interactionProps }: Props) {
  // 只按结构重新播种，ready/partial/failed 与资源数量更新始终直接呈现。
  const signature = JSON.stringify([nodes.map(node => [node.id, node.nodeType]), edges]);
  const plan = useMemo(() => planInkGraph(nodes, edges), [signature]);
  // 页面按 graphId 挂载实例。结构编辑只更新计划，不能重新给已有实体发明一次搜索入口时钟。
  const [startedAt] = useState(() => performance.now() - (animate ? 0 :
    Math.max(0, ...plan.nodes.map(node => node.bornAt + INK_NODE_FORM), ...plan.branches.map(branch => branch.detachAt)) + 1));
  const timeline = useMemo(() => ({ ...plan, startedAt }), [plan, startedAt]);
  const previousStructure = useRef(signature);
  const [editSettled, setEditSettled] = useState(false);
  const [visibleNodes, setVisibleNodes] = useState<ReadonlySet<string>>(() => new Set());
  const [visibleEdges, setVisibleEdges] = useState<ReadonlySet<string>>(() => new Set());
  const [revealSettled, setRevealSettled] = useState(() => !animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [layoutReady, setLayoutReady] = useState(false);
  const onLayoutReady = useCallback(() => { setLayoutReady(true); }, []);

  useLayoutEffect(() => {
    if (!active || (!layoutReady && timeline.nodes.length > 0)) return;
    const structuralEdit = previousStructure.current !== signature && editableGraphId !== undefined;
    previousStructure.current = signature;
    if (structuralEdit) setEditSettled(true);
    // 真实空记录没有可分裂的节点；让旧颜料聚回自由墨迹，不能为视效捏造节点或关闭画布。
    onScene(timeline.nodes.length === 0 ? { kind: "pointer" } : { kind: "graph", ...timeline, graphId, resume: !animate || editSettled || structuralEdit });
    // 真正离开图层由页面所有者切场景；旧组件卸载不再插入一次 pointer 干扰 A→B。
  }, [timeline, onScene, animate, active, layoutReady, graphId, signature, editableGraphId, editSettled]);

  useEffect(() => {
    // 退场冻结已揭示集合，不能因为回溯时钟而突然显示尚未出生的节点和正式边。
    if (!active) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timers: number[] = [];
    const clear = (): void => { timers.forEach(timer => window.clearTimeout(timer)); timers = []; };
    const schedule = (): void => {
      clear();
      const settled = motion.matches || !animate || editSettled;
      if (settled) setRevealSettled(true);
      const elapsed = performance.now() - timeline.startedAt;
      // 已看见的内容不倒退；中途开启再关闭减少动态，也不能把全图重新藏回去。
      setVisibleNodes(previous => new Set(timeline.nodes.filter(node => previous.has(node.id) || settled || node.bornAt <= elapsed).map(node => node.id)));
      setVisibleEdges(previous => new Set(timeline.branches.filter(branch => previous.has(branch.id) || settled || branch.detachAt <= elapsed).map(branch => branch.id)));
      if (settled) return;
      for (const node of timeline.nodes) {
        if (node.bornAt <= elapsed) continue;
        timers.push(window.setTimeout(() => setVisibleNodes(previous => new Set([...previous, node.id])), node.bornAt - elapsed));
      }
      for (const branch of timeline.branches) {
        if (branch.detachAt <= elapsed) continue;
        timers.push(window.setTimeout(() => setVisibleEdges(previous => new Set([...previous, branch.id])), branch.detachAt - elapsed));
      }
    };
    schedule();
    motion.addEventListener("change", schedule);
    return () => { clear(); motion.removeEventListener("change", schedule); };
  }, [timeline, active, animate, editSettled]);

  return <GraphView appearance="ink" presentationMode={presentationMode} language={language} graph={{ nodes, edges, positions }}
    {...(movable ? { onMoveNode } : {})} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode}
    {...(editableGraphId === undefined ? {} : { editableGraphId })} {...interactionProps}
    visibleNodeIds={visibleNodes} visibleEdgeIds={visibleEdges} revealSettled={revealSettled}
    interactionReady={active && (layoutReady || nodes.length === 0) && !transferMoving} labelSnapshots={labelSnapshots}
    inkContentState={!layoutReady ? "measuring" : transferMoving ? "moving" : "ready"} onLayoutReady={onLayoutReady} />;
}
