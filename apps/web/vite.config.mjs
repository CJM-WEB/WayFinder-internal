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
  // 开发预览使用 .env.example 中约定的本地 API 端口；生产仍由原 Fastify 同源提供。
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
  // 独立视觉试验单独打包；原应用仍使用 index.html，不增加其启动依赖。
  build: {
    rolldownOptions: {
      input: {
        app: fileURLToPath(new globalThis.URL("./index.html", import.meta.url)),
        inkStudy: fileURLToPath(new globalThis.URL("./ink-study.html", import.meta.url)),
      },
    },
  },
  resolve: {
    alias: {
      "@wayfinder/contracts": contractsEntry,
    },
  },
});
