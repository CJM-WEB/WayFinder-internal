/**
 * 模块职责：组装唯一生产 Fastify 实例、进程级 Provider 装饰器与 Search Handler。
 *
 * 边界说明：公共 Contract、Prompt、Ranking 与 Streaming Route 均在既有模块中冻结；
 * 本模块只连接依赖。测试可以注入 Fake Provider，但不存在可被生产误启用的 Fake 环境开关。
 */
import type { FastifyInstance } from "fastify";

import { DeepSeekLLMProvider } from "./ai/providers/deepseek-llm-provider.js";
import { buildServer } from "./app.js";
import type { ServerConfig } from "./config.js";
import { createLocalRunLogSink } from "./observability/local-run-log-writer.js";
import { createConcurrencyLimitedProviders } from "./orchestrator/provider-concurrency.js";
import { createRunSearchHandler } from "./orchestrator/run-search.js";
import { registerSearchRoute } from "./routes/search.js";
import { createMemoryCachedSearchProvider } from "./search/memory-cached-provider.js";
import type { SearchProvider } from "./search/provider.js";
import { SerpApiBingSearchProvider } from "./search/providers/serpapi-bing.js";
import type { LLMProvider } from "./ai/llm-provider.js";
import { registerWebAssets } from "./web-assets.js";

export type ProductionBaseProviders = Readonly<{
  searchProvider: SearchProvider;
  llmProvider: LLMProvider;
}>;

export type BuildProductionServerInput = Readonly<{
  config: ServerConfig;
  repositoryRoot: string;
  webAssetsDirectory: string;
  /** 仅作为确定性测试接缝；真实进程始终省略并创建正式 Adapter。 */
  baseProviders?: ProductionBaseProviders;
}>;

function createBaseProviders(config: ServerConfig): ProductionBaseProviders {
  return {
    searchProvider: new SerpApiBingSearchProvider({
      apiKey: config.serpApiKey,
      searchTimeoutMs: config.timeouts.searchMs,
    }),
    llmProvider: new DeepSeekLLMProvider({ apiKey: config.llmApiKey }),
  };
}

/** 创建单个可监听实例；Provider、Cache 与并发队列均只在此处创建一次。 */
export async function buildProductionServer(
  input: BuildProductionServerInput,
): Promise<FastifyInstance> {
  const baseProviders = input.baseProviders ?? createBaseProviders(input.config);
  const limitedProviders = createConcurrencyLimitedProviders({
    ...baseProviders,
    concurrency: input.config.concurrency,
  });
  // Cache 位于并发装饰器外层，使命中缓存时不会占用真实 Provider 槽位。
  const providers = {
    searchProvider: createMemoryCachedSearchProvider(
      limitedProviders.searchProvider,
    ),
    llmProvider: limitedProviders.llmProvider,
  };
  const runLogSink = input.config.runLogging
    ? createLocalRunLogSink({
        repositoryRoot: input.repositoryRoot,
        enabled: true,
      })
    : undefined;
  const server = buildServer();

  registerSearchRoute(
    server,
    createRunSearchHandler({
      providers,
      officialSourcePolicy: { knownRiskyDownloadDomains: [] },
      llmStageTimeoutMs: input.config.timeouts.plannerMs,
      rerankTimeoutMs: input.config.timeouts.rerankMs,
      normalizeQuery: query => query.normalize("NFKC").trim().toLowerCase(),
      onPlannerValidationDiagnostic: () => undefined,
      onRevisionValidationDiagnostic: () => undefined,
      onSearchPlanValidationDiagnostic: () => undefined,
      ...(runLogSink === undefined ? {} : { runLogSink }),
    }),
  );
  await registerWebAssets(server, input.webAssetsDirectory);

  return server;
}
