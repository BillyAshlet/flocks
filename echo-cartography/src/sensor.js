// 射线扇传感器 —— 本项目的核心新增。
//
// 原来的避障是【盒体最近点斥力场】：全方向、与航向无关、算出来的是"盒子上
// 离我最近的点"。那个东西躲得开障碍，但它不是一次测量 —— 没有射线，
// 就没有 origin→hit 这一段，自由空间雕刻的输入根本不存在。
//
// 现在改成朝航向张开的锥形射线扇。每根射线各自求交，避障转向由五根合成。
// 命中点即是障碍物表面上的一个点 —— 这就是事件里的 hit。
//
// 现实对应：真实海底测绘用的多波束测深仪（multibeam）也是一个扇面。
// 差别在于真实多波束垂直于航向向下横扫（专职测绘），我们的扇面朝前，
// 因为它【首先是避障传感器】—— 测绘是它的副产品，这正是本项目的论点。
// 别为了覆盖率把扇面转下去，那就成了专职测绘传感器，论点就塌了。
//
// 本文件不 import three.js。

import { SENSOR } from './params.js';

const EPSILON = 1e-8;

// ── 射线 vs 轴对齐盒体（slab 法）────────────────────────────────
// 返回最近命中距离 t，未命中返回 -1。命中时把表面法向写进 outNormal。
//
// slab 法顺带白送法向：进入时间最晚的那个轴，就是射线穿过的那个面。
function rayAABB(ox, oy, oz, dx, dy, dz, maxT, bx, outNormal) {
  let tMin = 0;
  let tMax = maxT;
  let hitAxis = -1;
  let hitSign = 0;

  for (let a = 0; a < 3; a += 1) {
    const o = a === 0 ? ox : a === 1 ? oy : oz;
    const d = a === 0 ? dx : a === 1 ? dy : dz;
    const lo = bx[a];
    const hi = bx[a + 3];

    if (Math.abs(d) < EPSILON) {
      // 射线平行于这对面：只要起点在板外就永远打不中
      if (o < lo || o > hi) return -1;
      continue;
    }

    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    let sign = -1; // 命中的是 lo 面 → 法向朝 −a
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      sign = 1; // 命中的是 hi 面 → 法向朝 +a
    }
    if (t1 > tMin) {
      tMin = t1;
      hitAxis = a;
      hitSign = sign;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }

  if (hitAxis < 0) return -1; // 起点已在盒内，本项目视为无效测量
  outNormal[0] = hitAxis === 0 ? hitSign : 0;
  outNormal[1] = hitAxis === 1 ? hitSign : 0;
  outNormal[2] = hitAxis === 2 ? hitSign : 0;
  return tMin;
}

// ── 射线 vs 包围盒【内壁】────────────────────────────────────────
// 设备在盒内向外打，要的是【离开】的那个面 —— 也就是 tMax 而非 tMin。
// 缸壁 / 沟壁 / 海床都靠这个被测到，否则地图上只有几个盒子悬在空中。
function rayBoundsInside(ox, oy, oz, dx, dy, dz, maxT, bx, outNormal) {
  let tExit = Infinity;
  let axis = -1;
  let sign = 0;

  for (let a = 0; a < 3; a += 1) {
    const o = a === 0 ? ox : a === 1 ? oy : oz;
    const d = a === 0 ? dx : a === 1 ? dy : dz;
    if (Math.abs(d) < EPSILON) continue;
    const target = d > 0 ? bx[a + 3] : bx[a];
    const t = (target - o) / d;
    if (t >= 0 && t < tExit) {
      tExit = t;
      axis = a;
      sign = d > 0 ? -1 : 1; // 内壁法向朝里，与射线方向相反
    }
  }

  if (axis < 0 || tExit > maxT) return -1;
  outNormal[0] = axis === 0 ? sign : 0;
  outNormal[1] = axis === 1 ? sign : 0;
  outNormal[2] = axis === 2 ? sign : 0;
  return tExit;
}

// ── 扇面几何 ────────────────────────────────────────────────────
//
// 【导出】给终端复用：事件里只传航向与半角，五根射线的方向由这个函数
// 在两端各算一次算回来。方向是可推导的，所以不必上传 —— 这正是事件
// 打包能省下 3 倍带宽的原因。两端共用同一个函数，也就不可能算歪。

// 把轴对齐法向压成 1 字节。AABB/内壁只有 6 个可能，球面法向取主轴近似。
export function encodeFace(nx, ny, nz) {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (ax >= ay && ax >= az) return nx >= 0 ? 1 : 2;
  if (ay >= ax && ay >= az) return ny >= 0 ? 3 : 4;
  return nz >= 0 ? 5 : 6;
}

export function decodeFace(code, out) {
  out[0] = out[1] = out[2] = 0;
  if (code === 1) out[0] = 1;
  else if (code === 2) out[0] = -1;
  else if (code === 3) out[1] = 1;
  else if (code === 4) out[1] = -1;
  else if (code === 5) out[2] = 1;
  else if (code === 6) out[2] = -1;
  return out;
}

// 绕单位向量 d 建正交基。d 近似竖直时换参考轴，否则叉积退化。
export function basisFor(dx, dy, dz, outR, outU) {
  const refY = Math.abs(dy) > 0.99 ? 0 : 1;
  const refX = refY === 0 ? 1 : 0;
  let rx = refY * dz;
  let ry = -refX * dz;
  let rz = refX * dy - refY * dx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  outR[0] = rx; outR[1] = ry; outR[2] = rz;
  outU[0] = dy * rz - dz * ry;
  outU[1] = dz * rx - dx * rz;
  outU[2] = dx * ry - dy * rx;
}

const _fr = [0, 0, 0];
const _fu = [0, 0, 0];

// 把 count 根射线方向写进 dirs（长度 count*3）
// halfAngleDeg = 左右半角；vertHalfAngleDeg 缺省=左右。
// 上下用 u 轴、左右用 r 轴 —— PLAN 阶段可把竖直半角拉大补顶/底，
// 仍保持扇面朝前（不是整扇转成朝下多波束）。
export function buildFan(dx, dy, dz, halfAngleDeg, count, dirs, r = _fr, u = _fu, vertHalfAngleDeg) {
  dirs[0] = dx; dirs[1] = dy; dirs[2] = dz;
  if (count <= 1) return dirs;

  basisFor(dx, dy, dz, r, u);
  const aH = (halfAngleDeg * Math.PI) / 180;
  const aV = (((vertHalfAngleDeg == null) ? halfAngleDeg : vertHalfAngleDeg) * Math.PI) / 180;
  // 0,1 = 上/下（u）；2,3 = 左/右（r）
  const angles = [aV, aV, aH, aH];
  const offsets = [
    [u[0], u[1], u[2]],
    [-u[0], -u[1], -u[2]],
    [r[0], r[1], r[2]],
    [-r[0], -r[1], -r[2]],
  ];
  for (let k = 0; k < 4 && k + 1 < count; k += 1) {
    const o = (k + 1) * 3;
    const off = offsets[k];
    const c = Math.cos(angles[k]);
    const s = Math.sin(angles[k]);
    dirs[o] = dx * c + off[0] * s;
    dirs[o + 1] = dy * c + off[1] * s;
    dirs[o + 2] = dz * c + off[2] * s;
  }
  return dirs;
}

// 射线 vs 球（动态目标用）。返回最近正根，未命中 −1，法向写进 outNormal。
//
// 动态目标必须【和地形一样被测到】—— 传感器分不清那是石头还是一条鱼，
// 它只知道"前面 x 米有东西"。这正是本项目要处理的问题：
// 地图会被游动的生物污染，而分离它们只能靠自由空间雕刻，不能靠识别。
function raySphere(ox, oy, oz, dx, dy, dz, maxT, cx, cy, cz, r, outNormal) {
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return -1; // 起点在球外且背向球心
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq; // 起点在球内，取出射交点
  if (t < 0 || t > maxT) return -1;
  const hx = ox + dx * t, hy = oy + dy * t, hz = oz + dz * t;
  const nl = r || 1;
  outNormal[0] = (hx - cx) / nl;
  outNormal[1] = (hy - cy) / nl;
  outNormal[2] = (hz - cz) / nl;
  return t;
}

export class RaySensor {
  // boxes  : [{min:{x,y,z}, max:{x,y,z}}]  实体障碍
  // bounds : {min:{x,y,z}, max:{x,y,z}}    探测区包围盒（内壁也要被测到）
  constructor(boxes = [], bounds = null) {
    // 动态目标（大型生物）。不进空间网格 —— 它们每帧都在动，重建网格的
    // 代价远高于直接遍历这两三个球。
    this.dynamic = [];
    this.setWorld(boxes, bounds);
    this.setCount(0);

    // 每帧的临时量，预分配避免 GC
    this._dirs = new Float32Array(SENSOR.rayCount * 3);
    this._ts = new Float32Array(SENSOR.rayCount); // 各射线命中距离，−1 = 未命中
    this._bnd = new Uint8Array(SENSOR.rayCount); // 该根打中的是否为任务边界
    // 命中面编码：0=未命中，1=+X 2=-X 3=+Y 4=-Y 5=+Z 6=-Z
    // 建图要用【表面法向】做回退；沿射线回退在掠射时几乎不动法向分量，
    // 水平底座会整层稳定内陷。法向回退没有这个问题。
    this._faces = new Uint8Array(SENSOR.rayCount);
    this._normal = [0, 0, 0];
    this._basisR = [0, 0, 0];
    this._basisU = [0, 0, 0];
  }

  // 障碍从 {min,max} 对象拍平成连续数组：求交是内循环，属性链访问太贵
  setWorld(boxes, bounds) {
    this.boxCount = boxes.length;
    this.boxes = new Float32Array(boxes.length * 6);
    for (let i = 0; i < boxes.length; i += 1) {
      const b = boxes[i];
      const o = i * 6;
      this.boxes[o] = b.min.x;
      this.boxes[o + 1] = b.min.y;
      this.boxes[o + 2] = b.min.z;
      this.boxes[o + 3] = b.max.x;
      this.boxes[o + 4] = b.max.y;
      this.boxes[o + 5] = b.max.z;
    }
    this.bounds = bounds
      ? new Float32Array([
          bounds.min.x, bounds.min.y, bounds.min.z,
          bounds.max.x, bounds.max.y, bounds.max.z,
        ])
      : null;
    this._box = new Float32Array(6); // 求交时的滑动窗口视图
    this._buildGrid();
  }

  // ── 粗筛：均匀网格 ─────────────────────────────────────────────
  //
  // 朴素做法是每根射线遍历全部盒体。地形只有 5 个盒子时无所谓，
  // 变成阶梯状海沟后是 173 个 —— 260 台 × 5 根 × 173 = 每帧 22.5 万次求交。
  // 地图再放大就直接顶到帧预算了。
  //
  // 边长取【探测距离】：射线最远只走这么远，所以从所在格出发，
  // 任何一根射线最多够到相邻一格 —— 3×3×3 邻域就是完备的候选集。
  _buildGrid() {
    const cell = Math.max(SENSOR.range, 1);
    this._cell = cell;
    if (this.boxCount === 0) { this._grid = null; return; }

    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.boxCount; i += 1) {
      const o = i * 6;
      for (let a = 0; a < 3; a += 1) {
        if (this.boxes[o + a] < lo[a]) lo[a] = this.boxes[o + a];
        if (this.boxes[o + 3 + a] > hi[a]) hi[a] = this.boxes[o + 3 + a];
      }
    }
    this._origin = lo;
    this._dim = [0, 0, 0];
    for (let a = 0; a < 3; a += 1) {
      this._dim[a] = Math.max(1, Math.ceil((hi[a] - lo[a]) / cell) + 1);
    }
    const total = this._dim[0] * this._dim[1] * this._dim[2];
    const grid = new Array(total);
    for (let i = 0; i < total; i += 1) grid[i] = [];

    // 一个盒体跨多格就登记到每一格 —— 重复登记由查询端的访问标记去重
    for (let i = 0; i < this.boxCount; i += 1) {
      const o = i * 6;
      const c0 = this._cellCoord(this.boxes[o], this.boxes[o + 1], this.boxes[o + 2]);
      const c1 = this._cellCoord(this.boxes[o + 3], this.boxes[o + 4], this.boxes[o + 5]);
      for (let z = c0[2]; z <= c1[2]; z += 1)
        for (let y = c0[1]; y <= c1[1]; y += 1)
          for (let x = c0[0]; x <= c1[0]; x += 1)
            grid[(z * this._dim[1] + y) * this._dim[0] + x].push(i);
    }
    this._grid = grid;
    this._candidates = new Int32Array(this.boxCount);
    this._seen = new Int32Array(this.boxCount).fill(-1);
    this._stamp = 0;
  }

  _cellCoord(x, y, z) {
    const c = this._cell;
    const d = this._dim;
    return [
      Math.max(0, Math.min(d[0] - 1, Math.floor((x - this._origin[0]) / c))),
      Math.max(0, Math.min(d[1] - 1, Math.floor((y - this._origin[1]) / c))),
      Math.max(0, Math.min(d[2] - 1, Math.floor((z - this._origin[2]) / c))),
    ];
  }

  // 收集该位置 3×3×3 邻域内的盒体，写进 _candidates，返回个数。
  // 每台设备每帧只做一次，五根射线共用 —— 这是关键：粗筛按设备摊，不按射线。
  _gather(x, y, z) {
    if (!this._grid) return 0;
    const d = this._dim;
    const c = this._cellCoord(x, y, z);
    this._stamp += 1;
    let n = 0;
    for (let dz = -1; dz <= 1; dz += 1) {
      const cz = c[2] + dz;
      if (cz < 0 || cz >= d[2]) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        const cy = c[1] + dy;
        if (cy < 0 || cy >= d[1]) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const cx = c[0] + dx;
          if (cx < 0 || cx >= d[0]) continue;
          const bucket = this._grid[(cz * d[1] + cy) * d[0] + cx];
          for (let k = 0; k < bucket.length; k += 1) {
            const bi = bucket[k];
            if (this._seen[bi] === this._stamp) continue;
            this._seen[bi] = this._stamp;
            this._candidates[n] = bi;
            n += 1;
          }
        }
      }
    }
    return n;
  }

  setCount(n) {
    // 节流状态：每个个体记住上次发射时间与上次发射落入的体素
    this.lastEmit = new Float32Array(n);
    this.lastVoxel = new Int32Array(n);
    this.lastClear = new Float32Array(n);
    this.resetThrottle();
  }

  // 时间一旦回拨（重置仿真），残留的节流时间戳就落在"未来"，
  // `time - lastEmit` 恒为负、永远不满足发射条件 ——
  // 整条事件流会【静默死掉】：不报错、不崩溃，地图就是不再生长。
  // 所以重置必须连节流状态一起清，这也是同种子可复现的前提。
  resetThrottle() {
    this.lastEmit.fill(-Infinity);
    this.lastClear.fill(-Infinity);
    this.lastVoxel.fill(-1);
  }

  // 五根射线：中心 + 上下左右各偏 halfAngle。
  // 一根只看正前方，侧面来的墙躲不掉；而且一次触发只产出一条测量。
  // 五根一次给五条【来自不同角度】的测量 —— 这正是端点判定核想要的。
  _buildFan(dx, dy, dz, halfH, halfV) {
    buildFan(
      dx, dy, dz,
      halfH == null ? SENSOR.fanHalfAngleDeg : halfH,
      SENSOR.rayCount,
      this._dirs,
      this._basisR,
      this._basisU,
      halfV
    );
  }

  // 单根射线打候选盒体，返回最近 t（未命中 −1），法向写进 this._normal
  // 返回最近命中距离；同时把"这次命中的是不是任务包围盒内壁"写进
  // this.hitBoundary —— 包围盒不是地形，是我们自己画的框，不该进地图。
  _cast(ox, oy, oz, dx, dy, dz, candidateCount) {
    let best = -1;
    this.hitBoundary = false;
    const n = this._normal;
    const tmp = [0, 0, 0];
    const box = this._box;

    for (let ci = 0; ci < candidateCount; ci += 1) {
      const o = this._candidates[ci] * 6;
      for (let k = 0; k < 6; k += 1) box[k] = this.boxes[o + k];
      const t = rayAABB(ox, oy, oz, dx, dy, dz, SENSOR.range, box, tmp);
      if (t >= 0 && (best < 0 || t < best)) {
        best = t;
        n[0] = tmp[0]; n[1] = tmp[1]; n[2] = tmp[2];
      }
    }

    if (this.bounds) {
      const t = rayBoundsInside(
        ox, oy, oz, dx, dy, dz, SENSOR.range, this.bounds, tmp
      );
      if (t >= 0 && (best < 0 || t < best)) {
        best = t;
        this.hitBoundary = true;
        n[0] = tmp[0]; n[1] = tmp[1]; n[2] = tmp[2];
      }
    }

    // 动态目标最后测：数量少，且它们通常离得近，先测静态能提前剪枝
    for (let k = 0; k < this.dynamic.length; k += 1) {
      const d0 = this.dynamic[k];
      const t = raySphere(ox, oy, oz, dx, dy, dz, SENSOR.range,
        d0.position.x, d0.position.y, d0.position.z, d0.radius, tmp);
      if (t >= 0 && (best < 0 || t < best)) {
        best = t;
        this.hitBoundary = false; // 生物比包围盒近，标记要跟着换掉
        n[0] = tmp[0]; n[1] = tmp[1]; n[2] = tmp[2];
      }
    }
    return best;
  }

  // 对一个个体做一次扇形探测。
  //   写入 out = 避障期望方向（未归一化），返回 urgency ∈ [0,1]
  //   命中事件推给 bus（可为 null，算法侧因此能脱离 UI 独立跑）
  // profile（可选）：PLAN 阶段加宽竖直扇 / 略开水平扇。缺省=SENSOR 默认。
  sense(i, px, py, pz, vx, vy, vz, time, out, bus, profile) {
    out[0] = out[1] = out[2] = 0;
    const speed = Math.hypot(vx, vy, vz);
    if (speed < EPSILON) return 0;
    const dx = vx / speed;
    const dy = vy / speed;
    const dz = vz / speed;

    const halfH = profile && profile.fanHalfAngleDeg != null
      ? profile.fanHalfAngleDeg
      : SENSOR.fanHalfAngleDeg;
    const halfV = profile && profile.fanVertHalfAngleDeg != null
      ? profile.fanVertHalfAngleDeg
      : halfH;

    // 网格边长是按当时的探测距离定的，而探测距离是可实时拖的滑块。
    // 拖大之后 3×3×3 邻域不再完备，射线会静默漏掉远处的盒体 ——
    // 表现是"地图上凭空缺一块"，极难查。超了就重建。
    if (SENSOR.range > this._cell) this._buildGrid();

    this._buildFan(dx, dy, dz, halfH, halfV);
    const dirs = this._dirs;
    let urgency = 0;
    let anyHit = false;
    // 粗筛按【设备】摊一次，五根射线共用候选集
    const cand = this._gather(px, py, pz);

    // 发射保护时间：不满足就只算避障，不发事件。
    // 没有它，60 Hz × 260 台 × 5 根 ≈ 78000 事件/秒，带宽优势直接归零。
    const hitCanEmit = time - this.lastEmit[i] >= 1 / SENSOR.emitHz;
    const clearCanEmit = time - this.lastClear[i] >= 1 / SENSOR.clearHz;
    const ts = this._ts;
    const faces = this._faces;
    const bnd = this._bnd;

    for (let k = 0; k < SENSOR.rayCount; k += 1) {
      const o = k * 3;
      const rx = dirs[o];
      const ry = dirs[o + 1];
      const rz = dirs[o + 2];
      const t = this._cast(px, py, pz, rx, ry, rz, cand);
      ts[k] = t;
      // 打中的是任务包围盒内壁 → 仍然用于避障，但【不进地图】。
      // 它不是地形，是我们自己画的框；实测它占了点云的 28.4%。
      bnd[k] = this.hitBoundary ? 1 : 0;

      if (t < 0) {
        faces[k] = 0;
        // 这根是通的 —— 给它投一票，让个体往空处钻。
        // 只靠法向斥力会在正面撞墙时"顶住不动"（斥力与航向反平行）。
        out[0] += rx * SENSOR.openVote;
        out[1] += ry * SENSOR.openVote;
        out[2] += rz * SENSOR.openVote;
        continue;
      }

      anyHit = true;
      const n = this._normal;
      faces[k] = encodeFace(n[0], n[1], n[2]);
      const u = 1 - t / SENSOR.range;
      if (u > urgency) urgency = u;
      out[0] += n[0] * u;
      out[1] += n[1] * u;
      out[2] += n[2] * u;
    }

    // ── 一次发射 = 一条事件 ────────────────────────────────────
    //
    // 之前是五根射线各发一条，每条都带一份 origin —— 而它们【共用同一个
    // origin】，等于把它重复上传了五遍。方向同理：五根的朝向由航向加扇面
    // 几何完全决定，是可推导的，根本不必传。
    // 打包后一次发射从 5×32=160 字节降到 52 字节。
    //
    // 这不是取巧：真实声呐本来就是【一个 ping 发一包波束】，不是一束一包。
    //
    // 开阔水域（一根没中）也走同一条通道，只是频率低得多 ——
    // 掩码为 0 即"无回波"，而无回波本身就是一次有效测量：
    // 不发的话那片空间会永远停在"未知"。
    if (bus && ((anyHit && hitCanEmit) || (!anyHit && clearCanEmit))) {
      if (anyHit) this.lastEmit[i] = time;
      else this.lastClear[i] = time;
      bus.ping(px, py, pz, dx, dy, dz, halfH, ts, faces,
        bnd, SENSOR.rayCount, SENSOR.range, time, i, halfV);
    }

    return Math.min(1, urgency);
  }
}
