/**
 * 测试配置职责：让 Server 单测直接读取 Contracts 的 TypeScript 单一事实来源。
 * 生产构建仍通过 package exports 使用先构建完成的 dist/index.js。
 */
import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

const contractsEntry = fileURLToPath(
  new URL("../../packages/contracts/src/index.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    // 根与工程子路径均精确匹配，避免子路径被拼接到 index.ts 后面。
    alias: [
      { find: /^@wayfinder\/contracts$/, replacement: contractsEntry },
      { find: /^@wayfinder\/contracts\/graph-history$/, replacement: fileURLToPath(new URL("../../packages/contracts/src/graph-history.ts", import.meta.url)) },
    ],
  },
});
