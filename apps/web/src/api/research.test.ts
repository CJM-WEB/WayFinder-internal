import { prepareTestCredentials } from "../testing/test-credentials.js";
/** 测试职责：重搜使用临时 Run；取消、失败和应用前的新编辑都不能破坏当前图。 */
import { ResultGraphSchema, StreamEventSchema, type ResultGraph } from "@wayfinder/contracts";
import { expect, it, vi } from "vitest";
import { pythonResultGraphFixture } from "../fixtures/python-result-graph.js";
import type { ReadSearchEventStreamOptions } from "../lib/stream.js";
import { createGraphStore } from "../stores/graph-store.js";
import { addNode, addResource, deleteNode, deleteResource, updateNode, updateResource } from "../stores/workspace-edits.js";
import { createEmptyGraph, createWorkspaceStore, fromResultGraph, selectCurrentGraph, selectWorkspaceHistory } from "../stores/workspace-store.js";
import { createResearchStore } from "./research.js";
import { createStartStreamingSearch } from "./search.js";

function nodeResult(runId: string, nodeId = "节点"): ResultGraph {
  const node = pythonResultGraphFixture.graph.nodes.find(item => item.status === "ready");
  if (node === undefined) throw new Error("缺少搜索样例");
  return ResultGraphSchema.parse({
    ...pythonResultGraphFixture, runId,
    analysis: { ...pythonResultGraphFixture.analysis, presentationMode: "compact" },
    meta: { ...pythonResultGraphFixture.meta, partial: false },
    graph: { edges: [], nodes: [{ ...node, id: nodeId, resources: node.resources.map(resource => ({
      ...resource, url: "https://candidate.example.com/", canonicalUrl: "https://candidate.example.com/", domain: "candidate.example.com", engine: "google",
    })) }] },
  });
}
const complete = (result: ResultGraph) => StreamEventSchema.parse({
  type: "complete", runId: result.runId, sequence: 1, timestamp: "2026-11-01T00:00:00Z", protocolVersion: "0.1",
  data: { finalStatus: result.meta.partial ? "partial" : "complete", result },
});
function workspaceFixture() {
  const workspace = createWorkspaceStore();
  workspace.getState().addGraph(addNode(createEmptyGraph("图", "手动图", "zh-CN"), "当前节点标题", "当前说明", "节点"));
  return workspace;
}

it("节点重搜使用当前标题与原语境，预览完成前后都不改旧图，应用后才追加", async () => {
  const workspace = workspaceFixture();
  const previous = selectCurrentGraph(workspace.getState());
  let posted: unknown;
  const store = createResearchStore(workspace, {
    prepareCredentials: prepareTestCredentials,
    createRunId: () => "运行",
    fetchImplementation: async (_input, init) => { posted = JSON.parse(String(init?.body)); return new Response(""); },
    readStreamImplementation: async options => { await options.onEvent(complete(nodeResult("运行"))); },
  }, vi.fn());
  await store.getState().start("图", "节点");
  expect(posted).toMatchObject({ query: "当前节点标题", language: "zh-CN", engine: "baidu", nodeSearch: { node: { id: "节点", title: "当前节点标题", description: "当前说明" }, analysis: null } });
  expect(selectCurrentGraph(workspace.getState())).toBe(previous);
  expect(store.getState().preview?.status).toBe("ready");
  store.getState().apply("append");
  expect(selectCurrentGraph(workspace.getState())?.nodes[0]?.resources).toHaveLength(1);
  expect(selectCurrentGraph(workspace.getState())?.analysis).toBeUndefined();
  expect(store.getState().preview).toBeNull();
  expect(selectWorkspaceHistory(workspace.getState()).at(-1)?.kind).toBe("node.search");
});

it("真实全图应用明确拥有未变化的节点与资源字段，选择性撤销先前人工编辑不覆盖结果", async () => {
  const workspace = createWorkspaceStore();
  const original = fromResultGraph(pythonResultGraphFixture, "图");
  workspace.getState().addGraph(original);
  const node = original.nodes[0], resource = node?.resources[0];
  if (node === undefined || resource === undefined) throw new Error("缺少全图固定资源");
  workspace.getState().replaceGraph(updateNode(original, node.id, { title: "B" }));
  const edited = selectCurrentGraph(workspace.getState());
  if (edited === null) throw new Error("缺少编辑图");
  workspace.getState().replaceGraph(updateResource(edited, node.id, resource.id, { summary: "说明B" }));
  const result = { ...pythonResultGraphFixture, runId: "完整替换", graph: { ...pythonResultGraphFixture.graph,
    nodes: pythonResultGraphFixture.graph.nodes.map(current => current.id === node.id ? { ...current, title: "B",
      resources: current.resources.map(item => item.id === resource.id ? { ...item, summary: "说明B" } : item) } : current) } };
  const research = createResearchStore(workspace, {
    prepareCredentials: prepareTestCredentials,
    createRunId: () => result.runId, fetchImplementation: async () => new Response(""),
    readStreamImplementation: async options => { await options.onEvent(complete(result)); },
  }, vi.fn());
  await research.getState().start("图");
  research.getState().apply("replace");
  const events = selectWorkspaceHistory(workspace.getState());
  expect(events.at(-1)?.kind).toBe("graph.search");
  for (const event of events.slice(0, 2)) expect(workspace.getState().undoEvent(event.id)).toEqual({ ok: true });
  expect(selectCurrentGraph(workspace.getState())?.nodes[0]).toMatchObject({ title: "B", resources: [{ summary: "说明B" }] });
  const applied = events.at(-1);
  if (applied === undefined) throw new Error("缺少应用事件");
  expect(workspace.getState().undoEvent(applied.id)).toEqual({ ok: true });
  expect(selectCurrentGraph(workspace.getState())?.nodes[0]).toEqual(original.nodes[0]);
});

it("真实节点替换完全拥有资源集合，但不拥有节点标题与说明", async () => {
  const workspace = createWorkspaceStore();
  const original = addResource(addNode(createEmptyGraph("图", "手动图", "zh-CN"), "原标题", "原说明", "节点"), "节点", "https://old-node.example.com/", "旧资源");
  workspace.getState().addGraph(original);
  workspace.getState().replaceGraph(updateNode(original, "节点", { title: "新标题", description: "新说明" }));
  const edited = selectCurrentGraph(workspace.getState());
  if (edited === null) throw new Error("缺少编辑图");
  workspace.getState().replaceGraph(deleteResource(edited, "节点", "旧资源"));
  const research = createResearchStore(workspace, {
    prepareCredentials: prepareTestCredentials,
    createRunId: () => "替换", fetchImplementation: async () => new Response(""),
    readStreamImplementation: async options => { await options.onEvent(complete(nodeResult("替换"))); },
  }, vi.fn());
  await research.getState().start("图", "节点");
  research.getState().apply("replace");
  const events = selectWorkspaceHistory(workspace.getState());
  expect(events.at(-1)?.kind).toBe("node.search");
  const title = events[0], deletion = events[1];
  if (title === undefined || deletion === undefined) throw new Error("缺少节点编辑事件");
  expect(workspace.getState().undoEvent(deletion.id)).toEqual({ ok: true });
  expect(selectCurrentGraph(workspace.getState())?.nodes[0]?.resources.some(item => item.id === "旧资源")).toBe(false);
  expect(workspace.getState().undoEvent(title.id)).toEqual({ ok: true });
  expect(selectCurrentGraph(workspace.getState())?.nodes[0]).toMatchObject({ title: "原标题", description: "原说明" });
  expect(selectCurrentGraph(workspace.getState())?.nodes[0]?.resources).toHaveLength(1);
});

it("取消真实触发Signal，旧Reader即使伪装当前Run也不能写临时状态或预览", async () => {
  const workspace = workspaceFixture();
  const readers: ReadSearchEventStreamOptions[] = [];
  const release: (() => void)[] = [];
  let index = 0;
  const store = createResearchStore(workspace, {
    prepareCredentials: prepareTestCredentials,
    createRunId: () => `运行${++index}`,
    fetchImplementation: async () => new Response(""),
    readStreamImplementation: options => {
      readers.push(options);
      return new Promise<void>(resolve => { release.push(resolve); });
    },
  }, vi.fn());
  const first = store.getState().start("图", "节点");
  await vi.waitFor(() => expect(readers).toHaveLength(1));
  store.getState().cancel();
  expect(readers[0]?.signal?.aborted).toBe(true);
  const second = store.getState().start("图", "节点");
  await vi.waitFor(() => expect(readers).toHaveLength(2));
  await readers[0]?.onEvent(complete(nodeResult("运行2")));
  expect(store.getState().runStore.getState().isSearching).toBe(true);
  expect(store.getState().preview?.status).toBe("searching");
  await readers[1]?.onEvent(complete(nodeResult("运行2")));
  release[1]?.();
  await second;
  release[0]?.();
  await first;
  expect(store.getState().preview?.runId).toBe("运行2");
  expect(store.getState().preview?.status).toBe("ready");
  expect(selectCurrentGraph(workspace.getState())?.nodes[0]?.resources).toHaveLength(0);
  store.getState().dismiss();
});

it("失败或提前结束不伪造预览结果，旧图保持完整且不暴露内部异常", async () => {
  const workspace = workspaceFixture();
  const previous = selectCurrentGraph(workspace.getState());
  const store = createResearchStore(workspace, {
    prepareCredentials: prepareTestCredentials,
    fetchImplementation: async () => { throw new Error("不能进入界面的内部诊断"); },
  }, vi.fn());
  await store.getState().start("图", "节点");
  expect(store.getState().preview?.status).toBe("failed");
  expect(JSON.stringify(store.getState().preview)).not.toContain("内部诊断");
  expect(selectCurrentGraph(workspace.getState())).toBe(previous);
  store.getState().dismiss();
  expect(store.getState().preview).toBeNull();
});

it("预览后编辑造成重复或删除目标时不覆盖旧内容，也不写入另一张图", async () => {
  const workspace = workspaceFixture();
  const store = createResearchStore(workspace, {
    prepareCredentials: prepareTestCredentials,
    createRunId: () => "运行",
    fetchImplementation: async () => new Response(""),
    readStreamImplementation: async options => { await options.onEvent(complete(nodeResult("运行"))); },
  }, vi.fn());
  await store.getState().start("图", "节点");
  const first = selectCurrentGraph(workspace.getState());
  if (first === null) throw new Error("缺少图");
  workspace.getState().replaceGraph(addResource(addNode(first, "其他节点", "", "其他"), "其他", "https://candidate.example.com/"));
  const edited = selectCurrentGraph(workspace.getState());
  store.getState().apply("append");
  expect(selectCurrentGraph(workspace.getState())).toBe(edited);
  expect(store.getState().preview?.status).toBe("failed");
  await store.getState().start("图", "节点");
  if (edited === null) throw new Error("缺少编辑图");
  workspace.getState().replaceGraph(deleteNode(edited, "节点"));
  store.getState().apply("replace");
  expect(selectCurrentGraph(workspace.getState())?.nodes.map(node => node.id)).toEqual(["其他"]);
  workspace.getState().addGraph(createEmptyGraph("另图", "另一张图", "zh-CN"));
  const other = selectCurrentGraph(workspace.getState());
  store.getState().apply("replace");
  expect(selectCurrentGraph(workspace.getState())).toBe(other);
});

it("手动图全图重搜必须显式填写主题，取消后不写入原图查询", async () => {
  const workspace = workspaceFixture();
  const fetchImplementation = vi.fn(async () => new Response(""));
  const store = createResearchStore(workspace, {
    prepareCredentials: prepareTestCredentials, fetchImplementation, readStreamImplementation: async () => {} }, vi.fn());
  const original = selectCurrentGraph(workspace.getState());
  await store.getState().start("图");
  expect(fetchImplementation).not.toHaveBeenCalled();
  expect(store.getState().preview).toBeNull();
  await store.getState().start("图", undefined, "明确的主题");
  expect(fetchImplementation).toHaveBeenCalledTimes(1);
  expect(store.getState().preview?.query).toBe("明确的主题");
  store.getState().dismiss();
  expect(selectCurrentGraph(workspace.getState())).toBe(original);
  expect(selectCurrentGraph(workspace.getState())?.query).toBe("");
});

it("无效长主题或目标不能取消正在运行的旧请求，也不生成新身份或请求", async () => {
  const workspace = workspaceFixture();
  const cancelForeground = vi.fn();
  const createRunId = vi.fn(() => "有效运行");
  const fetchImplementation = vi.fn(async () => new Response(""));
  let reader: ReadSearchEventStreamOptions | undefined;
  let release: (() => void) | undefined;
  const store = createResearchStore(workspace, {
    prepareCredentials: prepareTestCredentials,
    createRunId, fetchImplementation,
    readStreamImplementation: options => {
      reader = options;
      return new Promise<void>(resolve => { release = resolve; });
    },
  }, cancelForeground);
  const pending = store.getState().start("图", "节点");
  await vi.waitFor(() => expect(reader).toBeDefined());
  const activePreview = store.getState().preview;
  await store.getState().start("图", undefined, "长".repeat(2001));
  expect(store.getState().preview).toBe(activePreview);
  expect(store.getState().inputError).toBe("query");
  await store.getState().start("图", "不存在的节点");
  expect(store.getState().preview).toBe(activePreview);
  expect(store.getState().inputError).toBe("target");
  expect(reader?.signal?.aborted).toBe(false);
  expect(fetchImplementation).toHaveBeenCalledTimes(1);
  expect(createRunId).toHaveBeenCalledTimes(1);
  expect(cancelForeground).toHaveBeenCalledTimes(1);
  await reader?.onEvent(complete(nodeResult("有效运行")));
  release?.();
  await pending;
  expect(store.getState().preview?.status).toBe("ready");
});

it("ready预览面对无效完整输入仍保留结果和旧Signal，不能被空白节点标题丢弃", async () => {
  const workspace = workspaceFixture();
  const cancelForeground = vi.fn();
  const fetchImplementation = vi.fn(async () => new Response(""));
  let signal: AbortSignal | undefined;
  const store = createResearchStore(workspace, {
    prepareCredentials: prepareTestCredentials,
    createRunId: () => "有效运行", fetchImplementation,
    readStreamImplementation: async options => {
      signal = options.signal;
      await options.onEvent(complete(nodeResult("有效运行")));
    },
  }, cancelForeground);
  await store.getState().start("图", "节点");
  const ready = store.getState().preview;
  await store.getState().start("图", undefined, "长".repeat(2001));
  expect(store.getState().preview).toBe(ready);
  const document = selectCurrentGraph(workspace.getState());
  if (document === null) throw new Error("缺少搜索图");
  workspace.getState().replaceGraph({ ...document, nodes: document.nodes.map(node => ({ ...node, title: " " })) });
  await store.getState().start("图", "节点");
  expect(store.getState().inputError).toBe("query");
  expect(store.getState().preview).toBe(ready);
  expect(signal?.aborted).toBe(false);
  expect(fetchImplementation).toHaveBeenCalledTimes(1);
  expect(cancelForeground).toHaveBeenCalledTimes(1);
});

it("缺失配置不清空ready预览、旧图与人工主题，不取消前台", async () => {
  const workspace = workspaceFixture();
  const cancelForeground = vi.fn();
  let configured = true;
  const fetchImplementation = vi.fn(async () => new Response(""));
  const store = createResearchStore(workspace, {
    prepareCredentials: async () => { if (!configured) throw new Error("配置不可用"); return prepareTestCredentials(); },
    createRunId: () => "已就绪", fetchImplementation,
    readStreamImplementation: async options => { options.onEvent(complete(nodeResult("已就绪"))); },
  }, cancelForeground);
  await store.getState().start("图", "节点");
  const preview = store.getState().preview;
  const previous = selectCurrentGraph(workspace.getState());
  configured = false;
  const started = vi.fn();
  await store.getState().start("图", undefined, "保留人工主题", started);
  expect(started).not.toHaveBeenCalled();
  expect(store.getState().preview).toBe(preview);
  expect(selectCurrentGraph(workspace.getState())).toBe(previous);
  expect(cancelForeground).toHaveBeenCalledOnce();
  expect(fetchImplementation).toHaveBeenCalledOnce();
});

it.each(["取消", "切图再返回", "删除节点"])("待检查重搜遇到%s后不能在迟到成功时启动", async change => {
  const workspace = workspaceFixture();
  let permit: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { permit = resolve; });
  const createRunId = vi.fn(() => "不应创建");
  const fetchImplementation = vi.fn(async () => new Response(""));
  const cancelForeground = vi.fn();
  const store = createResearchStore(workspace, {
    prepareCredentials: async () => { await gate; return prepareTestCredentials(); },
    createRunId, fetchImplementation,
  }, cancelForeground);
  const pending = store.getState().start("图", "节点");
  if (change === "取消") store.getState().cancelPending();
  else if (change === "切图再返回") {
    workspace.getState().addGraph(createEmptyGraph("另图", "另一图", "zh-CN"));
    workspace.getState().selectGraph("图");
  } else {
    const graph = selectCurrentGraph(workspace.getState());
    if (graph === null) throw new Error("缺少目标图");
    workspace.getState().replaceGraph(deleteNode(graph, "节点"));
  }
  permit?.();
  await pending;
  expect(createRunId).not.toHaveBeenCalled();
  expect(fetchImplementation).not.toHaveBeenCalled();
  expect(cancelForeground).not.toHaveBeenCalled();
  expect(store.getState().preview).toBeNull();
});

it("新的重搜意图只取消前台待检查意图，不把迟到前台请求当成最新运行", async () => {
  const workspace = workspaceFixture();
  let permit: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { permit = resolve; });
  const foregroundFetch = vi.fn(async () => new Response(""));
  const foreground = createStartStreamingSearch({
    store: createGraphStore(),
    prepareCredentials: async () => { await gate; return prepareTestCredentials(); },
    fetchImplementation: foregroundFetch,
    readStreamImplementation: async () => {},
  });
  const researchFetch = vi.fn(async () => new Response(""));
  const research = createResearchStore(workspace, {
    prepareCredentials: prepareTestCredentials, fetchImplementation: researchFetch,
    readStreamImplementation: async () => {},
  }, foreground.cancel, foreground.cancelPending);
  const pending = foreground({ query: "过期前台意图", language: "zh-CN" });
  await research.getState().start("图", "节点");
  permit?.();
  await pending;
  expect(foregroundFetch).not.toHaveBeenCalled();
  expect(researchFetch).toHaveBeenCalledOnce();
});
