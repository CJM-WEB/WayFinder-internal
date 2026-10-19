/**
 * 模块职责：作为 Server 唯一的 Composition Root（组合根），先校验完整配置，
 * 再创建并监听 Fastify 服务。其他模块导入不会读取 Secret 或启动网络监听。
 */
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildServer } from "./app.js";
import { ServerConfigError, parseServerConfig } from "./config.js";

export interface ServerRuntime {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly startListening: (port: number) => Promise<void>;
  readonly writeError: (message: string) => void;
  readonly setExitCode: (code: number) => void;
}

/**
 * 启动阶段只通过这个窄 Runtime（运行时）边界执行副作用，使测试可以证明：
 * 配置校验失败时不会创建监听，并且未知 Error 只能输出固定脱敏文案。
 */
export async function runServer(runtime: ServerRuntime): Promise<void> {
  try {
    const config = parseServerConfig(runtime.environment);

    await runtime.startListening(config.port);
  } catch (error: unknown) {
    const message =
      error instanceof ServerConfigError
        ? error.message
        : "Server 启动失败，请检查端口与运行环境";

    runtime.writeError(`${message}\n`);
    runtime.setExitCode(1);
  }
}

// 直接执行构建产物时才连接真实进程；Vitest 或其他模块导入不会触发监听。
const entryFile = process.argv[1];
const isDirectExecution =
  entryFile !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(entryFile);

if (isDirectExecution) {
  await runServer({
    environment: process.env,
    startListening: async (port) => {
      // 必须在配置通过后才构建并监听，确保 Secret 缺失时无网络副作用。
      const server = buildServer();

      await server.listen({ host: "0.0.0.0", port });
    },
    writeError: (message) => process.stderr.write(message),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  });
}
