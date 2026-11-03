/** 确定性回归：同一个墨团只能搬动一次，跟随链保持连续且最终回到真实坐标。 */
import { describe, expect, it } from "vitest";
import { followInkTrail, pairInkNodes } from "./ink-transfer.js";

describe("墨团搬动配对", () => {
  it("共享 ID 优先于更近的其他节点", () => {
    expect(pairInkNodes([{ id: "same",x: 0,y: 0 },{ id: "old",x: 100,y: 0 }],
      [{ id: "same",x: 100,y: 0 },{ id: "new",x: 0,y: 0 }])).toEqual([
      { sourceId: "same",targetId: "same" },{ sourceId: "old",targetId: "new" },
    ]);
  });
  it("不同 ID 按邻近关系一对一搬动，不把一个源重复分给多个目标", () => {
    const pairs = pairInkNodes([{ id: "a",x: 0,y: 0 },{ id: "b",x: 100,y: 0 }],
      [{ id: "x",x: 3,y: 0 },{ id: "y",x: 5,y: 0 }]);
    expect(pairs).toEqual([{ sourceId: "a",targetId: "x" },{ sourceId: "b",targetId: "y" }]);
    expect(new Set(pairs.map(pair => pair.sourceId)).size).toBe(pairs.length);
  });
  it("数量差只留下差额，九节点以上不截断，输入不变且并列距离稳定", () => {
    const sources = Array.from({ length: 12 },(_,index) => ({ id: `old-${index}`,x: index*50,y: 0 }));
    const targets = Array.from({ length: 9 },(_,index) => ({ id: `new-${index}`,x: index*50+1,y: 0 }));
    const before = JSON.stringify({ sources,targets });
    const pairs = pairInkNodes(sources,targets);
    expect(pairs).toHaveLength(9);
    expect(new Set(pairs.map(pair => pair.sourceId)).size).toBe(9);
    expect(JSON.stringify({ sources,targets })).toBe(before);
    expect(pairInkNodes([],targets)).toEqual([]);
    expect(pairInkNodes([...sources].reverse(),targets)).toEqual(pairs);
  });
});

it("十四点尾迹连续追随，松手后自然收敛；负时间不发散", () => {
  const points = Array.from({ length: 14 },() => ({ x: 0,y: 0 }));
  followInkTrail(points,{ x: 1,y: 1 },-5);
  expect(points.every(point => point.x===0 && point.y===0)).toBe(true);
  followInkTrail(points,{ x: 1,y: 1 },1/60);
  expect(points[0]?.x).toBeGreaterThan(points[1]?.x ?? 1);
  expect(points[0]?.x).toBeLessThan(1);
  for (let frame=0; frame<600; frame++) followInkTrail(points,{ x: 1,y: 1 },1/60);
  expect(points.every(point => Math.abs(point.x-1)<0.00001 && Math.abs(point.y-1)<0.00001)).toBe(true);
});
