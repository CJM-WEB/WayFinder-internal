/**
 * 测试职责：冻结 WAY-28 的环境配置边界，覆盖默认值、数值上限、
 * Provider/Model（提供方/模型）白名单、环境文档 Drift 与 Secret（密钥）脱敏失败路径。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  RUN_DEADLINE_MS,
  SERVER_ENVIRONMENT_VARIABLES,
  ServerConfigError,
  parseServerConfig,
} from "./config.js";

const ENV_EXAMPLE_PATH = fileURLToPath(
  new URL("../../../.env.example", import.meta.url),
);

const REQUIRED_ENVIRONMENT = {
  LLM_PROVIDER: "deepseek",
  LLM_MODEL: "deepseek-flash",
  LLM_API_KEY: "test-llm-key",
  SERPAPI_API_KEY: "test-serpapi-key",
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
      serpApiKey: "test-serpapi-key",
      experienceConfigPath: null,
      publicOrigin: null,
      timeouts: {
        searchMs: 16_000,
        plannerMs: 30_000,
        rerankMs: 24_000,
      },
      concurrency: {
        search: 6,
        llm: 3,
      },
      runDeadlineMs: RUN_DEADLINE_MS,
      runLogging: false,
    });
    expect(RUN_DEADLINE_MS).toBe(40_000);
  });

  it("只接受严格 Run Log 布尔值，并保持共享部署默认关闭", () => {
    expect(
      parseServerConfig({
        ...REQUIRED_ENVIRONMENT,
        RUN_LOGGING: "true",
      }).runLogging,
    ).toBe(true);

    const error = expectConfigError({
      ...REQUIRED_ENVIRONMENT,
      RUN_LOGGING: "TRUE",
    });
    expect(error.fields).toContain("RUN_LOGGING");
  });

  it("可信站点只接受 HTTPS 或规范 HTTP 回环纯 Origin，不接受转发或路径猜测", () => {
    for (const [input, expected] of [
      ["https://wayfinder.example/", "https://wayfinder.example"],
      ["http://localhost:5173", "http://localhost:5173"],
      ["http://127.0.0.1:3000/", "http://127.0.0.1:3000"],
      ["http://[::1]:3000", "http://[::1]:3000"],
    ]) expect(parseServerConfig({ ...REQUIRED_ENVIRONMENT, PUBLIC_ORIGIN: input }).publicOrigin).toBe(expected);
    for (const PUBLIC_ORIGIN of [
      "http://wayfinder.example", "https://name:secret@wayfinder.example", "https://wayfinder.example/path",
      "https://wayfinder.example?query", "https://wayfinder.example#hash", "https://wayfinder.example\n",
      "http://localhost.evil", "http://127.1", "http://2130706433", "https://wayfinder.example\\path",
    ]) expect(expectConfigError({ ...REQUIRED_ENVIRONMENT, PUBLIC_ORIGIN }).fields).toContain("PUBLIC_ORIGIN");
  });

  it("要求 .env.example 与运行时白名单完全一致且 Secret 示例为空", () => {
    const assignments = readFileSync(ENV_EXAMPLE_PATH, "utf8")
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith("#"))
      .map(line => {
        const separator = line.indexOf("=");
        if (separator < 1) throw new Error(".env.example 包含非法赋值行");
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      });
    const names = assignments.map(([name]) => name);

    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(SERVER_ENVIRONMENT_VARIABLES);
    expect(Object.fromEntries(assignments)).toMatchObject({
      LLM_API_KEY: "",
      SERPAPI_API_KEY: "",
      RUN_LOGGING: "false",
    });
  });

  it("接受全部数值字段的已批准边界", () => {
    const config = parseServerConfig({
      ...REQUIRED_ENVIRONMENT,
      PORT: "65535",
      SEARCH_TIMEOUT_MS: "40000",
      PLANNER_TIMEOUT_MS: "30000",
      RERANK_TIMEOUT_MS: "30000",
      SEARCH_CONCURRENCY: "1",
      LLM_CONCURRENCY: "1",
    });

    expect(config.port).toBe(65_535);
    expect(config.timeouts).toEqual({
      searchMs: 40_000,
      plannerMs: 30_000,
      rerankMs: 30_000,
    });
    expect(config.concurrency).toEqual({ search: 1, llm: 1 });
  });

  it.each([
    ["PORT", "0"],
    ["PORT", "65536"],
    ["PORT", "3000.5"],
    ["SEARCH_TIMEOUT_MS", "0"],
    ["SEARCH_TIMEOUT_MS", "40001"],
    ["PLANNER_TIMEOUT_MS", "30001"],
    ["RERANK_TIMEOUT_MS", "30001"],
    ["RERANK_TIMEOUT_MS", "NaN"],
    ["SEARCH_CONCURRENCY", "7"],
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

  it.each(["LLM_API_KEY", "SERPAPI_API_KEY"] as const)(
    "%s 缺失或仅含空白时快速失败，且错误不包含任何 Secret 值",
    (missingSecret) => {
      const secretSentinel = "never-print-this-secret";
      const error = expectConfigError({
        ...REQUIRED_ENVIRONMENT,
        LLM_API_KEY: secretSentinel,
        SERPAPI_API_KEY: secretSentinel,
        [missingSecret]: "   ",
      });

      expect(error.fields).toContain(missingSecret);
      expect(error.message).not.toContain(secretSentinel);
    },
  );
});
