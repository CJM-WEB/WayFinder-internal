/**
 * 类型边界：Better Auth 无条件引用可选的 Bun 数据库类型，但本服务只运行 Node 24／MySQL。
 * never 明确禁止配置不受支持的 Bun 数据库，不提供运行时替身，也不放宽其他库的类型检查。
 */
declare module "bun:sqlite" {
  export type Database = never;
}
