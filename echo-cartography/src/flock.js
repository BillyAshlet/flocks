// prey school: the three boid rules plus panic contagion.
//
// the panic system was ported wholesale from experiment-simulation.js in
// heritage-or-evolution-lab-advx2026 (latch / refractory period / pulse
// signal / emergency alignment / receiver gain). the logic is unchanged; the
// only change is the threat source: it used to iterate over the NPC predator
// school, and now it reads the player's live coordinates.
//
// per the brief, these two were not ported:
//   - body-size / role switching thresholds (all fish are the same size,
//     with no role branching)
//   - two-tier predator aggregation (the player is the only predator, so
//     there is no coordination)

import { FLOCK, PANIC, TANK, AGENT, ALTITUDE, PLAN, SENSOR, RECALL } from './params.js';
import { RaySensor } from './sensor.js';
import { createAabbCollider } from './collision.js';

const EPSILON = 1e-8;

function normalize3(x, y, z) {
  const length = Math.hypot(x, y, z);
  if (length < EPSILON) return [0, 0, 0, 0];
  return [x / length, y / length, z / length, length];
}

// desired direction -> steering force: normalize into a desired velocity,
// subtract the current velocity, then clamp to maxForce. this step is the
// original project's "unification of the dimensions of force", which keeps
// the per-rule weights comparable with each other.
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
  // bus may be null, so the algorithm side can run independently of the UI
  // (headless). that is the precondition for the three-mode comparison
  // experiment being able to run to completion on its own, instead of
  // someone clicking through it three times by hand.
  constructor(obstacles = [], bus = null) {
    this.obstacles = obstacles;
    this.bus = bus;
    this.time = 0;
    // the tank walls have to be measured too, otherwise the map is just a
    // few boxes hanging in mid-air with no seabed and no trench walls
    const half = {
      min: { x: -TANK.width / 2, y: -TANK.height / 2, z: -TANK.depth / 2 },
      max: { x: TANK.width / 2, y: TANK.height / 2, z: TANK.depth / 2 },
    };
    this.sensor = new RaySensor(obstacles, half);
    // hard-collision world: shares the same obstacle description as the
    // sensor. for another scene, just swap the collider backend.
    this.collider = createAabbCollider(obstacles);
    // behavior packet pushed down by the terminal (M2-lite). null = frontier
    // off, boid uses its original weights.
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

    // —— panic state ——
    this.panic = new Float32Array(n);
    this.alarm = new Float32Array(n); // discrete pulse, decays to zero
    this.threatLevel = new Float32Array(n); // direct sensing strength this frame
    this.heardSignal = new Float32Array(n); // social signal received this frame
    this.neighborPanic = new Float32Array(n);
    this.directLatch = new Uint8Array(n);
    this.panicHold = new Float32Array(n);
    this.refractory = new Float32Array(n);
    this.escapeDir = new Float32Array(n * 3);
    this.emergencyAlign = new Float32Array(n * 3);
    this.emergencyUrgency = new Float32Array(n);

    // subgroup id. during frontier exploration the terminal gives each
    // subgroup its own target. one shared target point for the whole swarm
    // turns 260 probes into 1: measured swarm radius collapsed from 42.4 to
    // 14.5, and point-cloud output actually dropped 24%.
    this.group = new Uint8Array(n);

    this.wanderPhase = new Float32Array(n);
    this.wanderRate = new Float32Array(n);
    // heading decoupled from velocity: when formation speed goes to 0, still
    // deriving the heading from velocity lets numerical noise spin the fish
    // wildly in place
    this.headings = new Float32Array(n * 3);

    this.reset();
  }

  reset() {
    const n = this.count;
    // time has to be zeroed along with the rest, and the sensor's throttle
    // state cleared with it — otherwise leftover timestamps sit in the
    // "future" and the event stream dies silently (see
    // RaySensor.resetThrottle).
    this.time = 0;
    this.departed = false;
    if (this.sensor) this.sensor.resetThrottle();
    // the swarm enters from above as one clump, instead of being scattered
    // across the whole tank. two reasons: first, a real mission drops the
    // devices from a single point on the mother ship; second, frontier
    // exploration has a cold-start flaw — when the map is entirely "unknown"
    // not a single frontier exists (a frontier requires "free and adjacent
    // to unknown"), so the swarm has to swim and carve out a bubble of free
    // space first before any frontier can appear. a scattered start skips
    // that step and hides an initial condition that does not hold.
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
      // round-robin grouping: at spawn the subgroups are spatially
      // interleaved and pull apart via their own targets. this is steadier
      // than splitting by initial position, which divides unevenly whenever
      // the spawn region has a different shape.
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

  // ── sensing: neighbor pairing + panic signal spread ────────────────────
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

        // view cone: can i see j (-Δ is the direction from i to j)
        const fi = normalize3(vel[io], vel[io + 1], vel[io + 2]);
        const fj = normalize3(vel[jo], vel[jo + 1], vel[jo + 2]);
        const seeIJ = (-dx * fi[0] - dy * fi[1] - dz * fi[2]) * inv >= cosFov;
        const seeJI = (dx * fj[0] + dy * fj[1] + dz * fj[2]) * inv >= cosFov;

        // —— separation: 1/d² repulsion, far stronger up close than linear ——
        if (d2 < sepR2) {
          const scale = 1 / d2;
          this.separation[io] += dx * scale;
          this.separation[io + 1] += dy * scale;
          this.separation[io + 2] += dz * scale;
          this.separation[jo] -= dx * scale;
          this.separation[jo + 1] -= dy * scale;
          this.separation[jo + 2] -= dz * scale;
        }

        // —— emergency alignment: panic headings get their own channel ——
        // it does not get averaged away by a crowd of calm neighbors, and it
        // is what actually carries the startle wave.
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

        // —— alignment: skipped once the emergency channel takes over ——
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

        // —— cohesion + startle wave propagation ——
        //
        // cohesion only applies within the same group: otherwise subgroups
        // that were just sent off to different frontiers get pulled straight
        // back by cross-group cohesion, and the split was for nothing.
        // separation stays global (devices in different groups must not
        // collide either), and the startle wave stays global too — danger
        // does not respect groups.
        const sameGroup = this.group[i] === this.group[j];
        if (d2 < cohR2) {
          if (seeIJ && sameGroup) {
            this.cohesion[io] += pos[jo];
            this.cohesion[io + 1] += pos[jo + 1];
            this.cohesion[io + 2] += pos[jo + 2];
            this.cohesionCounts[i] += 1;
            // the social signal carries the alarm pulse, not the panic
            // value — a pulse decays to zero, instead of echoing around the
            // school forever the way a continuous value would.
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

  // ── threat source: the player (originally an NPC predator school) ──────
  _senseThreat(threat) {
    const n = this.count;
    this.threatLevel.fill(0);
    this.escapeDir.fill(0);
    if (!threat) return;

    const radius = PANIC.panicRadius;
    const radius2 = radius * radius;
    const lead = PANIC.escapePredictionTime;
    // multiple threat sources are supported. each fish reacts only to the
    // nearest one, rather than to the average position of all threats.
    // averaging is wrong: with one threat on each side the average lands on
    // the fish itself, and the escape direction comes out zero.
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
        // distance falloff: a predator right in your face and one at the
        // edge of the radius should not produce the same panic.
        const level = 1 - distance / radius;
        if (level <= bestLevel) continue;
        bestLevel = level;
        // flee away from the predator's predicted position, not from where
        // it happens to be at this instant
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
    this.time += dt; // event timestamps and the emission guard window both use it
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

      // after departing on recall: stop in place and stop updating (the
      // scene layer hides them)
      if (this.departed) {
        vel[o] = vel[o + 1] = vel[o + 2] = 0;
        continue;
      }

      // ══ panic state machine (latch + refractory + pulse) ═══════════════
      const threatValue = this.threatLevel[i];
      const wasLatched = this.directLatch[i] === 1;
      // hysteresis: latches only past directOn, releases only below directOff
      if (!wasLatched && threatValue >= PANIC.directOn) {
        this.directLatch[i] = 1;
      } else if (wasLatched && threatValue < PANIC.directOff) {
        this.directLatch[i] = 0;
      }
      const latched = this.directLatch[i] === 1;
      const enteredDirect = latched && !wasLatched;

      this.panicHold[i] = Math.max(0, this.panicHold[i] - dt);
      this.refractory[i] = Math.max(0, this.refractory[i] - dt);

      // social trigger: the signal is strong enough, the fish is not latched
      // by a direct threat, and it is not inside its refractory period. the
      // refractory period is the key part — without it the pulse reflects
      // back and forth through the school and never stops.
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

      // during the startle window panic is pinned at full value, which is
      // what produces the scatter
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

      // ══ force composition ══════════════════════════════════════════════
      const term = this.terminal;
      const recallMode = term && term.mode === 'recall';
      // on the way back during recall the speed may stay near normal; it
      // only slows down once in formation (near the slot / in place). the
      // panic speed boost for fleeing is only allowed when a predator or
      // panic is involved.
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
      // formation: weaken the boid rules, so they do not tug at each other
      // and leave the formation wobbling
      const sepScale = recallMode ? 0.12 : guided ? term.separationScale : 1;
      const cohScale = recallMode ? 0.08 : guided ? term.cohesionScale : 1;
      const aliScale = recallMode ? 0.15 : guided ? term.alignmentScale : 1;

      applyRule(
        this.separation[o],
        this.separation[o + 1],
        this.separation[o + 2],
        FLOCK.separationWeight * sepScale
      );

      // cohesion drops when startled — flash expansion
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

      // receiver gain: the more panicked a fish is, the more it listens to
      // its neighbors — that is how the wave pushes outward layer by layer
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

      // emergency alignment: when one fish sees danger, its heading
      // outweighs the average of twenty calm neighbors
      if (this.emergencyUrgency[i] > 0) {
        applyRule(
          this.emergencyAlign[o],
          this.emergencyAlign[o + 1],
          this.emergencyAlign[o + 2],
          PANIC.emergencyAlignmentWeight * this.emergencyUrgency[i]
        );
      }

      // the geometric escape vector goes only to fish that can see the
      // player directly. socially panicked fish know only their neighbors'
      // headings, not where the player is — otherwise they would be
      // omniscient.
      if (threatValue > 0) {
        applyRule(
          this.escapeDir[o],
          this.escapeDir[o + 1],
          this.escapeDir[o + 2],
          PANIC.escapeWeight * threatValue
        );
      }

      // boundary (the recall formation sits close to the top of the box,
      // where the soft boundary keeps pushing down and the swarm never
      // brakes to a stop, so it is weakened a lot)
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

      // obstacles — the ray fan. the direction is composed from five rays,
      // and each hit point is emitted as an event at the same time. this is
      // the core of the project: the mapping data is exactly the intermediate
      // product that obstacle avoidance has already computed.
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

      // altitude strategy:
      // - ALTITUDE on: virtual ceiling / mission-floor soft walls plus weak
      //   negative buoyancy (no advance knowledge of the trench depth)
      // - otherwise the old fixed workingDepth can be used (control case)
      // the TANK walls are the mission-area boundary, not real terrain; the
      // actual floor comes from ray-based obstacle avoidance plus hard
      // collision.
      if (ALTITUDE.enabled && !recallMode) {
        const y = pos[o + 1];
        const m = ALTITUDE.softMargin;
        const w = ALTITUDE.softWeight;
        // soft wall: only pushes near the edge. by default yMin sits close
        // to the bottom of the mission box, so this mainly acts as a ceiling.
        if (m > 0 && w > 0) {
          const up = y - (ALTITUDE.yMax - m);
          if (up > 0) applyRule(0, -1, 0, w * Math.min(1, up / m));
          const dn = (ALTITUDE.yMin + m) - y;
          if (dn > 0) applyRule(0, 1, 0, w * Math.min(1, dn / m));
        }
        // weak negative buoyancy: a steady mild incentive to descend. the
        // real floor is held up by the obstacle rays, so it never “pins
        // itself to one fixed depth”.
        const sink = ALTITUDE.sinkWeight || 0;
        if (sink > 0) applyRule(0, -1, 0, sink);
        // attraction to the mid-line of the band defaults to 0; kept as a
        // control for the approach that failed
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

      // terminal target / recall formation
      // recall semantics: once in place it goes hard-static and wandering is
      // switched off; only a predator or panic breaks that stillness to flee,
      // and afterwards it returns to its slot.
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
        // only predator-related threats count; ordinary obstacles and
        // boundaries no longer stir the formation back into “still swimming”
        const dodging = predatorDodge;
        if (!dodging && recallDist <= holdR) {
          recallHolding = true;
          // clear this frame's force; the integration below pins it in place
          fx = fy = fz = 0;
        } else if (!dodging && recallDist <= settleR) {
          // near the slot: hard braking plus a weak pull home, no longer the
          // cruise-flavored seek
          applyRule(sdx, sdy, sdz, (term.seekWeight || 2.2) * 0.55);
          // damp the current velocity in reverse, so it does not keep
          // coasting after arriving
          applyRule(-vx, -vy, -vz, RECALL.brakeWeight || 8);
        } else {
          const w = dodging
            ? (RECALL.returnWeight || 2.8)
            : (term.seekWeight || 2.2);
          applyRule(sdx, sdy, sdz, w);
          if (!dodging) {
            // hold the speed down a little on the way in as well, to avoid
            // a “cruising” charge into the formation
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

      // wander noise: switched off while holding formation
      this.wanderPhase[i] += dt * this.wanderRate[i];
      const phase = this.wanderPhase[i];
      const wScale = recallHolding ? 0 : recallMode ? 0.05 : 1;
      fx += Math.sin(phase * 1.31) * FLOCK.wanderWeight * wScale;
      fy += Math.sin(phase * 1.73 + 2.1) * FLOCK.wanderWeight * 0.4 * wScale;
      fz += Math.cos(phase * 1.17) * FLOCK.wanderWeight * wScale;

      // ══ integration: turn rate limit + pitch clamp + speed clamp ═══════
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
      // turning ability rises with panic; in formation the angular rate also
      // has to be locked (slow linear speed plus wild turning = a top
      // spinning in place)
      let turnSpeed = FLOCK.turnSpeed * (1 + panic * PANIC.panicTurnBoost);
      if (recallMode && !predatorDodge) {
        const holdR = RECALL.holdRadius || 1.2;
        const settleR = RECALL.settleRadius || 3.5;
        const holdTurn = RECALL.holdTurnScale ?? 0;
        if (recallHolding || (recallSlot && recallDist <= holdR)) {
          turnSpeed = 0; // in place: heading completely frozen
        } else if (recallSlot && recallDist <= settleR) {
          // near the slot: linear speed is dropping, so squeeze the angular
          // rate down in step until it can barely turn
          const t = Math.max(0, (recallDist - holdR) / Math.max(1e-6, settleR - holdR));
          turnSpeed *= Math.max(holdTurn, 0.05) * t * t;
        }
      }
      // also limit turning when the current linear speed is very low, to
      // avoid noise in the direction vector at v≈0 causing wild spinning
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
      // when both velocity and force are near zero, keep the old heading
      // rather than using a zero vector
      if (turned[3] < EPSILON) {
        turned = normalize3(this.headings[o], this.headings[o + 1], this.headings[o + 2]);
        if (turned[3] < EPSILON) turned = [1, 0, 0, 1];
      }

      // pitch clamp: fish do not swim straight up and down like a submarine
      const horizontal = Math.hypot(turned[0], turned[2]);
      const pitch = Math.atan2(turned[1], Math.max(horizontal, EPSILON));
      if (Math.abs(pitch) > maxPitch) {
        turned = normalize3(
          turned[0],
          Math.max(horizontal, EPSILON) * Math.tan(Math.sign(pitch) * maxPitch),
          turned[2]
        );
      }

      // formation hard-static: pin the position, zero the linear velocity,
      // but keep headings (the renderer uses them)
      if (recallHolding && recallSlot) {
        pos[o] = recallSlot[0];
        pos[o + 1] = recallSlot[1];
        pos[o + 2] = recallSlot[2];
        vel[o] = vel[o + 1] = vel[o + 2] = 0;
        // heading frozen: turned is not written back
      } else {
        let speed = newDir[3];
        // cruiseSpeed is only maintained outside recall; on the way back
        // during recall the speed may stay near normal
        if (!recallMode && speed < FLOCK.cruiseSpeed) {
          speed = approach(speed, FLOCK.cruiseSpeed, 0.35, dt);
        }
        if (recallMode) {
          const holdR = RECALL.holdRadius || 1.2;
          const settleR = RECALL.settleRadius || 3.5;
          if (predatorDodge) {
            // predator encountered: normal panic speed
            speed = Math.min(speed, maxSpeed);
          } else if (recallSlot && recallDist <= settleR) {
            // in formation: hold the linear speed down; inside hold the
            // target is 0
            const t = Math.max(0, (recallDist - holdR) / Math.max(1e-6, settleR - holdR));
            const cap = (RECALL.approachSpeed || FLOCK.cruiseSpeed * 0.3) * t * t;
            if (force[3] < 1e-4) speed = approach(speed, 0, 0.12, dt);
            speed = Math.min(speed, cap);
          } else {
            // on the way back during recall: keep normal cruising speed, no
            // early slow motion
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

        // only update the heading when there is real movement speed; at low
        // speed or in formation, turned has already been angle-limited
        if (speed > 1e-4) {
          this.headings[o] = turned[0];
          this.headings[o + 1] = turned[1];
          this.headings[o + 2] = turned[2];
        }
      }

      // hard collision: after integration, push the body sphere back out of
      // any solid. the soft ray-based avoidance still handles turning early;
      // this is the fallback for when separation or panic squeezes a device
      // into a wall. without this step, once inside a wall rayAABB treats the
      // current box as transparent and the point cloud gets generated inside
      // the wall.
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
        // with no collider, fall back to the old bounding-box hard boundary
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

      // hard walls for the virtual altitude band: ceiling and floor, not a
      // continuous force
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

      // after collision or boundary pushes it still has to be pinned back to
      // the slot, otherwise the next frame judges it “not in place” and
      // accelerates again. note: only the linear velocity is cleared, not
      // headings — otherwise the renderer falls back to the default heading
      // and spins.
      if (recallHolding && recallSlot && !predatorDodge) {
        pos[o] = recallSlot[0];
        pos[o + 1] = recallSlot[1];
        pos[o + 2] = recallSlot[2];
        vel[o] = vel[o + 1] = vel[o + 2] = 0;
      }
    }
  }

  // for the HUD: average panic plus how many fish are panicking
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
