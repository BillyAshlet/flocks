// L3 建图：占据栅格 + 三维 DDA。
//
// 这是整个项目真正的新代码 —— 前面所有东西都是为了把事件送到这里。
//
// 为什么存栅格而不是存点：原始点云是 O(时间)，体素栅格是 O(空间)。
// 任务时长没有上界，空间有。存点的话跑一小时内存就爆了，存栅格永远不涨。
//
// 本文件不 import three.js。

import { TANK, MAP } from './params.js';

export class OccupancyGrid {
  constructor() {
    this.voxel = MAP.voxel;
    this.dim = [
      Math.ceil(TANK.width / this.voxel),
      Math.ceil(TANK.height / this.voxel),
      Math.ceil(TANK.depth / this.voxel),
    ];
    this.origin = [-TANK.width / 2, -TANK.height / 2, -TANK.depth / 2];
    this.total = this.dim[0] * this.dim[1] * this.dim[2];

    // 净证据。用 Int16 而不是 Float32：内存减半，而证据本来就只需要整数级
    // 分辨率（命中 +1、雕除 −1），浮点精度在这里没有意义。
    this.evidence = new Int16Array(this.total);

    // 已判定为占据的体素列表 + 反查表。
    // 渲染每帧扫全部 300 万格是不可能的，所以维护一个增量列表：
    // 证据越过阈值时入列，之后只更新入列过的那些。
    this.occupied = new Int32Array(MAP.maxPoints);
    this.occupiedCount = 0;
    this.slotOf = new Int32Array(this.total).fill(-1);

    // 本帧需要重画的槽位（新入列的，以及因出列被末位填补的）
    this.dirtySlots = [];

    // 自由体素列表（evidence 足够负）。前沿只在这些格子邻域上长。
    //
    // 容量【不能】和占据列表共用 maxPoints —— 两者数量级完全不同：
    // 占据只覆盖表面（实测 5 万），自由要填满整个已探空间（实测 60 万，
    // 上限是整个栅格）。共用 40 万上限时自由列表会满，之后新雕出来的
    // 自由体素不再登记，前沿检测就只能看到一份【残缺的自由空间】——
    // 表现是探索目标乱跳或干脆不动，而且不报错。
    this.free = new Int32Array(this.total);
    this.freeCount = 0;
    this.freeSlotOf = new Int32Array(this.total).fill(-1);

    // ── 粗栅格（前沿探索用，见 MAP.coarseFactor 的说明）──
    const F = MAP.coarseFactor;
    this.coarseFactor = F;
    this.cdim = [
      Math.ceil(this.dim[0] / F),
      Math.ceil(this.dim[1] / F),
      Math.ceil(this.dim[2] / F),
    ];
    this.ctotal = this.cdim[0] * this.cdim[1] * this.cdim[2];
    this.cellVolume = F * F * F;
    // 每个粗格里已确认自由 / 已确认占据的体素数，在 _bump 里增量维护。
    // 用时重新统计的话，就等于把省下来的那次全图扫描又加回去了。
    this.cFree = new Int32Array(this.ctotal);
    this.cOcc = new Int32Array(this.ctotal);

    this.rayCount = 0;
    this.hitCount = 0;
  }

  index(ix, iy, iz) {
    return (iz * this.dim[1] + iy) * this.dim[0] + ix;
  }

  // 体素中心的世界坐标
  centerOf(idx, out) {
    const d = this.dim;
    const ix = idx % d[0];
    const iy = ((idx / d[0]) | 0) % d[1];
    const iz = (idx / (d[0] * d[1])) | 0;
    out[0] = this.origin[0] + (ix + 0.5) * this.voxel;
    out[1] = this.origin[1] + (iy + 0.5) * this.voxel;
    out[2] = this.origin[2] + (iz + 0.5) * this.voxel;
    return out;
  }

  // 体素证据 → 三态。占据栅格的标准三态，也是前沿探索的输入。
  static classOf(e) {
    if (e >= MAP.occupiedThreshold) return 1;
    if (e <= MAP.freeThreshold) return -1;
    return 0;
  }

  // 粗格中心的世界坐标
  coarseCenter(cidx, out) {
    const d = this.cdim;
    const F = this.coarseFactor;
    const cx = cidx % d[0];
    const cy = ((cidx / d[0]) | 0) % d[1];
    const cz = (cidx / (d[0] * d[1])) | 0;
    out[0] = this.origin[0] + (cx + 0.5) * F * this.voxel;
    out[1] = this.origin[1] + (cy + 0.5) * F * this.voxel;
    out[2] = this.origin[2] + (cz + 0.5) * F * this.voxel;
    return out;
  }

  // 粗格三态。注意"能走"与"有实体"不互斥 —— 一格里既有岩壁又有空隙时，
  // 它仍然是可通行的，只是不空旷。所以先判自由，再判实体。
  coarseState(cidx) {
    if (this.cFree[cidx] >= this.cellVolume * MAP.coarseFreeRatio) return -1;
    if (this.cOcc[cidx] > 0) return 1;
    return 0;
  }

  _bump(ix, iy, iz, delta) {
    const d = this.dim;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= d[0] || iy >= d[1] || iz >= d[2]) return;
    const idx = this.index(ix, iy, iz);
    const prev = this.evidence[idx];
    let e = prev + delta;
    if (e > MAP.evidenceMax) e = MAP.evidenceMax;
    if (e < MAP.evidenceMin) e = MAP.evidenceMin;
    this.evidence[idx] = e;

    // 粗格计数增量维护。只在体素【跨越了状态边界】时动，
    // 所以绝大多数 _bump 调用在这里是一次比较就返回。
    const c0 = OccupancyGrid.classOf(prev);
    const c1 = OccupancyGrid.classOf(e);
    if (c0 !== c1) {
      const F = this.coarseFactor;
      const ci =
        (((iz / F) | 0) * this.cdim[1] + ((iy / F) | 0)) * this.cdim[0] +
        ((ix / F) | 0);
      if (c0 === -1) this.cFree[ci] -= 1;
      else if (c0 === 1) this.cOcc[ci] -= 1;
      if (c1 === -1) this.cFree[ci] += 1;
      else if (c1 === 1) this.cOcc[ci] += 1;
    }

    // —— 占据列表 ——
    const slot = this.slotOf[idx];
    if (e >= MAP.occupiedThreshold) {
      if (slot < 0 && this.occupiedCount < MAP.maxPoints) {
        const s = this.occupiedCount;
        this.occupied[s] = idx;
        this.slotOf[idx] = s;
        this.occupiedCount += 1;
        this.dirtySlots.push(s);
      }
    } else if (slot >= 0) {
      const last = this.occupiedCount - 1;
      const movedIdx = this.occupied[last];
      this.occupied[slot] = movedIdx;
      this.slotOf[movedIdx] = slot;
      this.slotOf[idx] = -1;
      this.occupiedCount = last;
      if (slot !== last) this.dirtySlots.push(slot);
    }

    // —— 自由列表（前沿提取用，O(自由格) 而非 O(全图)）——
    const freeT = MAP.freeThreshold;
    const fslot = this.freeSlotOf[idx];
    if (e <= freeT) {
      if (fslot < 0 && this.freeCount < this.total) {
        const s = this.freeCount;
        this.free[s] = idx;
        this.freeSlotOf[idx] = s;
        this.freeCount += 1;
      }
    } else if (fslot >= 0) {
      const last = this.freeCount - 1;
      const movedIdx = this.free[last];
      this.free[fslot] = movedIdx;
      this.freeSlotOf[movedIdx] = fslot;
      this.freeSlotOf[idx] = -1;
      this.freeCount = last;
    }
  }

  // ── 三维 DDA（Amanatides & Woo 1987）─────────────────────────
  //
  // 从 origin 沿射线走格，直到端点。命中时端点 +hit，沿途 −carve。
  //
  // 端点【不能只更新它落进的那一格】：同一面墙被两台设备从略微不同的角度
  // 打中，两个端点落进相邻两格各得 1 分，而中间那格被两条射线穿过、被雕成
  // 负分 —— 证据互相抵消，墙反而消失了。所以端点用一个小核（见 _splat）。
  integrateRay(ox, oy, oz, hx, hy, hz, hit, nx = 0, ny = 0, nz = 0) {
    this.rayCount += 1;
    const v = this.voxel;
    const o = this.origin;

    let dx = hx - ox, dy = hy - oy, dz = hz - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    dx /= len; dy /= len; dz /= len;

    // 表面回退：必须沿【命中法向】推进到自由空间，再 floor 入格。
    //
    // 沿射线回退是错的：掠射打水平底座时 dy≈0，回退几乎不改 Y，
    // 整层台阶顶面仍被决定性地吸进实体内侧 —— 看起来就像横跨整个底座
    // 的固定深度内陷层。PLY 已证实 y=-19.7/-3.5/-13.1 等层 78%+ 在实体内。
    //
    // 法向由传感器在求交时得到（AABB 只有 6 个方向），指向自由空间。
    // surfaceBias 以体素边长为单位，0.5 = 沿法向推出半格。
    let ehx = hx;
    let ehy = hy;
    let ehz = hz;
    if (hit) {
      const bias = v * Math.max(0, MAP.surfaceBias);
      if (nx !== 0 || ny !== 0 || nz !== 0) {
        ehx = hx + nx * bias;
        ehy = hy + ny * bias;
        ehz = hz + nz * bias;
      } else {
        // 旧事件/缺法向时的退路：沿射线回退（对掠射无效，但总比不退好）
        const pull = Math.min(bias, Math.max(0, len - 1e-6));
        ehx = hx - dx * pull;
        ehy = hy - dy * pull;
        ehz = hz - dz * pull;
      }
    }

    let ix = Math.floor((ox - o[0]) / v);
    let iy = Math.floor((oy - o[1]) / v);
    let iz = Math.floor((oz - o[2]) / v);
    const ex = Math.floor((ehx - o[0]) / v);
    const ey = Math.floor((ehy - o[1]) / v);
    const ez = Math.floor((ehz - o[2]) / v);

    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

    // 到下一个格边界的参数距离；轴向分量为 0 时永不跨越该轴
    const big = Infinity;
    const nextBoundary = (i, step, start, d) => {
      if (step === 0) return big;
      const edge = o[d] + (step > 0 ? i + 1 : i) * v;
      return (edge - start) / (d === 0 ? dx : d === 1 ? dy : dz);
    };
    let tMaxX = nextBoundary(ix, stepX, ox, 0);
    let tMaxY = nextBoundary(iy, stepY, oy, 1);
    let tMaxZ = nextBoundary(iz, stepZ, oz, 2);
    const tDeltaX = stepX === 0 ? big : Math.abs(v / dx);
    const tDeltaY = stepY === 0 ? big : Math.abs(v / dy);
    const tDeltaZ = stepZ === 0 ? big : Math.abs(v / dz);

    // 步数上限：按【入格端点】距离算。命中回退后端点更近，用原始 len
    // 只是多走几步，但终点单元格已变，仍以 ex,ey,ez 为准。
    const endLen = Math.hypot(ehx - ox, ehy - oy, ehz - oz);
    const maxSteps = Math.ceil(endLen / v) + 3;
    for (let s = 0; s < maxSteps; s += 1) {
      if (ix === ex && iy === ey && iz === ez) break;
      // 沿途是自由空间 —— 射线穿过即证明为空。这就是自由空间雕刻：
      // 唯一能把证据【减回去】的反证，也是分离动态目标的全部依据。
      if (MAP.carveWeight > 0) this._bump(ix, iy, iz, -MAP.carveWeight);

      if (tMaxX < tMaxY && tMaxX < tMaxZ) { ix += stepX; tMaxX += tDeltaX; }
      else if (tMaxY < tMaxZ) { iy += stepY; tMaxY += tDeltaY; }
      else { iz += stepZ; tMaxZ += tDeltaZ; }
    }

    if (hit) {
      this.hitCount += 1;
      this._splat(ex, ey, ez, dx, dy, dz);
    }
  }

  // 端点判定核：端点满权，六个面邻居减权。
  // 核不能再大 —— 越大地图越"厚"，窄缝会被糊死，而穿越窄缝正是要演示的。
  //
  // 核是【单侧】的：只往射线来的那一侧外扩，不往实体内部扩。
  // 对称外扩的话，六个邻居里有一半落在表面【里面】—— 实测点云有 41%
  // 的点浅陷在实体内。那些点不是错的（它们在表面 1 格内），但它们既没有
  // 信息量，又让壳变厚、窄缝更容易被糊死。
  // 判据就是射线方向：与射线同向的邻居 = 更深入实体，跳过。
  _splat(ix, iy, iz, dx, dy, dz) {
    this._bump(ix, iy, iz, MAP.hitWeight);
    const side = MAP.kernelWeight;
    if (side <= 0) return;
    // 点乘 > 0 即"在射线前进方向上"= 实体内侧。留一点余量给掠射角。
    const EPS = 0.15;
    if (dx < EPS) this._bump(ix + 1, iy, iz, side);
    if (-dx < EPS) this._bump(ix - 1, iy, iz, side);
    if (dy < EPS) this._bump(ix, iy + 1, iz, side);
    if (-dy < EPS) this._bump(ix, iy - 1, iz, side);
    if (dz < EPS) this._bump(ix, iy, iz + 1, side);
    if (-dz < EPS) this._bump(ix, iy, iz - 1, side);
  }

  // 从事件总线消费一批事件
  consume(bus, events) {
    for (const e of events) {
      if (e.type !== 'ping') continue;
      bus.forEachRay(e, (ox, oy, oz, hx, hy, hz, hit, nx, ny, nz) => {
        this.integrateRay(ox, oy, oz, hx, hy, hz, hit, nx, ny, nz);
      });
    }
  }

  reset() {
    this.evidence.fill(0);
    this.slotOf.fill(-1);
    this.occupiedCount = 0;
    this.dirtySlots.length = 0;
    this.freeSlotOf.fill(-1);
    this.freeCount = 0;
    this.cFree.fill(0);
    this.cOcc.fill(0);
    this.rayCount = 0;
    this.hitCount = 0;
  }

  // ── 水平覆盖率（俯视投影）────────────────────────────────
  //
  // 把粗栅格沿【高度】压扁，只问"这一根 xz 立柱底下有没有测到东西"。
  // 忽略高度是有意的：判断"这片区域扫过没有"要的是俯视覆盖，
  // 而不是"每一层都探明了"—— 后者要等到任务结束才可能满足。
  //
  // 它是自由巡游 → 前沿探索的切换判据：巡游负责把整片区域铺一遍，
  // 铺够了再让前沿去啃细节。反过来先开前沿，集群会一头扎进最近的
  // 边界，大片区域根本没去过（实测覆盖率反而更低）。
  //
  // 前提是【地板必须存在】—— 否则开阔水域下方的立柱永远命中不了，
  // 这个比例永远到不了阈值。
  columnCoverage() {
    const d = this.cdim;
    let hit = 0;
    for (let cz = 0; cz < d[2]; cz += 1) {
      for (let cx = 0; cx < d[0]; cx += 1) {
        for (let cy = 0; cy < d[1]; cy += 1) {
          if (this.cOcc[(cz * d[1] + cy) * d[0] + cx] > 0) { hit += 1; break; }
        }
      }
    }
    return hit / (d[0] * d[2]);
  }

  // 俯视热力图（仅显示用，不影响前沿/覆盖判据）。
  //
  // 决策侧粗格是 8×voxel ≈ 4.8 m，直接画会像马赛克。
  // 显示侧用更细的 xz bin（默认 2 个体素 = 1.2 m），从 free/occupied
  // 稀疏列表涂色，不扫全图。
  //   0 = 未知  1 = 仅自由  2 = 见过占据
  // 返回 { map, width, height, bin }，map 可复用。
  fillPlanMap(out, binVoxels = 2) {
    const bin = Math.max(1, binVoxels | 0);
    const width = Math.ceil(this.dim[0] / bin);
    const height = Math.ceil(this.dim[2] / bin);
    const n = width * height;
    if (!out || out.length < n) out = new Uint8Array(n);
    else out.fill(0, 0, n);

    const d0 = this.dim[0];
    const d1 = this.dim[1];
    const paint = (idx, kind) => {
      const ix = idx % d0;
      const iz = (idx / (d0 * d1)) | 0;
      const px = (ix / bin) | 0;
      const pz = (iz / bin) | 0;
      const o = pz * width + px;
      if (kind > out[o]) out[o] = kind;
    };

    // 先自由后占据，占据覆盖自由
    for (let s = 0; s < this.freeCount; s += 1) paint(this.free[s], 1);
    for (let s = 0; s < this.occupiedCount; s += 1) paint(this.occupied[s], 2);

    return { map: out, width, height, bin };
  }

  get coverage() {
    return this.occupiedCount / this.total;
  }

  // ── 导出 ────────────────────────────────────────────────────
  //
  // 用 PLY 而不是自定义扩展名：CloudCompare / MeshLab / Open3D / Blender
  // 都能直接打开 PLY，导出的东西要能被【别的工具】读，才算真的导出来了。
  //
  // 带上 confidence 标量：点云不只是几何，每个点还有"被观测了多少次"，
  // 那是本项目区分地形与生物的依据，丢掉就白做了。
  toPLY() {
    const c = [0, 0, 0];
    const n = this.occupiedCount;
    const head =
      'ply\nformat ascii 1.0\n' +
      'comment Echo Cartography - reconstructed from obstacle-avoidance events\n' +
      `comment voxel ${this.voxel} m, grid ${this.dim.join('x')}\n` +
      `comment rays ${this.rayCount}, hits ${this.hitCount}\n` +
      `element vertex ${n}\n` +
      'property float x\nproperty float y\nproperty float z\n' +
      'property float confidence\n' +
      'end_header\n';
    // 分块拼接：60000 个点一次 join 会造出一个巨大的中间数组，
    // 分块能让 GC 有机会回收
    const parts = [head];
    const CHUNK = 8192;
    let buf = [];
    for (let s = 0; s < n; s += 1) {
      this.centerOf(this.occupied[s], c);
      const conf = Math.max(0, this.evidence[this.occupied[s]]) / MAP.evidenceMax;
      buf.push(
        `${c[0].toFixed(3)} ${c[1].toFixed(3)} ${c[2].toFixed(3)} ${conf.toFixed(3)}`
      );
      if (buf.length >= CHUNK) { parts.push(buf.join('\n') + '\n'); buf = []; }
    }
    if (buf.length) parts.push(buf.join('\n') + '\n');
    return parts.join('');
  }
}
