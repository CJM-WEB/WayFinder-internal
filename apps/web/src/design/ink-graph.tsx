/**
 * 模块职责：把真实图的生长时间表交给 GPU 与已有 GraphView；不复制结果或延迟归并流式状态。
 * 生命周期：每个 Run 独立挂载，取消或换图时清理计时器；节点状态更新不会重播入场。
 * 无障碍：减少动态时立即展示全图；揭示前的内容不会提前进入交互顺序。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { GraphEdge, PresentationMode, SearchLanguage } from "@wayfinder/contracts";
import type { XYPosition } from "@xyflow/react";
import type { GraphDisplayNode, GraphNodeData } from "../components/Graph/graph-layout.js";
import { GraphView } from "../components/Graph/GraphView.js";
import { INK_NODE_FORM, planInkGraph, type InkScene } from "./ink-graph-motion.js";
import "@xyflow/react/dist/style.css";

type Props = Readonly<{
  graphId: string;
  nodes: readonly GraphDisplayNode[]; edges: readonly GraphEdge[];
  language: SearchLanguage; presentationMode: PresentationMode;
  onScene: (scene: InkScene) => void;
  positions: Readonly<Record<string, XYPosition>>;
  onMoveNode: (nodeId: string, position: XYPosition) => void;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  animate: boolean;
  /** 回程保留不可交互的 DOM 供文字淡出，墨迹场景已交回首页融合。 */
  active?: boolean;
  transferMoving?: boolean;
  labelSnapshots?: Readonly<Record<string, GraphNodeData>>;
}>;

export default function InkGraph({ graphId, nodes, edges, language, presentationMode, onScene, positions, onMoveNode, selectedNodeId, onSelectNode, animate, active = true,
  transferMoving = false, labelSnapshots = {} }: Props) {
  // 只按结构重新播种，ready/partial/failed 与资源数量更新始终直接呈现。
  const signature = JSON.stringify([nodes.map(node => [node.id, node.nodeType]), edges]);
  const timeline = useMemo(() => {
    const plan = planInkGraph(nodes, edges);
    // 历史恢复与界面重入只短显现已有图，不把原图当作一次新搜索重新播种。
    const completedAt = Math.max(0, ...plan.nodes.map(node => node.bornAt + INK_NODE_FORM), ...plan.branches.map(branch => branch.detachAt));
    return { ...plan, startedAt: performance.now() - (animate ? 0 : completedAt + 1) };
  }, [signature, animate]);
  const [visibleNodes, setVisibleNodes] = useState<ReadonlySet<string>>(() => new Set());
  const [visibleEdges, setVisibleEdges] = useState<ReadonlySet<string>>(() => new Set());
  const [revealSettled, setRevealSettled] = useState(() => !animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [layoutReady, setLayoutReady] = useState(false);
  const onLayoutReady = useCallback(() => { setLayoutReady(true); }, []);

  useLayoutEffect(() => {
    if (!active || (!layoutReady && timeline.nodes.length > 0)) return;
    // 真实空记录没有可分裂的节点；让旧颜料聚回自由墨迹，不能为视效捏造节点或关闭画布。
    onScene(timeline.nodes.length === 0 ? { kind: "pointer" } : { kind: "graph", ...timeline, graphId, resume: !animate });
    // 真正离开图层由页面所有者切场景；旧组件卸载不再插入一次 pointer 干扰 A→B。
  }, [timeline, onScene, animate, active, layoutReady, graphId]);

  useEffect(() => {
    // 退场冻结已揭示集合，不能因为回溯时钟而突然显示尚未出生的节点和正式边。
    if (!active) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timers: number[] = [];
    const clear = (): void => { timers.forEach(timer => window.clearTimeout(timer)); timers = []; };
    const schedule = (): void => {
      clear();
      if (motion.matches) setRevealSettled(true);
      const elapsed = performance.now() - timeline.startedAt;
      // 已看见的内容不倒退；中途开启再关闭减少动态，也不能把全图重新藏回去。
      setVisibleNodes(previous => new Set(timeline.nodes.filter(node => previous.has(node.id) || motion.matches || node.bornAt <= elapsed).map(node => node.id)));
      setVisibleEdges(previous => new Set(timeline.branches.filter(branch => previous.has(branch.id) || motion.matches || branch.detachAt <= elapsed).map(branch => branch.id)));
      if (motion.matches) return;
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
  }, [timeline, active]);

  return <GraphView appearance="ink" presentationMode={presentationMode} language={language} graph={{ nodes, edges, positions }}
    onMoveNode={onMoveNode} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode}
    visibleNodeIds={visibleNodes} visibleEdgeIds={visibleEdges} revealSettled={revealSettled}
    interactionReady={active && layoutReady && !transferMoving} labelSnapshots={labelSnapshots}
    inkContentState={!layoutReady ? "measuring" : transferMoving ? "moving" : "ready"} onLayoutReady={onLayoutReady} />;
}
