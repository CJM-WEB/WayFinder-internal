/** 云Key撤销以Run冻结服务为准；未使用云Key的请求/预览不受修改无关Key影响。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUD_ACCOUNT_HEADER, StreamEventSchema, type SearchCredentials } from "@wayfinder/contracts";
import { accountStore } from "../stores/account.js";
import { accountKeysStore } from "../stores/account-keys.js";
import { createGraphStore } from "../stores/graph-store.js";
import { createWorkspaceStore, fromResultGraph } from "../stores/workspace-store.js";
import { pythonResultGraphFixture } from "../fixtures/python-result-graph.js";
import { createPythonMockStream } from "../testing/python-mock-stream.js";
import { createStartStreamingSearch } from "./search.js";
import { createResearchStore } from "./research.js";

const initial = accountStore.getState(), keys = accountKeysStore.getState();
afterEach(() => { accountStore.setState(initial); accountKeysStore.setState(keys); vi.restoreAllMocks(); });
const own: SearchCredentials = { deepseek: { source: "own", apiKey: "fixture-own-llm" }, serpapi: { source: "own", apiKey: "fixture-own-search" } };
const cloud: SearchCredentials = { deepseek: { source: "cloud" }, serpapi: own.serpapi };
const login = () => accountStore.setState({ account: { userId: "fixture-A", email: "a@example.test" }, scopeUserId: "fixture-A", epoch: 4 });

describe("云Key搜索绑定与窄撤销", () => {
  it("预期账号在可重入onStart前冻结，cloud wire绝不携带Key", async () => {
    login();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(""));
    const search = createStartStreamingSearch({ store: createGraphStore(), prepareCredentials: async () => cloud,
      fetchImplementation: fetcher, readStreamImplementation: async () => {}, createRunId: () => "fixture-run",
      onStart: () => accountStore.setState({ account: { userId: "fixture-B", email: "b@example.test" }, scopeUserId: "fixture-B", epoch: 5 }),
    });
    await search({ query: "fixture query", language: "zh-CN" });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ [CLOUD_ACCOUNT_HEADER]: "fixture-A" });
    expect(JSON.stringify(fetcher.mock.calls[0]?.[1]?.headers)).not.toContain("fixture-own-llm");
  });

  it.each([false, true])("双own继续运行；只有选定cloud服务变化才取消 mixed=%s", async useCloud => {
    login(); let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => { signal = init?.signal ?? undefined; return new Response(""); });
    const search = createStartStreamingSearch({ store: createGraphStore(), prepareCredentials: async () => useCloud ? cloud : own,
      fetchImplementation: fetcher, createRunId: () => "fixture-run",
      readStreamImplementation: options => {
        const runSignal = options.signal;
        if (runSignal === undefined) throw new Error("fixture requires a run signal");
        return new Promise(resolve => { runSignal.addEventListener("abort", () => resolve(), { once: true }); });
      },
    });
    const pending = search({ query: "fixture query", language: "zh-CN" });
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(search.cancelForCloudKeyChange(["serpapi"])).toBe(false); expect(signal?.aborted).toBe(false);
    expect(search.cancelForCloudKeyChange(["deepseek"])).toBe(useCloud); expect(signal?.aborted).toBe(useCloud);
    search.cancel(); await pending;
  });

  it("准备期间仅选中的cloud服务代际变化才拒绝，own准备不被误取消", async () => {
    login();
    for (const selected of [own, cloud]) {
      let release!: (value: SearchCredentials) => void;
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(""));
      const search = createStartStreamingSearch({ store: createGraphStore(), fetchImplementation: fetcher, readStreamImplementation: async () => {},
        prepareCredentials: () => new Promise(resolve => { release = resolve; }), createRunId: () => "fixture-run" });
      const pending = search({ query: "fixture", language: "zh-CN" });
      accountKeysStore.setState(state => ({ generation: state.generation + 1, changedServices: ["deepseek"], serviceGenerations: { ...state.serviceGenerations, deepseek: state.serviceGenerations.deepseek + 1 } }));
      release(selected);
      if (selected === cloud) { await expect(pending).rejects.toMatchObject({ problem: { code: "CLOUD_KEY_REVOKED" } }); expect(fetcher).not.toHaveBeenCalled(); }
      else { await pending; expect(fetcher).toHaveBeenCalledTimes(1); }
    }
  });

  it.each([false, true])("已ready的own预览保留，cloud预览仅相关服务变化时退场 mixed=%s", async useCloud => {
    login();
    const workspace = createWorkspaceStore(); workspace.getState().addGraph(fromResultGraph(pythonResultGraphFixture, "fixture-graph"));
    const research = createResearchStore(workspace, { prepareCredentials: async () => useCloud ? cloud : own,
      fetchImplementation: async () => new Response(""), createRunId: () => "fixture-preview",
      readStreamImplementation: async options => {
        for (const event of createPythonMockStream({ now: () => Date.parse("2026-01-01T00:00:00Z") })) {
          const bound = StreamEventSchema.parse({ ...event, runId: "fixture-preview", ...(event.type === "complete" ? { data: { ...event.data, result: { ...event.data.result, runId: "fixture-preview" } } } : {}) });
          options.onEvent(bound);
        }
      },
    }, () => {}, () => {});
    await research.getState().start("fixture-graph"); expect(research.getState().preview?.status).toBe("ready");
    research.getState().cancelForCloudKeyChange(["serpapi"]); expect(research.getState().preview?.status).toBe("ready");
    research.getState().cancelForCloudKeyChange(["deepseek"]);
    if (useCloud) expect(research.getState().preview).toBeNull(); else expect(research.getState().preview?.status).toBe("ready");
  });
});
