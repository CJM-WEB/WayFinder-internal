/**
 * 测试职责：从公开 Store 入口验证选择性撤销，不用测试后门改写快照或事件 active。
 * 夹具只使用合法编辑图；所有重搜结果均为固定内存样例，不进行网络或 Provider 调用。
 */
import { describe, expect, it } from "vitest";
import { EditableGraphSchema, type EditableGraph } from "@wayfinder/contracts";
import { pythonResultGraphFixture } from "../fixtures/python-result-graph.js";
import {
  addEdge, addNode, addResource, deleteEdge, deleteNode, deleteResource,
  moveNode, moveResource, updateEdge, updateNode, updateResource,
} from "./workspace-edits.js";
import { applyGraphSearchResult, applyNodeSearchResult } from "./workspace-research.js";
import { createEmptyGraph, createWorkspaceStore, fromResultGraph, selectCurrentGraph, selectWorkspaceHistory,
  type WorkspaceHistoryDescription } from "./workspace-store.js";

const baseGraph = (): EditableGraph => addNode(addNode(createEmptyGraph("图", "原图", "zh-CN", "2026-01-01T00:00:00Z"),
  "甲", "原说明", "甲"), "乙", "", "乙");
const setup = (graph = baseGraph()) => {
  let number = 0, milliseconds = 0;
  const store = createWorkspaceStore({
    createEventId: () => `事件${++number}`,
    now: () => new Date(Date.parse("2026-11-03T00:00:00Z") + milliseconds++).toISOString(),
  });
  store.getState().addGraph(graph);
  const current = (): EditableGraph => {
    const document = selectCurrentGraph(store.getState());
    if (document === null) throw new Error("测试缺少当前图");
    return document;
  };
  return { store, current, edit: (change: (graph: EditableGraph) => EditableGraph, description?: WorkspaceHistoryDescription) => store.getState().replaceGraph(change(current()), description),
    events: () => selectWorkspaceHistory(store.getState()),
    undo: (index: number) => {
      const event = selectWorkspaceHistory(store.getState())[index];
      if (event === undefined) throw new Error("测试缺少目标事件");
      return store.getState().undoEvent(event.id);
    } };
};

describe("选择性会话撤销", () => {
  it("撤销节点标题不回退后续新增资源，事件保存真实时间、动作和稳定身份", () => {
    const test = setup();
    test.edit(graph => updateNode(graph, "甲", { title: "甲的新标题" }));
    test.edit(graph => addResource(graph, "甲", "https://independent.example.com/", "资源"));
    expect(test.events()[0]).toMatchObject({ id: "事件1", occurredAt: "2026-11-03T00:00:00.000Z", kind: "node.edit", subject: "甲 → 甲的新标题", active: true });
    expect(test.events()[0]?.occurredAt).not.toBe(test.current().updatedAt);
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().nodes[0]).toMatchObject({ title: "甲", status: "edited", resources: [{ id: "资源" }] });
    expect(test.events()[0]).toMatchObject({ id: "事件1", active: false });
    expect(test.events()[0]).not.toHaveProperty("before");
    expect(test.events()[0]).not.toHaveProperty("after");
  });

  it("同字段 A→B→C 中撤 B 保留 C，再撤 C 回到 A，重做仍恢复真实事件", () => {
    const test = setup();
    test.edit(graph => updateNode(graph, "甲", { title: "B" }));
    test.edit(graph => updateNode(graph, "甲", { title: "C" }));
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().nodes[0]?.title).toBe("C");
    expect(test.undo(1)).toEqual({ ok: true });
    expect(test.current().nodes[0]?.title).toBe("甲");
    expect(test.store.getState().histories["图"]?.past).toHaveLength(0);
    expect(test.store.getState().histories["图"]?.future).toHaveLength(2);
    test.store.getState().redo();
    expect(test.current().nodes[0]?.title).toBe("C");
    test.store.getState().redo();
    expect(test.current().nodes[0]?.title).toBe("C");
    expect(test.events().every(event => event.active)).toBe(true);
  });

  it("新增节点之后有资源时阻断，后续依赖先撤销后可重新执行同一事件", () => {
    const test = setup();
    test.edit(graph => addNode(graph, "新节点", "", "新"));
    const originalView = test.events()[0];
    expect(originalView?.blockedReason).toBeUndefined();
    test.edit(graph => addResource(graph, "新", "https://dependency.example.com/", "资源"));
    const before = test.store.getState();
    expect(test.undo(0)).toEqual({ ok: false, reason: "dependency" });
    expect(test.store.getState()).toBe(before);
    expect(test.events()[0]?.blockedReason).toBe("dependency");
    expect(test.undo(1)).toEqual({ ok: true });
    expect(test.events()[0]?.blockedReason).toBeUndefined();
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().nodes.some(node => node.id === "新")).toBe(false);
  });

  it("节点连线或布局依赖都不能在撤销新增时被级联删除", () => {
    for (const dependent of [
      (graph: EditableGraph) => addEdge(graph, "甲", "新", "related_to", "连线"),
      (graph: EditableGraph) => moveNode(graph, "新", { x: 345, y: 678 }),
    ]) {
      const test = setup();
      test.edit(graph => addNode(graph, "新", "", "新"));
      test.edit(dependent);
      const before = test.current();
      expect(test.undo(0)).toEqual({ ok: false, reason: "dependency" });
      expect(test.current()).toBe(before);
    }
  });

  it("新增节点后的资源已主动删除则允许撤新增，删除被撤回时依赖重新阻断", () => {
    const test = setup();
    test.edit(graph => addNode(graph, "新节点", "", "新"));
    test.edit(graph => addResource(graph, "新", "https://resolved.example.com/", "资源"));
    test.edit(graph => deleteResource(graph, "新", "资源"));
    expect(test.events()[0]?.blockedReason).toBeUndefined();
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().nodes.some(node => node.id === "新")).toBe(false);
    const before = test.store.getState();
    expect(test.undo(2)).toEqual({ ok: false, reason: "dependency" });
    expect(test.store.getState()).toBe(before);
    test.store.getState().redo();
    expect(test.current().nodes.find(node => node.id === "新")?.resources).toEqual([]);
    expect(test.undo(2)).toEqual({ ok: true });
    expect(test.events()[0]?.blockedReason).toBe("dependency");
  });

  it("新增资源后的说明编辑已随资源删除而消解，撤新增不误报临时依赖", () => {
    const test = setup();
    test.edit(graph => addResource(graph, "甲", "https://removed.example.com/", "资源"));
    test.edit(graph => updateResource(graph, "甲", "资源", { summary: "后来说明" }));
    test.edit(graph => deleteResource(graph, "甲", "资源"));
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().nodes[0]?.resources).toEqual([]);
    expect(test.undo(2)).toEqual({ ok: false, reason: "dependency" });
    test.store.getState().redo();
    expect(test.current().nodes[0]?.resources).toEqual([]);
  });

  it("缺失目标上的文本已改回初值或连线已删除时，不保留幽灵依赖", () => {
    const text = setup();
    text.edit(graph => addNode(graph, "新节点", "", "新"));
    text.edit(graph => updateNode(graph, "新", { title: "临时标题" }));
    text.edit(graph => updateNode(graph, "新", { title: "新节点" }));
    expect(text.undo(0)).toEqual({ ok: true });
    expect(text.current().nodes.some(node => node.id === "新")).toBe(false);
    const edge = setup();
    edge.edit(graph => addEdge(graph, "甲", "乙", "related_to", "关系"));
    edge.edit(graph => updateEdge(graph, "关系", { type: "recommended_next" }));
    edge.edit(graph => deleteEdge(graph, "关系"));
    expect(edge.undo(0)).toEqual({ ok: true });
    expect(edge.current().edges).toEqual([]);
  });

  it("资源新增后又有内容编辑时保留依赖，先撤内容后才可撤新增", () => {
    const test = setup();
    test.edit(graph => addResource(graph, "甲", "https://resource.example.com/", "资源"));
    test.edit(graph => updateResource(graph, "甲", "资源", { summary: "人工说明" }));
    expect(test.undo(0)).toEqual({ ok: false, reason: "dependency" });
    expect(test.undo(1)).toEqual({ ok: true });
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().nodes[0]?.resources).toHaveLength(0);
  });

  it("资源说明和选用理由为独立字段，撤说明不覆盖后续理由", () => {
    const test = setup(addResource(baseGraph(), "甲", "https://fields.example.com/", "资源"));
    test.edit(graph => updateResource(graph, "甲", "资源", { summary: "新说明" }));
    test.edit(graph => updateResource(graph, "甲", "资源", { whySelected: "新理由" }));
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().nodes[0]?.resources[0]).toMatchObject({ summary: "", whySelected: "新理由" });
  });

  it("撤销资源排序恢复顺序与连续rank，但保留后续资源文本", () => {
    let graph = baseGraph();
    for (const id of ["一", "二", "三"]) graph = addResource(graph, "甲", `https://order.example.com/${id}`, id);
    const test = setup(graph);
    test.edit(current => moveResource(current, "甲", "一", "三"));
    test.edit(current => updateResource(current, "甲", "二", { summary: "后续内容" }));
    expect(test.undo(0)).toEqual({ ok: true });
    const resources = test.current().nodes[0]?.resources;
    expect(resources?.map(resource => [resource.id, resource.rank])).toEqual([["一", 1], ["二", 2], ["三", 3]]);
    expect(resources?.[1]?.summary).toBe("后续内容");
  });

  it("恢复资源若与其他节点当前URL重复则阻断，不改变图和重做分支", () => {
    const test = setup(addResource(baseGraph(), "甲", "https://unique.example.com/", "原资源"));
    test.edit(graph => deleteResource(graph, "甲", "原资源"));
    test.edit(graph => addResource(graph, "乙", "https://unique.example.com/", "新资源"));
    const before = test.store.getState();
    expect(test.undo(0)).toEqual({ ok: false, reason: "constraint" });
    expect(test.store.getState()).toBe(before);
    expect(test.events()[0]?.blockedReason).toBe("constraint");
  });

  it("临时前缀重复URL已被后续删除解决时，按最终合法图允许恢复原资源", () => {
    const test = setup(addResource(baseGraph(), "甲", "https://temporary.example.com/", "原资源"));
    test.edit(graph => deleteResource(graph, "甲", "原资源"));
    test.edit(graph => addResource(graph, "乙", "https://temporary.example.com/", "临时资源"));
    test.edit(graph => deleteResource(graph, "乙", "临时资源"));
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().nodes[0]?.resources.map(resource => resource.id)).toEqual(["原资源"]);
    expect(test.current().nodes[1]?.resources).toEqual([]);
    // 旧工具栏可见快照必须仍合法；非法前缀只留在本次内部重放中。
    for (const snapshot of test.store.getState().histories["图"]?.past ?? []) expect(EditableGraphSchema.safeParse(snapshot).success).toBe(true);
    const before = test.store.getState();
    expect(test.undo(2)).toEqual({ ok: false, reason: "constraint" });
    expect(test.store.getState()).toBe(before);
    test.store.getState().redo();
    expect(test.current().nodes.every(node => node.resources.length === 0)).toBe(true);
  });

  it("恢复已删推荐边若与后续边形成环则阻断，相关边仍按原Schema允许成环", () => {
    const test = setup(addEdge(baseGraph(), "甲", "乙", "recommended_next", "原边"));
    test.edit(graph => deleteEdge(graph, "原边"));
    test.edit(graph => addEdge(graph, "乙", "甲", "recommended_next", "后续边"));
    expect(test.undo(0)).toEqual({ ok: false, reason: "constraint" });
    expect(test.current().edges.map(edge => edge.id)).toEqual(["后续边"]);
  });

  it("连线类型与端点按字段独立撤销，不覆盖后来的端点选择", () => {
    const graph = addEdge(addNode(baseGraph(), "丙", "", "丙"), "甲", "乙", "related_to", "边");
    const test = setup(graph);
    test.edit(current => updateEdge(current, "边", { type: "recommended_next" }));
    test.edit(current => updateEdge(current, "边", { target: "丙" }));
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().edges[0]).toEqual({ id: "边", source: "甲", target: "丙", type: "related_to" });
  });

  it("撤销删空资源后保留后续节点编辑，并按恢复后的资源数校准人工状态", () => {
    const test = setup(addResource(baseGraph(), "甲", "https://state.example.com/", "资源"));
    test.edit(graph => deleteResource(graph, "甲", "资源"));
    test.edit(graph => updateNode(graph, "甲", { description: "删空后编辑" }));
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().nodes[0]).toMatchObject({ description: "删空后编辑", status: "edited", resources: [{ id: "资源" }] });
  });

  it("布局按节点与坐标字段重放，撤x移动保留后续y移动及文本", () => {
    const test = setup();
    const original = test.current().positions["甲"];
    if (original === undefined) throw new Error("缺少原布局");
    test.edit(graph => moveNode(graph, "甲", { x: 500, y: original.y }));
    test.edit(graph => moveNode(graph, "甲", { x: 500, y: 600 }));
    test.edit(graph => updateNode(graph, "乙", { description: "独立文本" }));
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().positions["甲"]).toEqual({ x: original.x, y: 600 });
    expect(test.current().nodes[1]?.description).toBe("独立文本");
    expect(test.undo(1)).toEqual({ ok: true });
    expect(test.current().positions["甲"]).toEqual(original);
  });

  it("撤销删节点恢复其资源、边与位置，后续其他节点修改继续保留", () => {
    const graph = addEdge(addResource(baseGraph(), "甲", "https://restore.example.com/", "资源"), "甲", "乙", "related_to", "关系");
    const test = setup(graph);
    test.edit(current => deleteNode(current, "甲"));
    test.edit(current => updateNode(current, "乙", { title: "独立新名称" }));
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().nodes.find(node => node.id === "甲")).toEqual(graph.nodes[0]);
    expect(test.current().positions["甲"]).toEqual(graph.positions["甲"]);
    expect(test.current().edges).toEqual(graph.edges);
    expect(test.current().nodes.find(node => node.id === "乙")?.title).toBe("独立新名称");
  });

  it("全图重搜应用可撤销为旧完整图，保留应用后的独立记录改名", () => {
    const graph = addResource(baseGraph(), "甲", "https://manual.example.com/", "人工资源");
    const test = setup(graph);
    test.edit(current => applyGraphSearchResult(current, pythonResultGraphFixture), { kind: "graph.search", subject: graph.title, scope: { type: "graph.replace" } });
    expect(test.events()[0]?.kind).toBe("graph.search");
    test.store.getState().renameGraph("图", "应用后的记录名");
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().nodes).toEqual(graph.nodes);
    expect(test.current().edges).toEqual(graph.edges);
    expect(test.current().positions).toEqual(graph.positions);
    expect(test.current().title).toBe("应用后的记录名");
  });

  it("全图替换拥有同值节点标题与资源说明，撤先前编辑不能改写仍有效的替换结果", () => {
    const graph = fromResultGraph(pythonResultGraphFixture, "图");
    const nodeId = graph.nodes[0]?.id, resourceId = graph.nodes[0]?.resources[0]?.id;
    if (nodeId === undefined || resourceId === undefined) throw new Error("缺少固定资源");
    const test = setup(graph);
    test.edit(current => updateNode(current, nodeId, { title: "B" }));
    test.edit(current => updateResource(current, nodeId, resourceId, { summary: "说明B" }));
    const result = { ...pythonResultGraphFixture, runId: "完整替换运行", graph: { ...pythonResultGraphFixture.graph,
      nodes: pythonResultGraphFixture.graph.nodes.map(node => node.id === nodeId
        ? { ...node, title: "B", resources: node.resources.map(resource => resource.id === resourceId ? { ...resource, summary: "说明B" } : resource) } : node) } };
    test.edit(current => applyGraphSearchResult(current, result), { kind: "graph.search", subject: "完整替换", scope: { type: "graph.replace" } });
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.undo(1)).toEqual({ ok: true });
    expect(test.current().nodes[0]?.title).toBe("B");
    expect(test.current().nodes[0]?.resources[0]?.summary).toBe("说明B");
    expect(test.undo(2)).toEqual({ ok: true });
    expect(test.current().nodes[0]?.title).toBe(graph.nodes[0]?.title);
    expect(test.current().nodes[0]?.resources[0]?.summary).toBe(graph.nodes[0]?.resources[0]?.summary);
    test.store.getState().redo();
    expect(test.current().nodes[0]?.title).toBe("B");
  });

  it("单节点追加可撤销且保留原资源后来编辑，编辑新结果则形成真实依赖", () => {
    const nodeId = pythonResultGraphFixture.graph.nodes[0]?.id;
    if (nodeId === undefined) throw new Error("缺少固定结果节点");
    const graph = addResource(addNode(createEmptyGraph("图", "图", "zh-CN"), "目标", "", nodeId), nodeId, "https://old.example.com/", "旧资源");
    const test = setup(graph);
    test.edit(current => applyNodeSearchResult(current, nodeId, pythonResultGraphFixture, "append"), { kind: "node.search", subject: "目标", scope: { type: "node.append", nodeId } });
    expect(test.events()[0]?.kind).toBe("node.search");
    test.edit(current => updateResource(current, nodeId, "旧资源", { summary: "后来编辑" }));
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().nodes[0]?.resources).toHaveLength(1);
    expect(test.current().nodes[0]?.resources[0]?.summary).toBe("后来编辑");
    test.store.getState().redo();
    const added = test.current().nodes[0]?.resources.find(resource => resource.id !== "旧资源");
    if (added === undefined) throw new Error("缺少追加结果");
    test.edit(current => updateResource(current, nodeId, added.id, { summary: "新结果人工内容" }));
    expect(test.undo(0)).toEqual({ ok: false, reason: "dependency" });
  });

  it("单节点替换应用撤销恢复人工资源与顺序，后续其他节点编辑不回退", () => {
    const nodeId = pythonResultGraphFixture.graph.nodes[0]?.id;
    if (nodeId === undefined) throw new Error("缺少固定结果节点");
    let graph = addNode(createEmptyGraph("图", "图", "zh-CN"), "目标", "", nodeId);
    graph = addResource(addResource(graph, nodeId, "https://replace.example.com/one", "一"), nodeId, "https://replace.example.com/two", "二");
    graph = addNode(graph, "其他", "", "其他");
    const test = setup(graph);
    test.edit(current => applyNodeSearchResult(current, nodeId, pythonResultGraphFixture, "replace"), { kind: "node.search", subject: "目标", scope: { type: "node.replace", nodeId } });
    test.edit(current => updateNode(current, "其他", { description: "后续独立修改" }));
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().nodes[0]?.resources).toEqual(graph.nodes[0]?.resources);
    expect(test.current().nodes[1]?.description).toBe("后续独立修改");
  });

  it("节点替换完整拥有资源集合，不混入撤早先删除后恢复的旧资源", () => {
    const nodeId = pythonResultGraphFixture.graph.nodes[0]?.id;
    if (nodeId === undefined) throw new Error("缺少固定节点");
    const graph = addResource(addNode(createEmptyGraph("图", "图", "zh-CN"), "目标", "", nodeId), nodeId, "https://replaced-old.example.com/", "旧资源");
    const test = setup(graph);
    test.edit(current => deleteResource(current, nodeId, "旧资源"));
    test.edit(current => applyNodeSearchResult(current, nodeId, pythonResultGraphFixture, "replace"), { kind: "node.search", subject: "替换", scope: { type: "node.replace", nodeId } });
    const replacement = test.current().nodes[0]?.resources;
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().nodes[0]?.resources).toEqual(replacement);
    expect(test.undo(1)).toEqual({ ok: true });
    expect(test.current().nodes[0]?.resources).toEqual(graph.nodes[0]?.resources);
  });

  it("节点替换拥有同值资源的存在性，缺失父节点仍阻断直到资源确实删除", () => {
    const test = setup();
    test.edit(graph => addResource(addNode(graph, "新节点", "", "新"), "新", "https://owned.example.com/", "资源"));
    test.edit(graph => ({ ...graph, lastRunId: "明确替换", nodes: graph.nodes.map(node => node.id === "新" ? { ...node } : node) }),
      { kind: "node.search", subject: "新节点", scope: { type: "node.replace", nodeId: "新" } });
    expect(test.undo(0)).toEqual({ ok: false, reason: "dependency" });
    test.edit(graph => deleteResource(graph, "新", "资源"));
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().nodes.some(node => node.id === "新")).toBe(false);
  });

  it("节点追加只拥有新增资源，不把此前同值说明或顺序当作本次写入", () => {
    const nodeId = pythonResultGraphFixture.graph.nodes[0]?.id;
    if (nodeId === undefined) throw new Error("缺少固定节点");
    const graph = addResource(addNode(createEmptyGraph("图", "图", "zh-CN"), "目标", "", nodeId), nodeId, "https://append-old.example.com/", "旧资源");
    const test = setup(graph);
    test.edit(current => updateResource(current, nodeId, "旧资源", { summary: "B" }));
    test.edit(current => applyNodeSearchResult(current, nodeId, pythonResultGraphFixture, "append"), { kind: "node.search", subject: "追加", scope: { type: "node.append", nodeId } });
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().nodes[0]?.resources[0]).toMatchObject({ id: "旧资源", summary: "" });
    expect(test.current().nodes[0]?.resources.length).toBeGreaterThan(1);
  });

  it("可选引擎字段同样遵守后写覆盖，撤销不伪造旧资源来源", () => {
    const test = setup();
    test.edit(graph => ({ ...graph, engine: "baidu" }));
    test.edit(graph => ({ ...graph, engine: "google" }));
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().engine).toBe("google");
    expect(test.undo(1)).toEqual({ ok: true });
    expect(test.current()).not.toHaveProperty("engine");
  });

  it("新编辑清除选择性撤销后的重做分支，重复/非法事件执行保持原状态", () => {
    const test = setup();
    test.edit(graph => updateNode(graph, "甲", { title: "B" }));
    expect(test.undo(0)).toEqual({ ok: true });
    const before = test.store.getState();
    expect(test.undo(0)).toEqual({ ok: false, reason: "inactive" });
    expect(test.store.getState().undoEvent("不存在")).toEqual({ ok: false, reason: "missing" });
    expect(test.store.getState()).toBe(before);
    test.edit(graph => updateNode(graph, "乙", { title: "独立编辑" }));
    expect(test.store.getState().histories["图"]?.future).toHaveLength(0);
    test.store.getState().redo();
    expect(test.current().nodes[0]?.title).toBe("甲");
    expect(test.current().nodes[1]?.title).toBe("独立编辑");
  });

  it("事件按图隔离，删除恢复带回该图历史，刷新恢复全部清空", () => {
    const test = setup();
    test.store.getState().renameGraph("图", "第一图修改");
    const eventId = test.events()[0]?.id;
    if (eventId === undefined) throw new Error("缺少第一图事件");
    test.store.getState().addGraph(createEmptyGraph("第二图", "第二图", "en-US"));
    expect(test.store.getState().undoEvent(eventId)).toEqual({ ok: false, reason: "missing" });
    test.store.getState().deleteGraph("图");
    expect(test.store.getState().histories["图"]).toBeUndefined();
    test.store.getState().restoreDeletedGraph();
    expect(test.current().id).toBe("图");
    expect(test.events()[0]?.id).toBe(eventId);
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().title).toBe("原图");
    test.store.getState().restoreDocuments(test.store.getState().documents, "图");
    expect(test.events()).toEqual([]);
    expect(test.store.getState().deletedGraphs).toEqual([]);
    expect(test.store.getState().undoEvent(eventId)).toEqual({ ok: false, reason: "missing" });
  });

  it("最近100事件以有效基线截断，最早记录不可再执行但保留既有顺序撤销上限", () => {
    const test = setup();
    for (let index = 0; index < 105; index++) test.store.getState().renameGraph("图", `编辑${index}`);
    expect(test.events()).toHaveLength(100);
    expect(new Set(test.events().map(event => event.id)).size).toBe(100);
    expect(test.store.getState().undoEvent("事件1")).toEqual({ ok: false, reason: "missing" });
    expect(test.undo(0)).toEqual({ ok: true });
    expect(test.current().title).toBe("编辑104");
    for (let index = 0; index < 100; index++) test.store.getState().undo();
    expect(test.current().title).toBe("编辑4");
  });

  it("100步截断可折入已消解占位，不把旧临时依赖泄露到后续图或重做", () => {
    const test = setup();
    test.edit(graph => addResource(graph, "甲", "https://trimmed.example.com/", "资源"));
    test.edit(graph => updateResource(graph, "甲", "资源", { summary: "后来说明" }));
    test.edit(graph => deleteResource(graph, "甲", "资源"));
    expect(test.undo(0)).toEqual({ ok: true });
    for (let index = 0; index < 105; index++) test.store.getState().renameGraph("图", `截断${index}`);
    expect(test.events()).toHaveLength(100);
    for (let index = 0; index < 100; index++) test.store.getState().undo();
    expect(test.current().nodes[0]?.resources).toEqual([]);
    expect(test.current().title).toBe("截断4");
    test.store.getState().redo();
    expect(test.current().title).toBe("截断5");
  });

  it("无效、失败及仅更新时间的同值操作不新增事件，不改变有效重做", () => {
    const test = setup();
    test.store.getState().renameGraph("图", "新名");
    test.undo(0);
    const before = test.store.getState();
    test.edit(graph => ({ ...graph, updatedAt: "2026-12-01T00:00:00Z" }));
    expect(() => test.edit(graph => ({ ...graph, title: "" }))).toThrow();
    test.store.getState().renameGraph("不存在", "名称");
    expect(test.store.getState()).toBe(before);
    test.store.getState().redo();
    expect(test.current().title).toBe("新名");
    expect(test.events()).toHaveLength(1);
  });
});
