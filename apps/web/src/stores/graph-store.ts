/**
 * 模块职责：维护 Graph 页面跨组件共享的最小运行状态。
 *
 * 关键约束：
 * - Node、Edge、Run 与 sequence 的字段类型直接来自 @wayfinder/contracts，不能在 Web 内复制协议。
 * - selected Node 只保存 ID，具体对象由 selector 派生，避免图更新后保留陈旧对象。
 * - 所有 StreamEvent 必须经过同一个原子 Reducer，旧 Run、乱序事件和终态后事件均静默丢弃。
 */
import type {
  AppError,
  GraphEdge,
  GraphNodeCore,
  GraphPlan,
  PresentationMode,
  ProcessingNodeStatus,
  ResultGraph,
  ResultGraphNode,
  SearchRequest,
  StreamEvent,
} from "@wayfinder/contracts";
import { createStore } from "zustand/vanilla";

/** 处理中 Node 复用公共 Core 与公共状态枚举，不在前端复制 Wire 字段。 */
type ProcessingGraphNode = GraphNodeCore & {
  status: ProcessingNodeStatus;
};

export type GraphStoreNode = ProcessingGraphNode | ResultGraphNode;

/** GraphPlan 与 ResultGraph 快照都能通过同一个最小写入边界进入 store。 */
type GraphSnapshot =
  | Pick<GraphPlan, "nodes" | "edges">
  | ResultGraph["graph"];

type GraphStoreData = {
  activeRunId: SearchRequest["runId"] | null;
  query: SearchRequest["query"];
  language: SearchRequest["language"] | null;
  /** null 仅表示当前尚未收到 AI Search 的分析结果；Direct 永远不写入 Store。 */
  presentationMode: PresentationMode | null;
  nodes: GraphStoreNode[];
  edges: GraphEdge[];
  selectedNodeId: GraphNodeCore["id"] | null;
  /** 首次 Compact 自动选择或用户实际改变选择后关闭，防止后续终态夺回控制权。 */
  hasResolvedInitialCompactSelection: boolean;
  isSearching: boolean;
  /** 仅表示已接受真实 complete；取消、EOF 或失败不能把草稿标成已交付结果。 */
  hasCompleted: boolean;
  /** 只保留公共安全错误；运行失败与正常 EOF、取消仍是不同语义。 */
  runError: AppError | null;
  lastSequence: StreamEvent["sequence"];
};

type GraphStoreActions = {
  startRun: (request: SearchRequest) => void;
  applyStreamEvent: (event: StreamEvent) => void;
  setGraph: (graph: GraphSnapshot) => void;
  selectNode: (nodeId: GraphNodeCore["id"] | null) => void;
  finishRun: () => void;
  reset: () => void;
};

export type GraphStoreState = GraphStoreData & GraphStoreActions;

/** 终态 Node 不再接受增量状态，避免留下 status 与旧结果字段互相矛盾的对象。 */
const isProcessingGraphNode = (
  node: GraphStoreNode,
): node is ProcessingGraphNode =>
  node.status === "planned" ||
  node.status === "searching" ||
  node.status === "filtering";

/**
 * 只更新 GraphPlan 中仍处于处理阶段的目标 Node。
 * 未知 nodeId 与迟到的第二个终态只消费 sequence，不能凭事件猜造 Node Core。
 */
const updateProcessingNode = (
  nodes: GraphStoreNode[],
  nodeId: GraphNodeCore["id"],
  update: (node: ProcessingGraphNode) => GraphStoreNode,
): GraphStoreNode[] => {
  let didUpdate = false;
  const nextNodes = nodes.map(node => {
    if (node.id !== nodeId || !isProcessingGraphNode(node)) return node;

    didUpdate = true;
    return update(node);
  });

  return didUpdate ? nextNodes : nodes;
};

/**
 * ready/partial 的状态收敛与首次 Compact 选择必须原子提交。
 * 未知 Node、重复终态、Graph 模式或用户已经接管选择时只更新应有的 Node 状态。
 */
const createUsefulNodePatch = (
  state: GraphStoreData,
  nodeId: GraphNodeCore["id"],
  update: (node: ProcessingGraphNode) => GraphStoreNode,
): Pick<GraphStoreData, "nodes"> &
  Partial<
    Pick<
      GraphStoreData,
      "selectedNodeId" | "hasResolvedInitialCompactSelection"
    >
  > => {
  const nodes = updateProcessingNode(state.nodes, nodeId, update);
  const shouldAutoSelect =
    nodes !== state.nodes &&
    state.presentationMode === "compact" &&
    !state.hasResolvedInitialCompactSelection &&
    state.selectedNodeId === null;

  return shouldAutoSelect
    ? {
        nodes,
        selectedNodeId: nodeId,
        hasResolvedInitialCompactSelection: true,
      }
    : { nodes };
};

/** 图快照替换与选择修复必须一起提交，不能短暂暴露悬空 selectedNodeId。 */
const createGraphPatch = (
  state: GraphStoreData,
  graph: GraphSnapshot,
): Pick<GraphStoreData, "nodes" | "edges" | "selectedNodeId"> => ({
  nodes: graph.nodes,
  edges: graph.edges,
  selectedNodeId: graph.nodes.some(node => node.id === state.selectedNodeId)
    ? state.selectedNodeId
    : null,
});

/** 编译期穷尽检查：公共事件新增分支时，Store 必须显式决定归并语义。 */
const assertNeverStreamEvent = (event: never): never => {
  throw new Error(`未处理的 StreamEvent：${JSON.stringify(event)}`);
};

/** 每次 reset 都创建新数组，避免多个 store 实例共享可变容器。 */
const createInitialGraphState = (): GraphStoreData => ({
  activeRunId: null,
  // 空字符串只表示尚未开始查询；真实请求仍由 SearchRequestSchema 保证非空。
  query: "",
  language: null,
  presentationMode: null,
  nodes: [],
  edges: [],
  selectedNodeId: null,
  hasResolvedInitialCompactSelection: false,
  isSearching: false,
  hasCompleted: false,
  runError: null,
  lastSequence: 0,
});

/** 工厂用于测试隔离；应用级 singleton 在文件末尾统一创建。 */
export const createGraphStore = () =>
  createStore<GraphStoreState>()(set => ({
    ...createInitialGraphState(),

    startRun: request => {
      // 新 Run 必须原子清空旧图和游标，避免 UI 短暂组合两次查询的状态。
      set({
        ...createInitialGraphState(),
        activeRunId: request.runId,
        query: request.query,
        language: request.language,
        isSearching: true,
      });
    },

    applyStreamEvent: event => {
      set(state => {
        /**
         * 三道门禁在读取 payload 前完成；被丢弃事件返回同一对象，因此不会推进
         * sequence、关闭新 Run 或触发订阅者。sequence 允许跳号，只拒绝非递增值。
         */
        if (
          event.runId !== state.activeRunId ||
          !state.isSearching ||
          event.sequence <= state.lastSequence
        ) {
          return state;
        }

        // 最终快照自带 Run 身份；内外不一致时不能绕过 Envelope 门禁污染当前 Graph。
        if (
          event.type === "complete" &&
          event.data.result.runId !== event.runId
        ) {
          return state;
        }

        const sequencePatch = { lastSequence: event.sequence };

        switch (event.type) {
          case "query.analysis":
            // 只保存 UI 必需的展示模式，不复制完整 Analysis 形成第二份业务状态。
            return {
              presentationMode: event.data.presentationMode,
              ...sequencePatch,
            };

          case "graph.plan":
            // 服务端只应发布一次计划；重复计划不能把已收敛的 Node 退回 planned。
            return state.nodes.length > 0
              ? sequencePatch
              : {
                  ...createGraphPatch(state, event.data),
                  presentationMode: event.data.analysis.presentationMode,
                  ...sequencePatch,
                };

          case "node.status":
            return {
              nodes: updateProcessingNode(
                state.nodes,
                event.nodeId,
                node => ({ ...node, status: event.status }),
              ),
              ...sequencePatch,
            };

          case "node.ready":
            return {
              ...createUsefulNodePatch(
                state,
                event.nodeId,
                node => ({
                  ...node,
                  status: "ready",
                  resources: event.resources,
                  warnings: event.warnings,
                }),
              ),
              ...sequencePatch,
            };

          case "node.partial":
            return {
              ...createUsefulNodePatch(
                state,
                event.nodeId,
                node => ({
                  ...node,
                  status: "partial",
                  resources: event.resources,
                  warnings: event.warnings,
                }),
              ),
              ...sequencePatch,
            };

          case "node.failed":
            return {
              nodes: updateProcessingNode(
                state.nodes,
                event.nodeId,
                node => ({
                  ...node,
                  status: "failed",
                  resources: [],
                  warnings: [],
                  error: event.error,
                }),
              ),
              ...sequencePatch,
            };

          case "complete": {
            // ResultGraph 已通过公共 Schema，是丢失增量事件后的权威恢复快照。
            const graphPatch = createGraphPatch(
              state,
              event.data.result.graph,
            );
            const fallbackNode = graphPatch.nodes.find(
              node => node.status === "ready" || node.status === "partial",
            );
            const shouldAutoSelectFromComplete =
              event.data.result.analysis.presentationMode === "compact" &&
              !state.hasResolvedInitialCompactSelection &&
              state.selectedNodeId === null &&
              fallbackNode !== undefined;

            return {
              ...graphPatch,
              // complete 是漏收增量事件后的权威恢复快照，模式也必须一并收敛。
              presentationMode:
                event.data.result.analysis.presentationMode,
              ...(shouldAutoSelectFromComplete
                ? {
                    selectedNodeId: fallbackNode.id,
                    hasResolvedInitialCompactSelection: true,
                  }
                : {}),
              ...sequencePatch,
              isSearching: false,
              hasCompleted: true,
            };
          }

          case "run.failed":
            // Run 级失败保留已收到的 Graph 和规范化错误，不能被界面误当成零结果成功。
            return { ...sequencePatch, isSearching: false, runError: event.error };
        }

        return assertNeverStreamEvent(event);
      });
    },

    setGraph: graph => {
      set(state => createGraphPatch(state, graph));
    },

    selectNode: selectedNodeId => {
      // React Flow 的 click 与 selection 事件可能为同一 Node 连续到达；
      // 相同选择直接复用当前状态，避免无意义通知形成受控组件更新环。
      set(state =>
        state.selectedNodeId === selectedNodeId
          ? state
          : {
              selectedNodeId,
              // 实际选择变化表示用户已经接管；后续终态不能再次自动覆盖。
              hasResolvedInitialCompactSelection: true,
            },
      );
    },

    finishRun: () => {
      set({ isSearching: false });
    },

    reset: () => {
      set(createInitialGraphState());
    },
  }));

/** 选中对象始终从当前 nodes 计算，节点被替换或清空后自动返回 null。 */
export const selectSelectedNode = (
  state: GraphStoreState,
): GraphStoreNode | null =>
  state.nodes.find(node => node.id === state.selectedNodeId) ?? null;

export const graphStore = createGraphStore();
