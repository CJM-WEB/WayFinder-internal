/**
 * 静态回归：新皮肤共享旧预览模型和动作，只验证呈现、所有权与退场保护，不调用搜索或 GPU。
 * 动态退出由 presence 提供；此处注入保留快照，证明临时 store 清空后完整内容仍可被呈现。
 */
import type { ResearchPreview } from "../api/research.js";
import type { GraphViewProps } from "../components/Graph/GraphView.js";
import type { ResearchPreviewViewProps } from "../components/Workspace/WorkspaceResearchPreview.js";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  view: undefined as ResearchPreviewViewProps | undefined,
  graph: undefined as GraphViewProps | undefined,
  retained: undefined as { preview: ResearchPreview; selectedNodeId: string | null } | undefined,
  open: false,
}));
vi.mock("zustand", () => ({
  useStore: <State, Selected>(store: { getState: () => State }, selector: (state: State) => Selected): Selected => selector(store.getState()),
}));
vi.mock("../components/Graph/GraphView.js", () => ({
  GraphView: (props: GraphViewProps) => { captured.graph = props; return <div data-preview-flow={props.flowId} />; },
}));
vi.mock("../components/Workspace/WorkspaceResearchPreview.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../components/Workspace/WorkspaceResearchPreview.js")>();
  return { ...actual,ResearchPreviewView: (props: ResearchPreviewViewProps) => { captured.view = props; return <actual.ResearchPreviewView {...props} />; } };
});
vi.mock("./ink-presence.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./ink-presence.js")>();
  return { useInkPresence: <T,>(value: T | null, duration?: number) => {
    const live = actual.useInkPresence(value,duration);
    // 只控制预览的 420ms 快照，InkNotice 的独立退场逻辑保持真实入口。
    return duration===420 && captured.retained!==undefined ? { value: captured.retained as T,open: captured.open && value!==null } : live;
  } };
});

import { researchStore } from "../api/research.js";
import { pythonResultGraphFixture } from "../fixtures/python-result-graph.js";
import { getMessages } from "../i18n/messages.js";
import { fromResultGraph, workspaceStore } from "../stores/workspace-store.js";
import { ResearchPreviewView, WorkspaceResearchPreview } from "../components/Workspace/WorkspaceResearchPreview.js";
import InkResearchPreview, { clearRetiredResearchInput } from "./ink-research-preview.js";

const originalActions = { cancel: researchStore.getState().cancel,dismiss: researchStore.getState().dismiss,apply: researchStore.getState().apply };
const selectTemporaryNode = researchStore.getState().runStore.getState().selectNode;
const firstNodeId = pythonResultGraphFixture.graph.nodes[0]?.id;
if (firstNodeId===undefined) throw new Error("预览 Fixture 缺少首节点");
const preview = (patch: Partial<ResearchPreview> = {}): ResearchPreview => ({
  graphId: "ink-preview-graph",nodeId: firstNodeId,runId: pythonResultGraphFixture.runId,query: "保留原始查询",
  language: "zh-CN",engine: "baidu",status: "ready",result: pythonResultGraphFixture,...patch,
});
const prepare = (value: ResearchPreview): void => {
  workspaceStore.getState().restoreDocuments([fromResultGraph(pythonResultGraphFixture,value.graphId)],value.graphId);
  researchStore.setState({ preview: value,inputError: null });
};
const pure = (value: ResearchPreview, extra: Partial<ResearchPreviewViewProps> = {}) => renderToStaticMarkup(<ResearchPreviewView
  language="en-US" preview={value} selectedNodeId={value.nodeId} onSelectNode={() => undefined}
  onCancel={() => undefined} onDismiss={() => undefined} onApply={() => undefined} {...extra} />);

afterEach(() => {
  captured.view = undefined; captured.graph = undefined; captured.retained = undefined; captured.open = false;
  researchStore.setState({ preview: null,inputError: null,...originalActions });
  researchStore.getState().runStore.getState().reset();
  researchStore.getState().runStore.setState({ selectNode: selectTemporaryNode });
  workspaceStore.getState().restoreDocuments([],null);
});

describe("共享重搜纯视图", () => {
  it("单节点保留追加/替换，English UI 不翻译已有查询、标题和资源内容", () => {
    const value = preview(), html = pure(value);
    const first = pythonResultGraphFixture.graph.nodes[0];
    expect(html).toContain("Append to this node");
    expect(html).toContain("Apply replacement");
    expect(html).toContain(value.query);
    expect(html).toContain(first?.title);
    if (first?.status!=="ready" || first.resources[0]===undefined) throw new Error("缺少资源原文样例");
    expect(html).toContain(first.resources[0].summary);
    expect(html).toContain(first.resources[0].whySelected);
    expect(html).not.toContain(getMessages("zh-CN").research.append);
  });

  it("全图只给整体替换；Graph 与资源选择使用同一个临时 node ID，预览不可编辑工作图", () => {
    const selected = pythonResultGraphFixture.graph.nodes[1]?.id;
    if (selected===undefined) throw new Error("缺少第二个节点");
    const html = pure(preview({ nodeId: null }),{ selectedNodeId: selected,idPrefix: "isolated-" });
    expect(html).not.toContain("Append to this node");
    expect(html).toContain("Apply replacement");
    expect(html).toContain(pythonResultGraphFixture.graph.nodes[1]?.title);
    expect(captured.graph?.selectedNodeId).toBe(selected);
    expect(captured.graph?.flowId).toBe(`isolated-preview-${pythonResultGraphFixture.runId}`);
    expect(captured.graph?.editableGraphId).toBeUndefined();
  });

  it("全图选择沿用调用方稳定回调，禁用画布的旧选择事件不能回写", () => {
    const select = vi.fn(), value = preview({ nodeId: null });
    pure(value,{ onSelectNode: select });
    expect(captured.graph?.onSelectNode).toBe(select);
    pure(value,{ onSelectNode: select,selectedNodeId: firstNodeId });
    expect(captured.graph?.onSelectNode).toBe(select);
    pure(value,{ onSelectNode: select,disabled: true });
    const disabledSelection = captured.graph?.onSelectNode;
    disabledSelection?.(firstNodeId);
    pure(value,{ onSelectNode: select,disabled: true });
    expect(captured.graph?.onSelectNode).toBe(disabledSelection);
    expect(select).not.toHaveBeenCalled();
  });

  it.each(["searching","failed"] as const)("%s 保留原状态提示与正确取消/弃用动作，不出现应用按钮", status => {
    const html = pure(preview({ status,result: null }));
    expect(html).toContain(status==="searching" ? 'role="status"' : 'role="alert"');
    expect(html).toContain(status==="searching" ? "Cancel search" : "Discard new results");
    expect(html).not.toContain("Apply replacement");
    expect(html).not.toContain("Append to this node");
  });

  it("原 Workspace 容器仍使用原 section 与同一动作文案", () => {
    prepare(preview());
    const html = renderToStaticMarkup(<WorkspaceResearchPreview language="en-US" />);
    expect(html).toContain('class="workspace-research-preview"');
    expect(html).toContain("Append to this node");
    expect(html).not.toContain('role="dialog"');
  });
});

describe("墨迹页重搜预览外观与所有权", () => {
  it("初次内容完整存在但不可操作，非模态不锁住全局键盘导航", () => {
    prepare(preview());
    const html = renderToStaticMarkup(<InkResearchPreview language="en-US" />);
    expect(html).toContain('role="dialog"');
    expect(html).not.toContain("aria-modal");
    expect(html).toContain('data-ink-overlay="true"');
    expect(html).toContain('data-open="false"');
    expect(html).toContain('inert=""');
    expect(html).toContain("保留原始查询");
    expect(captured.view?.disabled).toBe(true);
  });

  it.each([{ active: false },{ suspended: true }])("不可见输入 %j 不挂预览交互层或同步改写临时结果", extra => {
    const value = preview(); prepare(value);
    expect(renderToStaticMarkup(<InkResearchPreview language="en-US" {...extra} />)).toBe("");
    expect(researchStore.getState().preview).toBe(value);
  });

  it("原目标已删除或已切另一图时，effects 执行前也不展示错误目标", () => {
    prepare(preview({ nodeId: "deleted-node" }));
    expect(renderToStaticMarkup(<InkResearchPreview language="en-US" />)).toBe("");
    prepare(preview());
    workspaceStore.getState().selectGraph(null);
    expect(renderToStaticMarkup(<InkResearchPreview language="en-US" />)).toBe("");
  });

  it("退出保留完整结果和旧选择，即使临时 preview 与 selection 已清空也不退成空面板", () => {
    const selected = pythonResultGraphFixture.graph.nodes[1]?.id;
    if (selected===undefined) throw new Error("缺少第二个节点");
    const value = preview({ nodeId: null }); prepare(value);
    captured.retained = { preview: value,selectedNodeId: selected };
    researchStore.setState({ preview: null });
    const html = renderToStaticMarkup(<InkResearchPreview language="en-US" />);
    expect(html).toContain(value.query);
    expect(html).toContain(pythonResultGraphFixture.graph.nodes[1]?.title);
    expect(captured.graph?.selectedNodeId).toBe(selected);
    expect(captured.view?.disabled).toBe(true);
  });

  it("只有当前可操作快照才能调用原 apply；旧退场按钮不能应用后来建立的预览", () => {
    const value = preview(), apply = vi.fn(); prepare(value);
    captured.retained = { preview: value,selectedNodeId: value.nodeId }; captured.open = true;
    researchStore.setState({ apply });
    renderToStaticMarkup(<InkResearchPreview language="en-US" />);
    captured.view?.onApply("append");
    expect(apply).toHaveBeenCalledExactlyOnceWith("append");
    researchStore.setState({ preview: preview({ runId: "newer-run" }) });
    renderToStaticMarkup(<InkResearchPreview language="en-US" />);
    captured.view?.onApply("replace");
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it.each(["query","target"] as const)("没有preview的%s验证失败也有现成的本地化InkNotice", error => {
    researchStore.setState({ preview: null,inputError: error });
    const html = renderToStaticMarkup(<InkResearchPreview language="en-US" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(error==="target" ? getMessages("en-US").research.missingTarget : getMessages("en-US").research.invalidInput);
    expect(html).not.toContain('role="dialog"');
  });

  it("真正换图清理没有preview的旧输入提示，同图验证失败不会自动消失", () => {
    const cancel = vi.fn();
    researchStore.setState({ preview: null,inputError: "query",cancel });
    const snapshot = researchStore.getState();
    clearRetiredResearchInput("graph-a","graph-a",snapshot);
    expect(cancel).not.toHaveBeenCalled();
    clearRetiredResearchInput("graph-a","graph-b",snapshot);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("旧导航快照不能取消后来建立的有效preview，也不能清除同错误码的新输入失败", () => {
    const cancel = vi.fn();
    researchStore.setState({ preview: null,inputError: "query",cancel });
    const oldSnapshot = researchStore.getState();
    const newer = preview({ graphId: "graph-b",runId: "newer" });
    researchStore.setState({ preview: newer,inputError: null });
    clearRetiredResearchInput("graph-a","graph-b",oldSnapshot);
    expect(cancel).not.toHaveBeenCalled();
    expect(researchStore.getState().preview).toBe(newer);
    researchStore.setState({ preview: null,inputError: "query" });
    clearRetiredResearchInput("graph-a","graph-b",oldSnapshot);
    expect(cancel).not.toHaveBeenCalled();
    expect(researchStore.getState().inputError).toBe("query");
  });

  it("存在有效preview时，输入提示导航清理本身不负责丢弃结果", () => {
    const cancel = vi.fn(), value = preview();
    researchStore.setState({ preview: value,inputError: "target",cancel });
    clearRetiredResearchInput("graph-a","graph-b",researchStore.getState());
    expect(cancel).not.toHaveBeenCalled();
    expect(researchStore.getState().preview).toBe(value);
  });
});
