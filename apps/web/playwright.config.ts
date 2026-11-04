/**
 * 配置职责：用单一 Chromium 项目运行 WAY-85 的确定性 Browser-like E2E。
 *
 * 关键边界：
 * - 只启动本地 Vite，不启动真实 Provider / LLM Server；
 * - 不复用未知本地服务，固定端口冲突时直接失败；
 * - 失败证据写入已忽略目录，普通成功运行不保留报告噪声。
 */
import { defineConfig, devices } from "@playwright/test";
import { WEB_TEST_TIMEOUT_MS, WEB_WAIT_TIMEOUT_MS } from "./test-timing.js";

const E2E_PORT = 4_174;
const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: WEB_TEST_TIMEOUT_MS,
  expect: { timeout: WEB_WAIT_TIMEOUT_MS },
  workers: 1,
  reporter: "line",
  outputDir: "../../test-results/wayfinder-web",
  use: {
    ...devices["Desktop Chrome"],
    // 持续集成降低软件渲染的像素密度；本地使用同版本的完整 Chromium，按桌面原始密度采集动效。
    ...(process.env.CI ? { deviceScaleFactor: 0.25 } : { channel: "chromium" }),
    baseURL: E2E_ORIGIN,
    actionTimeout: WEB_WAIT_TIMEOUT_MS,
    navigationTimeout: WEB_WAIT_TIMEOUT_MS,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${E2E_PORT} --strictPort`,
    url: E2E_ORIGIN,
    reuseExistingServer: false,
    timeout: WEB_WAIT_TIMEOUT_MS,
    stdout: "ignore",
    stderr: "pipe",
  },
});
