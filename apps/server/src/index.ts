/**
 * 模块职责：提供 WAY-16 所需的最小可编译入口。
 *
 * 关键约束：
 * - 本标识没有 API、路由或 Provider（提供方）语义，也不是服务启动入口。
 * - WAY-28 建立真实 Fastify 入口时，应删除本标识及对应 smoke test。
 */
export const workspaceId = "@wayfinder/server" as const;
