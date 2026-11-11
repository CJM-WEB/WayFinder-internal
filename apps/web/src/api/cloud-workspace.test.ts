/**
 * 测试职责：用假传输验证云工作区的账号护栏、完整快照与失败边界，不连接真实服务。
 * 取消与期限包含忽略Signal的fetch／正文；坏协议和坏历史不得把原始响应写入错误。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUD_ACCOUNT_HEADER, EditableGraphSchema,
  type CloudGraphWriteRequest, type CloudGraphWriteResponse, type CloudWorkspaceImportRequest,
  type CloudWorkspaceResponse, type EditableGraph } from "@wayfinder/contracts";
import { appendHistory, createGraphHistory, restoreGraphHistory, storeGraphHistory, undoHistoryEvent } from "@wayfinder/contracts/graph-history";
import { createDeferred } from "../../../../tests/support/test-infrastructure.mjs";
import { CloudWorkspaceError, createCloudWorkspaceApi } from "./cloud-workspace.js";

const userId = "fixture_owner", privateValue = "fixture-private-response-value";
const signal = () => new AbortController().signal;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const graph = (id: string): EditableGraph => EditableGraphSchema.parse({
  version: "workspace.v1", id, title: "原图", query: "", language: "zh-CN", presentationMode: "graph",
  createdAt: "2026-11-11T00:00:00.000Z", updatedAt: "2026-11-11T00:00:00.000Z", lastRunId: null,
  nodes: [], edges: [], positions: {},
});
/** 创建有真实撤销／重做的快照，避免空历史样例掩盖正文与历史不一致。 */
function record(id: string) {
  const before = graph(id), after = { ...before, title: "可重做的改名" };
  const history = appendHistory(createGraphHistory(before), before, after, {
    id: "rename_fixture", kind: "graph.rename", subject: "改名", active: true, occurredAt: before.updatedAt,
  }, 100);
  const undone = undoHistoryEvent(history, "rename_fixture");
  if (!undone.ok) throw new Error("假历史必须可撤销");
  return { document: undone.graph, history: storeGraphHistory(undone.history), revision: 3, status: "active" as const, originalIndex: null };
}
function snapshot(): CloudWorkspaceResponse {
  return { userId, activeOrder: ["existing", "imported"], deletedIds: ["deleted"],
    graphs: [record("existing"), record("imported"), { ...record("deleted"), status: "deleted", originalIndex: 1 }] };
}
function writeRequest(): CloudGraphWriteRequest {
  const value = record("existing");
  return { action: "save", document: value.document, history: value.history, expectedRevision: 3, mutationId: "fixture_save" };
}
const importRequest = (): CloudWorkspaceImportRequest => ({ action: "import", importId: "fixture_import", documents: [], deletedGraphs: [] });
function writeResponse(): CloudGraphWriteResponse {
  const value = snapshot();
  return { userId, record: record("existing"), activeOrder: value.activeOrder, deletedIds: value.deletedIds };
}
async function safeFailure(pending: Promise<unknown>, code = "WORKSPACE_UNAVAILABLE") {
  const error: unknown = await pending.then(() => { throw new Error("预期请求被拒绝"); }, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CloudWorkspaceError);
  expect(error).toMatchObject({ code });
  expect(String(error)).not.toContain(privateValue);
  expect(JSON.stringify(error)).not.toContain(privateValue);
  expect(error).not.toHaveProperty("cause");
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("云工作区同源API", () => {
  it("读、写、导入都携带预期账号且禁止缓存，正文不进入URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(snapshot()))
      .mockResolvedValueOnce(json(writeResponse())).mockResolvedValueOnce(json(snapshot()));
    const api = createCloudWorkspaceApi(fetcher), write = writeRequest(), imported = importRequest();
    await api.read(userId, signal()); await api.write(userId, write, signal()); await api.import(userId, imported, signal());
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["/api/workspace", "/api/workspace", "/api/workspace"]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store", headers: { [CLOUD_ACCOUNT_HEADER]: userId } });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("body");
    for (const [index, body] of [[1, write], [2, imported]] as const) {
      expect(fetcher.mock.calls[index]?.[1]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }
  });

  it("服务端固定冲突码保留，网络、坏JSON和未知错误响应统一脱敏", async () => {
    await safeFailure(createCloudWorkspaceApi(vi.fn<typeof fetch>().mockResolvedValue(json({ code: "WORKSPACE_CONFLICT" }, 409))).read(userId, signal()), "WORKSPACE_CONFLICT");
    for (const fetcher of [
      vi.fn<typeof fetch>().mockRejectedValue(new Error(privateValue)),
      vi.fn<typeof fetch>().mockResolvedValue(new Response(privateValue, { status: 503 })),
      vi.fn<typeof fetch>().mockResolvedValue(json({ code: privateValue }, 503)),
      vi.fn<typeof fetch>().mockResolvedValue(json({ code: "WORKSPACE_CONFLICT", message: privateValue }, 409)),
      // 额外字段名也可能由不可信响应携带秘密，不能让Zod原始issue泄漏它。
      vi.fn<typeof fetch>().mockResolvedValue(json({ ...snapshot(), [privateValue]: "ignored" })),
    ]) await safeFailure(createCloudWorkspaceApi(fetcher).read(userId, signal()));
  });

  it("读、写及导入拒绝其他账号响应，不把Cookie切换后的内容交给旧请求", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ ...snapshot(), userId: "other_owner" }))
      .mockResolvedValueOnce(json({ ...writeResponse(), userId: "other_owner" }))
      .mockResolvedValueOnce(json({ ...snapshot(), userId: "other_owner" }));
    const api = createCloudWorkspaceApi(fetcher);
    await safeFailure(api.read(userId, signal()), "ACCOUNT_REQUIRED");
    await safeFailure(api.write(userId, writeRequest(), signal()), "ACCOUNT_REQUIRED");
    await safeFailure(api.import(userId, importRequest(), signal()), "ACCOUNT_REQUIRED");
  });

  it("结构合法但无法重放成当前图的历史在三种返回路径都被拒绝", async () => {
    const broken = record("existing"); broken.document.title = privateValue;
    const invalid = { userId, activeOrder: ["existing"], deletedIds: [], graphs: [broken] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(invalid))
      .mockResolvedValueOnce(json({ userId, record: broken, activeOrder: ["existing"], deletedIds: [] }))
      .mockResolvedValueOnce(json(invalid));
    const api = createCloudWorkspaceApi(fetcher);
    await safeFailure(api.read(userId, signal()));
    await safeFailure(api.write(userId, writeRequest(), signal()));
    await safeFailure(api.import(userId, importRequest(), signal()));
  });

  it("预先取消零请求；fetch与json忽略Signal时取消仍能结束等待", async () => {
    const pre = new AbortController(); pre.abort(new Error(privateValue));
    const unused = vi.fn<typeof fetch>();
    await safeFailure(createCloudWorkspaceApi(unused).read(userId, pre.signal)); expect(unused).not.toHaveBeenCalled();
    for (const phase of ["fetch", "json"] as const) {
      const controller = new AbortController(), started = createDeferred<void>(), late = createDeferred<Response>();
      const body = createDeferred<unknown>(), response = json(snapshot());
      vi.spyOn(response, "json").mockImplementation(() => { started.resolve(); return body.promise; });
      const fetcher = vi.fn<typeof fetch>(() => {
        if (phase === "fetch") { started.resolve(); return late.promise; }
        return Promise.resolve(response);
      });
      const pending = createCloudWorkspaceApi(fetcher).read(userId, controller.signal);
      const rejected = safeFailure(pending);
      await started.promise; controller.abort(new Error(privateValue)); await rejected;
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      // 迟到成功也不能复活已取消的读取；所有测试promise最终主动结算。
      late.resolve(json(snapshot())); body.resolve(snapshot()); await Promise.resolve();
    }
  });

  it.each(["fetch", "json"] as const)("10秒绝对期限覆盖不响应取消的%s阶段", async phase => {
    vi.useFakeTimers();
    // 原生AbortSignal.timeout不依赖JS假计时器；只替换其时钟，仍执行真实AbortSignal传播。
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), milliseconds); return controller.signal;
    });
    const started = createDeferred<void>(), late = createDeferred<Response>(), body = createDeferred<unknown>(), response = json(snapshot());
    vi.spyOn(response, "json").mockImplementation(() => { started.resolve(); return body.promise; });
    const fetcher = vi.fn<typeof fetch>(() => {
      if (phase === "fetch") { started.resolve(); return late.promise; }
      return Promise.resolve(response);
    });
    let settled = false;
    const pending = createCloudWorkspaceApi(fetcher).read(userId, signal());
    const rejected = safeFailure(pending).finally(() => { settled = true; });
    await started.promise; await vi.advanceTimersByTimeAsync(9_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(timeout).toHaveBeenCalledWith(10_000); expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    late.resolve(json(snapshot())); body.resolve(snapshot());
  });

  it("同步序列化跨过绝对期限但timer尚未执行时不再发请求", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const input = importRequest(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(snapshot()));
    Object.defineProperty(input, "toJSON", { value: () => { vi.setSystemTime(10_001); return importRequest(); } });
    await safeFailure(createCloudWorkspaceApi(fetcher).import(userId, input, signal()));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("导入返回当前完整快照，保留既有图、删除顺序与重做而非仅返回导入条目", async () => {
    const expected = snapshot(), input = importRequest(), source = JSON.stringify(input);
    const result = await createCloudWorkspaceApi(vi.fn<typeof fetch>().mockResolvedValue(json(expected))).import(userId, input, signal());
    expect(result).toEqual(expected); expect(JSON.stringify(input)).toBe(source);
    expect(result.activeOrder).toEqual(["existing", "imported"]); expect(result.deletedIds).toEqual(["deleted"]);
    for (const item of result.graphs) {
      expect(item.history.redoIds).toEqual(["rename_fixture"]);
      expect(restoreGraphHistory(item.history, item.document, 100).redoIds).toEqual(["rename_fixture"]);
    }
  });
});
