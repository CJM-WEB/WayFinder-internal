/**
 * E2E 职责：在真实 Chromium 中覆盖统一 Omnibox 到 Graph、Resource Panel 与第二次 Query 的
 * Browser-like 主旅程，并确定性证明旧 Run 取消和过期事件隔离。
 *
 * 测试边界：
 * - Fixture 仅替换浏览器的 `/api/search` fetch，应用仍走真实 Search Coordinator、NDJSON Reader、
 *   Graph Store、React / React Flow 与 Resource Panel；
 * - Stream 由测试显式分段放行，不依赖 sleep、随机时序、Secret 或真实 Provider；
 * - 非 `/api/search` 的 JavaScript fetch 一律拒绝，Resource Open 只记录安全打开意图。
 */
import {
  EditableGraphSchema,
  StreamEventSchema,
  type EditableGraph,
  type Resource,
  type SearchLanguage,
  type SearchEngine,
  type StreamEvent,
} from "@wayfinder/contracts";
import { copyFile, writeFile } from "node:fs/promises";
import { expect, test, type CDPSession, type Page, type TestInfo } from "@playwright/test";

import { createPythonMockStream } from "../src/testing/python-mock-stream.js";

const FIXTURE_TIME = Date.parse("2026-10-22T00:00:00.000Z");
const FIRST_QUERY = "Python";
const SECOND_QUERY = "TypeScript";
const READY_NODE_ID = "python-introduction";

type BrowserFixtureSnapshot = Readonly<{
  runId: string;
  query: string;
  language: SearchLanguage;
  engine: SearchEngine;
  nodeSearch?: unknown;
  aborted: boolean;
  cancelled: boolean;
}>;

type BrowserOpenCall = readonly [
  url: string,
  target: string,
  features: string,
];

type BrowserFixtureHarness = Readonly<{
  emit: (
    targetRunIndex: number,
    eventIndexes: readonly number[],
    sourceRunIndex?: number,
  ) => void;
  close: (runIndex: number) => void;
  fail: (runIndex: number) => void;
  snapshots: () => readonly BrowserFixtureSnapshot[];
  openCalls: () => readonly BrowserOpenCall[];
}>;

declare global {
  interface Window {
    __WAYFINDER_E2E__: BrowserFixtureHarness;
  }
}

/** 为首个 ready Node 扩充到 4 项资源，只服务于真实 Top 3 / Show More 浏览器断言。 */
function createJourneyEvents(): readonly StreamEvent[] {
  const events = createPythonMockStream({ now: () => FIXTURE_TIME });
  const readyEvent = events.find(
    (event): event is Extract<StreamEvent, { type: "node.ready" }> =>
      event.type === "node.ready" && event.nodeId === READY_NODE_ID,
  );
  const firstResource = readyEvent?.resources[0];
  if (readyEvent?.type !== "node.ready" || firstResource === undefined) {
    throw new Error("Browser-like Fixture 缺少首个 ready Resource");
  }

  const extraResources: readonly Resource[] = [
    {
      ...firstResource,
      id: "resource-python-docs",
      title: "Python Documentation",
      url: "https://docs.python.org/3/",
      canonicalUrl: "https://docs.python.org/3/",
      domain: "docs.python.org",
      sourceType: "official_documentation",
      rank: 2,
    },
    {
      ...firstResource,
      id: "resource-python-reference-e2e",
      title: "Python Language Reference",
      url: "https://docs.python.org/3/reference/",
      canonicalUrl: "https://docs.python.org/3/reference/",
      domain: "docs.python.org",
      sourceType: "official_documentation",
      rank: 3,
    },
    {
      ...firstResource,
      id: "resource-python-library-e2e",
      title: "Python Standard Library",
      url: "https://docs.python.org/3/library/",
      canonicalUrl: "https://docs.python.org/3/library/",
      domain: "docs.python.org",
      sourceType: "official_documentation",
      rank: 4,
    },
  ];
  const resources = [firstResource, ...extraResources];

  return events.map(event => {
    if (event.type === "node.ready" && event.nodeId === READY_NODE_ID) {
      return StreamEventSchema.parse({ ...event, resources });
    }
    if (event.type === "complete") {
      return StreamEventSchema.parse({
        ...event,
        data: {
          ...event.data,
          result: {
            ...event.data.result,
            graph: {
              ...event.data.result.graph,
              nodes: event.data.result.graph.nodes.map(node =>
                node.id === READY_NODE_ID && node.status === "ready"
                  ? { ...node, resources }
                  : node,
              ),
            },
          },
        },
      });
    }
    return event;
  });
}

/**
 * 墨迹生长夹具：故意打乱节点数组，再增加一条真实相关边形成汇合。
 * 这样浏览器必须按业务连线传播，而不能碰巧按数组顺序依次展示或只保留生成树的边。
 */
function createInkMotionEvents(): readonly StreamEvent[] {
  const events = createJourneyEvents();
  const extraEdge = {
    id: "edge-introduction-libraries-e2e",
    source: READY_NODE_ID,
    target: "python-third-party-libraries",
    type: "related_to" as const,
  };
  const reorder = <T extends { id: string }>(nodes: readonly T[]): readonly T[] => {
    const order = [READY_NODE_ID, "python-basics", "python-third-party-libraries", "python-installation"];
    return order.flatMap(id => nodes.filter(node => node.id === id));
  };
  return events.map(event => {
    if (event.type === "graph.plan") return StreamEventSchema.parse({
      ...event, data: { ...event.data, nodes: reorder(event.data.nodes), edges: [...event.data.edges, extraEdge] },
    });
    if (event.type === "complete") return StreamEventSchema.parse({
      ...event, data: { ...event.data, result: { ...event.data.result, graph: {
        nodes: reorder(event.data.result.graph.nodes), edges: [...event.data.result.graph.edges, extraEdge],
      } } },
    });
    return event;
  });
}

/** 只读取实际可见 DOM，不把渲染器的内部时间表当作测试答案。 */
const visibleInkNodeIds = (page: Page): Promise<readonly string[]> =>
  page.locator("[data-ink-node]:visible").evaluateAll(elements =>
    elements.map(element => element.getAttribute("data-ink-node") ?? "").sort());

const visibleInkEdgeIds = (page: Page): Promise<readonly string[]> =>
  page.locator(".react-flow__edge").evaluateAll(elements => elements.filter(element => {
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.5;
  }).map(element => element.getAttribute("data-id") ?? "").sort());

/**
 * GPU 验证只统计有色颜料，排除黑字和浅色背景；采样在下一次绘制之后执行，避免读取已清空缓冲。
 * 不可用的 WebGL 返回 null，独立的降级用例继续验证所有真实节点与状态可读。
 */
async function inkPigmentCenter(page: Page): Promise<Readonly<{ count: number; x: number; y: number }> | null> {
  return page.locator(".ink-study__canvas").evaluate(async element => {
    const source = element as HTMLCanvasElement;
    if (getComputedStyle(source).visibility !== "visible") return null;
    await new Promise<void>(resolve => {
      let frames = 0;
      const afterFrame = (): void => { if (++frames >= 30) resolve(); else requestAnimationFrame(afterFrame); };
      requestAnimationFrame(afterFrame);
    });
    return new Promise<Readonly<{ count: number; x: number; y: number }> | null>(resolve => requestAnimationFrame(() => {
      const copy = document.createElement("canvas");
      copy.width = source.width;
      copy.height = source.height;
      const context = copy.getContext("2d");
      if (context === null) { resolve(null); return; }
      context.drawImage(source, 0, 0);
      const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
      let count = 0, sumX = 0, sumY = 0;
      for (let y = 0; y < copy.height; y += 4) for (let x = 0; x < copy.width; x += 4) {
        const offset = (y * copy.width + x) * 4;
        const red = pixels[offset] ?? 0, green = pixels[offset + 1] ?? 0, blue = pixels[offset + 2] ?? 0;
        if (Math.max(red, green, blue) - Math.min(red, green, blue) < 35) continue;
        count++;
        sumX += x;
        sumY += y;
      }
      resolve({ count, x: count === 0 ? 0 : sumX / count / copy.width, y: count === 0 ? 0 : sumY / count / copy.height });
    }));
  });
}

/**
 * 在页面脚本之前安装可控 Stream。模板事件进入页面后仍会按每次真实 Request 的 runId / Query
 * 重写并逐行编码，因此第二次提交走的是完整的新 Run，而不是直接改 Store 的测试后门。
 */
async function installBrowserFixture(
  page: Page,
  eventTemplates: readonly StreamEvent[],
): Promise<void> {
  await page.addInitScript((templates: readonly StreamEvent[]) => {
    type BrowserRun = {
      runId: string;
      query: string;
      language: SearchLanguage;
      engine: SearchEngine;
      fixtureIndex: number;
      nodeSearch?: unknown;
      targetNode?: { id: string; title: string; description: string };
      signal: AbortSignal;
      controller: ReadableStreamDefaultController<Uint8Array>;
      aborted: boolean;
      cancelled: boolean;
    };

    const runs: BrowserRun[] = [];
    const openCalls: BrowserOpenCall[] = [];
    const encoder = new TextEncoder();

    const sourceNodeId = templates.find(event => event.type === "node.ready")?.nodeId;
    const resourceForRun = (resource: Resource, index: number, run: BrowserRun): Resource => run.targetNode === undefined
      ? { ...resource, engine: run.engine }
      : { ...resource, engine: run.engine, title: `Node result ${run.fixtureIndex}-${index}`,
          url: `https://node-${run.fixtureIndex}.example.com/resource-${index}`,
          canonicalUrl: `https://node-${run.fixtureIndex}.example.com/resource-${index}`,
          domain: `node-${run.fixtureIndex}.example.com` };
    const eventForRun = (template: StreamEvent, run: BrowserRun): StreamEvent => {
      // 固定样例按本次请求标注模拟实际来源，生产来源仍由真实 Adapter 独立验证。
      if (template.type === "complete") {
        const base = template.data.result;
        const initial = base.graph.nodes.find(node => node.id === sourceNodeId);
        const target = run.targetNode;
        if (target !== undefined && initial === undefined) throw new Error("节点固定样例缺少来源");
        return {
          ...template, runId: run.runId,
          data: { ...template.data, ...(target === undefined ? {} : { finalStatus: "complete" as const }), result: {
            ...base, runId: run.runId,
            query: { ...base.query, raw: run.query, normalized: run.query, language: run.language },
            analysis: { ...base.analysis, ...(target === undefined ? {} : { presentationMode: "compact" as const }) },
            meta: { ...base.meta, ...(target === undefined ? {} : { partial: false }) },
            graph: target === undefined ? { ...base.graph, nodes: base.graph.nodes.map(node => ({
              ...node, resources: node.resources.map((resource, index) => resourceForRun(resource, index, run)),
            })) } : { edges: [], nodes: initial === undefined ? [] : [{
              ...initial, id: target.id, title: target.title, description: target.description || target.title,
              nodeType: "primary", layer: 0, resources: initial.resources.map((resource, index) => resourceForRun(resource, index, run)),
            }] },
          } },
        };
      }
      if (run.targetNode !== undefined && template.type === "query.analysis") return {
        ...template, runId: run.runId, data: { ...template.data, presentationMode: "compact" },
      };
      if (run.targetNode !== undefined && template.type === "graph.plan") {
        const base = template.data.nodes.find(node => node.id === sourceNodeId);
        if (base === undefined) throw new Error("节点固定样例缺少计划");
        const target = run.targetNode;
        return { ...template, runId: run.runId, data: {
          ...template.data, analysis: { ...template.data.analysis, presentationMode: "compact" },
          edges: [], nodes: [{ ...base, id: target.id, title: target.title, description: target.description || target.title, nodeType: "primary", layer: 0 }],
        } };
      }
      if (template.type === "node.ready" || template.type === "node.partial") return {
        ...template, runId: run.runId,
        nodeId: run.targetNode !== undefined && template.nodeId === sourceNodeId ? run.targetNode.id : template.nodeId,
        resources: template.resources.map((resource, index) => resourceForRun(resource, index, run)),
      };
      if (template.type === "node.status" && run.targetNode !== undefined && template.nodeId === sourceNodeId) {
        return { ...template, runId: run.runId, nodeId: run.targetNode.id };
      }
      return { ...template, runId: run.runId };
    };

    window.__WAYFINDER_E2E__ = {
      emit(targetRunIndex, eventIndexes, sourceRunIndex = targetRunIndex) {
        const target = runs[targetRunIndex];
        const source = runs[sourceRunIndex];
        if (target === undefined || source === undefined) {
          throw new Error("E2E Stream Run 索引无效");
        }
        for (const eventIndex of eventIndexes) {
          const template = templates[eventIndex];
          if (template === undefined) {
            throw new Error("E2E Stream Event 索引无效");
          }
          const event = eventForRun(template, source);
          target.controller.enqueue(
            encoder.encode(`${JSON.stringify(event)}\n`),
          );
        }
      },
      close(runIndex) {
        const run = runs[runIndex];
        if (run === undefined) throw new Error("E2E Stream Run 索引无效");
        run.controller.close();
      },
      fail(runIndex) {
        const run = runs[runIndex];
        if (run === undefined) throw new Error("固定样例运行不存在");
        run.controller.error(new Error("固定样例模拟网络失败"));
      },
      snapshots: () =>
        runs.map(run => ({
          runId: run.runId,
          query: run.query,
          language: run.language,
          engine: run.engine,
          ...(run.nodeSearch === undefined ? {} : { nodeSearch: run.nodeSearch }),
          aborted: run.aborted,
          cancelled: run.cancelled,
        })),
      openCalls: () => structuredClone(openCalls),
    };

    window.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const requestUrl =
        input instanceof Request ? input.url : input.toString();
      const url = new URL(requestUrl, window.location.href);
      if (
        url.origin !== window.location.origin ||
        url.pathname !== "/api/search"
      ) {
        throw new Error(`E2E 禁止未声明的 fetch：${url.origin}${url.pathname}`);
      }
      if (typeof init?.body !== "string") {
        throw new Error("E2E Search Request 缺少 JSON Body");
      }
      const body: unknown = JSON.parse(init.body);
      if (
        typeof body !== "object" ||
        body === null ||
        !("runId" in body) ||
        !("query" in body) ||
        !("language" in body)
      ) {
        throw new Error("E2E Search Request 不符合 Fixture 边界");
      }
      const runId = body.runId;
      const query = body.query;
      const language = body.language;
      const engine = "engine" in body ? body.engine : language === "zh-CN" ? "baidu" : "google";
      const signal = init.signal;
      if (
        typeof runId !== "string" ||
        typeof query !== "string" ||
        (language !== "zh-CN" && language !== "en-US") ||
        (engine !== "baidu" && engine !== "google") ||
        !(signal instanceof AbortSignal)
      ) {
        throw new Error("E2E Search Request 不符合 Fixture 边界");
      }

      const rawNodeSearch = "nodeSearch" in body ? body.nodeSearch : undefined;
      let targetNode: BrowserRun["targetNode"];
      if (rawNodeSearch !== undefined) {
        if (typeof rawNodeSearch !== "object" || rawNodeSearch === null || !("node" in rawNodeSearch)) throw new Error("节点请求无效");
        const node = rawNodeSearch.node;
        if (typeof node !== "object" || node === null || !("id" in node) || !("title" in node) || !("description" in node) ||
            typeof node.id !== "string" || typeof node.title !== "string" || typeof node.description !== "string") throw new Error("节点目标无效");
        targetNode = { id: node.id, title: node.title, description: node.description };
      }
      let run: BrowserRun | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          run = {
            runId,
            query,
            language,
            engine,
            fixtureIndex: runs.length,
            ...(targetNode === undefined ? {} : { targetNode, nodeSearch: rawNodeSearch }),
            signal,
            controller,
            aborted: false,
            cancelled: false,
          };
        },
        cancel() {
          if (run !== undefined) run.cancelled = true;
        },
      });
      if (run === undefined) {
        throw new Error("E2E ReadableStream 未同步初始化");
      }
      const currentRun = run;
      currentRun.signal.addEventListener(
        "abort",
        () => {
          currentRun.aborted = true;
        },
        { once: true },
      );
      runs.push(currentRun);

      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      });
    };

    window.open = ((
      url?: string | URL,
      target?: string,
      features?: string,
    ): WindowProxy | null => {
      openCalls.push([
        url?.toString() ?? "",
        target ?? "",
        features ?? "",
      ]);
      return null;
    }) as typeof window.open;
  }, eventTemplates);
}

const readFixtureSnapshots = (page: Page) =>
  page.evaluate(() => window.__WAYFINDER_E2E__.snapshots());

const emitFixtureEvents = (
  page: Page,
  targetRunIndex: number,
  eventIndexes: readonly number[],
  sourceRunIndex?: number,
) =>
  page.evaluate(
    ({ target, indexes, source }) =>
      window.__WAYFINDER_E2E__.emit(target, indexes, source),
    {
      target: targetRunIndex,
      indexes: [...eventIndexes],
      ...(sourceRunIndex === undefined ? {} : { source: sourceRunIndex }),
    },
  );

type StoredWorkspace = Readonly<{ documents: readonly EditableGraph[]; currentId: string | null }>;
type NodePosition = Readonly<{ x: number; y: number }>;

/**
 * 只通过真实 IndexedDB 边界读取持久结果；用公共 Schema 验证，绝不注入或替换 Workspace Store。
 * 测试上下文拥有独立浏览器存储，因此不会读写人员正在使用的历史记录。
 */
async function readStoredWorkspace(page: Page): Promise<StoredWorkspace | null> {
  const snapshot: unknown = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("wayfinder-workspace", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const transaction = database.transaction("workspace", "readonly");
        const request = transaction.objectStore("workspace").get("current");
        transaction.oncomplete = () => resolve(request.result ?? null);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  });
  if (snapshot === null) return null;
  if (typeof snapshot !== "object" || !("documents" in snapshot) || !("currentId" in snapshot)
    || !(snapshot.currentId === null || typeof snapshot.currentId === "string")) {
    throw new Error("浏览器持久快照格式不合法");
  }
  return { documents: EditableGraphSchema.array().parse(snapshot.documents), currentId: snapshot.currentId };
}

/** 仅为超出 AI 初稿数量的手动历史场景预置合法文档，恢复仍完全走应用的真实加载与渲染。 */
async function seedStoredWorkspace(page: Page, documents: readonly EditableGraph[]): Promise<void> {
  const validated = EditableGraphSchema.array().parse(documents);
  await page.evaluate(async graphs => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("wayfinder-workspace", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("workspace", "readwrite");
        transaction.objectStore("workspace").put({ documents: graphs, currentId: graphs[0]?.id ?? null }, "current");
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }, validated);
}

/** 读取 React Flow 的世界坐标；屏幕缩放不属于持久位置，不把截图像素误当成保存值。 */
const readInkPosition = (page: Page, nodeId = READY_NODE_ID): Promise<NodePosition> =>
  page.locator(`.react-flow__node[data-id="${nodeId}"]`).evaluate(element => {
    const transform = new DOMMatrix(getComputedStyle(element).transform);
    return { x: transform.m41, y: transform.m42 };
  });

/** 使用原生指针拖动标题，触发真实 DragStop 和持久化，不直接设置坐标。 */
async function dragInkNode(page: Page, dx: number, dy: number, nodeId = READY_NODE_ID): Promise<NodePosition> {
  const node = page.locator(`[data-ink-node="${nodeId}"]`);
  const before = await readInkPosition(page, nodeId);
  const bounds = await node.getByRole("heading").boundingBox();
  if (bounds === null) throw new Error("墨迹节点拖动起点不可见");
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => readInkPosition(page, nodeId)).not.toEqual(before);
  return readInkPosition(page, nodeId);
}

/** 精确比较同一节点的持久坐标，不以完整 Transform 字符串偶然相等替代业务位置验证。 */
async function expectInkPosition(page: Page, expected: NodePosition, nodeId = READY_NODE_ID): Promise<void> {
  await expect.poll(async () => {
    const actual = await readInkPosition(page, nodeId);
    return Math.max(Math.abs(actual.x - expected.x), Math.abs(actual.y - expected.y));
  }).toBeLessThan(0.02);
}

async function expectSavedInkPosition(page: Page, graphId: string, expected: NodePosition, nodeId = READY_NODE_ID): Promise<void> {
  await expect.poll(async () => {
    const actual = (await readStoredWorkspace(page))?.documents.find(document => document.id === graphId)?.positions[nodeId];
    return actual === undefined ? Infinity : Math.max(Math.abs(actual.x - expected.x), Math.abs(actual.y - expected.y));
  }).toBeLessThan(0.02);
}

/**
 * 从浏览器合成截图逐节点采样颜料；减弱动态时 WebGL 不连续重绘，直接读已交换缓冲会错误得到透明像素。
 * 截图包含真正显示的 GPU 输出，避免九个可读 DOM 掩盖第九个墨团被固定批次上限截断的问题。
 */
async function inkPigmentPerNode(page: Page): Promise<readonly Readonly<{ id: string; count: number }>[]> {
  const screenshot = (await page.screenshot()).toString("base64");
  return page.evaluate(async encoded => {
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const copy = document.createElement("canvas");
      copy.width = image.width; copy.height = image.height;
      const context = copy.getContext("2d");
      if (context === null) { image.close(); return []; }
      context.drawImage(image, 0, 0);
      image.close();
      const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
      return [...document.querySelectorAll<HTMLElement>("[data-ink-node]")].map(node => {
        const bounds = node.getBoundingClientRect();
        const scaleX = copy.width / innerWidth, scaleY = copy.height / innerHeight;
        const left = Math.max(0, Math.floor(bounds.x * scaleX));
        const top = Math.max(0, Math.floor(bounds.y * scaleY));
        const right = Math.min(copy.width, Math.ceil(bounds.right * scaleX));
        const bottom = Math.min(copy.height, Math.ceil(bounds.bottom * scaleY));
        let count = 0;
        for (let y = top; y < bottom; y += 3) for (let x = left; x < right; x += 3) {
          const offset = (y * copy.width + x) * 4;
          const red = pixels[offset] ?? 0, green = pixels[offset + 1] ?? 0, blue = pixels[offset + 2] ?? 0;
          if (Math.max(red, green, blue) - Math.min(red, green, blue) >= 35) count++;
        }
        return { id: node.dataset.inkNode ?? "", count };
      });
  }, screenshot);
}

type InkRaster = Readonly<{
  mask: readonly number[]; count: number; smallIslands: number;
  bodies: readonly Readonly<{ count: number; x: number; y: number }>[];
}>;

/**
 * 动效证据读取浏览器实际合成帧，不读取 Shader 参数或伪造动画状态。
 * 缩略颜料掩码排除黑白文字；独立小色块用于检查加载彩滴，帧差只证明画面仍在运动。
 */
async function captureInkRaster(page: Page, path: string, session?: CDPSession): Promise<InkRaster> {
  let screenshot: string;
  if (session === undefined) screenshot = (await page.screenshot({ path })).toString("base64");
  else {
    // 加载控件已稳定、字体已等待且无可见光标；直接保存同一视口的原生 PNG，不重复附加 action 快照。
    screenshot = (await session.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false })).data;
    await writeFile(path, Buffer.from(screenshot, "base64"));
  }
  return page.evaluate(async encoded => {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const copy = document.createElement("canvas");
    copy.width = 320; copy.height = 180;
    const context = copy.getContext("2d");
    if (context === null) { image.close(); throw new Error("无法分析 GPU 合成截图"); }
    context.drawImage(image, 0, 0, copy.width, copy.height);
    image.close();
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    const mask: number[] = [];
    for (let index = 0; index < copy.width * copy.height; index++) {
      const red = pixels[index * 4] ?? 0, green = pixels[index * 4 + 1] ?? 0, blue = pixels[index * 4 + 2] ?? 0;
      if (Math.max(red, green, blue) - Math.min(red, green, blue) >= 35) mask.push(index);
    }
    const remaining = new Set(mask);
    let smallIslands = 0;
    const bodies: Array<{ count: number; x: number; y: number }> = [];
    while (remaining.size > 0) {
      const first = remaining.values().next().value;
      if (first === undefined) break;
      const queue = [first]; remaining.delete(first);
      for (let index = 0; index < queue.length; index++) {
        const point = queue[index];
        if (point === undefined) continue;
        for (const next of [point - copy.width, point + copy.width,
          ...(point % copy.width > 0 ? [point - 1] : []), ...(point % copy.width < copy.width - 1 ? [point + 1] : [])]) {
          if (!remaining.delete(next)) continue;
          queue.push(next);
        }
      }
      if (queue.length >= 3 && queue.length <= 60) smallIslands++;
      if (queue.length >= 80) bodies.push({ count: queue.length,
        x: queue.reduce((sum, point) => sum + point % copy.width, 0) / queue.length / copy.width,
        y: queue.reduce((sum, point) => sum + Math.floor(point / copy.width), 0) / queue.length / copy.height });
    }
    return { mask, count: mask.length, smallIslands, bodies };
  }, screenshot);
}

/** 掩码差异不固定颜色或逐像素快照，保留液体表面自然变化的自由度。 */
function changedInkPixels(before: InkRaster, after: InkRaster): number {
  const first = new Set(before.mask), second = new Set(after.mask);
  return before.mask.filter(pixel => !second.has(pixel)).length + after.mask.filter(pixel => !first.has(pixel)).length;
}

/** 不同业务 ID、数量和布局的人工历史图，恢复仍走公共 Schema 与真实 IndexedDB。 */
function createWaterDocuments(): readonly EditableGraph[] {
  return [
    { id: "water-a", title: "水流历史甲", points: [[40, 40], [40, 280], [430, 280]] },
    { id: "water-b", title: "水流历史乙", points: [[420, 50], [80, 330]] },
    { id: "water-c", title: "水流历史丙", points: [[30, 70], [380, 70], [30, 340], [380, 340]] },
  ].map(({ id, title, points }) => EditableGraphSchema.parse({
    version: "workspace.v1", id, title, query: "", language: "zh-CN", presentationMode: "graph",
    analysis: null, createdAt: new Date(FIXTURE_TIME).toISOString(), updatedAt: new Date(FIXTURE_TIME).toISOString(), lastRunId: null,
    nodes: points.map((_, index) => ({ id: `${id}-${index}`, title: `${title}节点${index + 1}`,
      description: `${title}的原始说明${index + 1}`, nodeType: "primary", layer: 0, status: "empty", resources: [], warnings: [] })),
    edges: points.slice(1).map((_, index) => ({ id: `${id}-edge-${index}`, source: `${id}-${index}`, target: `${id}-${index + 1}`, type: "recommended_next" })),
    positions: Object.fromEntries(points.map((point, index) => [`${id}-${index}`, { x: point[0], y: point[1] }])),
  }));
}

/** 先在独立测试上下文准备历史，再以真实时间恢复首页；不安装或推进虚拟时钟。 */
async function prepareWaterPage(page: Page, documents = createWaterDocuments(), requireRenderer = true): Promise<readonly EditableGraph[]> {
  await installBrowserFixture(page, createInkMotionEvents());
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  await expect(page.getByRole("region", { name: "搜索历史", exact: true }).getByRole("status")).toHaveText("已保存到本浏览器");
  await seedStoredWorkspace(page, documents);
  await page.reload();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-ink-renderer", requireRenderer ? "active" : "fallback");
  return documents;
}

type WaterDragSample = Readonly<{ at: number; rafAt: number; headingX: number; headingY: number; title: string; path: string; dragging: boolean }>;

/** 可信 CDP 鼠标事件仍走真实浏览器输入，减少每个微小手势步骤重复采集 Playwright action 快照。 */
async function nativeWaterPointer(page: Page) {
  const session = await page.context().newCDPSession(page);
  let x = 0, y = 0, pressed = false;
  return {
    move: async (nextX: number, nextY: number) => {
      x = nextX; y = nextY;
      await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: pressed ? 1 : 0 });
    },
    down: async () => { pressed = true; await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }); },
    up: async () => { pressed = false; await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }); },
    afterFrame: async (nodeId: string, edgeId: string): Promise<WaterDragSample> => {
      // 输入后固定等待两个 RAF：先给 React Flow 提交，再读坐标；五步同样处理，不筛选失败帧。
      const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
        expression: `new Promise((resolve, reject) => requestAnimationFrame(() => requestAnimationFrame(rafAt => {
          const node = document.querySelector(${JSON.stringify(`[data-ink-node="${nodeId}"]`)});
          const heading = node?.querySelector("h3"), bounds = heading?.getBoundingClientRect();
          const edge = document.querySelector(${JSON.stringify(`.react-flow__edge[data-id="${edgeId}"] .react-flow__edge-path`)});
          if (bounds === undefined || edge === null) { reject(new Error("原生拖动采样缺少真实标题或边")); return; }
          resolve({ at: performance.now(), rafAt, headingX: bounds.x, headingY: bounds.y,
            title: heading.textContent ?? "", path: edge.getAttribute("d") ?? "",
            dragging: node.closest(".react-flow__node")?.classList.contains("dragging") ?? false });
        })))`,
        awaitPromise: true, returnByValue: true,
      });
      if (exceptionDetails !== undefined) throw new Error(`原生拖动采样失败：${exceptionDetails.text}`);
      return result.value as WaterDragSample;
    },
    close: async () => {
      // 仅关闭期间的协议拒绝允许忽略；上面的真实输入命令始终保留失败，不能吞掉手势错误。
      if (pressed) await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }).catch(() => undefined);
      await session.detach().catch(() => undefined);
    },
  };
}

type WaterLabel = Readonly<{ id: string; title: string; description: string; x: number; y: number; headingX: number; headingY: number; opacity: number }>;
type WaterInput = Readonly<{ at: number; x: number; y: number; buttons: number }>;
type WaterDomFrame = Readonly<{ at: number; rafAt: number; state: string; labels: readonly WaterLabel[]; pointer: WaterInput | null; edges: readonly { id: string; path: string }[] }>;
type WaterRegion = Readonly<{ id: string; x: number; y: number; width: number; height: number }>;
type WaterBody = Readonly<{ count: number; x: number; y: number; bulkWidth: number; bulkHeight: number }>;
type WaterPatchShape = Readonly<{ components: number; secondaryMass: number; fill: number }>;
type WaterPixelFrame = Readonly<{ at: number; color: number; black: number; paper: number;
  patches: readonly Readonly<{ id: string; pixels: string; shape: WaterPatchShape }>[]; bodies: readonly WaterBody[] }>;

/**
 * 所有原生帧都分析，但 JPEG 解码和像素归约移到独立 Worker 的 CPU 画布。
 * 避免在持续运行的 1M WebGL 主线程逐帧 GPU readback，把观察本身变成 30 秒超时的原因。
 */
async function decodeWaterFrames(page: Page, encoded: readonly { at: number; data: string }[], regions: readonly WaterRegion[]): Promise<readonly WaterPixelFrame[]> {
  return page.evaluate(async payload => {
    const analyze = async ({ frames, boxes, width, height }: {
      frames: readonly { at: number; data: string }[]; boxes: readonly WaterRegion[]; width: number; height: number;
    }): Promise<WaterPixelFrame[]> => {
      const result: WaterPixelFrame[] = [];
      const copy = new OffscreenCanvas(160, 90);
      const context = copy.getContext("2d", { willReadFrequently: true });
      const patch = new OffscreenCanvas(96, 64);
      const painter = patch.getContext("2d", { willReadFrequently: true });
      if (context === null || painter === null) throw new Error("无法分析 compositor 原生帧");
      for (const frame of frames) {
        const bytes = Uint8Array.from(atob(frame.data), value => value.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        context.drawImage(image, 0, 0, copy.width, copy.height);
        const data = context.getImageData(0, 0, copy.width, copy.height).data;
        const mask = new Set<number>();
        let color = 0, black = 0, paper = 0, count = 0;
        for (let y = 3; y < copy.height - 3; y++) for (let x = 3; x < copy.width - 3; x++) {
          const offset = (y * copy.width + x) * 4;
          const red = data[offset] ?? 0, green = data[offset + 1] ?? 0, blue = data[offset + 2] ?? 0;
          const high = Math.max(red, green, blue), low = Math.min(red, green, blue);
          count++;
          if (high - low >= 35) { color++; mask.add(y * copy.width + x); }
          if (high < 25) black++;
          if (low > 225 && high - low < 20) paper++;
        }
        const bodies: WaterBody[] = [];
        while (mask.size > 0) {
          const first = mask.values().next().value;
          if (first === undefined) break;
          const queue = [first]; mask.delete(first);
          const columns = new Uint16Array(copy.width), rows = new Uint16Array(copy.height);
          let sumX = 0, sumY = 0;
          for (let index = 0; index < queue.length; index++) {
            const point = queue[index];
            if (point === undefined) continue;
            const x = point % copy.width, y = Math.floor(point / copy.width);
            columns[x] = (columns[x] ?? 0) + 1; rows[y] = (rows[y] ?? 0) + 1; sumX += x; sumY += y;
            for (const next of [point - copy.width, point + copy.width, ...(x > 0 ? [point - 1] : []), ...(x < copy.width - 1 ? [point + 1] : [])]) {
              if (mask.delete(next)) queue.push(next);
            }
          }
          if (queue.length < 60) continue;
          const quantile = (histogram: Uint16Array, fraction: number): number => {
            let total = 0;
            for (let index = 0; index < histogram.length; index++) { total += histogram[index] ?? 0; if (total >= queue.length * fraction) return index; }
            return histogram.length - 1;
          };
          // 中央 60% 颜料质量不包含低质量细尾尖；用于区分整体 body 形变与固定头后只拉一根细尾。
          bodies.push({ count: queue.length, x: sumX / queue.length / copy.width, y: sumY / queue.length / copy.height,
            bulkWidth: (quantile(columns, 0.8) - quantile(columns, 0.2) + 1) / copy.width,
            bulkHeight: (quantile(rows, 0.8) - quantile(rows, 0.2) + 1) / copy.height });
        }
        const patches = boxes.map(box => {
          painter.clearRect(0, 0, patch.width, patch.height);
          painter.drawImage(image, box.x / width * image.width, box.y / height * image.height,
            box.width / width * image.width, box.height / height * image.height, 0, 0, patch.width, patch.height);
          const pixels = Array.from(painter.getImageData(0, 0, patch.width, patch.height).data);
          const pigment = new Set<number>();
          for (let index = 0; index < patch.width * patch.height; index++) {
            const rgb = pixels.slice(index * 4, index * 4 + 3);
            if (Math.max(...rgb) - Math.min(...rgb) >= 35) pigment.add(index);
          }
          // 从外侧填充背景，补平白字/材质内部小孔；只把真实外轮廓凹口和分离颜料当成形态变化。
          const outside = new Set<number>(), queue: number[] = [];
          for (let index = 0; index < patch.width * patch.height; index++) {
            const x = index % patch.width, y = Math.floor(index / patch.width);
            if ((x === 0 || y === 0 || x === patch.width - 1 || y === patch.height - 1) && !pigment.has(index)) { outside.add(index); queue.push(index); }
          }
          const neighbours = (point: number): number[] => [point - patch.width, point + patch.width,
            ...(point % patch.width > 0 ? [point - 1] : []), ...(point % patch.width < patch.width - 1 ? [point + 1] : [])];
          for (let index = 0; index < queue.length; index++) for (const next of neighbours(queue[index] ?? 0)) {
            if (next < 0 || next >= patch.width * patch.height || pigment.has(next) || outside.has(next)) continue;
            outside.add(next); queue.push(next);
          }
          const filled = new Set(Array.from({ length: patch.width * patch.height }, (_, index) => index).filter(index => !outside.has(index)));
          const pieces: Array<{ count: number; fill: number }> = [];
          while (filled.size > 0) {
            const first = filled.values().next().value;
            if (first === undefined) break;
            const points = [first]; filled.delete(first);
            let left = patch.width, right = 0, top = patch.height, bottom = 0;
            for (let index = 0; index < points.length; index++) {
              const point = points[index] ?? 0, x = point % patch.width, y = Math.floor(point / patch.width);
              left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
              for (const next of neighbours(point)) if (filled.delete(next)) points.push(next);
            }
            pieces.push({ count: points.length, fill: points.length / ((right - left + 1) * (bottom - top + 1)) });
          }
          pieces.sort((a, b) => b.count - a.count);
          const main = pieces[0];
          const significant = pieces.filter(piece => piece.count >= Math.max(4, (main?.count ?? 0) * 0.005));
          const mass = significant.reduce((sum, piece) => sum + piece.count, 0);
          // RGBA 以无损 Base64 返回，避免数百万单独 number 经 CDP 对象序列化挤占门禁预算。
          return { id: box.id, pixels: btoa(String.fromCharCode(...pixels)), shape: { components: significant.length,
            secondaryMass: mass === 0 ? 0 : 1 - (main?.count ?? 0) / mass, fill: main?.fill ?? 0 } };
        });
        image.close();
        result.push({ at: frame.at, color: color / count, black: black / count, paper: paper / count, patches, bodies });
      }
      return result;
    };
    // Worker 只执行本文件固定的分析函数，不执行网页、Provider 或外部输入中的代码。
    const source = `self.onmessage=async event=>{try{self.postMessage({pixels:await (${analyze.toString()})(event.data)});}catch(error){self.postMessage({error:String(error)});}};`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url);
    try {
      return await new Promise<WaterPixelFrame[]>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<{ pixels?: WaterPixelFrame[]; error?: string }>) => {
          if (event.data.error !== undefined) reject(new Error(event.data.error));
          else if (event.data.pixels === undefined) reject(new Error("原生帧分析没有返回结果"));
          else resolve(event.data.pixels);
        };
        worker.onerror = event => reject(new Error(event.message));
        worker.postMessage({ frames: payload.encoded, boxes: payload.regions, width: innerWidth, height: innerHeight });
      });
    } finally { worker.terminate(); URL.revokeObjectURL(url); }
  }, { encoded, regions });
}

/** 失败也要保存已收到的原生帧；兜底错误只附加证据，不覆盖原来的断言或超时失败。 */
const pendingWaterEvidence = new Map<TestInfo, Set<() => Promise<unknown>>>();
test.afterEach(async ({ page }, testInfo) => {
  const pending = pendingWaterEvidence.get(testInfo);
  if (pending === undefined) return;
  const results = await Promise.allSettled([...pending].map(stop => stop()));
  pendingWaterEvidence.delete(testInfo);
  const errors = results.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
  if (errors.length === 0) return;
  await testInfo.attach("water-evidence-teardown", { body: JSON.stringify({ pageClosed: page.isClosed(), errors }), contentType: "application/json" });
  if (testInfo.status === "passed") throw new Error(`原生动效证据未完整保存：${errors.join("；")}`);
});

/**
 * 连续证据来自原生 compositor（合成器）JPEG 与只读 DOM/事件观察，不读取或覆写 Shader 内部状态。
 * 属性观察可以抓住“把相同 width 再写一次”造成的清屏；场景切换也不得替换画布或 WebGL context。
 */
async function observeWaterMotion(page: Page, testInfo: TestInfo, name: string, regions: readonly WaterRegion[] = []) {
  const observer = await page.evaluateHandle(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".ink-study__canvas");
    if (canvas === null) throw new Error("缺少实际墨迹画布");
    const context = canvas.getContext("webgl2");
    if (context === null) throw new Error("真实时间视觉回归需要 WebGL renderer");
    const initialSize = { width: canvas.width, height: canvas.height };
    const frames: WaterDomFrame[] = [];
    const clicks: Array<{ name: string; at: number }> = [];
    const pointers: Array<{ id: string | null; at: number }> = [];
    const inputEvents: Array<{ at: number; x: number; y: number; buttons: number }> = [];
    const drags: Array<{ phase: "down" | "up"; id: string; at: number }> = [];
    const writes: Array<{ name: string | null; at: number }> = [];
    let lost = 0, restored = 0, frame = 0;
    let hovered: string | null = null;
    let dragged: string | null = null;
    let currentInput: WaterInput | null = null;
    const doc = canvas.ownerDocument;
    const onLost = (): void => { lost++; };
    const onRestored = (): void => { restored++; };
    const onClick = (event: MouseEvent): void => {
      const button = event.target instanceof Element ? event.target.closest(".ink-study__history-title") : null;
      if (button !== null) clicks.push({ name: button.textContent ?? "", at: performance.now() });
    };
    const onPointer = (event: PointerEvent): void => {
      currentInput = { at: performance.now(), x: event.clientX, y: event.clientY, buttons: event.buttons };
      inputEvents.push(currentInput);
      const node = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-ink-node]") : null;
      const id = node?.dataset.inkNode ?? null;
      if (id !== hovered) { pointers.push({ id, at: performance.now() }); hovered = id; }
    };
    const onDown = (event: PointerEvent): void => {
      const node = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-ink-node]") : null;
      dragged = node?.dataset.inkNode ?? null;
      if (dragged !== null) drags.push({ phase: "down", id: dragged, at: performance.now() });
    };
    const onUp = (): void => {
      if (dragged !== null) drags.push({ phase: "up", id: dragged, at: performance.now() });
      dragged = null;
    };
    const mutations = new MutationObserver(records => records.forEach(record => writes.push({ name: record.attributeName, at: performance.now() })));
    mutations.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("pointermove", onPointer, true);
    doc.addEventListener("pointerdown", onDown, true);
    doc.addEventListener("pointerup", onUp, true);
    const sample = (rafAt: number): void => {
      const graph = doc.querySelector(".graph-canvas--ink");
      // RAF 参数是帧开始时间，可能早于当前输入；事件对齐必须使用真正读取 DOM 的时刻。
      frames.push({ at: performance.now(), rafAt, state: graph?.getAttribute("data-ink-content-state") ?? "absent", pointer: currentInput,
        edges: [...doc.querySelectorAll(".react-flow__edge")].map(edge => ({ id: edge.getAttribute("data-id") ?? "", path: edge.querySelector(".react-flow__edge-path")?.getAttribute("d") ?? "" })),
        labels: [...doc.querySelectorAll<HTMLElement>("[data-ink-node]")].map(node => {
        const content = node.querySelector<HTMLElement>(".ink-graph-node__content");
        const bounds = content?.getBoundingClientRect();
        const heading = content?.querySelector("h3"), headingBounds = heading?.getBoundingClientRect();
        let opacity = 1;
        for (let element: Element | null = content ?? null; element !== null; element = element.parentElement) {
          const style = getComputedStyle(element);
          if (style.visibility === "hidden" || style.display === "none") opacity = 0;
          opacity *= Number(style.opacity);
        }
        return { id: node.dataset.inkNode ?? "", title: heading?.textContent ?? "", description: content?.querySelector("p")?.textContent ?? "",
          x: bounds?.x ?? 0, y: bounds?.y ?? 0, headingX: headingBounds?.x ?? 0, headingY: headingBounds?.y ?? 0, opacity };
      }) });
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    return { stop: () => {
      cancelAnimationFrame(frame); mutations.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      doc.removeEventListener("click", onClick, true);
      doc.removeEventListener("pointermove", onPointer, true);
      doc.removeEventListener("pointerdown", onDown, true);
      doc.removeEventListener("pointerup", onUp, true);
      return { frames, clicks, pointers, inputEvents, drags, writes, lost, restored, initialSize, timeOrigin: performance.timeOrigin, size: { width: canvas.width, height: canvas.height },
        sameCanvas: canvas.isConnected && doc.querySelector(".ink-study__canvas") === canvas,
        sameContext: canvas.getContext("webgl2") === context && !context.isContextLost() };
    } };
  });
  const session = await page.context().newCDPSession(page);
  const images: Array<{ at: number; data: string }> = [];
  const acknowledgmentErrors: string[] = [];
  let recording = true;
  session.on("Page.screencastFrame", event => {
    if (!recording) return;
    images.push({ at: event.metadata.timestamp ?? 0, data: event.data });
    // 关闭期间可能收到最后一帧；仅记录仍在观察时的协议错误，避免未处理的异步拒绝污染后续用例。
    void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch((error: unknown) => {
      if (recording) acknowledgmentErrors.push(String(error));
    });
  });
  const readDom = () => observer.evaluate(value => value.stop());
  const save = async () => {
    const errors: string[] = [];
    let dom: Awaited<ReturnType<typeof readDom>> | undefined;
    try {
      await session.send("Page.stopScreencast");
      recording = false;
      dom = await readDom();
    } catch (error: unknown) { errors.push(String(error)); }
    finally {
      recording = false;
      // Node 已收到的图片先落盘；之后即使 Page/context 已关闭，最关键的黑屏帧也不会丢。
      await Promise.all(images.map((image, index) => writeFile(testInfo.outputPath(`${name}-compositor-${String(index).padStart(3, "0")}.jpeg`), Buffer.from(image.data, "base64"))));
      await session.detach().catch((error: unknown) => errors.push(String(error)));
      await observer.dispose().catch((error: unknown) => errors.push(String(error)));
      await writeFile(testInfo.outputPath(`${name}-raw-dom.json`), JSON.stringify({ ...(dom ?? {}), acknowledgmentErrors, errors, imageCount: images.length }, null, 2));
    }
    if (dom === undefined || errors.length > 0) throw new Error(`动效观察收尾失败：${errors.join("；")}`);
    const pixels = await decodeWaterFrames(page, images, regions);
    await writeFile(testInfo.outputPath(`${name}-evidence.json`), JSON.stringify({ ...dom, acknowledgmentErrors, pixels }, null, 2));
    return { ...dom, acknowledgmentErrors, pixels };
  };
  let stopped: ReturnType<typeof save> | undefined;
  const stop = (): ReturnType<typeof save> => {
    stopped ??= save().finally(() => { pendingWaterEvidence.get(testInfo)?.delete(stop); });
    return stopped;
  };
  const pending = pendingWaterEvidence.get(testInfo) ?? new Set<() => Promise<unknown>>();
  pending.add(stop); pendingWaterEvidence.set(testInfo, pending);
  await session.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 640, maxHeight: 360, everyNthFrame: 1 });
  return { frameCount: () => images.length, sampleLatest: (count = 2) => decodeWaterFrames(page, images.slice(-count), regions), stop };
}

type WaterEvidence = Awaited<ReturnType<Awaited<ReturnType<typeof observeWaterMotion>>["stop"]>>;

function expectWaterContinuity(evidence: WaterEvidence): void {
  expect(evidence.sameCanvas).toBe(true);
  expect(evidence.sameContext).toBe(true);
  expect(evidence.size).toEqual(evidence.initialSize);
  expect(evidence.writes).toEqual([]);
  expect(evidence.lost).toBe(0);
  expect(evidence.restored).toBe(0);
  expect(evidence.acknowledgmentErrors).toEqual([]);
  expect(evidence.pixels.length).toBeGreaterThan(5);
  for (const frame of evidence.pixels) {
    expect(frame.color).toBeGreaterThan(0.003);
    expect(frame.color).toBeLessThan(0.8);
    expect(frame.black).toBeLessThan(0.8);
    expect(frame.paper).toBeLessThan(0.9995);
  }
}

async function selectWaterHistory(page: Page, title: string): Promise<void> {
  const toggle = page.getByRole("button", { name: "搜索历史", exact: true });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.press("Enter");
  await page.getByRole("region", { name: "搜索历史", exact: true }).getByRole("button", { name: title, exact: true }).press("Enter");
  // 只等本次选择意图提交并收起菜单；不能把下一次 open 错当作尚未收起菜单的 close。
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
}

/** 快切只省略工具快照；focus/菜单状态仍由真实 DOM 决定，激活始终使用可信原生 Enter。 */
async function interruptWaterHistory(page: Page, first: string, last: string): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const focus = async (title: string | null, open: boolean): Promise<void> => {
    const locate = (name: string | null, expanded: boolean) => new Promise<boolean>((resolve, reject) => {
      const deadline = performance.now() + 1000;
      const check = (): void => {
        const toggle = document.querySelector<HTMLButtonElement>(".ink-study__history-toggle");
        const button = name === null ? toggle : [...document.querySelectorAll<HTMLButtonElement>(".ink-study__history-title")].find(element => element.textContent === name);
        if (toggle?.getAttribute("aria-expanded") === String(expanded) && button !== undefined && button !== null && !button.disabled && button.closest("[inert]") === null) {
          button.focus(); resolve(true); return;
        }
        if (performance.now() >= deadline) { reject(new Error("历史状态未提交，不能注入下一次选择")); return; }
        requestAnimationFrame(check);
      };
      check();
    });
    const result = await session.send("Runtime.evaluate", { expression: `(${locate.toString()})(${JSON.stringify(title)},${open})`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails !== undefined || result.result.value !== true) throw new Error("原生历史键盘输入未能获得真实焦点");
  };
  const enter = async (): Promise<void> => {
    // 同一 CDP 通道按发送顺序处理 down/up，成对发送避免逐 action 的截图等待。
    const down = session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
    const up = session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await Promise.all([down, up]);
  };
  try {
    await focus(null, false); await enter(); await focus(first, true); await enter();
    await focus(null, false); await enter(); await focus(last, true); await enter();
  } finally { await session.detach(); }
}

async function expectWaterReady(page: Page, target: EditableGraph): Promise<void> {
  const node = target.nodes[0];
  if (node === undefined) throw new Error("固定样例缺少目标节点");
  await expect(page.locator(`[data-ink-node="${node.id}"]`)).toHaveCount(1);
  await expect(page.locator(".graph-canvas--ink")).toHaveAttribute("data-ink-content-state", "ready");
}

/**
 * 虚拟时钟只用于旧关键帧用例：先逐 RAF 完成布局测量，以 renderer 宣告 moving 的实际时刻为飞行原点。
 * 上限 16 帧；没有 start 必须失败，不能任意加长末态等待掩盖一直 measuring 的交互锁。
 */
async function advanceInkTransferStart(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const samples: Array<{ at: number; state: string | null; inert: boolean }> = [];
  for (let index = 0; index < 16; index++) {
    const sample = await page.locator(".graph-canvas--ink").evaluate(element => ({
      at: performance.now(), state: element.getAttribute("data-ink-content-state"), inert: element.closest("[inert]") !== null,
    }));
    samples.push(sample);
    if (sample.state === "moving") {
      await writeFile(testInfo.outputPath(`${name}-transfer-origin.json`), JSON.stringify(samples, null, 2));
      return;
    }
    expect(sample.state).toBe("measuring");
    expect(sample.inert).toBe(true);
    if (index === 0) {
      expect((await captureInkRaster(page, testInfo.outputPath(`${name}-measuring.png`))).count).toBeGreaterThan(30);
      await page.keyboard.press("Tab");
      expect(await page.locator(".ink-study__graph").evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(false);
    }
    await page.clock.runFor(16);
  }
  await writeFile(testInfo.outputPath(`${name}-transfer-origin.json`), JSON.stringify(samples, null, 2));
  throw new Error("16 个布局帧内未收到真实 transfer-start");
}

/** 历史和首页切换必须连续绘制；任何一次相同尺寸重写也会被属性观察捕获。 */
test("真实时间首页与异ID历史切换连续绘制且不重置画布和上下文", async ({ page }, testInfo) => {
  const documents = await prepareWaterPage(page);
  const first = documents[0], second = documents[1];
  if (first === undefined || second === undefined) throw new Error("缺少异 ID 历史固定样例");
  const probe = await observeWaterMotion(page, testInfo, "water-scene-continuity");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  await expectWaterReady(page, first);
  await expect(page.locator("[data-ink-node]:visible")).toHaveCount(first.nodes.length);
  await page.getByRole("button", { name: "返回首页", exact: true }).click();
  await expect(page.getByRole("button", { name: "开始探索", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  await expectWaterReady(page, first);
  await selectWaterHistory(page, second.title);
  await expectWaterReady(page, second);
  await expect(page.locator("[data-ink-node]:visible")).toHaveCount(second.nodes.length);
  const evidence = await probe.stop();
  expectWaterContinuity(evidence);
  expect((await readStoredWorkspace(page))?.currentId).toBe(second.id);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

/** 迁移过程保留源文案并沿屏幕路径移动，到位才换目标；快速反向选择不能让旧 generation 回写。 */
test("真实时间异ID历史先搬源文字再换目标，快速连续切图仅保留最后一图", async ({ page }, testInfo) => {
  const documents = await prepareWaterPage(page);
  const first = documents[0], second = documents[1], third = documents[2];
  if (first === undefined || second === undefined || third === undefined) throw new Error("缺少连续切换固定样例");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  await expectWaterReady(page, first);
  const probe = await observeWaterMotion(page, testInfo, "water-history-labels");
  await selectWaterHistory(page, second.title);
  await expectWaterReady(page, second);
  const secondTargets = await page.locator("[data-ink-node]").evaluateAll(elements => elements.map(node => {
    const content = node.querySelector(".ink-graph-node__content");
    const bounds = content?.getBoundingClientRect();
    return { id: node.getAttribute("data-ink-node"), x: bounds?.x ?? 0, y: bounds?.y ?? 0 };
  }));
  for (const node of second.nodes) {
    await expect(page.locator(`[data-ink-node="${node.id}"] h3`)).toHaveText(node.title);
    await expect(page.locator(`[data-ink-node="${node.id}"] p`)).toHaveText(node.description);
  }
  await selectWaterHistory(page, first.title);
  await expectWaterReady(page, first);
  // 键盘标题操作不等待抽屉 CSS 稳定，确实让两个选择意图在同一过渡内相继到达。
  await interruptWaterHistory(page, second.title, third.title);
  await expectWaterReady(page, third);
  const evidence = await probe.stop();
  expectWaterContinuity(evidence);
  const firstSecondClick = evidence.clicks.find(click => click.name === second.title);
  const returnClick = evidence.clicks.find(click => click.name === first.title);
  const finalSecondClick = evidence.clicks.filter(click => click.name === second.title).at(-1);
  const finalThirdClick = evidence.clicks.find(click => click.name === third.title);
  if (firstSecondClick === undefined || returnClick === undefined || finalSecondClick === undefined || finalThirdClick === undefined) throw new Error("缺少真实标题点击时间线");
  const moving = evidence.frames.filter(frame => frame.at >= firstSecondClick.at && frame.at < returnClick.at && frame.state === "moving");
  const visibleMoving = moving.flatMap(frame => frame.labels.filter(label => label.opacity > 0.05));
  expect(visibleMoving.length).toBeGreaterThan(0);
  const sources = new Map(first.nodes.map(node => [node.title, node.description]));
  const targetLabels = new Map(second.nodes.map(node => [node.title, node.description]));
  for (const frame of evidence.frames.filter(frame => frame.at >= firstSecondClick.at && frame.at < returnClick.at)) {
    for (const label of frame.labels.filter(label => label.opacity > 0.05 && targetLabels.has(label.title))) {
      expect(frame.state).toBe("ready");
      expect(label.description).toBe(targetLabels.get(label.title));
    }
  }
  for (const frame of moving) {
    const labels = frame.labels.filter(label => label.opacity > 0.05);
    expect(new Set(labels.map(label => label.title)).size).toBe(labels.length);
    for (const label of labels) expect(sources.get(label.title)).toBe(label.description);
  }
  const initial = evidence.frames.find(frame => frame.at < firstSecondClick.at && frame.state === "ready");
  if (initial === undefined) throw new Error("缺少源图稳定帧");
  expect(visibleMoving.some(label => {
    const start = initial.labels.find(source => source.title === label.title);
    const end = secondTargets.find(target => target.id === label.id);
    return start !== undefined && end !== undefined && Math.hypot(label.x - start.x, label.y - start.y) > 8 && Math.hypot(label.x - end.x, label.y - end.y) > 8;
  })).toBe(true);
  expect(finalThirdClick.at - finalSecondClick.at).toBeLessThan(860);
  expect(evidence.frames.filter(frame => frame.at >= finalThirdClick.at).flatMap(frame => frame.labels)
    .filter(label => label.opacity > 0.05 && targetLabels.has(label.title))).toEqual([]);
  expect(await visibleInkNodeIds(page)).toEqual(third.nodes.map(node => node.id).sort());
  for (const node of third.nodes) await expect(page.locator(`[data-ink-node="${node.id}"] h3`)).toHaveText(node.title);
  const saved = await readStoredWorkspace(page);
  expect(saved?.currentId).toBe(third.id);
  expect(saved?.documents).toEqual(documents);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

/** 局部拨散以自身基线和远处节点作对照，不与独立拖动风险共用 30 秒测试预算。 */
test("真实时间hover拨散当前节点颜料后自然聚回，不改变文字布局与存储", async ({ page }, testInfo) => {
  const documents = await prepareWaterPage(page);
  const document = documents[0], active = document?.nodes[0], control = document?.nodes[2];
  if (document === undefined || active === undefined || control === undefined) throw new Error("缺少局部水波固定样例");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  await expectWaterReady(page, document);
  const before = await readStoredWorkspace(page);
  const positions = await Promise.all(document.nodes.map(async node => ({ id: node.id, position: await readInkPosition(page, node.id) })));
  const boxes = await Promise.all([active, control].map(async node => {
    const bounds = await page.locator(`[data-ink-node="${node.id}"]`).boundingBox();
    if (bounds === null) throw new Error("水波对照节点不可见");
    return { id: node.id, x: bounds.x - 96, y: bounds.y - 96, width: bounds.width + 192, height: bounds.height + 192 };
  }));
  const hover = await observeWaterMotion(page, testInfo, "water-local-hover", boxes);
  await expect.poll(hover.frameCount).toBeGreaterThanOrEqual(3);
  const baselinePixels = await hover.sampleLatest(3);
  const baselineShapes = baselinePixels.map(frame => frame.patches.find(patch => patch.id === active.id)?.shape).filter((shape): shape is WaterPatchShape => shape !== undefined);
  if (baselineShapes.length === 0) throw new Error("缺少拨散前主体形态");
  const baselineShape = { fill: baselineShapes.reduce((sum, shape) => sum + shape.fill, 0) / baselineShapes.length,
    secondaryMass: Math.max(...baselineShapes.map(shape => shape.secondaryMass)), components: Math.max(...baselineShapes.map(shape => shape.components)) };
  const topMaterial = (frame: WaterPixelFrame) => [...frame.bodies].filter(body => body.count >= 200).sort((a, b) => a.y - b.y)[0];
  const baselineBodies = baselinePixels.map(topMaterial).filter((body): body is WaterBody => body !== undefined);
  if (baselineBodies.length === 0) throw new Error("缺少拨散前材料位置");
  const baselineMaterial = { x: baselineBodies.reduce((sum, body) => sum + body.x, 0) / baselineBodies.length,
    y: baselineBodies.reduce((sum, body) => sum + body.y, 0) / baselineBodies.length,
    width: baselineBodies.reduce((sum, body) => sum + body.bulkWidth, 0) / baselineBodies.length,
    height: baselineBodies.reduce((sum, body) => sum + body.bulkHeight, 0) / baselineBodies.length };
  const region = await page.locator(`[data-ink-node="${active.id}"]`).boundingBox();
  if (region === null) throw new Error("缺少真实拨动区域");
  // 材料按真实扫动注能：跨过节点内部的短曲线，而不是停在上面持续施加一枚 hover 波纹。
  const pointer = await nativeWaterPointer(page);
  try {
    let previous = { x: region.x + region.width * 0.15, y: region.y + region.height * 0.45 };
    await pointer.move(previous.x, previous.y);
    for (const [x, y] of [[0.35, 0.25], [0.55, 0.7], [0.8, 0.4]] as const) {
      const next = { x: region.x + region.width * x, y: region.y + region.height * y };
      for (let step = 1; step <= 3; step++) await pointer.move(previous.x + (next.x - previous.x) * step / 3, previous.y + (next.y - previous.y) * step / 3);
      previous = next;
    }
    const during = hover.frameCount();
    await expect.poll(hover.frameCount).toBeGreaterThanOrEqual(during + 3);
    await pointer.move(1180, 260);
  } finally { await pointer.close(); }
  const leaving = hover.frameCount();
  await expect.poll(hover.frameCount).toBeGreaterThanOrEqual(leaving + 2);
  let recoveredFrameAt = Number.POSITIVE_INFINITY;
  const materialRecovered = (frame: WaterPixelFrame): boolean => {
    const shape = frame.patches.find(patch => patch.id === active.id)?.shape, body = topMaterial(frame);
    return shape !== undefined && body !== undefined && shape.fill >= baselineShape.fill - 0.06 && shape.secondaryMass < baselineShape.secondaryMass + 0.02 && shape.components <= baselineShape.components + 1
      && Math.abs(body.x - baselineMaterial.x) < 0.025 && Math.abs(body.y - baselineMaterial.y) < 0.025
      && Math.abs(body.bulkWidth / baselineMaterial.width - 1) < 0.18 && Math.abs(body.bulkHeight / baselineMaterial.height - 1) < 0.18;
  };
  // 以原生帧中的集中度/外轮廓回近自身基线判断聚回，最多 4 秒；不靠一段固定 sleep 假设材料已经恢复。
  await expect.poll(async () => {
    const frames = await hover.sampleLatest(3);
    const ready = frames.length === 3 && frames.every(materialRecovered);
    if (ready) recoveredFrameAt = frames[0]?.at ?? Number.POSITIVE_INFINITY;
    return ready;
  }, { timeout: 4000, intervals: [100, 200, 300] }).toBe(true);
  const afterRecovery = hover.frameCount();
  await expect.poll(hover.frameCount).toBeGreaterThanOrEqual(afterRecovery + 1);
  const hoverEvidence = await hover.stop();
  expectWaterContinuity(hoverEvidence);
  const entered = hoverEvidence.pointers.find(pointer => pointer.id === active.id);
  const exited = hoverEvidence.pointers.find(pointer => pointer.id === null && entered !== undefined && pointer.at > entered.at);
  if (entered === undefined || exited === undefined) throw new Error("缺少实际悬停与离开事件");
  const rates = hoverEvidence.pixels.slice(1).map((frame, index) => {
    const previous = hoverEvidence.pixels[index];
    if (previous === undefined) throw new Error("缺少局部帧前态");
    const difference = (id: string): number => {
      const encodedA = previous.patches.find(patch => patch.id === id)?.pixels;
      const encodedB = frame.patches.find(patch => patch.id === id)?.pixels;
      if (encodedA === undefined || encodedB === undefined) throw new Error("局部水波区域不完整");
      const a = Buffer.from(encodedA, "base64"), b = Buffer.from(encodedB, "base64");
      if (a.length !== b.length) throw new Error("局部水波区域尺寸不一致");
      const delta = a.reduce((sum, value, offset) => sum + (offset % 4 === 3 ? 0 : Math.abs(value - (b[offset] ?? 0))), 0);
      return delta / (a.length / 4 * 3 * 255) / Math.max(0.016, frame.at - previous.at);
    };
    return { at: frame.at * 1000 - hoverEvidence.timeOrigin, active: difference(active.id), control: difference(control.id) };
  });
  const baseline = rates.filter(frame => frame.at < entered.at);
  const disturbed = rates.filter(frame => frame.at >= entered.at && frame.at < exited.at);
  const recovered = rates.filter(frame => frame.at >= recoveredFrameAt * 1000 - hoverEvidence.timeOrigin);
  expect(baseline.length).toBeGreaterThan(0);
  expect(disturbed.length).toBeGreaterThan(0);
  expect(recovered.length).toBeGreaterThan(0);
  const peak = (frames: readonly { active: number; control: number }[], key: "active" | "control") => Math.max(...frames.map(frame => frame[key]));
  const metrics = { baseline: { active: peak(baseline, "active"), control: peak(baseline, "control") },
    disturbed: { active: peak(disturbed, "active"), control: peak(disturbed, "control") }, recovered: recovered.at(-1) };
  await writeFile(testInfo.outputPath("water-hover-relative-metrics.json"), JSON.stringify({ metrics, rates, entered, exited }, null, 2));
  expect(metrics.disturbed.active).toBeGreaterThan(metrics.baseline.active);
  expect(metrics.disturbed.active - metrics.baseline.active).toBeGreaterThan(Math.max(0, metrics.disturbed.control - metrics.baseline.control));
  expect(metrics.recovered?.active).toBeLessThan(metrics.disturbed.active);
  const shapeFrames = hoverEvidence.pixels.map(frame => ({ at: frame.at * 1000 - hoverEvidence.timeOrigin,
    active: frame.patches.find(patch => patch.id === active.id)?.shape, control: frame.patches.find(patch => patch.id === control.id)?.shape }));
  const shapesDuring = shapeFrames.filter(frame => frame.at >= entered.at && frame.at < exited.at);
  const lastShape = shapeFrames.at(-1)?.active;
  const shapeRange = (frames: typeof shapeFrames, key: "active" | "control") => ({
    fill: frames.reduce((sum, frame) => sum + (frame[key]?.fill ?? 0), 0) / frames.length,
    minFill: Math.min(...frames.map(frame => frame[key]?.fill ?? 1)),
    secondary: Math.max(...frames.map(frame => frame[key]?.secondaryMass ?? 0)),
  });
  const controlShapes = baselinePixels.map(frame => frame.patches.find(patch => patch.id === control.id)?.shape).filter((shape): shape is WaterPatchShape => shape !== undefined);
  if (controlShapes.length === 0) throw new Error("缺少远节点形态基线");
  const baseShape = { fill: baselineShape.fill, secondary: baselineShape.secondaryMass }, hoverShape = shapeRange(shapesDuring, "active");
  const baseControl = { fill: controlShapes.reduce((sum, shape) => sum + shape.fill, 0) / controlShapes.length, secondary: Math.max(...controlShapes.map(shape => shape.secondaryMass)) }, hoverControl = shapeRange(shapesDuring, "control");
  const split = hoverShape.secondary - baseShape.secondary;
  const indentation = baseShape.fill - hoverShape.minFill;
  const splitVisible = split > 0.02 && split > hoverControl.secondary - baseControl.secondary + 0.01;
  const notchVisible = indentation > 0.05 && indentation > baseControl.fill - hoverControl.minFill + 0.03;
  await writeFile(testInfo.outputPath("water-hover-shape-metrics.json"), JSON.stringify({ baseShape, baselineMaterial, hoverShape, baseControl, hoverControl, split, indentation, lastShape, shapeFrames }, null, 2));
  // 外轮廓凹口或显著分离质量必须增加，才能称为“拨散”；材质颜色/纹理帧差本身不能满足此门禁。
  expect(splitVisible || notchVisible).toBe(true);
  expect(lastShape).toBeDefined();
  if (splitVisible) expect(Math.abs((lastShape?.secondaryMass ?? 1) - baseShape.secondary)).toBeLessThan(split);
  if (notchVisible) expect(baseShape.fill - (lastShape?.fill ?? 0)).toBeLessThan(indentation);
  expect(hoverEvidence.pixels.slice(-3).every(materialRecovered)).toBe(true);
  for (const node of positions) await expectInkPosition(page, node.position, node.id);
  expect(await readStoredWorkspace(page)).toEqual(before);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

/** 原生曲线拖动中，文字与正式边即时跟手，GPU 只负责连续尾迹，结束坐标仍由原持久化保存。 */
test("真实时间曲线拖动文字连线跟手，首页流体尾迹连续收敛", async ({ page }, testInfo) => {
  const documents = await prepareWaterPage(page);
  const document = documents[0], active = document?.nodes[0];
  if (document === undefined || active === undefined) throw new Error("缺少连续拖动固定样例");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  await expectWaterReady(page, document);
  const positions = await Promise.all(document.nodes.map(async node => ({ id: node.id, position: await readInkPosition(page, node.id) })));
  const drag = await observeWaterMotion(page, testInfo, "water-continuous-drag");
  await expect.poll(drag.frameCount).toBeGreaterThanOrEqual(3);
  const topBody = (frame: WaterPixelFrame) => [...frame.bodies].filter(body => body.count >= 200).sort((a, b) => a.y - b.y)[0];
  const initialBodies = (await drag.sampleLatest(3)).map(topBody).filter((body): body is WaterBody => body !== undefined);
  if (initialBodies.length === 0) throw new Error("缺少拖动前主体形态");
  const initialBulk = { width: initialBodies.reduce((sum, body) => sum + body.bulkWidth, 0) / initialBodies.length,
    height: initialBodies.reduce((sum, body) => sum + body.bulkHeight, 0) / initialBodies.length,
    x: initialBodies.reduce((sum, body) => sum + body.x, 0) / initialBodies.length,
    y: initialBodies.reduce((sum, body) => sum + body.y, 0) / initialBodies.length };
  const heading = page.locator(`[data-ink-node="${active.id}"] h3`);
  const start = await heading.boundingBox();
  if (start === null) throw new Error("缺少跟手文字");
  const edge = page.locator(`.react-flow__edge[data-id="${document.id}-edge-0"] .react-flow__edge-path`);
  const originalPath = await edge.getAttribute("d");
  const x = start.x + start.width / 2, y = start.y + start.height / 2;
  const pointer = await nativeWaterPointer(page);
  const following: Array<WaterDragSample & Readonly<{ inputX: number; inputY: number }>> = [];
  try {
    await pointer.move(x, y); await pointer.down(); await pointer.move(x + 4, y);
    const route = [[45, 20], [90, 70], [150, 95], [210, 55], [260, -10]] as const;
    const gestureStarted = performance.now();
    for (const [index, [dx, dy]] of route.entries()) {
      // 保留真实 100ms 目标节奏；仅在可信输入后用原生 RAF 读坐标，不插入 Playwright 快照或截图。
      const remaining = gestureStarted + (index + 1) * 100 - performance.now();
      if (remaining > 0) await new Promise<void>(resolve => setTimeout(resolve, remaining));
      await pointer.move(x + dx, y + dy);
      following.push({ ...await pointer.afterFrame(active.id, `${document.id}-edge-0`), inputX: x + dx, inputY: y + dy });
    }
    await pointer.up();
  } finally { await pointer.close(); }
  const moved = await readInkPosition(page, active.id);
  await expectSavedInkPosition(page, document.id, moved, active.id);
  await expect.poll(async () => (await inkPigmentPerNode(page)).find(node => node.id === active.id)?.count ?? 0).toBeGreaterThan(20);
  const finalHeading = await heading.boundingBox(), viewport = page.viewportSize();
  if (finalHeading === null || viewport === null) throw new Error("松手后缺少真实节点位置");
  const target = { x: initialBulk.x + (finalHeading.x - start.x) / viewport.width,
    y: initialBulk.y + (finalHeading.y - start.y) / viewport.height };
  await expect.poll(async () => {
    const frame = (await drag.sampleLatest()).at(-1), body = frame === undefined ? undefined : topBody(frame);
    return body !== undefined && Math.abs(body.bulkWidth / initialBulk.width - 1) < 0.18 && Math.abs(body.bulkHeight / initialBulk.height - 1) < 0.18
      && Math.abs(body.x - target.x) < 0.025 && Math.abs(body.y - target.y) < 0.025;
  }, { timeout: 4000, intervals: [100, 200, 300] }).toBe(true);
  await expect.poll(async () => (await inkPigmentPerNode(page)).find(node => node.id === active.id)?.count ?? 0).toBeGreaterThan(20);
  const evidence = await drag.stop();
  expectWaterContinuity(evidence);
  const down = evidence.drags.find(event => event.phase === "down" && event.id === active.id);
  const up = evidence.drags.find(event => event.phase === "up" && event.id === active.id);
  if (down === undefined || up === undefined) throw new Error("缺少真实拖动阶段");
  // 五个输入各有提交后的只读样本，不用不同时间基准的 pointer/RAF 差值丢弃跟手失败帧。
  await writeFile(testInfo.outputPath("water-drag-following-metrics.json"), JSON.stringify({ down, up, following }, null, 2));
  expect(following).toHaveLength(5);
  expect(following.length).toBeGreaterThan(1);
  for (const frame of following) {
    expect(frame.at).toBeGreaterThanOrEqual(down.at); expect(frame.at).toBeLessThan(up.at);
    expect(frame.dragging).toBe(true);
    expect(Math.abs(frame.headingX - start.x - frame.inputX + x)).toBeLessThan(7);
    expect(Math.abs(frame.headingY - start.y - frame.inputY + y)).toBeLessThan(7);
    expect(frame.title).toBe(active.title);
    expect(frame.path).not.toBe(""); expect(frame.path).not.toBe(originalPath);
  }
  const middle = evidence.pixels.map((frame, index) => ({ at: frame.at * 1000 - evidence.timeOrigin, index }))
    .filter(frame => frame.at >= down.at && frame.at <= up.at).sort((a, b) => Math.abs(a.at - (down.at + up.at) / 2) - Math.abs(b.at - (down.at + up.at) / 2))[0];
  if (middle === undefined) throw new Error("缺少实际拖动中的合成帧");
  await copyFile(testInfo.outputPath(`water-continuous-drag-compositor-${String(middle.index).padStart(3, "0")}.jpeg`), testInfo.outputPath("water-drag-continuous-tail.jpeg"));
  const bodies = evidence.pixels.map(frame => ({ at: frame.at * 1000 - evidence.timeOrigin, body: topBody(frame) }));
  const baselineBodies = bodies.filter(frame => frame.at < down.at && frame.body !== undefined);
  const movingBodies = bodies.filter(frame => frame.at >= down.at && frame.at < up.at);
  expect(baselineBodies.length).toBeGreaterThan(0);
  expect(movingBodies.length).toBeGreaterThan(0);
  const bulkWidth = baselineBodies.reduce((sum, frame) => sum + (frame.body?.bulkWidth ?? 0), 0) / baselineBodies.length;
  const bulkHeight = baselineBodies.reduce((sum, frame) => sum + (frame.body?.bulkHeight ?? 0), 0) / baselineBodies.length;
  const baselineCount = baselineBodies.reduce((sum, frame) => sum + (frame.body?.count ?? 0), 0) / baselineBodies.length;
  const deformation = (body: WaterBody | undefined) => Math.max(Math.abs((body?.bulkWidth ?? 0) / bulkWidth - 1), Math.abs((body?.bulkHeight ?? 0) / bulkHeight - 1));
  const peakDeformation = Math.max(...movingBodies.map(frame => deformation(frame.body)));
  const last = bodies.at(-1)?.body;
  const settledDeformation = deformation(last);
  const bodyEvidence = bodies.map(frame => ({ ...frame, countRatio: (frame.body?.count ?? 0) / baselineCount }));
  await writeFile(testInfo.outputPath("water-drag-bulk-metrics.json"), JSON.stringify({ down, up, bulkWidth, bulkHeight, baselineCount, peakDeformation, settledDeformation, bodies: bodyEvidence }, null, 2));
  // 中央 60% 颜料的主体应有至少 15% 收缩或拉伸；细尾尖不能满足，主体消失也不能冒充形变。
  expect(peakDeformation).toBeGreaterThan(0.15);
  expect(settledDeformation).toBeLessThan(peakDeformation);
  for (const frame of bodyEvidence.filter(frame => frame.at >= down.at)) {
    expect(frame.body).toBeDefined(); expect(frame.countRatio).toBeGreaterThanOrEqual(0.5);
  }
  for (const node of positions.slice(1)) await expectInkPosition(page, node.position, node.id);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

test("新搜索页直接携带语言请求后端且不跳转旧展示页", async ({ page }) => {
  const events = createJourneyEvents();
  await installBrowserFixture(page, events);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");

  await expect(page.getByText("©26", { exact: true })).toHaveCount(0);
  await expect(page.getByText("浏览", { exact: true })).toHaveCount(0);
  await expect(page.getByText("移动指针，揭开灵感", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "画面导航" })).toHaveCount(0);
  await expect(page.getByText("打造属于自己的互联网", { exact: true })).toBeVisible();

  // 新入口持续保留原画布，仅在实际提交时复用搜索协调器，不跳转旧页面。
  await page.getByRole("button", { name: "语言", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.getByText("BUILD YOUR OWN INTERNET", { exact: true })).toBeVisible();
  const canvas = await page.locator(".ink-study__canvas").elementHandle();
  await page.getByRole("button", { name: "Start exploring", exact: true }).click();
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-layer", "explore");
  await expect(page.getByRole("searchbox", { name: "Search any topic", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Start exploring", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Language", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Contact author", exact: true })).toBeVisible();
  expect(await canvas?.evaluate(element => element.isConnected)).toBe(true);
  await expect(page).toHaveURL(/\/ink-study\.html$/);

  const queryInput = page.getByRole("searchbox", { name: "Search any topic" });
  await queryInput.fill("TypeScript guides");
  await queryInput.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page))[0])
    .toMatchObject({ query: "TypeScript guides", language: "en-US", engine: "google" });
  await expect(page).toHaveURL(/\/ink-study\.html$/);
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, events.map((_, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await page.reload();
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

test("开始胶囊连续伸展为搜索框并分裂按钮，品牌下移且角落控件不移动", async ({ page }) => {
  await page.goto("/ink-study.html");
  const shell = page.locator(".ink-study__search");
  const originalShell = await shell.elementHandle();
  const initialShell = await shell.boundingBox();
  const language = page.getByRole("button", { name: "语言", exact: true });
  const contact = page.getByRole("button", { name: "联系作者", exact: true });
  const initialLanguage = await language.boundingBox();
  const initialContact = await contact.boundingBox();
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await expect(input).toBeFocused();
  await input.fill("输入状态预览");
  await expect(input).toHaveValue("输入状态预览");
  const submit = page.getByRole("button", { name: "搜索", exact: true });
  await expect(submit).toBeEnabled();
  await expect(submit).toHaveText("");
  await expect.poll(async () => {
    const bounds = await submit.boundingBox();
    return bounds === null ? Infinity : Math.abs(bounds.width - bounds.height);
  }).toBeLessThan(1);
  expect(await originalShell?.evaluate(element => element.isConnected)).toBe(true);
  expect((await shell.boundingBox())?.width ?? 0).toBeGreaterThan((initialShell?.width ?? 0) * 3);
  expect(await language.boundingBox()).toEqual(initialLanguage);
  expect(await contact.boundingBox()).toEqual(initialContact);
  await expect.poll(async () => {
    const inputBox = await input.boundingBox();
    const submitBox = await page.locator(".ink-study__search-submit").boundingBox();
    return submitBox !== null && inputBox !== null ? submitBox.x - inputBox.x - inputBox.width : 0;
  }).toBeGreaterThan(8);
  await expect.poll(async () => {
    const title = await page.locator(".ink-study__wordmark").boundingBox();
    const stage = await page.locator(".ink-study__stage").boundingBox();
    return title !== null && stage !== null && title.y >= stage.y + stage.height;
  }).toBe(true);
});

test("页面中线引擎胶囊影响真实请求，语言默认与独立覆盖仍遵循原规则", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const engine = page.locator(".ink-study__engine");
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await expect(input).toBeFocused();
  await expect.poll(async () => {
    const engineBounds = await engine.boundingBox();
    const stage = await page.locator(".ink-study__stage").boundingBox();
    return engineBounds === null || stage === null ? Infinity
      : Math.abs(engineBounds.x + engineBounds.width / 2 - stage.x - stage.width / 2);
  }).toBeLessThan(1);
  await engine.getByRole("button", { name: "搜索引擎：百度", exact: true }).click();
  await engine.getByRole("button", { name: "Google", exact: true }).click();
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
  await input.fill("中文 Google");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect.poll(async () => (await readFixtureSnapshots(page))[0])
    .toMatchObject({ language: "zh-CN", engine: "google", query: "中文 Google" });

  await page.getByRole("button", { name: "语言", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  // 界面即时使用 English，但已发请求仍保留中文生成语言；取消后再改变下一次请求的引擎。
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  expect((await readFixtureSnapshots(page))[0]?.language).toBe("zh-CN");
  await expect(engine).toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(async () => (await readFixtureSnapshots(page))[0])
    .toMatchObject({ aborted: true, cancelled: true });
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await engine.getByRole("button", { name: "Search engine：Google", exact: true }).click();
  await engine.getByRole("button", { name: "Baidu", exact: true }).click();
  const nextInput = page.getByRole("searchbox", { name: "Search any topic", exact: true });
  await nextInput.fill("English Baidu");
  await nextInput.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page))[1])
    .toMatchObject({ language: "en-US", engine: "baidu", query: "English Baidu" });
  await expect.poll(async () => (await readFixtureSnapshots(page))[0]?.aborted).toBe(true);
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await page.evaluate(() => window.__WAYFINDER_E2E__.fail(1));
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await readFixtureSnapshots(page)).toHaveLength(2);
});

/** 新工作区以真实持久化文档启动，交互仍经过组件、纯编辑函数与Store，不注入业务方法。 */
function createInkWorkspaceDocument(): EditableGraph {
  const base = createWaterDocuments()[0];
  if (base === undefined) throw new Error("缺少工作区夹具");
  return EditableGraphSchema.parse({ ...base, id: "ink-workspace", title: "墨迹工作区", edges: [],
    nodes: base.nodes.map((node, index) => ({ ...node, id: `workspace-node-${index}`, title: ["资料入口", "第二节点", "第三节点"][index],
      status: index === 0 ? "edited" : "empty", resources: index === 0 ? Array.from({ length: 4 }, (_, rank) => ({
        id: `workspace-resource-${rank}`, origin: "manual", title: `资料链接 ${rank + 1}`, url: `https://workspace.example.com/${rank}`,
        canonicalUrl: `https://workspace.example.com/${rank}`, domain: "workspace.example.com", sourceType: "user_added",
        summary: "真实网页说明。".repeat(8), whySelected: "适合当前主题，作为入门资料。".repeat(4), rank: rank + 1,
      })) : [] })),
    positions: { "workspace-node-0": { x: 60, y: 80 }, "workspace-node-1": { x: 400, y: 80 }, "workspace-node-2": { x: 60, y: 330 } },
  });
}

async function openInkWorkspace(page: Page, withInk = false): Promise<EditableGraph> {
  const document = createInkWorkspaceDocument();
  // 流体本身由独立GPU旅程验证；其余功能同时覆盖真实无WebGL降级路径，避免重复采样Shader。
  if (!withInk) await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true,
      value: function (this: HTMLCanvasElement, kind: string, ...options: unknown[]): RenderingContext | null {
        return kind.includes("webgl") ? null : Reflect.apply(original, this, [kind, ...options]) as RenderingContext | null;
      },
    });
  });
  await prepareWaterPage(page, [document], withInk);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  await expect(page.locator(".graph-canvas--ink")).toHaveAttribute("data-ink-content-state", "ready");
  return document;
}

async function openInkNodeMenu(page: Page, nodeId = "workspace-node-0"): Promise<void> {
  await page.locator(`[data-ink-node="${nodeId}"]`).getByRole("heading").click({ button: "right" });
  await expect(page.getByRole("menu", { name: "图操作菜单", exact: true })).toBeVisible();
}

async function openInkUndo(page: Page): Promise<void> {
  await page.locator(".ink-study__history-dock").hover();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.getByRole("region", { name: "撤销记录", exact: true })).toBeVisible();
}

/** 视口缩放后先查真实命中空白，避免父pane上的坐标实际落在其内部节点。 */
async function openInkPaneMenu(page: Page): Promise<void> {
  const point = await page.locator(".react-flow__pane").evaluate(element => {
    const bounds = element.getBoundingClientRect();
    for (let y = bounds.top + 100; y < bounds.bottom - 80; y += 70) {
      for (let x = bounds.left + 24; x < bounds.right - 24; x += 70) {
        if (document.elementFromPoint(x, y) === element) return { x, y };
      }
    }
    throw new Error("图中没有可右键的空白命中区");
  });
  await page.mouse.click(point.x, point.y, { button: "right" });
  await expect(page.getByRole("menu", { name: "图操作菜单", exact: true })).toBeVisible();
}

/** 覆盖新资源的真实入退场、悬浮挤开、Top3和最终安全打开边界。 */
test("墨迹工作区资源条从右依次进入，悬浮展开并安全打开，外点反向收回", async ({ page }, testInfo) => {
  await openInkWorkspace(page, true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const enteredFrames = page.evaluate(() => new Promise<readonly (readonly number[])[]>((resolve, reject) => {
    const frames: number[][] = [];
    let raf = 0;
    const timeout = window.setTimeout(() => { observer.disconnect(); cancelAnimationFrame(raf); reject(new Error("资源入场未开始")); }, 5_000);
    const observer = new MutationObserver(() => {
      if (document.querySelectorAll("[data-ink-resource]").length < 2) return;
      observer.disconnect();
      const started = performance.now();
      const frame = (): void => {
        frames.push([...document.querySelectorAll("[data-ink-resource]")].slice(0, 2).map(element => element.getBoundingClientRect().x));
        if (performance.now() - started < 850) raf = requestAnimationFrame(frame);
        else { window.clearTimeout(timeout); resolve(frames); }
      };
      raf = requestAnimationFrame(frame);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }));
  await page.locator('[data-ink-node="workspace-node-0"]').getByRole("heading").click();
  const frames = await enteredFrames, startX = frames[0]?.[0], endX = frames.at(-1)?.[0];
  if (startX === undefined || endX === undefined) throw new Error("缺少资源入场帧");
  expect(startX - endX).toBeGreaterThan(80);
  expect(frames.some(frame => (frame[1] ?? 0) - (frame[0] ?? 0) > 5)).toBe(true);
  const panel = page.locator(".ink-resources");
  await expect(panel).toHaveAttribute("data-phase", "visible");
  const resources = panel.locator("[data-ink-resource]");
  await expect(resources).toHaveCount(3);
  const secondY = (await resources.nth(1).boundingBox())?.y;
  if (secondY === undefined) throw new Error("缺少第二资源条");
  await resources.first().hover();
  await expect.poll(async () => (await resources.nth(1).boundingBox())?.y ?? 0).toBeGreaterThan(secondY + 40);
  await resources.first().getByRole("button", { name: "在新标签页打开 资料链接 1" }).click();
  await resources.first().locator(".ink-resources__details h4").first().click();
  expect(await page.evaluate(() => window.__WAYFINDER_E2E__.openCalls())).toEqual(Array.from({ length: 2 }, () => ["https://workspace.example.com/0", "_blank", "noopener,noreferrer"]));
  await panel.getByRole("button", { name: "显示更多（1）" }).click();
  await expect(resources).toHaveCount(4);
  await page.screenshot({ path: testInfo.outputPath("ink-workspace-resource-strips.png") });
  await page.locator(".react-flow__pane").click({ position: { x: 22, y: 530 } });
  await expect(panel).toHaveAttribute("data-phase", "leaving");
  await expect(panel).toHaveAttribute("inert", "");
  await expect(panel).toHaveCount(0);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

/** 右键表单只提交一次，Esc先关上层，重复URL的恢复按钮可完整接收真实点击。 */
test("墨迹工作区右键编辑保留资源，Esc优先退出表单，重复URL可定位已有节点", async ({ page }) => {
  await openInkWorkspace(page);
  await openInkNodeMenu(page);
  await page.getByRole("menuitem", { name: "编辑节点", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "编辑节点", exact: true });
  await dialog.getByRole("textbox", { name: "节点标题", exact: true }).fill("新的资料入口");
  await dialog.getByRole("button", { name: "保存节点", exact: true }).click();
  await expect(page.locator('[data-ink-node="workspace-node-0"] h3')).toHaveText("新的资料入口");
  await expect(page.locator(".ink-resources [data-ink-resource]")).toHaveCount(3);
  await openInkNodeMenu(page);
  await page.getByRole("menuitem", { name: "编辑节点", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "编辑节点", exact: true });
  await dialog.getByRole("textbox", { name: "节点标题", exact: true }).fill("尚未保存");
  await dialog.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".ink-resources")).toHaveAttribute("data-phase", "visible");
  await page.getByRole("button", { name: "收起资源", exact: true }).click();
  await openInkNodeMenu(page, "workspace-node-1");
  await page.getByRole("menuitem", { name: "添加资源", exact: true }).click();
  const resourceForm = page.getByRole("dialog", { name: "添加资源", exact: true });
  await resourceForm.getByRole("textbox", { name: "资源 URL", exact: true }).fill("https://workspace.example.com/0?utm_source=duplicate#section");
  await resourceForm.getByRole("button", { name: "添加资源", exact: true }).click();
  await expect(page.locator(".ink-workspace-notice[data-open=true]")).toContainText("新的资料入口");
  await page.getByRole("button", { name: "定位已有资源所在节点", exact: true }).click();
  await expect(resourceForm).toHaveCount(0);
  await expect(page.locator(".ink-resources h2")).toHaveText("新的资料入口");
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents[0]?.nodes[0]?.resources.length).toBe(4);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

/** 逐条撤销保持后续字段修改，且撤后续事件会按较早事件不存在来重放。 */
test("墨迹工作区撤销队列保留后续改名并正确重放，支持重做及删除图恢复", async ({ page }) => {
  await openInkWorkspace(page);
  for (const title of ["中间名称", "最后名称"]) {
    await openInkNodeMenu(page);
    await page.getByRole("menuitem", { name: "编辑节点", exact: true }).click();
    const form = page.getByRole("dialog", { name: "编辑节点", exact: true });
    await form.getByRole("textbox", { name: "节点标题", exact: true }).fill(title);
    await form.getByRole("button", { name: "保存节点", exact: true }).click();
  }
  await openInkUndo(page);
  const panel = page.getByRole("region", { name: "撤销记录", exact: true });
  const first = panel.locator("[data-ink-undo-event]").filter({ hasText: "资料入口 → 中间名称" });
  await expect(first.locator("time")).toHaveAttribute("datetime", /T/);
  await first.getByRole("button", { name: /^撤销：/ }).click();
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents[0]?.nodes[0]?.title).toBe("最后名称");
  const later = panel.locator("[data-ink-undo-event]").filter({ hasText: "中间名称 → 最后名称" });
  await later.getByRole("button", { name: /^撤销：/ }).click();
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents[0]?.nodes[0]?.title).toBe("资料入口");
  await panel.getByRole("button", { name: "重做", exact: true }).click();
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents[0]?.nodes[0]?.title).toBe("最后名称");
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  await page.getByRole("button", { name: "删除记录：墨迹工作区", exact: true }).click();
  await page.locator(".ink-study__history-dock").hover();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.getByRole("button", { name: "恢复搜索图", exact: true }).click();
  await expect(page.locator('[data-ink-node="workspace-node-0"] h3')).toHaveText("最后名称");
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

/** 新建、拉线和关系菜单复用真实图约束；带资源的父节点事件不能单独撤回。 */
test("墨迹工作区空白右键新建、边缘拉线和关系编辑接入真实撤销依赖", async ({ page }) => {
  await openInkWorkspace(page);
  const before = await readInkPosition(page, "workspace-node-0");
  await page.locator(".react-flow__pane").click({ button: "right", position: { x: 650, y: 430 } });
  await page.getByRole("menuitem", { name: "新建节点", exact: true }).click();
  const form = page.getByRole("dialog", { name: "新建节点", exact: true });
  await form.getByRole("textbox", { name: "节点标题", exact: true }).fill("新建依赖节点");
  await form.getByRole("button", { name: "新建节点", exact: true }).click();
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents[0]?.nodes.length).toBe(4);
  const nodeId = (await readStoredWorkspace(page))?.documents[0]?.nodes.find(node => node.title === "新建依赖节点")?.id;
  if (nodeId === undefined) throw new Error("没有保存新节点");
  await expectInkPosition(page, before, "workspace-node-0");
  await openInkNodeMenu(page, nodeId);
  await page.getByRole("menuitem", { name: "添加资源", exact: true }).click();
  const resourceForm = page.getByRole("dialog", { name: "添加资源", exact: true });
  await resourceForm.getByRole("textbox", { name: "资源 URL", exact: true }).fill("https://new-workspace.example.com/");
  await resourceForm.getByRole("button", { name: "添加资源", exact: true }).click();
  await page.getByRole("button", { name: "收起资源", exact: true }).click();
  const source = page.locator(`[data-ink-node="${nodeId}"]`);
  await source.hover();
  const from = await source.locator('[data-handleid="main-source"]').boundingBox();
  const to = await page.locator('[data-ink-node="workspace-node-2"] [data-handleid="main-target"]').boundingBox();
  if (from === null || to === null) throw new Error("连接点没有布局");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents[0]?.edges.map(edge => edge.type)).toEqual(["recommended_next"]);
  const edgePoint = await page.locator(".react-flow__edge-path").evaluate(element => {
    const path = element as SVGPathElement, point = path.getPointAtLength(path.getTotalLength() / 2);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM() ?? undefined);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(edgePoint.x, edgePoint.y, { button: "right" });
  await page.getByRole("menuitemradio", { name: "相关", exact: true }).click();
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents[0]?.edges.map(edge => edge.type)).toEqual(["related_to"]);
  await openInkUndo(page);
  const event = page.getByRole("region", { name: "撤销记录", exact: true }).locator("[data-ink-undo-event]")
    .filter({ has: page.getByRole("heading", { name: "新建节点", exact: true }) });
  await expect(event.getByRole("button", { name: /^撤销：/ })).toBeDisabled();
  await expect(event).toContainText("依赖");
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

/** 临时请求、取消和明确应用均走既有协调器；新界面不把预览写到原图。 */
test("墨迹工作区节点重搜可取消或追加，节点引擎与原图内容保持正确", async ({ page }) => {
  await openInkWorkspace(page);
  await openInkNodeMenu(page);
  await page.getByRole("menuitemradio", { name: "Google", exact: true }).click();
  await openInkNodeMenu(page);
  await page.getByRole("menuitem", { name: "重新搜索此节点", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "重搜预览", exact: true });
  await expect(preview).toBeVisible();
  await expect.poll(async () => (await readFixtureSnapshots(page))[0]).toMatchObject({ engine: "google", language: "zh-CN", nodeSearch: { node: { id: "workspace-node-0" } } });
  await preview.getByRole("button", { name: "取消重搜", exact: true }).click();
  await expect.poll(async () => (await readFixtureSnapshots(page))[0]?.aborted).toBe(true);
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents[0]?.nodes[0]?.resources.length).toBe(4);
  await openInkNodeMenu(page);
  await page.getByRole("menuitem", { name: "重新搜索此节点", exact: true }).click();
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(2);
  const events = createInkMotionEvents();
  await emitFixtureEvents(page, 1, events.map((_event, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(1));
  await expect(preview.getByRole("button", { name: "追加到此节点", exact: true })).toBeEnabled();
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents[0]?.nodes[0]?.resources.length).toBe(4);
  await preview.getByRole("button", { name: "追加到此节点", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents[0]?.nodes[0]?.resources.length).toBe(8);
  const graph = (await readStoredWorkspace(page))?.documents[0];
  expect(graph?.nodes).toHaveLength(3);
  expect(graph?.nodes[0]?.title).toBe("资料入口");
  expect(graph?.nodes[0]?.engine).toBe("google");
  expect(graph?.edges).toEqual([]);
});

/** 窄屏保留全局控件走廊，挂起预览不丢结果，英文UI不翻译生成内容。 */
test("墨迹工作区全图重搜预览支持窄屏语言和历史挂起，明确替换后可撤销", async ({ page }, testInfo) => {
  await openInkWorkspace(page);
  await page.setViewportSize({ width: 760, height: 780 });
  await openInkPaneMenu(page);
  await page.getByRole("menuitem", { name: "重新搜索全图", exact: true }).click();
  const form = page.getByRole("dialog", { name: "重新搜索全图", exact: true });
  await form.getByRole("textbox", { name: "搜索主题", exact: true }).fill("Python预览主题");
  await form.getByRole("button", { name: "重新搜索全图", exact: true }).click();
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  const events = createInkMotionEvents();
  await emitFixtureEvents(page, 0, events.map((_event, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await page.getByRole("button", { name: "语言", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Search preview", exact: true });
  await expect(preview.getByRole("button", { name: "Apply replacement", exact: true })).toBeEnabled();
  await expect(preview.getByRole("button", { name: "Append to this node", exact: true })).toHaveCount(0);
  await preview.locator(`.react-flow__node[data-id="${READY_NODE_ID}"]`).click();
  await expect(preview.locator(".resource-card")).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath("ink-workspace-preview-narrow.png") });
  await page.getByRole("button", { name: "Search history", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await page.getByRole("region", { name: "Search history", exact: true }).press("Escape");
  await expect(preview).toBeVisible();
  // 从抽屉直接操作全局控件时，预览恢复不得抢走语言按钮的焦点并收起选项。
  await page.getByRole("button", { name: "Search history", exact: true }).click();
  const language = page.getByRole("button", { name: "Language", exact: true });
  await language.click();
  await expect(language).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(preview).toBeVisible();
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents[0]?.nodes.length).toBe(3);
  await preview.getByRole("button", { name: "Apply replacement", exact: true }).click();
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents[0]?.nodes.length).toBe(4);
  expect((await readStoredWorkspace(page))?.documents[0]?.title).toBe("墨迹工作区");
  await page.locator(".ink-study__history-dock").hover();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("region", { name: "Undo history", exact: true }).getByRole("button", { name: /^Undo[：:]/ }).click();
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents[0]?.nodes.length).toBe(3);
});

/** 已交付空图与未交付草图不同：撤首次结果、删最后节点都不能从旧Run缓存复活内容。 */
test("墨迹工作区完成图撤空和删空后保持空图，重做与恢复仍可使用", async ({ page }) => {
  await openInkWorkspace(page);
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  await page.getByRole("button", { name: "新建搜索图", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await input.fill("完成后编辑为空");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  const events = createInkMotionEvents();
  await emitFixtureEvents(page, 0, events.map((_event, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await expect(page.locator("[data-ink-node]")).toHaveCount(4);
  await openInkUndo(page);
  const panel = page.getByRole("region", { name: "撤销记录", exact: true });
  await panel.getByRole("button", { name: /^撤销：/ }).click();
  await expect(page.locator("[data-ink-node]")).toHaveCount(0);
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "graph");
  await expect(panel.getByRole("button", { name: "重做", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "重做", exact: true }).click();
  await expect(page.locator("[data-ink-node]")).toHaveCount(4);
  await panel.press("Escape");
  const plan = events.find(event => event.type === "graph.plan");
  if (plan?.type !== "graph.plan") throw new Error("缺少图计划");
  for (const node of plan.data.nodes) {
    await openInkNodeMenu(page, node.id);
    await page.getByRole("menuitem", { name: "删除节点", exact: true }).click();
  }
  await expect(page.locator("[data-ink-node]")).toHaveCount(0);
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "graph");
  await openInkUndo(page);
  await panel.locator("[data-ink-undo-event]").first().getByRole("button", { name: /^撤销：/ }).click();
  await expect(page.locator("[data-ink-node]")).toHaveCount(1);
});

/** 异步下载不拥有用户后来的普通点击；不能在新选择上弹出旧节点的菜单。 */
test("墨迹工作区右键冷加载会被随后普通点击取消", async ({ page }) => {
  await openInkWorkspace(page);
  let release = (): void => {}, requested = false;
  const moduleUrls = new Set<string>();
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/src\/design\/ink-(?:workspace-actions|research-preview)\.(?:tsx|js)(?:\?.*)?$/, async route => {
    moduleUrls.add(route.request().url());
    if (route.request().url().includes("ink-workspace-actions")) { requested = true; await gate; }
    await route.continue();
  });
  try {
    await page.locator('[data-ink-node="workspace-node-0"] h3').click({ button: "right" });
    await expect.poll(() => requested).toBe(true);
    await expect.poll(() => moduleUrls.size).toBe(2);
    await page.locator(".react-flow__pane").click({ position: { x: 22, y: 530 } });
    release();
    // 等真实模块及其预览依赖完成求值，再核对旧意图；不靠固定sleep抢在异步回调之前通过。
    await page.evaluate(async urls => { await Promise.all(urls.map(url => import(url))); },
      [...moduleUrls]);
    await expect(page.getByRole("menu", { name: "图操作菜单", exact: true })).toHaveCount(0);
    await openInkNodeMenu(page);
    await expect(page.getByRole("menuitem", { name: "编辑节点", exact: true })).toBeEnabled();
  } finally { release(); }
});

test("新搜索入口沿用 Direct 与拒绝规则，不因改版额外请求后端", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await expect(input).toBeFocused();
  await input.fill("javascript:alert(1)");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "input");
  await expect(page.getByRole("button", { name: "取消", exact: true })).toHaveCount(0);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
  await input.fill("https://example.com/docs");
  await input.press("Enter");
  expect(await page.evaluate(() => window.__WAYFINDER_E2E__.openCalls()))
    .toEqual([["https://example.com/docs", "_blank", "noopener,noreferrer"]]);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "input");
  await expect(page).toHaveURL(/\/ink-study\.html$/);
});

test("后端运行失败明确反馈且不覆盖状态文字，重试和取消继续走原协调器", async ({ page }) => {
  const failure = StreamEventSchema.parse({
    type: "run.failed", runId: "failure-template", sequence: 1, protocolVersion: "0.1",
    timestamp: new Date(FIXTURE_TIME).toISOString(), error: { code: "PLANNER_FAILED", retryable: true },
  });
  await installBrowserFixture(page, [failure]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await input.fill("计划失败固定样例");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, [0]);
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  const alert = page.getByRole("alert");
  await expect(alert).toHaveText("本次搜索未完成，请重试。");
  const statusBounds = await page.locator(".ink-study__run-status").boundingBox();
  const errorBounds = await alert.boundingBox();
  expect(errorBounds?.y ?? 0).toBeGreaterThan((statusBounds?.y ?? 0) + (statusBounds?.height ?? 0));
  await input.fill("重新尝试");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(2);
  await expect(alert).toHaveCount(0);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect.poll(async () => (await readFixtureSnapshots(page))[1]?.aborted).toBe(true);
  await expect(alert).toHaveCount(0);
});

test("冷加载期间取消会撤销合法搜索意图，恢复后无效输入和 Direct 仍零请求", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.emulateMedia({ reducedMotion: "reduce" });
  let releaseModule = (): void => {};
  let moduleRequested = false;
  const moduleGate = new Promise<void>(resolve => { releaseModule = resolve; });
  await page.route(/\/src\/api\/workspace-search\.(?:js|ts)/, async route => {
    moduleRequested = true;
    await moduleGate;
    await route.continue();
  });
  try {
    await page.goto("/ink-study.html");
    await page.getByRole("button", { name: "开始探索", exact: true }).click();
    const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
    await input.fill("应保留的合法查询");
    await input.press("Enter");
    await expect.poll(() => moduleRequested).toBe(true);
    await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "loading");
    // 输入已退出交互顺序；取消尚未导入完毕的意图，不能为下一次操作偷偷创建旧 Run。
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(input).toBeFocused();
    await input.fill("javascript:alert(1)");
    await input.press("Enter");
    await expect(page.getByRole("alert")).toBeVisible();
    await input.fill("https://example.com/docs");
    await input.press("Enter");
    expect(await readFixtureSnapshots(page)).toHaveLength(0);
    releaseModule();
    await input.fill("取消后的新查询");
    await input.press("Enter");
    await expect.poll(async () => (await readFixtureSnapshots(page))[0])
      .toMatchObject({ query: "取消后的新查询", language: "zh-CN", engine: "baidu" });
    expect(await readFixtureSnapshots(page)).toHaveLength(1);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect.poll(async () => (await readFixtureSnapshots(page))[0]?.aborted).toBe(true);
  } finally {
    releaseModule();
  }
});

test("左箭头原路返回并保留跨语言的输入和引擎选择", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.goto("/ink-study.html");
  const canvas = await page.locator(".ink-study__canvas").elementHandle();
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await expect(input).toBeFocused();
  await input.fill("保留我的输入");
  await page.getByRole("button", { name: "语言", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "Search engine：Google", exact: true }).click();
  await page.getByRole("button", { name: "Baidu", exact: true }).click();
  await page.setViewportSize({ width: 1360, height: 760 });
  await page.getByRole("button", { name: "Back to home", exact: true }).click();
  const start = page.getByRole("button", { name: "Start exploring", exact: true });
  await expect(start).toBeFocused();
  await expect(page.getByRole("button", { name: "Search history", exact: true })).toHaveCount(0);
  await expect.poll(async () => {
    const shell = await page.locator(".ink-study__search").boundingBox();
    const button = await start.boundingBox();
    return shell === null || button === null ? Infinity : Math.abs(shell.width - button.width - 2);
  }).toBeLessThan(1);
  await expect.poll(async () => {
    const title = await page.locator(".ink-study__wordmark").boundingBox();
    const stage = await page.locator(".ink-study__stage").boundingBox();
    return title === null || stage === null ? Infinity : Math.abs(title.y + title.height / 2 - stage.y - stage.height / 2);
  }).toBeLessThan(1);
  expect(await canvas?.evaluate(element => element.isConnected)).toBe(true);
  await start.click();
  await expect(page.getByRole("searchbox", { name: "Search any topic", exact: true })).toHaveValue("保留我的输入");
  await expect(page.getByRole("button", { name: "Search engine：Baidu", exact: true })).toBeVisible();
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

test("历史按钮底边悬浮稳定展开，真实历史进出与外部焦点恢复正确", async ({ page }) => {
  const events = createJourneyEvents();
  await installBrowserFixture(page, events);
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await expect(input).toBeFocused();
  await input.fill("只读历史记录样例");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, events.map((_, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await expect(page.getByRole("button", { name: "取消", exact: true })).toHaveCount(0);
  const stage = page.locator(".ink-study__stage");
  const stageBounds = await stage.boundingBox();
  if (stageBounds === null) throw new Error("缺少展示画布");
  const toggle = page.getByRole("button", { name: "搜索历史", exact: true });
  await page.mouse.move(stageBounds.x + stageBounds.width / 2, stageBounds.y + stageBounds.height - 2);
  await expect(toggle.locator("span")).toHaveCSS("opacity", "1");
  await expect(toggle).toHaveCSS("width", "114px");
  expect(await toggle.evaluate(element => element.matches(":hover"))).toBe(true);
  await page.mouse.move(0, 0);
  await expect(toggle.locator("span")).toHaveCSS("opacity", "0");
  await toggle.click();
  const panel = page.getByRole("region", { name: "搜索历史", exact: true });
  await expect(panel).toBeFocused();
  const panelColor = await panel.evaluate(element => getComputedStyle(element).backgroundColor);
  await expect(toggle).toHaveCSS("background-color", panelColor);
  await expect.poll(() => toggle.locator("svg").evaluate(element =>
    new DOMMatrix(getComputedStyle(element).transform).a)).toBeLessThan(-0.99);
  await expect(panel.getByRole("heading", { name: "只读历史记录样例", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "新建搜索图", exact: true })).toBeVisible();
  await expect(panel.getByRole("listitem").getByRole("button")).toHaveCount(3);
  await expect.poll(async () => {
    const layer = await page.locator(".ink-study__search-layer").boundingBox();
    return layer !== null && layer.y + layer.height <= stageBounds.y;
  }).toBe(true);
  expect(await stage.evaluate(element => element.scrollTop)).toBe(0);
  const language = page.getByRole("button", { name: "语言", exact: true });
  await language.click();
  await expect(panel).toHaveCount(0);
  await expect(language).toBeFocused();
  await expect(language).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await toggle.click();
  await expect(panel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await expect(page.locator(".ink-study__search-input")).toHaveValue("只读历史记录样例");
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "graph");
  await expect.poll(async () => {
    const bounds = await page.locator(".ink-study__search-layer").boundingBox();
    return bounds === null ? Infinity : Math.abs(bounds.y - stageBounds.y);
  }).toBeLessThan(1);
  expect(await readFixtureSnapshots(page)).toHaveLength(1);
});

/** 独立验证改名失败/取消分支；双图悬浮、删除和刷新仍由下一条真实连续旅程覆盖。 */
test("历史重命名拒绝空白并支持Escape，在途完成保留人工标题与原查询", async ({ page }) => {
  const events = createJourneyEvents();
  await installBrowserFixture(page, events);
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await expect(input).toBeFocused();
  await input.fill(FIRST_QUERY);
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  const panel = page.getByRole("region", { name: "搜索历史", exact: true });
  const rename = panel.getByRole("button", { name: `重命名：${FIRST_QUERY}`, exact: true });
  await rename.click();
  const name = panel.getByRole("textbox", { name: "记录名称", exact: true });
  await expect(name).toBeFocused();
  await name.fill("   ");
  await expect(panel.getByRole("button", { name: "保存名称", exact: true })).toBeDisabled();
  await name.press("Escape");
  await expect(panel).toBeVisible();
  await expect(rename).toBeFocused();
  await rename.click();
  await name.fill("Python 灵感地图");
  await name.press("Enter");
  const renamedRow = panel.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Python 灵感地图", exact: true }) });
  await expect(renamedRow.getByRole("button", { name: "重命名：Python 灵感地图", exact: true })).toBeFocused();
  await page.evaluate(indexes => {
    window.__WAYFINDER_E2E__.emit(0, indexes);
    window.__WAYFINDER_E2E__.close(0);
  }, events.map((_, index) => index));
  // 四个持久结果节点证明 complete 已真正消费，不能把改名那次“已保存”误当完成交付。
  await expect.poll(async () => {
    const document = (await readStoredWorkspace(page))?.documents[0];
    return { title: document?.title, query: document?.query, nodes: document?.nodes.length };
  }).toEqual({ title: "Python 灵感地图", query: FIRST_QUERY, nodes: 4 });
  await expect(panel.getByRole("status")).toHaveText("已保存到本浏览器");
  await expect(renamedRow).toBeVisible();
  const requests = await readFixtureSnapshots(page);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.query).toBe(FIRST_QUERY);
});

test("历史信息条重命名保留原查询，悬浮推动邻行，删除与刷新复用本地记录", async ({ page }, testInfo) => {
  const events = createJourneyEvents();
  // 同一流仍先入队全部事件再关闭；合并浏览器往返，不改变 Reader 的真实消费顺序。
  const finishRun = (run: number) => page.evaluate(({ run, indexes }) => {
    window.__WAYFINDER_E2E__.emit(run, indexes);
    window.__WAYFINDER_E2E__.close(run);
  }, { run, indexes: events.map((_, index) => index) });
  await installBrowserFixture(page, events);
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await expect(input).toBeFocused();
  await input.fill(FIRST_QUERY);
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  const toggle = page.getByRole("button", { name: "搜索历史", exact: true });
  const panel = page.getByRole("region", { name: "搜索历史", exact: true });
  await toggle.click();
  const firstRow = panel.getByRole("listitem").filter({ has: page.getByRole("heading", { name: FIRST_QUERY, exact: true }) });
  await firstRow.getByRole("button", { name: `重命名：${FIRST_QUERY}`, exact: true }).click();
  const name = panel.getByRole("textbox", { name: "记录名称", exact: true });
  await expect(name).toBeFocused();
  await name.fill("Python 灵感地图");
  await name.press("Enter");
  const renamedRow = panel.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Python 灵感地图", exact: true }) });
  await expect(renamedRow.getByRole("button", { name: "重命名：Python 灵感地图", exact: true })).toBeFocused();
  // 在途结果继续交付到同一记录，不能覆盖人工名称，也不能因改名再发请求。
  await finishRun(0);
  await expect(panel.getByRole("status")).toHaveText("已保存到本浏览器");
  await expect(renamedRow).toBeVisible();
  expect((await readFixtureSnapshots(page))[0]?.query).toBe(FIRST_QUERY);
  await panel.getByRole("button", { name: "新建搜索图", exact: true }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  expect(await readFixtureSnapshots(page)).toHaveLength(1);
  await input.fill(SECOND_QUERY);
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(2);
  await finishRun(1);
  await toggle.click();
  await expect(panel).toBeFocused();
  const rows = panel.getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await page.mouse.move(0, 0);
  // 面板可能仍在上滑，邻行位移应在同一布局坐标系比较，不能混入抽屉的屏幕位移。
  const before = await renamedRow.evaluate(element => {
    const next = element.parentElement?.children[1], bounds = element.getBoundingClientRect();
    if (!(next instanceof HTMLElement)) throw new Error("历史信息条缺少邻行");
    return { width: bounds.width, height: bounds.height, nextTop: next.offsetTop };
  });
  await renamedRow.hover({ position: { x: before.width / 2, y: 2 } });
  // 三个原条件必须在同一帧同时成立，不用连续三次自动快照拉长整个真实操作流程。
  await expect.poll(() => renamedRow.evaluate((element, before) => {
    const next = element.parentElement?.children[1];
    return { expanded: element.getBoundingClientRect().height > before.height + 8,
      pushed: next instanceof HTMLElement && next.offsetTop > before.nextTop + 8, hovered: element.matches(":hover") };
  }, before)).toEqual({ expanded: true, pushed: true, hovered: true });
  await page.screenshot({ path: testInfo.outputPath("ink-history-records.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => panel.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
  await expect(renamedRow.getByRole("button", { name: "重命名：Python 灵感地图", exact: true })).toBeVisible();
  await renamedRow.getByRole("button", { name: "删除记录：Python 灵感地图", exact: true }).click();
  await expect.poll(() => panel.evaluate(element => {
    const statuses = element.querySelectorAll('[role="status"]');
    return { rows: element.querySelectorAll("li").length, focused: element === element.ownerDocument.activeElement,
      statuses: statuses.length, status: statuses[0]?.textContent?.trim(), queries: window.__WAYFINDER_E2E__.snapshots().length };
  })).toEqual({ rows: 1, focused: true, statuses: 1, status: "已保存到本浏览器", queries: 2 });
  await page.reload();
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "graph");
  await expect(page.locator("[data-ink-node]:visible")).toHaveCount(4);
  await toggle.click();
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("heading", { name: SECOND_QUERY, exact: true })).toBeVisible();
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

test("历史新建取消本页在途搜索，保留旧记录与引擎，下一次提交才创建新图", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await page.getByRole("button", { name: "搜索引擎：百度", exact: true }).click();
  await page.getByRole("button", { name: "Google", exact: true }).click();
  await input.fill("尚未完成的图");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  const toggle = page.getByRole("button", { name: "搜索历史", exact: true });
  const panel = page.getByRole("region", { name: "搜索历史", exact: true });
  await toggle.click();
  await panel.getByRole("button", { name: "新建搜索图", exact: true }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await expect(page.getByRole("button", { name: "搜索引擎：Google", exact: true })).toBeVisible();
  await expect.poll(async () => (await readFixtureSnapshots(page))[0]?.aborted).toBe(true);
  await toggle.click();
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await expect(panel.getByRole("heading", { name: "尚未完成的图", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await input.fill("下一张独立的图");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(2);
  const runs = await readFixtureSnapshots(page);
  expect(runs[1]?.runId).not.toBe(runs[0]?.runId);
  expect(runs[1]?.engine).toBe("google");
  await toggle.click();
  await expect(panel.getByRole("listitem")).toHaveCount(2);
});

test("历史删除在途记录后，迟到完成不得复活记录或新发搜索", async ({ page }) => {
  const events = createJourneyEvents();
  await installBrowserFixture(page, events);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await input.fill("将被删除的图");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  const panel = page.getByRole("region", { name: "搜索历史", exact: true });
  await panel.getByRole("button", { name: "删除记录：将被删除的图", exact: true }).click();
  await expect(panel.getByRole("listitem")).toHaveCount(0);
  await expect(panel).toBeFocused();
  await emitFixtureEvents(page, 0, events.map((_, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await expect(panel.getByRole("status")).toHaveText("已保存到本浏览器");
  await expect(panel.getByRole("listitem")).toHaveCount(0);
  expect(await readFixtureSnapshots(page)).toHaveLength(1);
});

test("历史读取失败时禁用新建并保留原存储错误反馈", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", { value: { open: () => { throw new Error("固定的存储读取失败"); } } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  const panel = page.getByRole("region", { name: "搜索历史", exact: true });
  await expect(panel.getByRole("button", { name: "新建搜索图", exact: true })).toBeDisabled();
  await expect(panel.getByRole("alert")).toContainText("无法读取本地记录");
  await panel.getByRole("button", { name: "重试保存或读取", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("无法读取本地记录");
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

test("历史打开时返回首页会取消本页搜索但保留真实记录", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await input.fill("保留未完成记录");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  await expect(page.getByRole("region", { name: "搜索历史", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "返回首页", exact: true }).click();
  const start = page.getByRole("button", { name: "开始探索", exact: true });
  await expect(start).toBeFocused();
  await expect.poll(async () => (await readFixtureSnapshots(page))[0]?.aborted).toBe(true);
  await start.click();
  await expect(input).toHaveValue("保留未完成记录");
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  await expect(page.getByRole("region", { name: "搜索历史", exact: true })
    .getByRole("heading", { name: "保留未完成记录", exact: true })).toBeVisible();
  expect(await readFixtureSnapshots(page)).toHaveLength(1);
});

test("减弱动态时胶囊直接完成变形并聚焦输入框", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const viewport of [{ width: 390, height: 844 }, { width: 1920, height: 400 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/ink-study.html");
    await page.getByRole("button", { name: "开始探索", exact: true }).click();
    await expect(page.getByRole("searchbox", { name: "搜索任意主题", exact: true })).toBeFocused();
    await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-ready", "true");
    const title = await page.locator(".ink-study__wordmark").boundingBox();
    const stage = await page.locator(".ink-study__stage").boundingBox();
    expect(title?.y ?? 0).toBeGreaterThan((stage?.y ?? 0) + (stage?.height ?? 0));
  }
});

test("第二层的滑出与滑入均先加速后减速", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/ink-study.html");

  // 点击前安装监听，在动画创建时立即暂停并采样，慢机器也不会错过短暂的离场动画。
  await page.evaluate(() => {
    for (const selector of [".ink-study__intro", ".ink-study__back"]) {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) throw new Error("没有找到过渡元素");
      const capture = (event: TransitionEvent): void => {
        if (event.target !== element || event.propertyName !== "transform") return;
        element.removeEventListener("transitionrun", capture);
        const animation = element.getAnimations().find(candidate =>
          candidate instanceof CSSTransition && candidate.transitionProperty === "transform");
        const timing = animation?.effect?.getTiming();
        if (animation === undefined || timing === undefined || typeof timing.duration !== "number") {
          element.dataset.motionSamples = "没有找到可采样的位移动画";
          return;
        }
        animation.pause();
        const duration = timing.duration;
        const delay = timing.delay ?? 0;
        const leftAt = (fraction: number): number => {
          animation.currentTime = delay + duration * fraction;
          return element.getBoundingClientRect().left;
        };
        const start = leftAt(0);
        const end = leftAt(1);
        element.dataset.motionSamples = JSON.stringify(
          [0.25, 0.5, 0.75].map(fraction => (leftAt(fraction) - start) / (end - start)),
        );
      };
      element.addEventListener("transitionrun", capture);
    }
  });
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  for (const selector of [".ink-study__intro", ".ink-study__back"]) {
    const element = page.locator(selector);
    await expect(element).toHaveAttribute("data-motion-samples", /^\[/);
    const [quarter, middle, threeQuarters] = JSON.parse(await element.getAttribute("data-motion-samples") ?? "[]") as number[];
    expect(quarter).toBeLessThan(0.25);
    expect(middle).toBeCloseTo(0.5, 1);
    expect(threeQuarters).toBeGreaterThan(0.75);
  }
});

test("墨迹页圆角语言面板可收起，联系胶囊悬浮展开并在离开后恢复", async ({ page }) => {
  await page.goto("/ink-study.html");
  const language = page.getByRole("button", { name: "语言", exact: true });
  await language.click();
  await expect(page.getByRole("button", { name: "简体中文", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "简体中文", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(language).toBeFocused();
  await expect(language).toHaveAttribute("aria-expanded", "false");
  await language.click();
  await page.getByRole("heading", { name: "WAYFINDER", exact: true }).click({ force: true });
  await expect(language).toHaveAttribute("aria-expanded", "false");

  // 检查真实尺寸和颜色变化，避免只验证 DOM 已经包含邮箱而漏掉悬浮呈现。
  const contact = page.getByRole("button", { name: "联系作者", exact: true });
  const email = contact.getByText("cjmweb@outlook.com", { exact: true });
  const closedWidth = (await contact.boundingBox())?.width ?? 0;
  await expect(email).toHaveCSS("max-width", "0px");
  await contact.hover();
  await expect(contact).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(email).toHaveCSS("opacity", "1");
  await expect.poll(async () => (await contact.boundingBox())?.width ?? 0).toBeGreaterThan(closedWidth + 100);
  await page.mouse.move(0, 0);
  await expect(email).toHaveCSS("opacity", "0");
  await expect.poll(async () => (await contact.boundingBox())?.width ?? 0).toBeCloseTo(closedWidth, 0);
  await expect(contact).toHaveCSS("background-color", "rgb(17, 17, 17)");
});

test("联系作者点击复制真实邮箱，拒绝剪贴板权限时显示失败提示", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "联系作者", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("邮箱已复制");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("cjmweb@outlook.com");
  await expect(page.getByRole("status")).toBeEmpty();

  // 只替换拒绝路径，确认失败不会被误报为成功；真实成功路径使用上面的浏览器剪贴板。
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new DOMException("拒绝测试", "NotAllowedError"); } },
    });
  });
  await page.getByRole("button", { name: "联系作者", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("复制失败，请手动复制邮箱");
});

/** 有效请求才进入融合态；同一三个控件保留 DOM 身份，并以真实取消恢复交互。 */
test("有效搜索将三组件融合为中心停止圆，墨迹保持中心且取消中止真实运行", async ({ page }, testInfo) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await expect(input).toBeFocused();
  const shell = page.locator(".ink-study__search");
  const engine = page.locator(".ink-study__engine");
  const submit = page.locator(".ink-study__search-submit");
  const handles = await Promise.all([shell.elementHandle(), engine.elementHandle(), submit.elementHandle()]);
  const canvas = await page.locator(".ink-study__canvas").elementHandle();
  await input.fill("验证中心墨迹与取消");
  await input.press("Enter");
  const stage = page.locator(".ink-study__stage");
  const stop = page.getByRole("button", { name: "取消", exact: true });
  await expect(stage).toHaveAttribute("data-search-state", "loading");
  // 收束中仍为圆角胶囊；用实际逐帧几何防止宽输入框套百分比圆角后短暂变为椭圆。
  const capsuleFrames = await page.locator(".ink-study__search-input-shell").evaluate(async element => {
    const frames: Array<{ target: string; width: number; height: number; radius: string }> = [];
    for (let index = 0; index < 6; index++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const stop = element.closest("form")?.querySelector(".ink-study__search-stop");
      for (const target of [element, ...(stop === null || stop === undefined ? [] : [stop])]) {
        const bounds = target.getBoundingClientRect();
        frames.push({ target: target.className, width: bounds.width, height: bounds.height, radius: getComputedStyle(target).borderTopLeftRadius });
      }
    }
    return frames;
  });
  await writeFile(testInfo.outputPath("ink-loading-capsule-geometry.json"), JSON.stringify(capsuleFrames, null, 2));
  for (const frame of capsuleFrames) {
    expect(frame.radius).toMatch(/^[\d.]+px$/);
    expect(Number.parseFloat(frame.radius)).toBeGreaterThanOrEqual(Math.min(frame.width, frame.height) / 2);
  }
  await testInfo.attach("ink-loading-capsule-geometry", { body: JSON.stringify(capsuleFrames), contentType: "application/json" });
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  // 同一阶段的只读事实一次取齐，保留所有逐项断言，避免十余次自动快照拖慢真实手势。
  const loadingDom = await page.evaluate(({ handles, canvas }) => {
    const stop = document.querySelector(".ink-study__search-stop");
    const rect = stop?.querySelector("rect");
    return { stopClass: stop?.className, connected: handles.map(element => element?.isConnected), canvasConnected: canvas?.isConnected,
      controls: [".ink-study__search-input", ".ink-study__engine", ".ink-study__search-submit"].map(selector => {
        const element = document.querySelector(selector);
        return { inert: element?.getAttribute("inert"), hidden: element?.getAttribute("aria-hidden") };
      }), fill: rect === undefined || rect === null ? null : getComputedStyle(rect).fill, radius: Number(rect?.getAttribute("rx")) };
  }, { handles, canvas });
  expect(loadingDom.stopClass).toMatch(/ink-study__search-stop/);
  for (const control of loadingDom.controls) { expect(control.inert).toBe(""); expect(control.hidden).toBe("true"); }
  for (const connected of loadingDom.connected) expect(connected).toBe(true);
  expect(loadingDom.canvasConnected).toBe(true);
  await expect.poll(() => stage.evaluate(element => {
    const bounds = element.querySelector(".ink-study__search-stop")?.getBoundingClientRect(), host = element.getBoundingClientRect();
    return bounds === undefined ? Infinity : Math.max(Math.abs(bounds.width - bounds.height),
      Math.abs(bounds.x + bounds.width / 2 - host.x - host.width / 2), Math.abs(bounds.y + bounds.height / 2 - host.y - host.height / 2));
  })).toBeLessThan(2);
  expect(loadingDom.fill).toBe("rgb(255, 255, 255)");
  expect(loadingDom.radius).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("ink-loading-center.png"), animations: "disabled" });
  const loadingFrames: InkRaster[] = [];
  const captures = await page.context().newCDPSession(page);
  try {
    for (let index = 0; index < 3; index++) {
      loadingFrames.push(await captureInkRaster(page, testInfo.outputPath(`ink-loading-fluid-${index}.png`), captures));
    }
  } finally { await captures.detach(); }
  await writeFile(testInfo.outputPath("ink-loading-fluid-evidence.json"), JSON.stringify(loadingFrames.map(({ count, smallIslands, bodies }) => ({ count, smallIslands, bodies })), null, 2));
  expect(loadingFrames.some(frame => frame.smallIslands > 0)).toBe(true);

  // 将真实指针移到相反角落；可用的 GPU 画面仍应把有色颜料保持在中央区域。
  const host = await stage.boundingBox();
  if (host === null) throw new Error("缺少墨迹画布边界");
  const pigmentSamples: Array<Readonly<{ pointer: Readonly<{ x: number; y: number }>; pigment: Awaited<ReturnType<typeof inkPigmentCenter>> }>> = [];
  for (const point of [{ x: 0.08, y: 0.8 }, { x: 0.9, y: 0.15 }]) {
    await page.mouse.move(host.x + host.width * point.x, host.y + host.height * point.y);
    const pigment = await inkPigmentCenter(page);
    pigmentSamples.push({ pointer: point, pigment });
    if (pigment !== null) {
      expect(pigment.count).toBeGreaterThan(25);
      expect(Math.abs(pigment.x - 0.5)).toBeLessThan(0.22);
      expect(Math.abs(pigment.y - 0.5)).toBeLessThan(0.22);
    }
  }
  await testInfo.attach("ink-loading-pigment-center", { body: JSON.stringify(pigmentSamples), contentType: "application/json" });
  await stop.click();
  await expect.poll(async () => (await readFixtureSnapshots(page))[0])
    .toMatchObject({ aborted: true, cancelled: true });
  await expect(stage).toHaveAttribute("data-search-state", "input");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("验证中心墨迹与取消");
  await expect(page.getByRole("button", { name: "搜索", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "搜索引擎：百度", exact: true })).toBeVisible();
  await expect(page.locator("[data-ink-node]")).toHaveCount(0);
});

/**
 * 已有图的聚合和恢复复用同一画布与真实文档；视觉退场不能清空选择、改写布局或重新请求。
 * 时钟只控制抽样时刻，PNG 全部来自真实 WebGL 合成结果，不把静态截图加工成动效。
 */
test("已有图回首页聚合再分裂恢复，新建与快速逆转不丢原图坐标", async ({ page }, testInfo) => {
  const events = createInkMotionEvents();
  await installBrowserFixture(page, events);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await input.fill("液体聚合恢复的真实图");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, events.map((_, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await expect(page.locator("[data-ink-node]:visible")).toHaveCount(4);
  const moved = await dragInkNode(page, 65, -20);
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents[0]?.nodes.length).toBe(4);
  const document = (await readStoredWorkspace(page))?.documents[0];
  if (document === undefined) throw new Error("缺少待恢复的真实图");
  await expectSavedInkPosition(page, document.id, moved);
  const canvas = await page.locator(".ink-study__canvas").elementHandle();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install({ time: new Date(FIXTURE_TIME) });
  await page.clock.pauseAt(new Date(FIXTURE_TIME + 1000));
  await page.getByRole("button", { name: "返回首页", exact: true }).click();
  const frames: Array<{ phase: string; elapsed: number; count: number; bodies: InkRaster["bodies"] }> = [];
  for (const [elapsed, advance] of [[0, 0], [160, 160], [480, 320], [1000, 520]] as const) {
    if (advance > 0) await page.clock.fastForward(advance);
    const frame = await captureInkRaster(page, testInfo.outputPath(`ink-home-merge-${elapsed}.png`));
    expect(frame.count).toBeGreaterThan(30);
    frames.push({ phase: "home", elapsed, count: frame.count, bodies: frame.bodies });
  }
  await writeFile(testInfo.outputPath("ink-fluid-transition-evidence.json"), JSON.stringify(frames, null, 2));
  const initialBodies = frames[0]?.bodies.filter(body => body.count >= 300).length ?? 0;
  const mergedBodies = frames[3]?.bodies.filter(body => body.count >= 300).length ?? 0;
  expect(initialBodies).toBe(4);
  expect(initialBodies).toBeGreaterThan(mergedBodies);
  expect(mergedBodies).toBe(1);
  const start = page.getByRole("button", { name: "开始探索", exact: true });
  await expect(start).toBeFocused();
  await expect(page.locator("[data-ink-node]")).toHaveCount(0);
  expect((await readStoredWorkspace(page))?.currentId).toBe(document.id);
  await start.click();
  await advanceInkTransferStart(page, testInfo, "ink-first-restore");
  for (const [elapsed, advance] of [[0, 0], [160, 160], [480, 320], [1000, 520]] as const) {
    if (advance > 0) await page.clock.fastForward(advance);
    const frame = await captureInkRaster(page, testInfo.outputPath(`ink-explore-split-${elapsed}.png`));
    expect(frame.count).toBeGreaterThan(30);
    frames.push({ phase: "restore", elapsed, count: frame.count, bodies: frame.bodies });
    if (elapsed < 320) {
      // 恢复的透明阶段不能留下可点击或可 Tab 到达的节点和缩放控件。
      expect(await page.locator(`[data-ink-node="${READY_NODE_ID}"]`).evaluate(element => element.closest("[inert]") !== null)).toBe(true);
      expect(await page.locator(".react-flow__controls-button").first().evaluate(element => element.closest("[inert]") !== null)).toBe(true);
      await page.keyboard.press("Tab");
      expect(await page.locator(".ink-study__graph").evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(false);
    }
  }
  await writeFile(testInfo.outputPath("ink-fluid-transition-evidence.json"), JSON.stringify(frames, null, 2));
  expect(frames[7]?.bodies.filter(body => body.count >= 300)).toHaveLength(4);
  await expect(page.locator("[data-ink-node]:visible")).toHaveCount(4);
  expect(await page.locator(`[data-ink-node="${READY_NODE_ID}"]`).evaluate(element => element.closest("[inert]") !== null)).toBe(false);
  await expect.poll(() => visibleInkEdgeIds(page)).toHaveLength(4);
  await expectInkPosition(page, moved);
  await expect.poll(async () => Math.min(...(await inkPigmentPerNode(page)).map(node => node.count))).toBeGreaterThan(20);
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  await page.getByRole("region", { name: "搜索历史", exact: true })
    .getByRole("button", { name: "新建搜索图", exact: true }).press("Enter");
  const newFrame = await captureInkRaster(page, testInfo.outputPath("ink-new-search-merge-start.png"));
  expect(newFrame.count).toBeGreaterThan(30);
  await page.clock.fastForward(1000);
  const emptyFrame = await captureInkRaster(page, testInfo.outputPath("ink-new-search-merge-end.png"));
  expect(emptyFrame.count).toBeGreaterThan(30);
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "input");
  await expect(input).toHaveValue("");
  expect((await readStoredWorkspace(page))?.currentId).toBeNull();

  // 历史恢复刚开始即返回，再次进入；以最终业务实体与位置验证快速逆转没有遗失节点。
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  await page.getByRole("region", { name: "搜索历史", exact: true })
    .getByRole("button", { name: document.title, exact: true }).press("Enter");
  await advanceInkTransferStart(page, testInfo, "ink-reverse-start");
  await page.clock.fastForward(160);
  await page.getByRole("button", { name: "返回首页", exact: true }).click();
  await page.clock.fastForward(1000);
  await start.click();
  await advanceInkTransferStart(page, testInfo, "ink-final-restore");
  await page.clock.fastForward(1000);
  await expect(page.locator("[data-ink-node]:visible")).toHaveCount(4);
  await expect.poll(() => visibleInkEdgeIds(page)).toHaveLength(4);
  await expectInkPosition(page, moved);
  await expectSavedInkPosition(page, document.id, moved);
  expect((await readStoredWorkspace(page))?.currentId).toBe(document.id);
  expect(await readFixtureSnapshots(page)).toHaveLength(1);
  expect(await canvas?.evaluate(element => element.isConnected)).toBe(true);
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-ink-renderer", "active");
  await testInfo.attach("ink-fluid-transition-evidence", { body: JSON.stringify(frames), contentType: "application/json" });
  await writeFile(testInfo.outputPath("ink-fluid-transition-evidence.json"), JSON.stringify(frames, null, 2));
  await page.screenshot({ path: testInfo.outputPath("ink-rapid-reversal-restored.png") });
});

/** GPU 的液体表面允许运动，真实节点文字与连线仍固定在业务布局；拖动最终只提交一次真实坐标。 */
test("液体墨团持续变化但文字布局不漂移，拖动后落定并保存", async ({ page }, testInfo) => {
  const events = createInkMotionEvents();
  await installBrowserFixture(page, events);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await input.fill("真实液体轮廓与拖动");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, events.map((_, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await expect(page.locator("[data-ink-node]:visible")).toHaveCount(4);
  const positions = await Promise.all([READY_NODE_ID, "python-installation", "python-basics", "python-third-party-libraries"]
    .map(async id => ({ id, position: await readInkPosition(page, id) })));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const before = await captureInkRaster(page, testInfo.outputPath("ink-liquid-surface-0.png"));
  await page.evaluate(() => new Promise<void>(resolve => {
    let frames = 0;
    const next = (): void => { if (++frames >= 12) resolve(); else requestAnimationFrame(next); };
    requestAnimationFrame(next);
  }));
  const after = await captureInkRaster(page, testInfo.outputPath("ink-liquid-surface-1.png"));
  expect(changedInkPixels(before, after)).toBeGreaterThan(20);
  for (const item of positions) await expectInkPosition(page, item.position, item.id);
  const first = page.locator(`[data-ink-node="${READY_NODE_ID}"]`);
  const heading = await first.getByRole("heading").boundingBox();
  if (heading === null) throw new Error("液体节点缺少真实拖动标题");
  const x = heading.x + heading.width / 2, y = heading.y + heading.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 4, y);
  await page.mouse.move(x + 200, y, { steps: 1 });
  // 首个移动用于跨过真实拖动阈值；等待 React 提交位置再取墨团帧，不能把旧 DOM 当作跟手失败。
  await expect.poll(() => readInkPosition(page), { intervals: [16, 16, 32] }).not.toEqual(positions[0]?.position);
  const dragging = await readInkPosition(page);
  const followingFrame = await captureInkRaster(page, testInfo.outputPath("ink-liquid-drag-follow.png"));
  const movedHeading = await first.getByRole("heading").boundingBox();
  if (movedHeading === null) throw new Error("拖动后的标题未跟随指针");
  await page.mouse.up();
  await expectInkPosition(page, dragging);
  const saved = (await readStoredWorkspace(page))?.documents[0];
  if (saved === undefined) throw new Error("拖动缺少真实保存文档");
  await expectSavedInkPosition(page, saved.id, dragging);
  await expect.poll(async () => (await inkPigmentPerNode(page)).find(node => node.id === READY_NODE_ID)?.count ?? 0).toBeGreaterThan(20);
  await page.evaluate(() => new Promise<void>(resolve => {
    let frames = 0;
    const next = (): void => { if (++frames >= 12) resolve(); else requestAnimationFrame(next); };
    requestAnimationFrame(next);
  }));
  const settledFrame = await captureInkRaster(page, testInfo.outputPath("ink-liquid-drag-settled.png"));
  const topBody = (frame: InkRaster) => [...frame.bodies].filter(body => body.count >= 300).sort((a, b) => a.y - b.y)[0];
  const initialBody = topBody(after), followingBody = topBody(followingFrame), settledBody = topBody(settledFrame);
  if (initialBody === undefined || followingBody === undefined || settledBody === undefined) throw new Error("拖动质心缺少可见墨团");
  const width = page.viewportSize()?.width;
  if (width === undefined) throw new Error("缺少拖动视口尺寸");
  const domShift = (movedHeading.x - heading.x) / width;
  const followingDeficit = domShift - followingBody.x + initialBody.x;
  const settledDeficit = domShift - settledBody.x + initialBody.x;
  await writeFile(testInfo.outputPath("ink-liquid-drag-centroids.json"), JSON.stringify({
    before: after.bodies, following: followingFrame.bodies, settled: settledFrame.bodies, target: dragging,
    domShift, followingDeficit, settledDeficit,
  }, null, 2));
  // 指针与文字先走到目的地，颜料质心少走一段；随后颜料继续同向追近，而非让文字一起滞后。
  expect(followingDeficit).toBeGreaterThan(0);
  expect(settledBody.x - followingBody.x).toBeGreaterThan(0.0005);
  expect(Math.abs(settledDeficit)).toBeLessThan(Math.abs(followingDeficit) + 0.0005);
  // 其余三个真实世界坐标同时核对，精度与原逐节点轮询完全相同。
  await expect.poll(() => page.evaluate(items => Math.max(0, ...items.map(item => {
    const element = document.querySelector(`.react-flow__node[data-id="${item.id}"]`);
    if (element === null) return Infinity;
    const transform = new DOMMatrix(getComputedStyle(element).transform);
    return Math.max(Math.abs(transform.m41 - item.position.x), Math.abs(transform.m42 - item.position.y));
  })), positions.slice(1))).toBeLessThan(0.02);
  expect(await readFixtureSnapshots(page)).toHaveLength(1);
});

/** 用分支、汇合与乱序节点验证传播；状态和 complete 不得让既有节点重播或丢失正式边。 */
test("真实graph.plan在complete前按连线波次成形，状态不断流且正式边全部保留", async ({ page }, testInfo) => {
  const events = createInkMotionEvents();
  const planIndex = events.findIndex(event => event.type === "graph.plan");
  const analysisIndex = events.findIndex(event => event.type === "query.analysis");
  const plan = events[planIndex];
  const firstStatus = events.findIndex(event => event.type === "node.status" && event.nodeId === READY_NODE_ID);
  const firstReady = events.findIndex(event => event.type === "node.ready" && event.nodeId === READY_NODE_ID);
  const complete = events.findIndex(event => event.type === "complete");
  if (plan?.type !== "graph.plan" || analysisIndex < 0 || firstStatus < 0 || firstReady < 0 || complete < 0) {
    throw new Error("墨迹图夹具缺少必要事件");
  }
  await installBrowserFixture(page, events);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await expect(input).toBeFocused();
  await page.clock.install({ time: new Date(FIXTURE_TIME) });
  await page.clock.pauseAt(new Date(FIXTURE_TIME + 1000));
  await input.fill(FIRST_QUERY);
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, [analysisIndex, planIndex]);
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "graph");
  await expect(page.getByRole("button", { name: "取消", exact: true })).toHaveCount(0);
  await expect(page.locator(".ink-study__search-input")).toHaveAttribute("inert", "");
  await expect(page.locator("[data-ink-node]")).toHaveCount(4);
  expect(await visibleInkNodeIds(page)).toEqual([]);
  // 时间表使用一次性定时器；跳跃到判定点保留每个事件，省去无关的 GPU 中间帧开销。
  await page.clock.fastForward(1100);
  await expect.poll(() => visibleInkNodeIds(page)).toEqual([READY_NODE_ID]);
  expect(await visibleInkEdgeIds(page)).toEqual([]);
  // 在冻结时钟下重新选择当前图，只关闭历史；不能重新播放或提前揭示下一波节点。
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  const currentHistory = page.getByRole("region", { name: "搜索历史", exact: true });
  await expect(currentHistory).toBeFocused();
  await currentHistory.getByRole("button", { name: FIRST_QUERY, exact: true }).press("Enter");
  await expect(currentHistory).toHaveCount(0);
  expect(await visibleInkNodeIds(page)).toEqual([READY_NODE_ID]);
  expect(await visibleInkEdgeIds(page)).toEqual([]);
  expect(await readFixtureSnapshots(page)).toHaveLength(1);
  const first = page.locator(`[data-ink-node="${READY_NODE_ID}"]`);
  const firstHandle = await first.elementHandle();
  const firstBounds = await first.boundingBox();
  const planned = plan.data.nodes.find(node => node.id === READY_NODE_ID);
  if (planned === undefined || firstBounds === null) throw new Error("首个业务节点不可读取");
  await expect(first.getByRole("heading", { name: planned.title, exact: true })).toBeVisible();
  await expect(first.locator("p")).toHaveText(planned.description);
  await expect(first.getByText("主路径", { exact: true })).toBeVisible();
  await expect(first).toHaveAttribute("data-node-status", "planned");
  expect(await first.evaluate(element => ({ width: (element as HTMLElement).offsetWidth, height: (element as HTMLElement).offsetHeight })))
    .toEqual({ width: 240, height: 112 });
  // 人审图在首个墨团成形后采集，避免截图提前结束 CSS 过渡而误示尚未长成的 GPU 背景。
  await page.clock.fastForward(600);
  await page.screenshot({ path: testInfo.outputPath("ink-graph-first-wave.png"), animations: "disabled" });

  await emitFixtureEvents(page, 0, [firstStatus]);
  await expect(first).toHaveAttribute("data-node-status", "searching");
  await emitFixtureEvents(page, 0, [firstReady]);
  await expect(first).toHaveAttribute("data-node-status", "ready");
  await expect(first.getByText("4 条可用资源", { exact: true })).toBeVisible();
  expect(await firstHandle?.evaluate(element => element.isConnected)).toBe(true);
  expect(await first.boundingBox()).toEqual(firstBounds);
  const nextWave = [READY_NODE_ID, "python-installation", "python-third-party-libraries"].sort();
  await page.clock.fastForward(800);
  await expect.poll(() => visibleInkNodeIds(page)).toEqual(nextWave);
  await expect(page.locator('[data-ink-node="python-basics"]')).toHaveCSS("visibility", "hidden");
  expect(await visibleInkEdgeIds(page)).toEqual([]);
  await page.clock.fastForward(350);
  await expect.poll(() => visibleInkEdgeIds(page)).toEqual([
    "edge-introduction-installation", "edge-introduction-libraries-e2e",
  ]);

  await emitFixtureEvents(page, 0, events.flatMap((_event, index) =>
    [analysisIndex, planIndex, firstStatus, firstReady, complete].includes(index) ? [] : [index]));
  const expectedIds = plan.data.nodes.map(node => node.id).sort();
  await page.clock.fastForward(4000);
  await expect.poll(() => visibleInkNodeIds(page), { timeout: 10_000 }).toEqual(expectedIds);
  await expect.poll(() => visibleInkEdgeIds(page), { timeout: 10_000 }).toEqual(plan.data.edges.map(edge => edge.id).sort());
  await expect(page.locator(".graph-edge--recommended")).toHaveCount(2);
  await expect(page.locator(".graph-edge--related")).toHaveCount(2);
  await expect(page.locator('[data-ink-node="python-installation"]')).toHaveAttribute("data-node-status", "partial");
  await expect(page.locator('[data-ink-node="python-third-party-libraries"]')).toHaveAttribute("data-node-status", "failed");
  expect((await readFixtureSnapshots(page))[0]?.aborted).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("ink-graph-all-real-edges.png"), animations: "disabled" });

  await emitFixtureEvents(page, 0, [complete]);
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await expect(page.locator(".ink-study__run-status").getByRole("status")).toContainText("4");
  expect(await visibleInkNodeIds(page)).toEqual(expectedIds);
  expect(await firstHandle?.evaluate(element => element.isConnected)).toBe(true);
  expect(await first.boundingBox()).toEqual(firstBounds);
});

/** 冻结页面时间后只推进四帧布局，确保减弱动态不是等完正常动画才“最终通过”。 */
test("减弱动态在真实计划到达后立即显示全部节点和边而不等待生长计时器", async ({ page }, testInfo) => {
  const events = createInkMotionEvents();
  const plan = events.find(event => event.type === "graph.plan");
  if (plan?.type !== "graph.plan") throw new Error("缺少图计划");
  await installBrowserFixture(page, events);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await expect(input).toBeFocused();
  await page.clock.install({ time: new Date(FIXTURE_TIME) });
  await page.clock.pauseAt(new Date(FIXTURE_TIME + 1000));
  await input.fill("减弱动态的完整图");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, events.flatMap((event, index) =>
    event.type === "query.analysis" || event.type === "graph.plan" ? [index] : []));
  await expect(page.locator("[data-ink-node]")).toHaveCount(plan.data.nodes.length);
  await page.clock.runFor(64);
  expect(await visibleInkNodeIds(page)).toEqual(plan.data.nodes.map(node => node.id).sort());
  expect(await visibleInkEdgeIds(page)).toEqual(plan.data.edges.map(edge => edge.id).sort());
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "graph");
  // 同一 Run 已经揭示的实体保持单调；恢复动态偏好只恢复表面运动，不重藏已完成的图。
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.runFor(64);
  expect(await visibleInkNodeIds(page)).toEqual(plan.data.nodes.map(node => node.id).sort());
  expect(await visibleInkEdgeIds(page)).toEqual(plan.data.edges.map(edge => edge.id).sort());
  await page.screenshot({ path: testInfo.outputPath("ink-graph-reduced-motion.png"), animations: "disabled" });
});

/** WebGL 拒绝只影响绘制能力，不能隐藏真实节点、状态、说明或连线。 */
test("WebGL不可用时真实图仍以可读DOM降级呈现", async ({ page }, testInfo) => {
  const events = createInkMotionEvents();
  await installBrowserFixture(page, events);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: function (this: HTMLCanvasElement, kind: string, ...options: unknown[]): RenderingContext | null {
        if (kind.includes("webgl")) return null;
        return Reflect.apply(original, this, [kind, ...options]) as RenderingContext | null;
      },
    });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await input.fill("无 GPU 的图结果");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, events.map((_event, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await expect.poll(() => visibleInkNodeIds(page)).toHaveLength(4);
  await expect.poll(() => visibleInkEdgeIds(page)).toHaveLength(4);
  const first = page.locator(`[data-ink-node="${READY_NODE_ID}"]`);
  await expect(first.getByRole("heading", { name: "Python 简介", exact: true })).toBeVisible();
  await expect(first.locator("p")).toHaveText("了解 Python 的定位、核心特性与常见使用场景。");
  await expect(first).toHaveAttribute("data-node-status", "ready");
  await expect(page.locator('[data-ink-node="python-installation"]')).toHaveAttribute("data-node-status", "partial");
  await expect(page.locator('[data-ink-node="python-third-party-libraries"]')).toHaveAttribute("data-node-status", "failed");
  // 直接核对降级渐变的最弱对比，防止 DOM 存在但白字落在浅底上仍无法阅读。
  const contrast = await first.locator(".ink-graph-node__content").evaluate(element => {
    const style = getComputedStyle(element);
    const parse = (value: string): readonly number[] => [...value.matchAll(/[\d.]+/g)].map(match => Number(match[0])).slice(0, 3);
    const luminance = (rgb: readonly number[]): number => rgb.reduce((sum, channel, index) => {
      const normalized = channel / 255;
      const linear = normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      return sum + linear * ([0.2126, 0.7152, 0.0722][index] ?? 0);
    }, 0);
    const foreground = luminance(parse(style.color));
    const stops = [...style.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map(match => luminance(parse(match[0])));
    if (stops.length === 0) return 0;
    return Math.min(...stops.map(background => (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)));
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: testInfo.outputPath("ink-graph-webgl-fallback.png"), animations: "disabled" });

  // 第二个独立 Page 保留真实 WebGL，验证测量尚未 start 时丢失 context 也会结束门禁。
  // 上面的 getContext 不可用覆盖仅安装在原 Page，不替换这个真实失败事件或业务完成状态。
  const live = await page.context().newPage();
  try {
    const documents = await prepareWaterPage(live);
    const first = documents[0], second = documents[1];
    if (first === undefined || second === undefined) throw new Error("缺少 contextloss 固定样例");
    await live.getByRole("button", { name: "开始探索", exact: true }).click();
    await expectWaterReady(live, first);
    await live.getByRole("button", { name: "搜索历史", exact: true }).click();
    const hiddenTargets = await live.addStyleTag({ content: `article[data-ink-node^="${second.id}-"] { width: 0 !important; height: 0 !important; }` });
    await live.getByRole("region", { name: "搜索历史", exact: true }).getByRole("button", { name: second.title, exact: true }).click();
    const pendingTarget = live.locator(`[data-ink-node="${second.nodes[0]?.id}"]`);
    await expect(pendingTarget).toHaveCount(1);
    await expect(live.locator(".graph-canvas--ink")).toHaveAttribute("data-ink-content-state", "moving");
    const pendingLayout = await pendingTarget.evaluate(article => ({ target: article.getBoundingClientRect().width,
      wrapper: article.closest(".react-flow__node")?.getBoundingClientRect().width ?? 0 }));
    expect(pendingLayout.target).toBe(0);
    expect(pendingLayout.wrapper).toBeGreaterThan(0);
    await live.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(".ink-study__canvas");
      const extension = canvas?.getContext("webgl2")?.getExtension("WEBGL_lose_context");
      if (extension === undefined || extension === null) throw new Error("缺少真实 WebGL contextloss 扩展");
      extension.loseContext();
    });
    await expect(live.locator(".ink-study__stage")).toHaveAttribute("data-ink-renderer", "fallback");
    await hiddenTargets.evaluate(style => style.parentNode?.removeChild(style));
    await expectWaterReady(live, second);
    expect(await live.locator(`[data-ink-node="${second.nodes[0]?.id}"]`).evaluate(element => element.closest("[inert]") !== null)).toBe(false);
    for (const node of second.nodes) await expect(live.locator(`[data-ink-node="${node.id}"] h3`)).toHaveText(node.title);
    expect((await readStoredWorkspace(live))?.currentId).toBe(second.id);
    expect(await readFixtureSnapshots(live)).toHaveLength(0);
    await live.screenshot({ path: testInfo.outputPath("ink-transfer-contextloss-fallback.png") });
  } finally { await live.close(); }
});

/** 图呈现模块与协调器一起预加载；任一模块失败都不能发送请求后留下空白结果阶段。 */
test("图模块加载失败明确恢复输入且不发API请求", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.emulateMedia({ reducedMotion: "reduce" });
  let requested = false;
  await page.route(/\/src\/design\/ink-graph\.(?:tsx|js)(?:\?.*)?$/, async route => {
    requested = true;
    await route.abort("failed");
  });
  await page.goto("/ink-study.html");
  const canvas = await page.locator(".ink-study__canvas").elementHandle();
  expect(requested).toBe(false);
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await input.fill("图模块不可用固定样例");
  await input.press("Enter");
  await expect.poll(() => requested).toBe(true);
  await expect(page.getByRole("alert")).toHaveText("本次搜索未完成，请重试。");
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "input");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("图模块不可用固定样例");
  await expect(page.getByRole("button", { name: "搜索", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "取消", exact: true })).toHaveCount(0);
  await expect(page.locator("[data-ink-node]")).toHaveCount(0);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
  expect(await canvas?.evaluate(element => element.isConnected)).toBe(true);
});

/** 返回保留所选草图；显式新建才清理旧图和计时器，迟到事件不得进入新记录。 */
test("返回恢复所选草图而新建清理旧图及计时器，新运行忽略旧complete", async ({ page }) => {
  const events = createInkMotionEvents();
  const planIndexes = events.flatMap((event, index) => event.type === "query.analysis" || event.type === "graph.plan" ? [index] : []);
  const complete = events.findIndex(event => event.type === "complete");
  await installBrowserFixture(page, events);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await expect(input).toBeFocused();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install({ time: new Date(FIXTURE_TIME) });
  await page.clock.pauseAt(new Date(FIXTURE_TIME + 1000));
  await input.fill("旧图的延迟节点");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, planIndexes);
  await expect(page.locator("[data-ink-node]")).toHaveCount(4);
  await page.clock.fastForward(1200);
  expect(await visibleInkNodeIds(page)).toEqual([READY_NODE_ID]);
  await page.getByRole("button", { name: "返回首页", exact: true }).click();
  // 保留真实退场过程，未出生节点和未断开的正式边不能因 active=false 被突然全部揭示。
  await page.clock.fastForward(160);
  for (const id of ["python-installation", "python-basics", "python-third-party-libraries"]) {
    await expect(page.locator(`[data-ink-node="${id}"]`)).toHaveCSS("visibility", "hidden");
  }
  expect(await visibleInkEdgeIds(page)).toEqual([]);
  await page.clock.fastForward(1000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const start = page.getByRole("button", { name: "开始探索", exact: true });
  await expect(start).toBeFocused();
  await expect(page.locator("[data-ink-node]")).toHaveCount(0);
  await expect.poll(async () => (await readFixtureSnapshots(page))[0]).toMatchObject({ aborted: true, cancelled: true });

  await start.click();
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "graph");
  await expect.poll(() => visibleInkNodeIds(page)).toHaveLength(4);
  expect(await readFixtureSnapshots(page)).toHaveLength(1);
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  await page.getByRole("region", { name: "搜索历史", exact: true })
    .getByRole("button", { name: "新建搜索图", exact: true }).click();
  await expect(input).toBeFocused();
  await input.fill("新运行拥有的新图");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(2);
  await page.clock.fastForward(10_000);
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "loading");
  await expect(page.locator("[data-ink-node]")).toHaveCount(0);
  await emitFixtureEvents(page, 1, [complete], 0);
  await expect(page.locator("[data-ink-node]")).toHaveCount(0);
  await emitFixtureEvents(page, 1, planIndexes);
  await expect.poll(() => visibleInkNodeIds(page)).toHaveLength(4);
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  await page.getByRole("region", { name: "搜索历史", exact: true })
    .getByRole("button", { name: "新建搜索图", exact: true }).click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await page.clock.fastForward(10_000);
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "input");
  await expect(page.locator("[data-ink-node]")).toHaveCount(0);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect.poll(async () => (await readFixtureSnapshots(page))[1]).toMatchObject({ aborted: true, cancelled: true });
});

/** 历史恢复必须选择实际文档；同业务节点 ID 出现在两张图中，也不能串用它们的坐标。 */
test("历史标题恢复两张真实图且独立保存拖动位置，切图不重搜", async ({ page }, testInfo) => {
  const events = createJourneyEvents();
  await installBrowserFixture(page, events);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await input.fill("保存图甲");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, events.map((_, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await expect(page.locator("[data-ink-node]:visible")).toHaveCount(4);
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents.length).toBe(1);
  const firstGraph = (await readStoredWorkspace(page))?.documents.find(document => document.query === "保存图甲");
  if (firstGraph === undefined) throw new Error("首张搜索图未持久保存");
  const firstPosition = await dragInkNode(page, 70, 35);
  await expectSavedInkPosition(page, firstGraph.id, firstPosition);
  const toggle = page.getByRole("button", { name: "搜索历史", exact: true });
  const panel = page.getByRole("region", { name: "搜索历史", exact: true });
  await toggle.click();
  await panel.getByRole("button", { name: "新建搜索图", exact: true }).click();
  await input.fill("保存图乙");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(2);
  await emitFixtureEvents(page, 1, events.map((_, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(1));
  await expect(page.locator("[data-ink-node]:visible")).toHaveCount(4);
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents.length).toBe(2);
  const secondGraph = (await readStoredWorkspace(page))?.documents.find(document => document.query === "保存图乙");
  if (secondGraph === undefined) throw new Error("第二张搜索图未持久保存");
  const secondPosition = await dragInkNode(page, -45, 65);
  await expectSavedInkPosition(page, secondGraph.id, secondPosition);

  for (const [document, position] of [[firstGraph, firstPosition], [secondGraph, secondPosition], [firstGraph, firstPosition]] as const) {
    await toggle.click();
    await panel.getByRole("button", { name: document.title, exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "graph");
    await expect(page.locator("[data-ink-node]:visible")).toHaveCount(4);
    await expectInkPosition(page, position);
    await expect.poll(async () => (await readStoredWorkspace(page))?.currentId).toBe(document.id);
    expect(await readFixtureSnapshots(page)).toHaveLength(2);
  }
  await expectSavedInkPosition(page, secondGraph.id, secondPosition);
  await page.screenshot({ path: testInfo.outputPath("ink-history-restored-layout.png"), animations: "disabled" });
});

/** 草图位置必须在 complete 时交给同一文档，再经过首页与 IndexedDB 恢复仍保持。 */
test("运行中独立拖动的节点在完成后承接，返回重入及刷新保留坐标", async ({ page }, testInfo) => {
  const events = createInkMotionEvents();
  const complete = events.findIndex(event => event.type === "complete");
  await installBrowserFixture(page, events);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await input.fill("运行中移动后保存");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, events.flatMap((_, index) => index < complete ? [index] : []));
  await expect(page.locator("[data-ink-node]:visible")).toHaveCount(4);
  const otherPosition = await readInkPosition(page, "python-installation");
  const moved = await dragInkNode(page, 85, 40);
  await expectInkPosition(page, otherPosition, "python-installation");
  await emitFixtureEvents(page, 0, [complete]);
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await expectInkPosition(page, moved);
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents[0]?.nodes.length).toBe(4);
  const graph = (await readStoredWorkspace(page))?.documents[0];
  if (graph === undefined) throw new Error("运行完成文档未保存");
  await expectSavedInkPosition(page, graph.id, moved);
  await page.getByRole("button", { name: "返回首页", exact: true }).click();
  await expect(page.locator("[data-ink-node]")).toHaveCount(0);
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "graph");
  await expectInkPosition(page, moved);
  expect(await readFixtureSnapshots(page)).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "开始探索", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  await expect(page.locator("[data-ink-node]:visible")).toHaveCount(4);
  await expectInkPosition(page, moved);
  await expectInkPosition(page, otherPosition, "python-installation");
  expect((await readStoredWorkspace(page))?.currentId).toBe(graph.id);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath("ink-runtime-drag-refresh.png"), animations: "disabled" });
});

/** 完整页面就是图的裁切边界；节点接近左边缘时，文字与墨团不得被旧的内缩图框提前裁掉。 */
test("图画布覆盖完整stage且边缘节点保持可读语义与实际命中", async ({ page }, testInfo) => {
  const events = createJourneyEvents();
  await installBrowserFixture(page, events);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await input.fill("页面边缘文本");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, events.map((_, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await expect(page.locator("[data-ink-node]:visible")).toHaveCount(4);
  const stage = await page.locator(".ink-study__stage").boundingBox();
  const viewport = await page.locator(".ink-study__graph").boundingBox();
  const node = page.locator(`[data-ink-node="${READY_NODE_ID}"]`);
  const before = await node.boundingBox();
  if (stage === null || viewport === null || before === null) throw new Error("缺少完整图画布或节点");
  for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(stage[key] - viewport[key])).toBeLessThan(1);
  await dragInkNode(page, stage.x - 24 - before.x, stage.y + stage.height * 0.55 - before.y);
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "graph");
  const heading = node.getByRole("heading", { name: "Python 简介", exact: true });
  await expect(heading).toBeVisible();
  await expect(node.locator("p")).toHaveText("了解 Python 的定位、核心特性与常见使用场景。");
  await expect.poll(() => heading.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const stageBounds = document.querySelector(".ink-study__stage")?.getBoundingClientRect();
    if (stageBounds === undefined) return false;
    const x = Math.max(stageBounds.left + 6, bounds.left + 2);
    const target = document.elementFromPoint(x, bounds.y + bounds.height / 2);
    return x < bounds.right && target?.closest("[data-ink-node]")?.getAttribute("data-ink-node") === "python-introduction";
  })).toBe(true);
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-ink-renderer", "active");
  await expect.poll(async () => (await inkPigmentPerNode(page)).find(item => item.id === READY_NODE_ID)?.count ?? 0).toBeGreaterThan(20);
  await page.screenshot({ path: testInfo.outputPath("ink-real-page-edge.png"), animations: "disabled" });
});

/** UI 本地化和已生成内容的语言分开验证，不能靠重搜或改写历史文档来获得英文控件。 */
test("新页语言即时更新状态连线控件和历史，原始内容及请求语言不变", async ({ page }, testInfo) => {
  const events = createInkMotionEvents();
  await installBrowserFixture(page, events);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "搜索任意主题", exact: true });
  await input.fill("保留中文结果");
  await input.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, events.map((_, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await expect(page.locator("[data-ink-node]:visible")).toHaveCount(4);
  await expect.poll(async () => (await readStoredWorkspace(page))?.documents[0]?.nodes.length).toBe(4);
  const original = (await readStoredWorkspace(page))?.documents[0];
  if (original === undefined) throw new Error("缺少原始中文文档");
  await page.getByRole("button", { name: "语言", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  const readyNode = page.locator(`[data-ink-node="${READY_NODE_ID}"]`);
  await expect(readyNode.getByText("Ready", { exact: true })).toBeVisible();
  await expect(readyNode.getByText("Main path", { exact: true })).toBeVisible();
  await expect(page.locator('[data-ink-node="python-installation"]').getByText("Partially complete", { exact: true })).toBeVisible();
  await expect(page.locator('[data-ink-node="python-third-party-libraries"]').getByText("Failed", { exact: true })).toBeVisible();
  await expect(page.locator(".react-flow__edge-text").getByText("Recommended next", { exact: true })).toHaveCount(2);
  await expect(page.locator(".react-flow__edge-text").getByText("Related", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fit all nodes", exact: true })).toBeVisible();
  for (const source of original.nodes) {
    const node = page.locator(`[data-ink-node="${source.id}"]`);
    await expect(node.getByRole("heading")).toHaveText(source.title);
    await expect(node.locator("p")).toHaveText(source.description);
  }
  await page.getByRole("button", { name: "Search history", exact: true }).click();
  const history = page.getByRole("region", { name: "Search history", exact: true });
  await expect(history.getByRole("status")).toHaveText("Saved in this browser");
  await expect(history.getByRole("button", { name: original.title, exact: true })).toBeVisible();
  await expect(history.getByRole("button", { name: `Rename：${original.title}`, exact: true })).toBeVisible();
  expect((await readStoredWorkspace(page))?.documents.find(document => document.id === original.id)).toEqual(original);
  expect((await readFixtureSnapshots(page))[0]).toMatchObject({ language: "zh-CN", engine: "baidu" });
  expect(await readFixtureSnapshots(page)).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath("ink-immediate-english-history.png"), animations: "disabled" });
  await history.getByRole("button", { name: "New search graph", exact: true }).click();
  const nextInput = page.getByRole("searchbox", { name: "Search any topic", exact: true });
  await expect(nextInput).toBeFocused();
  await expect(nextInput).toHaveValue("");
  await nextInput.fill("Next English graph");
  await nextInput.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page))[1]).toMatchObject({ language: "en-US", engine: "google" });
  expect((await readStoredWorkspace(page))?.documents.find(document => document.id === original.id)?.language).toBe("zh-CN");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

/** 手动文档不受 AI 八节点限制；真实读取九节点历史后，逐个证明 DOM 和 GPU 墨团均完整。 */
test("九节点手动历史通过原生存储恢复且每个节点都有墨团", async ({ page }, testInfo) => {
  const nodes = Array.from({ length: 9 }, (_, index) => ({
    id: `manual-ink-${index + 1}`, title: `手动节点 ${index + 1}`, description: `人工保存的第 ${index + 1} 个节点说明。`,
    nodeType: "primary", layer: 0, status: "empty", resources: [], warnings: [],
  }));
  const document = EditableGraphSchema.parse({
    version: "workspace.v1", id: "ink-history-nine", title: "九节点人工历史图", query: "", language: "zh-CN",
    presentationMode: "graph", analysis: null, createdAt: new Date(FIXTURE_TIME).toISOString(),
    updatedAt: new Date(FIXTURE_TIME).toISOString(), lastRunId: null, nodes, edges: [],
    positions: Object.fromEntries(nodes.map((node, index) => [node.id, { x: 32 + index % 3 * 340, y: 32 + Math.floor(index / 3) * 220 }])),
  });
  const emptyDocument = EditableGraphSchema.parse({ ...document, id: "ink-history-empty", title: "空的人工历史图", nodes: [], edges: [], positions: {} });
  await installBrowserFixture(page, createJourneyEvents());
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ink-study.html");
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  await expect(page.getByRole("region", { name: "搜索历史", exact: true }).getByRole("status")).toHaveText("已保存到本浏览器");
  await seedStoredWorkspace(page, [document, emptyDocument]);
  await page.reload();
  await page.getByRole("button", { name: "开始探索", exact: true }).click();
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "graph");
  await expect(page.locator("[data-ink-node]:visible")).toHaveCount(9);
  for (const node of nodes) {
    await expect(page.locator(`[data-ink-node="${node.id}"]`).getByRole("heading", { name: node.title, exact: true })).toBeVisible();
    await expectInkPosition(page, document.positions[node.id] ?? { x: NaN, y: NaN }, node.id);
  }
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-ink-renderer", "active");
  await expect.poll(async () => Math.min(...(await inkPigmentPerNode(page)).map(item => item.count))).toBeGreaterThan(20);
  const pigments = await inkPigmentPerNode(page);
  expect(pigments).toHaveLength(9);
  await testInfo.attach("nine-node-gpu-pigment", { body: JSON.stringify(pigments, null, 2), contentType: "application/json" });
  expect((await readStoredWorkspace(page))?.currentId).toBe(document.id);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath("ink-nine-node-history.png"), animations: "disabled" });
  // 从已有九墨团切到真实空记录仍应聚合为自由墨迹，不能因空 scene 最终把所有颜料关掉。
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install({ time: new Date(FIXTURE_TIME) });
  await page.clock.pauseAt(new Date(FIXTURE_TIME + 1000));
  await page.getByRole("button", { name: "搜索历史", exact: true }).click();
  await page.getByRole("region", { name: "搜索历史", exact: true })
    .getByRole("button", { name: emptyDocument.title, exact: true }).press("Enter");
  await page.clock.fastForward(1000);
  await expect(page.locator(".ink-study__stage")).toHaveAttribute("data-search-state", "graph");
  await expect(page.locator("[data-ink-node]")).toHaveCount(0);
  expect((await readStoredWorkspace(page))?.currentId).toBe(emptyDocument.id);
  expect((await captureInkRaster(page, testInfo.outputPath("ink-nine-to-empty-merge.png"))).count).toBeGreaterThan(30);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

test("English 选择器控制请求与页面语言，既有 Run 不随下一次选择混语", async ({
  page,
}) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.goto("/");

  const languageSelector = page.getByRole("combobox", { name: "语言" });
  await languageSelector.selectOption("en-US");

  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  const queryInput = page.getByRole("searchbox", {
    name: "Search any topic",
  });
  await queryInput.fill("What is MySQL?");
  await queryInput.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length)
    .toBe(1);
  await expect.poll(async () => (await readFixtureSnapshots(page))[0])
    .toMatchObject({ query: "What is MySQL?", language: "en-US" });

  const activeRunSelector = page.getByRole("combobox", { name: "Language" });
  await activeRunSelector.selectOption("zh-CN");

  await expect(activeRunSelector).toHaveValue("zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.getByRole("heading", { name: "Search results" }))
    .toBeVisible();
  await expect(page.getByRole("heading", { name: "搜索结果" })).toHaveCount(0);
});

test("fixture 覆盖 Graph Draft、Resource 交互、取消与第二次 Query", async ({
  page,
}) => {
  const events = createJourneyEvents();
  const analysisIndex = events.findIndex(
    event => event.type === "query.analysis",
  );
  const planIndex = events.findIndex(event => event.type === "graph.plan");
  const readyIndex = events.findIndex(
    event => event.type === "node.ready" && event.nodeId === READY_NODE_ID,
  );
  const statusIndex = events.findIndex(
    event => event.type === "node.status" && event.nodeId === READY_NODE_ID,
  );
  const completeIndex = events.findIndex(event => event.type === "complete");
  if (
    analysisIndex < 0 ||
    planIndex < 0 ||
    readyIndex < 0 ||
    statusIndex < 0 ||
    completeIndex < 0
  ) {
    throw new Error("Browser-like Fixture 事件不完整");
  }

  const externalRequests: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") externalRequests.push(url.href);
  });
  await installBrowserFixture(page, events);
  await page.goto("/");

  const queryInput = page.getByRole("searchbox", { name: "搜索任意主题" });
  await queryInput.fill(FIRST_QUERY);
  await queryInput.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length)
    .toBe(1);

  // 先只释放 Analysis + Plan，证明 Graph Draft 不等待任何 Node 终态或 complete。
  await emitFixtureEvents(page, 0, [analysisIndex, planIndex]);
  await expect(page.locator('[data-node-status="planned"]')).toHaveCount(4);
  await expect(page.getByText("暂无可展示的搜索结果。")).toHaveCount(0);
  await expect(page.getByRole("definition").filter({ hasText: "搜索中" }))
    .toHaveCount(1);

  await emitFixtureEvents(page, 0, [statusIndex]);
  await expect(
    page.locator(`.react-flow__node[data-id="${READY_NODE_ID}"]`)
      .locator('[data-node-status="searching"]'),
  ).toHaveCount(1);

  await emitFixtureEvents(page, 0, [readyIndex]);
  const readyNode = page.locator(
    `.react-flow__node[data-id="${READY_NODE_ID}"]`,
  );
  await expect(readyNode.locator('[data-node-status="ready"]')).toHaveCount(1);
  await readyNode.click();

  const resourceList = page.getByRole("list", { name: "节点资源" });
  await expect(page.getByRole("heading", { name: "Python 简介" })).toHaveCount(2);
  await expect(resourceList.getByRole("listitem")).toHaveCount(3);
  await expect(page.getByText("Python Standard Library")).toHaveCount(0);

  await page.getByRole("button", { name: "显示更多（1）" }).click();
  await expect(resourceList.getByRole("listitem")).toHaveCount(4);
  await expect(page.getByText("Python Standard Library")).toBeVisible();
  expect(await readFixtureSnapshots(page)).toHaveLength(1);

  await page.getByRole("button", {
    name: "在新标签页打开 Python Programming Language",
  }).click();
  await expect.poll(() =>
    page.evaluate(() => window.__WAYFINDER_E2E__.openCalls()),
  ).toEqual([
    ["https://www.python.org/", "_blank", "noopener,noreferrer"],
  ]);

  // 第一条 Stream 保持 pending；第二次提交必须同步取消旧 Signal 并立即取得 Store 所有权。
  await queryInput.fill(SECOND_QUERY);
  await queryInput.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length)
    .toBe(2);
  await expect.poll(async () => (await readFixtureSnapshots(page))[0])
    .toMatchObject({ query: FIRST_QUERY, aborted: true, cancelled: true });
  await expect(page.getByRole("definition").filter({ hasText: SECOND_QUERY }))
    .toHaveCount(1);
  await expect(page.getByText("暂无可展示的搜索结果。")).toBeVisible();

  // 把旧 Run 的合法 complete 注入新 Reader；随后同一 Stream 的新 Plan 成功出现，证明
  // 旧 complete 已按顺序处理并被 runId Guard 丢弃，而非断言抢在 Reader 之前执行。
  await emitFixtureEvents(page, 1, [completeIndex], 0);
  await emitFixtureEvents(page, 1, [analysisIndex, planIndex]);
  await expect(page.locator('[data-node-status="planned"]')).toHaveCount(4);

  // 新 Run 随后走剩余 Fixture Stream，证明旧事件不会破坏 sequence 或终态收敛。
  await emitFixtureEvents(
    page,
    1,
    events.flatMap((_event, index) =>
      index === analysisIndex || index === planIndex ? [] : [index],
    ),
  );
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(1));
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await expect(page.getByRole("definition").filter({ hasText: "已完成" }))
    .toHaveCount(1);
  await expect(page.getByRole("definition").filter({ hasText: SECOND_QUERY }))
    .toHaveCount(1);
  expect(externalRequests).toEqual([]);
});

/** 使用真实 IndexedDB 与正式侧栏证明恢复和记录隔离，不把状态直接注入应用仓库。 */
test("本地记录支持切换改名删除恢复，刷新及重新打开后不重新搜索", async ({ page, context }) => {
  const events = createJourneyEvents();
  await installBrowserFixture(page, events);
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "搜索图记录" });
  const queryInput = page.getByRole("searchbox", { name: "搜索任意主题" });
  const saved = sidebar.getByRole("status");
  await expect(saved).toHaveText("已保存到本浏览器");

  await queryInput.fill(FIRST_QUERY);
  await queryInput.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await emitFixtureEvents(page, 0, events.map((_event, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await expect(saved).toHaveText("已保存到本浏览器");
  const firstRecord = sidebar.getByRole("listitem").filter({ has: page.getByRole("button", { name: FIRST_QUERY, exact: true }) });
  await firstRecord.getByRole("button", { name: "重命名", exact: true }).click();
  await firstRecord.getByRole("textbox", { name: "记录名称" }).fill("Python 资料");
  await firstRecord.getByRole("button", { name: "保存名称" }).click();

  await sidebar.getByRole("button", { name: "新建搜索", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await queryInput.fill(SECOND_QUERY);
  await queryInput.press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(2);
  const planIndexes = events.flatMap((event, index) => event.type === "query.analysis" || event.type === "graph.plan" ? [index] : []);
  await emitFixtureEvents(page, 1, planIndexes);
  await expect(page.locator('[data-node-status="planned"]')).toHaveCount(4);
  await sidebar.getByRole("button", { name: "Python 资料", exact: true }).click();
  await expect(page.getByRole("definition").filter({ hasText: FIRST_QUERY })).toHaveCount(1);
  await expect(page.locator('[data-node-status="ready"]')).toHaveCount(2);

  // 后台新图完成后仍停留在用户选择的旧图。
  await emitFixtureEvents(page, 1, events.flatMap((_event, index) => planIndexes.includes(index) ? [] : [index]));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(1));
  await expect(saved).toHaveText("已保存到本浏览器");
  await expect(page.getByRole("definition").filter({ hasText: FIRST_QUERY })).toHaveCount(1);
  await sidebar.getByRole("button", { name: SECOND_QUERY, exact: true }).click();
  const readyNode = page.locator(`.react-flow__node[data-id="${READY_NODE_ID}"]`);
  await readyNode.click();
  await page.getByRole("button", { name: "显示更多（1）" }).click();
  await expect(page.getByRole("list", { name: "节点资源" }).getByRole("listitem")).toHaveCount(4);
  const positionBefore = await readyNode.evaluate(node => getComputedStyle(node).transform);
  await expect(saved).toHaveText("已保存到本浏览器");

  await page.reload();
  await expect(sidebar.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("definition").filter({ hasText: SECOND_QUERY })).toHaveCount(1);
  await expect(readyNode).toHaveCSS("transform", positionBefore);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
  await readyNode.click();
  await page.getByRole("button", { name: "显示更多（1）" }).click();
  const titles = await page.getByRole("list", { name: "节点资源" }).getByRole("heading", { level: 3 }).allTextContents();
  expect(titles).toEqual(["Python Programming Language", "Python Documentation", "Python Language Reference", "Python Standard Library"]);

  await sidebar.getByRole("button", { name: "Python 资料", exact: true }).click();
  const renamedRecord = sidebar.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Python 资料", exact: true }) });
  await renamedRecord.getByRole("button", { name: "删除记录", exact: true }).click();
  await expect(sidebar.getByRole("listitem")).toHaveCount(1);
  await sidebar.getByRole("button", { name: "撤销删除记录", exact: true }).click();
  await expect(sidebar.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("definition").filter({ hasText: FIRST_QUERY })).toHaveCount(1);
  await expect(saved).toHaveText("已保存到本浏览器");
  expect(await readFixtureSnapshots(page)).toHaveLength(0);

  const reopened = await context.newPage();
  const searchRequests: string[] = [];
  reopened.on("request", request => { if (new URL(request.url()).pathname === "/api/search") searchRequests.push(request.url()); });
  await reopened.goto("/");
  await expect(reopened.getByRole("complementary", { name: "搜索图记录" }).getByRole("listitem")).toHaveCount(2);
  await expect(reopened.locator(".react-flow__node")).toHaveCount(4);
  await expect(reopened.getByRole("definition").filter({ hasText: FIRST_QUERY })).toHaveCount(1);
  expect(searchRequests).toEqual([]);
  await reopened.close();
});

/** 纯手动编辑走真实界面和持久化，禁止把编辑误接成搜索或模型调用。 */
test("手动节点与资源支持编辑、全图去重定位、拖拽排序和撤销恢复", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "搜索图记录" });
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  const addNode = async (title: string): Promise<void> => {
    await page.getByRole("textbox", { name: "新节点标题", exact: true }).fill(title);
    await page.getByRole("button", { name: "新建节点", exact: true }).click();
  };
  await addNode("资料节点");
  await page.getByRole("button", { name: "编辑节点", exact: true }).click();
  await page.getByRole("textbox", { name: "节点标题", exact: true }).fill("主要资料");
  await page.getByRole("textbox", { name: "节点说明", exact: true }).fill("用户自行整理的网页");
  await page.getByRole("button", { name: "保存节点", exact: true }).click();
  await expect(page.getByRole("heading", { name: "主要资料", exact: true })).toHaveCount(2);

  for (let index = 0; index < 7; index += 1) {
    await page.getByRole("textbox", { name: "资源 URL", exact: true }).fill(`https://resource-${index}.example.com/page`);
    await page.getByRole("button", { name: "添加资源", exact: true }).click();
  }
  await page.getByRole("button", { name: "显示更多（4）" }).click();
  const resourceList = page.getByRole("list", { name: "节点资源" });
  const cards = resourceList.getByRole("listitem");
  await expect(cards).toHaveCount(7);
  await cards.first().getByRole("button", { name: "编辑资源", exact: true }).click();
  await cards.first().getByRole("textbox", { name: "资源标题", exact: true }).fill("我的首个链接");
  await cards.first().getByRole("textbox", { name: "网页说明", exact: true }).fill("我写的网页说明");
  await cards.first().getByRole("textbox", { name: "选用理由", exact: true }).fill("适合当前研究主题");
  await cards.first().getByRole("button", { name: "保存资源", exact: true }).click();
  await expect(cards.first().getByText("我写的网页说明", { exact: true })).toBeVisible();
  await cards.first().getByRole("button", { name: "编辑资源", exact: true }).click();
  await cards.first().getByRole("textbox", { name: "资源标题", exact: true }).fill("未保存的草稿");
  await cards.first().getByRole("textbox", { name: "网页说明", exact: true }).fill("取消的说明");
  await cards.first().getByRole("button", { name: "取消编辑", exact: true }).click();
  await cards.first().getByRole("button", { name: "编辑资源", exact: true }).click();
  await expect(cards.first().getByRole("textbox", { name: "资源标题", exact: true })).toHaveValue("我的首个链接");
  await expect(cards.first().getByRole("textbox", { name: "网页说明", exact: true })).toHaveValue("我写的网页说明");
  await cards.first().getByRole("button", { name: "取消编辑", exact: true }).click();

  await addNode("另一个节点");
  await page.getByRole("textbox", { name: "资源 URL", exact: true }).fill("https://resource-0.example.com/page?utm_source=test#section");
  await page.getByRole("button", { name: "添加资源", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("主要资料");
  await page.getByRole("button", { name: "定位已有资源所在节点", exact: true }).click();
  await expect(page.getByRole("heading", { name: "主要资料", exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "显示更多（4）" }).click();
  await expect(cards).toHaveCount(7);

  // 使用浏览器原生拖拽；撤销与重做只恢复数组顺序，不调用搜索。
  const grip = cards.first().locator(".resource-card__drag-handle");
  await grip.scrollIntoViewIfNeeded();
  const gripBounds = await grip.boundingBox();
  if (gripBounds === null) throw new Error("拖拽起点不可见");
  await page.mouse.move(gripBounds.x + gripBounds.width / 2, gripBounds.y + gripBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(gripBounds.x + gripBounds.width / 2 + 12, gripBounds.y + gripBounds.height / 2, { steps: 5 });
  // 长资源卡片位于滚动面板中；拖动保持按下，滚动到真实目标后再释放。
  const dropHeader = cards.nth(1).locator(".resource-card__header");
  await dropHeader.evaluate(element => element.scrollIntoView({ block: "center" }));
  const dropBounds = await dropHeader.boundingBox();
  if (dropBounds === null) throw new Error("拖拽目标不可见");
  await page.mouse.move(dropBounds.x + dropBounds.width / 2, dropBounds.y + dropBounds.height / 2, { steps: 8 });
  await page.mouse.move(dropBounds.x + dropBounds.width / 2 + 1, dropBounds.y + dropBounds.height / 2);
  await page.mouse.up();
  await expect(cards.nth(0).getByRole("heading", { level: 3 })).toHaveText("resource-1.example.com");
  await expect(cards.nth(1).getByRole("heading", { level: 3 })).toHaveText("我的首个链接");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(cards.first().getByRole("heading", { level: 3 })).toHaveText("我的首个链接");
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(cards.first().getByRole("heading", { level: 3 })).toHaveText("resource-1.example.com");
  await cards.last().getByRole("button", { name: "删除资源", exact: true }).click();
  await expect(cards).toHaveCount(6);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(cards).toHaveCount(7);
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  expect(await readFixtureSnapshots(page)).toHaveLength(0);

  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await page.locator(".react-flow__node").filter({ has: page.getByRole("heading", { name: "主要资料", exact: true }) }).click();
  await page.getByRole("button", { name: "显示更多（4）" }).click();
  await expect(cards).toHaveCount(7);
  await expect(cards.first().getByRole("heading", { level: 3 })).toHaveText("resource-1.example.com");
  await expect(cards.nth(1).getByText("我写的网页说明", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "撤销", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "删除节点", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

/** 布局与关系走真实画布手势；临时拖动只形成一次可撤销提交。 */
test("节点拖动与连线编辑可撤销并持久保存，相关可成环而推荐顺序不可成环", async ({ page }) => {
  const pageErrors: string[] = [];
  const flowWarnings: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "warning" && message.text().includes("[React Flow]")) flowWarnings.push(message.text()); });
  await installBrowserFixture(page, createJourneyEvents());
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "搜索图记录" });
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  const addNode = async (title: string): Promise<void> => {
    await page.getByRole("textbox", { name: "新节点标题", exact: true }).fill(title);
    await page.getByRole("button", { name: "新建节点", exact: true }).click();
  };
  await addNode("布局甲");
  await addNode("布局乙");
  await sidebar.getByRole("button", { name: "重命名", exact: true }).click();
  await sidebar.getByRole("textbox", { name: "记录名称" }).fill("布局图");
  await sidebar.getByRole("button", { name: "保存名称" }).click();
  const firstNode = page.locator(".react-flow__node").filter({ has: page.getByRole("heading", { name: "布局甲", exact: true }) });
  const secondNode = page.locator(".react-flow__node").filter({ has: page.getByRole("heading", { name: "布局乙", exact: true }) });
  const before = await firstNode.evaluate(element => getComputedStyle(element).transform);
  const heading = firstNode.getByRole("heading", { name: "布局甲", exact: true });
  await heading.scrollIntoViewIfNeeded();
  const bounds = await heading.boundingBox();
  if (bounds === null) throw new Error("节点拖动起点不可见");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2 + 50, { steps: 12 });
  await page.mouse.up();
  await expect(firstNode).not.toHaveCSS("transform", before);
  const after = await firstNode.evaluate(element => getComputedStyle(element).transform);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(firstNode).toHaveCSS("transform", before);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(firstNode).toHaveCSS("transform", after);
  // 方向键不触发指针 DragStop，也必须保存为独立一步并可恢复。
  await firstNode.focus();
  await firstNode.press("ArrowRight");
  await expect(firstNode).not.toHaveCSS("transform", after);
  const keyboardAfter = await firstNode.evaluate(element => getComputedStyle(element).transform);
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(firstNode).toHaveCSS("transform", after);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(firstNode).toHaveCSS("transform", keyboardAfter);

  // 同类端口通过原生指针拖线；编辑既有边仍使用相同的确定性关系规则。
  await firstNode.locator('[data-handleid="main-source"]').dragTo(secondNode.locator('[data-handleid="main-target"]'));
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.locator(".graph-edge--recommended")).toHaveCount(1);
  await secondNode.locator('[data-handleid="related-source"]').dragTo(firstNode.locator('[data-handleid="related-target"]'));
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  const edgeEditor = page.locator(".workspace-edge-editor");
  await edgeEditor.locator("summary").click();
  const edgeSelector = edgeEditor.getByRole("combobox", { name: "选择连线", exact: true });
  const firstEdgeId = await edgeSelector.locator("option").nth(1).getAttribute("value");
  if (firstEdgeId === null) throw new Error("缺少测试连线");
  await edgeSelector.selectOption(firstEdgeId);
  await edgeEditor.getByRole("combobox", { name: "关系类型", exact: true }).selectOption("related_to");
  await edgeEditor.getByRole("button", { name: "保存连线", exact: true }).click();
  await expect(page.locator(".graph-edge--related")).toHaveCount(2);
  await edgeEditor.getByRole("combobox", { name: "关系类型", exact: true }).selectOption("recommended_next");
  await edgeEditor.getByRole("button", { name: "保存连线", exact: true }).click();
  await expect(page.locator(".graph-edge--recommended")).toHaveCount(1);

  await edgeSelector.selectOption("");
  await edgeEditor.getByRole("combobox", { name: "起点节点", exact: true }).selectOption({ label: "布局乙" });
  await edgeEditor.getByRole("combobox", { name: "终点节点", exact: true }).selectOption({ label: "布局甲" });
  await edgeEditor.getByRole("combobox", { name: "关系类型", exact: true }).selectOption("recommended_next");
  await edgeEditor.getByRole("button", { name: "添加连线", exact: true }).click();
  await expect(edgeEditor.getByRole("alert")).toContainText("推荐下一步不能形成环");
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await edgeSelector.selectOption(firstEdgeId);
  await edgeEditor.getByRole("button", { name: "删除连线", exact: true }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);

  // 原生 Delete 键不绕过显式删除入口，不允许画布与保存的数据出现两套内容。
  await firstNode.press("Delete");
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await sidebar.getByRole("button", { name: "新建搜索", exact: true }).click();
  await addNode("其他记录节点");
  await sidebar.getByRole("button", { name: "布局图", exact: true }).click();
  await expect(firstNode).toHaveCSS("transform", keyboardAfter);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  await page.reload();
  await expect(firstNode).toHaveCSS("transform", keyboardAfter);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "撤销", exact: true })).toBeDisabled();
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
  expect(pageErrors).toEqual([]);
  expect(flowWarnings).toEqual([]);
});

/** 引擎覆盖只影响下一次请求，偏好与资源实际来源分开，所有响应均为本地固定样例。 */
test("引擎随语言默认且可独立覆盖，节点偏好保存而旧资源来源不变", async ({ page }) => {
  const events = createJourneyEvents();
  await installBrowserFixture(page, events);
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "搜索图记录" });
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  await expect(page.getByRole("combobox", { name: "搜索引擎", exact: true })).toHaveValue("baidu");
  await page.getByRole("combobox", { name: "语言", exact: true }).selectOption("en-US");
  const globalEngine = page.getByRole("combobox", { name: "Search engine", exact: true });
  await expect(globalEngine).toHaveValue("google");
  await globalEngine.selectOption("baidu");
  await expect(page.getByRole("note")).toHaveText("Baidu does not guarantee regional targeting.");
  expect(await readFixtureSnapshots(page)).toHaveLength(0);

  await page.getByRole("searchbox", { name: "Search any topic" }).fill("Engine fixture");
  await page.getByRole("searchbox", { name: "Search any topic" }).press("Enter");
  await expect.poll(async () => (await readFixtureSnapshots(page))[0]).toMatchObject({ language: "en-US", engine: "baidu" });
  await emitFixtureEvents(page, 0, events.map((_event, index) => index));
  await page.evaluate(() => window.__WAYFINDER_E2E__.close(0));
  await page.locator(`.react-flow__node[data-id="${READY_NODE_ID}"]`).click();
  const firstCard = page.getByRole("list", { name: "Node resources" }).getByRole("listitem").first();
  await expect(firstCard.getByRole("definition").filter({ hasText: "Baidu" })).toHaveCount(1);
  await globalEngine.selectOption("google");
  await expect(page.getByRole("combobox", { name: "Language", exact: true })).toHaveValue("en-US");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(firstCard.getByRole("definition").filter({ hasText: "Baidu" })).toHaveCount(1);
  const nodeEngine = page.getByRole("combobox", { name: "Node search engine", exact: true });
  await expect(nodeEngine).toHaveValue("google");
  await nodeEngine.selectOption("baidu");
  expect(await readFixtureSnapshots(page)).toHaveLength(1);
  await expect(page.getByRole("complementary", { name: "Search graphs", exact: true }).getByRole("status")).toHaveText("Saved in this browser");

  await page.reload();
  await expect(globalEngine).toHaveValue("google");
  await page.locator(`.react-flow__node[data-id="${READY_NODE_ID}"]`).click();
  await expect(nodeEngine).toHaveValue("baidu");
  await expect(firstCard.getByRole("definition").filter({ hasText: "Baidu" })).toHaveCount(1);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});


/** 缺少显式引擎的人工图撤销后恢复语言默认，不能泄漏空页偏好。 */
test("手动图引擎选择撤销后全局与节点均恢复语言默认", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "搜索图记录" });
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  await page.getByRole("textbox", { name: "新节点标题", exact: true }).fill("未选引擎节点");
  await page.getByRole("button", { name: "新建节点", exact: true }).click();
  const globalEngine = page.getByRole("combobox", { name: "搜索引擎", exact: true });
  const nodeEngine = page.getByRole("combobox", { name: "节点搜索引擎", exact: true });
  await expect(globalEngine).toHaveValue("baidu");
  await expect(nodeEngine).toHaveValue("baidu");
  await globalEngine.selectOption("google");
  await expect(nodeEngine).toHaveValue("google");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(globalEngine).toHaveValue("baidu");
  await expect(nodeEngine).toHaveValue("baidu");
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

/** 重搜全链路仍用同一可控 NDJSON 流，旧工作图只在明确应用时更新。 */
test("重搜预览支持弃用取消失败、追加和替换，完整旧图可撤销并刷新恢复", async ({ page }) => {
  const events = createJourneyEvents();
  const indexes = events.map((_event, index) => index);
  const completeIndex = events.findIndex(event => event.type === "complete");
  await installBrowserFixture(page, events);
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "搜索图记录" });
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  const working = page.locator(".graph-section");
  const preview = page.getByRole("region", { name: "重搜预览", exact: true });
  const addNode = async (title: string): Promise<void> => {
    await page.getByRole("textbox", { name: "新节点标题", exact: true }).fill(title);
    await page.getByRole("button", { name: "新建节点", exact: true }).click();
  };
  const addUrl = async (url: string): Promise<void> => {
    await working.getByRole("textbox", { name: "资源 URL", exact: true }).fill(url);
    await working.getByRole("button", { name: "添加资源", exact: true }).click();
  };
  const researchNode = async (index: number): Promise<void> => {
    await working.getByRole("button", { name: "重新搜索此节点", exact: true }).click();
    await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(index + 1);
  };
  const finish = async (index: number): Promise<void> => {
    await emitFixtureEvents(page, index, indexes);
    await page.evaluate(target => window.__WAYFINDER_E2E__.close(target), index);
    await expect(preview.getByRole("button", { name: "应用替换", exact: true })).toBeVisible();
  };
  await addNode("重搜主题");
  const targetNode = working.locator(".react-flow__node").filter({ has: page.getByRole("heading", { name: "重搜主题", exact: true }) });
  const targetId = await targetNode.getAttribute("data-id");
  await addUrl("https://original.example.com/");
  await working.getByRole("combobox", { name: "节点搜索引擎", exact: true }).selectOption("google");
  await addNode("保留节点");
  const otherNode = working.locator(".react-flow__node").filter({ has: page.getByRole("heading", { name: "保留节点", exact: true }) });
  await addUrl("https://keep.example.com/");
  await targetNode.click();
  const oldCards = working.getByRole("list", { name: "节点资源" }).getByRole("listitem");

  await researchNode(0);
  await expect.poll(async () => (await readFixtureSnapshots(page))[0]).toMatchObject({ query: "重搜主题", engine: "google", language: "zh-CN", nodeSearch: { node: { id: targetId, title: "重搜主题", description: "" }, analysis: null } });
  await expect(oldCards).toHaveCount(1);
  await preview.getByRole("button", { name: "取消重搜", exact: true }).click();
  await expect.poll(async () => (await readFixtureSnapshots(page))[0]).toMatchObject({ aborted: true, cancelled: true });
  await expect(preview).toHaveCount(0);
  await researchNode(1);
  await page.evaluate(() => window.__WAYFINDER_E2E__.fail(1));
  await expect(preview.getByRole("alert")).toContainText("当前图保持不变");
  await expect(oldCards).toHaveCount(1);
  await preview.getByRole("button", { name: "弃用新结果", exact: true }).click();

  await researchNode(2);
  await emitFixtureEvents(page, 2, [completeIndex], 0);
  await expect(preview.getByRole("button", { name: "取消重搜", exact: true })).toBeVisible();
  await finish(2);
  await expect(oldCards).toHaveCount(1);
  // 即使绕过原生长度限制，完整输入校验也应保留已就绪的旧预览，而不是取消后才拒绝。
  const topicField = page.getByRole("textbox", { name: "搜索主题", exact: true });
  await topicField.evaluate(element => element.removeAttribute("maxlength"));
  await topicField.fill("长".repeat(2001));
  await page.getByRole("button", { name: "重新搜索全图", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "搜索主题须为 1 至 2000 个字符" })).toBeVisible();
  await expect(preview.getByRole("button", { name: "应用替换", exact: true })).toBeVisible();
  expect(await readFixtureSnapshots(page)).toHaveLength(3);
  expect((await readFixtureSnapshots(page))[2]?.aborted).toBe(false);
  await topicField.fill("");
  await topicField.evaluate(element => element.setAttribute("maxlength", "2000"));
  const duplicateIds = await page.locator("[id]").evaluateAll(elements => {
    const ids = elements.map(element => element.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  expect(duplicateIds).toEqual([]);
  await preview.getByRole("button", { name: "弃用新结果", exact: true }).click();
  await expect(oldCards).toHaveCount(1);

  await researchNode(3);
  await finish(3);
  await preview.getByRole("button", { name: "追加到此节点", exact: true }).click();
  await working.getByRole("button", { name: "显示更多（2）", exact: true }).click();
  await expect(oldCards).toHaveCount(5);
  await researchNode(4);
  await finish(4);
  await preview.getByRole("button", { name: "追加到此节点", exact: true }).click();
  await expect(oldCards).toHaveCount(9);
  await oldCards.first().getByRole("button", { name: "编辑资源", exact: true }).click();
  await oldCards.first().getByRole("textbox", { name: "资源标题", exact: true }).fill("人工改写的旧资源");
  await oldCards.first().getByRole("button", { name: "保存资源", exact: true }).click();
  await researchNode(5);
  await finish(5);
  // 预览之后又在其他节点加入候选 URL，应用时必须重新去重。
  await otherNode.click();
  await addUrl("https://node-5.example.com/resource-0");
  await preview.getByRole("button", { name: "应用替换", exact: true }).click();
  await targetNode.click();
  await expect(oldCards).toHaveCount(3);
  await expect(working.getByRole("heading", { name: "人工改写的旧资源", exact: true })).toHaveCount(0);
  await expect(oldCards.getByRole("heading", { level: 3 })).toHaveText(["Node result 5-1", "Node result 5-2", "Node result 5-3"]);
  await expect(page.getByRole("definition").filter({ hasText: "已完成" })).toHaveCount(1);

  const edgeEditor = page.locator(".workspace-edge-editor");
  await edgeEditor.locator("summary").click();
  await edgeEditor.getByRole("button", { name: "添加连线", exact: true }).click();
  await expect(working.locator(".react-flow__edge")).toHaveCount(1);
  const position = await targetNode.evaluate(element => getComputedStyle(element).transform);
  await sidebar.getByRole("button", { name: "重命名", exact: true }).click();
  await sidebar.getByRole("textbox", { name: "记录名称" }).fill("完整重搜主题");
  await sidebar.getByRole("button", { name: "保存名称" }).click();
  await expect(page.getByRole("button", { name: "重新搜索全图", exact: true })).toBeDisabled();
  expect(await readFixtureSnapshots(page)).toHaveLength(6);
  await page.getByRole("textbox", { name: "搜索主题", exact: true }).fill("明确填写的全图主题");
  await page.getByRole("button", { name: "重新搜索全图", exact: true }).click();
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(7);
  expect((await readFixtureSnapshots(page))[6]?.nodeSearch).toBeUndefined();
  expect((await readFixtureSnapshots(page))[6]?.query).toBe("明确填写的全图主题");
  await expect(working.locator(".react-flow__node")).toHaveCount(2);
  await finish(6);
  await expect(preview.getByRole("button", { name: "追加到此节点", exact: true })).toHaveCount(0);
  await expect(preview.locator(".react-flow__node")).toHaveCount(4);
  await preview.locator(`.react-flow__node[data-id="${READY_NODE_ID}"]`).click();
  expect(await page.locator("[id]").evaluateAll(elements => {
    const ids = elements.map(element => element.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  })).toEqual([]);
  await preview.getByRole("button", { name: "应用替换", exact: true }).click();
  await expect(working.locator(".react-flow__node")).toHaveCount(4);
  await expect(targetNode).toHaveCount(0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(working.locator(".react-flow__node")).toHaveCount(2);
  await expect(working.locator(".react-flow__edge")).toHaveCount(1);
  await expect(targetNode).toHaveCSS("transform", position);
  await targetNode.click();
  await expect(oldCards).toHaveCount(3);
  await expect(working.getByRole("combobox", { name: "节点搜索引擎", exact: true })).toHaveValue("google");
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  await page.reload();
  await expect(working.locator(".react-flow__node")).toHaveCount(2);
  await expect(working.locator(".react-flow__edge")).toHaveCount(1);
  await expect(targetNode).toHaveCSS("transform", position);
  await targetNode.click();
  await expect(oldCards).toHaveCount(3);
  expect(await readFixtureSnapshots(page)).toHaveLength(0);
});

/** 删除目标或离开所属记录立即中止临时请求，不把晚到结果写入新记录。 */
test("重搜期间删除目标或切换记录会取消请求且不复活旧节点", async ({ page }) => {
  await installBrowserFixture(page, createJourneyEvents());
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "搜索图记录" });
  await expect(sidebar.getByRole("status")).toHaveText("已保存到本浏览器");
  await page.getByRole("textbox", { name: "新节点标题", exact: true }).fill("取消目标");
  await page.getByRole("button", { name: "新建节点", exact: true }).click();
  await sidebar.getByRole("button", { name: "重命名", exact: true }).click();
  await sidebar.getByRole("textbox", { name: "记录名称" }).fill("原图");
  await sidebar.getByRole("button", { name: "保存名称" }).click();
  const working = page.locator(".graph-section");
  const preview = page.getByRole("region", { name: "重搜预览", exact: true });
  await working.getByRole("button", { name: "重新搜索此节点", exact: true }).click();
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(1);
  await working.getByRole("button", { name: "删除节点", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect.poll(async () => (await readFixtureSnapshots(page))[0]).toMatchObject({ aborted: true, cancelled: true });
  await expect(working.locator(".react-flow__node")).toHaveCount(0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(working.locator(".react-flow__node")).toHaveCount(1);
  await working.getByRole("button", { name: "重新搜索此节点", exact: true }).click();
  await expect.poll(async () => (await readFixtureSnapshots(page)).length).toBe(2);
  await sidebar.getByRole("button", { name: "新建搜索", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect.poll(async () => (await readFixtureSnapshots(page))[1]).toMatchObject({ aborted: true, cancelled: true });
  await page.getByRole("textbox", { name: "新节点标题", exact: true }).fill("别的图");
  await page.getByRole("button", { name: "新建节点", exact: true }).click();
  await expect(working.locator(".react-flow__node")).toHaveCount(1);
  await expect(working.getByRole("heading", { name: "别的图", exact: true })).toHaveCount(2);
  await sidebar.getByRole("button", { name: "原图", exact: true }).click();
  await expect(working.getByRole("heading", { name: "取消目标", exact: true })).toHaveCount(2);
  await expect(working.getByRole("list", { name: "节点资源" })).toHaveCount(0);
  expect(await readFixtureSnapshots(page)).toHaveLength(2);
});
