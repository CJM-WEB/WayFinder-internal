/**
 * 测试职责：证明 Web Workspace 的 TypeScript、ESM 导入与 Vitest 链路可执行。
 */
import { describe, expect, it } from "vitest";

// NodeNext 要求源码写运行时会存在的 .js 扩展名；Vitest 开发时会解析到 index.ts。
import { workspaceId } from "./index.js";

describe("Web Workspace", () => {
  it("暴露仅用于工具链验证的只读标识", () => {
    expect(workspaceId).toBe("@wayfinder/web");
  });
});
