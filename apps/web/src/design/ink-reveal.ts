/**
 * 模块职责：用浏览器原生 WebGL2（图形接口）绘制可交互的体积墨迹与局部揭字。
 *
 * 设计边界：所有颜色、笔触、液滴和文字遮罩均在本地生成，不加载录屏、图片或网络素材。
 * 生命周期：暂停时停止逐帧绘制；卸载时释放对象而不主动丢失上下文，兼容 React StrictMode。
 */
import { INK_NODE_FORM, INK_SCENE_TRANSITION, inkEase, inkSceneKey, type InkScene } from "./ink-graph-motion.js";
import { followInkTrail, pairInkNodes, type InkNodeTransferPair } from "./ink-transfer.js";
import { inkMaterialHome, inkMaterialRadius, pushInkMaterial, stepInkMaterial, type InkMaterialOffset } from "./ink-material.js";

export type InkTransferEvent = Readonly<{
  kind: "start" | "complete"; graphId?: string; generation: number; startedAt: number; duration: number;
  pairs: readonly InkNodeTransferPair[];
}>;

export type InkRevealController = Readonly<{
  refreshTextPosition: () => void;
  setScene: (scene: InkScene) => void;
  destroy: () => void;
}>;

const POINT_COUNT = 14;
const MAX_PIXELS = 1_000_000;
const NODE_BATCH = 8;
const BRANCH_BATCH = 12;
const MATERIAL_BATCH = 2;
const SCENE_MORPH = INK_SCENE_TRANSITION;

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform vec2 uResolution;
uniform float uTime;
uniform vec4 uPoints[14];
uniform sampler2D uLetters;
uniform vec4 uTextPointer;
uniform float uHeadingShift;
uniform int uScene;
uniform float uTrailAmount;
uniform int uNodeCount;
uniform vec4 uNodes[8];
uniform vec4 uNodeStyles[8];
uniform int uMaterialCount;
uniform vec4 uMaterialPoints[28];
uniform vec4 uMaterialBounds[2];
uniform vec4 uMaterialNodes[2];
uniform vec4 uMaterialStyles[2];
uniform vec4 uMaterialMotion[2];
uniform int uBranchCount;
uniform vec4 uBranchA[12];
uniform vec4 uBranchB[12];
uniform vec4 uBranchStyles[12];
uniform bool uOverlay;

// 三维连续噪声用于颜料内部的凹凸与色层，不把外轮廓简化成规则椭圆。
float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.13, 0.71, 0.37));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i), hash(i+vec3(1,0,0)), f.x),
                 mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x),
                 mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float n = 0.0, a = 0.53;
  for (int i=0; i<4; i++) {
    n += a*noise3(p);
    p = p*2.07 + vec3(4.7, 1.3, 6.1);
    a *= 0.48;
  }
  return n;
}
float smoothMin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5*(b-a)/k, 0.0, 1.0);
  return mix(b,a,h) - k*h*(1.0-h);
}

// 首页与拖拽尾迹共用逐段宽度/颜色插值，十四点链不会退化成几段等粗管道。
vec2 stroke(vec2 p, vec4 a, vec4 b) {
  vec2 delta = b.xy-a.xy;
  float h = clamp(dot(p-a.xy,delta)/max(dot(delta,delta),0.000001),0.0,1.0);
  return vec2(length(p-a.xy-delta*h)-mix(a.z,b.z,h),mix(a.w,b.w,h));
}

// 静止节点与材料形态共用这一个基准距离场；活动节点不会再额外绘制固定大头。
vec2 restNode(vec2 p, vec4 node, vec4 style) {
  float growth = style.x, phase = style.z;
  vec2 center = node.xy + vec2(sin(uTime*0.73+phase),cos(uTime*0.61+phase))*0.0028*growth;
  vec2 radius = max(node.zw*growth,vec2(0.0001));
  vec2 q = (p-center)/radius;
  float angle = atan(q.y,q.x);
  float fingers = pow(0.5+0.5*sin(angle*6.0-uTime*0.68+phase),3.0);
  float ripple = sin(angle*3.0+uTime*0.71+phase)*0.050 + sin(angle*5.0-uTime*0.39+phase)*0.025 - fingers*0.105;
  float shape = pow(pow(abs(q.x),2.65)+pow(abs(q.y),2.65),1.0/2.65);
  float distance = (shape-1.0+ripple)*min(radius.x,radius.y);
  float along = 1.0-style.y;
  for (int drop=0; drop<2; drop++) {
    float fd = float(drop);
    float orbit = phase+fd*3.47+uTime*(0.09+fd*0.025);
    vec2 dropCenter = center+vec2(cos(orbit)*1.37,sin(orbit)*1.40)*radius;
    float dropRadius = min(radius.x,radius.y)*(0.052+fd*0.013);
    vec2 delta = p-dropCenter;
    float dropAngle = atan(delta.y,delta.x);
    float d = length(delta)-dropRadius*(1.0+0.16*sin(dropAngle*3.0+phase));
    if (d<distance) { distance = d; along = 1.0-fract(style.y+0.29+fd*0.27); }
  }
  return vec2(distance,along);
}

// 同一节点只提交一次：静止体积连续变成整批材料，拨散时允许液颈真正断开再凝聚。
vec3 body(vec2 p) {
  float distance = 10.0, along = 0.0, fluid = 0.0;
  if (uTrailAmount>0.001 && !uOverlay) for (int i=0; i<13; i++) {
    vec2 segment = stroke(p,uPoints[i],uPoints[i+1]);
    if (segment.x<distance) { along = segment.y; fluid = 1.0; }
    distance = smoothMin(distance,segment.x,uScene==0 ? 0.035 : 0.010*uTrailAmount);
  }
  for (int i=0; i<8; i++) {
    if (i>=uNodeCount) break;
    if (uNodeStyles[i].x<0.001) continue;
    vec2 radius = max(uNodes[i].zw*uNodeStyles[i].x,vec2(0.0001));
    vec2 q = (p-uNodes[i].xy)/radius;
    float cutoff = 1.65+0.10/min(radius.x,radius.y);
    if (any(greaterThan(abs(q),vec2(cutoff)))) continue;
    vec2 node = restNode(p,uNodes[i],uNodeStyles[i]);
    if (node.x<distance) { along = node.y; fluid = 0.0; }
    distance = smoothMin(distance,node.x,0.009*uNodeStyles[i].x);
  }
  for (int material=0; material<2; material++) {
    if (material>=uMaterialCount) break;
    vec4 bounds = uMaterialBounds[material];
    if (any(lessThan(p,bounds.xy)) || any(greaterThan(p,bounds.zw))) continue;
    float materialDistance = 10.0, materialAlong = 0.0, colorMass = 0.0, totalMass = 0.0;
    float drag = uMaterialMotion[material].x;
    for (int i=0; i<14; i++) {
      int index = material*14+i;
      vec4 point = uMaterialPoints[index];
      vec2 delta = p-point.xy;
      float radius2 = point.z*point.z;
      float mass = radius2/max(dot(delta,delta)+radius2*0.6,0.0000001);
      mass *= mass;
      colorMass += point.w*mass;
      totalMass += mass;
      float polar = atan(delta.y,delta.x);
      float lobe = 1.0+0.055*sin(polar*3.0+uTime*0.6+float(i));
      float d = length(delta)-point.z*lobe;
      if (d<materialDistance) materialAlong = point.w;
      materialDistance = smoothMin(materialDistance,d,0.012);
      if (i<13) {
        vec4 next = uMaterialPoints[index+1];
        float separation = length(point.xy-next.xy)/max(point.z+next.z,0.0001);
        float neck = mix(1.0-smoothstep(0.85,1.36,separation),1.0,drag);
        if (neck>0.001) {
          vec2 segment = stroke(p,vec4(point.xy,point.z*neck,point.w),vec4(next.xy,next.z*neck,next.w));
          if (segment.x<materialDistance) materialAlong = segment.y;
          materialDistance = smoothMin(materialDistance,segment.x,0.020*neck);
        }
      }
    }
    materialAlong = colorMass/max(totalMass,0.000001);
    vec2 rest = restNode(p,uMaterialNodes[material],uMaterialStyles[material]);
    float factor = uMaterialStyles[material].w;
    float d = mix(rest.x,materialDistance,factor);
    float color = mix(rest.y,materialAlong,factor);
    if (d<distance) { along = color; fluid = factor; }
    distance = smoothMin(distance,d,0.012);
  }
  // 分支只在它的飞行/液颈断开窗口存在；最终连接完全由正式 React Flow 边承接。
  for (int i=0; i<12; i++) {
    if (i>=uBranchCount) break;
    vec2 a = uBranchA[i].xy, b = uBranchA[i].zw;
    vec2 c = uBranchB[i].xy, d = uBranchB[i].zw;
    float radius = uBranchStyles[i].x;
    // 飞行墨头比液颈更粗；边界还需覆盖头部/管径与投影余量，高缩放时也不能裁掉实体。
    float padding = max(radius,uBranchStyles[i].w)+0.10;
    vec2 lower = min(min(a,b),min(c,d))-vec2(padding);
    vec2 upper = max(max(a,b),max(c,d))+vec2(padding);
    if (any(lessThan(p,lower)) || any(greaterThan(p,upper))) continue;
    float branchDistance = 10.0;
    for (int part=0; part<3; part++) {
      vec2 from = part==0 ? a : part==1 ? b : c;
      vec2 to = part==0 ? b : part==1 ? c : d;
      vec2 delta = to-from;
      float h = clamp(dot(p-from,delta)/max(dot(delta,delta),0.000001),0.0,1.0);
      float route = (float(part)+h)/3.0;
      float neckWave = sin(route*3.14159265);
      float neck = mix(1.0,uBranchStyles[i].y,neckWave*neckWave);
      float sampleDistance = length(p-from-delta*h)-radius*neck;
      branchDistance = min(branchDistance,sampleDistance);
    }
    branchDistance = min(branchDistance,length(p-d)-uBranchStyles[i].w);
    if (branchDistance<distance) { along = 1.0-uBranchStyles[i].z; fluid = 0.0; }
    distance = smoothMin(distance,branchDistance,0.006);
  }
  return vec3(distance,along,fluid);
}
vec3 pigment(float t) {
  vec3 blue = vec3(0.025,0.025,0.68);
  vec3 magenta = vec3(0.97,0.005,0.46);
  vec3 orange = vec3(1.0,0.30,0.008);
  return mix(mix(blue,magenta,smoothstep(0.08,0.60,t)),orange,smoothstep(0.61,0.98,t));
}
void main() {
  vec2 p = vec2(gl_FragCoord.x,uResolution.y-gl_FragCoord.y)/uResolution.y;
  vec3 background = vec3(0.953,0.953,0.945);
  // 只扰动文字遮罩，位移封顶为少量 CSS 像素；黑字与反相白字共用同一采样。
  vec2 textDelta = p-uTextPointer.xy;
  float textRadius = 0.19*min(uResolution.x/uResolution.y,1.0);
  float textFalloff = exp(-dot(textDelta,textDelta)/(textRadius*textRadius));
  vec2 textWave = vec2(sin(textDelta.y*30.0+uTime*5.2)*0.45,
                       sin(textDelta.x*36.0-uTime*6.0));
  vec2 textOffset = textWave*textFalloff*uTextPointer.z*uTextPointer.w;
  vec2 textUv = vec2(vUv.x,1.0-vUv.y-uHeadingShift) + textOffset*vec2(uResolution.y/uResolution.x,1.0);
  float letters = uScene==2 ? 0.0 : texture(uLetters,textUv).a;
  vec3 base = mix(background,vec3(0.018),letters);
  vec3 roughField = body(p);
  vec2 warp = vec2(0.0);
  if (roughField.x<0.065) warp = vec2(noise3(vec3(p*6.0,uTime*0.14)),noise3(vec3(p*6.0+17.0,uTime*0.12)))-0.5;
  float distortion = mix(uScene==0 ? 0.039 : uScene==1 ? 0.010 : 0.013,0.039,roughField.z);
  vec3 field = roughField.x<0.065 ? body(p+warp*distortion) : roughField;
  float wrinkle = field.x<0.045 ? fbm(vec3(p*37.0,uTime*0.28)) : 0.49;
  float edge = field.x + (wrinkle-0.49)*mix(uScene==0 ? 0.022 : 0.007,0.022,field.z);
  float aa = 1.5/uResolution.y;
  float cover = 1.0-smoothstep(-aa,aa,edge);

  // 底部柔影先绘制，近处投影再叠加；墨迹本体随后覆盖，保留轻盈的悬浮感。
  float groundDistance = body(p-vec2(0.006,0.034)).x;
  float groundShadow = (1.0-smoothstep(-0.012,0.062,groundDistance))*0.34;
  base = mix(base,vec3(0.62,0.62,0.65),groundShadow);

  // 投影与实体分开计算，文字在灰色投影下保留其原始层级。
  float sd = body(p-vec2(0.014,0.023)).x;
  float shadow = (1.0-smoothstep(-0.003,0.030,sd))*0.105;
  base = mix(base,vec3(0.69,0.69,0.72),shadow);

  if (cover>0.001) {
    float core = clamp(-edge/0.092,0.0,1.0);
    float folds = fbm(vec3(p*24.0 + warp*3.0,uTime*0.26));
    float fine = noise3(vec3(p*106.0,uTime*0.38));
    float relief = core*0.74 + folds*0.28 + fine*0.014;
    vec2 grad = vec2(dFdx(relief),dFdy(relief))*uResolution.y*0.115;
    vec3 normal = normalize(vec3(-grad.x,grad.y,1.0));
    vec3 light = normalize(vec3(-0.6,-0.7,1.2));
    float diffuse = max(dot(normal,light),0.0);
    float specular = pow(max(dot(reflect(-light,normal),vec3(0,0,1)),0.0),22.0);
    float colorPosition = clamp(1.0-field.y + 0.11*sin(p.x*5.0+uTime*0.16),0.0,1.0);
    vec3 color = pigment(colorPosition);
    color *= 0.48 + diffuse*0.76;
    color *= 0.78 + folds*0.48;
    color += vec3(0.55,0.56,0.66)*specular*0.35;
    color += vec3(0.08,0.06,0.10)*pow(1.0-core,6.0);
    // 白色反相文字严格受实体遮罩约束，不受投影或游离粒子误触发。
    color = mix(color,vec3(0.995),letters);
    base = mix(base,color,cover);
  }

  // 游离液滴跟随实际笔触强度收拢，切入图场景也不突然消失；不按场景枚举开关实体。
  if (uTrailAmount>0.001 && !uOverlay) for (int i=0; i<8; i++) {
    float fi = float(i);
    int index = 2 + i;
    vec2 center = uPoints[index].xy + vec2(sin(fi*2.39+uTime*0.47),cos(fi*3.41+uTime*0.39))*vec2(0.14,0.19)*uTrailAmount;
    float radius = (0.006 + 0.007*(0.5+0.5*sin(fi*5.7)))*uTrailAmount;
    // 实体最大半径为1.275r/0.54，投影最远r+0.017；保留逆缩放后的AA，纸面无需再算极角/高次幂。
    float support = radius*2.5+max(0.020,2.0*aa);
    if (any(greaterThan(abs(p-center),vec2(support)))) continue;
    vec2 q = p-center;
    float angle = fi*2.17 + 0.21*sin(uTime*0.19+fi);
    q = mat2(cos(angle),-sin(angle),sin(angle),cos(angle))*q;
    q.x *= 0.73+0.19*sin(fi+uTime*0.5);
    q.y *= 1.09+0.26*cos(fi*1.3+uTime*0.4);
    float polar = atan(q.y,q.x);
    float lobes = 1.0 + 0.11*sin(polar*3.0+fi) + 0.065*sin(polar*5.0-fi*0.7);
    lobes += 0.10*clamp(q.y/radius,-1.0,1.0);
    float d = length(q)-radius*lobes;
    float sh = (1.0-smoothstep(radius,radius+0.009,length(p-center-vec2(0.006,0.008))))*0.12*uTrailAmount;
    base = mix(base,vec3(0.67),sh);
    float alpha = 1.0-smoothstep(-aa,aa,d);
    float dome = sqrt(max(0.0,1.0-dot(q,q)/(radius*radius)));
    vec3 drop = pigment(fi/7.0)*(0.48+dome*0.55);
    drop += vec3(0.32)*pow(max(dome-0.1-q.x/radius*0.3,0.0),10.0)*0.28;
    base = mix(base,drop,alpha);
  }
  // 后续批次只提交本批节点/分支及其柔影；从背景混合中还原透明颜色，避免批次间浅影变淡。
  float layerAlpha = 1.0-(1.0-cover)*(1.0-groundShadow)*(1.0-shadow);
  vec3 layerColor = layerAlpha>0.00001 ? (base-background*(1.0-layerAlpha))/layerAlpha : vec3(0.0);
  fragColor = uOverlay ? vec4(layerColor,layerAlpha) : vec4(base,1.0);
}`;

type TrailPoint = { x: number; y: number };
type NodePosition = TrailPoint & { radiusX: number; radiusY: number; color: number };
type MaterialPoint = TrailPoint & Readonly<{ radius: number; color: number }>;
type MaterialDrawing = Readonly<{ points: readonly MaterialPoint[]; amount: number; drag: number }>;
type NodeDrawing = Readonly<{ id: string; point: NodePosition; labelPoint: TrailPoint; growth: number; phase: number; brush?: MaterialDrawing }>;
type BranchDrawing = Readonly<{ a: TrailPoint; b: TrailPoint; c: TrailPoint; d: TrailPoint; radius: number; neck: number; color: number; head: number }>;
type SceneMorph = {
  startedAt: number | null; nodes: readonly NodeDrawing[]; branches: readonly BranchDrawing[];
  reform: boolean; pairs: readonly InkNodeTransferPair[] | null;
  announced: boolean; generation: number; duration: number; graphId?: string;
};
type DragPosition = { point: NodePosition; tail: TrailPoint[]; offsets: InkMaterialOffset[];
  points: readonly MaterialPoint[]; lastTarget: TrailPoint; drag: number; amount: number };

function mixPoint(from: TrailPoint, to: TrailPoint, amount: number): TrailPoint {
  return { x: from.x+(to.x-from.x)*amount,y: from.y+(to.y-from.y)*amount };
}

/** 控制点沿屏幕的垂直方向弯曲，主墨与分支共用同一条连续 S 形轨迹。 */
function flightPoint(from: TrailPoint, to: TrailPoint, progress: number, width: number, height: number): TrailPoint {
  const dx = (to.x-from.x)*width, dy = (to.y-from.y)*height;
  const length = Math.max(1,Math.hypot(dx,dy));
  const bend = Math.min(length*0.29,Math.min(width,height)*0.16);
  const nx = -dy/length*bend, ny = dx/length*bend;
  const first = { x: from.x+dx*0.29/width+nx/width, y: from.y+dy*0.29/height+ny/height };
  const second = { x: from.x+dx*0.74/width-nx*0.70/width, y: from.y+dy*0.74/height-ny*0.70/height };
  const t = Math.max(0,Math.min(1,progress)), rest = 1-t;
  return {
    x: rest**3*from.x+3*rest**2*t*first.x+3*rest*t*t*second.x+t**3*to.x,
    y: rest**3*from.y+3*rest**2*t*first.y+3*rest*t*t*second.y+t**3*to.y,
  };
}

/** 材料点与所属节点一起迁移；中途换图不能先恢复块头，也不能把独立尾迹吸向别处。 */
function moveInkMaterial(brush: MaterialDrawing, to: TrailPoint, progress: number, width: number, height: number, settle: boolean): MaterialDrawing {
  return { points: brush.points.map(point => ({ ...point,...flightPoint(point,to,progress,width,height) })),
    amount: brush.amount*(settle ? 1-progress : 1),drag: brush.drag*(settle ? 1-progress : 1) };
}

/** 初始化失败关闭到静态标题；成功时返回只操作呈现层的轻量控制器。 */
export function createInkReveal(
  canvas: HTMLCanvasElement,
  host: HTMLElement,
  heading: HTMLElement,
  onTransfer?: (event: InkTransferEvent) => void,
): InkRevealController | null {
  // 首帧成功前让 DOM 标题保持可见；编译失败时不能留下默认黑色画布遮住后备内容。
  canvas.style.visibility = "hidden";
  host.dataset.inkRenderer = "fallback";
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",
  });
  if (gl === null) return null;

  const resources: { shaders: WebGLShader[]; program: WebGLProgram | null; buffer: WebGLBuffer | null; texture: WebGLTexture | null } = {
    shaders: [], program: null, buffer: null, texture: null,
  };
  const release = (): void => {
    if (resources.texture !== null) gl.deleteTexture(resources.texture);
    if (resources.buffer !== null) gl.deleteBuffer(resources.buffer);
    if (resources.program !== null) gl.deleteProgram(resources.program);
    resources.shaders.forEach(shader => gl.deleteShader(shader));
  };
  const compile = (kind: number, source: string): WebGLShader => {
    const shader = gl.createShader(kind);
    if (shader === null) throw new Error("无法创建墨迹着色器");
    resources.shaders.push(shader);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("墨迹着色器编译失败");
    return shader;
  };

  try {
    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    resources.program = gl.createProgram();
    if (resources.program === null) throw new Error("无法创建墨迹程序");
    gl.attachShader(resources.program, vertex);
    gl.attachShader(resources.program, fragment);
    gl.linkProgram(resources.program);
    if (!gl.getProgramParameter(resources.program, gl.LINK_STATUS)) throw new Error("墨迹程序连接失败");
    gl.useProgram(resources.program);
    resources.buffer = gl.createBuffer();
    resources.texture = gl.createTexture();
    if (resources.buffer === null || resources.texture === null) throw new Error("无法创建墨迹绘图资源");
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(resources.program, "aPosition");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D,resources.texture);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(resources.program,"uLetters"),0);
  } catch {
    release();
    return null;
  }

  const resolution = gl.getUniformLocation(resources.program,"uResolution");
  const timeUniform = gl.getUniformLocation(resources.program,"uTime");
  const pointsUniform = gl.getUniformLocation(resources.program,"uPoints[0]");
  const textPointerUniform = gl.getUniformLocation(resources.program,"uTextPointer");
  const headingShiftUniform = gl.getUniformLocation(resources.program,"uHeadingShift");
  const sceneUniform = gl.getUniformLocation(resources.program,"uScene");
  const trailAmountUniform = gl.getUniformLocation(resources.program,"uTrailAmount");
  const nodeCountUniform = gl.getUniformLocation(resources.program,"uNodeCount");
  const nodesUniform = gl.getUniformLocation(resources.program,"uNodes[0]");
  const nodeStylesUniform = gl.getUniformLocation(resources.program,"uNodeStyles[0]");
  const materialCountUniform = gl.getUniformLocation(resources.program,"uMaterialCount");
  const materialPointsUniform = gl.getUniformLocation(resources.program,"uMaterialPoints[0]");
  const materialBoundsUniform = gl.getUniformLocation(resources.program,"uMaterialBounds[0]");
  const materialNodesUniform = gl.getUniformLocation(resources.program,"uMaterialNodes[0]");
  const materialStylesUniform = gl.getUniformLocation(resources.program,"uMaterialStyles[0]");
  const materialMotionUniform = gl.getUniformLocation(resources.program,"uMaterialMotion[0]");
  const branchCountUniform = gl.getUniformLocation(resources.program,"uBranchCount");
  const branchAUniform = gl.getUniformLocation(resources.program,"uBranchA[0]");
  const branchBUniform = gl.getUniformLocation(resources.program,"uBranchB[0]");
  const branchStylesUniform = gl.getUniformLocation(resources.program,"uBranchStyles[0]");
  const overlayUniform = gl.getUniformLocation(resources.program,"uOverlay");
  const mask = document.createElement("canvas");
  const maskContext = mask.getContext("2d");
  if (maskContext === null) { release(); return null; }

  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let paused = motion.matches;
  let disposed = false;
  let lost = false;
  let frame = 0;
  let previousTime = performance.now();
  let elapsed = 0;
  let lastPointer = -10;
  let width = 1;
  let height = 1;
  let maskHeadingTop = 0;
  let activePointer: TrailPoint | null = null;
  let textStrength = 0;
  let scene: InkScene = { kind: "pointer" };
  let currentSceneKey = inkSceneKey(scene);
  let sceneEnteredAt = performance.now();
  let sceneGeneration = 0;
  let graphSettled = false;
  let sceneTrail: readonly TrailPoint[] = [];
  let sceneRadii: readonly number[] = [];
  let sceneMorph: SceneMorph | null = null;
  let lastBranches: readonly BranchDrawing[] = [];
  let positionTime = performance.now();
  let viewportKey = "";
  const dragPositions = new Map<string,DragPosition>();
  let graphPointer: TrailPoint | null = null;
  let currentNodeElements = new Map<string,HTMLElement>();
  const transferElements = new Set<HTMLElement>();
  const heldTransferElements = new Map<HTMLElement,{ at: number; frame: number }>();
  let drawFrame = 0;
  let sceneHeld = false;
  let maskKey = "";
  let trailAmount = 1;
  let nodeDrawings: readonly NodeDrawing[] = [];
  const textPointer: TrailPoint = { x: 0.5, y: 0.5 };
  const values = new Float32Array(POINT_COUNT*4);
  const nodeValues = new Float32Array(NODE_BATCH*4);
  const nodeStyles = new Float32Array(NODE_BATCH*4);
  const materialValues = new Float32Array(MATERIAL_BATCH*POINT_COUNT*4);
  const materialBounds = new Float32Array(MATERIAL_BATCH*4);
  const materialNodes = new Float32Array(MATERIAL_BATCH*4);
  const materialStyles = new Float32Array(MATERIAL_BATCH*4);
  const materialMotion = new Float32Array(MATERIAL_BATCH*4);
  const branchA = new Float32Array(BRANCH_BATCH*4);
  const branchB = new Float32Array(BRANCH_BATCH*4);
  const branchStyles = new Float32Array(BRANCH_BATCH*4);
  const autoPosition = (t: number): TrailPoint => ({
    x: 0.5 + 0.39*Math.sin(t*0.91+0.28),
    y: 0.5 + 0.26*Math.sin(t*1.29+0.1)*Math.cos(t*0.38),
  });
  const trail: TrailPoint[] = Array.from({ length: POINT_COUNT }, (_, index) => autoPosition(1.5-index*0.052));

  const clearTransferElement = (element: HTMLElement): void => {
    for (const property of ["--ink-transfer-x","--ink-transfer-y","--ink-transfer-scale","--ink-transfer-opacity"]) {
      if (element.style.getPropertyValue(property)!=="") element.style.removeProperty(property);
    }
  };
  const holdTransferOffsets = (now: number, delay: number): void => {
    for (const element of transferElements) heldTransferElements.set(element,{ at: now+delay,frame: drawFrame });
    transferElements.clear();
  };
  const transferOffset = (element: HTMLElement, from: TrailPoint, to: TrailPoint, opacity: number, scale: number): void => {
    heldTransferElements.delete(element);
    transferElements.add(element);
    const zoom = element.getBoundingClientRect().width/Math.max(1,element.offsetWidth);
    const properties = { "--ink-transfer-x": `${(from.x-to.x)*width/Math.max(0.001,zoom)}px`,
      "--ink-transfer-y": `${(from.y-to.y)*height/Math.max(0.001,zoom)}px`,"--ink-transfer-opacity": `${opacity}`,
      "--ink-transfer-scale": `${scale}` };
    for (const [property,value] of Object.entries(properties)) {
      if (element.style.getPropertyValue(property)!==value) element.style.setProperty(property,value);
    }
  };
  const notifyTransfer = (kind: InkTransferEvent["kind"], morph: SceneMorph): void => {
    if (morph.startedAt===null) return;
    if (kind==="complete" && (morph.generation!==sceneGeneration || scene.kind!=="graph")) return;
    onTransfer?.({ kind,generation: morph.generation,startedAt: morph.startedAt,duration: morph.duration,
      pairs: morph.pairs ?? [],...(morph.graphId===undefined ? {} : { graphId: morph.graphId }) });
  };

  /**
   * 真实节点/连线仍由 React Flow 跟手；这里只迟滞颜料坐标，不回写 DOM 或持久化数据。
   * 仅 dragging 类触发迟滞；视口矩阵、容器尺寸/位置变化立即对齐，避免把平移缩放误认成拖动。
   */
  const scenePositions = (now: number): {
    positions: Map<string,NodePosition>; paint: Map<string,NodePosition>; shapes: Map<string,MaterialDrawing>; elements: Map<string,HTMLElement>;
  } => {
    const positions = new Map<string,NodePosition>(), paint = new Map<string,NodePosition>();
    const shapes = new Map<string,MaterialDrawing>(), elements = new Map<string,HTMLElement>();
    if (scene.kind!=="graph") return { positions,paint,shapes,elements };
    const bounds = host.getBoundingClientRect();
    for (const element of host.querySelectorAll<HTMLElement>("[data-ink-node]")) {
      if (element.dataset.inkNode!==undefined) elements.set(element.dataset.inkNode,element);
    }
    const viewport = host.querySelector<HTMLElement>(".react-flow__viewport");
    const nextViewport = [bounds.left,bounds.top,width,height,viewport?.style.transform ?? ""].join(":");
    const viewChanged = nextViewport!==viewportKey;
    viewportKey = nextViewport;
    if (viewChanged || motion.matches) { dragPositions.clear(); graphPointer = null; }
    const dt = Math.min(0.05,Math.max(0,(now-positionTime)/1000));
    positionTime = now;
    scene.nodes.forEach((birth,index) => {
      const element = elements.get(birth.id);
      if (element===undefined) return;
      const rect = element.getBoundingClientRect();
      if (rect.width<=0 || rect.height<=0) return;
      const target: NodePosition = {
        x: (rect.left-bounds.left+rect.width/2)/width,y: (rect.top-bounds.top+rect.height/2)/height,
        radiusX: rect.width*0.54/height,radiusY: rect.height*0.65/height,
        color: 0.08+0.84*index/Math.max(1,scene.kind==="graph" ? scene.nodes.length-1 : 1),
      };
      positions.set(birth.id,target);
      const dragging = element.closest(".react-flow__node")?.classList.contains("dragging")===true;
      let state = dragPositions.get(birth.id);
      if (state===undefined) {
        state = { point: target,tail: Array.from({ length: POINT_COUNT },() => ({ x: target.x,y: target.y })),
          offsets: Array.from({ length: POINT_COUNT },() => ({ x: 0,y: 0,vx: 0,vy: 0 })),points: [],lastTarget: target,drag: 0,amount: 0 };
        dragPositions.set(birth.id,state);
      }
      const speed = dragging && dt>0 ? Math.hypot((target.x-state.lastTarget.x)*width,(target.y-state.lastTarget.y)*height)/dt : 0;
      state.lastTarget = { x: target.x,y: target.y };
      followInkTrail(state.tail,target,dt);
      stepInkMaterial(state.offsets,dt);
      const residual = Math.max(...state.tail.map(point => Math.hypot((point.x-target.x)*width,(point.y-target.y)*height)));
      const dragTarget = motion.matches || viewChanged ? 0 : inkEase(Math.max(speed/480,residual/Math.max(1,target.radiusY*height*1.65)));
      state.drag += (dragTarget-state.drag)*(1-Math.exp(-dt*11));
      const displaced = Math.max(...state.offsets.map(point => Math.hypot(point.x,point.y)));
      // 材料偏移已超过采样间距的一部分时，基准团块必须交出几何，不能继续替真实间隙补洞。
      const materialTarget = Math.max(state.drag,inkEase(displaced/Math.min(16,target.radiusY*height*0.18)));
      state.amount += (materialTarget-state.amount)*(1-Math.exp(-dt*(materialTarget>state.amount ? 17 : 7)));
      if (state.amount<0.001 && residual<0.35 && displaced<0.02) { state.amount = 0; state.drag = 0; }
      const head = state.tail[0] ?? target;
      state.point = { ...target,...mixPoint(target,head,state.drag) };
      let length = 0;
      state.tail.forEach((point,part) => {
        const previous = state?.tail[part-1];
        if (previous!==undefined) length += Math.hypot((point.x-previous.x)*width,(point.y-previous.y)*height)/height;
      });
      const brushRadius = inkMaterialRadius(target.radiusX,target.radiusY,length);
      state.points = state.tail.map((point,part): MaterialPoint => {
        const home = inkMaterialHome(part), offset = state?.offsets[part] ?? { x: 0,y: 0 };
        const rest = { x: target.x+home.x*target.radiusX*height/width,y: target.y+home.y*target.radiusY };
        const location = mixPoint(rest,point,state?.drag ?? 0);
        const taper = 0.37+0.63*Math.sin(part/(POINT_COUNT-1)*Math.PI);
        return { x: location.x+offset.x/width,y: location.y+offset.y/height,
          radius: target.radiusY*0.64+(brushRadius*taper-target.radiusY*0.64)*(state?.drag ?? 0),
          color: target.color+(part/(POINT_COUNT-1)-target.color)*(state?.amount ?? 0) };
      });
      paint.set(birth.id,state.point);
      if (state.amount>0.001) shapes.set(birth.id,{ points: state.points,amount: state.amount,drag: state.drag });
    });
    for (const id of dragPositions.keys()) if (!positions.has(id)) dragPositions.delete(id);
    currentNodeElements = elements;
    return { positions,paint,shapes,elements };
  };

  /**
   * 视觉快照独立于旧图 DOM：卸载、取消和快速反向切换都从上次真正绘出的实体继续。
   * 新搜索保留传播时间表；恢复/同图结构变化只做分裂，不重播已经发生的节点与边。
   */
  const updateScene = (now: number): readonly BranchDrawing[] => {
    const previousNodes = nodeDrawings;
    sceneHeld = false;
    const hold = (): readonly BranchDrawing[] => {
      sceneHeld = true;
      nodeDrawings = previousNodes;
      return lastBranches;
    };
    // 新图布局尚未交接时旧 scene 仍有效；不能读到 B 的同 ID 矩形后把 A 瞬移过去。
    if (scene.kind==="graph" && scene.graphId!==undefined &&
      host.querySelector<HTMLElement>("[data-ink-graph-id]")?.dataset.inkGraphId!==scene.graphId) return hold();
    nodeDrawings = [];
    const branches: BranchDrawing[] = [];
    const morph = sceneMorph;
    let raw = morph===null || motion.matches ? 1 : morph.startedAt===null ? 0 : Math.min(1,Math.max(0,(now-morph.startedAt)/SCENE_MORPH));
    let progress = inkEase(raw);
    const matched = new Set<number>();
    let mergeTargets: readonly NodePosition[] = [];
    if (motion.matches && scene.kind==="graph") graphSettled = true;
    const age = scene.kind==="pointer" ? 0 : Math.max(0,now-scene.startedAt);
    if (scene.kind==="pointer") trailAmount = 1;
    else if (scene.kind==="loading") {
      const minimum = Math.min(width,height);
      const radius = Math.max(76,Math.min(160,minimum*0.23));
      const entry = motion.matches ? 1 : inkEase((now-sceneEnteredAt)/420);
      trail.forEach((point,index) => {
        const phase = (Math.max(0,age-index*29)%2200)/2200;
        const angle = inkEase(phase)*Math.PI*2-0.72;
        const orbit = { x: 0.5+Math.cos(angle)*radius/width,y: 0.5+Math.sin(angle)*radius*0.86/height };
        const origin = sceneTrail[index] ?? orbit;
        Object.assign(point,mixPoint(origin,orbit,entry));
      });
      trailAmount = 1;
    } else {
      const { positions,paint,shapes,elements } = scenePositions(now);
      if (positions.size<scene.nodes.length) return hold();
      mergeTargets = [...positions.values()];
      if (morph?.reform===true && !morph.announced) {
        // 布局未稳定前保留旧帧；配对时钟与文字层一起从真实目标可测时开始。
        morph.pairs = pairInkNodes(morph.nodes.map(node => ({ id: node.id,x: node.point.x*width,y: node.point.y*height })),
          scene.nodes.flatMap(node => { const point = positions.get(node.id); return point===undefined ? [] : [{ id: node.id,x: point.x*width,y: point.y*height }]; }));
        morph.startedAt = now;
        morph.duration = motion.matches ? 0 : SCENE_MORPH;
        morph.announced = true;
        sceneEnteredAt = now;
        raw = motion.matches ? 1 : 0;
        progress = raw;
        notifyTransfer("start",morph);
      }
      const entrance = graphSettled ? 1 : inkEase((now-sceneEnteredAt)/INK_NODE_FORM);
      const reform = morph?.reform===true;
      nodeDrawings = scene.nodes.flatMap((birth,index): readonly NodeDrawing[] => {
        const target = paint.get(birth.id);
        if (target===undefined) return [];
        let point = target;
        let labelPoint: TrailPoint = target;
        let phase = index*2.17;
        let brush = shapes.get(birth.id);
        let growth = (graphSettled ? 1 : inkEase((age-birth.bornAt)/INK_NODE_FORM))*entrance;
        if (reform && morph!==null) {
          const pair = morph.pairs?.find(pair => pair.targetId===birth.id);
          const sourceIndex = pair===undefined ? -1 : morph.nodes.findIndex((source,sourceIndex) => source.id===pair.sourceId && !matched.has(sourceIndex));
          const source = sourceIndex<0 ? undefined : morph.nodes[sourceIndex];
          if (source!==undefined) matched.add(sourceIndex);
          // 一对一配对的旧墨团完整搬动；只有目标数量更多时，差额才从最近颜料分裂。
          const nearest = source ?? morph.nodes.reduce<NodeDrawing | undefined>((best,node) => {
            const distance = (node.point.x-target.x)**2+(node.point.y-target.y)**2;
            return best===undefined || distance<(best.point.x-target.x)**2+(best.point.y-target.y)**2 ? node : best;
          },undefined);
          const origin = source?.point ?? nearest?.point ?? sceneTrail[0] ?? trail[0] ?? target;
          const location = flightPoint(origin,target,progress,width,height);
          labelPoint = flightPoint(source?.labelPoint ?? origin,target,progress,width,height);
          const initialX = source?.point.radiusX ?? target.radiusX*0.18;
          const initialY = source?.point.radiusY ?? target.radiusY*0.18;
          point = { ...target,...location,radiusX: initialX+(target.radiusX-initialX)*progress,
            radiusY: initialY+(target.radiusY-initialY)*progress,
            color: source===undefined ? target.color : source.point.color+(target.color-source.point.color)*progress };
          if (source!==undefined) {
            phase = source.phase+(phase-source.phase)*progress;
            if (source.brush!==undefined) brush = moveInkMaterial(source.brush,target,progress,width,height,true);
          }
          growth = source===undefined ? progress : source.growth+(1-source.growth)*progress;
          const element = elements.get(birth.id);
          if (element!==undefined && !motion.matches) transferOffset(element,labelPoint,target,
            1-inkEase((raw-(1-150/SCENE_MORPH))/(150/SCENE_MORPH)),point.radiusX*growth/Math.max(0.0001,target.radiusX));
          if (raw>0 && raw<1) {
            const tail = flightPoint(origin,target,inkEase(Math.max(0,(raw-0.24)/0.76)),width,height);
            branches.push({ a: tail,b: flightPoint(tail,point,1/3,width,height),c: flightPoint(tail,point,2/3,width,height),d: point,
              radius: Math.min(target.radiusX,target.radiusY)*0.14*Math.sin(raw*Math.PI),
              neck: 1-inkEase((raw-0.65)/0.35),color: target.color,head: 0 });
          }
        }
        return growth<0.001 ? [] : [{ id: birth.id,point,labelPoint,growth,phase,...(brush===undefined || brush.amount<0.001 ? {} : { brush }) }];
      });
      const first = scene.nodes.filter(birth => birth.seed).reduce<(typeof scene.nodes)[number] | undefined>((earliest,birth) => earliest===undefined || birth.bornAt<earliest.bornAt ? birth : earliest,undefined);
      const target = first===undefined ? undefined : positions.get(first.id);
      trailAmount = graphSettled || first===undefined || target===undefined ? 0 : 1-inkEase((age-first.bornAt-120)/420);
      if (!graphSettled && first!==undefined && target!==undefined && trailAmount>0) {
        trail.forEach((point,index) => {
          // 每个采样点保留自己的旧位置，加载轨迹不会在第一帧挤成一个点。
          const origin = sceneTrail[index] ?? sceneTrail[0] ?? { x: 0.5,y: 0.5 };
          Object.assign(point,flightPoint(origin,target,inkEase((age-index*21)/Math.max(1,first.bornAt)),width,height));
        });
      }
      if (!graphSettled) for (const branch of scene.branches) {
        if (age<branch.startAt || age>=branch.detachAt) continue;
        const from = positions.get(branch.source), to = positions.get(branch.target);
        if (from===undefined || to===undefined) continue;
        const flight = inkEase((age-branch.startAt)/Math.max(1,branch.arriveAt-branch.startAt));
        const detach = inkEase((age-branch.arriveAt)/Math.max(1,branch.detachAt-branch.arriveAt));
        const zoom = from.radiusX*height/(240*0.54);
        branches.push({ a: from,b: flightPoint(from,to,flight/3,width,height),c: flightPoint(from,to,flight*2/3,width,height),
          d: flightPoint(from,to,flight,width,height),radius: 7.5*zoom/height*Math.pow(1-detach,0.55),neck: 1-detach,
          color: from.color+(to.color-from.color)*flight*0.5,head: (12+7*Math.sin(flight*Math.PI))*zoom/height*(1-detach) });
      }
    }
    if (morph!==null && !motion.matches && raw<1) {
      const hub = trail[0] ?? { x: 0.5,y: 0.5 };
      const remaining = 1-inkEase((raw-0.32)/0.68);
      const outgoing = morph.nodes.flatMap((source,index): readonly NodeDrawing[] => {
        if (matched.has(index)) return [];
        // 目标数量更少时，差额融合到实际目标；不把所有剩余墨团吸向无关的首页笔头。
        const destination = mergeTargets.reduce<NodePosition | undefined>((nearest,target) =>
          nearest===undefined || Math.hypot((target.x-source.point.x)*width,(target.y-source.point.y)*height)<
            Math.hypot((nearest.x-source.point.x)*width,(nearest.y-source.point.y)*height) ? target : nearest,undefined) ?? hub;
        const location = flightPoint(source.point,destination,progress,width,height);
        const point = { ...source.point,...location,
          radiusX: source.point.radiusX+(0.045-source.point.radiusX)*progress,
          radiusY: source.point.radiusY+(0.045-source.point.radiusY)*progress };
        const tail = flightPoint(source.point,destination,inkEase(Math.max(0,(raw-0.23)/0.77)),width,height);
        branches.push({ a: tail,b: flightPoint(tail,point,1/3,width,height),c: flightPoint(tail,point,2/3,width,height),d: point,
          radius: Math.min(source.point.radiusX,source.point.radiusY)*0.17*Math.sin(raw*Math.PI)*source.growth,
          neck: remaining,color: source.point.color,head: 0 });
        return [{ ...source,point,growth: source.growth*remaining,
          ...(source.brush===undefined ? {} : { brush: moveInkMaterial(source.brush,destination,progress,width,height,false) }) }];
      });
      nodeDrawings = [...outgoing,...nodeDrawings];
      for (const branch of morph.branches) branches.push({ ...branch,
        a: mixPoint(branch.a,hub,progress),b: mixPoint(branch.b,hub,progress),
        c: mixPoint(branch.c,hub,progress),d: mixPoint(branch.d,hub,progress),
        radius: branch.radius*(1-progress),head: branch.head*(1-progress) });

    }
    if (raw===1) {
      if (morph?.announced===true) notifyTransfer("complete",morph);
      if (motion.matches) {
        for (const element of transferElements) clearTransferElement(element);
        transferElements.clear();
      } else holdTransferOffsets(now,0);
      sceneMorph = null;
    }
    return branches;
  };

  const draw = (): void => {
    if (disposed || lost) return;
    const aspect = width/height;
    const now = performance.now();
    drawFrame++;
    for (const [element,held] of heldTransferElements) {
      if (!element.isConnected || (now>=held.at && drawFrame>held.frame)) {
        clearTransferElement(element);
        heldTransferElements.delete(element);
      }
    }
    const branches = updateScene(now);
    lastBranches = branches;
    const radiusEntry = motion.matches ? 1 : sceneMorph?.startedAt===null ? 0 : inkEase((now-sceneEnteredAt)/(scene.kind==="graph" && graphSettled ? SCENE_MORPH : 420));
    let actualTrail = 0;
    if (!sceneHeld) trail.forEach((point,index) => {
      const offset = index*4;
      const taper = 0.37+0.63*Math.sin((index/(POINT_COUNT-1))*Math.PI);
      values[offset] = point.x*aspect;
      values[offset+1] = point.y;
      const radius = scene.kind==="pointer" ? 0.059+0.021*Math.sin(index*0.73+elapsed*1.7) : scene.kind==="loading" ? 0.023*Math.min(width,height)/height : 0.050*Math.min(width,height)/height;
      const desiredRadius = radius*taper*trailAmount;
      const previousRadius = sceneRadii[index] ?? desiredRadius;
      values[offset+2] = previousRadius+(desiredRadius-previousRadius)*radiusEntry;
      actualTrail = Math.max(actualTrail,values[offset+2] ?? 0);
      values[offset+3] = index/(POINT_COUNT-1);
    });
    if (sceneHeld) for (let index=0; index<POINT_COUNT; index++) actualTrail = Math.max(actualTrail,values[index*4+2] ?? 0);
    // 归位后丢弃旧场景半径；减弱动态或时钟重新锚定不能让已消退的自由墨头复活。
    if (radiusEntry===1) sceneRadii = [];
    gl.useProgram(resources.program);
    gl.uniform2f(resolution,canvas.width,canvas.height);
    gl.uniform1f(timeUniform,elapsed);
    gl.uniform4fv(pointsUniform,values);
    gl.uniform4f(textPointerUniform,textPointer.x*aspect,textPointer.y,textStrength,3.2/height);
    gl.uniform1i(sceneUniform,scene.kind==="pointer" ? 0 : scene.kind==="loading" ? 1 : 2);
    gl.uniform1f(trailAmountUniform,Math.min(1,actualTrail*24));
    // 只平移文字采样，不移动或重建墨迹画布；CSS 位移时也保持黑字与反相白字同步。
    const headingTop = heading.getBoundingClientRect().top-host.getBoundingClientRect().top;
    gl.uniform1f(headingShiftUniform,(headingTop-maskHeadingTop)/height);
    // uniform 数组仅限定每批容量。人工历史图可以超过八节点，所有可见节点与活动分支都分批提交。
    // 快照保存所有实体；仅提交时按同一 SDF 安全边界剔除屏外内容，平移回屏幕即可再次绘出。
    const visibleNodes = nodeDrawings.filter(({ point,growth,brush }) => {
      if (brush!==undefined && brush.amount>0.001) return false;
      const rx = Math.max(0.0001,point.radiusX*growth), ry = Math.max(0.0001,point.radiusY*growth);
      const cutoff = 1.65+0.10/Math.min(rx,ry);
      const ex = rx*cutoff+0.04, ey = ry*cutoff+0.04;
      const x = point.x*aspect;
      return x+ex>=0 && x-ex<=aspect && point.y+ey>=0 && point.y-ey<=1;
    });
    // CPU/GPU 共用真实材料包围盒；拨散到静止框外的液滴也必须保留完整实体和柔影。
    const materials = nodeDrawings.flatMap(node => {
      const { point,growth,brush } = node;
      if (brush===undefined || brush.amount<=0.001 || growth<0.001) return [];
      const rx = Math.max(0.0001,point.radiusX*growth), ry = Math.max(0.0001,point.radiusY*growth);
      const cutoff = 1.65+0.10/Math.min(rx,ry);
      let x0 = point.x*aspect-rx*cutoff-0.04, x1 = point.x*aspect+rx*cutoff+0.04;
      let y0 = point.y-ry*cutoff-0.04, y1 = point.y+ry*cutoff+0.04;
      brush.points.forEach(sample => {
        const location = mixPoint(point,sample,growth);
        const margin = sample.radius*growth*1.06+0.14;
        x0 = Math.min(x0,location.x*aspect-margin); x1 = Math.max(x1,location.x*aspect+margin);
        y0 = Math.min(y0,location.y-margin); y1 = Math.max(y1,location.y+margin);
      });
      return x1<0 || x0>aspect || y1<0 || y0>1 ? [] : [{ node,brush,bounds: [x0,y0,x1,y1] }];
    });
    const batches = Math.max(1,Math.ceil(visibleNodes.length/NODE_BATCH),Math.ceil(branches.length/BRANCH_BATCH),Math.ceil(materials.length/MATERIAL_BATCH));
    for (let batch=0; batch<batches; batch++) {
      const nodes = visibleNodes.slice(batch*NODE_BATCH,(batch+1)*NODE_BATCH);
      const slice = branches.slice(batch*BRANCH_BATCH,(batch+1)*BRANCH_BATCH);
      const materialSlice = materials.slice(batch*MATERIAL_BATCH,(batch+1)*MATERIAL_BATCH);
      nodeValues.fill(0); nodeStyles.fill(0);
      nodes.forEach((node,index) => {
        const { point,growth,phase } = node;
        nodeValues.set([point.x*aspect,point.y,point.radiusX,point.radiusY],index*4);
        nodeStyles.set([growth,point.color,phase,0],index*4);
      });
      materialValues.fill(0); materialBounds.fill(0); materialNodes.fill(0); materialStyles.fill(0); materialMotion.fill(0);
      materialSlice.forEach(({ node,brush,bounds },index) => {
        brush.points.forEach((sample,part) => {
          const location = mixPoint(node.point,sample,node.growth);
          materialValues.set([location.x*aspect,location.y,sample.radius*node.growth,1-sample.color],(index*POINT_COUNT+part)*4);
        });
        materialBounds.set(bounds,index*4);
        materialNodes.set([node.point.x*aspect,node.point.y,node.point.radiusX,node.point.radiusY],index*4);
        materialStyles.set([node.growth,node.point.color,node.phase,brush.amount],index*4);
        materialMotion.set([brush.drag,0,0,0],index*4);
      });
      branchA.fill(0); branchB.fill(0); branchStyles.fill(0);
      slice.forEach((branch,index) => {
        branchA.set([branch.a.x*aspect,branch.a.y,branch.b.x*aspect,branch.b.y],index*4);
        branchB.set([branch.c.x*aspect,branch.c.y,branch.d.x*aspect,branch.d.y],index*4);
        branchStyles.set([branch.radius,branch.neck,branch.color,branch.head],index*4);
      });
      gl.uniform1i(branchCountUniform,slice.length);
      gl.uniform1i(nodeCountUniform,nodes.length);
      gl.uniform4fv(nodesUniform,nodeValues);
      gl.uniform4fv(nodeStylesUniform,nodeStyles);
      gl.uniform1i(materialCountUniform,materialSlice.length);
      gl.uniform4fv(materialPointsUniform,materialValues);
      gl.uniform4fv(materialBoundsUniform,materialBounds);
      gl.uniform4fv(materialNodesUniform,materialNodes);
      gl.uniform4fv(materialStylesUniform,materialStyles);
      gl.uniform4fv(materialMotionUniform,materialMotion);
      gl.uniform4fv(branchAUniform,branchA);
      gl.uniform4fv(branchBUniform,branchB);
      gl.uniform4fv(branchStylesUniform,branchStyles);
      gl.uniform1i(overlayUniform,batch===0 ? 0 : 1);
      if (batch===0) gl.disable(gl.BLEND);
      else { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA); }
      gl.drawArrays(gl.TRIANGLES,0,6);
    }
    gl.disable(gl.BLEND);
  };

  /** DOM 字形与 GPU 遮罩共用样式；逐字绘制保留负字距，不依赖新增字体或图片。 */
  const resize = (): void => {
    if (disposed || lost) return;
    const bounds = host.getBoundingClientRect();
    const textBounds = heading.getBoundingClientRect();
    width = Math.max(1,bounds.width);
    height = Math.max(1,bounds.height);
    // 遮罩固定画在未平移的首页基线；搜索层离屏时 resize 也不能把字形画出纹理之外。
    maskHeadingTop = heading.offsetTop-textBounds.height/2;
    // 全场景固定预算；只有真实像素尺寸变化才重分配，切图不能清掉正在呈现的 drawing buffer。
    const density = Math.min(window.devicePixelRatio || 1,1.75,Math.sqrt(MAX_PIXELS/(width*height)));
    const nextWidth = Math.max(1,Math.round(width*density)), nextHeight = Math.max(1,Math.round(height*density));
    if (canvas.width!==nextWidth || canvas.height!==nextHeight) {
      canvas.width = nextWidth;
      canvas.height = nextHeight;
      gl.viewport(0,0,canvas.width,canvas.height);
      gl.clearColor(0.953,0.953,0.945,1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    const style = getComputedStyle(heading);
    const nextMaskKey = [canvas.width,canvas.height,width,height,maskHeadingTop,textBounds.left-bounds.left,textBounds.width,
      textBounds.height,style.font,style.fontFamily,style.fontWeight,style.fontSize,style.letterSpacing,heading.textContent].join("|");
    if (maskKey===nextMaskKey) { draw(); return; }
    maskKey = nextMaskKey;
    if (mask.width!==canvas.width || mask.height!==canvas.height) { mask.width = canvas.width; mask.height = canvas.height; }
    maskContext.setTransform(density,0,0,density,0,0);
    maskContext.clearRect(0,0,width,height);
    const fontSize = Number.parseFloat(style.fontSize);
    const spacing = Number.parseFloat(style.letterSpacing) || 0;
    maskContext.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    maskContext.textAlign = "left";
    maskContext.textBaseline = "alphabetic";
    maskContext.fillStyle = "white";
    const letters = Array.from(heading.textContent ?? "WAYFINDER");
    const metrics = letters.map(letter => maskContext.measureText(letter));
    const textWidth = metrics.reduce((sum,metric) => sum+metric.width,0) + spacing*Math.max(0,letters.length-1);
    // CSS 中央对齐与实际字体度量共同确定基线，避免不同系统字体把揭字位置推离标题。
    const fontMetrics = maskContext.measureText("Mg");
    const ascent = fontMetrics.fontBoundingBoxAscent || fontSize*0.8;
    const descent = fontMetrics.fontBoundingBoxDescent || fontSize*0.2;
    let x = textBounds.left-bounds.left+(textBounds.width-textWidth)/2;
    const y = maskHeadingTop+(textBounds.height-ascent-descent)/2+ascent;
    letters.forEach((letter,index) => {
      maskContext.fillText(letter,x,y);
      x += (metrics[index]?.width ?? 0)+spacing;
    });
    gl.bindTexture(gl.TEXTURE_2D,resources.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,mask);
    draw();
    if (!gl.isContextLost()) {
      canvas.style.visibility = "visible";
      host.dataset.inkRenderer = "active";
    }
  };

  const tick = (now: number): void => {
    frame = 0;
    if (disposed || lost || paused || document.hidden) return;
    // 恢复调度或测试切换时钟后，首个 RAF 时间戳可能早于基线；负阻尼会让尾迹坐标发散。
    const dt = Math.max(0,Math.min((now-previousTime)/1000,0.05));
    previousTime = now;
    elapsed += dt;
    // 真实指针移动才激活文字波动；停止或离开后平滑衰减，自动漫游不扰动文字。
    const textTarget = scene.kind!=="pointer" || activePointer === null ? 0 : Math.exp(-Math.max(0,elapsed-lastPointer)*5.0);
    textStrength += (textTarget-textStrength)*(1-Math.exp(-dt*10));
    const usesPointer = activePointer !== null && elapsed-lastPointer<2.4;
    const target = scene.kind!=="pointer" ? undefined : usesPointer && activePointer !== null ? activePointer : autoPosition(elapsed+1.5);
    if (target !== undefined) {
      followInkTrail(trail,target,dt);
    }
    draw();
    frame = requestAnimationFrame(tick);
  };
  const schedule = (): void => {
    if (!disposed && !lost && !paused && !document.hidden && frame===0) {
      previousTime = performance.now();
      frame = requestAnimationFrame(tick);
    }
  };
  const stop = (): void => { cancelAnimationFrame(frame); frame = 0; };
  const onPointer = (event: PointerEvent): void => {
    if (scene.kind==="graph") {
      // 被控件、透明门禁或触屏接管的输入不能续接旧扫线，重新进入图时先建立新起点。
      if (motion.matches || sceneMorph!==null || event.pointerType==="touch" || !(event.target instanceof Element) ||
        event.target.closest("[inert], [data-ink-overlay], .react-flow__handle")!==null) {
        graphPointer = null;
        return;
      }
      const article = event.target.closest<HTMLElement>("[data-ink-node]");
      if (article===null && event.target.closest("button,a")!==null) { graphPointer = null; return; }
      const bounds = host.getBoundingClientRect();
      const point = { x: (event.clientX-bounds.left)/width,y: (event.clientY-bounds.top)/height };
      const previous = graphPointer;
      graphPointer = point;
      // 触屏和节点拖动只走同一批材料的重排，不再叠加 hover 动量；停留也不重复注能。
      if (previous===null || event.buttons!==0) return;
      const dx = (point.x-previous.x)*width, dy = (point.y-previous.y)*height;
      const length = Math.hypot(dx,dy);
      if (length<1.2) return;
      const ux = dx/length, uy = dy/length;
      const sweepDistance = (sample: TrailPoint): { x: number; y: number; distance: number } => {
        const sx = (sample.x-previous.x)*width, sy = (sample.y-previous.y)*height;
        const t = Math.max(0,Math.min(1,(sx*dx+sy*dy)/(length*length)));
        const x = sx-dx*t, y = sy-dy*t;
        return { x,y,distance: Math.hypot(x,y) };
      };
      let selected: DragPosition | undefined;
      let nearest = Infinity;
      for (const [id,state] of dragPositions) {
        const element = currentNodeElements.get(id);
        if (element===undefined || !element.isConnected || element.closest("[inert],[aria-hidden='true']")!==null) continue;
        if (article?.dataset.inkNode===id) { selected = state; break; }
        const distance = Math.min(...state.points.map(sample => sweepDistance(sample).distance-sample.radius*height));
        if (distance<38 && distance<nearest) { selected = state; nearest = distance; }
      }
      if (selected===undefined) return;
      selected.points.forEach((sample,index) => {
        const delta = sweepDistance(sample), offset = selected?.offsets[index];
        // 接触的是有体积的材料，而非无半径的采样中心；自身半径外再留光标的局部接触范围。
        const reach = sample.radius*height+38;
        if (offset===undefined || delta.distance>=reach) return;
        const weight = (1-delta.distance/reach)**1.45;
        const radialX = delta.distance>0.5 ? delta.x/delta.distance : -uy*(index%2===0 ? 1 : -1);
        const radialY = delta.distance>0.5 ? delta.y/delta.distance : ux*(index%2===0 ? 1 : -1);
        const impulse = (800+Math.min(100,length)*25)*weight;
        pushInkMaterial(offset,(ux*0.22+radialX*1.28)*impulse,(uy*0.22+radialY*1.28)*impulse);
      });
      return;
    }
    if (scene.kind!=="pointer") return;
    // 操作角落胶囊时不把墨迹吸向控件，展开面板和联系方式也属于同一交互区域。
    if (event.target instanceof Element && event.target.closest("a, button, [data-ink-control]") !== null) {
      activePointer = null;
      return;
    }
    const bounds = host.getBoundingClientRect();
    activePointer = { x: (event.clientX-bounds.left)/Math.max(1,bounds.width), y: (event.clientY-bounds.top)/Math.max(1,bounds.height) };
    textPointer.x = activePointer.x;
    textPointer.y = activePointer.y;
    lastPointer = elapsed;
  };
  const onLeave = (): void => { activePointer = null; graphPointer = null; };
  const onVisibility = (): void => {
    // 隐藏期间没有连续指针输入，恢复后不可把离开前的位置当成一次新的拨动。
    if (document.hidden) { graphPointer = null; stop(); } else schedule();
  };
  const onMotion = (): void => {
    paused = motion.matches;
    if (paused) {
      stop();
      // 归位后清除旧半径插值源；立即关闭 reduce 也不能让已消退的自由墨迹重新冒出。
      sceneRadii = [];
      graphPointer = null;
      for (const element of heldTransferElements.keys()) clearTransferElement(element);
      heldTransferElements.clear();
      draw();
    } else schedule();
  };
  const onContextLost = (event: Event): void => {
    // 保留 DOM 标题作为失败路径；不主动调用 loseContext，以免严格模式二次初始化失败。
    event.preventDefault();
    lost = true;
    stop();
    canvas.style.visibility = "hidden";
    host.dataset.inkRenderer = "fallback";
    // 仅完成视觉搬动事务，解除文字层的等待；真实搜索状态仍完全由原状态机负责。
    if (sceneMorph?.reform===true) {
      // root 已为恢复建立 pending 占位，即使目标尚不可测也必须结束视觉事务。
      // 不读取已丢失的源/目标 DOM；先发布同代零时长 start，再交还真实目标文字的 fallback。
      if (!sceneMorph.announced) {
        sceneMorph.startedAt = performance.now();
        sceneMorph.duration = 0;
        sceneMorph.pairs = [];
        sceneMorph.announced = true;
        notifyTransfer("start",sceneMorph);
      }
      notifyTransfer("complete",sceneMorph);
    }
    sceneMorph = null;
    for (const element of transferElements) clearTransferElement(element);
    for (const element of heldTransferElements.keys()) clearTransferElement(element);
    transferElements.clear(); heldTransferElements.clear();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  observer.observe(heading);
  // 减少动态效果模式不保持 RAF；用户平移、缩放或首次挂载图节点时仍按 DOM 变化刷新静态墨团。
  const graphObserver = new MutationObserver(() => { if (paused && scene.kind==="graph") draw(); });
  graphObserver.observe(host,{ subtree: true,childList: true,attributes: true,attributeFilter: ["style","transform","data-ink-node"] });
  host.addEventListener("pointermove",onPointer,{ passive: true });
  host.addEventListener("pointerdown",onPointer,{ passive: true });
  host.addEventListener("pointerleave",onLeave);
  document.addEventListener("visibilitychange",onVisibility);
  window.addEventListener("resize",resize,{ passive: true });
  motion.addEventListener("change",onMotion);
  canvas.addEventListener("webglcontextlost",onContextLost);
  resize();
  void document.fonts.ready.then(() => { if (!disposed) { maskKey = ""; resize(); } });
  schedule();

  return {
    refreshTextPosition: draw,
    setScene(next) {
      const nextKey = inkSceneKey(next);
      const changed = currentSceneKey!==nextKey;
      if (changed) {
        const reform = next.kind==="graph" && (next.resume===true || (scene.kind==="graph" && scene.startedAt===next.startedAt));
        sceneEnteredAt = performance.now();
        sceneGeneration++;
        // 真正离场仍给旧文字层保留 260ms 末帧；旧 DOM 卸载后清理，不污染后来复用的元素。
        holdTransferOffsets(sceneEnteredAt,motion.matches ? 0 : 260);
        // 使用上次真正绘出的坐标，不能在此重读可能已卸载的旧图 DOM；中途逆转也只捕获当前态。
        sceneMorph = motion.matches && !reform ? null : { startedAt: reform ? null : sceneEnteredAt,reform,
          nodes: nodeDrawings.map(node => ({ ...node,point: { ...node.point },labelPoint: { ...node.labelPoint },
            ...(node.brush===undefined ? {} : { brush: { ...node.brush,points: node.brush.points.map(point => ({ ...point })) } }) })),
          branches: lastBranches.map(branch => ({ ...branch,a: { ...branch.a },b: { ...branch.b },c: { ...branch.c },d: { ...branch.d } })),
          pairs: null,announced: false,generation: sceneGeneration,duration: motion.matches ? 0 : SCENE_MORPH,
          ...(next.kind==="graph" && next.graphId!==undefined ? { graphId: next.graphId } : {}) };
        sceneTrail = trail.map(point => ({ ...point }));
        sceneRadii = Array.from({ length: POINT_COUNT },(_,index) => values[index*4+2] ?? 0);
        activePointer = null;
        textStrength = 0;
        graphSettled = next.kind==="graph" && (reform || motion.matches);
        dragPositions.clear();
        graphPointer = null;
        viewportKey = "";
      }
      scene = next;
      currentSceneKey = nextKey;
      if (lost && sceneMorph?.reform===true) {
        sceneMorph.startedAt = sceneEnteredAt;
        sceneMorph.duration = 0;
        sceneMorph.pairs = [];
        notifyTransfer("start",sceneMorph);
        notifyTransfer("complete",sceneMorph);
        sceneMorph = null;
      }
      // 场景只是现有画布内的视觉状态，不再借 resize 清空/重建绘图缓冲。
      // 同一视觉实体不重复同步绘制；运动、节点量测和尺寸变化由现有 RAF/观察器接续。
      if (changed) draw();
      schedule();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      stop();
      canvas.style.visibility = "hidden";
      host.dataset.inkRenderer = "fallback";
      observer.disconnect();
      graphObserver.disconnect();
      dragPositions.clear();
      currentNodeElements.clear();
      graphPointer = null;
      for (const element of transferElements) clearTransferElement(element);
      for (const element of heldTransferElements.keys()) clearTransferElement(element);
      transferElements.clear();
      heldTransferElements.clear();
      sceneMorph = null;
      nodeDrawings = [];
      lastBranches = [];
        host.removeEventListener("pointermove",onPointer);
      host.removeEventListener("pointerdown",onPointer);
      host.removeEventListener("pointerleave",onLeave);
      document.removeEventListener("visibilitychange",onVisibility);
      window.removeEventListener("resize",resize);
      motion.removeEventListener("change",onMotion);
      canvas.removeEventListener("webglcontextlost",onContextLost);
      release();
    },
  };
}
