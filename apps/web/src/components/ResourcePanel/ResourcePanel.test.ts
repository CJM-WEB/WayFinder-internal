/**
 * 测试职责：冻结 WAY-31 选中节点到 Resource Panel（资源面板）视图模型的映射。
 *
 * 关键约束：ready、partial 与 failed 都能被选择；failed 没有 Resource 时仍必须展示节点状态。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { pythonResultGraphFixture } from "../../fixtures/python-result-graph.js";
import {
  createGraphStore,
  selectSelectedNode,
  type GraphStoreNode,
} from "../../stores/graph-store.js";
import {
  buildResourcePanelModel,
  ResourcePanelView,
} from "./ResourcePanel.js";

const fixtureNodeByStatus = (
  status: "ready" | "partial" | "failed",
): GraphStoreNode => {
  const node = pythonResultGraphFixture.graph.nodes.find(
    candidate => candidate.status === status,
  );

  if (node === undefined) {
    throw new Error(`Python fixture 缺少 ${status} 节点`);
  }

  return node;
};

describe("Resource Panel model", () => {
  it("未选择节点时返回明确空态", () => {
    expect(buildResourcePanelModel(null)).toEqual({ kind: "unselected" });
  });

  it.each(["ready", "partial"] as const)(
    "为 %s 节点保留完整 Resource 展示字段",
    status => {
      const node = fixtureNodeByStatus(status);
      const model = buildResourcePanelModel(node);

      expect(model).toMatchObject({
        kind: "selected",
        nodeTitle: node.title,
        nodeStatus: status,
        nodeStatusLabel: status === "ready" ? "已就绪" : "部分完成",
      });

      if (model.kind !== "selected") {
        throw new Error("已选择节点必须生成 selected 模型");
      }

      expect(model.resources).toEqual(
        "resources" in node ? node.resources : [],
      );

      const resource = model.resources[0];
      if (resource === undefined) {
        throw new Error(`${status} 节点缺少预期 Resource`);
      }

      const markup = renderToStaticMarkup(
        createElement(ResourcePanelView, { model }),
      );

      expect(markup).toContain(node.title);
      expect(markup).toContain(model.nodeStatusLabel);
      expect(markup).toContain(resource.title);
      expect(markup).toContain(resource.domain);
      expect(markup).toContain(resource.sourceType.replaceAll("_", " "));
      expect(markup).toContain(resource.summary);
      expect(markup).toContain(resource.whySelected);
    },
  );

  it("为 failed 节点保留失败状态并提供无资源说明", () => {
    const node = fixtureNodeByStatus("failed");
    const model = buildResourcePanelModel(node);

    expect(model).toMatchObject({
      kind: "selected",
      nodeTitle: node.title,
      nodeStatus: "failed",
      nodeStatusLabel: "失败",
      resources: [],
      emptyMessage: "该节点检索失败，暂无可展示的资源。",
    });

    expect(
      renderToStaticMarkup(createElement(ResourcePanelView, { model })),
    ).toContain("该节点检索失败，暂无可展示的资源。");
  });

  it("按非箭头顺序选择任意节点并保持三种最终状态", () => {
    const store = createGraphStore();
    const nodes = pythonResultGraphFixture.graph.nodes;
    const selectionOrder = [nodes[3], nodes[0], nodes[1], nodes[2]];

    store.getState().setGraph(pythonResultGraphFixture.graph);

    for (const node of selectionOrder) {
      if (node === undefined) {
        throw new Error("Python fixture 缺少选择顺序中的预期节点");
      }

      store.getState().selectNode(node.id);
      expect(selectSelectedNode(store.getState())).toMatchObject({
        id: node.id,
        status: node.status,
      });
    }
  });

  it("重复选择同一节点时不产生额外 Store 通知", () => {
    const store = createGraphStore();
    const readyNode = fixtureNodeByStatus("ready");
    let notificationCount = 0;

    store.getState().setGraph(pythonResultGraphFixture.graph);
    store.subscribe(() => {
      notificationCount += 1;
    });

    store.getState().selectNode(readyNode.id);
    store.getState().selectNode(readyNode.id);

    expect(notificationCount).toBe(1);
  });

  it("将未选择状态真正渲染为引导文案", () => {
    const markup = renderToStaticMarkup(
      createElement(ResourcePanelView, {
        model: buildResourcePanelModel(null),
      }),
    );

    expect(markup).toContain("选择一个节点");
    expect(markup).toContain("不必沿箭头顺序浏览");
  });
});
