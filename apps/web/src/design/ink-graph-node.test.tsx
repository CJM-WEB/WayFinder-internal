/** 静态回归：四个真实锚点复用原语义与可连接门禁，不改变 article 的测量结构。 */
import { renderToStaticMarkup } from "react-dom/server";
import type { NodeProps } from "@xyflow/react";
import { expect, it, vi } from "vitest";
import type { GraphFlowNode } from "../components/Graph/graph-layout.js";

vi.mock("@xyflow/react", async importOriginal => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return { ...actual,Handle: ({ id,isConnectable }: { id: string; isConnectable: boolean }) =>
    <span data-handle-id={id} data-connectable={isConnectable} /> };
});
import { InkGraphNode } from "./ink-graph-node.js";

const props = (isConnectable: boolean): NodeProps<GraphFlowNode> => ({
  id: "ink-node",type: "wayfinder",data: { title: "现有节点",nodeType: "primary",status: "empty",resourceCount: 0,language: "zh-CN" },
  dragging: false,zIndex: 0,selectable: true,deletable: false,selected: false,draggable: true,isConnectable,
  positionAbsoluteX: 0,positionAbsoluteY: 0,
});

it.each([false,true])("四锚点统一遵从 NodeProps.isConnectable=%s", connectable => {
  const markup = renderToStaticMarkup(<InkGraphNode {...props(connectable)} />);
  expect(markup).toContain('data-ink-node="ink-node"');
  expect(markup).toContain(`data-ink-connectable="${connectable}"`);
  for (const id of ["main-target","related-target","related-source","main-source"]) expect(markup).toContain(`data-handle-id="${id}"`);
  expect(markup.match(new RegExp(`data-connectable="${connectable}"`,"g"))).toHaveLength(4);
});
