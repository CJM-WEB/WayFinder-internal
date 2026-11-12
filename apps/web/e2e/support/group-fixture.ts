/**
 * 小组浏览器样例：真实前端、公共Schema及持续NDJSON，HTTP数据全部是假账号和固定图。
 * 这里只脚本化界面用到的动作；CAS、权限竞态及100步历史由前序真实SQL检查负责。
 * 流支持心跳、主动推送、取消和断流，不能用snapshot后EOF冒充在线。
 */
import { expect, type Page } from "@playwright/test";
import {
  CLOUD_ACCOUNT_HEADER, GROUP_CONNECTION_HEADER, AccountProfileActionSchema, CloudGraphWriteRequestSchema,
  EditableGraphSchema, GroupActionSchema, GroupGraphActionSchema, GroupGraphHistorySchema, GroupSyncEventSchema,
  type Account, type GroupGraphReceiptResponse, type CloudGraphRecord, type CloudWorkspaceResponse, type EditableGraph, type GroupDetails,
  type GroupGraphHistory, type GroupGraphRecord, type GroupSyncEvent, type GroupWorkspaceResponse,
} from "@wayfinder/contracts";
import { appendHistory, createGraphHistory, restoreGraphHistory, storeGraphHistory, undoHistoryEvent } from "@wayfinder/contracts/graph-history";

export const fixturePageErrors = new WeakMap<Page, string[]>();
export const FIXTURE_USER = "fixture-group-A", OTHER_USER = "fixture-group-B";
export const FIXTURE_GROUP = "fixture-group-owned", MEMBER_GROUP = "fixture-group-member";
export const INVITATION = "owner@example.test#AbCdEf01234567890123";
const AT = "2026-11-12T00:00:00.000Z";
type RemoteGroup = { details: GroupDetails; workspace: GroupWorkspaceResponse };
type BrowserControl = {
  replace: (groups: Record<string, RemoteGroup>) => void;
  disconnect: () => void;
  reconnect: () => void;
  stats: () => { opened: number; active: number };
};
export function fixtureDocument(id = "fixture-group-graph", title = "组内搜索图"): EditableGraph {
  return EditableGraphSchema.parse({ version: "workspace.v1", id, title, query: "共同学习", language: "zh-CN", presentationMode: "graph",
    createdAt: AT, updatedAt: AT, lastRunId: null, nodes: [
      { id: "fixture-node", title: "共同节点", description: "", nodeType: "primary", layer: 0, status: "empty", resources: [], warnings: [] },
      { id: "fixture-node-2", title: "第二节点", description: "", nodeType: "primary", layer: 0, status: "empty", resources: [], warnings: [] },
    ], edges: [], positions: { "fixture-node": { x: 70, y: 100 }, "fixture-node-2": { x: 430, y: 100 } } });
}
function emptyHistory(document: EditableGraph): GroupGraphHistory {
  const stored = storeGraphHistory(createGraphHistory(document));
  return GroupGraphHistorySchema.parse({ version: "groupHistory.v1", base: stored.base, events: [], redoIdsByUser: {} });
}
/** 复用共享历史差异算法；此样例没有并发合并或窗口裁剪的第二套实现。 */
function append(record: GroupGraphRecord, after: EditableGraph, actor: string, subject: string, kind: "node.edit" | "graph.rename" = "node.edit"): GroupGraphRecord {
  const restored = restoreGraphHistory({ version: "history.v1", base: record.history.base, events: record.history.events, redoIds: [] }, record.document, 100);
  const stored = storeGraphHistory(appendHistory(restored, record.document, after,
    { id: `fixture-event-${record.revision}`, occurredAt: AT, active: true, kind, subject }, 100));
  const actors = new Map(record.history.events.map(event => [event.id, event.actorUserId]));
  return { ...record, document: after, revision: record.revision + 1,
    history: GroupGraphHistorySchema.parse({ ...record.history, base: stored.base,
      events: stored.events.map(event => ({ ...event, actorUserId: actors.get(event.id) ?? actor, undoable: true })) }) };
}
function makeGroup(groupId: string, owner = FIXTURE_USER): RemoteGroup {
  const document = fixtureDocument(groupId === FIXTURE_GROUP ? undefined : "fixture-member-graph");
  let record: GroupGraphRecord = { document, history: emptyHistory(document), revision: 1, status: "active", originalIndex: null };
  record = append(record, { ...record.document, nodes: record.document.nodes.map((node, index) => index === 0 ? { ...node, description: "本人说明" } : node) }, FIXTURE_USER, "本人记录");
  record = append(record, { ...record.document, nodes: record.document.nodes.map((node, index) => index === 1 ? { ...node, description: "他人说明" } : node) }, OTHER_USER, "他人记录");
  return { details: { group: { groupId, name: groupId === FIXTURE_GROUP ? "学习小组" : "伙伴小组", description: "一起探索网页", ownerUserId: owner, revision: 1 },
    members: [{ userId: owner, nickname: owner === FIXTURE_USER ? "小甲" : "小乙", role: "owner" },
      { userId: owner === FIXTURE_USER ? OTHER_USER : FIXTURE_USER, nickname: owner === FIXTURE_USER ? "小乙" : "小甲", role: "member" }],
    invitationCode: owner === FIXTURE_USER ? INVITATION : null },
    workspace: { groupId, revision: 1, graphs: [record], activeOrder: [document.id], deletedIds: [] } };
}

export async function installGroupFixture(page: Page, options: { nickname?: string | null; empty?: boolean } = {}) {
  const pageErrors: string[] = []; fixturePageErrors.set(page, pageErrors); page.on("pageerror", error => pageErrors.push(error.message));
  let account: Account | null = { userId: FIXTURE_USER, email: "owner@example.test" };
  let nickname = options.nickname === undefined ? "小甲" : options.nickname;
  const groups: Record<string, RemoteGroup> = options.empty ? {} : { [FIXTURE_GROUP]: makeGroup(FIXTURE_GROUP), [MEMBER_GROUP]: makeGroup(MEMBER_GROUP, OTHER_USER) };
  const privateDocument = fixtureDocument("fixture-private-graph", "个人源图");
  const privateHistory = storeGraphHistory(appendHistory(createGraphHistory(privateDocument), privateDocument, { ...privateDocument, title: "个人源图已改名" },
    { id: "fixture-private-event", occurredAt: AT, active: true, kind: "graph.rename", subject: "个人源图已改名" }, 100));
  const personal: CloudWorkspaceResponse = { userId: FIXTURE_USER, graphs: [{ document: { ...privateDocument, title: "个人源图已改名" }, history: privateHistory,
    revision: 1, status: "active", originalIndex: null }], activeOrder: [privateDocument.id], deletedIds: [] };
  const requests: Array<{ path: string; body: unknown; proof: string | undefined }> = [];
  const receipts = new Map<string, GroupGraphReceiptResponse>();
  let rejectedEdits = 0;
  let heldManagement: { action: "leave" | "dissolve"; started: () => void; released: Promise<void> } | undefined;
  let serial = 0;
  const nextId = () => `fixture-generated-${++serial}`;
  const publish = async () => {
    for (const remote of Object.values(groups)) GroupSyncEventSchema.parse({ type: "snapshot", sequence: 0, connectionId: "fixture-validation", ...remote });
    await page.evaluate(({ groups }) => {
      (window as unknown as { groupFixture: BrowserControl }).groupFixture.replace(groups);
    }, { groups: structuredClone(groups) });
  };
  // 与既有浏览器旅程相同，在应用模块之前安装可控ReadableStream；其余fetch保留真实路由。
  await page.addInitScript(({ initial }) => {
    const original = globalThis.fetch.bind(globalThis), encoder = new TextEncoder();
    let groups = initial, disconnected = false, opened = 0;
    type Stream = { id: string; groupId: string; sequence: number; controller: ReadableStreamDefaultController<Uint8Array>; timer?: ReturnType<typeof setInterval>; closed: boolean };
    const streams = new Set<Stream>();
    const emit = (stream: Stream, event: GroupSyncEvent) => {
      if (!stream.closed) stream.controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    };
    const shutdown = (stream: Stream) => {
      if (stream.closed) return; stream.closed = true; clearInterval(stream.timer); streams.delete(stream);
      try { stream.controller.close(); } catch { /* Reader取消后无需重复关闭。 */ }
    };
    const replace = (next: Record<string, RemoteGroup>) => {
      groups = next;
      for (const stream of streams) {
        const remote = groups[stream.groupId];
        if (remote === undefined) { emit(stream, { type: "revoked", code: "GROUP_NOT_FOUND" }); shutdown(stream); }
        else emit(stream, { type: "snapshot", sequence: ++stream.sequence, connectionId: stream.id, ...remote });
      }
    };
    Object.assign(window, { groupFixture: { replace, disconnect: () => { disconnected = true; for (const stream of streams) shutdown(stream); },
      reconnect: () => { disconnected = false; }, stats: () => ({ opened, active: streams.size }) } satisfies BrowserControl });
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname !== "/api/group-sync") return original(input, init);
      if (disconnected) return Response.json({ code: "GROUP_UNAVAILABLE" }, { status: 503 });
      const groupId = url.searchParams.get("groupId") ?? "", remote = groups[groupId];
      if (remote === undefined) return Response.json({ code: "GROUP_NOT_FOUND" }, { status: 404 });
      const signal = init?.signal; let stream: Stream;
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        stream = { id: `fixture-proof-${++opened}`, groupId, sequence: 0, controller, closed: false }; streams.add(stream);
        emit(stream, { type: "snapshot", sequence: 0, connectionId: stream.id, ...remote });
        stream.timer = setInterval(() => emit(stream, { type: "heartbeat", sequence: ++stream.sequence }), 1_000);
        signal?.addEventListener("abort", () => shutdown(stream), { once: true }); if (signal?.aborted) shutdown(stream);
      }, cancel() { shutdown(stream); } });
      return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
    };
    localStorage.setItem("wayfinder.credentials.v1", JSON.stringify({ deepseek: { source: "own", apiKey: "fixture-group-llm" }, serpapi: { source: "own", apiKey: "fixture-group-search" } }));
    const canvas = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: function (this: HTMLCanvasElement, kind: string, ...args: unknown[]) {
      return kind.includes("webgl") ? null : Reflect.apply(canvas, this, [kind, ...args]) as RenderingContext | null;
    } });
  }, { initial: structuredClone(groups) });
  await page.context().route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const proof = request.headers()[GROUP_CONNECTION_HEADER];
    if (url.pathname === "/api/account") {
      if (method === "POST") { const body = request.postDataJSON() as { action: string }; if (body.action === "logout") account = null; }
      return route.fulfill({ json: { account } });
    }
    if (url.pathname === "/api/profile") {
      if (method === "POST") { const body: unknown = request.postDataJSON(); requests.push({ path: url.pathname, body, proof }); nickname = AccountProfileActionSchema.parse(body).nickname;
        for (const remote of Object.values(groups)) { const member = remote.details.members.find(value => value.userId === FIXTURE_USER); if (member) member.nickname = nickname; }
        await publish(); }
      return route.fulfill({ json: { profile: { userId: FIXTURE_USER, nickname } } });
    }
    if (url.pathname === "/api/workspace") {
      if (method === "POST") {
        const body = CloudGraphWriteRequestSchema.parse(request.postDataJSON());
        expect(body.action).toBe("save");
        if (body.action === "save") {
          const old = personal.graphs.find(record => record.document.id === body.document.id);
          personal.graphs = [...personal.graphs.filter(record => record.document.id !== body.document.id), { document: body.document, history: body.history, revision: (old?.revision ?? 0) + 1, status: "active", originalIndex: null }];
          if (!old) personal.activeOrder.push(body.document.id);
          return route.fulfill({ json: { userId: FIXTURE_USER, record: personal.graphs.at(-1), activeOrder: personal.activeOrder, deletedIds: personal.deletedIds } });
        }
      }
      return route.fulfill({ json: personal });
    }
    if (url.pathname === "/api/group-receipt") {
      const mutationId = url.searchParams.get("mutationId") ?? "";
      return route.fulfill({ json: receipts.get(mutationId) ?? { mutationId, applied: false, groupId: null, graphId: null, personalGraphId: null } });
    }
    if (url.pathname !== "/api/groups" && url.pathname !== "/api/group-workspace") return route.fulfill({ status: 503, json: { code: "GROUP_UNAVAILABLE" } });
    expect(request.headers()[CLOUD_ACCOUNT_HEADER]).toBe(FIXTURE_USER);
    if (method === "GET") {
      const groupId = url.searchParams.get("groupId");
      if (url.pathname === "/api/groups" && groupId === null) return route.fulfill({ json: { groups: Object.values(groups).map(value => value.details.group) } });
      const remote = groups[groupId ?? ""];
      return remote ? route.fulfill({ json: url.pathname === "/api/groups" ? remote.details : remote.workspace })
        : route.fulfill({ status: 404, json: { code: "GROUP_NOT_FOUND" } });
    }
    const body: unknown = request.postDataJSON(); requests.push({ path: url.pathname, body, proof });
    if (url.pathname === "/api/groups") {
      const action = GroupActionSchema.parse(body);
      if (action.action !== "create" && action.action !== "join") expect(proof).toMatch(/^fixture-proof-/);
      let remote: RemoteGroup | undefined;
      if (action.action === "create" || action.action === "join") {
        if (nickname === null) return route.fulfill({ status: 409, json: { code: "NICKNAME_REQUIRED" } });
        remote = makeGroup(nextId(), action.action === "create" ? FIXTURE_USER : OTHER_USER);
        remote.details.group.name = action.action === "create" ? action.name : "加入的小组";
        remote.details.group.description = action.action === "create" ? action.description : "邀请加入";
        const member = remote.details.members.find(value => value.userId === FIXTURE_USER); if (member) member.nickname = nickname;
        groups[remote.details.group.groupId] = remote;
      } else {
        remote = groups[action.groupId]; expect(remote).toBeDefined(); if (!remote) throw new Error("固定小组缺失");
        if (action.action === "update") { remote.details.group = { ...remote.details.group, name: action.name, description: action.description, revision: remote.details.group.revision + 1 }; remote.workspace.revision = remote.details.group.revision; }
        else { delete groups[action.groupId]; remote = undefined; }
      }
      if (heldManagement?.action === action.action) { const held = heldManagement; heldManagement = undefined; held.started(); await held.released; }
      await publish(); return route.fulfill({ json: { groups: Object.values(groups).map(value => value.details.group), details: remote?.details ?? null } });
    }
    expect(proof).toMatch(/^fixture-proof-/);
    const action = GroupGraphActionSchema.parse(body), remote = groups[action.groupId];
    if (action.action === "edit" && rejectedEdits > 0) { rejectedEdits--; return route.fulfill({ status: 409, json: { code: "GROUP_CONFLICT" } }); }
    if (!remote) throw new Error("固定小组缺失");
    let personalGraph: CloudGraphRecord | undefined, appliedGraphId: string;
    if (action.action === "create" || action.action === "copyIn") {
      const source = action.action === "create" ? action.document : personal.graphs.find(record => record.document.id === action.sourceGraphId)?.document;
      if (!source) throw new Error("固定复制源缺失");
      const document = { ...source, id: nextId() }; appliedGraphId = document.id;
      remote.workspace.graphs.push({ document, history: emptyHistory(document), revision: 1, status: "active", originalIndex: null }); remote.workspace.activeOrder.push(document.id);
    } else {
      appliedGraphId = action.graphId;
      const record = remote.workspace.graphs.find(value => value.document.id === action.graphId); if (!record) throw new Error("固定图缺失");
      if (action.action === "edit") remote.workspace.graphs = remote.workspace.graphs.map(value => value === record ? append(record, action.after, FIXTURE_USER, action.subject, action.kind === "graph.rename" ? "graph.rename" : "node.edit") : value);
      else if (action.action === "copyOut") {
        const document = { ...record.document, id: nextId() };
        personalGraph = { document, history: storeGraphHistory(createGraphHistory(document)), revision: 1, status: "active", originalIndex: null };
        personal.graphs.push(personalGraph); personal.activeOrder.push(document.id);
      } else if (action.action === "undo") {
        const restored = restoreGraphHistory({ version: "history.v1", base: record.history.base, events: record.history.events, redoIds: [] }, record.document, 100);
        const changed = undoHistoryEvent(restored, action.eventId); expect(changed.ok).toBe(true);
        if (changed.ok) {
          const stored = storeGraphHistory(changed.history), actors = new Map(record.history.events.map(event => [event.id, event.actorUserId]));
          record.document = changed.graph; record.revision++;
          record.history = GroupGraphHistorySchema.parse({ ...record.history, base: stored.base, events: stored.events.map(event => ({ ...event, actorUserId: actors.get(event.id), undoable: true })), redoIdsByUser: { [FIXTURE_USER]: [action.eventId] } });
        }
      } else throw new Error(`未脚本化的小组动作：${action.action}`);
    }
    if (action.action !== "copyOut") { remote.workspace.revision++; remote.details.group.revision = remote.workspace.revision; }
    receipts.set(action.mutationId, { mutationId: action.mutationId, applied: true, groupId: action.groupId, graphId: appliedGraphId, personalGraphId: personalGraph?.document.id ?? null });
    await publish(); return route.fulfill({ json: { workspace: remote.workspace, ...(personalGraph === undefined ? {} : { personalGraph }) } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  return { groups, personal, requests,
    rejectNextEdit: () => { rejectedEdits++; },
    holdManagement(action: "leave" | "dissolve") {
      let started: () => void = () => {}, release: () => void = () => {};
      const entered = new Promise<void>(resolve => { started = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      heldManagement = { action, started, released }; return { entered, release };
    },
    disconnect: async () => { await page.context().setOffline(true); await page.evaluate(() => (window as unknown as { groupFixture: BrowserControl }).groupFixture.disconnect()); },
    reconnect: async () => { await page.evaluate(() => (window as unknown as { groupFixture: BrowserControl }).groupFixture.reconnect()); await page.context().setOffline(false); },
    streamStats: () => page.evaluate(() => (window as unknown as { groupFixture: BrowserControl }).groupFixture.stats()),
    async pushOtherEdit(title: string) {
      const remote = groups[FIXTURE_GROUP]; if (!remote) throw new Error("固定小组缺失");
      const record = remote.workspace.graphs[0]; if (!record) throw new Error("固定图缺失");
      remote.workspace.graphs[0] = append(record, { ...record.document, nodes: record.document.nodes.map((node, index) => index === 0 ? { ...node, title } : node) }, OTHER_USER, title);
      remote.workspace.revision++; remote.details.group.revision = remote.workspace.revision; await publish();
    },
  };
}
