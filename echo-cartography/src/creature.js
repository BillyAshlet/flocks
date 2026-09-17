// 大型生物 —— 自主游弋的动态威胁源，取代原来的玩家。
//
// 换掉玩家不只是"少一个操作模式"。本项目要证明的是集群在【无人干预】下
// 完成测绘 —— 手里握着一条鱼，整个论点就变成了表演。
//
// 它同时是建图算法的对手：这东西会动，所以它在点云里留下的痕迹必须能被
// 自由空间雕刻抹掉。没有它，"区分静态几何与动态目标"这件事无从验证。
//
// 对 Flock 只暴露 { position, velocity } —— 与原来的玩家接口一致。
// 本文件不 import three.js。

import { CREATURE, TANK } from './params.js';

class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
}

// 盒体避让 —— 取盒上最近点求外推方向。
//
// 这里【故意不用射线扇】：射线扇的产物是测量数据，那是集群设备才有的能力。
// 一条鱼不应该产生测绘事件，它只需要不撞墙。用两套机制反而更诚实。
//
// 返回紧迫度 [0,1]，外推方向写进 out。
function boxAvoid(x, y, z, boxes, softness, out) {
  out[0] = out[1] = out[2] = 0;
  let urgency = 0;
  for (const b of boxes) {
    const cx = Math.max(b.min.x, Math.min(x, b.max.x));
    const cy = Math.max(b.min.y, Math.min(y, b.max.y));
    const cz = Math.max(b.min.z, Math.min(z, b.max.z));
    let dx = x - cx, dy = y - cy, dz = z - cz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > softness) continue;

    if (dist < 1e-6) {
      // 已经陷在盒体内部：沿【穿透最浅的那个轴】推出去。
      // 固定往上推是错的 —— 陷进侧壁时会被顶着往上蹭，蹭出一路穿模。
      const px = Math.min(x - b.min.x, b.max.x - x);
      const py = Math.min(y - b.min.y, b.max.y - y);
      const pz = Math.min(z - b.min.z, b.max.z - z);
      if (px <= py && px <= pz) { dx = x - (b.min.x + b.max.x) / 2 >= 0 ? 1 : -1; dy = dz = 0; }
      else if (py <= pz) { dy = y - (b.min.y + b.max.y) / 2 >= 0 ? 1 : -1; dx = dz = 0; }
      else { dz = z - (b.min.z + b.max.z) / 2 >= 0 ? 1 : -1; dx = dy = 0; }
      out[0] += dx * 2; out[1] += dy * 2; out[2] += dz * 2;
      urgency = 1;
      continue;
    }

    const close = 1 - dist / softness;
    out[0] += (dx / dist) * close;
    out[1] += (dy / dist) * close;
    out[2] += (dz / dist) * close;
    if (close > urgency) urgency = close;
  }
  return urgency;
}

export class Creature {
  constructor(seed = 0, obstacles = []) {
    this.position = new Vec3();
    this.velocity = new Vec3();
    this.obstacles = obstacles;
    this.phase = seed * 2.7 + 0.3;
    // 被人接管时，自主游走整段跳过 —— 速度由 Pilot 写入，
    // 但避障【仍然生效】：驾驶时也不该穿墙。
    this.piloted = false;
    this._avoid = [0, 0, 0];
    this.reset(seed);
  }

  reset(seed = 0) {
    const hx = TANK.width / 2 - CREATURE.margin;
    const hz = TANK.depth / 2 - CREATURE.margin;
    this.position.x = (seed % 2 === 0 ? -1 : 1) * hx * 0.6;
    // 出生在沟沿之上的开阔水域，不要落在山峰丛里 ——
    // 从岩体内部起步会让它第一帧就在解穿透，看起来像被弹出来
    this.position.y = TANK.height * 0.12;
    this.position.z = (seed % 2 === 0 ? 1 : -1) * hz * 0.4;
    this.velocity.x = seed % 2 === 0 ? CREATURE.speed : -CREATURE.speed;
    this.velocity.y = 0;
    this.velocity.z = 0;
  }

  step(dt) {
    const speed = CREATURE.speed;
    // 地形避让对【自主与驾驶两种模式都生效】—— 驾驶时也不该穿墙。
    // 之前漏了这一步，大鱼是直接从岩体里穿过去的。
    const clearance = CREATURE.bodyRadius + CREATURE.avoidMargin;
    const urgency = boxAvoid(
      this.position.x, this.position.y, this.position.z,
      this.obstacles, clearance, this._avoid
    );

    if (!this.piloted) {
      this.phase += dt * CREATURE.turnRate;
      const p = this.phase;

      // 三个不同周期的正弦叠加 —— 互质的频率不会短周期内重复，
      // 看起来像在漫游而不是在跑固定路线。
      let dx = Math.cos(p * 1.0);
      let dy = Math.sin(p * 0.37) * 0.35;
      let dz = Math.sin(p * 0.73);

      // 撞壁前转向：越靠近壁面，反向分量越强
      const hx = TANK.width / 2 - CREATURE.margin;
      const hy = TANK.height / 2 - CREATURE.margin;
      const hz = TANK.depth / 2 - CREATURE.margin;
      const push = (v, half) => {
        if (v > half) return -((v - half) / CREATURE.margin);
        if (v < -half) return -((v + half) / CREATURE.margin);
        return 0;
      };
      dx += push(this.position.x, hx) * 3;
      dy += push(this.position.y, hy) * 3;
      dz += push(this.position.z, hz) * 3;

      // 地形避让权重最大 —— 它得压过游走噪声，否则会顺着岩壁一路蹭进去
      const w = CREATURE.avoidWeight * urgency;
      dx += this._avoid[0] * w;
      dy += this._avoid[1] * w;
      dz += this._avoid[2] * w;

      const len = Math.hypot(dx, dy, dz) || 1;
      // 平滑转向而非瞬间换向，否则鱼群的逃逸预测（escapePredictionTime）
      // 会指向一个下一帧就不存在的方向
      const blend = Math.min(1, dt * 2.2);
      this.velocity.x += ((dx / len) * speed - this.velocity.x) * blend;
      this.velocity.y += ((dy / len) * speed - this.velocity.y) * blend;
      this.velocity.z += ((dz / len) * speed - this.velocity.z) * blend;
    } else if (urgency > 0) {
      // 驾驶模式：不夺走操控，只叠一个外推速度。
      // 直接改写 velocity 会让手感变成"撞墙后被弹开"，很难受；
      // 叠加则表现为"贴着墙滑过去"。
      const w = speed * urgency;
      this.velocity.x += this._avoid[0] * w * dt * 6;
      this.velocity.y += this._avoid[1] * w * dt * 6;
      this.velocity.z += this._avoid[2] * w * dt * 6;
    }

    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;

    // 硬解算兜底：转向是软的，高速时仍可能一帧内插进岩体。
    //
    // 必须【迭代】。地形从 5 个盒子变成 333 个山峰阶梯之后，一次外推经常
    // 只是把它从一个盒子推进相邻那个 —— 实测两头大鱼都会永久嵌死在夹角里。
    // 每次推完重新求解，直到脱离或用完次数。
    for (let iter = 0; iter < 4; iter += 1) {
      const u = boxAvoid(
        this.position.x, this.position.y, this.position.z,
        this.obstacles, clearance, this._avoid
      );
      if (u < 0.999) break; // 只有真正陷在体内才硬推
      const l = Math.hypot(this._avoid[0], this._avoid[1], this._avoid[2]) || 1;
      const outStep = clearance * 0.8;
      this.position.x += (this._avoid[0] / l) * outStep;
      this.position.y += (this._avoid[1] / l) * outStep;
      this.position.z += (this._avoid[2] / l) * outStep;
      // 速度也要跟着改向，否则下一帧又原方向撞回去，来回抖
      this.velocity.x = (this._avoid[0] / l) * speed;
      this.velocity.y = (this._avoid[1] / l) * speed;
      this.velocity.z = (this._avoid[2] / l) * speed;
    }

    // 包围盒硬钳制
    const clamp = (v, half) => Math.max(-half, Math.min(half, v));
    this.position.x = clamp(this.position.x, TANK.width / 2 - 1);
    this.position.y = clamp(this.position.y, TANK.height / 2 - 1);
    this.position.z = clamp(this.position.z, TANK.depth / 2 - 1);
  }
}

// 多头生物。Flock._senseThreat 认 `.members`，每条鱼对最近的那一头反应。
export class CreaturePack {
  constructor(obstacles = [], n = CREATURE.count) {
    this.members = [];
    for (let i = 0; i < n; i += 1) this.members.push(new Creature(i, obstacles));
  }

  step(dt) {
    for (const c of this.members) c.step(dt);
  }

  reset() {
    this.members.forEach((c, i) => c.reset(i));
  }
}
