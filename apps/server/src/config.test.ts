/**
 * 测试职责：冻结 WAY-28 的环境配置边界，覆盖默认值、数值上限、
 * Provider/Model（提供方/模型）白名单与 Secret（密钥）脱敏失败路径。
 */
import { describe, expect, it } from "vitest";

import {
  RUN_DEADLINE_MS,
  ServerConfigError,
  parseServerConfig,
} from "./config.js";

const REQUIRED_ENVIRONMENT = {
  LLM_PROVIDER: "deepseek",
  LLM_MODEL: "deepseek-flash",
  LLM_API_KEY: "test-llm-key",
  TAVILY_API_KEY: "test-tavily-key",
} as const;

function expectConfigError(
  environment: Readonly<Record<string, string | undefined>>,
): ServerConfigError {
  try {
    parseServerConfig(environment);
  } catch (error: unknown) {
    if (error instanceof ServerConfigError) {
      return error;
    }

    throw error;
  }

  throw new Error("预期环境配置校验失败，但解析成功");
}

describe("parseServerConfig", () => {
  it("为端口、调用超时和并发限制提供已批准的安全默认值", () => {
    const config = parseServerConfig(REQUIRED_ENVIRONMENT);

    expect(config).toEqual({
      port: 3000,
      llmProvider: "deepseek",
      llmModel: "deepseek-flash",
      llmApiKey: "test-llm-key",
      tavilyApiKey: "test-tavily-key",
      timeouts: {
        searchMs: 8_000,
        extractMs: 10_000,
        plannerMs: 15_000,
        rerankMs: 12_000,
      },
      concurrency: {
        search: 6,
        extract: 3,
        llm: 3,
      },
      runDeadlineMs: RUN_DEADLINE_MS,
    });
    expect(RUN_DEADLINE_MS).toBe(20_000);
  });

  it("接受全部数值字段的已批准边界", () => {
    const config = parseServerConfig({
      ...REQUIRED_ENVIRONMENT,
      PORT: "65535",
      SEARCH_TIMEOUT_MS: "20000",
      EXTRACT_TIMEOUT_MS: "20000",
      PLANNER_TIMEOUT_MS: "15000",
      RERANK_TIMEOUT_MS: "15000",
      SEARCH_CONCURRENCY: "1",
      EXTRACT_CONCURRENCY: "1",
      LLM_CONCURRENCY: "1",
    });

    expect(config.port).toBe(65_535);
    expect(config.timeouts).toEqual({
      searchMs: 20_000,
      extractMs: 20_000,
      plannerMs: 15_000,
      rerankMs: 15_000,
    });
    expect(config.concurrency).toEqual({ search: 1, extract: 1, llm: 1 });
  });

  it.each([
    ["PORT", "0"],
    ["PORT", "65536"],
    ["PORT", "3000.5"],
    ["SEARCH_TIMEOUT_MS", "0"],
    ["EXTRACT_TIMEOUT_MS", "20001"],
    ["PLANNER_TIMEOUT_MS", "15001"],
    ["RERANK_TIMEOUT_MS", "15001"],
    ["RERANK_TIMEOUT_MS", "NaN"],
    ["SEARCH_CONCURRENCY", "7"],
    ["EXTRACT_CONCURRENCY", "4"],
    ["LLM_CONCURRENCY", "4"],
  ])("拒绝越界或非整数配置 %s=%s", (field, value) => {
    const error = expectConfigError({
      ...REQUIRED_ENVIRONMENT,
      [field]: value,
    });

    expect(error.fields).toContain(field);
  });

  it.each([
    ["LLM_PROVIDER", "openai"],
    ["LLM_PROVIDER", "unknown"],
    ["LLM_MODEL", "gpt-6-luna"],
    ["LLM_MODEL", "unknown"],
  ])("拒绝未经资格验证的 Provider/Model 组合：%s=%s", (field, value) => {
    const error = expectConfigError({
      ...REQUIRED_ENVIRONMENT,
      [field]: value,
    });

    expect(error.fields).toContain(field);
  });

  it.each(["LLM_API_KEY", "TAVILY_API_KEY"] as const)(
    "%s 缺失或仅含空白时快速失败，且错误不包含任何 Secret 值",
    (missingSecret) => {
      const secretSentinel = "never-print-this-secret";
      const error = expectConfigError({
        ...REQUIRED_ENVIRONMENT,
        LLM_API_KEY: secretSentinel,
        TAVILY_API_KEY: secretSentinel,
        [missingSecret]: "   ",
      });

      expect(error.fields).toContain(missingSecret);
      expect(error.message).not.toContain(secretSentinel);
    },
  );
});
