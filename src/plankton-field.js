/**
 * 浮游场：**有位置的颗粒**，不是一池数。
 *
 * ── 为什么不是全局标量 ──────────────────────────────────────────────
 * 原来 `planktonLevel` 是一个数，任何位置的鱼从同一个数里扣；那 700 个
 * 可视点是建场时随机撒一次、位置永不改变的，靠比例决定「显示前几个」——
 * 上缸的鱼吃东西下缸的点也会消失。**那是一根画成星星点点的进度条**，
 * 画面在断言一个模型里不存在的空间食物。
 *
 * ── 为什么是实体而不是网格浓度场 ────────────────────────────────────
 * 1. **场太平滑，平滑就会退回阶跃。** 场里每条鱼都能拿到「一些」，拿多少
 *    由算术决定 —— 确定性 = 阶跃函数，正是耐力那一课的老毛病。颗粒是
 *    离散的：「旁边刚好有 / 没有」，这个 lumpiness 才是个体差异的来源，
 *    而个体差异累起来才是群体层面的存活率梯度。
 * 2. **觅食更简单也更像真的。** 场要爬浓度梯度（均匀区域里梯度会消失）；
 *    颗粒只要「附近有几颗」。高密度时自动变成滤食 —— 两种摄食模式
 *    （particulate / filter）是涌现的，不是编码的。
 * 3. **斑块能自己维持。** 初始就成斑块，被吃空的地方要等重生。
 *
 * ── 为什么是「次数」不是「质量」 ────────────────────────────────────
 * 一颗能被吃 N 口，用完消失，过 `regrowSeconds` 整颗回来。
 * 比连续质量 + logistic 好在两处：没有浮点累积；而且
 * **「一颗被吃空之后 20 秒回来」比「growthRate = 0.12」好想得多** ——
 * 逐关配置的重置时间就是字面的秒数。N = 1 就是「先到先得、一条鱼吃掉
 * 一颗」那个竞争最凶的版本。
 *
 * 见 ECOLOGY-DECISIONS.md §2。
 */
import { SeededRng } from './experiment-model.js';

const clampTo = (value, limit) =>
  value > limit ? limit : value < -limit ? -limit : value;

export class SpatialPlanktonField {
  constructor(config, seed = 1) {
    this.config = config;
    this.rng = new SeededRng((Number(seed) ^ 0x9e3779b9) >>> 0);
    const count = Math.max(1, Math.round(config.plankton.visualCount || 1));
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.uses = new Uint8Array(count);
    this.spentAt = new Float32Array(count);
    this.now = 0;

    this.usesPerParticle = Math.max(
      1,
      Math.round(config.plankton.usesPerParticle ?? 3)
    );
    this.regrowSeconds = Math.max(
      0.1,
      config.plankton.regrowSeconds ?? 20
    );
    // 【全场以「口」为单位计量】。
    //
    // 曾经用 perUse = capacity / (颗数 × 每颗次数) 把口换算成「存量」，
    // 结果一口 = 0.167 而 maxIntakePerFish = 0.04 —— 一口比一次摄入上限还大
    // 四倍，鱼永远吃不下哪怕一口。根子是两个独立来源的数没有共同尺度。
    //
    // 现在不换算了：availableAt 返回【口数】，maxIntakePerFish 是
    // 【每次最多吃几口】，halfSaturation 也是口。全场食物 = 颗数 × 每颗口数，
    // 全部可数、全部同一个单位。（plankton.capacity 因此不再参与计算，
    // 它留在配置里只是历史；第六步一起清理。）

    // 【进食半径】够得着吃的距离；【感知半径】看得见食物的距离。
    // 感知复用鱼的感知尺度：「能看见鱼多远就能看见食物多远」，不新增参数。
    this.reach = Math.max(1e-4, config.plankton.forageRadius ?? 0.12);
    this.sense = Math.max(this.reach, config.plankton.senseRadius ?? 0.6);

    this._buildGrid();
    this.reset();
  }

  /**
   * 定长网格，**不是 Map + 字符串键**。缸是有界的、格数固定，直接用扁平
   * 数组下标 —— 现有的 SpatialHash3D 每次查询要拼 27 个字符串，679 条鱼时
   * 每秒约 220 万次分配（见 ECOLOGY-DECISIONS.md §7）。不重蹈那个覆辙。
   *
   * 格边长取【感知半径】而不是进食半径：这样找食扫 3×3×3 格就够，
   * 吃则扫同样 27 格再按较小的进食半径过滤 —— 一个网格、一种扫法、两个半径。
   */
  _buildGrid() {
    const tank = this.config.tank;
    this.cell = this.sense;
    this.dim = [
      Math.max(1, Math.ceil(tank.width / this.cell)),
      Math.max(1, Math.ceil(tank.height / this.cell)),
      Math.max(1, Math.ceil(tank.depth / this.cell)),
    ];
    this.origin = [-tank.width / 2, -tank.height / 2, -tank.depth / 2];
    const cells = this.dim[0] * this.dim[1] * this.dim[2];
    this.cellStart = new Int32Array(cells + 1);
    this.cellItems = new Int32Array(this.count);
    this._counts = new Int32Array(cells);
    this._dirty = true;
  }

  /** 初始分布【成斑块，不均匀撒】。均匀分布会让「游过去找食」失去意义。 */
  reset() {
    const margin = this.config.tank.wallMargin;
    const half = [
      Math.max(0, this.config.tank.width / 2 - margin),
      Math.max(0, this.config.tank.height / 2 - margin),
      Math.max(0, this.config.tank.depth / 2 - margin),
    ];
    // 斑块半径取进食半径的三倍：一片云要装得下一小群鱼，
    // 「一群一起吃饱 / 一起错过」才成立。
    const spread = this.reach * 3;
    const patchSize = Math.max(4, Math.round(this.count / 24));
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < this.count; i += 1) {
      if (i % patchSize === 0) {
        cx = this.rng.range(-half[0], half[0]);
        cy = this.rng.range(-half[1], half[1]);
        cz = this.rng.range(-half[2], half[2]);
      }
      const o = i * 3;
      this.positions[o] = clampTo(cx + this.rng.range(-spread, spread), half[0]);
      this.positions[o + 1] = clampTo(cy + this.rng.range(-spread, spread), half[1]);
      this.positions[o + 2] = clampTo(cz + this.rng.range(-spread, spread), half[2]);
      this.uses[i] = this.usesPerParticle;
      this.spentAt[i] = 0;
    }
    this.now = 0;
    this._dirty = true;
  }

  get remainingUses() {
    let sum = 0;
    for (let i = 0; i < this.count; i += 1) sum += this.uses[i];
    return sum;
  }

  /** 全场食物总量，单位是【口】。 */
  get capacity() {
    return this.count * this.usesPerParticle;
  }

  /** 过渡用：外部还在读写「浮游总量」这个概念。单位同样是口。 */
  get level() {
    return this.remainingUses;
  }

  set level(value) {
    const full = this.capacity;
    let left = Math.max(0, Math.min(full, Math.round(value)));
    for (let i = 0; i < this.count; i += 1) {
      const give = Math.min(this.usesPerParticle, left);
      this.uses[i] = give;
      left -= give;
    }
    this._dirty = true;
  }

  get fraction() {
    return this.capacity > 0 ? this.remainingUses / this.capacity : 0;
  }

  get hasFood() {
    for (let i = 0; i < this.count; i += 1) {
      if (this.uses[i] > 0) return true;
    }
    return false;
  }

  /**
   * Holling-II 的半饱和常数，**单位是口**。
   *
   * 参照量取「食物铺满整缸时，一条鱼够得着的那几口」—— 于是
   * halfSaturationFraction 的含义不变（相对于一份满食的多少算半饱和），
   * 只是参照系从整缸换成了一条鱼的可及范围，单位从抽象存量换成了口。
   */
  get halfSaturation() {
    const tank = this.config.tank;
    const tankVolume = Math.max(
      1e-9,
      tank.width * tank.height * tank.depth
    );
    const reachVolume = (4 / 3) * Math.PI * this.reach ** 3;
    const usesInReach = this.capacity * (reachVolume / tankVolume);
    return (
      usesInReach *
      Math.max(0, this.config.plankton.halfSaturationFraction ?? 0)
    );
  }

  /** 被吃空的颗粒到点就整颗回来。**不是**逐渐长回来 —— 就是回来。 */
  regrow(dt) {
    if (!this.config.plankton.enabled) return;
    this.now += dt;
    const ready = this.now - this.regrowSeconds;
    for (let i = 0; i < this.count; i += 1) {
      if (this.uses[i] > 0) continue;
      if (this.spentAt[i] <= ready) {
        this.uses[i] = this.usesPerParticle;
        this._dirty = true;
      }
    }
  }

  /** 这一带够得着吃的【口数】。**局部**，不是全场。 */
  availableAt(x, y, z) {
    let sum = 0;
    this._forEachNear(x, y, z, this.reach, (p) => {
      sum += this.uses[p];
    });
    return sum;
  }

  /**
   * 找食用的方向：感知范围内所有颗粒的加权重心。
   *
   * 【不是「朝最近那一颗」】—— 只有一颗时鱼会死盯着它抖。
   * 权重 = 剩余次数 / 距离（**1/d 不是 1/d²**：平方衰减会让鱼死盯最近那颗，
   * 又回到抖动；1/d 保留「朝一片密的地方去」，同时近的确实更有分量）。
   * 范围内一颗都没有就返回 null —— 鱼不知道往哪走，不假装它有信息。
   */
  directionAt(x, y, z) {
    let dx = 0;
    let dy = 0;
    let dz = 0;
    let total = 0;
    this._forEachNear(x, y, z, this.sense, (p, d2) => {
      const d = Math.sqrt(d2);
      if (d < 1e-6) return;
      const w = this.uses[p] / d;
      const o = p * 3;
      dx += (this.positions[o] - x) * w;
      dy += (this.positions[o + 1] - y) * w;
      dz += (this.positions[o + 2] - z) * w;
      total += w;
    });
    if (total <= 0) return null;
    return [dx / total, dy / total, dz / total];
  }

  /** 从这一带取走，**近的先吃**。返回实际取到的量。 */
  take(x, y, z, amount) {
    if (!(amount > 0)) return 0;
    const near = [];
    this._forEachNear(x, y, z, this.reach, (p, d2) => near.push([d2, p]));
    if (!near.length) return 0;
    near.sort((a, b) => a[0] - b[0]);
    // 单位是口，所以只能整口地取。请求 2.7 口就取 2 口。
    let left = Math.floor(amount);
    let taken = 0;
    for (const [, p] of near) {
      while (left > 0 && this.uses[p] > 0) {
        this.uses[p] -= 1;
        left -= 1;
        taken += 1;
        if (this.uses[p] === 0) this.spentAt[p] = this.now;
      }
      if (left <= 0) break;
    }
    this._dirty = true;
    return taken;
  }

  /** 计数排序式重建：两趟 O(n)，零分配。 */
  _reindex() {
    this._counts.fill(0);
    for (let i = 0; i < this.count; i += 1) {
      if (this.uses[i] === 0) continue;
      const o = i * 3;
      this._counts[
        this._cellIndex(this.positions[o], this.positions[o + 1], this.positions[o + 2])
      ] += 1;
    }
    let running = 0;
    for (let c = 0; c < this._counts.length; c += 1) {
      this.cellStart[c] = running;
      running += this._counts[c];
    }
    this.cellStart[this._counts.length] = running;
    const cursor = this._counts;
    for (let c = 0; c < cursor.length; c += 1) cursor[c] = this.cellStart[c];
    for (let i = 0; i < this.count; i += 1) {
      if (this.uses[i] === 0) continue;
      const o = i * 3;
      const c = this._cellIndex(
        this.positions[o],
        this.positions[o + 1],
        this.positions[o + 2]
      );
      this.cellItems[cursor[c]] = i;
      cursor[c] += 1;
    }
    this._dirty = false;
  }

  _cellIndex(x, y, z) {
    const ix = Math.min(
      this.dim[0] - 1,
      Math.max(0, Math.floor((x - this.origin[0]) / this.cell))
    );
    const iy = Math.min(
      this.dim[1] - 1,
      Math.max(0, Math.floor((y - this.origin[1]) / this.cell))
    );
    const iz = Math.min(
      this.dim[2] - 1,
      Math.max(0, Math.floor((z - this.origin[2]) / this.cell))
    );
    return (iz * this.dim[1] + iy) * this.dim[0] + ix;
  }

  /** 扫 3×3×3 格，对半径内还有次数的每颗调用 cb(index, 距离平方)。 */
  _forEachNear(x, y, z, radius, cb) {
    if (this._dirty) this._reindex();
    const r2 = radius * radius;
    const bx = Math.floor((x - this.origin[0]) / this.cell);
    const by = Math.floor((y - this.origin[1]) / this.cell);
    const bz = Math.floor((z - this.origin[2]) / this.cell);
    for (let iz = bz - 1; iz <= bz + 1; iz += 1) {
      if (iz < 0 || iz >= this.dim[2]) continue;
      for (let iy = by - 1; iy <= by + 1; iy += 1) {
        if (iy < 0 || iy >= this.dim[1]) continue;
        for (let ix = bx - 1; ix <= bx + 1; ix += 1) {
          if (ix < 0 || ix >= this.dim[0]) continue;
          const c = (iz * this.dim[1] + iy) * this.dim[0] + ix;
          for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k += 1) {
            const p = this.cellItems[k];
            if (this.uses[p] === 0) continue;
            const o = p * 3;
            const ddx = this.positions[o] - x;
            const ddy = this.positions[o + 1] - y;
            const ddz = this.positions[o + 2] - z;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 <= r2) cb(p, d2);
          }
        }
      }
    }
  }
}
