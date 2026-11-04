/**
 * 配置职责：用单一 Chromium 项目运行 WAY-85 的确定性 Browser-like E2E。
 *
 * 关键边界：
 * - 只启动本地 Vite，不启动真实 Provider / LLM Server；
 * - 不复用未知本地服务，固定端口冲突时直接失败；
 * - 失败证据写入已忽略目录，普通成功运行不保留报告噪声。
 */
import { defineConfig, devices } from "@playwright/test";

const E2E_PORT = 4_174;
const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "line",
  outputDir: "../../test-results/wayfinder-web",
  use: {
    ...devices["Desktop Chrome"],
    // 持续集成使用软件渲染，降低物理像素密度以保留实时采帧；本地沿用桌面原始密度复核画质。
    ...(process.env.CI ? { deviceScaleFactor: 0.25 } : {}),
    baseURL: E2E_ORIGIN,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${E2E_PORT} --strictPort`,
    url: E2E_ORIGIN,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
