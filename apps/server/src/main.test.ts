/**
 * 测试职责：冻结启动组合根的副作用顺序与脱敏失败路径，证明配置通过前
 * 不会监听端口，失败会设置退出码，并且未知 Error 不能伪装成配置错误。
 */
import { describe, expect, it, vi } from "vitest";

import { runServer, type ServerRuntime } from "./main.js";

const REQUIRED_ENVIRONMENT = {
  LLM_PROVIDER: "deepseek",
  LLM_MODEL: "deepseek-flash",
  LLM_API_KEY: "test-llm-key",
  TAVILY_API_KEY: "test-tavily-key",
} as const;

function createRuntime(
  environment: Readonly<Record<string, string | undefined>>,
): ServerRuntime {
  return {
    environment,
    startListening: vi.fn(async () => undefined),
    writeError: vi.fn(),
    setExitCode: vi.fn(),
  };
}

describe("runServer", () => {
  it("配置通过后才把完整已校验配置交给唯一启动回调", async () => {
    const runtime = createRuntime({ ...REQUIRED_ENVIRONMENT, PORT: "4321" });

    await runServer(runtime);

    expect(runtime.startListening).toHaveBeenCalledOnce();
    expect(runtime.startListening).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 4_321,
        llmApiKey: "test-llm-key",
        tavilyApiKey: "test-tavily-key",
        runLogging: false,
      }),
    );
    expect(runtime.writeError).not.toHaveBeenCalled();
    expect(runtime.setExitCode).not.toHaveBeenCalled();
  });

  it.each(["LLM_API_KEY", "TAVILY_API_KEY"] as const)(
    "%s 缺失时不监听，并以脱敏错误和失败退出码快速终止",
    async (missingSecret) => {
      const secretSentinel = "never-print-this-secret";
      const environment = {
        ...REQUIRED_ENVIRONMENT,
        LLM_API_KEY: secretSentinel,
        TAVILY_API_KEY: secretSentinel,
        [missingSecret]: "   ",
      };
      const runtime = createRuntime(environment);

      await runServer(runtime);

      expect(runtime.startListening).not.toHaveBeenCalled();
      expect(runtime.setExitCode).toHaveBeenCalledExactlyOnceWith(1);
      expect(runtime.writeError).toHaveBeenCalledOnce();
      expect(runtime.writeError).toHaveBeenCalledWith(
        expect.stringContaining(missingSecret),
      );
      expect(runtime.writeError).not.toHaveBeenCalledWith(
        expect.stringContaining(secretSentinel),
      );
    },
  );

  it("未知错误即使伪造配置错误名称，也只能输出固定脱敏文案", async () => {
    const secretSentinel = "forged-error-secret";
    const forgedError = new Error(secretSentinel);
    forgedError.name = "ServerConfigError";
    const runtime = createRuntime(REQUIRED_ENVIRONMENT);
    vi.mocked(runtime.startListening).mockRejectedValueOnce(forgedError);

    await runServer(runtime);

    expect(runtime.writeError).toHaveBeenCalledWith(
      "Server 启动失败，请检查端口与运行环境\n",
    );
    expect(runtime.writeError).not.toHaveBeenCalledWith(
      expect.stringContaining(secretSentinel),
    );
    expect(runtime.setExitCode).toHaveBeenCalledExactlyOnceWith(1);
  });
});
