/**
 * 搜索收据回归：假会话与假DAL隔离纯签名／绑定规则，真实生产流水线和事务由本地集成另验。
 * 时钟直接覆盖原40秒RunScope，验证组准备扣原预算、正常连接续租不截Run、终态签名不再访问数据库。
 */
import { readFileSync } from "node:fs";
import type { FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_ACCOUNT_HEADER, GROUP_CONNECTION_HEADER, GROUP_SEARCH_TARGET_HEADER, EditableGraphSchema,
  GroupGraphActionSchema, ResultGraphSchema, type GroupGraphAction, type GroupGraphRecord, type GroupSearchTarget,
} from "@wayfinder/contracts";
import { z } from "zod";
import { AccountDatabase, databaseConfigFromUrl, type DatabaseOperation } from "../accounts/database.js";
import { createAbsoluteRunDeadline } from "../orchestrator/absolute-run-deadline.js";
import { createGroupHistory } from "./history.js";
import { createGroupSearch } from "./search.js";
import type { GroupQuery } from "./storage.js";
import type { GroupSyncRuntime } from "./sync.js";

const fixtureFile: unknown = JSON.parse(readFileSync(new URL("../../../../tests/fixtures/contracts/result-graphs.valid.json", import.meta.url), "utf8"));
const result = ResultGraphSchema.parse(z.object({ ready: z.unknown() }).parse(fixtureFile).ready);
const identity = { userId: "owner", sessionId: "session", email: "fixture@example.test" };
const target: GroupSearchTarget = { groupId: "fixture_group", graphId: "fixture_graph", expectedRevision: 1 };
const initialDocument = EditableGraphSchema.parse({ version: "workspace.v1", id: target.graphId, title: "学习图", query: "",
  language: "zh-CN", presentationMode: "graph", createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:00:00Z",
  lastRunId: null, nodes: [], edges: [], positions: {} });
const request = (scope = target, extraBody: Record<string, unknown> = {}): FastifyRequest => {
  const headers = { host: "127.0.0.1:4321", origin: "http://127.0.0.1:4321", [CLOUD_ACCOUNT_HEADER]: identity.userId,
    [GROUP_CONNECTION_HEADER]: "connection", [GROUP_SEARCH_TARGET_HEADER]: JSON.stringify(scope) };
  return { method: "POST", headers, raw: { rawHeaders: Object.entries(headers).flatMap(([key, value]) => [key, value]) },
    body: { runId: result.runId, query: result.query.raw, language: result.query.language, ...extraBody } } as unknown as FastifyRequest;
};
function fixture() {
  const database = new AccountDatabase(databaseConfigFromUrl("mysql://fixture:fake@127.0.0.1:1/wf_d12_test_search_unit"));
  const claims = new Map<string, string>();
  let epoch = "epoch_a", member = true, account: typeof identity | null = identity;
  let current: GroupGraphRecord = { document: initialDocument, history: createGroupHistory(initialDocument), revision: 1, status: "active", originalIndex: null };
  const query = vi.fn<GroupQuery>(async (sql, values = []) => {
    if (sql.startsWith("SELECT payload FROM wf_user_data")) {
      const payload = claims.get(String(values[1])); return payload === undefined ? [] : [{ payload }];
    }
    if (sql.startsWith("SELECT groupId,")) return [{ groupId: target.groupId, ownerUserId: identity.userId,
      invitationCode: "fixture@example.test#" + "A".repeat(20), payload: { groupId: target.groupId, ownerUserId: identity.userId, name: "组", description: "", revision: 1 } }];
    if (sql.startsWith("SELECT userId FROM wf_group_members")) return member ? [{ userId: identity.userId }] : [];
    if (sql.startsWith("SELECT payload FROM wf_group_data")) return [{ payload: String(values[1]).startsWith("m_")
      ? { kind: "memberEpoch", epoch } : { kind: "graph", recordJson: JSON.stringify(current) } }];
    if (sql.startsWith("INSERT INTO wf_user_data") && String(values[1]).startsWith("gs_")) claims.set(String(values[1]), String(values[2]));
    if (sql.startsWith("UPDATE wf_user_data")) claims.set(String(values[2]), String(values[0]));
    return [];
  });
  const transaction = vi.spyOn(database, "transaction").mockImplementation(async (_operation, action) => action(query));
  const getIdentity = vi.fn<(headers: Headers, operation: DatabaseOperation) => Promise<typeof identity | null>>(async () => account);
  const lease = new AbortController();
  const authorize = vi.fn<GroupSyncRuntime["authorize"]>((_identity, _groupId, connectionId, operation) => {
    if (connectionId !== "connection") throw new Error("fixture invalid proof");
    return { ...operation, signal: lease.signal, deadline: Date.now() + 1 };
  });
  const sync: GroupSyncRuntime = { authorize, open: vi.fn(), notifyGroup: vi.fn(), notifyUser: vi.fn(), close: vi.fn() };
  const secret = "fixture-group-search-domain-key-0000000000000000";
  const options = { database, auth: { getIdentity }, sync, secret };
  const access = createGroupSearch(options);
  return { access, options, database, query, transaction, getIdentity, lease, claims, current: () => current,
    setRecord: (record: GroupGraphRecord) => { current = record; }, setEpoch: (value: string) => { epoch = value; },
    revoke: () => { member = false; }, setAccount: (value: typeof identity | null) => { account = value; },
    cleanup: async () => { transaction.mockRestore(); await database.close(); } };
}
type Apply = Extract<GroupGraphAction, { action: "applySearch" }>;
afterEach(() => { vi.useRealTimers(); });

describe("小组搜索可信完成收据", () => {
  it("双自带路径也冻结身份，普通搜索不claim，相同Run不能再次消耗", async () => {
    const f = fixture(), signal = new AbortController().signal;
    try {
      const ordinary = request(); delete ordinary.headers[GROUP_SEARCH_TARGET_HEADER];
      expect(await f.access.prepare(ordinary, signal, Date.now() + 40_000)).toBeNull();
      expect(f.getIdentity).not.toHaveBeenCalled();
      const prepared = await f.access.prepare(request(), signal, Date.now() + 40_000);
      expect(prepared?.input.runId).toBe(result.runId); expect(f.getIdentity).toHaveBeenCalled();
      await expect(f.access.prepare(request(), signal, Date.now() + 40_000)).rejects.toMatchObject({ code: "GROUP_CONFLICT" });
      f.setAccount(null);
      await expect(prepared?.assertActive(signal)).rejects.toMatchObject({ code: "ACCOUNT_REQUIRED" });
    } finally { await f.cleanup(); }
  });

  it("绑定实际节点上下文，忽略客户端伪造的节点标题和分析", async () => {
    const f = fixture(), signal = new AbortController().signal;
    try {
      const document = EditableGraphSchema.parse({ ...initialDocument, nodes: [{ id: "node", title: "真实标题", description: "真实说明",
        nodeType: "primary", layer: 0, status: "empty", resources: [], warnings: [] }] });
      f.setRecord({ ...f.current(), document, history: createGroupHistory(document) });
      const prepared = await f.access.prepare(request({ ...target, nodeId: "node" }, { nodeSearch: {
        node: { id: "other", title: "伪造", description: "伪造" }, analysis: null } }), signal, Date.now() + 40_000);
      expect(prepared?.input.nodeSearch?.node).toEqual({ id: "node", title: "真实标题", description: "真实说明" });
    } finally { await f.cleanup(); }
  });

  it("签名跨runtime稳定，篡改正文／签名及换会话不能消费，成功只能消费一次", async () => {
    const f = fixture(), signal = new AbortController().signal;
    try {
      const prepared = await f.access.prepare(request(), signal, Date.now() + 40_000);
      if (prepared === null) throw new Error("缺少小组准备结果");
      const receipt = prepared.receipt(result);
      const input = GroupGraphActionSchema.parse({ action: "applySearch", ...target, mutationId: "apply", receipt, result, mode: "replace" }) as Apply;
      const restarted = createGroupSearch(f.options);
      await expect(restarted.consume(f.query, identity.userId, "another_session", input, f.current())).rejects.toMatchObject({ code: "ACCOUNT_REQUIRED" });
      await expect(restarted.consume(f.query, identity.userId, identity.sessionId, { ...input,
        receipt: { ...receipt, signature: receipt.signature.replace(/^./, character => character === "a" ? "b" : "a") } }, f.current()))
        .rejects.toMatchObject({ code: "GROUP_CONSTRAINT" });
      const changed = ResultGraphSchema.parse({ ...result, query: { ...result.query, raw: "被篡改" } });
      await expect(restarted.consume(f.query, identity.userId, identity.sessionId, { ...input, result: changed }, f.current()))
        .rejects.toMatchObject({ code: "GROUP_CONSTRAINT" });
      expect(await restarted.consume(f.query, identity.userId, identity.sessionId, input, f.current())).toEqual(result);
      await expect(restarted.consume(f.query, identity.userId, identity.sessionId, { ...input, mutationId: "apply_again" }, f.current()))
        .rejects.toMatchObject({ code: "GROUP_CONFLICT" });
    } finally { await f.cleanup(); }
  });

  it("冲突不消费，签名基准不改，仅明确确认当前版本才可应用旧预览", async () => {
    const f = fixture(), signal = new AbortController().signal;
    try {
      const prepared = await f.access.prepare(request(), signal, Date.now() + 40_000);
      if (prepared === null) throw new Error("缺少小组准备结果");
      const receipt = prepared.receipt(result), current = { ...f.current(), revision: 2 };
      const input: Apply = { action: "applySearch", groupId: target.groupId, graphId: target.graphId, expectedRevision: 2,
        mutationId: "apply", receipt, result, mode: "replace" };
      await expect(f.access.consume(f.query, identity.userId, identity.sessionId, input, current)).rejects.toMatchObject({ code: "GROUP_CONFLICT" });
      await expect(f.access.consume(f.query, identity.userId, identity.sessionId, { ...input, confirmedRevision: 1 }, current)).rejects.toMatchObject({ code: "GROUP_CONFLICT" });
      expect(receipt.target.expectedRevision).toBe(1);
      expect(await f.access.consume(f.query, identity.userId, identity.sessionId, { ...input, confirmedRevision: 2 }, current)).toEqual(result);
    } finally { await f.cleanup(); }
  });

  it("退出再加入换成员代际后，旧收据及旧Run不能重新有效", async () => {
    const f = fixture(), signal = new AbortController().signal;
    try {
      const prepared = await f.access.prepare(request(), signal, Date.now() + 40_000);
      if (prepared === null) throw new Error("缺少小组准备结果");
      const receipt = prepared.receipt(result);
      f.setEpoch("epoch_b");
      await expect(f.access.consume(f.query, identity.userId, identity.sessionId, { action: "applySearch", ...target,
        mutationId: "apply", receipt, result, mode: "replace" }, f.current())).rejects.toMatchObject({ code: "GROUP_FORBIDDEN" });
      await expect(prepared.assertActive(signal)).rejects.toMatchObject({ code: "GROUP_FORBIDDEN" });
      expect(prepared.signal.aborted).toBe(true);
    } finally { await f.cleanup(); }
  });

  it("组准备沿用原40秒剩余预算，正常30秒租期取消不截Run，期限后签名不做DB写入", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const f = fixture(), parent = new AbortController(), scope = createAbsoluteRunDeadline({ parentSignal: parent.signal });
    try {
      // 模拟前置凭据准备已消耗39900ms；组认证再用50ms、claim再用49ms，只剩原Run的1ms。
      vi.setSystemTime(39_900);
      f.getIdentity.mockImplementationOnce(async (_headers, operation) => { expect(operation.deadline).toBe(40_000); vi.setSystemTime(39_950); return identity; });
      f.transaction.mockImplementationOnce(async (operation, action) => { expect(operation.deadline).toBe(40_000); vi.setSystemTime(39_999); return action(f.query); });
      const prepared = await f.access.prepare(request(), scope.signal, scope.deadlineAt, scope.requirePositiveRemainingMs);
      if (prepared === null) throw new Error("缺少小组准备结果");
      f.lease.abort(); expect(prepared.signal.aborted).toBe(false); expect(scope.signal.aborted).toBe(false);
      const calls = f.query.mock.calls.length, authCalls = f.getIdentity.mock.calls.length;
      vi.setSystemTime(40_000);
      expect(prepared.receipt(result).signature).toMatch(/^[a-f0-9]{64}$/);
      expect(f.query.mock.calls).toHaveLength(calls); expect(f.getIdentity.mock.calls).toHaveLength(authCalls);
      await expect(prepared.assertActive(scope.signal)).rejects.toSatisfy((error: unknown) => scope.isDeadlineReason(error));
      expect(scope.signal.aborted).toBe(true); expect(prepared.signal.aborted).toBe(false);
    } finally { scope.dispose(); await f.cleanup(); }
  });
});
