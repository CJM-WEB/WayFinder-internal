/**
 * 测试职责：冻结 localized sibling（本地化同页）门禁的保守识别与稳定过滤语义。
 */
import type { CandidateSearchHit } from "@wayfinder/contracts";
import { describe, expect, it } from "vitest";

import { preferLocalizedSiblings } from "./prefer-localized-siblings.js";

function candidate(url: string, title = "MySQL"): CandidateSearchHit {
  const parsed = new URL(url);
  return {
    provider: "test",
    query: "mysql",
    title,
    url,
    canonicalUrl: parsed.toString(),
    domain: parsed.hostname,
    snippet: "snippet",
  };
}

describe("preferLocalizedSiblings", () => {
  it("中文 Path 副本可替代更早的中性与英文入口", () => {
    const inputs = [
      candidate("https://www.mysql.com/"),
      candidate("https://www.mysql.com/en/"),
      candidate("https://www.mysql.com/cn/"),
    ];

    expect(preferLocalizedSiblings(inputs, "zh-CN")).toEqual([inputs[2]]);
  });

  it("多个中文副本只保留 Provider 顺序最靠前的一个", () => {
    const inputs = [
      candidate("https://example.com/zh/"),
      candidate("https://example.com/cn/"),
      candidate("https://example.com/EN_us/"),
    ];

    expect(preferLocalizedSiblings(inputs, "zh-CN")).toEqual([inputs[0]]);
  });

  it("没有中文副本时不删除中性或英文入口", () => {
    const inputs = [
      candidate("https://example.com/"),
      candidate("https://example.com/en-gb/"),
    ];

    expect(preferLocalizedSiblings(inputs, "zh-CN")).toEqual(inputs);
  });

  it("支持标题 NFKC、空白折叠和 ASCII marker 规范化", () => {
    const inputs = [
      candidate("https://example.com/EN_us/docs", "  ＭｙＳＱＬ\nDocs "),
      candidate("https://example.com/ZH_HANS/docs", "mysql docs"),
    ];

    expect(preferLocalizedSiblings(inputs, "zh-CN")).toEqual([inputs[1]]);
  });

  it("只移除唯一受支持的 Query 语言维度", () => {
    const inputs = [
      candidate("https://example.com/docs?lang=en&topic=sql"),
      candidate("https://example.com/docs?lang=zh-CN&topic=sql"),
    ];

    expect(preferLocalizedSiblings(inputs, "zh-CN")).toEqual([inputs[1]]);
  });

  it.each(["language", "locale"])(
    "支持唯一 %s Query 语言维度",
    key => {
      const inputs = [
        candidate(`https://example.com/docs?${key}=en&topic=sql`),
        candidate(`https://example.com/docs?${key}=zh-cn&topic=sql`),
      ];
      expect(preferLocalizedSiblings(inputs, "zh-CN")).toEqual([inputs[1]]);
    },
  );

  it("Path 尾斜杠语义不同时不合并", () => {
    const inputs = [
      candidate("https://example.com/docs"),
      candidate("https://example.com/zh/docs/"),
    ];
    expect(preferLocalizedSiblings(inputs, "zh-CN")).toEqual(inputs);
  });

  it("根路径与 /1234/ 始终是不同页面", () => {
    const inputs = [
      candidate("https://example.com/"),
      candidate("https://example.com/1234/"),
    ];
    expect(preferLocalizedSiblings(inputs, "zh-CN")).toEqual(inputs);
  });

  it("普通英文论文没有明确 Locale 维度时不合并", () => {
    const inputs = [
      candidate("https://papers.example/paper-a", "Graph Search Paper"),
      candidate("https://papers.example/paper-b", "Graph Search Paper"),
    ];
    expect(preferLocalizedSiblings(inputs, "zh-CN")).toEqual(inputs);
  });

  it("无法解析 canonicalUrl 时 fail-open 并保留原对象", () => {
    const invalid = {
      ...candidate("https://example.com/docs"),
      canonicalUrl: "not-a-url",
    };
    const target = candidate("https://example.com/zh/docs");
    expect(preferLocalizedSiblings([invalid, target], "zh-CN")).toEqual([
      invalid,
      target,
    ]);
  });

  it.each([
    [
      "不同页面 Path",
      candidate("https://example.com/"),
      candidate("https://example.com/zh-cn/1234/"),
    ],
    [
      "不同业务 Query",
      candidate("https://example.com/docs?lang=en&topic=a"),
      candidate("https://example.com/docs?lang=zh&topic=b"),
    ],
    [
      "不同标题",
      candidate("https://example.com/en/", "Paper A"),
      candidate("https://example.com/zh/", "Paper B"),
    ],
    [
      "不同 origin",
      candidate("https://example.com/en/"),
      candidate("http://example.com/zh/"),
    ],
  ])("保留%s", (_name, first, second) => {
    expect(preferLocalizedSiblings([first, second], "zh-CN")).toEqual([
      first,
      second,
    ]);
  });

  it.each([
    [
      "重复 Query 语言参数",
      "https://example.com/docs?lang=en&lang=en",
    ],
    [
      "多个 Query 语言 key",
      "https://example.com/docs?lang=en&locale=zh",
    ],
    [
      "Path 与 Query 语言冲突",
      "https://example.com/cn/docs?lang=zh-CN",
    ],
    ["未支持 Query marker", "https://example.com/docs?lang=fr"],
  ])("歧义的%s fail-open", (_name, ambiguousUrl) => {
    const ambiguous = candidate(ambiguousUrl);
    const target = candidate("https://example.com/zh/docs");
    expect(preferLocalizedSiblings([ambiguous, target], "zh-CN")).toEqual([
      ambiguous,
      target,
    ]);
  });

  it("不识别语言子域、ccTLD、中间 Path 或普通 topic 值", () => {
    const inputs = [
      candidate("https://zh.example.com/docs"),
      candidate("https://example.cn/docs"),
      candidate("https://example.com/docs/zh/"),
      candidate("https://example.com/docs?topic=cn"),
    ];
    expect(preferLocalizedSiblings(inputs, "zh-CN")).toEqual(inputs);
  });

  it("不改写输入对象且重复执行幂等", () => {
    const inputs = [
      candidate("https://example.com/en/"),
      candidate("https://example.com/zh-cn/"),
      candidate("https://other.example/1234/"),
    ];
    const snapshot = structuredClone(inputs);
    const once = preferLocalizedSiblings(inputs, "zh-CN");

    expect(inputs).toEqual(snapshot);
    expect(preferLocalizedSiblings(once, "zh-CN")).toEqual(once);
    expect(once).toEqual([inputs[1], inputs[2]]);
  });
});
