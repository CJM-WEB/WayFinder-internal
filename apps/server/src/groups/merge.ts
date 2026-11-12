/**
 * 模块职责：检查客户端本次真正改动的字段，再用既有历史差异算法合并到最新共享图。
 * 同字段冲突拒绝；实体按稳定ID定位，排序作为所属集合的一个字段，派生序位不单独冲突。
 * URL与人工来源在服务端规范化，最终图再通过去重、端点、状态与DAG硬约束。
 */
import { canonicalizeHttpUrl, EditableGraphSchema, type EditableGraph, type EditableNode, type EditableResource } from "@wayfinder/contracts";
import { applyGraphDifference } from "@wayfinder/contracts/graph-history";
import { GroupAccessError } from "./errors.js";

const same = (first: unknown, second: unknown): boolean => JSON.stringify(first) === JSON.stringify(second);
const omit = (value: object, keys: readonly string[]): object => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const nodeDerived = ["status", "warnings", "error"];
const resourceFields = ["title", "url", "summary", "whySelected"];
function fields(current: object, before: object, after: object, ignored: readonly string[] = []): void {
  const old = before as Record<string, unknown>, incoming = after as Record<string, unknown>, latest = current as Record<string, unknown>;
  for (const key of new Set([...Object.keys(old), ...Object.keys(incoming)])) {
    if (ignored.includes(key) || same(old[key], incoming[key])) continue;
    if (!same(latest[key], old[key]) && !same(latest[key], incoming[key])) throw new GroupAccessError("GROUP_CONFLICT");
  }
}

function entities<T extends { id: string }>(current: readonly T[], before: readonly T[], after: readonly T[],
  changed: (current: T, before: T, after: T) => void, comparable: (value: T) => unknown = value => value): void {
  const old = new Map(before.map(value => [value.id, value])), next = new Map(after.map(value => [value.id, value]));
  const latest = new Map(current.map(value => [value.id, value]));
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const previous = old.get(id), incoming = next.get(id), present = latest.get(id);
    if (previous === undefined) {
      // 不同动作不能借相同实体ID覆盖对方；同一动作重试已由事务收据处理。
      if (present !== undefined) throw new GroupAccessError("GROUP_CONFLICT");
    } else if (incoming === undefined) {
      if (present !== undefined && !same(comparable(present), comparable(previous))) throw new GroupAccessError("GROUP_CONFLICT");
    } else if (!same(previous, incoming)) {
      if (present === undefined) throw new GroupAccessError("GROUP_CONFLICT");
      changed(present, previous, incoming);
    }
  }
  const ids = new Set(before.filter(value => next.has(value.id)).map(value => value.id));
  const oldOrder = before.filter(value => ids.has(value.id)).map(value => value.id);
  const newOrder = after.filter(value => ids.has(value.id)).map(value => value.id);
  if (!same(oldOrder, newOrder)) {
    const latestOrder = current.filter(value => ids.has(value.id)).map(value => value.id);
    if (!same(latestOrder, oldOrder) && !same(latestOrder, newOrder)) throw new GroupAccessError("GROUP_CONFLICT");
  }
}

/** 手工修改只接受展示字段；换URL或新增资源不能继续冒用旧网页的搜索来源和日期。 */
function manualResource(previous: EditableResource | undefined, incoming: EditableResource): EditableResource {
  const canonical = canonicalizeHttpUrl(incoming.url);
  if (canonical === null) throw new GroupAccessError("GROUP_CONSTRAINT");
  // 未触碰的合法搜索URL保留原表示，避免仅补尾斜杠／改主机大小写就把ready/partial误判成人工修改。
  const url = previous?.url === incoming.url ? previous.url : new URL(incoming.url).href;
  const canonicalUrl = canonical.href, domain = canonical.hostname.toLowerCase();
  const presentation = { id: incoming.id, title: incoming.title, summary: incoming.summary, whySelected: incoming.whySelected,
    rank: incoming.rank, url, canonicalUrl, domain };
  return previous === undefined || canonicalizeHttpUrl(previous.url)?.href !== canonicalUrl
    ? { ...presentation, origin: "manual", sourceType: "user_added" }
    : { ...previous, ...presentation };
}
function normalizedAfter(before: EditableGraph, after: EditableGraph): EditableGraph {
  const nodes = after.nodes.map(input => {
    const old = before.nodes.find(value => value.id === input.id);
    // 搜索计划同来源元数据一样只能由可信搜索应用建立；手工字段变化不能伪造一次检索。
    const node = { ...input };
    if (old?.searchPlan === undefined) delete node.searchPlan;
    else node.searchPlan = old.searchPlan;
    const resources = node.resources.map(resource => manualResource(old?.resources.find(value => value.id === resource.id), resource));
    const changed = old === undefined || old.title !== node.title || old.description !== node.description || !same(old.resources, resources);
    if (!changed && old !== undefined) {
      // 派生状态来自已确认的源图；忽略客户端单独提交的ready／警告／错误，不能把人工内容伪装成检索结论。
      const retained = { ...node, resources, status: old.status, warnings: old.warnings };
      if (old.error === undefined) delete retained.error;
      else retained.error = old.error;
      return retained;
    }
    const edited = { ...node, resources, status: resources.length === 0 ? "empty" as const : "edited" as const, warnings: [] };
    delete edited.error;
    return edited;
  });
  const content = { ...after, nodes, id: before.id, createdAt: before.createdAt, updatedAt: before.updatedAt, lastRunId: before.lastRunId };
  if (before.analysis === undefined) delete content.analysis;
  else content.analysis = before.analysis;
  const parsed = EditableGraphSchema.safeParse(content);
  if (!parsed.success) throw new GroupAccessError("GROUP_CONSTRAINT");
  return parsed.data;
}
const nodeComparable = (node: EditableNode): unknown => ({ ...omit(node, nodeDerived), resources: node.resources.map(resource => omit(resource, ["rank"])) });

/** 复制保留源内容；对已存源和搜索应用只验证真实URL，不静默改写来源或历史。 */
export function assertGroupResourceUrls(document: EditableGraph): void {
  const urls = new Set<string>();
  for (const node of document.nodes) for (const resource of node.resources) {
    const canonical = canonicalizeHttpUrl(resource.url);
    if (canonical === null || canonical.href !== resource.canonicalUrl || canonical.hostname.toLowerCase() !== resource.domain
      || urls.has(canonical.href)) throw new GroupAccessError("GROUP_CONSTRAINT");
    urls.add(canonical.href);
  }
}

/** 普通新建是人工内容入口；真实搜索随后经独立应用边界写入，内容复制使用原来源校验。 */
export function normalizeGroupCreate(document: EditableGraph): EditableGraph {
  const manual = { ...document, lastRunId: null };
  delete manual.analysis;
  const baseline = EditableGraphSchema.parse({ ...manual, nodes: [], edges: [], positions: {} });
  return normalizedAfter(baseline, manual);
}

export function mergeGroupEdit(current: EditableGraph, before: EditableGraph, inputAfter: EditableGraph): EditableGraph {
  if (current.id !== before.id || current.id !== inputAfter.id) throw new GroupAccessError("GROUP_CONFLICT");
  const after = normalizedAfter(before, inputAfter);
  fields(current, before, after, ["id", "createdAt", "updatedAt", "nodes", "edges", "positions"]);
  entities(current.nodes, before.nodes, after.nodes, (present, old, incoming) => {
    fields(present, old, incoming, ["resources", ...nodeDerived]);
    entities(present.resources, old.resources, incoming.resources,
      (resource, previous, next) => fields(resource, previous, next,
        Object.keys({ ...previous, ...next }).filter(key => !resourceFields.includes(key))), resource => omit(resource, ["rank"]));
  }, nodeComparable);
  entities(current.edges, before.edges, after.edges, (present, old, incoming) => fields(present, old, incoming));
  for (const id of new Set([...Object.keys(before.positions), ...Object.keys(after.positions)])) {
    const old = before.positions[id], incoming = after.positions[id], present = current.positions[id];
    if (!same(old, incoming) && !same(present, old) && !same(present, incoming)) throw new GroupAccessError("GROUP_CONFLICT");
  }
  const sanitizedBefore = { ...before, createdAt: current.createdAt, updatedAt: current.updatedAt };
  const result = applyGraphDifference(current, sanitizedBefore, { ...after, createdAt: current.createdAt, updatedAt: current.updatedAt });
  if (!result.ok) throw new GroupAccessError(result.reason === "dependency" ? "GROUP_DEPENDENCY" : "GROUP_CONSTRAINT");
  return result.graph;
}
