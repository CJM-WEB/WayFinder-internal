/** 确定性回归：材料覆盖、质量分配和局部拨散后的凝聚均不依赖真实搜索或 GPU。 */
import { expect, it } from "vitest";
import { inkMaterialHome, inkMaterialRadius, pushInkMaterial, stepInkMaterial } from "./ink-material.js";

it("十四个材料点覆盖两行体积，顺序相邻而不是全部挤在头部", () => {
  const points = Array.from({ length: 14 },(_,index) => inkMaterialHome(index));
  expect(new Set(points.map(point => `${point.x},${point.y}`)).size).toBe(14);
  expect(points.filter(point => point.y<0)).toHaveLength(7);
  expect(points.filter(point => point.y>0)).toHaveLength(7);
  expect(points.every((point,index) => index===0 || Math.hypot(point.x-(points[index-1]?.x ?? 0),point.y-(points[index-1]?.y ?? 0))<0.7)).toBe(true);
});

it("整条笔触变长时平滑分配宽度，面积仍符合原体积估算", () => {
  const radii = [0,50,150,500].map(length => inkMaterialRadius(130,73,length));
  expect(radii.every((radius,index) => Number.isFinite(radius) && radius>0 && (index===0 || radius<(radii[index-1] ?? 0)))).toBe(true);
  const radius = radii[2] ?? 0;
  expect(Math.PI*radius*radius+2*150*0.77*radius).toBeCloseTo(3.45*130*73,5);
});

it("只有受力材料散开，之后不切时钟自然凝聚，负时间不能发散", () => {
  const points = Array.from({ length: 14 },() => ({ x: 0,y: 0,vx: 0,vy: 0 }));
  const selected = points[5];
  if (selected===undefined) throw new Error("缺少受力材料");
  pushInkMaterial(selected,1100,-600);
  stepInkMaterial(points,-8);
  expect(selected.x).toBe(0);
  stepInkMaterial(points,0.05);
  expect(selected.x).toBeGreaterThan(20);
  expect(points.filter(point => point.x!==0 || point.y!==0)).toHaveLength(1);
  for (let frame=0; frame<600; frame++) stepInkMaterial(points,1/60);
  expect(points.every(point => point.x===0 && point.y===0 && point.vx===0 && point.vy===0)).toBe(true);
});
