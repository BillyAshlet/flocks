// 猎物鱼群：Boid 三规则 + 恐慌传染。
//
// 恐慌系统整体移植自 heritage-or-evolution-lab-advx2026 的
// experiment-simulation.js（闩锁 / 不应期 / 脉冲信号 / 应急对齐 / 接收方增益），
// 逻辑未改，唯一改动是【威胁源】：原来遍历 NPC 捕食者鱼群，现在读玩家实时坐标。
//
// 按任务书要求，以下两项未迁移：
//   - 体型/角色切换阈值（所有鱼同尺寸，无角色分支）
//   - 双层捕食者聚合（只有玩家一个捕食者，不存在协同）

import { FLOCK, PANIC, TANK, AGENT, ALTITUDE, PLAN, SENSOR, RECALL } from './params.js';
import { RaySensor } from './sensor.js';
import { createAabbCollider } from './collision.js';

const EPSILON = 1e-8;

function normalize3(x, y, z) {
  const length = Math.hypot(x, y, z);
  if (length < EPSILON) return [0, 0, 0, 0];
  return [x / length, y / length, z / length, length];
}

// 期望方向 → 转向力：先归一化成期望速度，减当前速度，再钳到 maxForce。
// 这一步是原项目"力的量纲统一"，保证各规则权重之间可比。
function steerToward(dx, dy, dz, vx, vy, vz, maxSpeed, maxForce, out) {
  const desired = normalize3(dx, dy, dz);
  if (desired[3] < EPSILON) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  let sx = desired[0] * maxSpeed - vx;
  let sy = desired[1] * maxSpeed - vy;
  let sz = desired[2] * maxSpeed - vz;
  const magnitude = Math.hypot(sx, sy, sz);
  if (magnitude > maxForce) {
    const scale = maxForce / magnitude;
    sx *= scale;
    sy *= scale;
    sz *= scale;
  }
  out[0] = sx;
  out[1] = sy;
  out[2] = sz;
  return out;
}

function approach(current, target, rate, dt) {
  if (rate <= 0) return target;
  const step = (target - current) * Math.min(1, dt / rate);
  return current + step;
}

const STEER = [0, 0, 0];

export class Flock {
  // bus 可为 null —— 算法侧因此能脱离 UI 独立跑（headless），
  // 这是三模式对照实验能自动跑完、不用人肉点三遍的前提。
  constructor(obstacles = [], bus = null) {
    this.obstacles = obstacles;
    this.bus = bus;
    this.time = 0;
    // 缸壁也要被测到，否则地图上只有几个盒子悬在空中，没有海床没有沟壁
    const half = {
      min: { x: -TANK.width / 2, y: -TANK.height / 2, z: -TANK.depth / 2 },
      max: { x: TANK.width / 2, y: TANK.height / 2, z: TANK.depth / 2 },
    };
    this.sensor = new RaySensor(obstacles, half);
    // 硬碰撞世界：与传感器共用同一份障碍描述。换场景时换 collider 后端即可。
    this.collider = createAabbCollider(obstacles);
    // 终端下发的行为包（M2-lite）。null = 关闭前沿，boid 用原权重。
    this.terminal = null;
    this.setCount(FLOCK.count);
  }

  setTerminalParams(p) {
    this.terminal = p;
  }

  setCount(count) {
    const n = Math.max(1, Math.round(count));
    this.count = n;
    FLOCK.count = n;
    if (this.sensor) this.sensor.setCount(n);

    this.positions = new Float32Array(n * 3);
    this.velocities = new Float32Array(n * 3);

    this.separation = new Float32Array(n * 3);
    this.alignment = new Float32Array(n * 3);
    this.cohesion = new Float32Array(n * 3);
    this.alignCounts = new Uint16Array(n);
    this.cohesionCounts = new Uint16Array(n);

    // —— 恐慌状态 ——
    this.panic = new Float32Array(n);
    this.alarm = new Float32Array(n); // 离散脉冲，会衰减到零
    this.threatLevel = new Float32Array(n); // 本帧直接感知强度
    this.heardSignal = new Float32Array(n); // 本帧收到的社会信号
    this.neighborPanic = new Float32Array(n);
    this.directLatch = new Uint8Array(n);
    this.panicHold = new Float32Array(n);
    this.refractory = new Float32Array(n);
    this.escapeDir = new Float32Array(n * 3);
    this.emergencyAlign = new Float32Array(n * 3);
    this.emergencyUrgency = new Float32Array(n);

    // 子群编号。前沿探索时终端给每个子群【各自的目标】——
    // 全群共用一个目标点等于把 260 个探测器变成 1 个：实测群半径从 42.4
    // 塌到 14.5，点云产出反而掉 24%。
    this.group = new Uint8Array(n);

    this.wanderPhase = new Float32Array(n);
    this.wanderRate = new Float32Array(n);
    // 朝向与速度解耦：列阵速度→0 时若仍用 velocity 定向，数值噪声会让鱼原地疯转
    this.headings = new Float32Array(n * 3);

    this.reset();
  }

  reset() {
    const n = this.count;
    // 时间必须一起归零，且传感器节流状态要跟着清 —— 否则残留的时间戳
    // 落在"未来"，事件流会静默死掉（见 RaySensor.resetThrottle）。
    this.time = 0;
    this.departed = false;
    if (this.sensor) this.sensor.resetThrottle();
    // 集群【成团从上方入场】，不再满场散布。
    // 两个理由：一是真实任务本就是从母船一处投放；二是前沿探索有冷启动
    // 缺陷 —— 地图全为"未知"时一个前沿都不存在（前沿要求"自由且邻接未知"），
    // 必须先由集群游动雕出一个自由空间的气泡，前沿才得以出现。
    // 散布开局等于跳过了这一步，把不成立的初始条件藏起来了。
    const spread = FLOCK.cohesionRadius * 2.2;
    const entryY = TANK.height / 2 - FLOCK.wallMargin * 2;
    for (let i = 0; i < n; i += 1) {
      const o = i * 3;
      this.positions[o] = -TANK.width * 0.36 + (Math.random() * 2 - 1) * spread;
      this.positions[o + 1] = entryY - Math.random() * spread;
      this.positions[o + 2] = (Math.random() * 2 - 1) * spread;
      const angle = Math.random() * Math.PI * 2;
      this.velocities[o] = Math.cos(angle) * FLOCK.cruiseSpeed;
      this.velocities[o + 1] = (Math.random() * 2 - 1) * 0.2;
      this.velocities[o + 2] = Math.sin(angle) * FLOCK.cruiseSpeed;
      const hlen = Math.hypot(this.velocities[o], this.velocities[o + 1], this.velocities[o + 2]) || 1;
      this.headings[o] = this.velocities[o] / hlen;
      this.headings[o + 1] = this.velocities[o + 1] / hlen;
      this.headings[o + 2] = this.velocities[o + 2] / hlen;
      // 轮转分组：出生时子群在空间上是交织的，靠各自的目标飞散开 ——
      // 这比按初始位置切更稳，不会因为出生点形状不同而分得不均。
      this.group[i] = i % Math.max(1, FLOCK.groupCount);
      this.wanderPhase[i] = Math.random() * Math.PI * 2;
      this.wanderRate[i] = 0.6 + Math.random() * 0.9;
    }
    this.panic.fill(0);
    this.alarm.fill(0);
    this.directLatch.fill(0);
    this.panicHold.fill(0);
    this.refractory.fill(0);
  }

  // ── 感知：邻居配对 + 恐慌信号传播 ─────────────────────────────
  _pairPass() {
    const n = this.count;
    const pos = this.positions;
    const vel = this.velocities;

    this.separation.fill(0);
    this.alignment.fill(0);
    this.cohesion.fill(0);
    this.alignCounts.fill(0);
    this.cohesionCounts.fill(0);
    this.heardSignal.fill(0);
    this.neighborPanic.fill(0);
    this.emergencyAlign.fill(0);
    this.emergencyUrgency.fill(0);

    const sepR2 = FLOCK.separationRadius ** 2;
    const aliR2 = FLOCK.alignmentRadius ** 2;
    const cohR = FLOCK.cohesionRadius;
    const cohR2 = cohR * cohR;
    const maxR2 = Math.max(sepR2, aliR2, cohR2);
    const signalRadius = FLOCK.alignmentRadius * PANIC.signalRadiusFactor;
    const signalR2 = signalRadius * signalRadius;
    const cosFov = Math.cos((FLOCK.fovDegrees * Math.PI) / 360);

    for (let i = 0; i < n; i += 1) {
      const io = i * 3;
      for (let j = i + 1; j < n; j += 1) {
        const jo = j * 3;
        const dx = pos[io] - pos[jo];
        const dy = pos[io + 1] - pos[jo + 1];
        const dz = pos[io + 2] - pos[jo + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= maxR2 || d2 < EPSILON) continue;
        const distance = Math.sqrt(d2);
        const inv = 1 / distance;

        // 视锥：i 能否看见 j（-Δ 是 i→j 方向）
        const fi = normalize3(vel[io], vel[io + 1], vel[io + 2]);
        const fj = normalize3(vel[jo], vel[jo + 1], vel[jo + 2]);
        const seeIJ = (-dx * fi[0] - dy * fi[1] - dz * fi[2]) * inv >= cosFov;
        const seeJI = (dx * fj[0] + dy * fj[1] + dz * fj[2]) * inv >= cosFov;

        // —— 分离：1/d² 斥力，近距离远强于线性 ——
        if (d2 < sepR2) {
          const scale = 1 / d2;
          this.separation[io] += dx * scale;
          this.separation[io + 1] += dy * scale;
          this.separation[io + 2] += dz * scale;
          this.separation[jo] -= dx * scale;
          this.separation[jo + 1] -= dy * scale;
          this.separation[jo + 2] -= dz * scale;
        }

        // —— 应急对齐：恐慌航向走独立通道 ——
        // 它不会被大量镇定邻居平均掉，这是惊扰波真正的载体。
        const emitEmergency = (receiver, sender, canSee) => {
          if (!canSee || d2 >= signalR2) return false;
          const urgency = this.panic[sender];
          if (urgency < PANIC.signalThreshold) return false;
          const proximity = 1 - distance / signalRadius;
          const boost = PANIC.alignmentSourceBoost;
          const weight = proximity * urgency * (1 + boost * urgency * urgency);
          if (weight <= 1e-6) return false;
          const so = sender * 3;
          const heading = normalize3(vel[so], vel[so + 1], vel[so + 2]);
          const ro = receiver * 3;
          this.emergencyAlign[ro] += heading[0] * weight;
          this.emergencyAlign[ro + 1] += heading[1] * weight;
          this.emergencyAlign[ro + 2] += heading[2] * weight;
          const urgencySignal = proximity * urgency;
          if (urgencySignal > this.emergencyUrgency[receiver]) {
            this.emergencyUrgency[receiver] = urgencySignal;
          }
          return true;
        };
        const emergencyIJ = emitEmergency(i, j, seeIJ);
        const emergencyJI = emitEmergency(j, i, seeJI);

        // —— 对齐：应急通道接管时不再走普通对齐 ——
        if (d2 < aliR2) {
          if (seeIJ && !emergencyIJ) {
            this.alignment[io] += vel[jo];
            this.alignment[io + 1] += vel[jo + 1];
            this.alignment[io + 2] += vel[jo + 2];
            this.alignCounts[i] += 1;
          }
          if (seeJI && !emergencyJI) {
            this.alignment[jo] += vel[io];
            this.alignment[jo + 1] += vel[io + 1];
            this.alignment[jo + 2] += vel[io + 2];
            this.alignCounts[j] += 1;
          }
        }

        // —— 聚合 + 惊扰波传播 ——
        //
        // 聚合【只在同组内】生效：不然子群刚被派往不同前沿，就会被跨组的
        // 聚合力拉回来，拆分等于白做。分离保持全局（不同组之间也不能撞），
        // 惊扰波同样保持全局 —— 危险不分组。
        const sameGroup = this.group[i] === this.group[j];
        if (d2 < cohR2) {
          if (seeIJ && sameGroup) {
            this.cohesion[io] += pos[jo];
            this.cohesion[io + 1] += pos[jo + 1];
            this.cohesion[io + 2] += pos[jo + 2];
            this.cohesionCounts[i] += 1;
            // 社会信号传的是 alarm【脉冲】，不是 panic 值 ——
            // 脉冲会衰减到零，不会像连续值那样在鱼群里无限回响。
            const signal = this.alarm[j] * (1 - distance / cohR);
            if (signal > this.heardSignal[i]) this.heardSignal[i] = signal;
            if (this.panic[j] > this.neighborPanic[i]) {
              this.neighborPanic[i] = this.panic[j];
            }
          }
          if (seeJI && sameGroup) {
            this.cohesion[jo] += pos[io];
            this.cohesion[jo + 1] += pos[io + 1];
            this.cohesion[jo + 2] += pos[io + 2];
            this.cohesionCounts[j] += 1;
            const signalBack = this.alarm[i] * (1 - distance / cohR);
            if (signalBack > this.heardSignal[j]) {
              this.heardSignal[j] = signalBack;
            }
            if (this.panic[i] > this.neighborPanic[j]) {
              this.neighborPanic[j] = this.panic[i];
            }
          }
        }
      }
    }
  }

  // ── 威胁源：玩家（原项目此处遍历 NPC 捕食者鱼群）───────────────
  _senseThreat(threat) {
    const n = this.count;
    this.threatLevel.fill(0);
    this.escapeDir.fill(0);
    if (!threat) return;

    const radius = PANIC.panicRadius;
    const radius2 = radius * radius;
    const lead = PANIC.escapePredictionTime;
    // 支持多个威胁源。每条鱼只对【最近的那一头】反应 —— 而不是对所有
    // 威胁的平均位置反应。平均是错的：两头一左一右时，平均值落在鱼身上，
    // 逃逸方向会变成零。
    const sources = threat.members || [threat];

    for (let i = 0; i < n; i += 1) {
      const o = i * 3;
      let bestLevel = 0;
      let bx = 0, by = 0, bz = 0;

      for (const s of sources) {
        const dx = this.positions[o] - s.position.x;
        const dy = this.positions[o + 1] - s.position.y;
        const dz = this.positions[o + 2] - s.position.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > radius2) continue;
        const distance = Math.sqrt(Math.max(d2, EPSILON));
        // 距离衰减：贴脸的捕食者和边缘的捕食者不该产生同样的恐慌。
        const level = 1 - distance / radius;
        if (level <= bestLevel) continue;
        bestLevel = level;
        // 逃向捕食者【预测位置】的反方向，而不是它此刻在哪
        bx = dx - s.velocity.x * lead;
        by = dy - s.velocity.y * lead;
        bz = dz - s.velocity.z * lead;
      }

      if (bestLevel <= 0) continue;
      this.threatLevel[i] = bestLevel;
      const escape = normalize3(bx, by, bz);
      this.escapeDir[o] = escape[0];
      this.escapeDir[o + 1] = escape[1];
      this.escapeDir[o + 2] = escape[2];
    }
  }

  _boundaryForce(index, out) {
    const o = index * 3;
    const half = [TANK.width / 2, TANK.height / 2, TANK.depth / 2];
    const softness = FLOCK.edgeSoftness;
    out[0] = out[1] = out[2] = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = this.positions[o + axis];
      const negative = value + half[axis];
      const positive = half[axis] - value;
      if (negative < softness) out[axis] += 1 - negative / softness;
      if (positive < softness) out[axis] -= 1 - positive / softness;
    }
    return out;
  }

  step(dt, threat) {
    this.time += dt; // 事件时间戳与发射保护时间都用它
    this._pairPass();
    this._senseThreat(threat);

    const n = this.count;
    const pos = this.positions;
    const vel = this.velocities;
    const boundary = [0, 0, 0];
    const obstacle = [0, 0, 0];
    const baseMaxPitch = (FLOCK.maxPitchDegrees * Math.PI) / 180;
    const planMaxPitch = ((PLAN.maxPitchDegrees || FLOCK.maxPitchDegrees) * Math.PI) / 180;

    for (let i = 0; i < n; i += 1) {
      const o = i * 3;
      const vx = vel[o];
      const vy = vel[o + 1];
      const vz = vel[o + 2];

      // 召回离场后：停在原处，不再更新（场景层会隐藏）
      if (this.departed) {
        vel[o] = vel[o + 1] = vel[o + 2] = 0;
        continue;
      }

      // ══ 恐慌状态机（闩锁 + 不应期 + 脉冲）══════════════════
      const threatValue = this.threatLevel[i];
      const wasLatched = this.directLatch[i] === 1;
      // 滞回：越过 directOn 才闩上，掉到 directOff 以下才松开
      if (!wasLatched && threatValue >= PANIC.directOn) {
        this.directLatch[i] = 1;
      } else if (wasLatched && threatValue < PANIC.directOff) {
        this.directLatch[i] = 0;
      }
      const latched = this.directLatch[i] === 1;
      const enteredDirect = latched && !wasLatched;

      this.panicHold[i] = Math.max(0, this.panicHold[i] - dt);
      this.refractory[i] = Math.max(0, this.refractory[i] - dt);

      // 社会触发：信号够强、自己没被直接威胁闩住、且不在不应期内。
      // 不应期是关键 —— 没有它，脉冲会在鱼群里来回反射永不停止。
      let emitPulse = enteredDirect;
      if (
        !latched &&
        this.heardSignal[i] >= PANIC.signalThreshold &&
        this.refractory[i] <= 0
      ) {
        emitPulse = true;
        this.refractory[i] = PANIC.refractoryTime;
      }
      if (emitPulse) this.panicHold[i] = PANIC.holdTime;
      if (enteredDirect) {
        this.refractory[i] = Math.max(this.refractory[i], PANIC.refractoryTime);
      }

      // 惊吓期间恐慌被【钉在满值】，这才有四散而逃
      const panicTarget = Math.max(
        latched ? threatValue : 0,
        this.panicHold[i] > 0 ? 1 : 0
      );
      const rising = panicTarget > this.panic[i];
      this.panic[i] = approach(
        this.panic[i],
        panicTarget,
        rising ? PANIC.riseTime : PANIC.fallTime,
        dt
      );
      this.alarm[i] = emitPulse
        ? 1
        : this.alarm[i] * Math.exp(-dt / Math.max(PANIC.signalDecayTime, 1e-6));
      const panic = this.panic[i];

      // ══ 力的合成 ═══════════════════════════════════════════
      const term = this.terminal;
      const recallMode = term && term.mode === 'recall';
      // 召回途中速度可接近常态；列阵后（近阵/到位）再减速。
      // 遇捕食/恐慌才允许恐慌提速逃跑。
      const predatorDodge = recallMode && (panic > 0.2 || threatValue > 0.15);
      const maxSpeed = FLOCK.maxSpeed * (1 + (predatorDodge ? panic * PANIC.speedBoost : 0));
      const maxForce = FLOCK.maxForce;
      let fx = 0;
      let fy = 0;
      let fz = 0;
      const applyRule = (dxr, dyr, dzr, weight) => {
        if (weight === 0) return;
        steerToward(dxr, dyr, dzr, vx, vy, vz, maxSpeed, maxForce, STEER);
        fx += STEER[0] * weight;
        fy += STEER[1] * weight;
        fz += STEER[2] * weight;
      };
      const guided = term && (term.mode === 'plan' || term.mode === 'frontier' || recallMode) && (term.seekWeight > 0 || recallMode);
      const planMode = term && term.mode === 'plan';
      const maxPitch = planMode ? planMaxPitch : baseMaxPitch;
      // 列阵：弱化 boid，避免互相拉扯导致阵型一直晃
      const sepScale = recallMode ? 0.12 : guided ? term.separationScale : 1;
      const cohScale = recallMode ? 0.08 : guided ? term.cohesionScale : 1;
      const aliScale = recallMode ? 0.15 : guided ? term.alignmentScale : 1;

      applyRule(
        this.separation[o],
        this.separation[o + 1],
        this.separation[o + 2],
        FLOCK.separationWeight * sepScale
      );

      // 受惊时凝聚力下降 —— flash expansion
      const cohesionWeight =
        FLOCK.cohesionWeight * cohScale * Math.max(0, 1 - panic * PANIC.cohesionDrop);
      if (this.cohesionCounts[i] > 0) {
        const c = this.cohesionCounts[i];
        applyRule(
          this.cohesion[o] / c - pos[o],
          this.cohesion[o + 1] / c - pos[o + 1],
          this.cohesion[o + 2] / c - pos[o + 2],
          cohesionWeight
        );
      }

      // 接收方增益：自己越慌，越会去听邻居 —— 波才能一层层推下去
      const receiverBoost = Math.min(
        1 + PANIC.alignmentReceiverBoost * this.neighborPanic[i],
        PANIC.alignmentReceiverMax
      );
      if (this.alignCounts[i] > 0) {
        const a = this.alignCounts[i];
        applyRule(
          this.alignment[o] / a,
          this.alignment[o + 1] / a,
          this.alignment[o + 2] / a,
          FLOCK.alignmentWeight * aliScale * receiverBoost
        );
      }

      // 应急对齐：一条鱼看见危险，它的航向会压过二十条镇定邻居的平均值
      if (this.emergencyUrgency[i] > 0) {
        applyRule(
          this.emergencyAlign[o],
          this.emergencyAlign[o + 1],
          this.emergencyAlign[o + 2],
          PANIC.emergencyAlignmentWeight * this.emergencyUrgency[i]
        );
      }

      // 几何逃逸向量【只给直接看见玩家的鱼】。
      // 社会性恐慌的鱼只知道邻居航向，不知道玩家在哪 —— 否则等于全知。
      if (threatValue > 0) {
        applyRule(
          this.escapeDir[o],
          this.escapeDir[o + 1],
          this.escapeDir[o + 2],
          PANIC.escapeWeight * threatValue
        );
      }

      // 边界（召回列阵贴近盒顶，软边界会一直下推导致永远刹不住，故大幅削弱）
      this._boundaryForce(i, boundary);
      const boundaryUrgency = Math.min(
        1,
        Math.hypot(boundary[0], boundary[1], boundary[2])
      );
      if (boundaryUrgency > EPSILON) {
        const bw = recallMode
          ? FLOCK.boundaryWeight * 0.15
          : FLOCK.boundaryWeight;
        applyRule(
          boundary[0],
          boundary[1],
          boundary[2],
          bw * boundaryUrgency * (1 + boundaryUrgency * 2)
        );
      }

      // 障碍物 —— 射线扇。方向由五根射线合成，命中点同时作为事件发出。
      // 这是本项目的核心：测绘数据【就是】避障已经算出来的中间产物。
      const senseProfile = (term && term.mode === 'plan')
        ? {
            fanHalfAngleDeg: PLAN.sensorFanHalfDeg ?? SENSOR.fanHalfAngleDeg,
            fanVertHalfAngleDeg: PLAN.sensorFanVertHalfDeg ?? PLAN.sensorFanHalfDeg ?? SENSOR.fanHalfAngleDeg,
          }
        : null;
      const obstacleUrgency = this.sensor.sense(
        i,
        pos[o], pos[o + 1], pos[o + 2],
        vx, vy, vz,
        this.time,
        obstacle,
        this.bus,
        senseProfile
      );
      if (obstacleUrgency > EPSILON) {
        applyRule(
          obstacle[0],
          obstacle[1],
          obstacle[2],
          FLOCK.obstacleWeight * obstacleUrgency
        );
      }

      // 高度策略：
      // - ALTITUDE 开：虚拟天花板/任务底软墙 + 弱负浮力（不预知沟深）
      // - 否则可用旧 workingDepth 定深（对照）
      // TANK 缸壁是任务区边界，不是客观地形；真正的底靠射线避障 + 硬碰撞。
      if (ALTITUDE.enabled && !recallMode) {
        const y = pos[o + 1];
        const m = ALTITUDE.softMargin;
        const w = ALTITUDE.softWeight;
        // 软墙：只在贴边时推。默认 yMin 接近任务盒底，主要作用是天花板。
        if (m > 0 && w > 0) {
          const up = y - (ALTITUDE.yMax - m);
          if (up > 0) applyRule(0, -1, 0, w * Math.min(1, up / m));
          const dn = (ALTITUDE.yMin + m) - y;
          if (dn > 0) applyRule(0, 1, 0, w * Math.min(1, dn / m));
        }
        // 弱负浮力：持续轻微下探动机。真实底由障碍射线顶住，不会“钉死到某一深度”。
        const sink = ALTITUDE.sinkWeight || 0;
        if (sink > 0) applyRule(0, -1, 0, sink);
        // 带宽中线吸引默认 0；保留作失败方案对照
        const cw = ALTITUDE.centerWeight || 0;
        if (cw > 0) {
          const mid = 0.5 * (ALTITUDE.yMin + ALTITUDE.yMax);
          const dy = mid - y;
          const ad = Math.abs(dy);
          if (ad > 0.4) {
            applyRule(0, Math.sign(dy), 0, cw * Math.min(1, ad / 8));
          }
        }
      } else if (FLOCK.descentWeight > 0) {
        const dy = FLOCK.workingDepth - pos[o + 1];
        const gain = Math.min(1, Math.abs(dy) / Math.max(FLOCK.depthBand, 1e-6));
        if (gain > 0.02) {
          applyRule(0, Math.sign(dy), 0, FLOCK.descentWeight * gain);
        }
      }

      // 终端目标 / 召回列阵
      // 召回语义：到位后硬静止，关掉巡游；只有捕食/恐慌才破静止逃跑，逃完再回阵。
      let recallHolding = false;
      let recallSlot = null;
      let recallDist = 0;
      if (recallMode && term.slots && term.slots[i]) {
        recallSlot = term.slots[i];
        const sdx = recallSlot[0] - pos[o];
        const sdy = recallSlot[1] - pos[o + 1];
        const sdz = recallSlot[2] - pos[o + 2];
        recallDist = Math.hypot(sdx, sdy, sdz);
        const holdR = RECALL.holdRadius || 1.35;
        const settleR = RECALL.settleRadius || Math.max(holdR * 3, 4.5);
        // 只认捕食相关威胁；普通障碍/边界不再把阵型搅成“还在游”
        const dodging = predatorDodge;
        if (!dodging && recallDist <= holdR) {
          recallHolding = true;
          // 清空本帧力，后面积分直接钉死
          fx = fy = fz = 0;
        } else if (!dodging && recallDist <= settleR) {
          // 近阵：强刹车 + 弱归位，不再用巡航感的 seek
          applyRule(sdx, sdy, sdz, (term.seekWeight || 2.2) * 0.55);
          // 反向阻尼当前速度，避免到位后仍滑行
          applyRule(-vx, -vy, -vz, RECALL.brakeWeight || 8);
        } else {
          const w = dodging
            ? (RECALL.returnWeight || 2.8)
            : (term.seekWeight || 2.2);
          applyRule(sdx, sdy, sdz, w);
          if (!dodging) {
            // 途中也稍微抑速，防止“巡游式”冲阵
            applyRule(-vx, -vy, -vz, (RECALL.brakeWeight || 8) * 0.25);
          }
        }
      } else if (guided) {
        const tg = term.targets && term.targets.length
          ? term.targets[this.group[i] % term.targets.length]
          : term.target;
        if (tg) {
          applyRule(
            tg[0] - pos[o], tg[1] - pos[o + 1], tg[2] - pos[o + 2],
            term.seekWeight
          );
        }
        const vw = term.verticalWeight || 0;
        if (vw > 0) {
          let bob = Math.sin(this.time * 0.9 + i * 0.37);
          if (tg) {
            const dy = tg[1] - pos[o + 1];
            if (Math.abs(dy) > 1.5) bob = Math.sign(dy);
          }
          applyRule(0, bob, 0, vw);
        }
      }

      // 游走噪声：列阵静止时关闭
      this.wanderPhase[i] += dt * this.wanderRate[i];
      const phase = this.wanderPhase[i];
      const wScale = recallHolding ? 0 : recallMode ? 0.05 : 1;
      fx += Math.sin(phase * 1.31) * FLOCK.wanderWeight * wScale;
      fy += Math.sin(phase * 1.73 + 2.1) * FLOCK.wanderWeight * 0.4 * wScale;
      fz += Math.cos(phase * 1.17) * FLOCK.wanderWeight * wScale;

      // ══ 积分：转向限速 + 俯仰钳制 + 速度钳制 ═══════════════
      const force = normalize3(fx, fy, fz);
      const magnitude = Math.min(maxForce, force[3]);
      let nvx = vx + force[0] * magnitude * dt;
      let nvy = vy + force[1] * magnitude * dt;
      let nvz = vz + force[2] * magnitude * dt;

      const oldDir = normalize3(vx, vy, vz);
      const newDir = normalize3(nvx, nvy, nvz);
      const dot = Math.max(
        -1,
        Math.min(1, oldDir[0] * newDir[0] + oldDir[1] * newDir[1] + oldDir[2] * newDir[2])
      );
      const angle = Math.acos(dot);
      // 恐慌时转向能力提升；列阵后还要锁角速度（线速度慢但乱转 = 原地陀螺）
      let turnSpeed = FLOCK.turnSpeed * (1 + panic * PANIC.panicTurnBoost);
      if (recallMode && !predatorDodge) {
        const holdR = RECALL.holdRadius || 1.2;
        const settleR = RECALL.settleRadius || 3.5;
        const holdTurn = RECALL.holdTurnScale ?? 0;
        if (recallHolding || (recallSlot && recallDist <= holdR)) {
          turnSpeed = 0; // 到位：朝向完全冻结
        } else if (recallSlot && recallDist <= settleR) {
          // 近阵：线速度在降，角速度同步压到几乎不能转
          const t = Math.max(0, (recallDist - holdR) / Math.max(1e-6, settleR - holdR));
          turnSpeed *= Math.max(holdTurn, 0.05) * t * t;
        }
      }
      // 当前线速度很低时也限制转向，避免 v≈0 时方向向量噪声导致疯转
      const curSpd = Math.hypot(vx, vy, vz);
      if (!predatorDodge && curSpd < FLOCK.cruiseSpeed * 0.2) {
        turnSpeed *= Math.max(0.02, curSpd / Math.max(1e-6, FLOCK.cruiseSpeed * 0.2));
      }
      const alpha = angle <= EPSILON || turnSpeed <= EPSILON ? (turnSpeed <= EPSILON ? 0 : 1) : Math.min(1, (turnSpeed * dt) / angle);
      let turned = normalize3(
        oldDir[0] * (1 - alpha) + newDir[0] * alpha,
        oldDir[1] * (1 - alpha) + newDir[1] * alpha,
        oldDir[2] * (1 - alpha) + newDir[2] * alpha
      );
      // 速度/力都近零时 keep 旧朝向，不要用零向量
      if (turned[3] < EPSILON) {
        turned = normalize3(this.headings[o], this.headings[o + 1], this.headings[o + 2]);
        if (turned[3] < EPSILON) turned = [1, 0, 0, 1];
      }

      // 俯仰钳制：鱼不像潜艇那样垂直上下游
      const horizontal = Math.hypot(turned[0], turned[2]);
      const pitch = Math.atan2(turned[1], Math.max(horizontal, EPSILON));
      if (Math.abs(pitch) > maxPitch) {
        turned = normalize3(
          turned[0],
          Math.max(horizontal, EPSILON) * Math.tan(Math.sign(pitch) * maxPitch),
          turned[2]
        );
      }

      // 列阵硬静止：位置钉死、线速度清零，但 headings 保留（渲染用）
      if (recallHolding && recallSlot) {
        pos[o] = recallSlot[0];
        pos[o + 1] = recallSlot[1];
        pos[o + 2] = recallSlot[2];
        vel[o] = vel[o + 1] = vel[o + 2] = 0;
        // 朝向冻结：不写回 turned
      } else {
        let speed = newDir[3];
        // 非召回才维持 cruiseSpeed；召回途中允许接近常态速度
        if (!recallMode && speed < FLOCK.cruiseSpeed) {
          speed = approach(speed, FLOCK.cruiseSpeed, 0.35, dt);
        }
        if (recallMode) {
          const holdR = RECALL.holdRadius || 1.2;
          const settleR = RECALL.settleRadius || 3.5;
          if (predatorDodge) {
            // 遇捕食：正常恐慌速度
            speed = Math.min(speed, maxSpeed);
          } else if (recallSlot && recallDist <= settleR) {
            // 列阵后：线速度压低；hold 内目标 0
            const t = Math.max(0, (recallDist - holdR) / Math.max(1e-6, settleR - holdR));
            const cap = (RECALL.approachSpeed || FLOCK.cruiseSpeed * 0.3) * t * t;
            if (force[3] < 1e-4) speed = approach(speed, 0, 0.12, dt);
            speed = Math.min(speed, cap);
          } else {
            // 召回途中：速度保持常态巡航，不提前慢动作
            if (speed < FLOCK.cruiseSpeed) {
              speed = approach(speed, FLOCK.cruiseSpeed, 0.35, dt);
            }
            speed = Math.min(speed, maxSpeed);
          }
        } else {
          speed = Math.min(speed, maxSpeed);
        }

        vel[o] = turned[0] * speed;
        vel[o + 1] = turned[1] * speed;
        vel[o + 2] = turned[2] * speed;
        pos[o] += vel[o] * dt;
        pos[o + 1] += vel[o + 1] * dt;
        pos[o + 2] += vel[o + 2] * dt;

        // 有实际位移速度时才更新朝向；慢速/列阵时 turned 已被限角
        if (speed > 1e-4) {
          this.headings[o] = turned[0];
          this.headings[o + 1] = turned[1];
          this.headings[o + 2] = turned[2];
        }
      }

      // 硬碰撞：积分之后把球壳从实体里推出去。
      // 软射线避障仍负责提前转向；这里负责 separation/panic 把鱼挤进墙后的兜底。
      // 没有这一步，进墙后 rayAABB 会把当前盒子当成透明，点云就会在墙内生成。
      if (this.collider) {
        const fixed = this.collider.resolve(
          pos[o], pos[o + 1], pos[o + 2],
          AGENT.bodyRadius,
          vel[o], vel[o + 1], vel[o + 2]
        );
        pos[o] = fixed.x;
        pos[o + 1] = fixed.y;
        pos[o + 2] = fixed.z;
        vel[o] = fixed.vx;
        vel[o + 1] = fixed.vy;
        vel[o + 2] = fixed.vz;
      } else {
        // 无 collider 时退回旧的包围盒硬边界
        const hx = TANK.width / 2 - FLOCK.wallMargin;
        const hy = TANK.height / 2 - FLOCK.wallMargin;
        const hz = TANK.depth / 2 - FLOCK.wallMargin;
        if (pos[o] > hx || pos[o] < -hx) {
          pos[o] = Math.max(-hx, Math.min(hx, pos[o]));
          vel[o] *= -0.5;
        }
        if (pos[o + 1] > hy || pos[o + 1] < -hy) {
          pos[o + 1] = Math.max(-hy, Math.min(hy, pos[o + 1]));
          vel[o + 1] *= -0.5;
        }
        if (pos[o + 2] > hz || pos[o + 2] < -hz) {
          pos[o + 2] = Math.max(-hz, Math.min(hz, pos[o + 2]));
          vel[o + 2] *= -0.5;
        }
      }

      // 虚拟高度带硬墙：天花板/地板，不是持续力
      if (ALTITUDE.enabled && ALTITUDE.hard) {
        const r = AGENT.bodyRadius;
        const yLo = ALTITUDE.yMin + r;
        const yHi = ALTITUDE.yMax - r;
        if (pos[o + 1] < yLo) {
          pos[o + 1] = yLo;
          if (vel[o + 1] < 0) vel[o + 1] = 0;
        } else if (pos[o + 1] > yHi) {
          pos[o + 1] = yHi;
          if (vel[o + 1] > 0) vel[o + 1] = 0;
        }
      }

      // 碰撞/边界推挤后仍要钉回阵位，否则下一帧又被判定“未到位”重新加速
      // 注意：只清线速度，不清 headings —— 否则渲染会回落到默认朝向乱转
      if (recallHolding && recallSlot && !predatorDodge) {
        pos[o] = recallSlot[0];
        pos[o + 1] = recallSlot[1];
        pos[o + 2] = recallSlot[2];
        vel[o] = vel[o + 1] = vel[o + 2] = 0;
      }
    }
  }

  // 供 HUD 显示：平均恐慌 + 有多少鱼处于恐慌
  metrics() {
    let sum = 0;
    let panicking = 0;
    for (let i = 0; i < this.count; i += 1) {
      sum += this.panic[i];
      if (this.panic[i] > 0.35) panicking += 1;
    }
    return { average: sum / this.count, panicking, total: this.count };
  }
}
