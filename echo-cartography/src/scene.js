// 渲染层。算法侧不 import 这个文件，反过来也一样单向：
// 这里只【读】仿真状态，不写回去。
//
// 场景是一条海沟：阶梯状的沟壁向下收拢，中间留出一条通道。
// 沟壁用轴对齐盒体拼 —— 不是偷懒，是因为射线求交与真值体素化对 AABB
// 都是解析精确的（见 TERRAIN-SPEC.md）。美术要好看可以另外套一层 mesh，
// 那层不参与物理。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TANK, PALETTE, AGENT, CREATURE, CAMERA } from './params.js';

const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _camTarget = new THREE.Vector3();
const _lookAt = new THREE.Vector3();
const _calm = new THREE.Color(PALETTE.agentCalm);
const _afraid = new THREE.Color(PALETTE.agentPanic);
const _mix = new THREE.Color();
const _glowCalm = new THREE.Color(PALETTE.agentGlowCalm);
const _glowPanic = new THREE.Color(PALETTE.agentGlowPanic);
const _glowMix = new THREE.Color();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _bodyQ = new THREE.Quaternion();
const ROV_URL = new URL('../assets/models/industrial-deep-sea-inspection-rov.glb', import.meta.url).href;
const PREDATOR_URL = new URL('../assets/models/predator-red-fish.glb', import.meta.url).href;

// 机体附近的假光：半透明加色光晕，不创建真实 Point/SpotLight。
// flocks: on a light background an additive glow disappears, so the halos
// are drawn with normal blending and kept faint.
const GLOW = {
  coreScale: 5,   // 相对 bodyLength
  haloScale: 12,
  coreOpacity: 0.12,
  haloOpacity: 0.04,
};

// 捕食者暗红假光：比 ROV 的暖琥珀更沉、更威胁感。
const CREATURE_GLOW = {
  coreScale: 3.2,  // 相对 bodyLength
  haloScale: 8.5,
  coreOpacity: 0.14,
  haloOpacity: 0.05,
};

// ROV 原材质是冷青工业色，和场景暖深海（骨白/赭石/沟壁棕）冲突。
// 按角色重映射成"暖深渊黄铜"：壳暖灰、架深褐、件黄铜、灯琥珀。
const ROV_TONE = {
  shell: new THREE.Color('#4f463c'),
  frame: new THREE.Color('#1b1713'),
  accent: new THREE.Color('#9a7d55'),
  eye: new THREE.Color('#e6c78a'),
  eyeEmissive: new THREE.Color('#a67c3a'),
};

function toneRovMaterial(base, emissive) {
  const eSum = emissive.r + emissive.g + emissive.b;
  const sum = base.r + base.g + base.b;
  // 原亮青灯 / 带 emissive → 探测灯改琥珀
  if (eSum > 0.15 || (base.b > 0.65 && base.g > 0.55)) {
    return { color: ROV_TONE.eye.clone(), emissive: ROV_TONE.eyeEmissive.clone() };
  }
  // 原中亮青零件 → 黄铜件
  if (base.b > 0.25 && base.g > 0.2 && base.r < 0.15) {
    return { color: ROV_TONE.accent.clone(), emissive: new THREE.Color(0x000000) };
  }
  // 近黑结构架
  if (sum < 0.12) {
    return { color: ROV_TONE.frame.clone(), emissive: new THREE.Color(0x000000) };
  }
  // 主壳体
  return { color: ROV_TONE.shell.clone(), emissive: new THREE.Color(0x000000) };
}

// ── 纺锤形个体 ─────────────────────────────────────────────────
// 真实鱼类与水下航行器共有的低阻体形：两端收尖、中段最粗。
// 用 LatheGeometry 旋转一条剖面线得到，再拼一个小锥体当尾。
function buildAgentGeometry() {
  const segments = 14;
  const profile = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    // sin 曲线取 0.75 次幂：比纯 sin 更饱满，头尾仍然收尖
    const r = AGENT.bodyRadius * Math.pow(Math.sin(Math.PI * t), 0.75);
    profile.push(new THREE.Vector2(Math.max(r, 1e-4), (t - 0.5) * AGENT.bodyLength));
  }
  const body = new THREE.LatheGeometry(profile, 10);

  const tail = new THREE.ConeGeometry(AGENT.tailRadius, AGENT.tailLength, 6, 1, true);
  tail.scale(1, 1, 0.35); // 压扁成尾鳍而不是一个圆锥
  tail.rotateX(Math.PI); // 锥尖朝 −Y（朝后）
  tail.translate(0, -AGENT.bodyLength / 2 - AGENT.tailLength / 2 + 0.06, 0);

  const merged = BufferGeometryUtils.mergeGeometries([body, tail], false);
  merged.rotateX(Math.PI / 2); // 长轴由 +Y 转到 +Z = 前方
  return merged;
}


// 把多材质低模 ROV 烘焙成【单个】BufferGeometry，供 InstancedMesh 使用。
// - 原模型 +X 朝前、眼睛在 +X；项目约定 +Z 朝前，因此绕 Y 转 -90°
// - 顶点色保留壳体分区；instanceColor 再叠冷静/恐慌染色
// - 无贴图、无骨骼，加载后只留一份合并几何
async function loadRovAgentGeometry() {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(ROV_URL);
  const parts = [];
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;

    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const groups = (obj.geometry.groups && obj.geometry.groups.length)
      ? obj.geometry.groups
      : [{ start: 0, count: (obj.geometry.index ? obj.geometry.index.count : obj.geometry.attributes.position.count), materialIndex: 0 }];

    // 多 primitive 可能被 loader 收成"单 mesh + groups"；按 group 拆开烘焙顶点色
    for (const group of groups) {
      const geom = obj.geometry.clone();
      // 只保留该 group 的索引范围
      if (obj.geometry.index) {
        const src = obj.geometry.index;
        const slice = new src.array.constructor(group.count);
        for (let i = 0; i < group.count; i += 1) slice[i] = src.array[group.start + i];
        geom.setIndex(new THREE.BufferAttribute(slice, 1));
      }
      geom.applyMatrix4(obj.matrixWorld);

      const mat = mats[group.materialIndex || 0] || mats[0] || {};
      const base = mat.color ? mat.color.clone() : new THREE.Color(0xffffff);
      const emissive = mat.emissive ? mat.emissive.clone() : new THREE.Color(0x000000);
      // 丢掉冷青原色，烘焙进暖深渊角色色；灯保留一点 emissive 亮度
      const toned = toneRovMaterial(base, emissive);
      const display = toned.color.clone().add(toned.emissive);
      // 雾里略抬亮，但仍压在地形暖棕体系内（不再偏蓝）
      display.r = Math.min(1, display.r * 1.18 + 0.04);
      display.g = Math.min(1, display.g * 1.12 + 0.03);
      display.b = Math.min(1, display.b * 1.05 + 0.02);

      const n = geom.attributes.position.count;
      const colors = new Float32Array(n * 3);
      for (let i = 0; i < n; i += 1) {
        colors[i * 3] = display.r;
        colors[i * 3 + 1] = display.g;
        colors[i * 3 + 2] = display.b;
      }
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      if (geom.attributes.normal) geom.deleteAttribute('normal');
      if (geom.attributes.uv) geom.deleteAttribute('uv');
      // 清掉 groups，避免 merge 后残留
      geom.clearGroups();
      parts.push(geom);
    }
  });

  if (!parts.length) throw new Error('ROV glb contained no meshes');

  let merged = BufferGeometryUtils.mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  if (!merged) throw new Error('failed to merge ROV geometries');

  // +X 前向 → +Z 前向
  merged.rotateY(-Math.PI / 2);
  merged.computeBoundingBox();
  const center = new THREE.Vector3();
  merged.boundingBox.getCenter(center);
  merged.translate(-center.x, -center.y, -center.z);

  merged.computeBoundingBox();
  const size = new THREE.Vector3();
  merged.boundingBox.getSize(size);
  // 长轴对齐 bodyLength；ROV 比纺锤鱼"胖"，用 Z 长而非对角线，避免缩太小
  const s = AGENT.bodyLength / Math.max(size.z, 1e-6);
  merged.scale(s, s, s);
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

function makeGlowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.12)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildCreatureGeometry() {
  const segments = 16;
  const profile = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const r = CREATURE.bodyRadius * Math.pow(Math.sin(Math.PI * t), 0.7);
    profile.push(new THREE.Vector2(Math.max(r, 1e-4), (t - 0.5) * CREATURE.bodyLength));
  }
  const body = new THREE.LatheGeometry(profile, 14);
  const tail = new THREE.ConeGeometry(CREATURE.bodyRadius * 2.1, CREATURE.bodyLength * 0.34, 6, 1, true);
  tail.scale(1, 1, 0.22);
  tail.rotateX(Math.PI);
  tail.translate(0, -CREATURE.bodyLength / 2 - CREATURE.bodyLength * 0.14, 0);
  const merged = BufferGeometryUtils.mergeGeometries([body, tail], false);
  merged.rotateX(Math.PI / 2);
  return merged;
}

// 把低模红鱼烘焙成单个 BufferGeometry，供捕食者 Mesh 使用。
// - 原模型 +X 朝前（吻侧在 +X，尾鳍在 -X）；项目约定 +Z 朝前 → 绕 Y -90°
// - 顶点色保留壳体分区，并叠一层暗红 emissive 亮度，方便雾里仍能读出轮廓
function tonePredatorMaterial(base) {
  const sum = base.r + base.g + base.b;
  // 近黑眼窝：留一点暗红自发光，像深渊里的瞳孔
  if (sum < 0.08) {
    return {
      color: new THREE.Color('#120303'),
      emissive: new THREE.Color('#4a0808'),
    };
  }
  // 较亮腹侧 / 鳍缘 → 更热的暗红
  if (base.r > 0.55) {
    return {
      color: new THREE.Color('#6e1610'),
      emissive: new THREE.Color('#5a0e0a'),
    };
  }
  // 主壳体：沉暗红
  return {
    color: new THREE.Color('#3a0f0c'),
    emissive: new THREE.Color('#2a0806'),
  };
}

async function loadPredatorGeometry() {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(PREDATOR_URL);
  const parts = [];
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;

    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const groups = (obj.geometry.groups && obj.geometry.groups.length)
      ? obj.geometry.groups
      : [{ start: 0, count: (obj.geometry.index ? obj.geometry.index.count : obj.geometry.attributes.position.count), materialIndex: 0 }];

    for (const group of groups) {
      const geom = obj.geometry.clone();
      if (obj.geometry.index) {
        const src = obj.geometry.index;
        const slice = new src.array.constructor(group.count);
        for (let i = 0; i < group.count; i += 1) slice[i] = src.array[group.start + i];
        geom.setIndex(new THREE.BufferAttribute(slice, 1));
      }
      geom.applyMatrix4(obj.matrixWorld);

      const mat = mats[group.materialIndex || 0] || mats[0] || {};
      const base = mat.color ? mat.color.clone() : new THREE.Color(0x3a1210);
      const toned = tonePredatorMaterial(base);
      // display = albedo + 一部分 emissive，Instanced/单 Mesh 都能读出"带红光"
      const display = toned.color.clone().add(toned.emissive.clone().multiplyScalar(0.85));
      display.r = Math.min(1, display.r * 1.12 + 0.03);
      display.g = Math.min(1, display.g * 0.95);
      display.b = Math.min(1, display.b * 0.9);

      const n = geom.attributes.position.count;
      const colors = new Float32Array(n * 3);
      for (let i = 0; i < n; i += 1) {
        colors[i * 3] = display.r;
        colors[i * 3 + 1] = display.g;
        colors[i * 3 + 2] = display.b;
      }
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      if (geom.attributes.normal) geom.deleteAttribute('normal');
      if (geom.attributes.uv) geom.deleteAttribute('uv');
      geom.clearGroups();
      parts.push(geom);
    }
  });

  if (!parts.length) throw new Error('predator glb contained no meshes');

  let merged = BufferGeometryUtils.mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  if (!merged) throw new Error('failed to merge predator geometries');

  // +X 前向 → +Z 前向
  merged.rotateY(-Math.PI / 2);
  merged.computeBoundingBox();
  const center = new THREE.Vector3();
  merged.boundingBox.getCenter(center);
  merged.translate(-center.x, -center.y, -center.z);

  merged.computeBoundingBox();
  const size = new THREE.Vector3();
  merged.boundingBox.getSize(size);
  const s = CREATURE.bodyLength / Math.max(size.z, 1e-6);
  merged.scale(s, s, s);
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}


// ── 海沟地形 ───────────────────────────────────────────────────
// 结构是"高原上的一道槽"，不是一个填满的盒子。
//
// 这个区别不是美术偏好 —— 如果岩体一直填到包围盒顶，近侧沟壁会从任何
// 斜俯视角度把沟里整个挡住，看不见的东西等于没做。真实海沟本来也是
// 海床高原被切开一道，上方是开阔水体。集群正是从那片开阔水体下潜进来的。
const BED_TOP = -TANK.height / 2 + TANK.height * 0.5; // 海床台面高度

function buildTrench() {
  const specs = [];
  const halfW = TANK.width / 2;
  const halfH = TANK.height / 2;
  const halfD = TANK.depth / 2;
  const LEVELS = 8;
  const SEGMENTS = 18; // 沿 x 切段，每段的通道中心不同
  const bedH = BED_TOP - -halfH;
  const levelH = bedH / LEVELS;
  const segW = TANK.width / SEGMENTS;

  for (let s = 0; s < SEGMENTS; s += 1) {
    const x0 = -halfW + s * segW;
    const cx = x0 + segW / 2;
    // 通道中心的横向摆动 + 宽度起伏 —— 没有它就是一条笔直的走廊
    const drift = Math.sin(cx * 0.048) * halfD * 0.2 + Math.sin(cx * 0.11) * halfD * 0.06;
    const widen = 1 + Math.sin(cx * 0.085 + 1.7) * 0.22;

    for (let l = 0; l < LEVELS; l += 1) {
      const yLow = -halfH + l * levelH;
      // 通道半宽：底层最窄，向上张开成 V 形
      const t = (l + 0.5) / LEVELS;
      const channel = halfD * (0.2 + 0.46 * t * t) * widen;
      const left = drift - channel;
      const right = drift + channel;

      if (left > -halfD + 0.5) {
        specs.push({ min: [x0, yLow, -halfD], max: [x0 + segW, yLow + levelH, left] });
      }
      if (right < halfD - 0.5) {
        specs.push({ min: [x0, yLow, right], max: [x0 + segW, yLow + levelH, halfD] });
      }
    }
  }

  // ── 海床地板 ──
  //
  // 沟道底部原本【没有实体】—— 靠的是任务包围盒内壁。
  // 边界不再进地图之后（它是我们画的框，不是地形），底面就整个消失了：
  // 点云悬空，Mesh 没有底，按 xz 列统计覆盖率时大片列永远是零。
  // 所以要一层真地板。薄一点，只是给射线一个可命中的实体。
  specs.push({
    min: [-halfW, -halfH, -halfD],
    max: [halfW, -halfH + 1.2, halfD],
  });

  // ── 沟中山峰 ──
  //
  // 平坦的沟底没什么可测的，点云出来就是一张平板。山峰给的是【垂直结构】：
  // 它在点云里最出效果，而且峰与沟壁之间的窄缝会形成真正的遮挡 ——
  // 集群必须绕进去才测得到，覆盖率这才第一次成为一个真问题。
  //
  // 逐层收窄的盒体堆叠，与阶梯沟壁同一种语言：低多边形 + 硬边。
  const spire = (sx, szOff, height, baseW, baseD, layers = 5) => {
    const drift = Math.sin(sx * 0.048) * halfD * 0.2 + szOff;
    const layerH = height / layers;
    for (let l = 0; l < layers; l += 1) {
      const t = 1 - l / layers; // 自下而上收窄
      const w = baseW * (0.28 + 0.72 * t);
      const d = baseD * (0.28 + 0.72 * t);
      // 每层轻微错位，避免堆成一座完美的金字塔
      const jx = Math.sin(sx * 0.7 + l * 1.9) * baseW * 0.08;
      const jz = Math.cos(sx * 0.5 + l * 2.3) * baseD * 0.08;
      specs.push({
        min: [sx - w / 2 + jx, -halfH + l * layerH, drift - d / 2 + jz],
        max: [sx + w / 2 + jx, -halfH + (l + 1) * layerH, drift + d / 2 + jz],
      });
    }
  };

  // 高度参差：有的几乎顶到沟沿，有的只是矮丘 —— 高的那些会把沟切成几段，
  // 集群得绕过去，这正是要给终端出的题。
  spire(-56, 2, bedH * 0.86, 13, 12);
  spire(-40, -9, bedH * 0.42, 10, 11, 4);
  spire(-22, 5, bedH * 0.95, 15, 13, 6);
  spire(-4, -6, bedH * 0.55, 11, 10, 4);
  spire(12, 7, bedH * 0.78, 12, 14);
  spire(30, -4, bedH * 0.36, 14, 10, 3);
  spire(46, 6, bedH * 0.9, 13, 12, 6);
  spire(62, -7, bedH * 0.5, 11, 12, 4);

  // 沟底散石：小尺度细节，让点云不至于只有大块面
  const rocks = [
    [-48, 6, 7, 5, 6], [-30, -3, 9, 4, 7], [-12, 8, 6, 6, 5],
    [4, -8, 8, 5, 8], [22, 3, 7, 7, 6], [38, -6, 9, 4, 7],
    [54, 4, 6, 6, 6], [68, -2, 8, 5, 7],
  ];
  for (const [rx, rzOff, w, h, d] of rocks) {
    const drift = Math.sin(rx * 0.048) * halfD * 0.2 + rzOff;
    specs.push({
      min: [rx - w / 2, -halfH, drift - d / 2],
      max: [rx + w / 2, -halfH + h, drift + d / 2],
    });
  }
  return specs;
}

export function createScene(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.background);
  scene.fog = new THREE.Fog(PALETTE.fog, PALETTE.fogNear, PALETTE.fogFar);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 900);
  camera.position.set(
    0,
    CAMERA.overviewDistance * Math.sin(CAMERA.overviewPitch),
    CAMERA.overviewDistance * Math.cos(CAMERA.overviewPitch)
  );

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.maxDistance = 400;
  controls.minDistance = 8;
  controls.target.set(0, -TANK.height * 0.12, 0);

  // 环境光压低、主光提高：环境光开太大会把所有面照成同一个亮度，
  // 阶梯与山峰的体积感全部消失，整块地形糊成一片均匀的棕色。
  scene.add(new THREE.AmbientLight(PALETTE.ambient, 1.12));
  // 主光从上方偏斜射入 —— 深海里唯一的光只可能来自上面
  const key = new THREE.DirectionalLight(PALETTE.keyLight, 2.45);
  key.position.set(30, 90, 40);
  scene.add(key);
  // 补光从下方打，把沟底从纯黑里提出来。物理上不合理（海底没有下方光源），
  // 但没有它沟底就是一片死黑，而沟底恰好是要给人看的地方。
  const rim = new THREE.DirectionalLight(PALETTE.rimLight, 1.25);
  rim.position.set(-40, -30, -30);
  scene.add(rim);

  // ── 任务包围盒（探测区边界）──
  const boundsGeo = new THREE.BoxGeometry(TANK.width, TANK.height, TANK.depth);
  scene.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(boundsGeo),
      new THREE.LineBasicMaterial({
        color: PALETTE.boundsEdge, transparent: true, opacity: 0.5,
      })
    )
  );

  // ── 海沟 ──
  const obstacles = [];
  const terrainMat = new THREE.MeshStandardMaterial({
    color: PALETTE.terrain, roughness: 0.95, metalness: 0.02, flatShading: true,
  });
  const edgeMat = new THREE.LineBasicMaterial({
    color: PALETTE.terrainEdge, transparent: true, opacity: 0.35,
  });
  const parts = [];
  for (const spec of buildTrench()) {
    const w = spec.max[0] - spec.min[0];
    const h = spec.max[1] - spec.min[1];
    const d = spec.max[2] - spec.min[2];
    if (w <= 0 || h <= 0 || d <= 0) continue;
    const cx = (spec.min[0] + spec.max[0]) / 2;
    const cy = (spec.min[1] + spec.max[1]) / 2;
    const cz = (spec.min[2] + spec.max[2]) / 2;
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(cx, cy, cz);
    parts.push(g);
    obstacles.push({
      min: new THREE.Vector3(spec.min[0], spec.min[1], spec.min[2]),
      max: new THREE.Vector3(spec.max[0], spec.max[1], spec.max[2]),
    });
  }
  // 几百个盒体合并成一个 mesh：draw call 从几百降到 1
  const terrainGeo = BufferGeometryUtils.mergeGeometries(parts, false);
  scene.add(new THREE.Mesh(terrainGeo, terrainMat));
  scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(terrainGeo, 40), edgeMat));

  // ── 集群（ROV 模型 + 机体附近假光）──
  // 先用程序化纺锤体占位，GLB 就绪后热替换几何，避免首屏卡在加载上。
  let agentGeo = buildAgentGeometry();
  let agentUsesVertexColors = false;
  let flockMesh = null;
  let glowCoreMesh = null;
  let glowHaloMesh = null;
  const glowTexture = makeGlowTexture();
  const glowPlane = new THREE.PlaneGeometry(1, 1);

  function disposeInstanced(mesh) {
    if (!mesh) return;
    scene.remove(mesh);
    // 几何可能被 ROV/占位共享，不在这里 dispose geometry
    if (mesh.material) mesh.material.dispose();
    mesh.dispose();
  }

  function buildFlockMesh(count) {
    disposeInstanced(flockMesh);
    disposeInstanced(glowCoreMesh);
    disposeInstanced(glowHaloMesh);

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: agentUsesVertexColors ? 0.42 : 0.55,
      metalness: agentUsesVertexColors ? 0.28 : 0.05,
      vertexColors: agentUsesVertexColors,
      // 轻微自发光：深海里机身自己"带一点亮度"，假光再在外围扩一圈
      emissive: new THREE.Color(agentUsesVertexColors ? '#2a2218' : '#000000'),
      emissiveIntensity: agentUsesVertexColors ? 0.34 : 0.0,
    });

    flockMesh = new THREE.InstancedMesh(agentGeo, bodyMat, count);
    flockMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    flockMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    flockMesh.frustumCulled = false;
    scene.add(flockMesh);

    // 双层 billboard 光斑：芯亮、晕散。用平面 + additive，比真灯便宜两个数量级。
    const mkGlowMat = (opacity) => new THREE.MeshBasicMaterial({
      map: glowTexture,
      color: 0xffffff,
      transparent: true,
      opacity,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      toneMapped: false,
    });

    glowCoreMesh = new THREE.InstancedMesh(glowPlane, mkGlowMat(GLOW.coreOpacity), count);
    glowHaloMesh = new THREE.InstancedMesh(glowPlane, mkGlowMat(GLOW.haloOpacity), count);
    for (const gmesh of [glowCoreMesh, glowHaloMesh]) {
      gmesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      gmesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
      gmesh.frustumCulled = false;
      gmesh.renderOrder = 2;
      scene.add(gmesh);
    }

    return flockMesh;
  }

  // 异步替换为工业深海 ROV；失败时静默保留纺锤占位，不阻断仿真。
  loadRovAgentGeometry().then((geo) => {
    const old = agentGeo;
    agentGeo = geo;
    agentUsesVertexColors = true;
    if (flockMesh) buildFlockMesh(flockMesh.count);
    // 占位几何可释放；ROV 几何交给后续 flockMesh 共用
    if (old && old !== geo) old.dispose();
  }).catch((err) => {
    console.warn('[scene] ROV model load failed, keeping procedural agents', err);
  });

  // ── 大型生物（低模红鱼 + 暗红假光）──
  // 先用程序化纺锤体占位，GLB 就绪后热替换几何。
  let creatureGeo = buildCreatureGeometry();
  let creatureUsesModel = false;
  let creatureMat = new THREE.MeshStandardMaterial({
    color: PALETTE.creature, roughness: 0.7, metalness: 0.1,
  });
  const creatureMeshes = [];
  const creatureGlowCores = [];
  const creatureGlowHalos = [];
  const _creatureGlowCore = new THREE.Color(PALETTE.creatureGlowCore || '#a01812');
  const _creatureGlowHalo = new THREE.Color(PALETTE.creatureGlowHalo || '#5c100c');

  function disposeCreatureVisuals() {
    for (const mesh of creatureMeshes) {
      scene.remove(mesh);
      mesh.traverse((obj) => {
        if (obj.geometry && obj.geometry !== creatureGeo) obj.geometry.dispose();
        if (obj.material && obj.material !== creatureMat) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
    }
    creatureMeshes.length = 0;
    for (const g of [...creatureGlowCores, ...creatureGlowHalos]) {
      scene.remove(g);
      if (g.material) g.material.dispose();
    }
    creatureGlowCores.length = 0;
    creatureGlowHalos.length = 0;
  }

  function makeCreatureGlowMat(opacity) {
    return new THREE.MeshBasicMaterial({
      map: glowTexture,
      color: 0xffffff,
      transparent: true,
      opacity,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      toneMapped: false,
    });
  }

  function buildCreatures(n) {
    while (creatureMeshes.length < n) {
      const mesh = new THREE.Mesh(creatureGeo, creatureMat);
      if (!creatureUsesModel) {
        mesh.add(new THREE.LineSegments(
          new THREE.EdgesGeometry(creatureGeo, 30),
          new THREE.LineBasicMaterial({ color: PALETTE.creatureEdge, transparent: true, opacity: 0.55 })
        ));
      }
      scene.add(mesh);
      creatureMeshes.push(mesh);

      const core = new THREE.Mesh(glowPlane, makeCreatureGlowMat(CREATURE_GLOW.coreOpacity));
      const halo = new THREE.Mesh(glowPlane, makeCreatureGlowMat(CREATURE_GLOW.haloOpacity));
      for (const g of [core, halo]) {
        g.renderOrder = 2;
        g.raycast = () => {}; // 光晕不抢拾取
        scene.add(g);
      }
      core.material.color.copy(_creatureGlowCore);
      halo.material.color.copy(_creatureGlowHalo);
      creatureGlowCores.push(core);
      creatureGlowHalos.push(halo);
    }
  }

  function applyPredatorGeometry(geo) {
    const old = creatureGeo;
    const had = creatureMeshes.length;
    disposeCreatureVisuals();
    creatureGeo = geo;
    creatureUsesModel = true;
    if (creatureMat) creatureMat.dispose();
    creatureMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.48,
      metalness: 0.18,
      vertexColors: true,
      // 机身自带暗红底光，外围再叠一层 billboard 假光
      emissive: new THREE.Color('#2a0806'),
      emissiveIntensity: 0.72,
    });
    if (had > 0) buildCreatures(had);
    if (old && old !== geo) old.dispose();
  }

  loadPredatorGeometry().then((geo) => {
    applyPredatorGeometry(geo);
  }).catch((err) => {
    console.warn('[scene] predator model load failed, keeping procedural creature', err);
  });

  // flocks: the canvas fills its column, not the window. The terminal panel
  // covers the right edge of it, so the picture is centered on what is left:
  // a view offset shifts it left by half the covered width.
  function resize() {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    const covered = Math.min(w * 0.45, Number(container.dataset.coveredRight) || 0);
    // With a view offset, aspect describes the full virtual frame.
    camera.aspect = (w + covered) / h;
    if (covered > 0) camera.setViewOffset(w + covered, h, covered, 0, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  function orient(dx, dy, dz, matrix) {
    _dir.set(dx, dy, dz);
    if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1);
    _dir.normalize();
    _right.crossVectors(UP, _dir);
    if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_dir, _right).normalize();
    matrix.makeBasis(_right, _up, _dir);
  }

  function syncFlock(flock) {
    if (!flockMesh || flockMesh.count !== flock.count) buildFlockMesh(flock.count);

    // 光晕面向相机：用相机位姿做 billboard，避免加色光斑侧看成一条线
    camera.getWorldQuaternion(_q);

    // 召回完成：整群隐藏（离场）
    if (flock.departed) {
      const hide = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < flock.count; i += 1) {
        flockMesh.setMatrixAt(i, hide);
        if (glowCoreMesh) glowCoreMesh.setMatrixAt(i, hide);
        if (glowHaloMesh) glowHaloMesh.setMatrixAt(i, hide);
      }
      flockMesh.instanceMatrix.needsUpdate = true;
      if (glowCoreMesh) glowCoreMesh.instanceMatrix.needsUpdate = true;
      if (glowHaloMesh) glowHaloMesh.instanceMatrix.needsUpdate = true;
      return;
    }

    for (let i = 0; i < flock.count; i += 1) {
      const o = i * 3;
      _pos.set(flock.positions[o], flock.positions[o + 1], flock.positions[o + 2]);
      // 列阵静止时 velocity=0；用独立 heading 定向，避免默认朝向/噪声狂转
      if (flock.headings) {
        orient(flock.headings[o], flock.headings[o + 1], flock.headings[o + 2], _m);
      } else {
        orient(flock.velocities[o], flock.velocities[o + 1], flock.velocities[o + 2], _m);
      }
      _m.setPosition(_pos.x, _pos.y, _pos.z);
      flockMesh.setMatrixAt(i, _m);

      // 配色曲线而非线性：实测被传染的鱼恐慌值常在 0.2–0.5 区间，
      // 线性映射下几乎看不出变色，涟漪就白做了。sqrt 让 0.25 就已明显发赭。
      const heat = Math.min(1, Math.sqrt(Math.max(0, flock.panic[i])) * 1.15);
      _mix.copy(_calm).lerp(_afraid, heat);
      flockMesh.setColorAt(i, _mix);

      _glowMix.copy(_glowCalm).lerp(_glowPanic, heat);
      const pulse = 1 + 0.22 * heat;
      const core = AGENT.bodyLength * GLOW.coreScale * pulse;
      const halo = AGENT.bodyLength * GLOW.haloScale * pulse;

      // billboard 矩阵：旋转取相机，缩放分芯/晕，位置=机体
      _m.compose(_pos, _q, _scale.set(core, core, core));
      glowCoreMesh.setMatrixAt(i, _m);
      glowCoreMesh.setColorAt(i, _glowMix);

      _m.compose(_pos, _q, _scale.set(halo, halo, halo));
      glowHaloMesh.setMatrixAt(i, _m);
      glowHaloMesh.setColorAt(i, _glowMix);
    }

    flockMesh.instanceMatrix.needsUpdate = true;
    if (flockMesh.instanceColor) flockMesh.instanceColor.needsUpdate = true;
    glowCoreMesh.instanceMatrix.needsUpdate = true;
    glowHaloMesh.instanceMatrix.needsUpdate = true;
    if (glowCoreMesh.instanceColor) glowCoreMesh.instanceColor.needsUpdate = true;
    if (glowHaloMesh.instanceColor) glowHaloMesh.instanceColor.needsUpdate = true;
  }

  function syncCreatures(pack) {
    buildCreatures(pack.members.length);
    camera.getWorldQuaternion(_q);
    pack.members.forEach((c, i) => {
      const mesh = creatureMeshes[i];
      mesh.position.set(c.position.x, c.position.y, c.position.z);
      orient(c.velocity.x, c.velocity.y, c.velocity.z, _m);
      // 鱼身朝速度方向；光晕单独面向相机
      _bodyQ.setFromRotationMatrix(_m);
      mesh.quaternion.copy(_bodyQ);

      const core = creatureGlowCores[i];
      const halo = creatureGlowHalos[i];
      if (!core || !halo) return;
      const pulse = 1 + 0.08 * Math.sin((performance.now() * 0.001) + i * 1.7);
      const coreSize = CREATURE.bodyLength * CREATURE_GLOW.coreScale * pulse;
      const haloSize = CREATURE.bodyLength * CREATURE_GLOW.haloScale * pulse;
      core.position.copy(mesh.position);
      halo.position.copy(mesh.position);
      core.quaternion.copy(_q);
      halo.quaternion.copy(_q);
      core.scale.set(coreSize, coreSize, coreSize);
      halo.scale.set(haloSize, haloSize, haloSize);
    });
  }

  // ── 相机：总览（轨道）/ 跟随（点击个体切入，Esc 退出）──
  let followIndex = -1;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  // 返回 { kind:'agent'|'creature', index } 或 null。
  // 大型生物优先：它体积大得多，重叠时人想点的多半是它。
  function pick(clientX, clientY) {
    // 用画布自身的矩形而不是 window.innerWidth：画布未必铺满窗口，
    // 而且窗口尺寸为 0 时会除出 NaN，射线静默失效、查不出原因。
    const r = renderer.domElement.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    pointer.x = ((clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((clientY - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const cHits = raycaster.intersectObjects(creatureMeshes, false);
    if (cHits.length) {
      const idx = creatureMeshes.indexOf(cHits[0].object);
      if (idx >= 0) return { kind: 'creature', index: idx };
    }
    if (flockMesh) {
      const hits = raycaster.intersectObject(flockMesh, false);
      if (hits.length) return { kind: 'agent', index: hits[0].instanceId };
    }
    return null;
  }

  function setFollow(index) {
    followIndex = index;
    controls.enabled = index < 0;
  }

  function updateCamera(flock, dt) {
    if (followIndex < 0 || followIndex >= flock.count) {
      controls.update();
      return;
    }
    const o = followIndex * 3;
    _dir.set(flock.velocities[o], flock.velocities[o + 1], flock.velocities[o + 2]);
    if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1);
    _dir.normalize();
    _camTarget
      .set(flock.positions[o], flock.positions[o + 1], flock.positions[o + 2])
      .addScaledVector(_dir, -CAMERA.followBack)
      .addScaledVector(UP, CAMERA.followUp);
    // 指数滞后而非硬跟随，否则恐慌时的急转会把画面甩晕
    camera.position.lerp(_camTarget, 1 - Math.exp(-CAMERA.followLag * dt));
    _lookAt
      .set(flock.positions[o], flock.positions[o + 1], flock.positions[o + 2])
      .addScaledVector(_dir, 6);
    camera.lookAt(_lookAt);
  }

  // ── 画中画：大型生物的第一人称视角 ────────────────────────────
  // 同一个场景用第二个相机再渲一遍，靠 scissor 把它裁进一个 DOM 方框里。
  const previewCamera = new THREE.PerspectiveCamera(72, 1, 0.05, 900);
  const _pvFwd = new THREE.Vector3();
  const _pvEye = new THREE.Vector3();

  function renderPreview(el, creature, pilot) {
    if (!el || el.hidden || !creature) return;
    const r = el.getBoundingClientRect();
    const c = renderer.domElement.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return;

    // 朝向优先用驾驶者的视线；无人驾驶时退回它自己的速度方向
    if (pilot && pilot.active) pilot.forward(_pvFwd);
    else _pvFwd.set(creature.velocity.x, creature.velocity.y, creature.velocity.z);
    if (_pvFwd.lengthSq() < 1e-8) _pvFwd.set(0, 0, 1);
    _pvFwd.normalize();

    // 眼点稍微前移出体外，否则会看见自己身体的内壁
    _pvEye
      .set(creature.position.x, creature.position.y, creature.position.z)
      .addScaledVector(_pvFwd, CREATURE.bodyLength * 0.55);
    previewCamera.position.copy(_pvEye);
    previewCamera.lookAt(
      _pvEye.x + _pvFwd.x, _pvEye.y + _pvFwd.y, _pvEye.z + _pvFwd.z
    );
    previewCamera.aspect = r.width / r.height;
    previewCamera.updateProjectionMatrix();

    // setViewport/setScissor 收的是【逻辑像素】，three 内部会自己乘 DPR。
    // 在这里再乘一次会双重缩放，小窗会溢出主画面。
    const x = r.left - c.left;
    const y = c.bottom - r.bottom;

    const oldViewport = renderer.getViewport(new THREE.Vector4());
    const oldScissor = renderer.getScissor(new THREE.Vector4());
    const oldTest = renderer.getScissorTest();
    renderer.setViewport(x, y, r.width, r.height);
    renderer.setScissor(x, y, r.width, r.height);
    renderer.setScissorTest(true);
    renderer.clear(true, true, true);
    renderer.render(scene, previewCamera);
    renderer.setViewport(oldViewport);
    renderer.setScissor(oldScissor);
    renderer.setScissorTest(oldTest);
  }

  return {
    renderer, scene, camera, controls, obstacles,
    syncFlock, syncCreatures, updateCamera, pick, setFollow, renderPreview,
    getFollow: () => followIndex,
  };
}
