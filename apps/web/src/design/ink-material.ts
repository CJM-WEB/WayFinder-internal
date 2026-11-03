/**
 * 模块职责：只模拟颜料材料点的局部位移与凝聚，不改变真实图节点或 DOM 坐标。
 * 数值边界：使用 CSS 像素和秒，分步积分避免帧率/调度抖动造成负阻尼或发散。
 */
export type InkMaterialOffset = { x: number; y: number; vx: number; vy: number };

/** 两行蛇形点阵覆盖节点体积；同一批十四点随后可连续重排成首页的整条宽笔触。 */
export function inkMaterialHome(index: number): Readonly<{ x: number; y: number }> {
  const column = index<7 ? index : 13-index;
  return { x: (column-3)*0.24,y: index<7 ? -0.32 : 0.32 };
}

/** 宽度从静止面积和当前中心线长度估算；拉长分配整个体积，不能另保留一颗球头。 */
export function inkMaterialRadius(radiusX: number, radiusY: number, length: number): number {
  const area = 3.45*radiusX*radiusY;
  const weightedLength = Math.max(0,length)*0.77;
  return area/(Math.sqrt(weightedLength*weightedLength+Math.PI*area)+weightedLength);
}

/** 半隐式弹簧积分：释放后始终沿同一运动收拢，不切换到固定时长的位置插值。 */
export function stepInkMaterial(points: InkMaterialOffset[], delta: number): void {
  const dt = Math.max(0,Math.min(0.05,delta));
  const steps = Math.max(1,Math.ceil(dt/0.012));
  const step = dt/steps;
  for (let pass=0; pass<steps; pass++) for (const point of points) {
    point.vx += (-point.x*34-point.vx*8.8)*step;
    point.vy += (-point.y*34-point.vy*8.8)*step;
    point.x += point.vx*step;
    point.y += point.vy*step;
    if (Math.hypot(point.x,point.y)<0.02 && Math.hypot(point.vx,point.vy)<0.05) {
      point.x = 0; point.y = 0; point.vx = 0; point.vy = 0;
    }
  }
}

/** 指针只给局部材料点动量；限速保护数值，不限制整块颜料与指针之间的空间距离。 */
export function pushInkMaterial(point: InkMaterialOffset, x: number, y: number): void {
  point.vx += x; point.vy += y;
  const speed = Math.hypot(point.vx,point.vy);
  if (speed>1600) { point.vx *= 1600/speed; point.vy *= 1600/speed; }
}
