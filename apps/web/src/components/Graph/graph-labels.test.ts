/**
 * 测试职责：冻结六种 Node（节点）状态的非颜色语义与加载边界。
 *
 * 关键约束：状态必须通过中文标签、符号和说明共同可辨；只有执行中的两态可标记加载。
 */
import { StreamNodeStatusSchema } from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import { buildNodeStatusPresentation } from "./graph-labels.js";

describe("Graph Node 状态展示模型", () => {
  it("为六种 Contract 状态提供两两可辨的非颜色提示", () => {
    const presentations = StreamNodeStatusSchema.options.map(status => ({
      status,
      presentation: buildNodeStatusPresentation(status, 3),
    }));
    const nonColorSignatures = presentations.map(
      ({ presentation }) =>
        `${presentation.marker}|${presentation.label}|${presentation.detail}`,
    );

    expect(presentations).toHaveLength(6);
    expect(new Set(nonColorSignatures)).toHaveLength(6);
    for (const { presentation } of presentations) {
      expect(presentation.marker).not.toBe("");
      expect(presentation.label).not.toBe("");
      expect(presentation.detail).not.toBe("");
    }
  });

  it("只有 searching 与 filtering 是活动加载态", () => {
    const loadingStatuses = StreamNodeStatusSchema.options.filter(
      status => buildNodeStatusPresentation(status, 0).isLoading,
    );

    expect(loadingStatuses).toEqual(["searching", "filtering"]);
    expect(buildNodeStatusPresentation("planned", 0)).toMatchObject({
      label: "等待检索",
      detail: "等待开始",
      isLoading: false,
    });
    expect(buildNodeStatusPresentation("failed", 0)).toMatchObject({
      label: "失败",
      detail: "没有可用资源",
      isLoading: false,
    });
  });

  it("完整成功与降级成功显示真实资源数且明确区分", () => {
    expect(buildNodeStatusPresentation("ready", 2)).toMatchObject({
      detail: "2 条可用资源",
      isLoading: false,
    });
    expect(buildNodeStatusPresentation("partial", 2)).toMatchObject({
      detail: "2 条可用资源 · 含降级",
      isLoading: false,
    });
  });

  it("English 状态覆盖六态并正确处理资源单复数", () => {
    const labels = StreamNodeStatusSchema.options.map(
      status => buildNodeStatusPresentation(status, 2, "en-US").label,
    );

    expect(new Set(labels)).toHaveLength(StreamNodeStatusSchema.options.length);
    expect(buildNodeStatusPresentation("ready", 1, "en-US").detail).toBe(
      "1 available resource",
    );
    expect(buildNodeStatusPresentation("ready", 2, "en-US").detail).toBe(
      "2 available resources",
    );
    expect(buildNodeStatusPresentation("partial", 2, "en-US").detail).toBe(
      "2 available resources · Degraded",
    );
  });
});
