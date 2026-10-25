/**
 * 配置职责：提供 Web App 的 React 构建入口，并让开发与测试统一解析共享 Contract。
 *
 * 关键约束：alias 使用 import.meta.url 推导仓库路径，不能写死 macOS 或 Windows 用户目录。
 */
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const contractsEntry = fileURLToPath(
  new globalThis.URL("../../packages/contracts/src/index.ts", import.meta.url),
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@wayfinder/contracts": contractsEntry,
    },
  },
});
