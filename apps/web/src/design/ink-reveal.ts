/**
 * 模块职责：用浏览器原生 WebGL2（图形接口）绘制可交互的体积墨迹与局部揭字。
 *
 * 设计边界：所有颜色、笔触、液滴和文字遮罩均在本地生成，不加载录屏、图片或网络素材。
 * 生命周期：暂停时停止逐帧绘制；卸载时释放对象而不主动丢失上下文，兼容 React StrictMode。
 */
import { INK_NODE_FORM, inkEase, type InkBranch, type InkScene } from "./ink-graph-motion.js";

export type InkRevealController = Readonly<{
  refreshTextPosition: () => void;
  setScene: (scene: InkScene) => void;
  destroy: () => void;
}>;

const POINT_COUNT = 14;
const MAX_PIXELS = 1_500_000;
const NODE_BATCH = 8;
const BRANCH_BATCH = 12;

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

// 相邻采样点构成有宽度的连续笔触；软融合让相邻体块保持液体般的连接。
vec2 body(vec2 p) {
  float distance = 10.0, along = 0.0;
  if (uTrailAmount>0.001 && !uOverlay) for (int i=0; i<13; i++) {
    vec2 a = uPoints[i].xy, b = uPoints[i+1].xy;
    vec2 ab = b-a;
    float h = clamp(dot(p-a,ab)/max(dot(ab,ab),0.000001),0.0,1.0);
    float radius = mix(uPoints[i].z,uPoints[i+1].z,h);
    float d = length(p-a-ab*h)-radius;
    if (d<distance) along = (float(i)+h)/13.0;
    distance = smoothMin(distance,d,uScene==0 ? 0.035 : 0.010*uTrailAmount);
  }
  // 节点固定在 DOM 的屏幕坐标上；仅颜料边缘与表面微浮动，不移动业务节点。
  if (uScene==2) for (int i=0; i<8; i++) {
    if (i>=uNodeCount) break;
    float growth = uNodeStyles[i].x;
    if (growth<0.001) continue;
    float phase = uNodeStyles[i].z;
    vec2 center = uNodes[i].xy + vec2(sin(uTime*0.73+phase),cos(uTime*0.61+phase))*0.0028*growth;
    vec2 radius = max(uNodes[i].zw*growth,vec2(0.0001));
    vec2 q = (p-center)/radius;
    // 早退必须在柔影归零之后；距离按最短半径计量，并留出外轮廓起伏，避免矩形截影。
    float cutoff = 1.07 + 0.10/min(radius.x,radius.y);
    if (any(greaterThan(abs(q),vec2(cutoff)))) continue;
    float angle = atan(q.y,q.x);
    float ripple = sin(angle*3.0+uTime*0.71+phase)*0.038 + sin(angle*5.0-uTime*0.39+phase)*0.021;
    float shape = pow(pow(abs(q.x),2.65)+pow(abs(q.y),2.65),1.0/2.65);
    float d = (shape-1.0+ripple)*min(radius.x,radius.y);
    if (d<distance) along = 1.0-uNodeStyles[i].y;
    distance = smoothMin(distance,d,0.009*growth);
  }
  // 分支只在它的飞行/液颈断开窗口存在；最终连接完全由正式 React Flow 边承接。
  if (uScene==2) for (int i=0; i<12; i++) {
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
    if (branchDistance<distance) along = 1.0-uBranchStyles[i].z;
    distance = smoothMin(distance,branchDistance,0.006);
  }
  return vec2(distance, along);
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
  vec2 roughField = body(p);
  vec2 warp = vec2(0.0);
  if (roughField.x<0.065) warp = vec2(noise3(vec3(p*6.0,uTime*0.14)),noise3(vec3(p*6.0+17.0,uTime*0.12)))-0.5;
  float distortion = uScene==0 ? 0.039 : uScene==1 ? 0.010 : 0.013;
  vec2 field = roughField.x<0.065 ? body(p + warp*distortion) : roughField;
  float wrinkle = field.x<0.045 ? fbm(vec3(p*37.0,uTime*0.28)) : 0.49;
  float edge = field.x + (wrinkle-0.49)*(uScene==0 ? 0.022 : 0.007);
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

  // 少量游离液滴使用相同颜料与投影，不铺满背景，避免夺走排版焦点。
  if (uScene==0 && !uOverlay) for (int i=0; i<8; i++) {
    float fi = float(i);
    int index = 2 + i;
    vec2 center = uPoints[index].xy + vec2(sin(fi*2.39+uTime*0.47),cos(fi*3.41+uTime*0.39))*vec2(0.14,0.19);
    float radius = 0.006 + 0.007*(0.5+0.5*sin(fi*5.7));
    vec2 q = p-center;
    float angle = fi*2.17 + 0.21*sin(uTime*0.19+fi);
    q = mat2(cos(angle),-sin(angle),sin(angle),cos(angle))*q;
    q.x *= 0.73+0.19*sin(fi+uTime*0.5);
    q.y *= 1.09+0.26*cos(fi*1.3+uTime*0.4);
    float polar = atan(q.y,q.x);
    float lobes = 1.0 + 0.11*sin(polar*3.0+fi) + 0.065*sin(polar*5.0-fi*0.7);
    lobes += 0.10*clamp(q.y/radius,-1.0,1.0);
    float d = length(q)-radius*lobes;
    float sh = (1.0-smoothstep(radius,radius+0.009,length(p-center-vec2(0.006,0.008))))*0.12;
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
type NodeDrawing = Readonly<{ point: NodePosition; growth: number; phase: number }>;
type BranchDrawing = Readonly<{ a: TrailPoint; b: TrailPoint; c: TrailPoint; d: TrailPoint; radius: number; neck: number; color: number; head: number }>;

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

/** 初始化失败关闭到静态标题；成功时返回只操作呈现层的轻量控制器。 */
export function createInkReveal(
  canvas: HTMLCanvasElement,
  host: HTMLElement,
  heading: HTMLElement,
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
  let sceneEnteredAt = performance.now();
  let graphSettled = false;
  let sceneTrail: readonly TrailPoint[] = [];
  let trailAmount = 1;
  let nodeDrawings: readonly NodeDrawing[] = [];
  const textPointer: TrailPoint = { x: 0.5, y: 0.5 };
  const values = new Float32Array(POINT_COUNT*4);
  const nodeValues = new Float32Array(NODE_BATCH*4);
  const nodeStyles = new Float32Array(NODE_BATCH*4);
  const branchA = new Float32Array(BRANCH_BATCH*4);
  const branchB = new Float32Array(BRANCH_BATCH*4);
  const branchStyles = new Float32Array(BRANCH_BATCH*4);
  const autoPosition = (t: number): TrailPoint => ({
    x: 0.5 + 0.39*Math.sin(t*0.91+0.28),
    y: 0.5 + 0.26*Math.sin(t*1.29+0.1)*Math.cos(t*0.38),
  });
  const trail: TrailPoint[] = Array.from({ length: POINT_COUNT }, (_, index) => autoPosition(1.5-index*0.052));

  const scenePositions = (): Map<string, NodePosition> => {
    const positions = new Map<string, NodePosition>();
    if (scene.kind!=="graph") return positions;
    const bounds = host.getBoundingClientRect();
    const elements = new Map(Array.from(host.querySelectorAll<HTMLElement>("[data-ink-node]"), element => [element.dataset.inkNode,element]));
    scene.nodes.forEach((birth,index) => {
      const element = elements.get(birth.id);
      if (element===undefined) return;
      const rect = element.getBoundingClientRect();
      if (rect.width<=0 || rect.height<=0) return;
      positions.set(birth.id,{
        x: (rect.left-bounds.left+rect.width/2)/width,
        y: (rect.top-bounds.top+rect.height/2)/height,
        radiusX: rect.width*0.54/height,
        radiusY: rect.height*0.65/height,
        color: 0.08+0.84*index/Math.max(1,scene.kind==="graph" ? scene.nodes.length-1 : 1),
      });
    });
    return positions;
  };

  /** 时间表只决定颜料的呈现；读取 DOM 屏幕坐标，禁止把布局坐标误当成视口坐标。 */
  const updateScene = (now: number): readonly BranchDrawing[] => {
    nodeDrawings = [];
    const aspect = width/height;
    if (scene.kind==="pointer") { trailAmount = 1; return []; }
    const age = Math.max(0,now-scene.startedAt);
    const minimum = Math.min(width,height);
    if (scene.kind==="loading") {
      const radius = Math.max(76,Math.min(160,minimum*0.23));
      const entry = motion.matches ? 1 : inkEase(age/420);
      trail.forEach((point,index) => {
        const phase = (Math.max(0,age-index*29)%2200)/2200;
        const angle = inkEase(phase)*Math.PI*2-0.72;
        const orbit = { x: 0.5+Math.cos(angle)*radius/width, y: 0.5+Math.sin(angle)*radius*0.86/height };
        const origin = sceneTrail[index] ?? orbit;
        point.x = origin.x+(orbit.x-origin.x)*entry;
        point.y = origin.y+(orbit.y-origin.y)*entry;
      });
      trailAmount = 1;
      return [];
    }
    // 系统减少动态效果一旦让本图直接成形，关闭偏好也不倒退到未出生的墨团。
    // 仅新的场景时钟或离开图场景清除此标记；后续只恢复表面浮动。
    if (motion.matches) graphSettled = true;
    const positions = scenePositions();
    // 恢复历史只跳过旧传播，不跳过本次进入的短显现；新搜索首个出生时间晚于此门，原时序不变。
    const entrance = graphSettled ? 1 : inkEase((now-sceneEnteredAt)/INK_NODE_FORM);
    nodeDrawings = scene.nodes.flatMap((birth,index): readonly NodeDrawing[] => {
      const point = positions.get(birth.id);
      if (point===undefined) return [];
      const growth = (graphSettled ? 1 : inkEase((age-birth.bornAt)/INK_NODE_FORM))*entrance;
      if (growth<0.001) return [];
      // 屏外剔除复用 shader 的最短半径距离，并额外覆盖浮动、偏移柔影；不按数组数量省略节点。
      const radiusX = Math.max(0.0001,point.radiusX*growth), radiusY = Math.max(0.0001,point.radiusY*growth);
      const cutoff = 1.07+0.10/Math.min(radiusX,radiusY);
      const extentX = radiusX*cutoff+0.04, extentY = radiusY*cutoff+0.04;
      const x = point.x*aspect;
      if (x+extentX<0 || x-extentX>aspect || point.y+extentY<0 || point.y-extentY>1) return [];
      return [{ point,growth,phase: index*2.17 }];
    });
    const first = scene.nodes.filter(birth => birth.seed).reduce<(typeof scene.nodes)[number] | undefined>((earliest,birth) => earliest===undefined || birth.bornAt<earliest.bornAt ? birth : earliest,undefined);
    const target = first===undefined ? undefined : positions.get(first.id);
    trailAmount = graphSettled || first===undefined || target===undefined ? 0 : 1-inkEase((age-first.bornAt-120)/420);
    if (first!==undefined && target!==undefined && trailAmount>0) {
      const origin = sceneTrail[0] ?? { x: 0.5,y: 0.5 };
      trail.forEach((point,index) => {
        const next = flightPoint(origin,target,inkEase((age-index*21)/Math.max(1,first.bornAt)),width,height);
        point.x = next.x;
        point.y = next.y;
      });
    }
    if (graphSettled) return [];
    return scene.branches.flatMap((branch: InkBranch): readonly BranchDrawing[] => {
      if (age<branch.startAt || age>=branch.detachAt) return [];
      const from = positions.get(branch.source), to = positions.get(branch.target);
      if (from===undefined || to===undefined) return [];
      const progress = inkEase((age-branch.startAt)/Math.max(1,branch.arriveAt-branch.startAt));
      const detach = inkEase((age-branch.arriveAt)/Math.max(1,branch.detachAt-branch.arriveAt));
      const zoom = from.radiusX*height/(240*0.54);
      return [{
        a: from,
        b: flightPoint(from,to,progress/3,width,height),
        c: flightPoint(from,to,progress*2/3,width,height),
        d: flightPoint(from,to,progress,width,height),
        radius: 7.5*zoom/height*Math.pow(1-detach,0.55),
        neck: 1-detach,
        color: from.color+(to.color-from.color)*progress*0.5,
        head: (12+7*Math.sin(progress*Math.PI))*zoom/height*(1-detach),
      }];
    });
  };

  const draw = (): void => {
    if (disposed || lost) return;
    const aspect = width/height;
    const branches = updateScene(performance.now());
    trail.forEach((point,index) => {
      const offset = index*4;
      const taper = 0.37+0.63*Math.sin((index/(POINT_COUNT-1))*Math.PI);
      values[offset] = point.x*aspect;
      values[offset+1] = point.y;
      const radius = scene.kind==="pointer" ? 0.059+0.021*Math.sin(index*0.73+elapsed*1.7) : scene.kind==="loading" ? 0.023*Math.min(width,height)/height : 0.050*Math.min(width,height)/height;
      values[offset+2] = radius*taper*trailAmount;
      values[offset+3] = index/(POINT_COUNT-1);
    });
    gl.useProgram(resources.program);
    gl.uniform2f(resolution,canvas.width,canvas.height);
    gl.uniform1f(timeUniform,elapsed);
    gl.uniform4fv(pointsUniform,values);
    gl.uniform4f(textPointerUniform,textPointer.x*aspect,textPointer.y,textStrength,3.2/height);
    gl.uniform1i(sceneUniform,scene.kind==="pointer" ? 0 : scene.kind==="loading" ? 1 : 2);
    gl.uniform1f(trailAmountUniform,trailAmount);
    // 只平移文字采样，不移动或重建墨迹画布；CSS 位移时也保持黑字与反相白字同步。
    const headingTop = heading.getBoundingClientRect().top-host.getBoundingClientRect().top;
    gl.uniform1f(headingShiftUniform,(headingTop-maskHeadingTop)/height);
    // uniform 数组仅限定每批容量。人工历史图可以超过八节点，所有可见节点与活动分支都分批提交。
    const batches = Math.max(1,Math.ceil(nodeDrawings.length/NODE_BATCH),Math.ceil(branches.length/BRANCH_BATCH));
    for (let batch=0; batch<batches; batch++) {
      const nodes = nodeDrawings.slice(batch*NODE_BATCH,(batch+1)*NODE_BATCH);
      const slice = branches.slice(batch*BRANCH_BATCH,(batch+1)*BRANCH_BATCH);
      nodeValues.fill(0); nodeStyles.fill(0);
      nodes.forEach((node,index) => {
        const { point,growth,phase } = node;
        nodeValues.set([point.x*aspect,point.y,point.radiusX,point.radiusY],index*4);
        nodeStyles.set([growth,point.color,phase,0],index*4);
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
    const pixelLimit = scene.kind==="graph" ? 1_000_000 : MAX_PIXELS;
    const density = Math.min(window.devicePixelRatio || 1,1.75,Math.sqrt(pixelLimit/(width*height)));
    canvas.width = Math.max(1,Math.round(width*density));
    canvas.height = Math.max(1,Math.round(height*density));
    mask.width = canvas.width;
    mask.height = canvas.height;
    maskContext.setTransform(density,0,0,density,0,0);
    maskContext.clearRect(0,0,width,height);
    const style = getComputedStyle(heading);
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
    gl.viewport(0,0,canvas.width,canvas.height);
    draw();
    if (!gl.isContextLost()) {
      canvas.style.visibility = "visible";
      host.dataset.inkRenderer = "active";
    }
  };

  const tick = (now: number): void => {
    frame = 0;
    if (disposed || lost || paused || document.hidden) return;
    const dt = Math.min((now-previousTime)/1000,0.05);
    previousTime = now;
    elapsed += dt;
    // 真实指针移动才激活文字波动；停止或离开后平滑衰减，自动漫游不扰动文字。
    const textTarget = scene.kind!=="pointer" || activePointer === null ? 0 : Math.exp(-Math.max(0,elapsed-lastPointer)*5.0);
    textStrength += (textTarget-textStrength)*(1-Math.exp(-dt*10));
    const usesPointer = activePointer !== null && elapsed-lastPointer<2.4;
    const target = scene.kind!=="pointer" ? undefined : usesPointer && activePointer !== null ? activePointer : autoPosition(elapsed+1.5);
    if (target !== undefined) {
      const head = trail[0];
      if (head !== undefined) {
        const smoothing = 1-Math.exp(-dt*10);
        head.x += (target.x-head.x)*smoothing;
        head.y += (target.y-head.y)*smoothing;
      }
      for (let index=trail.length-1; index>0; index--) {
        const point = trail[index], ahead = trail[index-1];
        if (point === undefined || ahead === undefined) continue;
        // 尾部比笔头更慢地回落，保留连续展开的墨迹长度与颜色层次。
        const smoothing = 1-Math.exp(-dt*9);
        point.x += (ahead.x-point.x)*smoothing;
        point.y += (ahead.y-point.y)*smoothing;
      }
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
  const onLeave = (): void => { activePointer = null; };
  const onVisibility = (): void => { if (document.hidden) stop(); else schedule(); };
  const onMotion = (): void => {
    paused = motion.matches;
    if (paused) { stop(); draw(); } else schedule();
  };
  const onContextLost = (event: Event): void => {
    // 保留 DOM 标题作为失败路径；不主动调用 loseContext，以免严格模式二次初始化失败。
    event.preventDefault();
    lost = true;
    stop();
    canvas.style.visibility = "hidden";
    host.dataset.inkRenderer = "fallback";
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
  motion.addEventListener("change",onMotion);
  canvas.addEventListener("webglcontextlost",onContextLost);
  resize();
  void document.fonts.ready.then(() => { if (!disposed) resize(); });
  schedule();

  return {
    refreshTextPosition: draw,
    setScene(next) {
      const changed = scene.kind!==next.kind || (scene.kind!=="pointer" && next.kind!=="pointer" && scene.startedAt!==next.startedAt);
      if (changed) {
        sceneEnteredAt = performance.now();
        sceneTrail = trail.map(point => ({ ...point }));
        activePointer = null;
        textStrength = 0;
        graphSettled = false;
      }
      scene = next;
      if (changed) resize(); else draw();
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
      host.removeEventListener("pointermove",onPointer);
      host.removeEventListener("pointerdown",onPointer);
      host.removeEventListener("pointerleave",onLeave);
      document.removeEventListener("visibilitychange",onVisibility);
      motion.removeEventListener("change",onMotion);
      canvas.removeEventListener("webglcontextlost",onContextLost);
      release();
    },
  };
}
