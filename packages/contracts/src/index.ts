/**
 * 模块职责：提供 WAY-16 所需的最小可编译入口。
 *
 * 关键约束：
 * - 本标识没有产品或 Contract（协议）语义，不能被当作公共协议扩展。
 * - WAY-17 引入真实 Contract 导出时，应删除本标识及对应 smoke test。
 */
export const workspaceId = "@wayfinder/contracts" as const;
