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
export {
  NodeSearchError,
  runNodeSearches,
} from "./search/run-node-searches.js";
export type {
  RunNodeSearchesInput,
} from "./search/run-node-searches.js";
export {
  BROAD_DISCOVERY_RESULTS_PER_QUERY,
  BroadDiscoveryError,
  discoverBroadEvidence,
} from "./search/broad-discovery.js";
export type {
  DiscoverBroadEvidenceInput,
  EvidenceAssistedAnalysis,
} from "./search/broad-discovery.js";
export {
  assertBoundedLLMTimeout,
  LLMProviderError,
  MAX_LLM_CALL_TIMEOUT_MS,
} from "./ai/llm-provider.js";
export type {
  LLMCallOptions,
  LLMProvider,
  LLMProviderErrorKind,
  StructuredLLMInput,
} from "./ai/llm-provider.js";
export {
  GraphPlanValidationError,
  MAX_GRAPH_PLAN_VALIDATION_ISSUES,
  MAX_GRAPH_PLAN_VALIDATION_PATH_SEGMENT_LENGTH,
  MAX_GRAPH_PLAN_VALIDATION_PATH_SEGMENTS,
  parseGraphPlanOutput,
} from "./ai/graph-plan-parser.js";
export type {
  GraphPlanValidationDiagnostic,
  GraphPlanValidationIssueDiagnostic,
} from "./ai/graph-plan-parser.js";
export { planOrCompactFallback } from "./ai/graph-planner.js";
export type { PlanOrCompactFallbackInput } from "./ai/graph-planner.js";
export {
  DEEPSEEK_LLM_MODEL,
  DEEPSEEK_LLM_PROVIDER_ID,
  DEEPSEEK_RESPONSES_BASE_URL,
  DeepSeekLLMProvider,
} from "./ai/providers/deepseek-llm-provider.js";
export type {
  DeepSeekLLMProviderOptions,
} from "./ai/providers/deepseek-llm-provider.js";
