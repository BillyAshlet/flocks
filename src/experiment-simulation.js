import * as THREE from 'three';
import { SpatialPlanktonField } from './plankton-field.js';
import {
  RelationMatrix,
  SeededRng,
  SpatialHash3D,
  captureRadius,
  deriveExperiment,
  ecologyOutcome,
  effectiveMaxSpeed,
  energyCapacityFor,
  effectiveTurnSpeed,
  metabolicRate,
  planktonIntake,
  relationBetween,
  sustainedSpeedScale,
  tankVolume,
} from './experiment-model.js';
import { sceneClearance } from './distance-field.js';
import { CaptureVfx } from './capture-vfx.js';

const EPSILON = 1e-8;
const CHAMBER_EASE_RATE = 4;
const CHAMBER_STOP_EPSILON = 0.02;
const FORWARD = new THREE.Vector3(0, 0, 1);
const LOCOMOTION = Object.freeze({
  CRUISE: 0,
  BURST: 1,
  EVADE: 2,
});
const LOCOMOTION_LABEL = Object.freeze([
  'cruise',
  'burst',
  'evade',
]);

// ── 性状可读性：只影响外观，不参与任何判定 ──────────────────────────
// 三角形控制器把权重映射成系数时中段很平（w≥1/3 时 m = 0.75+0.75w），
// 拖到一半只有 ×1.1~1.2 —— 在 1.5 的基数上是 10% 的变化，肉眼分不出。
// 下面两组常数把"玩家选了什么"放大到看得见，判定继续用真实数值。
// 三个常数都可以设为关闭值，出问题直接回滚。

// 体型：视觉尺寸 = 锚点 × (真实尺寸 / 锚点) ^ γ × 全局倍率
//
// 为什么是"抬地板 + 压指数"这个组合：
//   浮游颗粒 pointSize = 0.03；鱼的视觉长度 = 0.046 × 视觉尺寸。
//   玩家把体型让给速度/耐力时真实体型 0.75，旧参数(γ=1.8)算出来的
//   视觉长度正好也是 0.030 —— 和浮游一模一样，鱼消失在食物里。
//   但只抬地板不压指数会让另一端爆炸：要让最小的鱼达到浮游 3 倍，
//   红鱼会涨到 0.65 m，而缸只有 6 m 宽。两件事必须一起做。
//
// γ<1 把两端都朝锚点收拢，最小的不消失、最大的不塞满缸；全局倍率
// 再把整体抬起来。绝对尺寸变大后，同样百分比的变化反而更容易看见
// （0.15 m 的鱼变化 20% 一眼可见，0.03 m 的看不出来）。
//
// 判定完全不受影响：捕食半径、谁吃谁、代谢、速度惩罚读的都是
// school.size；这里只改 setMatrixAt 的缩放。γ=1 且全局=1 即关闭。
// 结论：用线性（γ=1），靠【全局放大】而不是靠指数解决可见性。
//   试过 γ=1.8（放大差距）会让最小的鱼掉到浮游大小；试过 γ=0.9
//   （压缩两端）效果和线性几乎相同，却要多一个概念。线性还白拿三点：
//   ① 视觉不撒谎，看起来两倍大就是真的两倍大，比例精确保留；
//   ② "玩家拉满体型 == 大群"这个相等关系保住（指数会破坏它），
//      而那正是叙事上的高光时刻；③ 只剩一个旋钮。
//   可见性由绝对尺寸保证：0.18 m 的鱼变化 20% 一眼可见，
//   0.03 m 的看不出来 —— 所以把基准做大本身就够了。
const VISUAL_SIZE_EXPONENT = 1; // 1 = 线性。改成 ≠1 会启用非线性映射
const VISUAL_SIZE_ANCHOR = 1.5; // 仅当 γ≠1 时作为映射锚点
const VISUAL_SIZE_GLOBAL = 2.6; // ← 唯一要调的旋钮：全体视觉放大倍率

// 逐鱼群微调，在上面之后再乘。现在三群一致；要单独放大某群改这里。
const VISUAL_SIZE_BOOST = Object.freeze({
  gold: 1,
  blue: 1,
  red: 1,
});

// 耐力明度：亮度 ∝ 【还能活多久】= 当前能量 ÷ 每秒代谢。
//
// 为什么是这个量而不是代谢倍率本身：
//   耐力 → 代谢是倒数（代谢 ∝ 1/耐力），代谢 → 存活时间又是倒数
//   （时间 = 能量/代谢），两个倒数抵消，所以【存活时间与耐力系数
//   严格线性】—— 实测耐力 0.5/0.75/1.0/1.25/1.5 对应 22.6/33.9/
//   45.2/56.5/67.8 秒，比值恒为 45.18。拖一半就是一半亮度。
//
// 而直接映射代谢倍率是错的：拉满速度时代谢 ×1.01、均衡 ×1.00 —— 明度
// 纹丝不动；拉满体型却 ×2.66 大亮，可体型已经用尺寸表示了。等于明度
// 变成第二根体型条，而速度轴完全隐形。
//
// 这一个量还同时解决了"性状 vs 状态"：TUNING 时能量恒满，亮度显示的
// 是【这套选择能撑多久】；RUNNING 时能量下降，亮度就成了【现在还能
// 撑多久】。一个通道，两层含义，且都是玩家真正关心的那个数。
// 强度设 0 即关闭染色。
// 饥饿的身体语言：能量低时游速下降、队形涣散。evolution-model.js 里
// 早就写好了 energyResponse()，但它只被未接入主链路的 boids.js 调用 ——
// 也就是说现在的鱼从满能量到饿死行为完全不变，然后突然暴毙，饥饿只有
// 结果没有过程。强度 0 = 关闭（保持原行为）；1 = 完全启用。
//
// 【2026-08-19 评估结论：保持 0，暂不启用】
// 已完整接线并用 npm run test:balance 实测三档强度（基线为三关全 PASS、
// 中性与错误路线通过率均为 0%）：
//   1.00 → L1 中性选择通过率 0% → 100%（关卡完全失去鉴别力）
//   0.50 → L1 中性 80%
//   0.25 → L1 中性 40%，且"极端缩体与耐力"这条错误路线也能过 20%
// 失败方向与直觉相反：饥饿反应对【所有】鱼生效，包括捕食者。饿了的
// 捕食者追不上猎物，玩家白捡存活率，关卡整体反而变简单。0.25 档同时
// 放行中性和错误路线，说明这不是难度平移，而是往混沌系统里注入扰动、
// 把各种子结果重新洗牌 —— 不存在"轻一点就安全"的强度区间。
// 若将来要启用：必须连带重新标定三关胜利阈值（35%/75%/50%），并先决定
// 是否只对玩家鱼群生效（捕食者维持满速）。
// ⚠️ 这条改的是行为不是外观，改动后必须跑 npm run test:balance 复核。
const HUNGER_RESPONSE_STRENGTH = 0;
const HUNGER_TIRED_AT = 0.55; // 能量比低于此值开始变虚弱
const HUNGER_EXHAUSTED_AT = 0.15; // 低于此值达到最虚弱
const HUNGER_MIN_SPEED = 0.38;
const HUNGER_MIN_ALIGNMENT = 0.35;
const HUNGER_MIN_COHESION = 0.3;

const STAMINA_TINT_STRENGTH = 0.45;
const STAMINA_TINT_REFERENCE_SECONDS = 45; // 均衡选择的续航，作为亮度基准
const STAMINA_TINT_MIN = 0.35; // 濒死时最暗
const STAMINA_TINT_MAX = 1.45; // 满耐力时最亮，防止过曝

function visualSizeOf(size, schoolId) {
  const boost = (VISUAL_SIZE_BOOST[schoolId] ?? 1) * VISUAL_SIZE_GLOBAL;
  if (VISUAL_SIZE_EXPONENT === 1) return size * boost;
  const ratio = Math.max(EPSILON, size / VISUAL_SIZE_ANCHOR);
  return VISUAL_SIZE_ANCHOR * ratio ** VISUAL_SIZE_EXPONENT * boost;
}

// 能量比 → {速度, 对齐, 凝聚} 的衰减倍率。满能量时全为 1。
function hungerResponse(ratio) {
  if (HUNGER_RESPONSE_STRENGTH === 0) return null;
  const q = clamp(ratio, 0, 1);
  if (q >= HUNGER_TIRED_AT) return null;
  const span = HUNGER_TIRED_AT - HUNGER_EXHAUSTED_AT;
  const t = span > EPSILON ? clamp((q - HUNGER_EXHAUSTED_AT) / span, 0, 1) : 0;
  const awake = t * t * (3 - 2 * t); // smoothstep
  const fade = HUNGER_RESPONSE_STRENGTH * (1 - awake);
  return {
    speed: 1 - fade * (1 - HUNGER_MIN_SPEED),
    alignment: 1 - fade * (1 - HUNGER_MIN_ALIGNMENT),
    cohesion: 1 - fade * (1 - HUNGER_MIN_COHESION),
  };
}

// 还能活多久 → 亮度倍率。撑得久 = 亮，快饿死 = 暗。
function staminaTintFactor(survivalSeconds) {
  if (STAMINA_TINT_STRENGTH === 0) return 1;
  if (!Number.isFinite(survivalSeconds)) return STAMINA_TINT_MAX;
  const relative = survivalSeconds / STAMINA_TINT_REFERENCE_SECONDS;
  return clamp(
    1 + STAMINA_TINT_STRENGTH * (relative - 1),
    STAMINA_TINT_MIN,
    STAMINA_TINT_MAX
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function approach(current, target, rate, dt) {
  const alpha = 1 - Math.exp(-Math.max(0, rate) * dt);
  return current + (target - current) * alpha;
}

function normalize3(x, y, z) {
  const magnitude = Math.hypot(x, y, z);
  if (magnitude <= EPSILON) return [0, 0, 0, 0];
  return [x / magnitude, y / magnitude, z / magnitude, magnitude];
}

// 原版 boids.js 的核心：每条规则先归一化成"期望速度"，减去当前速度，
// 钳到 maxForce，之后才乘权重。实验版原来是原始量级直接加权求和 ——
// cohesion ∝ 到群心距离、alignment ∝ 速度差、separation ∝ 1/d²，
// 三者量纲不同，权重比值随密度和距离乱变。这是"不像原版"的根因。
function steerToward(dx, dy, dz, vx, vy, vz, maxSpeed, maxForce, out) {
  const length = Math.hypot(dx, dy, dz);
  if (length <= EPSILON) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return out;
  }
  const scale = maxSpeed / length;
  let sx = dx * scale - vx;
  let sy = dy * scale - vy;
  let sz = dz * scale - vz;
  const magnitude = Math.hypot(sx, sy, sz);
  if (magnitude > maxForce) {
    const clamp = maxForce / magnitude;
    sx *= clamp;
    sy *= clamp;
    sz *= clamp;
  }
  out[0] = sx;
  out[1] = sy;
  out[2] = sz;
  return out;
}

const STEER_SCRATCH = new Float64Array(3);

function add3(array, index, x, y, z) {
  const offset = index * 3;
  array[offset] += x;
  array[offset + 1] += y;
  array[offset + 2] += z;
}

function set3(array, index, x, y, z) {
  const offset = index * 3;
  array[offset] = x;
  array[offset + 1] = y;
  array[offset + 2] = z;
}

export class ExperimentSimulation {
  constructor({ scene, config, distanceField, physics }) {
    this.scene = scene;
    this.config = config;
    this.distanceField = distanceField;
    this.physics = physics;
    this.relations = new RelationMatrix();
    this.hash = new SpatialHash3D(1);
    this.hiddenFish = -1;
    this.locomotionPreview = false;
    this.captureVfx = null;
    this.planktonMesh = null;
    this.metricsState = {
      frameMs: 0,
      fps: 0,
      pairCount: 0,
      captures: 0,
      dynamicContacts: 0,
    };
    this.rebuild(config);
  }

  dispose() {
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
    if (this.planktonMesh) {
      this.planktonMesh.removeFromParent();
      this.planktonMesh.geometry.dispose();
      this.planktonMesh.material.dispose();
      this.planktonMesh = null;
    }
    this.captureVfx?.dispose();
    this.captureVfx = null;
  }

  rebuild(config = this.config) {
    this.config = config;
    this.dispose();
    this.derived = deriveExperiment(config);
    this.count = this.derived.totalCount;
    this.positions = new Float32Array(this.count * 3);
    this.velocities = new Float32Array(this.count * 3);
    this.forces = new Float32Array(this.count * 3);
    this.separation = new Float32Array(this.count * 3);
    this.cohesionSums = new Float32Array(this.count * 3);
    this.predationSums = new Float32Array(this.count * 3);
    this.alignmentSums = new Float32Array(this.count * 3);
    this.evadeForces = new Float32Array(this.count * 3);
    this.avoidanceDirections = new Float32Array(this.count * 3);
    this.schoolIds = new Uint16Array(this.count);
    this.alive = new Uint8Array(this.count);
    this.panic = new Float32Array(this.count);
    // --- 恐慌传播（惊扰波）：直接感知强度、邻居恐慌、邻居逃逸方向 ---
    this.threatLevel = new Float32Array(this.count);
    this.neighborPanic = new Float32Array(this.count);
    this.neighborEvade = new Float32Array(this.count * 3);
    // 应急对齐通道：恐慌航向不进普通 alignment 平均
    this.emergencyAlign = new Float32Array(this.count * 3);
    this.emergencyUrgency = new Float32Array(this.count);
    // 目标锁定。选目标：最近优先，距离相差在 targetTieTolerance 以内算平局，
    // 平局取最顺路。锁住之后只在三种情况下换：
    //   ① 目标离开 burstRadius → 立刻放
    //   ② giveUpSeconds 内没有追到新的最近距离 → 放弃，并排除这条鱼，
    //      直到它离开范围一次
    //   ③ 出现一条【明显】更近的（跳出平局带）→ 换过去
    // 平局带同时是防抖：两条差不多远的鱼不会让它每帧来回换。
    this.lockedTargets = new Int32Array(this.count).fill(-1);
    this.excludedTargets = new Int32Array(this.count).fill(-1);
    this.chaseBestDistance2 = new Float32Array(this.count).fill(Infinity);
    this.chaseStall = new Float32Array(this.count);
    // --- 脉冲/闩锁式恐慌（移植自 dev 分支 boids.js）---
    // 连续跟踪不会产生"惊吓"，而且社会传播没有不应期会无限回响。
    this.alarm = new Float32Array(this.count);       // 离散脉冲，指数衰减
    this.heardSignal = new Float32Array(this.count); // 本帧收到的社会信号
    this.panicHold = new Float32Array(this.count);   // 满恐慌保持计时
    this.refractory = new Float32Array(this.count);  // 不应期
    this.directLatch = new Uint8Array(this.count);   // 直接威胁闩锁（滞回）
    // 侧倾：转弯时鱼体侧过来。不改行为，但决定"像不像鱼"。
    this.rollAngles = new Float32Array(this.count);
    this.prevHeadings = new Float32Array(this.count * 3);
    this.escapeDir = new Float32Array(this.count * 3);
    this.energy = new Float32Array(this.count);
    // 每族一个能量共享池（进食所得的一部分汇入，逐帧平均分发）
    this.energyPools = new Float64Array(config.schools.length);
    // 尸体 = 鱼模型本身。1 = 浮尸（可见、灰色、上浮、可被吃），0 = 活着或已被吃掉。
    // 【孤注一掷】的三个状态。armed = 门闩：用过一次要回到恢复线才能再用。
    // 所以 armed=1 是正常，armed=0 且在计时内是「拼命」，armed=0 且计时结束
    // 是「力竭」—— 三种状态两个字节，不用额外的枚举。
    // 【炸开】的门闩：越过 panicScatterEnter 置 1，掉回 panicScatterExit
    // 以下才清 0。单一阈值会在边界来回抖，看起来像抽搐。
    this.scattering = new Uint8Array(this.count);
    this.desperation = new Uint8Array(this.count);
    this.desperationArmed = new Uint8Array(this.count);
    this.desperationUntil = new Float32Array(this.count);
    this.debt = new Float32Array(this.count);
    this.corpse = new Uint8Array(this.count);
    // 死后经过的秒数，驱动颜色渐变 / 翻身 / 上浮渐入
    this.corpseAge = new Float32Array(this.count);
    // 上一次写入的耐力明度倍率，用来跳过没有变化的 setColorAt。
    this.tintFactors = new Float32Array(this.count).fill(-1);
    this.corpseColor = new THREE.Color('#6b6f74');
    this.schoolColors = config.schools.map((sc) => new THREE.Color(sc.color));
    this.locomotionStates = new Uint8Array(this.count);
    this.wanderPhases = new Float32Array(this.count);
    this.wanderRates = new Float32Array(this.count);
    this.sameNeighbors = new Uint16Array(this.count);
    this.cohesionCounts = new Uint16Array(this.count);
    this.predationCounts = new Uint16Array(this.count);
    this.alignmentCounts = new Uint16Array(this.count);
    this.threatCounts = new Uint16Array(this.count);
    this.pursuitTargets = new Int32Array(this.count);
    this.lastPursuitTargets = new Int32Array(this.count);
    this.chaseStartTimes = new Float64Array(this.count);
    this.targetAlignment = new Float32Array(this.count);
    this.targetDistance2 = new Float32Array(this.count);
    this.schoolRanges = [];
    let cursor = 0;
    for (
      let schoolIndex = 0;
      schoolIndex < config.schools.length;
      schoolIndex += 1
    ) {
      const start = cursor;
      cursor += this.derived.schools[schoolIndex].count;
      this.schoolRanges.push({ start, end: cursor });
      this.schoolIds.fill(schoolIndex, start, cursor);
    }
    if (this.scene?.add) {
      this.captureVfx = new CaptureVfx(
        this.scene,
        this.config.captureVfx,
        this.config.starvationVfx
      );
    }
    this._buildMesh();
    this._buildPlanktonMesh();
    this.reset(config.runtime.seed);
  }

  _buildMesh() {
    if (!this.scene?.add) {
      this.mesh = null;
      return;
    }
    const radialSegments = Math.max(
      3,
      Math.round(this.config.visual.radialSegments)
    );
    const geometry = new THREE.CapsuleGeometry(
      this.config.visual.bodyRadius,
      this.config.visual.bodyLength,
      2,
      radialSegments
    );
    geometry.rotateX(Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: this.config.visual.opacity < 1,
      opacity: this.config.visual.opacity,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, this.count);
    this.mesh.name = 'experiment-fish';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let index = 0; index < this.count; index += 1) {
      const school = this.config.schools[this.schoolIds[index]];
      this.mesh.setColorAt(index, new THREE.Color(school.color));
    }
    this.mesh.instanceColor.needsUpdate = true;
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  _buildPlanktonMesh() {
    if (!this.scene?.add || this.config.plankton.visualCount <= 0) {
      this.planktonMesh = null;
      return;
    }
    const count = Math.max(
      0,
      Math.round(this.config.plankton.visualCount)
    );
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const rng = new SeededRng(
      (Number(this.config.runtime.seed) ^ 0x9e3779b9) >>> 0
    );
    const margin = this.config.tank.wallMargin;
    const half = [
      Math.max(0, this.config.tank.width / 2 - margin),
      Math.max(0, this.config.tank.height / 2 - margin),
      Math.max(0, this.config.tank.depth / 2 - margin),
    ];
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      positions[offset] = rng.range(-half[0], half[0]);
      positions[offset + 1] = rng.range(-half[1], half[1]);
      positions[offset + 2] = rng.range(-half[2], half[2]);
    }
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3)
    );
    const material = new THREE.PointsMaterial({
      color: this.config.plankton.color,
      size: this.config.plankton.pointSize,
      transparent: true,
      opacity: this.config.plankton.opacity,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.planktonMesh = new THREE.Points(geometry, material);
    this.planktonMesh.name = 'experiment-plankton';
    this.planktonMesh.frustumCulled = false;
    this.scene.add(this.planktonMesh);
  }

  reset(seed = undefined) {
    // 每局随机种子：不然初始位置、初速度、wander 相位全部相同，
    // 而模拟本身是确定性的 —— 每局都会跑出一模一样的结果。
    if (seed === undefined) {
      seed = this.config.runtime.randomizeSeed
        ? (Math.random() * 0xffffffff) >>> 0
        : this.config.runtime.seed;
    }
    this.rng = new SeededRng(seed);
    this.seed = Number(seed);
    this.config.runtime.seed = this.seed;
    this.elapsed = 0;
    this.relations.reset();
    this.relationMatrix = this.relations.update(
      this.config.schools,
      this.config.relations
    );
    this._isolateChambers();
    this.metricsState.pairCount = 0;
    this.metricsState.captures = 0;
    this.metricsState.dynamicContacts = 0;
    this.chaseTelemetry = new Map();
    this.deathCounts = this.config.schools.map(() => ({
      captured: 0,
      starved: 0,
    }));
    // 食物源。空间后端：颗粒有位置、局部枯竭、就地再生。
    this.food = new SpatialPlanktonField(
      this.config,
      this.config.runtime.seed
    );
    this.planktonConsumed = 0;
    this.ecologyStatus = { state: 'running', winnerIndex: null };
    this.captureVfx?.reset();
    this.alive.fill(1);
    this.panic.fill(0);
    this.escapeDir.fill(0);
    this.lockedTargets.fill(-1);
    this.excludedTargets.fill(-1);
    this.chaseBestDistance2.fill(Infinity);
    this.chaseStall.fill(0);
    this.alarm.fill(0);
    this.heardSignal.fill(0);
    this.panicHold.fill(0);
    this.refractory.fill(0);
    this.directLatch.fill(0);
    this.rollAngles.fill(0);
    this.prevHeadings.fill(0);
    // 初始能量必须有个体差异。原来同种族每条鱼起点完全相同，而代谢
    // 也是确定的（basalRate/size^0.75），所以第一波必然在同一秒集体饿死。
    {
      const jitter = Math.max(0, this.config.ecology.initialEnergyJitter ?? 0);
      const ratio = this.config.ecology.initialEnergyRatio;
      for (let index = 0; index < this.count; index += 1) {
        // 能量罐随体型变，所以每条鱼的上限要按它自己的鱼群算。
        const capacity = energyCapacityFor(
          this.config,
          this.config.schools[this.schoolIds[index]]
        );
        const factor = jitter > 0 ? 1 + this.rng.range(-jitter, jitter) : 1;
        this.energy[index] = Math.min(
          capacity,
          Math.max(0, capacity * ratio * factor)
        );
      }
    }
    this.energyPools.fill(0);
    this.scattering.fill(0);
    this.desperation.fill(0);
    this.desperationArmed.fill(1);
    this.desperationUntil.fill(0);
    this.debt.fill(0);
    this.corpse.fill(0);
    this.corpseAge.fill(0);
    this.locomotionStates.fill(LOCOMOTION.CRUISE);
    this.pursuitTargets.fill(-1);
    this.targetAlignment.fill(-Infinity);
    this.targetDistance2.fill(Infinity);
    this.lastPursuitTargets.fill(-1);
    this.chaseStartTimes.fill(-1);
    this.hiddenFish = -1;

    for (
      let schoolIndex = 0;
      schoolIndex < this.config.schools.length;
      schoolIndex += 1
    ) {
      const school = this.config.schools[schoolIndex];
      const range = this.schoolRanges[schoolIndex];
      const rawMode = this.config.runtime.spawnMode;
      const spawnMode =
        rawMode === 'cluster' || rawMode === 'pods' ? rawMode : 'random';
      const center = [
        school.spawnRegion.centerX * this.config.tank.width,
        school.spawnRegion.centerY * this.config.tank.height,
        school.spawnRegion.centerZ * this.config.tank.depth,
      ];
      const heading = normalize3(
        school.initialHeading.x,
        school.initialHeading.y,
        school.initialHeading.z
      );
      const wall = this.config.tank.wallMargin;
      const half = [
        this.config.tank.width / 2 - wall,
        this.config.tank.height / 2 - wall,
        this.config.tank.depth / 2 - wall,
      ];

      // --- 分群出生（fission-fusion）---
      // 一个鱼种散成若干互不相邻的小群。合并与再分裂不需要额外逻辑：
      // 只要小群内间距 < cohesionRadius、小群间距 > cohesionRadius，
      // boids 自己就会维持小群、偶遇时合并、被冲散后重组。
      let podCenters = null;
      let podRadius = 0;
      if (spawnMode === 'pods') {
        const desired = Math.max(1, Math.round(school.podCount ?? 1));
        const count = Math.max(1, range.end - range.start);
        const pods = Math.min(desired, count);
        // 小群半径必须由【每群条数】推导，不能只看 cohesionRadius：
        //   群内平均间距 = podRadius × (4π/3m)^(1/3)，要求它 ≈ k × separationRadius
        //   → podRadius = k × sepR × (3m/4π)^(1/3)
        // 太小则整群出生即互斥爆开；太大则相邻小群表面进入 cohesionRadius，
        // 开局就并成一团（这是"看不出小群"的原因）。
        const perPod = count / pods;
        podRadius =
          (this.config.perception.podSpacingFactor ?? 1.5) *
          this.derived.schools[schoolIndex].separationRadius *
          Math.cbrt((3 * perPod) / (4 * Math.PI));
        podCenters = [];
        for (let p = 0; p < pods; p += 1) {
          let best = null;
          let bestScore = -Infinity;
          // 采样若干候选，挑离已有小群最远的那个，避免开局就挤在一起
          for (let attempt = 0; attempt < 12; attempt += 1) {
            const candidate = [
              this.rng.range(-half[0] + podRadius, half[0] - podRadius),
              this.rng.range(-half[1] + podRadius, half[1] - podRadius),
              this.rng.range(-half[2] + podRadius, half[2] - podRadius),
            ];
            let nearest = Infinity;
            for (const existing of podCenters) {
              const dx = candidate[0] - existing[0];
              const dy = candidate[1] - existing[1];
              const dz = candidate[2] - existing[2];
              nearest = Math.min(nearest, dx * dx + dy * dy + dz * dz);
            }
            if (nearest > bestScore) {
              bestScore = nearest;
              best = candidate;
            }
          }
          podCenters.push(best);
        }
      }

      for (let index = range.start; index < range.end; index += 1) {
        const podCenter = podCenters
          ? podCenters[(index - range.start) % podCenters.length]
          : null;
        let spawn =
          spawnMode === 'cluster'
            ? center.slice()
            : podCenter
            ? podCenter.slice()
            : [
                this.rng.range(-half[0], half[0]),
                this.rng.range(-half[1], half[1]),
                this.rng.range(-half[2], half[2]),
              ];
        for (
          let attempt = 0;
          attempt < this.config.runtime.initialSpawnAttempts;
          attempt += 1
        ) {
          let candidate;
          if (spawnMode === 'cluster' || podCenter) {
            const point = this.rng.inUnitSphere();
            const origin = podCenter ?? center;
            const radius = podCenter ? podRadius : school.spawnRegion.radius;
            candidate = [
              clamp(origin[0] + point[0] * radius, -half[0], half[0]),
              clamp(origin[1] + point[1] * radius, -half[1], half[1]),
              clamp(origin[2] + point[2] * radius, -half[2], half[2]),
            ];
          } else {
            candidate = [
              this.rng.range(-half[0], half[0]),
              this.rng.range(-half[1], half[1]),
              this.rng.range(-half[2], half[2]),
            ];
          }
          spawn = candidate;
          if (
            sceneClearance(candidate, this.config) >
            this.derived.schools[schoolIndex].visualLength / 2
          ) {
            break;
          }
        }
        set3(
          this.positions,
          index,
          spawn[0],
          spawn[1],
          spawn[2]
        );
        let direction;
        if (spawnMode === 'cluster') {
          const jitter = this.rng.unitVector();
          // 散布太窄会让整群列队同向出发，一起撞墙。
          const spread = this.config.perception.spawnHeadingJitter ?? 0.6;
          direction = normalize3(
            heading[0] + jitter[0] * spread,
            heading[1] + jitter[1] * spread,
            heading[2] + jitter[2] * spread
          );
        } else {
          direction = this.rng.unitVector();
        }
        set3(
          this.velocities,
          index,
          direction[0] * school.cruiseSpeed,
          direction[1] * school.cruiseSpeed,
          direction[2] * school.cruiseSpeed
        );
        this.wanderPhases[index] = this.rng.range(0, Math.PI * 2);
        // 原来频率只有 index%13 共 13 档，整群会呈现可见的周期同步。
        this.wanderRates[index] = this.rng.range(0.55, 0.95);
      }
    }
    this.hash.cellSize = Math.max(EPSILON, this.derived.cellSize);
    this._syncVfxBounds();
    this._syncPlanktonVisual();
    this.updateMesh();
    return this;
  }

  setConfig(config, mode = 'live') {
    this.config = config;
    if (this.captureVfx) {
      this.captureVfx.params = config.captureVfx;
      this.captureVfx.starvationParams = config.starvationVfx;
    }
    this.derived = deriveExperiment(config);
    this.hash.cellSize = Math.max(EPSILON, this.derived.cellSize);
    this.relationMatrix = this.relations.update(
      config.schools,
      config.relations
    );
    this._isolateChambers();
    if (mode !== 'live') {
      this.reset(config.runtime.seed);
    } else {
      // live 改配置可能【翻转捕食关系】（教学关就是靠这个：拖一下滑块，
      // 上一秒还被吃、下一秒变成吃）。捕食冷却是在出生时按当时的关系算的，
    }
    if (this.mesh) {
      this.mesh.material.opacity = config.visual.opacity;
      this.mesh.material.transparent = config.visual.opacity < 1;
      // 基色只在这里重置；耐力明度由 updateMesh 每帧按实时能量叠加。
      for (let index = 0; index < this.count; index += 1) {
        this.mesh.setColorAt(
          index,
          new THREE.Color(config.schools[this.schoolIds[index]].color)
        );
      }
      this.mesh.instanceColor.needsUpdate = true;
    }
    this._syncPlanktonVisual();
  }

  setLocomotionPreview(enabled) {
    const next = Boolean(enabled);
    if (next === this.locomotionPreview) return;
    this.locomotionPreview = next;
    if (!next) return;
    this._clearGameplayInteractionState();
  }


  _clearGameplayInteractionState() {
    // TUNING is a clean, non-scoring preview. Clearing every interaction
    // latch here guarantees a previous scene can never leak panic or pursuit
    // state into the selection screen.
    this.panic.fill(0);
    this.threatLevel.fill(0);
    this.neighborPanic.fill(0);
    this.neighborEvade.fill(0);
    this.emergencyAlign.fill(0);
    this.emergencyUrgency.fill(0);
    this.evadeForces.fill(0);
    this.escapeDir.fill(0);
    this.lockedTargets.fill(-1);
    this.excludedTargets.fill(-1);
    this.chaseBestDistance2.fill(Infinity);
    this.chaseStall.fill(0);
    this.alarm.fill(0);
    this.heardSignal.fill(0);
    this.panicHold.fill(0);
    this.refractory.fill(0);
    this.directLatch.fill(0);
    this.pursuitTargets.fill(-1);
    this.lastPursuitTargets.fill(-1);
    this.chaseStartTimes.fill(-1);
    this.locomotionStates.fill(LOCOMOTION.CRUISE);
  }

  beginGameplayFromPreview() {
    const visibleMotion = {
      positions: this.positions.slice(),
      velocities: this.velocities.slice(),
      rollAngles: this.rollAngles.slice(),
      prevHeadings: this.prevHeadings.slice(),
      avoidanceDirections: this.avoidanceDirections.slice(),
    };
    this.locomotionPreview = false;
    // Reset from the submitted config so relation hysteresis
    // energy and the future ecology RNG exactly match direct balance trials.
    // Restore only visible kinematics afterward; no frame is rendered between
    // reset and restore, so Start remains spatially continuous.
    this.reset(this.config.runtime.seed);
    this.positions.set(visibleMotion.positions);
    this.velocities.set(visibleMotion.velocities);
    this.rollAngles.set(visibleMotion.rollAngles);
    this.prevHeadings.set(visibleMotion.prevHeadings);
    this.avoidanceDirections.set(visibleMotion.avoidanceDirections);
    this.updateMesh();
  }

  _syncVfxBounds() {
    this.captureVfx?.setBounds?.([
      this.config.tank.width / 2,
      this.config.tank.height / 2,
      this.config.tank.depth / 2,
    ]);
  }

  _syncPlanktonVisual() {
    if (!this.planktonMesh) return;
    const visible =
      this.config.ecology?.enabled &&
      this.config.plankton.enabled;
    this.planktonMesh.visible = visible;
    // 【点就是模型】。原来这里是按全局存量比例「显示前 N 个点」——
    // 点的位置是建场时随机撒的、永不改变，所以上缸的鱼吃东西下缸的点也会
    // 消失，而消失的是缓冲区里最靠前的那几个，和任何鱼的位置都无关。
    // 那是一根画成星星点点的进度条，画面在断言一个模型里不存在的空间食物。
    // 现在把还活着的颗粒【压实】写进缓冲区，画多少就是场里真的还剩多少。
    let visibleCount = 0;
    if (visible) {
      const array = this.planktonMesh.geometry.attributes.position.array;
      const field = this.food;
      for (let i = 0; i < field.count; i += 1) {
        if (field.uses[i] === 0) continue;
        const from = i * 3;
        const to = visibleCount * 3;
        array[to] = field.positions[from];
        array[to + 1] = field.positions[from + 1];
        array[to + 2] = field.positions[from + 2];
        visibleCount += 1;
      }
      this.planktonMesh.geometry.attributes.position.needsUpdate = true;
    }
    this.planktonMesh.geometry.setDrawRange(0, visibleCount);
    this.planktonMesh.material.size = this.config.plankton.pointSize;
    this.planktonMesh.material.opacity = this.config.plankton.opacity;
    this.planktonMesh.material.color.set(this.config.plankton.color);
  }

  _clearAccumulators() {
    this.forces.fill(0);
    this.separation.fill(0);
    this.cohesionSums.fill(0);
    this.predationSums.fill(0);
    this.alignmentSums.fill(0);
    this.evadeForces.fill(0);
    this.sameNeighbors.fill(0);
    this.cohesionCounts.fill(0);
    this.predationCounts.fill(0);
    this.alignmentCounts.fill(0);
    this.threatCounts.fill(0);
    this.threatLevel.fill(0);
    this.neighborPanic.fill(0);
    this.heardSignal.fill(0);
    this.neighborEvade.fill(0);
    this.emergencyAlign.fill(0);
    this.emergencyUrgency.fill(0);
    this.pursuitTargets.fill(-1);
    this.targetAlignment.fill(-Infinity);
    this.targetDistance2.fill(Infinity);
    this.metricsState.pairCount = 0;
    this.metricsState.dynamicContacts = 0;
  }

  _telemetryFor(actorSchool, targetSchool) {
    const key = `${actorSchool}>${targetSchool}`;
    let record = this.chaseTelemetry.get(key);
    if (!record) {
      record = {
        starts: 0,
        pursuitFrames: 0,
        captures: 0,
        abandoned: 0,
        active: 0,
        completedDuration: 0,
        capturedDuration: 0,
        burstSeconds: 0,
      };
      this.chaseTelemetry.set(key, record);
    }
    return record;
  }

  _finishChase(predator, prey, captured) {
    if (prey < 0 || this.chaseStartTimes[predator] < 0) return;
    const actorSchool = this.schoolIds[predator];
    const targetSchool = this.schoolIds[prey];
    const record = this._telemetryFor(actorSchool, targetSchool);
    const duration = Math.max(
      0,
      this.elapsed - this.chaseStartTimes[predator]
    );
    record.completedDuration += duration;
    if (captured) {
      record.captures += 1;
      record.capturedDuration += duration;
    } else {
      record.abandoned += 1;
    }
    this.lastPursuitTargets[predator] = -1;
    this.chaseStartTimes[predator] = -1;
  }

  _updateChaseTelemetry(dt) {
    for (const record of this.chaseTelemetry.values()) record.active = 0;
    for (let predator = 0; predator < this.count; predator += 1) {
      if (!this.alive[predator]) {
        this._finishChase(
          predator,
          this.lastPursuitTargets[predator],
          false
        );
        continue;
      }
      const next = this.pursuitTargets[predator];
      const previous = this.lastPursuitTargets[predator];
      if (next !== previous) {
        this._finishChase(predator, previous, false);
        if (next >= 0 && this.alive[next]) {
          const actorSchool = this.schoolIds[predator];
          const targetSchool = this.schoolIds[next];
          const record = this._telemetryFor(actorSchool, targetSchool);
          record.starts += 1;
          this.lastPursuitTargets[predator] = next;
          this.chaseStartTimes[predator] = this.elapsed;
        }
      }
      const activeTarget = this.lastPursuitTargets[predator];
      if (activeTarget < 0 || !this.alive[activeTarget]) continue;
      const record = this._telemetryFor(
        this.schoolIds[predator],
        this.schoolIds[activeTarget]
      );
      record.active += 1;
      record.pursuitFrames += 1;
      if (this.locomotionStates[predator] === LOCOMOTION.BURST) {
        record.burstSeconds += dt;
      }
    }
  }

  _sameSchoolPair(
    i,
    j,
    dx,
    dy,
    dz,
    distance2,
    interactionsEnabled = true
  ) {
    const schoolIndex = this.schoolIds[i];
    const derived = this.derived.schools[schoolIndex];
    const perception = this.config.perception;
    const relations = this.config.relations;

    // --- 视锥：只门控 alignment / cohesion，separation 保持全向 ---
    // 前向视锥打破配对对称性 → 方向信息必须逐层传播，而不是瞬间同步。
    // 这是"像鱼群"而不是"像一坨粒子"的主要来源。
    let seeIJ = true;
    let seeJI = true;
    if (perception.fovDegrees < 360) {
      const cosHalf = Math.cos((perception.fovDegrees * Math.PI) / 360);
      const inverse = 1 / Math.sqrt(Math.max(distance2, EPSILON));
      const io = i * 3;
      const jo = j * 3;
      const hi = normalize3(
        this.velocities[io],
        this.velocities[io + 1],
        this.velocities[io + 2]
      );
      const hj = normalize3(
        this.velocities[jo],
        this.velocities[jo + 1],
        this.velocities[jo + 2]
      );
      seeIJ = (dx * hi[0] + dy * hi[1] + dz * hi[2]) * inverse >= cosHalf;
      seeJI = (-dx * hj[0] - dy * hj[1] - dz * hj[2]) * inverse >= cosHalf;
    }

    // --- 应急对齐：恐慌航向走独立通道 ---
    const signalRadius = derived.alignmentRadius * relations.signalRadiusFactor;
    const signalRadius2 = signalRadius * signalRadius;
    const emitEmergency = (receiver, sender, canSee) => {
      if (!canSee || distance2 >= signalRadius2) return false;
      const urgency = this.panic[sender];
      if (urgency < relations.signalThreshold) return false;
      const distance = Math.sqrt(Math.max(distance2, EPSILON));
      const proximity = 1 - distance / signalRadius;
      const boost = relations.alignmentSourceBoost;
      const weight = proximity * urgency * (1 + boost * urgency * urgency);
      if (weight <= 1e-6) return false;
      const so = sender * 3;
      const heading = normalize3(
        this.velocities[so],
        this.velocities[so + 1],
        this.velocities[so + 2]
      );
      add3(
        this.emergencyAlign,
        receiver,
        heading[0] * weight,
        heading[1] * weight,
        heading[2] * weight
      );
      const urgencySignal = proximity * urgency;
      if (urgencySignal > this.emergencyUrgency[receiver]) {
        this.emergencyUrgency[receiver] = urgencySignal;
      }
      return true;
    };
    const emergencyIJ = interactionsEnabled
      ? emitEmergency(i, j, seeIJ)
      : false;
    const emergencyJI = interactionsEnabled
      ? emitEmergency(j, i, seeJI)
      : false;

    if (distance2 <= derived.cohesionRadius ** 2) {
      this.sameNeighbors[i] += 1;
      this.sameNeighbors[j] += 1;
      // 惊扰波：恐慌与逃逸方向沿邻居链传播（读的是上一帧的值）。
      // 同样走视锥 —— 波因此有方向性，而不是向四面八方瞬间铺开。
      const jo3 = j * 3;
      const io3 = i * 3;
      if (interactionsEnabled && seeIJ) {
        // 社会信号传的是 alarm【脉冲】，不是 panic 值 —— 脉冲会衰减到零，
        // 不会像连续值那样在鱼群里无限回响。
        const signal =
          this.alarm[j] * (1 - Math.sqrt(distance2) / derived.cohesionRadius);
        if (signal > this.heardSignal[i]) this.heardSignal[i] = signal;
        if (this.panic[j] > this.neighborPanic[i]) {
          this.neighborPanic[i] = this.panic[j];
        }
        add3(
          this.neighborEvade,
          i,
          this.escapeDir[jo3],
          this.escapeDir[jo3 + 1],
          this.escapeDir[jo3 + 2]
        );
      }
      if (interactionsEnabled && seeJI) {
        const signalBack =
          this.alarm[i] * (1 - Math.sqrt(distance2) / derived.cohesionRadius);
        if (signalBack > this.heardSignal[j]) this.heardSignal[j] = signalBack;
        if (this.panic[i] > this.neighborPanic[j]) {
          this.neighborPanic[j] = this.panic[i];
        }
        add3(
          this.neighborEvade,
          j,
          this.escapeDir[io3],
          this.escapeDir[io3 + 1],
          this.escapeDir[io3 + 2]
        );
      }
      // cohesion 权重：'inverse' 时按 1/(d²+ε) 加权。
      // 这是拓扑式交互的廉价近似（Ballerini 等人发现椋鸟只跟约 7 个最近邻
      // 互动，与距离无关）。效果是每条鱼被【自己所在的小群】主导，
      // 远处的另一个小群拉不动它 —— 小群才能维持，而不是一碰就并成一团。
      let cohW = 1;
      if (perception.cohesionFalloff === 'inverse') {
        const soft = derived.cohesionRadius * 0.15;
        cohW = 1 / (distance2 + soft * soft);
      }
      if (seeIJ) {
        this.cohesionCounts[i] += cohW;
        add3(
          this.cohesionSums,
          i,
          this.positions[j * 3] * cohW,
          this.positions[j * 3 + 1] * cohW,
          this.positions[j * 3 + 2] * cohW
        );
      }
      if (seeJI) {
        this.cohesionCounts[j] += cohW;
        add3(
          this.cohesionSums,
          j,
          this.positions[i * 3] * cohW,
          this.positions[i * 3 + 1] * cohW,
          this.positions[i * 3 + 2] * cohW
        );
      }
    }
    if (distance2 <= derived.alignmentRadius ** 2) {
      if (seeIJ && !emergencyIJ) {
        this.alignmentCounts[i] += 1;
        add3(
          this.alignmentSums,
          i,
          this.velocities[j * 3],
          this.velocities[j * 3 + 1],
          this.velocities[j * 3 + 2]
        );
      }
      if (seeJI && !emergencyJI) {
        this.alignmentCounts[j] += 1;
        add3(
          this.alignmentSums,
          j,
          this.velocities[i * 3],
          this.velocities[i * 3 + 1],
          this.velocities[i * 3 + 2]
        );
      }
    }
    if (distance2 <= derived.separationRadius ** 2) {
      // Identical positions produce 0 * Infinity = NaN; skip or floor distance.
      if (distance2 <= EPSILON) {
        // Deterministic tiny push so overlapping agents do not poison forces.
        const push = 1 / EPSILON;
        add3(this.separation, i, -push, 0, 0);
        add3(this.separation, j, push, 0, 0);
      } else {
        const distance = Math.sqrt(distance2);
        const radius = derived.separationRadius;
        // 原版默认 inverse：近距离斥力远强于线性，鱼群能压得很紧而不穿模
        let scale;
        if (perception.separationFalloff === 'linear') {
          scale = (radius - distance) / (radius * distance);
        } else if (perception.separationFalloff === 'invlog') {
          scale = Math.log(radius / distance) / distance;
        } else {
          scale = 1 / distance2;
        }
        add3(this.separation, i, -dx * scale, -dy * scale, -dz * scale);
        add3(this.separation, j, dx * scale, dy * scale, dz * scale);
      }
    }
  }

  _crossSchoolPair(
    i,
    j,
    dx,
    dy,
    dz,
    distance2,
    interactionsEnabled = true
  ) {
    const schoolI = this.schoolIds[i];
    const schoolJ = this.schoolIds[j];
    const configSchoolI = this.config.schools[schoolI];
    const configSchoolJ = this.config.schools[schoolJ];
    const distance = Math.sqrt(Math.max(EPSILON, distance2));
    const crossRadius =
      this.config.perception.crossSeparationScale *
      Math.max(configSchoolI.size, configSchoolJ.size);
    if (distance < crossRadius) {
      const strength = 1 - distance / crossRadius;
      const scale = strength / distance;
      add3(this.separation, i, -dx * scale, -dy * scale, -dz * scale);
      add3(this.separation, j, dx * scale, dy * scale, dz * scale);
    }

    if (interactionsEnabled) {
      this._directedRelation(i, j, dx, dy, dz, distance, distance2);
      this._directedRelation(j, i, -dx, -dy, -dz, distance, distance2);
    }
  }

  _directedRelation(
    actor,
    target,
    dx,
    dy,
    dz,
    distance,
    distance2
  ) {
    const actorSchool = this.schoolIds[actor];
    const targetSchool = this.schoolIds[target];
    const relation = this.relationMatrix[actorSchool][targetSchool];
    if (relation !== 'pursuit') return;
    const actorDetection =
      this.derived.schools[actorSchool].detectionLength;
    // 第一层：远距离朝猎物群质心巡航。独立捕食者版本用的是
    // schoolSenseRadius 1.0，比 detectionLength 大 6 倍 —— 所以它会从很远
    // 处平滑靠拢，而不是贴近了才猛窜。
    const senseRadius =
      actorDetection * this.config.relations.schoolSenseFactor;
    if (distance2 <= senseRadius * senseRadius) {
      add3(
        this.predationSums,
        actor,
        this.positions[target * 3],
        this.positions[target * 3 + 1],
        this.positions[target * 3 + 2]
      );
      this.predationCounts[actor] += 1;
    }

    const burstRadius =
      actorDetection * this.config.relations.burstRadiusFactor;
    if (distance2 <= burstRadius * burstRadius) {
      const actorOffset = actor * 3;
      const speed = normalize3(
        this.velocities[actorOffset],
        this.velocities[actorOffset + 1],
        this.velocities[actorOffset + 2]
      );
      const inverseDistance = 1 / Math.max(distance, EPSILON);
      const alignment =
        speed[0] * dx * inverseDistance +
        speed[1] * dy * inverseDistance +
        speed[2] * dz * inverseDistance;
      // 最近优先；相差在 targetTieTolerance 以内算平局，平局取最顺路。
      // 放弃过的那条，在它离开范围之前不参选。
      if (
        target !== this.excludedTargets[actor] &&
        this._preferCandidate(
          distance2,
          alignment,
          this.targetDistance2[actor],
          this.targetAlignment[actor]
        )
      ) {
        this.pursuitTargets[actor] = target;
        this.targetAlignment[actor] = alignment;
        this.targetDistance2[actor] = distance2;
      }
    }

    // directThreat belongs to the prey and is proximity-driven. It does
    // not care whether this predator won target selection or is cooling down.
    const preyDetection =
      this.derived.schools[targetSchool].panicRadius;
    if (distance2 <= preyDetection * preyDetection) {
      this.threatCounts[target] += 1;
      // 距离衰减：贴脸的捕食者和边缘的捕食者不该产生同样的恐慌。
      // 没有这一条，小缸里所有鱼永远处于满恐慌。
      const proximity = 1 - distance / Math.max(preyDetection, EPSILON);
      if (proximity > this.threatLevel[target]) {
        this.threatLevel[target] = proximity;
      }
      // 逃向捕食者【预测位置】的反方向，而不是它此刻在哪
      const lead = this.config.relations.escapePredictionTime;
      const ao = actor * 3;
      // dx 由 actor(捕食者) 指向 target(猎物)。捕食者前进 vel*lead 之后，
      // 从它的未来位置指向猎物的向量 = dx − vel*lead。
      const px = dx - this.velocities[ao] * lead;
      const py = dy - this.velocities[ao + 1] * lead;
      const pz = dz - this.velocities[ao + 2] * lead;
      const inverse = 1 / Math.max(Math.hypot(px, py, pz), EPSILON);
      const awayX = px * inverse;
      const awayY = py * inverse;
      const awayZ = pz * inverse;
      const velocityOffset = target * 3;
      const lateral = normalize3(
        this.velocities[velocityOffset + 1] * awayZ -
          this.velocities[velocityOffset + 2] * awayY,
        this.velocities[velocityOffset + 2] * awayX -
          this.velocities[velocityOffset] * awayZ,
        this.velocities[velocityOffset] * awayY -
          this.velocities[velocityOffset + 1] * awayX
      );
      add3(
        this.evadeForces,
        target,
        awayX +
          lateral[0] * this.config.relations.evadeLateralWeight,
        awayY +
          lateral[1] * this.config.relations.evadeLateralWeight,
        awayZ +
          lateral[2] * this.config.relations.evadeLateralWeight
      );
    }
  }

  _pairPasses(interactionsEnabled = true) {
    this.hash.forEachPair((i, j) => {
      this.metricsState.pairCount += 1;
      const io = i * 3;
      const jo = j * 3;
      const dx = this.positions[jo] - this.positions[io];
      const dy = this.positions[jo + 1] - this.positions[io + 1];
      const dz = this.positions[jo + 2] - this.positions[io + 2];
      const distance2 = dx * dx + dy * dy + dz * dz;
      if (this.schoolIds[i] === this.schoolIds[j]) {
        this._sameSchoolPair(
          i,
          j,
          dx,
          dy,
          dz,
          distance2,
          interactionsEnabled
        );
      }
    });
    this.hash.forEachPair((i, j) => {
      if (this.schoolIds[i] === this.schoolIds[j]) return;
      const io = i * 3;
      const jo = j * 3;
      const dx = this.positions[jo] - this.positions[io];
      const dy = this.positions[jo + 1] - this.positions[io + 1];
      const dz = this.positions[jo + 2] - this.positions[io + 2];
      const distance2 = dx * dx + dy * dy + dz * dz;
      this._crossSchoolPair(
        i,
        j,
        dx,
        dy,
        dz,
        distance2,
        interactionsEnabled
      );
    });
  }

  _boundaryForce(index) {
    const offset = index * 3;
    const half = [
      this.config.tank.width / 2,
      this.config.tank.height / 2,
      this.config.tank.depth / 2,
    ];
    const softness = this.config.tank.edgeSoftness;
    const force = [0, 0, 0];
    for (let axis = 0; axis < 3; axis += 1) {
      const value = this.positions[offset + axis];
      const negativeDistance = value + half[axis];
      const positiveDistance = half[axis] - value;
      if (negativeDistance < softness) {
        force[axis] += 1 - negativeDistance / softness;
      }
      if (positiveDistance < softness) {
        force[axis] -= 1 - positiveDistance / softness;
      }
    }
    return force;
  }

  _energyRatio(index) {
    const capacity = Math.max(
      EPSILON,
      energyCapacityFor(this.config, this.config.schools[this.schoolIds[index]])
    );
    return this.energy[index] / capacity;
  }

  _canBurst(index) {
    if (!this.config.ecology?.enabled) return true;
    // 【拼命时无视能量门槛】。这是这条机制存在的首要理由：原来能量掉到
    // 1/3 以下就再也不扑，于是「冲不动 → 抓不到 → 更饿」是个死锁。
    if (this.desperation[index]) return true;
    const minRatio = Number.isFinite(this.config.ecology.minBurstEnergyRatio)
      ? this.config.ecology.minBurstEnergyRatio
      : 1 / 3;
    return this._energyRatio(index) >= minRatio;
  }

  /**
   * 拼命 → 【只加追击速度】；力竭 → 全局减速。
   *
   * 加速必须限定在 BURST：不然逃跑的鱼也一起变快，猎物和捕食者同时提速，
   * 净效果是【大鱼反而追不上小鱼】—— 那正好和这条机制的目的相反。
   * 力竭则是真的虚弱，全局生效。
   */
  _desperationSpeedScale(index, state) {
    if (!this.config.ecology?.enabled) return 1;
    if (this.desperation[index]) {
      return state === 'burst'
        ? Math.max(1, this.config.ecology.desperationSpeedBoost ?? 1)
        : 1;
    }
    // armed=0 且不在计时内 = 用完了还没缓过来 = 力竭。
    if (!this.desperationArmed[index]) {
      return Math.max(
        0.05,
        this.config.ecology.desperationExhaustedSpeed ?? 1
      );
    }
    return 1;
  }

  _movementState(index, target, threatened) {
    const state =
      target >= 0 && this.alive[target] && this._canBurst(index)
        ? 'burst'
        : threatened
          ? 'evade'
          : 'cruise';
    this.locomotionStates[index] =
      state === 'burst'
        ? LOCOMOTION.BURST
        : state === 'evade'
          ? LOCOMOTION.EVADE
          : LOCOMOTION.CRUISE;
    return state;
  }

  // 候选比较：最近优先；两者距离相差不超过较远那条的 targetTieTolerance
  // 算平局，平局取更顺路（alignment 大）的，仍相同取更近的。
  _preferCandidate(distance2, alignment, bestDistance2, bestAlignment) {
    if (!(bestDistance2 < Infinity)) return true;
    if (!this._withinTieBand(distance2, bestDistance2)) {
      return distance2 < bestDistance2;
    }
    if (alignment !== bestAlignment) return alignment > bestAlignment;
    return distance2 < bestDistance2;
  }

  _withinTieBand(distanceA2, distanceB2) {
    const a = Math.sqrt(distanceA2);
    const b = Math.sqrt(distanceB2);
    return (
      Math.abs(a - b) <=
      this.config.relations.targetTieTolerance * Math.max(a, b)
    );
  }

  _distance2(a, b) {
    const ao = a * 3;
    const bo = b * 3;
    const dx = this.positions[bo] - this.positions[ao];
    const dy = this.positions[bo + 1] - this.positions[ao + 1];
    const dz = this.positions[bo + 2] - this.positions[ao + 2];
    return dx * dx + dy * dy + dz * dz;
  }

  _resolveLock(index, dt) {
    const relations = this.config.relations;
    const detection =
      this.derived.schools[this.schoolIds[index]].detectionLength;
    const burstRadius = detection * relations.burstRadiusFactor;
    const range2 = burstRadius * burstRadius;

    // 放弃过的那条：死了、或者离开范围一次，就解除排除。
    const excluded = this.excludedTargets[index];
    if (
      excluded >= 0 &&
      (!this.alive[excluded] || this._distance2(index, excluded) > range2)
    ) {
      this.excludedTargets[index] = -1;
    }

    const previous = this.lockedTargets[index];
    let next = -1;
    let previousDistance2 = Infinity;
    if (previous >= 0 && this.alive[previous]) {
      previousDistance2 = this._distance2(index, previous);
      // ① 出范围 → 不保留
      if (previousDistance2 <= range2) {
        // ② 追不上：giveUpSeconds 内没有追到新的最近距离
        if (previousDistance2 < this.chaseBestDistance2[index]) {
          this.chaseBestDistance2[index] = previousDistance2;
          this.chaseStall[index] = 0;
          next = previous;
        } else {
          this.chaseStall[index] += dt;
          if (this.chaseStall[index] >= relations.giveUpSeconds) {
            this.excludedTargets[index] = previous;
          } else {
            next = previous;
          }
        }
      }
    }

    // 本帧最佳候选（_directedRelation 已按最近优先选出、跳过了排除的那条）。
    // 没有锁 → 直接用；有锁 → ③ 只在它【明显】更近（跳出平局带）时换。
    const fresh = this.pursuitTargets[index];
    if (
      fresh >= 0 &&
      fresh !== next &&
      this.alive[fresh] &&
      fresh !== this.excludedTargets[index]
    ) {
      const freshDistance2 = this._distance2(index, fresh);
      if (
        next < 0 ||
        (freshDistance2 < previousDistance2 &&
          !this._withinTieBand(freshDistance2, previousDistance2))
      ) {
        next = fresh;
      }
    }

    if (next !== previous) {
      this.chaseBestDistance2[index] =
        next >= 0 ? this._distance2(index, next) : Infinity;
      this.chaseStall[index] = 0;
    }
    this.lockedTargets[index] = next;
    this.pursuitTargets[index] = next;
  }

  _steerFish(index, dt, interactionsEnabled = true) {
    if (this._isFrozen(index)) return;
    if (!this.alive[index]) return;
    if (interactionsEnabled) this._resolveLock(index, dt);
    const offset = index * 3;
    const schoolIndex = this.schoolIds[index];
    const school = this.config.schools[schoolIndex];
    const cohesionCount = this.cohesionCounts[index];
    const alignmentCount = this.alignmentCounts[index];

    // --- 恐慌：先算，因为它要放大 alignment / cohesion ---
    // 自己看见的（连续，按距离衰减） vs 从邻居继承的（惊扰波）
    const relations = this.config.relations;
    // --- 脉冲/闩锁式恐慌 ---
    // 直接威胁走滞回：越过 directOn 才闩上，掉到 directOff 以下才松开。
    let panic = 0;
    if (interactionsEnabled) {
      const threat = this.threatLevel[index];
      const wasLatched = this.directLatch[index] === 1;
      if (!wasLatched && threat >= relations.directOn) {
        this.directLatch[index] = 1;
      } else if (wasLatched && threat < relations.directOff) {
        this.directLatch[index] = 0;
      }
      const latched = this.directLatch[index] === 1;
      const enteredDirect = latched && !wasLatched;

      this.panicHold[index] = Math.max(0, this.panicHold[index] - dt);
      this.refractory[index] = Math.max(0, this.refractory[index] - dt);

      // 社会触发：收到的脉冲够强、自己没被直接威胁闩住、且不在不应期内。
      // 不应期是关键 —— 没有它，脉冲会在鱼群里来回反射永不停止。
      let emitPulse = enteredDirect;
      if (
        !latched &&
        this.heardSignal[index] >= relations.signalThreshold &&
        this.refractory[index] <= 0
      ) {
        emitPulse = true;
        this.refractory[index] = relations.refractoryTime;
      }
      if (emitPulse) this.panicHold[index] = relations.holdTime;
      if (enteredDirect) {
        this.refractory[index] = Math.max(
          this.refractory[index],
          relations.refractoryTime
        );
      }

      // 惊吓期间恐慌被【钉在满值】，这才有四散而逃
      const panicTarget = Math.max(
        latched ? threat : 0,
        this.panicHold[index] > 0 ? 1 : 0
      );
      const rising = panicTarget > this.panic[index];
      this.panic[index] = approach(
        this.panic[index],
        panicTarget,
        rising ? relations.panicRiseRate : relations.panicDecayRate,
        dt
      );
      this.alarm[index] = emitPulse
        ? 1
        : this.alarm[index] *
          Math.exp(-dt / Math.max(relations.signalDecayTime, 1e-6));
      panic = this.panic[index];
    }
    // 【炸开门闩】。越过 enter 进高段，掉回 exit 以下才回低段 ——
    // 单一阈值会在边界来回抖。
    if (interactionsEnabled) {
      const enter = relations.panicScatterEnter ?? 1;
      const exit = relations.panicScatterExit ?? 0;
      if (this.scattering[index]) {
        if (panic <= exit) this.scattering[index] = 0;
      } else if (panic >= enter) {
        this.scattering[index] = 1;
      }
    } else {
      this.scattering[index] = 0;
    }

    // 受惊时凝聚力下降 —— flash expansion（原版验证过的方向）。
    // 同步不靠放大 alignmentWeight，而靠下面独立的应急对齐通道。
    // 冲刺时压低社交权重（而不是把追击力放大 10 倍）。捕食者会"脱队扑食"，
    // 但整体力量级不变，运动仍然平滑；松开后自己归队。
    const lockedOn =
      interactionsEnabled &&
      this.pursuitTargets[index] >= 0 && this.alive[this.pursuitTargets[index]];
    const socialScale = lockedOn
      ? this.config.locomotion.burstSocialSuppression
      : 1;
    // 【删掉了「体型→独行」】(perception.socialSizeExponent)。它是第三条
    // 体型耦合，而三轴语义里只有「体型大 → 速度、耐力降」。留着就得把
    // 「更独来独往」也写进语义，那会让「体型」变成四件事 —— 而每多一条
    // 隐藏耦合，平衡就多一个没人知道来源的维度。
    // 饿了就散：对齐与凝聚随能量下降而衰减
    const hunger = hungerResponse(this._energyRatio(index));
    // 高段【内聚整个归零】，不只是按 cohesionDrop 打折 —— 那才是"各逃各的"。
    const cohesionWeight =
      school.cohesionWeight *
      (this.scattering[index]
        ? 0
        : Math.max(0, 1 - panic * relations.cohesionDrop)) *
      socialScale *
      (hunger ? hunger.cohesion : 1);
    // 接收方增益：自己越慌，越会去听邻居 —— 波才能一层层推下去
    const receiverBoost = interactionsEnabled
      ? Math.min(
          1 + relations.alignmentReceiverBoost * this.neighborPanic[index],
          relations.alignmentReceiverMax
        )
      : 1;
    const alignmentWeight =
      school.alignmentWeight *
      receiverBoost *
      socialScale *
      (hunger ? hunger.alignment : 1);

    const vx = this.velocities[offset];
    const vy = this.velocities[offset + 1];
    const vz = this.velocities[offset + 2];
    const ruleMaxSpeed = school.maxSpeed;
    const ruleMaxForce = this.config.locomotion.maxForce;
    let fx = 0;
    let fy = 0;
    let fz = 0;
    const applyRule = (dxr, dyr, dzr, weight) => {
      if (weight === 0) return;
      steerToward(
        dxr,
        dyr,
        dzr,
        vx,
        vy,
        vz,
        ruleMaxSpeed,
        ruleMaxForce,
        STEER_SCRATCH
      );
      fx += STEER_SCRATCH[0] * weight;
      fy += STEER_SCRATCH[1] * weight;
      fz += STEER_SCRATCH[2] * weight;
    };

    // 分离在恐慌时用更高的 safetySpeed —— 逃窜中互相让位的力更强
    const safetySpeed = ruleMaxSpeed * (1 + 0.25 * panic);
    steerToward(
      this.separation[offset],
      this.separation[offset + 1],
      this.separation[offset + 2],
      vx,
      vy,
      vz,
      safetySpeed,
      ruleMaxForce,
      STEER_SCRATCH
    );
    fx += STEER_SCRATCH[0] * school.separationWeight;
    fy += STEER_SCRATCH[1] * school.separationWeight;
    fz += STEER_SCRATCH[2] * school.separationWeight;
    if (cohesionCount > 0) {
      applyRule(
        this.cohesionSums[offset] / cohesionCount - this.positions[offset],
        this.cohesionSums[offset + 1] / cohesionCount -
          this.positions[offset + 1],
        this.cohesionSums[offset + 2] / cohesionCount -
          this.positions[offset + 2],
        cohesionWeight
      );
    }
    if (alignmentCount > 0) {
      applyRule(
        this.alignmentSums[offset] / alignmentCount,
        this.alignmentSums[offset + 1] / alignmentCount,
        this.alignmentSums[offset + 2] / alignmentCount,
        alignmentWeight
      );
    }

    // 逃逸方向：自己看见了就用自己的，没看见就用邻居传来的。
    // 这样没看见捕食者的鱼也会跟着整群一起转向。
    // 原版设计声明：只有【直接】感知到捕食者的鱼才获得几何逃逸向量。
    // 社会性恐慌的鱼只知道邻居的航向，不知道捕食者的位置 —— 否则等于全知。
    const ex = this.evadeForces[offset];
    const ey = this.evadeForces[offset + 1];
    const ez = this.evadeForces[offset + 2];
    const escapeMagnitude = Math.hypot(ex, ey, ez);
    if (escapeMagnitude > EPSILON) {
      const inverseEscape = 1 / escapeMagnitude;
      this.escapeDir[offset] = ex * inverseEscape;
      this.escapeDir[offset + 1] = ey * inverseEscape;
      this.escapeDir[offset + 2] = ez * inverseEscape;
    } else {
      this.escapeDir[offset] = 0;
      this.escapeDir[offset + 1] = 0;
      this.escapeDir[offset + 2] = 0;
    }
    // 应急对齐：一条鱼看见危险，它的航向会压过二十条镇定邻居的平均值。
    // 这是惊扰波真正的载体。
    // 【高段就不再一致了】。炸开的时候关掉应急对齐 —— 否则它会把想散开的
    // 鱼一直拽回同一个方向，"各逃各的"永远出不来。
    if (
      interactionsEnabled &&
      this.emergencyUrgency[index] > 0 &&
      !this.scattering[index]
    ) {
      const emergency = normalize3(
        this.emergencyAlign[offset],
        this.emergencyAlign[offset + 1],
        this.emergencyAlign[offset + 2]
      );
      applyRule(
        emergency[0],
        emergency[1],
        emergency[2],
        relations.emergencyAlignmentWeight * this.emergencyUrgency[index]
      );
    }

    // 逃逸强度随恐慌连续变化，不再是"看见/没看见"的开关
    const directThreat = interactionsEnabled
      ? this.threatLevel[index]
      : 0;
    const threatened =
      interactionsEnabled && panic > relations.panicMinTrigger;
    if (directThreat > 0) {
      applyRule(
        this.escapeDir[offset],
        this.escapeDir[offset + 1],
        this.escapeDir[offset + 2],
        relations.evadeWeight * directThreat
      );
    }

    const localPredationCount = interactionsEnabled
      ? this.predationCounts[index]
      : 0;
    // 【锁定成功之后第一层退场】。
    //
    // 两条捕食力的分工本来是「远距离朝猎物群质心靠拢」和「近距离扑锁定的
    // 那一条」。但它们一直叠着施加：锁定的猎物在鱼群边缘时，质心力往【群
    // 中心】拽、冲刺力往【那一条】拽，1.05 : 2.2 这个比例足够把冲刺方向
    // 拽偏、又不足以主导 —— 合力斜着插进两者中间的空处。
    // 那就是"捕食时转向很奇怪"的来源。
    //
    // 【有锁定就退场，和能不能冲刺无关】。
    //
    // 捕食判定里【没有】冲刺这一项：只要锁定的那条进入捕食半径、冷却为 0，
    // 就吃得到 —— 一条冲不动的鱼，猎物游到嘴边照样能吃。所以"能量不够就
    // 保留质心力"是把两件独立的事绑在了一起。
    //
    // 而且一旦锁定，目标就已经确定了，再往【猎物群质心】拉只会把它从
    // 要吃的那一条身上拽开。
    // ── 捕食转向：两种状态，【互斥】────────────────────────────────
    //
    //   LOCKED   锁定了一条 → 只朝那一条
    //   SCAN     没锁定     → 朝感知范围内猎物群的质心（远距离靠拢）
    //
    // 两者【任何时刻只有一个生效】。同时施加时，锁定的猎物在鱼群边缘会让
    // 两个方向打架：质心力往群中心拽、目标力往那一条拽，合力斜插进中间的
    // 空处 —— 那就是"捕食时转向很奇怪"的来源。
    //
    // 权重是同一个 pursuitWeight，只有【方向】随状态切换。冲刺力（burst）
    // 在能量够时叠加在上面，它不属于这个二选一。
    const lockedTarget = interactionsEnabled ? this.pursuitTargets[index] : -1;
    const hasLock = lockedTarget >= 0 && this.alive[lockedTarget];
    const bursting = hasLock && this._canBurst(index);
    const huntState = hasLock ? 'locked' : localPredationCount > 0 ? 'scan' : null;
    if (huntState) {
      let hx;
      let hy;
      let hz;
      if (huntState === 'locked') {
        const lo = lockedTarget * 3;
        hx = this.positions[lo] - this.positions[offset];
        hy = this.positions[lo + 1] - this.positions[offset + 1];
        hz = this.positions[lo + 2] - this.positions[offset + 2];
      } else {
        hx = this.predationSums[offset] / localPredationCount - this.positions[offset];
        hy =
          this.predationSums[offset + 1] / localPredationCount -
          this.positions[offset + 1];
        hz =
          this.predationSums[offset + 2] / localPredationCount -
          this.positions[offset + 2];
      }
      applyRule(
        hx,
        hy,
        hz,
        // 拼命时追得更凶 —— 只加速度的话，一条又快又不往猎物方向拐的鱼
        // 只是在乱窜。
        this.config.relations.pursuitWeight *
          (this.desperation[index]
            ? Math.max(1, this.config.ecology?.desperationPursuitBoost ?? 1)
            : 1)
      );
    }

    const target = lockedTarget;
    if (bursting) {
      const targetOffset = target * 3;
      // 用【锁住那条】的实际距离。targetDistance2 是本帧最佳候选的距离，
      // 两者可以不是同一条鱼 —— 原来这里读错了，提前量算在别的鱼身上。
      const distance = Math.sqrt(this._distance2(index, target));
      const lookAhead = Math.min(
        this.config.locomotion.interceptLookAhead,
        distance / Math.max(EPSILON, school.maxSpeed)
      );
      const ix =
        this.positions[targetOffset] +
        this.velocities[targetOffset] * lookAhead;
      const iy =
        this.positions[targetOffset + 1] +
        this.velocities[targetOffset + 1] * lookAhead;
      const iz =
        this.positions[targetOffset + 2] +
        this.velocities[targetOffset + 2] * lookAhead;
      const pursuit = normalize3(
        ix - this.positions[offset],
        iy - this.positions[offset + 1],
        iz - this.positions[offset + 2]
      );
      // 冲刺追击也走归一化转向。原来是裸力 ×10，量级是其它所有规则总和的
      // 2 倍以上，且不减速度、不钳 maxForce —— 锁定目标的鱼等于脱离了鱼群，
      // 这就是多群下"像离子对撞"的直接来源。
      applyRule(
        pursuit[0],
        pursuit[1],
        pursuit[2],
        this.config.relations.burstWeight
      );
    }

    // 【觅食转向】。只有真的饿了才去找 —— 见 ecology.seekHungerRatio 的注释。
    //
    // 方向是感知范围内颗粒的加权重心（1/d 加权，不是「朝最近那一颗」——
    // 后者只有一颗时会让鱼死盯着它抖）。范围内一颗都没有就没有力：
    // 鱼不知道该往哪走，不假装它有信息。
    if (this.config.ecology?.enabled && this.config.plankton?.enabled) {
      const seekGate =
        energyCapacityFor(this.config, school) *
        (this.config.ecology.seekHungerRatio ?? 0.5);
      const energy = this.energy[index];
      if (energy < seekGate && seekGate > EPSILON) {
        // 紧迫度：从门槛处 0，到能量耗尽时 1。越饿转向越强。
        const urgency = Math.min(1, Math.max(0, 1 - energy / seekGate));
        const toFood = this.food.directionAt(
          this.positions[offset],
          this.positions[offset + 1],
          this.positions[offset + 2]
        );
        if (toFood) {
          applyRule(
            toFood[0],
            toFood[1],
            toFood[2],
            this.config.locomotion.forageWeight * urgency
          );
        }
      }
    }

    // 边界力的【量级】就是紧急度（软斜坡 0..1）。steerToward 会 normalize
    // 方向，所以必须把斜坡量级作为权重带回来，否则一进边界区就吃满力、硬弹。
    const boundary = this._boundaryForce(index);
    const boundaryUrgency = Math.min(
      1,
      Math.hypot(boundary[0], boundary[1], boundary[2])
    );
    if (boundaryUrgency > EPSILON) {
      applyRule(
        boundary[0],
        boundary[1],
        boundary[2],
        this.config.locomotion.boundaryWeight *
          boundaryUrgency *
          (1 + boundaryUrgency * 2)
      );
    }

    const point = [
      this.positions[offset],
      this.positions[offset + 1],
      this.positions[offset + 2],
    ];
    const query = this.distanceField?.query(point);
    if (query && query.clearance < this.config.tank.edgeSoftness) {
      const closeness =
        1 -
        clamp(
          query.clearance / Math.max(EPSILON, this.config.tank.edgeSoftness),
          0,
          1
        );
      const inertia = this.config.locomotion.avoidanceInertia;
      this.avoidanceDirections[offset] =
        this.avoidanceDirections[offset] * inertia +
        query.gradient[0] * (1 - inertia);
      this.avoidanceDirections[offset + 1] =
        this.avoidanceDirections[offset + 1] * inertia +
        query.gradient[1] * (1 - inertia);
      this.avoidanceDirections[offset + 2] =
        this.avoidanceDirections[offset + 2] * inertia +
        query.gradient[2] * (1 - inertia);
      const weight = this.config.locomotion.avoidanceWeight * closeness;
      fx += this.avoidanceDirections[offset] * weight;
      fy += this.avoidanceDirections[offset + 1] * weight;
      fz += this.avoidanceDirections[offset + 2] * weight;
    }

    this.wanderPhases[index] += dt * this.wanderRates[index];
    const phase = this.wanderPhases[index];
    fx += Math.sin(phase * 1.31) * this.config.locomotion.wanderWeight;
    fy += Math.sin(phase * 1.73 + 2.1) * this.config.locomotion.wanderWeight;
    fz += Math.cos(phase * 1.17) * this.config.locomotion.wanderWeight;

    const dynamic = interactionsEnabled
      ? this.physics?.interactFish(point, [
          this.velocities[offset],
          this.velocities[offset + 1],
          this.velocities[offset + 2],
        ])
      : null;
    if (dynamic) {
      fx += dynamic.force[0] * this.config.locomotion.avoidanceWeight;
      fy += dynamic.force[1] * this.config.locomotion.avoidanceWeight;
      fz += dynamic.force[2] * this.config.locomotion.avoidanceWeight;
      this.metricsState.dynamicContacts += dynamic.contacts;
    }

    const force = normalize3(fx, fy, fz);
    // 冲刺时给一点额外力预算即可。原来是 ×burstWeight(10)，
    // 直接把总力钳制从 5.2 抬到 52，等于取消了钳制。
    const forceBudget =
      target >= 0 && this.alive[target]
        ? this.config.locomotion.maxForce *
          this.config.locomotion.burstForceBudget
        : this.config.locomotion.maxForce;
    const forceMagnitude = Math.min(
      forceBudget,
      force[3]
    );
    const oldVx = this.velocities[offset];
    const oldVy = this.velocities[offset + 1];
    const oldVz = this.velocities[offset + 2];
    let nextVx = oldVx + force[0] * forceMagnitude * dt;
    let nextVy = oldVy + force[1] * forceMagnitude * dt;
    let nextVz = oldVz + force[2] * forceMagnitude * dt;
    const nextDirection = normalize3(nextVx, nextVy, nextVz);
    const oldDirection = normalize3(oldVx, oldVy, oldVz);
    const dot = clamp(
      oldDirection[0] * nextDirection[0] +
        oldDirection[1] * nextDirection[1] +
        oldDirection[2] * nextDirection[2],
      -1,
      1
    );
    const angle = Math.acos(dot);
    // 冲刺中转向能力大幅下降：猎物一躲，捕食者会冲过头再绕回来。
    // 直接用本帧的锁定状态，避免读到上一帧的 locomotionStates。
    const burstingNow = target >= 0 && this.alive[target];
    const turnSpeed =
      effectiveTurnSpeed(this.config, school) *
      (burstingNow ? this.config.locomotion.burstTurnFactor : 1) *
      (1 + this.panic[index] * this.config.relations.panicTurnBoost);
    const turnAlpha =
      angle <= EPSILON
        ? 1
        : Math.min(1, (turnSpeed * dt) / angle);
    let turned = normalize3(
      oldDirection[0] * (1 - turnAlpha) + nextDirection[0] * turnAlpha,
      oldDirection[1] * (1 - turnAlpha) + nextDirection[1] * turnAlpha,
      oldDirection[2] * (1 - turnAlpha) + nextDirection[2] * turnAlpha
    );
    // 俯仰钳制：鱼不像潜艇那样垂直上下游。没有这条，逃窜时会直上直下。
    const maxPitch = (this.config.locomotion.maxPitchDegrees * Math.PI) / 180;
    const horizontal = Math.hypot(turned[0], turned[2]);
    const pitch = Math.atan2(turned[1], Math.max(horizontal, EPSILON));
    if (Math.abs(pitch) > maxPitch) {
      turned = normalize3(
        turned[0],
        Math.max(horizontal, EPSILON) * Math.tan(Math.sign(pitch) * maxPitch),
        turned[2]
      );
    }
    let desiredSpeed = nextDirection[3];
    const cruiseSpeed =
      school.cruiseSpeed * sustainedSpeedScale(this.config, school);
    if (desiredSpeed < cruiseSpeed) {
      desiredSpeed = approach(desiredSpeed, cruiseSpeed, 3, dt);
    }
    const state = this._movementState(index, target, threatened);
    const maxSpeed = effectiveMaxSpeed(this.config, school, state);
    desiredSpeed = Math.min(maxSpeed, desiredSpeed);
    const hungerSpeed = hungerResponse(this._energyRatio(index));
    if (hungerSpeed) desiredSpeed *= hungerSpeed.speed;
    desiredSpeed *= this._desperationSpeedScale(index, state);
    nextVx = turned[0] * desiredSpeed;
    nextVy = turned[1] * desiredSpeed;
    nextVz = turned[2] * desiredSpeed;
    set3(this.velocities, index, nextVx, nextVy, nextVz);
  }

  /**
   * 每个鱼群各自的活动包围盒。不声明 bounds 就是整缸（现有行为不变）。
   *
   * 这是给 T2「上下两个迷你水缸」准备的。引擎里 TANK 是模块级单例，被
   * 7 个文件引用 39 次，真开两个缸是结构级改动；但缸壁本来就是【硬钳制】
   * （这里直接改写坐标，不是加力），把那个盒子按鱼群拆开就够了 ——
   * 视觉上是两个缸，机制上零泄漏。
   *
   * 为什么不用隔板障碍物：避障是【软转向力】，不是硬约束 —— 一条被吓到、
   * 正全速逃命的鱼完全可能顶穿它。演示两个隔离的环境，不能用一堵会漏的墙。
   * （原来这里还引用了 panicAvoidanceSuppression「恐慌时避障被压低」当
   *   补充理由，那个参数已删除；结论不受影响。）
   */
  /**
   * 不同【隔间】的鱼群互相不存在：关系一律降为 ignore。
   *
   * 光给鱼群各自的包围盒不够 —— 盒子挡得住身体，挡不住视线。实测两个
   * 子缸中间留 0.10m 时，捕食半径 0.33m 直接跨过隔板咬到对面（30 秒内
   * 捕获 2 次）；就算把间隔拉到 1.0m，感知半径 1.18m 仍然覆盖整个缸高，
   * 恐慌值照样 0.895、追击照样发起。拉宽间隔治不了根。
   *
   * 改关系矩阵是最省的切法：捕食、逃逸、恐慌、目标锁定全都读它，
   * 一处降为 ignore 就等于让两边互不存在 —— 这才是"两个缸"的真实语义。
   * 社群力（对齐/凝聚）本来就只在同鱼群内生效，不受影响。
   */
  _isolateChambers() {
    const schools = this.config.schools;
    if (!schools.some((school) => school.chamber !== undefined)) return;
    for (let a = 0; a < schools.length; a += 1) {
      for (let b = 0; b < schools.length; b += 1) {
        if (a === b) continue;
        if (schools[a].chamber === schools[b].chamber) continue;
        this.relationMatrix[a][b] = 'ignore';
      }
    }
  }

  /**
   * 冻结某些隔间：那一半的鱼原地不动，也不参与任何捕食。
   *
   * T2 同屏有两个缸，两边同时在追逐时观察者应接不暇 —— 而这一课的全部
   * 意义就是"看清"。冻结做成【按隔间】而不是全局暂停：全局停只是两边
   * 一起停，分缸停才能一次只看一个。
   *
   * 走运行时状态而不是 config，是因为改 config 会触发校验与重建 ——
   * 暂停不该让鱼重排。
   */
  setFrozenChambers(chambers = []) {
    const frozen = new Set(chambers);
    const count = this.config.schools.length;
    if (!this.chamberTargets || this.chamberTargets.length !== count) {
      this.chamberTargets = new Float32Array(count).fill(1);
      this.chamberScales = new Float32Array(count).fill(1);
    }
    this.config.schools.forEach((school, index) => {
      this.chamberTargets[index] =
        school.chamber !== undefined && frozen.has(school.chamber) ? 0 : 1;
    });
  }

  /**
   * 让每个隔间的时间倍率【指数逼近】目标，而不是瞬间切到 0/1。
   *
   * 硬冻结的观感是"卡住"，缓入缓出的观感才是"停下来"。逼近到阈值以下就
   * 吸附到 0 —— 指数曲线永远到不了 0，不吸附的话鱼会以肉眼看不见的速度
   * 永远漂移，而且捕食判定也一直在跑。
   */
  _easeChamberScales(dt) {
    if (!this.chamberTargets) return;
    const k = 1 - Math.exp(-CHAMBER_EASE_RATE * dt);
    for (let i = 0; i < this.chamberTargets.length; i += 1) {
      const target = this.chamberTargets[i];
      let value = this.chamberScales[i] + (target - this.chamberScales[i]) * k;
      if (target === 0 && value < CHAMBER_STOP_EPSILON) value = 0;
      else if (target === 1 && value > 1 - CHAMBER_STOP_EPSILON) value = 1;
      this.chamberScales[i] = value;
    }
  }

  /** 这条鱼当前的时间倍率。1 = 正常，0 = 完全停住。 */
  _timeScaleFor(index) {
    return this.chamberScales?.[this.schoolIds[index]] ?? 1;
  }

  _isFrozen(index) {
    return this._timeScaleFor(index) === 0;
  }

  _refreshSchoolBounds() {
    const tank = this.config.tank;
    const margin = tank.wallMargin;
    this._schoolBounds = this.config.schools.map((school) => {
      const box = school.bounds;
      return {
        center: [box?.centerX ?? 0, box?.centerY ?? 0, box?.centerZ ?? 0],
        half: [
          Math.max(EPSILON, (box?.width ?? tank.width) / 2 - margin),
          Math.max(EPSILON, (box?.height ?? tank.height) / 2 - margin),
          Math.max(EPSILON, (box?.depth ?? tank.depth) / 2 - margin),
        ],
      };
    });
  }

  _integrate(index, dt) {
    if (!this.alive[index] || this._isFrozen(index)) return;
    const offset = index * 3;
    this.positions[offset] += this.velocities[offset] * dt;
    this.positions[offset + 1] += this.velocities[offset + 1] * dt;
    this.positions[offset + 2] += this.velocities[offset + 2] * dt;
    if (!this._schoolBounds) this._refreshSchoolBounds();
    const bounds = this._schoolBounds[this.schoolIds[index]];
    for (let axis = 0; axis < 3; axis += 1) {
      const low = bounds.center[axis] - bounds.half[axis];
      const high = bounds.center[axis] + bounds.half[axis];
      if (this.positions[offset + axis] < low) {
        this.positions[offset + axis] = low;
        this.velocities[offset + axis] = Math.abs(
          this.velocities[offset + axis]
        );
      } else if (this.positions[offset + axis] > high) {
        this.positions[offset + axis] = high;
        this.velocities[offset + axis] = -Math.abs(
          this.velocities[offset + axis]
        );
      }
    }
  }

  /**
   * 某个鱼群现在还活着几条。教学关的世代循环每帧都要问一次，所以走这条而不是
   * metrics() —— 后者会把捕食对、遥测、闭合时间全算一遍，代价大得多。
   * 找不到该鱼群时返回 0（换课途中配置可能一时对不上）。
   *
   * ⚠️ 名字不能叫 aliveCount —— 类里已经有一个【按下标】取的同名方法，
   * 后定义的会静默覆盖先定义的，传进去的 id 会被当成下标去查
   * schoolRanges，然后在 range.start 上炸掉。
   */
  /**
   * 【过渡用】。外部（metrics、面板、测试、fingerprint 工具）还在读写
   * 「浮游总量」这个概念。空间浮游落地时这个访问器要一起删掉 ——
   * 到那时「总量」就不再是一个有意义的量了。
   */
  get planktonLevel() {
    return this.food.level;
  }

  set planktonLevel(value) {
    this.food.level = value;
  }

  aliveCountFor(schoolId) {
    const index = this.config.schools.findIndex(
      (school) => school.id === schoolId
    );
    if (index < 0 || !this.schoolRanges?.[index]) return 0;
    return this._activeSchoolCount(index);
  }

  _activeSchoolCount(schoolIndex) {
    const range = this.schoolRanges[schoolIndex];
    let count = 0;
    for (let index = range.start; index < range.end; index += 1) {
      count += this.alive[index];
    }
    return count;
  }

  /** 浮尸缓慢上浮到水面并停在那里。 */
  _floatCorpses(dt) {
    // 上浮是【加速度】，不是固定速率。
    //
    // 原来是把 riseSpeed × t 当成一个速度偏移加上去，靠 t（渐变进度）
    // 手动做"刚死时几乎不动"的渐入。改成浮力加速度之后那个渐入是【白送的】：
    // 速度从 0 开始自己长起来，不需要 t 这个乘子。
    //
    // 而且它和已有的阻尼一起给出【终末速度】= 加速度 / 阻尼系数 ——
    // 尸体先加速、再稳定地飘，这正是浮力对抗水阻的真实形状，
    // 比一个凭空恒定的速率好看也更说得通。
    const riseAccel = Math.max(
      0,
      this.config.ecology.corpseRiseAccel ?? 0.15
    );
    const drag = Math.max(0, this.config.ecology.corpseDrag ?? 2.4);
    const margin = this.config.tank.wallMargin;
    const half = [
      this.config.tank.width / 2 - margin,
      this.config.tank.height / 2 - margin,
      this.config.tank.depth / 2 - margin,
    ];
    for (let index = 0; index < this.count; index += 1) {
      if (!this.corpse[index]) continue;
      this.corpseAge[index] += dt;
      const offset = index * 3;
      // 残余动量指数衰减 —— 滑行一段后停住
      const damping = Math.exp(-drag * dt);
      this.velocities[offset] *= damping;
      this.velocities[offset + 1] *= damping;
      this.velocities[offset + 2] *= damping;
      // 浮力：每帧往上加一点速度。阻尼在上面已经作用过，所以两者共同
      // 收敛到终末速度 riseAccel / drag。
      this.velocities[offset + 1] += riseAccel * dt;
      this.positions[offset] += this.velocities[offset] * dt;
      this.positions[offset + 1] += this.velocities[offset + 1] * dt;
      this.positions[offset + 2] += this.velocities[offset + 2] * dt;
      for (let axis = 0; axis < 3; axis += 1) {
        const limit = half[axis];
        const value = this.positions[offset + axis];
        if (value > limit) this.positions[offset + axis] = limit;
        else if (value < -limit) this.positions[offset + axis] = -limit;
      }
    }
  }

  _killFish(index, reason) {
    if (!this.alive[index]) return false;
    this.alive[index] = 0;
    const schoolIndex = this.schoolIds[index];
    if (reason === 'captured') {
      this.deathCounts[schoolIndex].captured += 1;
    } else if (reason === 'starved') {
      this.deathCounts[schoolIndex].starved += 1;
      // 尸体不再是碎屑粒子，而是鱼模型本身：留在原地、变灰、缓慢上浮到水面。
      // 真实的死鱼因鱼鳔残气多半是浮起来的。
      this.corpse[index] = 1;
      this.corpseAge[index] = 0;
      // 不清零速度 —— 让它带着原来的动量滑行一段再停，死亡才有过程感
    }
    return true;
  }

  _updateEcology(dt) {
    if (!this.config.ecology?.enabled) return;
    // 浮游生物重新启用：logistic 再生的场模型。浮尸能量更高，所以
    // 觅食时先找浮尸，没有才吃浮游。
    this.food.regrow(dt);
    // 一餐分三份：自己 / 附近 / 同族全场。见 experiment-config.js 的注释。
    const localShare = clamp(this.config.ecology.energyShareLocal ?? 0, 0, 1);
    const schoolShare = clamp(this.config.ecology.energyShareSchool ?? 0, 0, 1);
    const shareFraction = Math.min(1, localShare + schoolShare);
    const shareRadius = Math.max(
      0,
      this.config.ecology.energyShareRadius ?? 0
    );
    const shareRadius2 = shareRadius * shareRadius;
    const forageMul = this.config.ecology.forageEnergyMultiplier ?? 1;
    const planktonEnergy = Math.max(
      0,
      this.config.ecology.planktonEnergy ?? 0.06
    );

    const planktonOn = this.config.plankton.enabled && this.food.hasFood;

    for (let index = 0; index < this.count; index += 1) {
      if (!this.alive[index]) continue;
      const schoolIndex = this.schoolIds[index];
      const school = this.config.schools[schoolIndex];
      if (!(school.grazeRate > 0)) continue;
      // 【滤食频率随体型走】。school.grazeRate 现在是倍率，真正的速率
      // 还要乘 size^grazeSizeExponent —— 大鱼滤食能力更强（鳃/口面积），
      // 但不足以覆盖它按 size^0.75 放大的消耗，差额就是它必须捕猎的部分。
      const grazeRate =
        school.grazeRate *
        Math.pow(
          Math.max(EPSILON, school.size),
          this.config.ecology.grazeSizeExponent ?? 0
        );
      // 【优先吃鱼】正在锁定猎物的鱼不觅食。中群/大群几乎总在追猎，
      // 所以主动吃浮游的概率天然最低；小群从不追猎（体型比落在 evade 侧），
      // 所以它只能靠浮游和浮尸。
      if (this.pursuitTargets[index] >= 0) continue;
      // 能量罐随体型变，所以上限要【逐鱼】算，不能在循环外算一次。
      const capacityLimit = energyCapacityFor(this.config, school);
      // 【饥饿门控】吃饱了就不吃。这一条是浮游可持续的关键：
      // 无约束觅食是 64/s 消耗 vs 18/s 再生（几秒吃光且 level=0 后永不恢复）；
      // 只在能量低于阈值时进食，系统自动收敛到约 4/s，有 4.5 倍余量。
      const hungerGate =
        capacityLimit * (this.config.ecology.grazeHungerRatio ?? 0.8);
      if (this.energy[index] >= hungerGate) continue;
      const attemptChance = Math.min(1, grazeRate * dt * 4);
      if (this.rng.next() > attemptChance) continue;

      const offset = index * 3;
      let gain = 0;
      let ate = false;

      // 【浮尸不再是食物】。它上浮、还被墙夹住，carrionRadius 只有 0.08 ——
      // 实际几乎吃不到，是带着配置旋钮的死代码。更要紧的是方向：
      // 死鱼喂活鱼是【正反馈】，一批死完剩下的反而更好活，
      // 和「一群一群死」正好相反。（浮尸的视觉保留 —— 一条鱼翻肚上浮是
      // 「刚才死了一条」唯一看得见的信号。见 ECOLOGY-DECISIONS.md §2。）
      //
      // 顺带去掉了一个 O(N) 的内层扫描：每条觅食的鱼原来要遍历全部鱼找浮尸。
      if (planktonOn) {
        const maxIntake = Math.max(
          0,
          this.config.plankton.maxIntakePerFish
        );
        // 【这儿有多少】，不是「总共还有多少」—— 标量后端忽略坐标，
        // 空间后端会返回附近的。这就是这次重构挪动的那条接缝。
        const available = this.food.availableAt(
          this.positions[offset],
          this.positions[offset + 1],
          this.positions[offset + 2]
        );
        const requested = planktonIntake({
          available,
          maxIntake,
          // 【局部尺度】的半饱和常数。available 已经是「半径内」的存量，
          // 半饱和常数还按全场容量算的话，饱和项会把摄入压成零。
          halfSaturation: this.food.halfSaturation,
        });
        // 【按实际取到的算，不是按请求的算】。Holling-II 给出的是「想吃多少」，
        // 而颗粒是离散的（只能整口整口地取），实际拿到的往往更少。
        // 原来能量按【请求】发放、返回值被丢掉，等于凭空多给 —— 不致命，
        // 但界面上的「吃到了多少」和鱼身上涨的能量对不上，是在说谎。
        const intake =
          requested > 0
            ? this.food.take(
                this.positions[offset],
                this.positions[offset + 1],
                this.positions[offset + 2],
                requested
              )
            : 0;
        if (intake > 0) {
          this.planktonConsumed += intake;
          // 满摄入保持既有恢复量；资源不足时按真实摄入等比下降。
          // energyConversion 终于成为有效参数，而不是只出现在面板。
          const intakeFraction =
            maxIntake > EPSILON ? intake / maxIntake : 0;
          // 【不乘 grazeRate】。它在上面已经决定了「多久吃一次」，再乘进
          // 收益就是同一个参数在乘法链里出现两次 —— 平方效应。
          // 默认配置下大鱼 grazeRate 0.01 意味着浮游收入是小鱼的【万分之一】，
          // 而它的消耗还是小鱼的 1.8 倍。一口值多少不该取决于谁在吃。
          gain =
            planktonEnergy *
            intakeFraction *
            Math.max(0, this.config.plankton.energyConversion ?? 1) *
            forageMul;
          ate = true;
        }
      }

      if (!ate || gain <= 0) continue;
      this.energy[index] = Math.min(
        capacityLimit,
        this.energy[index] + gain * (1 - shareFraction)
      );
      // 同族全场那一档走原来的池子，逐帧按存活数平分。
      this.energyPools[schoolIndex] += gain * schoolShare;
      // 【附近】那一档当场分掉：谁物理上在这一片，谁就分到。
      // 不看族群 id —— 一小群一起吃饱、一小群一起饿死，
      // 「一群一群地死」是这么涌现的。
      if (localShare > 0 && shareRadius2 > 0) {
        const neighbours = [];
        this.hash.forEachCandidate(index, (other) => {
          if (other === index || !this.alive[other]) return;
          const oo = other * 3;
          const dx = this.positions[oo] - this.positions[offset];
          const dy = this.positions[oo + 1] - this.positions[offset + 1];
          const dz = this.positions[oo + 2] - this.positions[offset + 2];
          if (dx * dx + dy * dy + dz * dz <= shareRadius2) neighbours.push(other);
        });
        if (neighbours.length > 0) {
          const each = (gain * localShare) / neighbours.length;
          for (const other of neighbours) {
            this.energy[other] = Math.min(
              capacityLimit,
              this.energy[other] + each
            );
          }
        } else {
          // 附近一条鱼都没有：这一份归自己（独行者不该被罚）。
          this.energy[index] = Math.min(
            capacityLimit,
            this.energy[index] + gain * localShare
          );
        }
      }
      // 进食特效
      this.captureVfx?.emitFeed?.(
        this.positions[offset],
        this.positions[offset + 1],
        this.positions[offset + 2]
      );
    }
    // （原来这里还会 += carrionEaten —— 把浮尸的【条数】加进一个记能量的
    //   计数器，两种单位混在一起，这个指标一直是没有意义的。）

    // 分发共享池：按各族存活数平均。超出容量的部分丢弃（不累积到下一帧）。
    const perFishShare = this.energyPools.map((pool, schoolIndex) => {
      if (!(pool > 0)) return 0;
      const alive = this._activeSchoolCount(schoolIndex);
      return alive > 0 ? pool / alive : 0;
    });
    this.energyPools.fill(0);
    for (let index = 0; index < this.count; index += 1) {
      if (!this.alive[index]) continue;
      const schoolIndex = this.schoolIds[index];
      const bonus = perFishShare[schoolIndex];
      if (bonus > 0) {
        this.energy[index] = Math.min(
          energyCapacityFor(this.config, this.config.schools[schoolIndex]),
          this.energy[index] + bonus
        );
      }
    }

    const eco = this.config.ecology;
    const costShare = clamp(eco.desperationCostShare ?? 1, 0, 1);
    const settleSeconds = Math.max(0.01, eco.debtSettleSeconds ?? 10);

    const starved = [];
    for (let index = 0; index < this.count; index += 1) {
      if (!this.alive[index]) continue;
      const school = this.config.schools[this.schoolIds[index]];
      // 阈值跟着这条鱼自己的能量罐走。
      const fishCapacity = energyCapacityFor(this.config, school);
      const enterAt = fishCapacity * (eco.desperationEnterRatio ?? 0);
      const recoverAt = fishCapacity * (eco.desperationRecoverRatio ?? 1);
      let drain =
        metabolicRate(
          this.config,
          school,
          this.locomotionStates[index] === LOCOMOTION.BURST
        ) * dt;

      // ── 孤注一掷 ────────────────────────────────────────────────
      // 门闩：能量回到恢复线就重新上膛（同时也就退出了力竭）。
      if (this.energy[index] >= recoverAt) this.desperationArmed[index] = 1;
      if (this.desperation[index]) {
        // 计时到了还没缓过来 → 退出，进入力竭（armed 仍是 0，速度 ×0.8）。
        if (this.elapsed >= this.desperationUntil[index]) {
          this.desperation[index] = 0;
        }
      } else if (
        this.desperationArmed[index] &&
        enterAt > EPSILON &&
        this.energy[index] < enterAt
      ) {
        this.desperation[index] = 1;
        this.desperationArmed[index] = 0;
        this.desperationUntil[index] =
          this.elapsed + Math.max(0, eco.desperationSeconds ?? 0);
      }

      // 拼命期间【当场只付一部分，剩下的记成债】。
      // 债【不会被吃饱抹掉】—— 它照常从能量里扣，扣到 0 一样会死：
      // 被到期的账单杀死。那才是「代价会被继承」在单条鱼身上的样子。
      if (this.desperation[index] && costShare < 1) {
        const deferred = drain * (1 - costShare);
        this.debt[index] += deferred;
        drain -= deferred;
      }
      if (this.debt[index] > 0) {
        const settle = Math.min(
          this.debt[index],
          (this.debt[index] / settleSeconds) * dt
        );
        this.debt[index] -= settle;
        drain += settle;
      }

      // 减法不需要再夹上限（x − drain ≤ x ≤ capacity），原来那层
      // Math.min 是从「加能量」那段复制过来的，永远不会触发。
      this.energy[index] -= drain;
      if (this.energy[index] <= 0) starved.push(index);
    }
    for (const index of starved) this._killFish(index, 'starved');
    this._floatCorpses(dt);
    if (this.config.runtime.mode === 'ecology') {
      const aliveCounts = this.config.schools.map((_, schoolIndex) =>
        this._activeSchoolCount(schoolIndex)
      );
      this.ecologyStatus = ecologyOutcome(aliveCounts);
    }
    this._syncPlanktonVisual();
  }

  /**
   * 【顺路吞食】的目标:体型比超出 KMax（"太小,不值得追"）而恰好贴上来的鱼。
   *
   * 不需要锁定、不需要追击 —— 只判定"它已经在嘴边了"。这补的是一个真实的
   * 缺口:大鱼的主动猎物只有体型比落在 [k, KMax] 里的那一群,而代谢按体型
   * 放大之后那一群根本不够养活它。鲸不追单只磷虾,但游过磷虾云照样会吞。
   */
  _findIncidentalPrey(predator) {
    const predatorSchool = this.schoolIds[predator];
    const predatorConf = this.config.schools[predatorSchool];
    const kMax = this.config.relations.KMax;
    if (!(kMax > 0)) return -1;
    // 哈希是每步 _advance 里建的。测试会绕过整步直接调 _capture，
    // 那时它还是空的 —— 没有邻居可查就等于没有顺路撞上的。
    if (!this.hash?.positions) return -1;
    const po = predator * 3;
    let best = -1;
    let bestDistance2 = Infinity;
    this.hash.forEachCandidate(predator, (other) => {
      if (other === predator || !this.alive[other]) return;
      const otherSchool = this.schoolIds[other];
      if (otherSchool === predatorSchool) return;
      const otherConf = this.config.schools[otherSchool];
      // 只捡【太小以致被忽略】的那一类；正常猎物走锁定那条路。
      if (predatorConf.size / otherConf.size <= kMax) return;
      const radius = captureRadius(this.config, predatorConf, otherConf);
      const oo = other * 3;
      const dx = this.positions[oo] - this.positions[po];
      const dy = this.positions[oo + 1] - this.positions[po + 1];
      const dz = this.positions[oo + 2] - this.positions[po + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > radius * radius || d2 >= bestDistance2) return;
      bestDistance2 = d2;
      best = other;
    });
    return best;
  }

  _capture(dt) {
    if (this.config.relations.enabled === false) return;
    const incidentalOn = this.config.capture.incidentalCapture !== false;
    for (let predator = 0; predator < this.count; predator += 1) {
      if (this._isFrozen(predator) || !this.alive[predator]) {
        continue;
      }
      // 优先级:【正在追的那条够得着就吃它;够不着才看嘴边有没有别的】。
      //
      // 第一版写成"没有锁定目标时才找顺路的",结果它永远不触发 ——
      // 大鱼几乎总锁着一条 medium。而锁定管的是【往哪儿游】，不该决定
      // 【嘴里碰到什么】:鲸追着一条鱼的时候，路过的磷虾照样会被吞掉。
      let prey = -1;
      let incidental = false;
      const locked = this.pursuitTargets[predator];
      if (locked >= 0 && this.alive[locked]) {
        const lo = locked * 3;
        const po0 = predator * 3;
        const r = captureRadius(
          this.config,
          this.config.schools[this.schoolIds[predator]],
          this.config.schools[this.schoolIds[locked]]
        );
        const dx = this.positions[lo] - this.positions[po0];
        const dy = this.positions[lo + 1] - this.positions[po0 + 1];
        const dz = this.positions[lo + 2] - this.positions[po0 + 2];
        if (dx * dx + dy * dy + dz * dz <= r * r) prey = locked;
      }
      if (prey < 0 && incidentalOn) {
        prey = this._findIncidentalPrey(predator);
        incidental = prey >= 0;
      }
      if (prey < 0 || !this.alive[prey]) continue;
      const predatorSchool = this.schoolIds[predator];
      const preySchool = this.schoolIds[prey];
      if (
        !incidental &&
        relationBetween(
          this.config.schools[predatorSchool],
          this.config.schools[preySchool],
          this.config.relations
        ) !== 'pursuit'
      ) {
        continue;
      }
      const po = predator * 3;
      const qo = prey * 3;
      const distance = Math.hypot(
        this.positions[qo] - this.positions[po],
        this.positions[qo + 1] - this.positions[po + 1],
        this.positions[qo + 2] - this.positions[po + 2]
      );
      const radius = captureRadius(
        this.config,
        this.config.schools[predatorSchool],
        this.config.schools[preySchool]
      );
      if (distance > radius) continue;
      this.captureVfx?.emit(
        new THREE.Vector3(
          this.positions[qo],
          this.positions[qo + 1],
          this.positions[qo + 2]
        ),
        new THREE.Vector3(
          this.velocities[po],
          this.velocities[po + 1],
          this.velocities[po + 2]
        ),
        new THREE.Vector3(
          this.positions[po],
          this.positions[po + 1],
          this.positions[po + 2]
        )
      );
      this._finishChase(predator, prey, true);
      this._killFish(prey, 'captured');
      this.metricsState.captures += 1;
      if (this.config.ecology?.enabled) {
        const captureGain =
          this.config.ecology.captureEnergyPerSize *
          this.config.schools[preySchool].size;
        const captureShare = clamp(
          (this.config.ecology.energyShareLocal ?? 0) +
            (this.config.ecology.energyShareSchool ?? 0),
          0,
          1
        );
        this.energyPools[predatorSchool] += captureGain * captureShare;
        this.energy[predator] = Math.min(
          energyCapacityFor(
            this.config,
            this.config.schools[predatorSchool]
          ),
          this.energy[predator] + captureGain * (1 - captureShare)
        );
      }
    }
  }

  _advance(dt) {
    if (
      this.config.runtime.mode === 'ecology' &&
      this.ecologyStatus.state !== 'running'
    ) {
      return;
    }
    this.elapsed += dt;
    this.derived = deriveExperiment(this.config);
    this.hash.cellSize = Math.max(EPSILON, this.derived.cellSize);
    this._refreshSchoolBounds();
    this.relationMatrix = this.relations.update(
      this.config.schools,
      this.config.relations
    );
    this._isolateChambers();
    this._clearAccumulators();
    this.hash.build(this.positions, this.alive, this.count);
    this._easeChamberScales(dt);
    this._pairPasses();
    for (let index = 0; index < this.count; index += 1) {
      this._steerFish(index, dt * this._timeScaleFor(index));
    }
    this._updateChaseTelemetry(dt);
    for (let index = 0; index < this.count; index += 1) {
      this._integrate(index, dt * this._timeScaleFor(index));
    }
    this._capture(dt);
    this._updateEcology(dt);
    this.physics?.step(dt);
    this.updateMesh();
  }

  _advanceLocomotionPreview(dt) {
    this.derived = deriveExperiment(this.config);
    this.hash.cellSize = Math.max(EPSILON, this.derived.cellSize);
    this._refreshSchoolBounds();
    this.relationMatrix = this.relations.update(
      this.config.schools,
      this.config.relations
    );
    this._isolateChambers();
    this._clearAccumulators();
    this.hash.build(this.positions, this.alive, this.count);
    this._pairPasses(false);
    for (let index = 0; index < this.count; index += 1) {
      this._steerFish(index, dt, false);
    }
    for (let index = 0; index < this.count; index += 1) {
      this._integrate(index, dt);
    }
    this.updateMesh();
  }

  step(dt) {
    const start = performance.now();
    if (this.locomotionPreview) {
      this._advanceLocomotionPreview(dt);
    } else {
      this._advance(dt);
    }
    const frameMs = performance.now() - start;
    this.metricsState.frameMs = approach(
      this.metricsState.frameMs,
      frameMs,
      4,
      dt
    );
    this.metricsState.fps =
      this.metricsState.frameMs > 0
        ? Math.min(999, 1000 / this.metricsState.frameMs)
        : 0;
    if (!this.locomotionPreview) this.captureVfx?.step(dt);
  }

  updateMesh() {
    if (!this.mesh) return;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const rollQuaternion = new THREE.Quaternion();
    const corpseTint = new THREE.Color();
    const scale = new THREE.Vector3();
    const direction = new THREE.Vector3();
    for (let index = 0; index < this.count; index += 1) {
      const offset = index * 3;
      position.set(
        this.positions[offset],
        this.positions[offset + 1],
        this.positions[offset + 2]
      );
      if (index === this.hiddenFish) {
        scale.setScalar(0);
        quaternion.identity();
      } else if (!this.alive[index]) {
        // 浮尸：保留鱼模型，肚皮朝上，灰色
        if (this.corpse[index]) {
          const schoolIndex = this.schoolIds[index];
          const school = this.config.schools[schoolIndex];
          // 尺寸就是鱼自身的体型（同样走视觉放大，死后不该突然改变大小）
          scale.setScalar(visualSizeOf(school.size, school.id));
          const fade = Math.max(
            0.01,
            this.config.ecology.corpseFadeTime ?? 1.6
          );
          const t = clamp(this.corpseAge[index] / fade, 0, 1);
          // 逐渐翻身：从死亡时的朝向平滑转到肚皮朝上
          direction
            .set(
              this.prevHeadings[offset],
              this.prevHeadings[offset + 1],
              this.prevHeadings[offset + 2]
            )
            .normalize();
          if (direction.lengthSq() <= EPSILON) direction.copy(FORWARD);
          quaternion.setFromUnitVectors(FORWARD, direction);
          rollQuaternion.setFromAxisAngle(FORWARD, Math.PI * t);
          quaternion.multiply(rollQuaternion);
          // 颜色渐变：本族颜色 → 灰
          if (this.mesh.instanceColor) {
            corpseTint
              .copy(this.schoolColors[schoolIndex])
              .lerp(this.corpseColor, t);
            this.mesh.setColorAt(index, corpseTint);
            this._instanceColorDirty = true;
          }
        } else {
          scale.setScalar(0);
          quaternion.identity();
        }
      } else {
        const school = this.config.schools[this.schoolIds[index]];
        // 视觉放大：判定用 school.size，画面用 visualSizeOf(size)
        scale.setScalar(visualSizeOf(school.size, school.id));
        // 耐力明度：亮度 ∝ 还能活多久 = 当前能量 ÷ 每秒代谢。
        // TUNING 时能量恒满 → 显示"这套选择能撑多久"；RUNNING 时能量
        // 下降 → 显示"现在还能撑多久"。冲刺不计入，否则亮度会闪。
        if (this.mesh.instanceColor && STAMINA_TINT_STRENGTH !== 0) {
          const drain = metabolicRate(this.config, school, false);
          const seconds =
            drain > EPSILON ? this.energy[index] / drain : Infinity;
          const factor = staminaTintFactor(seconds);
          if (Math.abs(factor - this.tintFactors[index]) > 0.004) {
            this.tintFactors[index] = factor;
            corpseTint
              .copy(this.schoolColors[this.schoolIds[index]])
              .multiplyScalar(factor);
            this.mesh.setColorAt(index, corpseTint);
            this._instanceColorDirty = true;
          }
        }
        direction
          .set(
            this.velocities[offset],
            this.velocities[offset + 1],
            this.velocities[offset + 2]
          )
          .normalize();
        if (direction.lengthSq() <= EPSILON) direction.copy(FORWARD);
        // --- 侧倾（banking）：转弯时鱼体侧过来 ---
        // 用上一帧与本帧朝向的叉积估转向率；其竖直分量就是水平转向的方向。
        const visual = this.config.visual;
        const px = this.prevHeadings[offset];
        const py = this.prevHeadings[offset + 1];
        const pz = this.prevHeadings[offset + 2];
        let targetRoll = 0;
        if (px !== 0 || py !== 0 || pz !== 0) {
          const yawRate = pz * direction.x - px * direction.z;
          const maxRoll = (visual.maxRollDegrees * Math.PI) / 180;
          targetRoll = clamp(yawRate * visual.bankingGain, -maxRoll, maxRoll);
        }
        this.rollAngles[index] +=
          (targetRoll - this.rollAngles[index]) * visual.bankingSmoothing;
        this.prevHeadings[offset] = direction.x;
        this.prevHeadings[offset + 1] = direction.y;
        this.prevHeadings[offset + 2] = direction.z;
        quaternion.setFromUnitVectors(FORWARD, direction);
        if (Math.abs(this.rollAngles[index]) > 1e-4) {
          rollQuaternion.setFromAxisAngle(FORWARD, this.rollAngles[index]);
          quaternion.multiply(rollQuaternion);
        }
      }
      matrix.compose(position, quaternion, scale);
      this.mesh.setMatrixAt(index, matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this._instanceColorDirty && this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
      this._instanceColorDirty = false;
    }
  }

  averageNeighbors(schoolIndex) {
    const range = this.schoolRanges[schoolIndex];
    let total = 0;
    let count = 0;
    for (let index = range.start; index < range.end; index += 1) {
      if (!this.alive[index]) continue;
      total += this.sameNeighbors[index];
      count += 1;
    }
    return count > 0 ? total / count : 0;
  }

  averageEnergy(schoolIndex) {
    const range = this.schoolRanges[schoolIndex];
    let total = 0;
    let count = 0;
    for (let index = range.start; index < range.end; index += 1) {
      if (!this.alive[index]) continue;
      total +=
        this.energy[index] /
        Math.max(
          EPSILON,
          energyCapacityFor(this.config, this.config.schools[schoolIndex])
        );
      count += 1;
    }
    return count > 0 ? total / count : 0;
  }

  aliveCount(schoolIndex) {
    return this._activeSchoolCount(schoolIndex);
  }

  fish(index) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.count
    ) {
      return null;
    }
    const offset = index * 3;
    return {
      index,
      alive: Boolean(this.alive[index]),
      schoolIndex: this.schoolIds[index],
      school: this.config.schools[this.schoolIds[index]],
      position: [
        this.positions[offset],
        this.positions[offset + 1],
        this.positions[offset + 2],
      ],
      velocity: [
        this.velocities[offset],
        this.velocities[offset + 1],
        this.velocities[offset + 2],
      ],
      panic: this.panic[index],
      energy: this.energy[index],
      locomotionState: LOCOMOTION_LABEL[this.locomotionStates[index]],
    };
  }

  nearestAliveSameSchool(index) {
    const source = this.fish(index);
    if (!source) return -1;
    let result = -1;
    let distance2 = Infinity;
    const range = this.schoolRanges[source.schoolIndex];
    for (let other = range.start; other < range.end; other += 1) {
      if (other === index || !this.alive[other]) continue;
      const offset = other * 3;
      const dx = this.positions[offset] - source.position[0];
      const dy = this.positions[offset + 1] - source.position[1];
      const dz = this.positions[offset + 2] - source.position[2];
      const candidate = dx * dx + dy * dy + dz * dz;
      if (candidate < distance2) {
        result = other;
        distance2 = candidate;
      }
    }
    return result;
  }

  setHiddenFish(index = -1) {
    this.hiddenFish = index;
    this.updateMesh();
  }

  metrics() {
    const predatorPairs = [];
    for (let actor = 0; actor < this.config.schools.length; actor += 1) {
      for (let target = 0; target < this.config.schools.length; target += 1) {
        if (this.relationMatrix[actor][target] !== 'pursuit') continue;
        const actorSchool = this.config.schools[actor];
        const targetSchool = this.config.schools[target];
        const telemetry = this._telemetryFor(actor, target);
        const radius = captureRadius(
          this.config,
          actorSchool,
          targetSchool
        );
        const pursuitSpeed = effectiveMaxSpeed(
          this.config,
          actorSchool,
          'burst'
        );
        const evadeSpeed = effectiveMaxSpeed(
          this.config,
          targetSchool,
          'evade'
        );
        const closingSpeed = pursuitSpeed - evadeSpeed;
        predatorPairs.push({
          actor: actorSchool.id,
          target: targetSchool.id,
          captureRadius: radius,
          pursuitSpeed,
          evadeSpeed,
          closingSpeed,
          nominalClosureSeconds:
            closingSpeed > EPSILON
              ? Math.max(
                  0,
                  this.derived.schools[actor].detectionLength - radius
                ) / closingSpeed
              : Infinity,
          chaseStarts: telemetry.starts,
          pursuitFrames: telemetry.pursuitFrames,
          activeChases: telemetry.active,
          captures: telemetry.captures,
          abandoned: telemetry.abandoned,
          conversion:
            telemetry.starts > 0
              ? telemetry.captures / telemetry.starts
              : 0,
          averageChaseSeconds:
            telemetry.captures + telemetry.abandoned > 0
              ? telemetry.completedDuration /
                (telemetry.captures + telemetry.abandoned)
              : 0,
          averageCaptureChaseSeconds:
            telemetry.captures > 0
              ? telemetry.capturedDuration / telemetry.captures
              : 0,
          burstSeconds: telemetry.burstSeconds,
        });
      }
    }
    const ecologyWinner =
      this.ecologyStatus.winnerIndex === null
        ? null
        : this.config.schools[this.ecologyStatus.winnerIndex];
    const warnings = [];
    if (
      this.config.locomotion.burstFactor <=
      this.config.locomotion.panicSpeedFactor
    ) {
      warnings.push('burstFactor ≤ panicSpeedFactor');
    }
    if (predatorPairs.some((pair) => pair.closingSpeed <= 0)) {
      warnings.push('At least one predator pair has a nominal closing speed ≤ 0');
    }
    return {
      seed: this.seed,
      elapsed: this.elapsed,
      // 仿真当前走哪个分支。true = _advanceLocomotionPreview（只跑运动，
      // 捕食/生态/计时全部不执行）。排查「鱼在游但什么都不发生」时，
      // 这是第一个该看的值 —— 缺了它我曾经把 elapsed 恒为 0 误判成
      // 「elapsed 不是仿真时间」，绕了很远。
      locomotionPreview: this.locomotionPreview,
      project: this.config.runtime.project,
      mode: this.config.runtime.mode,
      population: this.config.schools.map((school, index) => ({
        id: school.id,
        name: school.name,
        color: school.color,
        size: school.size,
        alive: this.aliveCount(index),
        target: this.derived.schools[index].count,
        neighborRadius: this.derived.schools[index].neighborRadius,
        separationRadius:
          this.derived.schools[index].separationRadius,
        alignmentRadius:
          this.derived.schools[index].alignmentRadius,
        cohesionRadius:
          this.derived.schools[index].cohesionRadius,
        detectionLength: this.derived.schools[index].detectionLength,
        panicRadius: this.derived.schools[index].panicRadius,
        burstRadius:
          this.derived.schools[index].detectionLength *
          this.config.relations.burstRadiusFactor,
        measuredNeighbors: this.averageNeighbors(index),
        averageEnergy: this.averageEnergy(index),
        deaths: { ...this.deathCounts[index] },
      })),
      relationMatrix: this.relationMatrix,
      pairCount: this.metricsState.pairCount,
      captures: this.metricsState.captures,
      captureParticles: this.captureVfx?.particles.length ?? 0,
      dynamicContacts: this.metricsState.dynamicContacts,
      rigidBodies: this.physics?.metrics?.() ?? [],
      simulationMs: this.metricsState.frameMs,
      simulationFps: this.metricsState.fps,
      renderFps: this.metricsState.renderFps ?? 0,
      predatorPairs,
      ecology: {
        state: this.ecologyStatus.state,
        winnerId: ecologyWinner?.id ?? null,
        winnerName: ecologyWinner?.name ?? null,
        plankton: {
          // Legacy field names kept for dashboard compatibility: level =
          // current brown corpse fragments, consumed = eaten corpse count.
          level: this.captureVfx?.starvationCount?.() ?? 0,
          capacity: 0,
          fraction: 0,
          consumed: this.planktonConsumed,
        },
        deaths: this.deathCounts.map((entry, schoolIndex) => ({
          schoolId: this.config.schools[schoolIndex].id,
          ...entry,
        })),
      },
      tankVolume: tankVolume(this.config.tank),
      warnings,
    };
  }
}
