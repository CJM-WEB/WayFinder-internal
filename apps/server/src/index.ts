/**
 * 模块职责：暴露无启动副作用的 Server 公共构建能力。
 *
 * 构建流程会动态导入本入口，因此这里不能读取环境变量、校验 Secret、
 * 监听端口或输出日志；真实进程入口固定为 `main.ts`。
 */
export { buildServer } from "./app.js";
export {
  RUN_DEADLINE_MS,
  ServerConfigError,
  parseServerConfig,
} from "./config.js";
export type { ServerConfig } from "./config.js";
export type { SearchProvider } from "./search/provider.js";
export {
  TavilyProviderError,
  TavilySearchProvider,
} from "./search/providers/tavily.js";
export type {
  TavilySearchProviderOptions,
} from "./search/providers/tavily.js";
export {
  selectSearchProvider,
} from "./search/router.js";
export type {
  SelectSearchProviderInput,
} from "./search/router.js";
