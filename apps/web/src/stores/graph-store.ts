/**
 * 模块职责：维护 Graph 页面跨组件共享的最小运行状态。
 *
 * 关键约束：
 * - Node、Edge、Run 与 sequence 的字段类型直接来自 @wayfinder/contracts，不能在 Web 内复制协议。
 * - selected Node 只保存 ID，具体对象由 selector 派生，避免图更新后保留陈旧对象。
 * - 本模块只提供显式状态动作；旧 Run、乱序事件和终态封闭属于 WAY-72。
 */
import type {
  GraphEdge,
  GraphNodeCore,
  GraphPlan,
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
  nodes: GraphStoreNode[];
  edges: GraphEdge[];
  selectedNodeId: GraphNodeCore["id"] | null;
  isSearching: boolean;
  lastSequence: StreamEvent["sequence"];
};

type GraphStoreActions = {
  startRun: (request: SearchRequest) => void;
  setGraph: (graph: GraphSnapshot) => void;
  selectNode: (nodeId: GraphNodeCore["id"] | null) => void;
  setLastSequence: (sequence: StreamEvent["sequence"]) => void;
  finishRun: () => void;
  reset: () => void;
};

export type GraphStoreState = GraphStoreData & GraphStoreActions;

/** 每次 reset 都创建新数组，避免多个 store 实例共享可变容器。 */
const createInitialGraphState = (): GraphStoreData => ({
  activeRunId: null,
  // 空字符串只表示尚未开始查询；真实请求仍由 SearchRequestSchema 保证非空。
  query: "",
  nodes: [],
  edges: [],
  selectedNodeId: null,
  isSearching: false,
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
        isSearching: true,
      });
    },

    setGraph: graph => {
      set(state => ({
        nodes: graph.nodes,
        edges: graph.edges,
        // 图替换后不能保留已不存在的 Node ID，否则原始状态会产生悬空选择。
        selectedNodeId: graph.nodes.some(
          node => node.id === state.selectedNodeId,
        )
          ? state.selectedNodeId
          : null,
      }));
    },

    selectNode: selectedNodeId => {
      set({ selectedNodeId });
    },

    setLastSequence: lastSequence => {
      set({ lastSequence });
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
