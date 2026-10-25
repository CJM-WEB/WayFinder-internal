/**
 * 测试职责：冻结选中 Node 到 Resource Panel（资源面板）的映射、WAY-80
 * Show More（展开更多）边界，以及 WAY-81 的终态 Warning / Error 提示。
 *
 * 关键约束：ready、partial 与 failed 都能被选择；failed 没有 Resource 时仍必须展示节点状态。
 */
import {
  AppErrorCodeSchema,
  MAX_RETAINED_RESOURCES_PER_NODE,
  NodeWarningCodeSchema,
  type Resource,
} from "@wayfinder/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { pythonResultGraphFixture } from "../../fixtures/python-result-graph.js";
import {
  createGraphStore,
  selectSelectedNode,
  type GraphStoreNode,
} from "../../stores/graph-store.js";
import {
  buildResourcePanelModel,
  ResourcePanelView,
  selectVisibleResources,
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

/**
 * 构造保持输入顺序的 retained Resource（本轮保留资源）列表。
 * 测试刻意不从 rank 推导顺序，避免前端复制 Finalizer 的排序职责。
 */
const buildRetainedResources = (count: number): readonly Resource[] => {
  const node = fixtureNodeByStatus("ready");
  if (!("resources" in node) || node.resources[0] === undefined) {
    throw new Error("ready Fixture 缺少 Resource");
  }

  return Array.from({ length: count }, (_, index) => ({
    ...node.resources[0]!,
    id: `resource-${index + 1}`,
    title: `Resource ${index + 1}`,
    url: `https://source-${index + 1}.example/item`,
    canonicalUrl: `https://source-${index + 1}.example/item`,
    domain: `source-${index + 1}.example`,
    rank: index + 1,
  }));
};

/** 构造只含数量差异的 ready 面板模型，避免每个边界用例重复无关字段。 */
const buildSelectedModel = (resources: readonly Resource[]) => {
  const node = fixtureNodeByStatus("ready");

  return {
    kind: "selected" as const,
    nodeId: node.id,
    nodeTitle: node.title,
    nodeStatus: node.status,
    nodeStatusLabel: "已就绪",
    resources,
    outcomeNotice: null,
    emptyMessage: resources.length === 0 ? "资源仍在准备中。" : null,
  };
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
        nodeId: node.id,
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
      expect(model.outcomeNotice?.kind ?? null).toBe(
        status === "partial" ? "warning" : null,
      );

      const resource = model.resources[0];
      if (resource === undefined) {
        throw new Error(`${status} 节点缺少预期 Resource`);
      }

      const markup = renderToStaticMarkup(
        createElement(ResourcePanelView, { model, openResource: vi.fn() }),
      );

      expect(markup).toContain(node.title);
      expect(markup).toContain(model.nodeStatusLabel);
      expect(markup).toContain(resource.title);
      expect(markup).toContain(resource.domain);
      expect(markup).toContain(resource.sourceType.replaceAll("_", " "));
      expect(markup).toContain(resource.summary);
      expect(markup).toContain(resource.whySelected);
      expect(markup).toContain('type="button"');
      expect(markup).toContain(
        `aria-label="在新标签页打开 ${resource.title}"`,
      );
      expect(markup).toContain(">Open</button>");
    },
  );

  it("partial 按 Contract 顺序展示全部安全降级说明，不暴露原始 Warning Code", () => {
    const node = fixtureNodeByStatus("partial");
    if (node.status !== "partial") {
      throw new Error("测试节点必须是 partial");
    }
    const warnings = [...NodeWarningCodeSchema.options].reverse();
    const expectedMessages = [
      "智能排序暂时不可用，当前结果使用基础排序。",
      "部分网页正文读取失败，相关内容使用搜索摘要。",
      "部分搜索来源暂时不可用，现有结果仍可浏览。",
    ];
    const model = buildResourcePanelModel({ ...node, warnings });

    expect(model).toMatchObject({
      kind: "selected",
      nodeStatus: "partial",
      outcomeNotice: {
        kind: "warning",
        title: "结果部分降级",
        messages: expectedMessages,
      },
    });

    const markup = renderToStaticMarkup(
      createElement(ResourcePanelView, { model }),
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain("resource-panel__outcome--warning");
    for (const message of expectedMessages) {
      expect(markup).toContain(message);
    }
    for (const warning of warnings) {
      expect(markup).not.toContain(warning);
    }
  });

  it("初始渲染不会自动打开 Resource", () => {
    const model = buildResourcePanelModel(fixtureNodeByStatus("ready"));
    const openResource = vi.fn(() => null);

    renderToStaticMarkup(
      createElement(ResourcePanelView, { model, openResource }),
    );

    expect(openResource).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])(
    "%i 个 retained Resource 全部可见且不显示 Show More",
    resourceCount => {
      const resources = buildRetainedResources(resourceCount);
      const markup = renderToStaticMarkup(
        createElement(ResourcePanelView, {
          model: buildSelectedModel(resources),
          openResource: vi.fn(),
        }),
      );

      for (const resource of resources) {
        expect(markup).toContain(resource.title);
      }
      expect(markup).not.toContain("显示更多");
    },
  );

  it.each([
    { resourceCount: 4, hiddenCount: 1 },
    {
      resourceCount: MAX_RETAINED_RESOURCES_PER_NODE,
      hiddenCount: MAX_RETAINED_RESOURCES_PER_NODE - 3,
    },
  ])(
    "$resourceCount 个 retained Resource 默认显示 Top 3，展开后保持完整顺序",
    ({ resourceCount, hiddenCount }) => {
      const resources = buildRetainedResources(resourceCount);
      const resourcesSnapshot = [...resources];
      const collapsedResources = selectVisibleResources(resources, false);
      const expandedResources = selectVisibleResources(resources, true);

      expect(collapsedResources).toEqual(resources.slice(0, 3));
      expect(expandedResources).toEqual(resources);
      expect(resources).toEqual(resourcesSnapshot);

      const markup = renderToStaticMarkup(
        createElement(ResourcePanelView, {
          model: buildSelectedModel(resources),
          openResource: vi.fn(),
        }),
      );
      expect(markup).toContain("Resource 1");
      expect(markup).toContain("Resource 3");
      expect(markup).not.toContain("Resource 4");
      expect(markup).not.toContain(`Resource ${resourceCount}`);
      expect(markup).toContain(`显示更多（${hiddenCount}）`);
    },
  );

  it("按 retained 数组顺序取 Top 3，不依据 rank 在前端重排", () => {
    const resources = buildRetainedResources(4).map((resource, index) => ({
      ...resource,
      rank: [8, 1, 6, 2][index]!,
    }));

    expect(selectVisibleResources(resources, false)).toEqual(
      resources.slice(0, 3),
    );
    expect(selectVisibleResources(resources, true)).toEqual(resources);
  });

  it("为所有公共 Error Code 提供简洁安全的 failed 错误态", () => {
    const node = fixtureNodeByStatus("failed");
    if (node.status !== "failed") {
      throw new Error("测试节点必须是 failed");
    }
    const messages = AppErrorCodeSchema.options.map(code => {
      const model = buildResourcePanelModel({
        ...node,
        error: { code, retryable: false },
      });

      expect(model).toMatchObject({
        kind: "selected",
        nodeTitle: node.title,
        nodeStatus: "failed",
        nodeStatusLabel: "失败",
        resources: [],
        outcomeNotice: {
          kind: "error",
          title: "节点处理失败",
          messages: [expect.any(String)],
        },
        emptyMessage: null,
      });

      if (model.kind !== "selected" || model.outcomeNotice === null) {
        throw new Error("failed Node 必须生成错误提示");
      }
      const [message] = model.outcomeNotice.messages;
      expect(message).toBeTruthy();

      const markup = renderToStaticMarkup(
        createElement(ResourcePanelView, { model }),
      );
      expect(markup).toContain('role="alert"');
      expect(markup).toContain("resource-panel__outcome--error");
      expect(markup).toContain(message);
      expect(markup).not.toContain(code);
      expect(markup).not.toContain(">Open</button>");
      expect(markup).not.toContain("显示更多");

      return message;
    });

    expect(new Set(messages).size).toBe(AppErrorCodeSchema.options.length);
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
