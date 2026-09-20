// large creatures — autonomously swimming dynamic threats, replacing the
// former player.
//
// replacing the player is not just "one control mode fewer". what this
// project has to demonstrate is the swarm completing the survey with no
// human intervention — hold a fish in your hand and the whole argument
// turns into a performance.
//
// it is at the same time the adversary of the mapping algorithm: this thing
// moves, so the traces it leaves in the point cloud have to be erasable by
// free-space carving. without it there is no way to verify "telling static
// geometry from dynamic targets".
//
// only { position, velocity } is exposed to Flock — the same interface the
// player used to have.
// this file does not import three.js.

import { CREATURE, TANK } from './params.js';

class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
}

// box avoidance — take the nearest point on the box to get a push-out
// direction.
//
// deliberately not a ray fan here: what a ray fan produces is measurement
// data, and that is a capability only the swarm devices have. a fish should
// not generate survey events, it only needs to not hit walls. using two
// separate mechanisms is in fact more honest.
//
// returns urgency in [0,1], and writes the push-out direction into out.
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
      // already stuck inside the box: push out along the axis with the
      // shallowest penetration. always pushing up is wrong — stuck in a
      // side wall it gets scraped upwards and clips through geometry the
      // whole way.
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
    // when a human takes over, the whole autonomous-wander section is
    // skipped — the velocity is written by the pilot, but obstacle
    // avoidance still applies: driving should not go through walls either.
    this.piloted = false;
    this._avoid = [0, 0, 0];
    this.reset(seed);
  }

  reset(seed = 0) {
    const hx = TANK.width / 2 - CREATURE.margin;
    const hz = TANK.depth / 2 - CREATURE.margin;
    this.position.x = (seed % 2 === 0 ? -1 : 1) * hx * 0.6;
    // spawn in the open water above the trench rim, not down among the
    // peaks — starting from inside the rock means it spends the first frame
    // resolving penetration, which looks like being flung out
    this.position.y = TANK.height * 0.12;
    this.position.z = (seed % 2 === 0 ? 1 : -1) * hz * 0.4;
    this.velocity.x = seed % 2 === 0 ? CREATURE.speed : -CREATURE.speed;
    this.velocity.y = 0;
    this.velocity.z = 0;
  }

  step(dt) {
    const speed = CREATURE.speed;
    // terrain avoidance applies in both autonomous and piloted mode —
    // driving should not go through walls either. this step was missing
    // before, and the creatures went straight through the rock.
    const clearance = CREATURE.bodyRadius + CREATURE.avoidMargin;
    const urgency = boxAvoid(
      this.position.x, this.position.y, this.position.z,
      this.obstacles, clearance, this._avoid
    );

    if (!this.piloted) {
      this.phase += dt * CREATURE.turnRate;
      const p = this.phase;

      // three sines with different periods summed — mutually prime
      // frequencies do not repeat over a short cycle, so it looks like
      // wandering rather than running a fixed route.
      let dx = Math.cos(p * 1.0);
      let dy = Math.sin(p * 0.37) * 0.35;
      let dz = Math.sin(p * 0.73);

      // turn before hitting a wall: the closer to the wall, the stronger
      // the opposing component
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

      // terrain avoidance carries the largest weight — it has to overpower
      // the wander noise, otherwise it scrapes its way along the rock face
      // and straight into it
      const w = CREATURE.avoidWeight * urgency;
      dx += this._avoid[0] * w;
      dy += this._avoid[1] * w;
      dz += this._avoid[2] * w;

      const len = Math.hypot(dx, dy, dz) || 1;
      // turn smoothly rather than snapping direction, otherwise the
      // swarm's escape prediction (escapePredictionTime) points at a
      // direction that will not exist by the next frame
      const blend = Math.min(1, dt * 2.2);
      this.velocity.x += ((dx / len) * speed - this.velocity.x) * blend;
      this.velocity.y += ((dy / len) * speed - this.velocity.y) * blend;
      this.velocity.z += ((dz / len) * speed - this.velocity.z) * blend;
    } else if (urgency > 0) {
      // piloted mode: do not take control away, just add a push-out
      // velocity. overwriting velocity directly makes it feel like
      // "bouncing off after hitting the wall", which is unpleasant; adding
      // it instead reads as "sliding along the wall".
      const w = speed * urgency;
      this.velocity.x += this._avoid[0] * w * dt * 6;
      this.velocity.y += this._avoid[1] * w * dt * 6;
      this.velocity.z += this._avoid[2] * w * dt * 6;
    }

    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;

    // hard-resolve fallback: the turning is soft, so at high speed it can
    // still end up inside the rock within a single frame.
    //
    // this has to iterate. after the terrain went from 5 boxes to 333 peak
    // steps, a single push-out often just moved it from one box into the
    // neighbouring one — in testing both creatures ended up permanently
    // wedged in a corner. re-solve after each push, until it is clear or
    // the attempts run out.
    for (let iter = 0; iter < 4; iter += 1) {
      const u = boxAvoid(
        this.position.x, this.position.y, this.position.z,
        this.obstacles, clearance, this._avoid
      );
      if (u < 0.999) break; // only hard-push when genuinely stuck inside
      const l = Math.hypot(this._avoid[0], this._avoid[1], this._avoid[2]) || 1;
      const outStep = clearance * 0.8;
      this.position.x += (this._avoid[0] / l) * outStep;
      this.position.y += (this._avoid[1] / l) * outStep;
      this.position.z += (this._avoid[2] / l) * outStep;
      // the velocity has to turn with it, otherwise the next frame drives
      // back in the same direction and it jitters back and forth
      this.velocity.x = (this._avoid[0] / l) * speed;
      this.velocity.y = (this._avoid[1] / l) * speed;
      this.velocity.z = (this._avoid[2] / l) * speed;
    }

    // hard clamp to the bounding box
    const clamp = (v, half) => Math.max(-half, Math.min(half, v));
    this.position.x = clamp(this.position.x, TANK.width / 2 - 1);
    this.position.y = clamp(this.position.y, TANK.height / 2 - 1);
    this.position.z = clamp(this.position.z, TANK.depth / 2 - 1);
  }
}

// multiple creatures. Flock._senseThreat looks for `.members`, and each
// device reacts to the nearest one.
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
