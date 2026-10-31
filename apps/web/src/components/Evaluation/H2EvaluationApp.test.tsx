/**
 * 测试职责：证明 H2 工件严格校验、A/B 复用同一 Resource Panel，且页面不泄露检索来源。
 */
import {
  H2EvaluationArtifactSchema,
  type H2EvaluationArtifact,
} from "@wayfinder/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { pythonResultGraphFixture } from "../../fixtures/python-result-graph.js";
import {
  H2EvaluationApp,
  H2EvaluationView,
  parseH2EvaluationArtifact,
} from "./H2EvaluationApp.js";

function createArtifact(): H2EvaluationArtifact {
  const node = pythonResultGraphFixture.graph.nodes[0];
  if (node === undefined || node.status === "failed") {
    throw new Error("H2 Fixture 缺少可交付 Node");
  }

  return H2EvaluationArtifactSchema.parse({
    version: "h2-evaluation.v1",
    query: pythonResultGraphFixture.query.raw,
    conditions: [
      { id: "A", source: "node_specific", node },
      {
        id: "B",
        source: "raw_query",
        node: {
          ...node,
          searchPlan: {
            ...node.searchPlan,
            queries: [pythonResultGraphFixture.query.raw],
            maxResults: 20,
          },
          resources: node.resources.map(resource => ({
            ...resource,
            id: `${resource.id}-raw`,
            title: `${resource.title} Raw Variant`,
          })),
        },
      },
    ],
  });
}

describe("H2 Evaluation 工件读取", () => {
  it("只接受共享 Contract，且不会为非法 JSON 猜测修复", () => {
    const artifact = createArtifact();
    expect(parseH2EvaluationArtifact(JSON.stringify(artifact))).toEqual(
      artifact,
    );
    expect(() => parseH2EvaluationArtifact("{invalid"))
      .toThrow("不是有效 JSON");
    expect(() =>
      parseH2EvaluationArtifact(JSON.stringify({ ...artifact, version: "v2" })),
    ).toThrow("不符合当前 Contract");
  });
});

describe("H2 Evaluation 盲测视图", () => {
  it.each(["A", "B"] as const)(
    "条件 %s 使用同一生产 Resource Panel 字段与交互",
    condition => {
      const artifact = createArtifact();
      const selected = artifact.conditions.find(item => item.id === condition);
      if (selected === undefined) throw new Error("测试条件缺失");
      const markup = renderToStaticMarkup(
        <H2EvaluationView
          artifact={artifact}
          initialCondition={condition}
          openResource={vi.fn()}
        />,
      );

      expect(markup).toContain('class="resource-panel"');
      expect(markup).toContain(selected.node.title);
      expect(markup).toContain(selected.node.resources[0]?.title);
      expect(markup).toContain("AI 摘要");
      expect(markup).toContain("入选原因");
      expect(markup).toContain(">打开</button>");
      expect(markup).toContain(`data-evaluation-condition="${condition}"`);
      expect(markup).toContain(`条件 ${condition}`);
      expect(markup).not.toContain("node_specific");
      expect(markup).not.toContain("raw_query");
      expect(markup).not.toContain("SearchPlan");
    },
  );

  it("初始 Loader 不发起网络请求，也不暴露条件来源", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const markup = renderToStaticMarkup(<H2EvaluationApp />);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(markup).toContain('type="file"');
      expect(markup).toContain("文件只在当前浏览器标签内解析");
      expect(markup).not.toContain("node_specific");
      expect(markup).not.toContain("raw_query");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
