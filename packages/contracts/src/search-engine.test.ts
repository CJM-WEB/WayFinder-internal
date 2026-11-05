/** 测试职责：引擎覆盖与语言默认独立解析，旧协议字段缺失不被补写为伪造来源。 */
import { describe, expect, it } from "vitest";
import {
  EditableResourceSchema,
  resolveSearchEngine,
  SearchEngineSchema,
  SearchRequestSchema,
} from "./index.js";

describe("搜索引擎边界", () => {
  it("保留旧请求形状，只在执行时解析默认引擎", () => {
    const request = { runId: "run", query: "查询", language: "zh-CN" };
    expect(SearchRequestSchema.parse(request)).toEqual(request);
    expect(resolveSearchEngine("zh-CN")).toBe("baidu");
    expect(resolveSearchEngine("en-US")).toBe("google");
  });

  it.each(["zh-CN", "en-US"] as const)("%s 允许覆盖为任一已支持引擎", language => {
    for (const engine of SearchEngineSchema.options) {
      const request = { runId: "run", query: "查询", language, engine };
      expect(SearchRequestSchema.parse(request)).toEqual(request);
      expect(resolveSearchEngine(language, engine)).toBe(engine);
    }
  });

  it("非法引擎不进入公共请求", () => {
    expect(SearchRequestSchema.safeParse({
      runId: "run", query: "查询", language: "zh-CN", engine: "bing",
    }).success).toBe(false);
  });

  it("手动资源拒绝冒用实际引擎，历史搜索资源允许来源未记录", () => {
    const resource = {
      id: "resource", title: "链接", url: "https://example.com/",
      canonicalUrl: "https://example.com/", domain: "example.com",
      sourceType: "user_added", summary: "", whySelected: "", rank: 1,
    };
    expect(EditableResourceSchema.safeParse({ ...resource, origin: "manual", engine: "google" }).success).toBe(false);
    const old = { ...resource, origin: "search", searchProvider: "serpapi_bing" };
    expect(EditableResourceSchema.parse(old)).toEqual(old);
    const searched = EditableResourceSchema.parse({ ...old, engine: "google" });
    expect(searched.origin).toBe("search");
    if (searched.origin === "search") expect(searched.engine).toBe("google");
  });
});
