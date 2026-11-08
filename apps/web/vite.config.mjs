/**
 * 配置职责：提供 Web App 的 React 构建入口，并让开发与测试统一解析共享 Contract。
 *
 * 关键约束：alias 使用 import.meta.url 推导仓库路径，不能写死 macOS 或 Windows 用户目录。
 */
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { WEB_TEST_TIMEOUT_MS } from "./test-timing.ts";

const contractsEntry = fileURLToPath(
  new globalThis.URL("../../packages/contracts/src/index.ts", import.meta.url),
);

export default defineConfig({
  plugins: [react()],
  // 单元测试和钩子共用完成上限；异步状态一旦就绪，断言仍立即返回。
  test: {
    testTimeout: WEB_TEST_TIMEOUT_MS,
    hookTimeout: WEB_TEST_TIMEOUT_MS,
  },
  // 开发预览使用 .env.example 中约定的本地 API 端口；生产仍由原 Fastify 同源提供。
  server: {
    proxy: {
      // 字符串简写会默认启用 changeOrigin，改写 Host 后与浏览器 Origin 不符，导致授权被拒绝。
      // 显式保留原 Host / Origin，让后端继续执行精确同源校验，不通过放宽校验修复代理。
      "/api": { target: "http://127.0.0.1:3000", changeOrigin: false },
    },
  },
  // 沿用 Vite 默认 index.html 单入口；墨迹漫游即正式产品，不再打包重复的试验页面。
  resolve: {
    alias: {
      "@wayfinder/contracts": contractsEntry,
    },
  },
});
