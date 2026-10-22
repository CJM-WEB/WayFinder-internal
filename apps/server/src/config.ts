/**
 * 模块职责：把不可信环境变量收窄为 Server 内部可安全使用的只读配置。
 *
 * 关键约束：
 * - Provider/Model（提供方/模型）仅接受已经完成资格验证的组合。
 * - Secret（密钥）在真实启动前必须存在，但任何失败信息都不得包含其值。
 * - 单次调用 Timeout（超时）不能突破 20 秒全局 Run Deadline（运行截止时间）。
 * - 并发上限只允许向下调整，避免通过部署配置绕过 V0 已批准边界。
 */
import { z } from "zod";

import { MAX_LLM_CALL_TIMEOUT_MS } from "./ai/llm-provider.js";

export const RUN_DEADLINE_MS = 20_000 as const;
export const MAX_SEARCH_CONCURRENCY = 6 as const;
export const MAX_EXTRACT_CONCURRENCY = 3 as const;
export const MAX_LLM_CONCURRENCY = 3 as const;

/**
 * 环境变量天然是字符串；先拒绝小数、符号与科学计数法，再转换为数字，
 * 避免 `Number("") === 0` 等宽松转换把错误部署配置静默接受。
 */
function boundedInteger(
  defaultValue: number,
  maximum: number,
) {
  return z
    .string()
    .regex(/^[1-9]\d*$/)
    .default(String(defaultValue))
    .transform((value: string) => Number.parseInt(value, 10))
    .pipe(z.number().int().min(1).max(maximum));
}

const EnvironmentSchema = z
  .object({
    PORT: boundedInteger(3_000, 65_535),
    LLM_PROVIDER: z.literal("deepseek"),
    LLM_MODEL: z.literal("deepseek-flash"),
    LLM_API_KEY: z.string().trim().min(1),
    TAVILY_API_KEY: z.string().trim().min(1),
    SEARCH_TIMEOUT_MS: boundedInteger(8_000, RUN_DEADLINE_MS),
    EXTRACT_TIMEOUT_MS: boundedInteger(10_000, RUN_DEADLINE_MS),
    PLANNER_TIMEOUT_MS: boundedInteger(
      MAX_LLM_CALL_TIMEOUT_MS,
      MAX_LLM_CALL_TIMEOUT_MS,
    ),
    // 所有 Structured Output 共用 15 秒硬上限，配置不能制造运行时必然失败值。
    RERANK_TIMEOUT_MS: boundedInteger(12_000, MAX_LLM_CALL_TIMEOUT_MS),
    SEARCH_CONCURRENCY: boundedInteger(
      MAX_SEARCH_CONCURRENCY,
      MAX_SEARCH_CONCURRENCY,
    ),
    EXTRACT_CONCURRENCY: boundedInteger(
      MAX_EXTRACT_CONCURRENCY,
      MAX_EXTRACT_CONCURRENCY,
    ),
    LLM_CONCURRENCY: boundedInteger(
      MAX_LLM_CONCURRENCY,
      MAX_LLM_CONCURRENCY,
    ),
  })
  // `process.env` 包含操作系统与工具链变量；这里只投影应用明确声明的字段。
  .strip()
  .transform((environment) => ({
    port: environment.PORT,
    llmProvider: environment.LLM_PROVIDER,
    llmModel: environment.LLM_MODEL,
    llmApiKey: environment.LLM_API_KEY,
    tavilyApiKey: environment.TAVILY_API_KEY,
    timeouts: {
      searchMs: environment.SEARCH_TIMEOUT_MS,
      extractMs: environment.EXTRACT_TIMEOUT_MS,
      plannerMs: environment.PLANNER_TIMEOUT_MS,
      rerankMs: environment.RERANK_TIMEOUT_MS,
    },
    concurrency: {
      search: environment.SEARCH_CONCURRENCY,
      extract: environment.EXTRACT_CONCURRENCY,
      llm: environment.LLM_CONCURRENCY,
    },
    runDeadlineMs: RUN_DEADLINE_MS,
  }));

export type ServerConfig = Readonly<z.infer<typeof EnvironmentSchema>>;

/**
 * 配置错误只暴露字段名，绝不保存原始环境对象或失败值，防止 Secret
 * 通过 Error、日志序列化或测试快照间接泄露。
 */
export class ServerConfigError extends Error {
  public readonly fields: readonly string[];

  public constructor(fields: readonly string[]) {
    super(`环境配置无效：${fields.join(", ")}`);
    this.name = "ServerConfigError";
    this.fields = Object.freeze([...fields]);
  }
}

export function parseServerConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ServerConfig {
  const result = EnvironmentSchema.safeParse(environment);

  if (result.success) {
    return result.data;
  }

  const fields = [
    ...new Set(
      result.error.issues.map((issue) =>
        String(issue.path[0] ?? "environment"),
      ),
    ),
  ];

  throw new ServerConfigError(fields);
}
