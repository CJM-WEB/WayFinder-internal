/**
 * 模块职责：构建 Fastify 应用并注册不依赖外部 Provider（提供方）的基础路由。
 *
 * `buildServer` 不读取环境变量、不监听端口，也不记录配置；调用方可安全地用
 * Fastify Inject（请求注入）测试路由，真实监听只允许在 `main.ts` 组合根发生。
 */
import Fastify, { type FastifyInstance } from "fastify";

const HEALTH_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", const: "ok" },
  },
} as const;

export function buildServer(options: Readonly<{ trustLocalProxy?: boolean }> = {}): FastifyInstance {
  // HTTP Logger 保持关闭；脱敏 Run Log 由生产组合根按显式开关独立注入。
  const server = Fastify({ logger: false,
    // 仅生产组合根启用同机Nginx；同时校验回环地址与第一跳，不能只按跳数信任外部转发链。
    trustProxy: options.trustLocalProxy === true
      ? (address, hop) => address === "127.0.0.1" && hop === 0 : false,
  });

  server.get(
    "/health",
    {
      schema: {
        response: { 200: HEALTH_RESPONSE_SCHEMA },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  return server;
}
