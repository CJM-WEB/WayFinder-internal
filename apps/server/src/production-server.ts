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
import { createConcurrencyLimitedProviders, createProviderConcurrencyQueues } from "./orchestrator/provider-concurrency.js";
import { createRunSearchHandler } from "./orchestrator/run-search.js";
import { registerSearchRoute } from "./routes/search.js";
import { registerExperienceRoutes } from "./routes/experience.js";
import { createMemoryCachedSearchProvider, createSearchResultCache } from "./search/memory-cached-provider.js";
import type { SearchProvider } from "./search/provider.js";
import { SerpApiBingSearchProvider } from "./search/providers/serpapi-bing.js";
import type { LLMProvider } from "./ai/llm-provider.js";
import { registerWebAssets } from "./web-assets.js";
import { prepareSearchCredentialScope, type EffectiveProviderKeys } from "./settings/search-credentials.js";
import { assertPrivateConfigLocation } from "./settings/private-config-location.js";
import { callAuthorizedLLM } from "./settings/authorized-llm-call.js";
import type { AccountRuntime } from "./accounts/account-runtime.js";
import { createAbsoluteRunDeadline } from "./orchestrator/absolute-run-deadline.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerWorkspaceRoutes } from "./routes/workspace.js";
import { registerAccountKeyRoutes } from "./routes/account-keys.js";

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
  /** 仅作为确定性测试接缝，验证不同请求实际解析出的 Key；没有生产环境开关。 */
  providerFactory?: (keys: EffectiveProviderKeys, beforeSearchAttempt: (signal: AbortSignal) => Promise<void>) => ProductionBaseProviders;
  /** 仅由显式启动工厂提供；未配置时账号路由失败闭合，不隐式连接数据库。 */
  accounts?: Readonly<{ auth: AccountRuntime["auth"]; database: Pick<AccountRuntime["database"], "close">; workspace?: AccountRuntime["workspace"]; keys?: AccountRuntime["keys"] }>;
}>;

function createBaseProviders(
  config: ServerConfig,
  keys: EffectiveProviderKeys,
  beforeSearchAttempt: (signal: AbortSignal) => Promise<void>,
): ProductionBaseProviders {
  return {
    searchProvider: new SerpApiBingSearchProvider({
      apiKey: keys.serpApiKey,
      searchTimeoutMs: config.timeouts.searchMs,
      beforeAttempt: beforeSearchAttempt,
    }),
    llmProvider: new DeepSeekLLMProvider({ apiKey: keys.llmApiKey }),
  };
}

/** 创建单个可监听实例；只有有界缓存与总并发队列跨请求共享，用户 Adapter 不进入注册表。 */
export async function buildProductionServer(
  input: BuildProductionServerInput,
): Promise<FastifyInstance> {
  await assertPrivateConfigLocation(input.config.experienceConfigPath, input.webAssetsDirectory);
  const queues = createProviderConcurrencyQueues(input.config.concurrency);
  const authorCache = createSearchResultCache();
  const runLogSink = input.config.runLogging
    ? createLocalRunLogSink({
        repositoryRoot: input.repositoryRoot,
        enabled: true,
      })
    : undefined;
  const server = buildServer();

  registerAccountRoutes(server, { auth: input.accounts?.auth ?? null, publicOrigin: input.config.publicOrigin });
  registerWorkspaceRoutes(server, { auth: input.accounts?.auth ?? null, storage: input.accounts?.workspace ?? null,
    publicOrigin: input.config.publicOrigin });
  registerAccountKeyRoutes(server, { auth: input.accounts?.auth ?? null, storage: input.accounts?.keys ?? null,
    publicOrigin: input.config.publicOrigin });
  if (input.accounts !== undefined) {
    server.addHook("onClose", async () => { await input.accounts?.database.close(); });
  }

  registerExperienceRoutes(server, {
    configPath: input.config.experienceConfigPath,
    publicOrigin: input.config.publicOrigin,
    auth: input.accounts?.auth ?? null,
  });

  registerSearchRoute(
    server,
    { prepare: async (request, connectionSignal) => {
      const fatalController = new AbortController();
      const runScope = createAbsoluteRunDeadline({ parentSignal: AbortSignal.any([connectionSignal, fatalController.signal]) });
      try {
        const scope = await prepareSearchCredentialScope(request, input.config, runScope.signal,
          input.accounts?.auth ?? null, runScope.deadlineAt, input.accounts?.keys ?? null, runScope.requirePositiveRemainingMs);
        const beforeSearchAttempt = (signal: AbortSignal) => scope.assertService("serpapi", signal);
        const base = input.providerFactory?.(scope.keys, beforeSearchAttempt) ?? input.baseProviders
          ?? createBaseProviders(input.config, scope.keys, beforeSearchAttempt);
        connectionSignal.throwIfAborted();
        // 此层位于共享队列内部，实际取得槽位后才复核，不让排队时已撤销的请求花费作者额度。
        const guardedBase: ProductionBaseProviders = {
          searchProvider: {
            id: base.searchProvider.id, capabilities: [...base.searchProvider.capabilities],
            search: async (searchRequest, signal) => {
              await scope.assertService("serpapi", signal);
              const result = await base.searchProvider.search(searchRequest, signal);
              await scope.assertService("serpapi", signal);
              return result;
            },
          },
          llmProvider: {
            id: base.llmProvider.id,
            structured: (structuredInput, options) => callAuthorizedLLM(
              base.llmProvider, structuredInput, options, signal => scope.assertService("deepseek", signal),
            ),
          },
        };
        const limited = createConcurrencyLimitedProviders({
          ...guardedBase, concurrency: input.config.concurrency, queues,
        });
        // 作者共用一个有界池并按代际隔离；自带只在本次运行内缓存，不跨用户保存 Key 或结果。
        const cachedSearch = createMemoryCachedSearchProvider(limited.searchProvider,
          scope.credentials.serpapi.source === "author" && scope.authorGeneration !== null
            ? { sharedCache: authorCache, namespace: scope.authorGeneration } : {});
        const providers = {
          ...limited,
          searchProvider: {
            id: cachedSearch.id, capabilities: [...cachedSearch.capabilities],
            search: async (searchRequest: Parameters<SearchProvider["search"]>[0], signal: AbortSignal) => {
              await scope.assertService("serpapi", signal);
              const result = await cachedSearch.search(searchRequest, signal);
              await scope.assertService("serpapi", signal);
              return result;
            },
          },
        };
        const handle = createRunSearchHandler({
          runContext: { scope: runScope, fatalController },
          providers,
          officialSourcePolicy: { knownRiskyDownloadDomains: [] },
          llmStageTimeoutMs: input.config.timeouts.plannerMs,
          rerankTimeoutMs: input.config.timeouts.rerankMs,
          normalizeQuery: query => query.normalize("NFKC").trim().toLowerCase(),
          onPlannerValidationDiagnostic: () => undefined,
          onRevisionValidationDiagnostic: () => undefined,
          onSearchPlanValidationDiagnostic: () => undefined,
          ...(runLogSink === undefined ? {} : { runLogSink }),
        });
        return searchInput => handle({
          ...searchInput, signal: AbortSignal.any([searchInput.signal, scope.signal]),
        });
      } catch (error: unknown) { runScope.dispose(); throw error; }
    } },
  );
  await registerWebAssets(server, input.webAssetsDirectory);

  return server;
}
