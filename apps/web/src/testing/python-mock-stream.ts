/**
 * 模块职责：从 Python ResultGraph 固定夹具派生一条连贯、可复现的 Mock Stream（模拟事件流）。
 *
 * 关键约束：最终结果只维护一份事实来源；本模块不复制 Resource（资源）内容，
 * 而是将最终 Node（节点）映射为处理中事件与唯一终态事件。
 */
import {
  GraphPlanSchema,
  StreamEventSchema,
  type StreamEvent,
  type StreamEventPayload,
} from "@wayfinder/contracts";

import { pythonResultGraphFixture } from "../fixtures/python-result-graph.js";

/** 流生成只依赖最小 Clock（时钟）能力，避免绑定测试工具的具体实现。 */
type Clock = {
  now: () => number;
};

export function createPythonMockStream(clock: Clock): readonly StreamEvent[] {
  const result = pythonResultGraphFixture;
  const plan = GraphPlanSchema.parse({
    analysis: result.analysis,
    nodes: result.graph.nodes.map(node => ({
      id: node.id,
      title: node.title,
      description: node.description,
      nodeType: node.nodeType,
      layer: node.layer,
      searchPlan: node.searchPlan,
      status: "planned" as const,
    })),
    edges: result.graph.edges,
  });
  const events: StreamEvent[] = [];

  const append = (payload: StreamEventPayload): void => {
    events.push(
      StreamEventSchema.parse({
        ...payload,
        runId: result.runId,
        sequence: events.length + 1,
        protocolVersion: "0.1",
        timestamp: new Date(clock.now()).toISOString(),
      }),
    );
  };

  append({ type: "query.analysis", data: result.analysis });
  append({ type: "graph.plan", data: plan });

  for (const node of result.graph.nodes) {
    append({ type: "node.status", nodeId: node.id, status: "searching" });

    // 每个 Node 只发一个终态；失败节点不能伪造空的 ready/partial 结果。
    if (node.status === "ready") {
      append({
        type: "node.ready",
        nodeId: node.id,
        resources: node.resources,
        warnings: node.warnings,
      });
    } else if (node.status === "partial") {
      append({
        type: "node.partial",
        nodeId: node.id,
        resources: node.resources,
        warnings: node.warnings,
      });
    } else {
      append({ type: "node.failed", nodeId: node.id, error: node.error });
    }
  }

  append({
    type: "complete",
    data: {
      finalStatus: result.meta.partial ? "partial" : "complete",
      result,
    },
  });

  return events;
}
