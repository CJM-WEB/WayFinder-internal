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
  createMemoryCachedSearchProvider,
  DEFAULT_SEARCH_CACHE_MAX_ENTRIES,
  SEARCH_CACHE_MAX_ENTRY_SIZE_BYTES,
  SEARCH_CACHE_MAX_SIZE_BYTES,
  SEARCH_CACHE_TTL_MS,
} from "./search/memory-cached-provider.js";
export type {
  MemoryCachedSearchProviderOptions,
  SearchProviderCacheObservation,
} from "./search/memory-cached-provider.js";
export {
  SerpApiBingProviderError,
  SerpApiBingSearchProvider,
} from "./search/providers/serpapi-bing.js";
export type {
  SerpApiBingAttemptObservation,
  SerpApiBingSearchProviderOptions,
} from "./search/providers/serpapi-bing.js";
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
export { registerSearchRoute } from "./routes/search.js";
export type {
  SearchStreamHandler,
  SearchStreamHandlerInput,
} from "./routes/search.js";
export { createRunEventWriter } from "./streaming/run-event-writer.js";
export type {
  CreateRunEventWriterInput,
  RunEventWriter,
} from "./streaming/run-event-writer.js";
export { emitValidatedPlanEvents } from "./orchestrator/emit-validated-plan-events.js";
export type { EmitValidatedPlanEventsInput } from "./orchestrator/emit-validated-plan-events.js";
export {
  createRunTerminalEventState,
  emitRunFailedWithoutGraphPlan,
} from "./orchestrator/run-terminal-events.js";
export type {
  CompleteRunWithTerminalEventsInput,
  CreateRunTerminalEventStateInput,
  EmitRunFailedWithoutGraphPlanInput,
  RunTerminalEventState,
} from "./orchestrator/run-terminal-events.js";
export { createRunSearchHandler } from "./orchestrator/run-search.js";
export type { CreateRunSearchHandlerInput } from "./orchestrator/run-search.js";
export {
  createLocalRunLogSink,
  RUN_LOG_RELATIVE_DIRECTORY,
} from "./observability/local-run-log-writer.js";
export {
  createRunLogRecorder,
  RunLogRecordSchema,
} from "./observability/run-log.js";
export type {
  CreateRunLogRecorderInput,
  RunLogRecord,
  RunLogRecorder,
  RunLogSink,
  RunPlanningStage,
  RunProviderOperation,
} from "./observability/run-log.js";
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
export {
  GraphOutlineSchema,
  GraphOutlineValidationError,
  parseGraphOutlineOutput,
} from "./ai/graph-outline.js";
export type {
  GraphOutline,
  GraphOutlineNode,
  GraphOutlineValidationDiagnostic,
  GraphOutlineValidationIssueDiagnostic,
} from "./ai/graph-outline.js";
export {
  GraphPlannerError,
  planGraphOutline,
} from "./ai/graph-planner.js";
export type {
  GraphPlannerErrorKind,
  PlanGraphOutlineInput,
} from "./ai/graph-planner.js";
export {
  GRAPH_REVISER_MAX_DOMAIN_CODE_POINTS,
  GRAPH_REVISER_MAX_EVIDENCE_QUERY_CODE_POINTS,
  GRAPH_REVISER_MAX_PAYLOAD_CODE_POINTS,
  GRAPH_REVISER_MAX_PUBLISHED_AT_CODE_POINTS,
  GRAPH_REVISER_MAX_SNIPPET_CODE_POINTS,
  GRAPH_REVISER_MAX_TITLE_CODE_POINTS,
  GraphRevisionError,
  reviseGraphOutline,
} from "./ai/graph-reviser.js";
export type {
  GraphRevisionErrorKind,
  GraphRevisionValidationDiagnostic,
  ReviseGraphOutlineInput,
} from "./ai/graph-reviser.js";
export {
  SearchPlanBundleSchema,
  SearchPlanGenerationError,
  assembleGraphPlan,
  generateSearchPlanBundle,
  normalizeSearchPlanQueryKey,
} from "./ai/search-plan-generator.js";
export type {
  GenerateSearchPlanBundleInput,
  SearchPlanBundle,
  SearchPlanBundleValidationDiagnostic,
  SearchPlanGenerationErrorKind,
} from "./ai/search-plan-generator.js";
export {
  DEEPSEEK_LLM_MODEL,
  DEEPSEEK_LLM_PROVIDER_ID,
  DEEPSEEK_RESPONSES_BASE_URL,
  DeepSeekLLMProvider,
} from "./ai/providers/deepseek-llm-provider.js";
export type {
  DeepSeekLLMProviderOptions,
  DeepSeekTokenUsage,
} from "./ai/providers/deepseek-llm-provider.js";
