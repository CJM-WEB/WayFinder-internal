/**
 * 模块职责：提供 WAY-16 所需的最小可编译入口。
 *
 * 关键约束：
 * - 本标识没有 UI 或产品行为语义，也不是浏览器启动入口。
 * - WAY-27 建立真实 React/Vite 入口时，应删除本标识及对应 smoke test。
 */
export const workspaceId = "@wayfinder/web" as const;
