// ray fan sensor -- the core addition of this project.
//
// obstacle avoidance used to be a nearest-point-on-box repulsion field:
// omnidirectional, independent of heading, and what it computed was "the
// point on the box closest to me". that does dodge obstacles, but it is
// not a measurement -- with no ray there is no origin->hit segment, so the
// input for free-space carving does not exist at all.
//
// it is now a cone of rays opened along the heading. each ray does its own
// intersection test, and the avoidance steering is the sum of the five.
// the hit point is a point on the obstacle surface -- that is the hit
// carried in the event.
//
// real-world counterpart: the multibeam echosounders used for actual
// seabed mapping are a fan as well. the difference is that a real
// multibeam sweeps downward, perpendicular to the heading (it is a
// dedicated mapping instrument), while our fan points forward, because it
// is first of all an obstacle-avoidance sensor -- mapping is its
// by-product, and that is exactly the argument of this project. do not
// rotate the fan downward for the sake of coverage; that turns it into a
// dedicated mapping sensor and the argument collapses.
//
// this file does not import three.js.

import { SENSOR } from './params.js';

const EPSILON = 1e-8;

// ── ray vs axis-aligned box (slab method) ──────────────────────
// returns the nearest hit distance t, or -1 on a miss. on a hit the
// surface normal is written into outNormal.
//
// the slab method hands us the normal for free: the axis with the latest
// entry time is the face the ray passes through.
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
      // ray is parallel to this pair of faces: an origin outside the
      // slab can never hit it
      if (o < lo || o > hi) return -1;
      continue;
    }

    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    let sign = -1; // hit the lo face → normal points along -a
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      sign = 1; // hit the hi face → normal points along +a
    }
    if (t1 > tMin) {
      tMin = t1;
      hitAxis = a;
      hitSign = sign;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return -1;
  }

  if (hitAxis < 0) return -1; // origin already inside the box: invalid measurement
  outNormal[0] = hitAxis === 0 ? hitSign : 0;
  outNormal[1] = hitAxis === 1 ? hitSign : 0;
  outNormal[2] = hitAxis === 2 ? hitSign : 0;
  return tMin;
}

// ── ray vs the inner walls of the bounds box ───────────────────
// a device sits inside the box and shoots outward, so what we want is the
// face the ray leaves through -- tMax, not tMin.
// tank walls / trench walls / the seabed are all picked up this way;
// without it the map is only a few boxes hanging in mid-air.
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
      sign = d > 0 ? -1 : 1; // inner wall normals point inward, opposite the ray
    }
  }

  if (axis < 0 || tExit > maxT) return -1;
  outNormal[0] = axis === 0 ? sign : 0;
  outNormal[1] = axis === 1 ? sign : 0;
  outNormal[2] = axis === 2 ? sign : 0;
  return tExit;
}

// ── fan geometry ───────────────────────────────────────────────
//
// exported so the terminal can reuse it: the event carries only the
// heading and the half-angle, and this function recomputes the five ray
// directions at each end. the directions are derivable, so they do not
// have to be uploaded -- that is what packing an event saves. measured, it
// is 1.06x in bytes, not the 3x this comment used to claim (see eventBus.js:
// only 1.22 of the five rays hit on average, and the 3x figure assumed all
// five did); the real gain is that the misses then travel for free.
// both ends share the same function, so they cannot drift apart.

// pack an axis-aligned normal into 1 byte. an AABB or an inner wall has
// only 6 possibilities; a sphere normal is approximated by its dominant axis.
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

// build an orthonormal basis around the unit vector d. when d is close to
// vertical, switch the reference axis, otherwise the cross product degenerates.
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

// write count ray directions into dirs (length count*3)
// halfAngleDeg = the left/right half-angle; vertHalfAngleDeg defaults to it.
// up/down uses the u axis, left/right the r axis -- during the PLAN phase
// the vertical half-angle can be widened to cover the top and the bottom
// while the fan still points forward (rather than the whole fan being
// rotated down into a multibeam).
export function buildFan(dx, dy, dz, halfAngleDeg, count, dirs, r = _fr, u = _fu, vertHalfAngleDeg) {
  dirs[0] = dx; dirs[1] = dy; dirs[2] = dz;
  if (count <= 1) return dirs;

  basisFor(dx, dy, dz, r, u);
  const aH = (halfAngleDeg * Math.PI) / 180;
  const aV = (((vertHalfAngleDeg == null) ? halfAngleDeg : vertHalfAngleDeg) * Math.PI) / 180;
  // 0,1 = up/down (u); 2,3 = left/right (r)
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

// ray vs sphere (for dynamic targets). returns the nearest positive root,
// -1 on a miss, and writes the normal into outNormal.
//
// dynamic targets have to be measured just like terrain -- the sensor
// cannot tell a rock from a fish, it only knows "there is something x
// metres ahead". this is exactly the problem this project is about: the
// map gets polluted by swimming creatures, and the only way to separate
// them out is free-space carving, not recognition.
function raySphere(ox, oy, oz, dx, dy, dz, maxT, cx, cy, cz, r, outNormal) {
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c > 0 && b > 0) return -1; // origin outside the sphere, aimed away from it
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq; // origin inside the sphere, take the exit hit
  if (t < 0 || t > maxT) return -1;
  const hx = ox + dx * t, hy = oy + dy * t, hz = oz + dz * t;
  const nl = r || 1;
  outNormal[0] = (hx - cx) / nl;
  outNormal[1] = (hy - cy) / nl;
  outNormal[2] = (hz - cz) / nl;
  return t;
}

export class RaySensor {
  // boxes  : [{min:{x,y,z}, max:{x,y,z}}]  solid obstacles
  // bounds : {min:{x,y,z}, max:{x,y,z}}    survey box (inner walls measured too)
  constructor(boxes = [], bounds = null) {
    // dynamic targets (large creatures). they stay out of the spatial grid
    // -- they move every frame, and rebuilding the grid costs far more than
    // simply looping over these two or three spheres.
    this.dynamic = [];
    this.setWorld(boxes, bounds);
    this.setCount(0);

    // per-frame scratch values, preallocated to avoid GC
    this._dirs = new Float32Array(SENSOR.rayCount * 3);
    this._ts = new Float32Array(SENSOR.rayCount); // per-ray hit distance, -1 = miss
    this._bnd = new Uint8Array(SENSOR.rayCount); // hit the mission boundary?
    // hit face encoding: 0 = miss, 1=+X 2=-X 3=+Y 4=-Y 5=+Z 6=-Z
    // map building needs the surface normal to step back along; stepping
    // back along the ray barely moves the normal component at grazing
    // angles, so a horizontal base sinks in by a whole layer, consistently.
    // stepping back along the normal does not have that problem.
    this._faces = new Uint8Array(SENSOR.rayCount);
    this._normal = [0, 0, 0];
    this._basisR = [0, 0, 0];
    this._basisU = [0, 0, 0];
  }

  // obstacles are flattened from {min,max} objects into a contiguous array:
  // intersection is the inner loop, and property-chain access is too costly
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
    this._box = new Float32Array(6); // sliding-window view used when intersecting
    this._buildGrid();
  }

  // ── broad phase: uniform grid ────────────────────────────────
  //
  // the naive approach walks every box for every ray. that is fine while
  // the terrain is only 5 boxes, but once it becomes a stepped trench it is
  // 173 -- 260 devices x 5 rays x 173 = 225,000 intersection tests per
  // frame. scale the map up any further and it runs straight into the frame
  // budget.
  //
  // the cell size is the sensor range: a ray never travels further than
  // that, so starting from the cell it is in, any ray can reach at most the
  // neighbouring cell -- the 3x3x3 neighbourhood is a complete candidate set.
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

    // a box spanning several cells is registered in each of them -- the
    // duplicate entries are filtered out by the visit stamp on the query side
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

  // collect the boxes in the 3x3x3 neighbourhood of this position into
  // _candidates and return how many there are.
  // done once per device per frame and shared by all five rays -- that is
  // the key: the broad phase is amortised per device, not per ray.
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
    // throttle state: each individual remembers when it last emitted and
    // which voxel that last emission fell into
    this.lastEmit = new Float32Array(n);
    this.lastVoxel = new Int32Array(n);
    this.lastClear = new Float32Array(n);
    this.resetThrottle();
  }

  // once time is rewound (the simulation is reset), the leftover throttle
  // timestamps sit in the "future": `time - lastEmit` is always negative, so
  // the emit condition is never met -- and the whole event stream dies
  // silently: no error, no crash, the map just stops growing. so a reset has
  // to clear the throttle state as well, which is also what makes the same
  // seed reproducible.
  resetThrottle() {
    this.lastEmit.fill(-Infinity);
    this.lastClear.fill(-Infinity);
    this.lastVoxel.fill(-1);
  }

  // five rays: the centre one plus up, down, left and right offset by
  // halfAngle. a single ray only looks straight ahead, so a wall coming in
  // from the side cannot be dodged, and one trigger then yields only one
  // measurement. five rays give five measurements from different angles at
  // once -- which is exactly what the endpoint kernel wants.
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

  // cast one ray at the candidate boxes, return the nearest t (-1 on a
  // miss), and write the normal into this._normal.
  // returns the nearest hit distance; at the same time it records in
  // this.hitBoundary whether this hit was on the inner wall of the mission
  // bounds -- the bounds are not terrain, they are a frame we drew
  // ourselves, and they should not go into the map.
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

    // dynamic targets are tested last: there are few of them and they are
    // usually close by, so testing the static geometry first prunes early
    for (let k = 0; k < this.dynamic.length; k += 1) {
      const d0 = this.dynamic[k];
      const t = raySphere(ox, oy, oz, dx, dy, dz, SENSOR.range,
        d0.position.x, d0.position.y, d0.position.z, d0.radius, tmp);
      if (t >= 0 && (best < 0 || t < best)) {
        best = t;
        this.hitBoundary = false; // creature is nearer than the bounds; flag flips
        n[0] = tmp[0]; n[1] = tmp[1]; n[2] = tmp[2];
      }
    }
    return best;
  }

  // run one fan sweep for a single individual.
  //   writes out = the desired avoidance direction (not normalised) and
  //   returns urgency in [0,1]
  //   hit events are pushed to bus (which may be null, so the algorithm
  //   side can run on its own without any UI)
  // profile (optional): widen the vertical fan / open the horizontal fan a
  // little during the PLAN phase. defaults to the SENSOR values.
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

    // the cell size was fixed from whatever the sensor range was at the
    // time, and that range is a slider that can be dragged live. once it has
    // been dragged up, the 3x3x3 neighbourhood is no longer complete and
    // rays silently miss the boxes further out -- it shows up as "a chunk of
    // the map is missing for no reason" and is very hard to track down.
    // rebuild once it is exceeded.
    if (SENSOR.range > this._cell) this._buildGrid();

    this._buildFan(dx, dy, dz, halfH, halfV);
    const dirs = this._dirs;
    let urgency = 0;
    let anyHit = false;
    // the broad phase is amortised once per device; the five rays share the
    // candidate set
    const cand = this._gather(px, py, pz);

    // emit guard time: if it is not met, only avoidance is computed and no
    // event is sent. without it, 60 Hz x 260 devices x 5 rays is roughly
    // 78,000 events per second and the bandwidth advantage drops to zero.
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
      // hit the inner wall of the mission bounds → still used for
      // avoidance, but it does not go into the map. it is not terrain, it
      // is a frame we drew ourselves; measured, it made up 28.4% of the
      // point cloud.
      bnd[k] = this.hitBoundary ? 1 : 0;

      if (t < 0) {
        faces[k] = 0;
        // this ray is clear -- give it a vote so the individual heads into
        // open space. normal repulsion alone makes an individual "jam up"
        // when it hits a wall head-on (the repulsion is antiparallel to the
        // heading).
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

    // ── one emission = one event ──────────────────────────────
    //
    // it used to be one event per ray, each carrying its own copy of the
    // origin -- but the five rays share the same origin, so it was uploaded
    // five times over. same story for the directions: the orientation of
    // the five rays is fully determined by the heading plus the fan
    // geometry, so it is derivable and does not need to be sent at all.
    // with all five rays hitting, packed, one emission drops from 5x32 =
    // 160 bytes to 52 bytes. that best case is not what happens: measured,
    // 1.22 rays hit per emission, so it is 39.1 bytes down to 36.9 -- the
    // saving in bytes is 1.06x, and the point is the free-space evidence
    // that comes with it (eventBus.js has the numbers).
    //
    // this is not a trick: a real sonar sends one packet of beams per ping
    // anyway, not one packet per beam.
    //
    // open water (not a single ray hit) goes through the same channel, just
    // at a much lower rate -- a mask of 0 means "no echo", and no echo is
    // itself a valid measurement: without sending it, that stretch of space
    // would stay "unknown" forever.
    if (bus && ((anyHit && hitCanEmit) || (!anyHit && clearCanEmit))) {
      if (anyHit) this.lastEmit[i] = time;
      else this.lastClear[i] = time;
      bus.ping(px, py, pz, dx, dy, dz, halfH, ts, faces,
        bnd, SENSOR.rayCount, SENSOR.range, time, i, halfV);
    }

    return Math.min(1, urgency);
  }
}
