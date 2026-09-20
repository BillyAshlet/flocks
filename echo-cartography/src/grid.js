// L3 mapping: occupancy grid + 3D DDA.
//
// this is the genuinely new code in the project — everything before it
// exists to deliver events here.
//
// why store a grid instead of points: a raw point cloud is O(time), a voxel
// grid is O(space). mission duration has no upper bound, space does. storing
// points blows up memory after an hour of running; storing a grid never
// grows.
//
// this file does not import three.js.

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

    // net evidence. Int16 rather than Float32: half the memory, and
    // evidence only ever needs integer resolution anyway (hit +1, carve
    // −1), so floating-point precision means nothing here.
    this.evidence = new Int16Array(this.total);

    // list of voxels judged occupied, plus a reverse lookup table.
    // scanning all 3 million cells every render frame is impossible, so we
    // keep an incremental list: a voxel joins when its evidence crosses the
    // threshold, and afterwards only the listed ones get updated.
    this.occupied = new Int32Array(MAP.maxPoints);
    this.occupiedCount = 0;
    this.slotOf = new Int32Array(this.total).fill(-1);

    // slots that need redrawing this frame (newly listed ones, and ones
    // backfilled by the last entry when a voxel left the list)
    this.dirtySlots = [];

    // list of free voxels (evidence negative enough). frontiers only grow
    // on the neighbourhood of these cells.
    //
    // the capacity must NOT share maxPoints with the occupied list — the
    // two are orders of magnitude apart: occupied covers only surfaces
    // (50k measured), free has to fill the whole explored space (600k
    // measured, bounded by the entire grid). with a shared 400k cap the
    // free list fills up, newly carved free voxels stop being registered,
    // and frontier detection sees only a truncated free space — which
    // shows up as the exploration target jumping around or not moving at
    // all, and nothing is reported as an error.
    this.free = new Int32Array(this.total);
    this.freeCount = 0;
    this.freeSlotOf = new Int32Array(this.total).fill(-1);

    // ── coarse grid (for frontier exploration, see MAP.coarseFactor) ──
    const F = MAP.coarseFactor;
    this.coarseFactor = F;
    this.cdim = [
      Math.ceil(this.dim[0] / F),
      Math.ceil(this.dim[1] / F),
      Math.ceil(this.dim[2] / F),
    ];
    this.ctotal = this.cdim[0] * this.cdim[1] * this.cdim[2];
    this.cellVolume = F * F * F;
    // number of confirmed-free / confirmed-occupied voxels in each coarse
    // cell, maintained incrementally in _bump. recounting on demand would
    // just add back the full-grid scan we saved.
    this.cFree = new Int32Array(this.ctotal);
    this.cOcc = new Int32Array(this.ctotal);

    this.rayCount = 0;
    this.hitCount = 0;
  }

  index(ix, iy, iz) {
    return (iz * this.dim[1] + iy) * this.dim[0] + ix;
  }

  // world coordinates of a voxel center
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

  // voxel evidence → three states. the standard occupancy-grid
  // trichotomy, and also the input to frontier exploration.
  static classOf(e) {
    if (e >= MAP.occupiedThreshold) return 1;
    if (e <= MAP.freeThreshold) return -1;
    return 0;
  }

  // world coordinates of a coarse-cell center
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

  // coarse-cell three states. note that "passable" and "has solid matter"
  // are not mutually exclusive — a cell holding both rock wall and gaps is
  // still traversable, just not open. so test free first, solid second.
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

    // incremental maintenance of the coarse-cell counters. they only move
    // when a voxel crosses a state boundary, so the vast majority of _bump
    // calls return here after a single comparison.
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

    // —— occupied list ——
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

    // —— free list (for frontier extraction, O(free cells) rather than
    // O(whole grid)) ——
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

  // ── 3D DDA (Amanatides & Woo 1987) ─────────────────────────────────────
  //
  // walk cells from origin along the ray until the endpoint. on a hit the
  // endpoint gets +hit and everything along the way gets −carve.
  //
  // the endpoint must NOT only update the single cell it lands in: when the
  // same wall is hit by two devices from slightly different angles, the two
  // endpoints land in two adjacent cells and each scores 1, while the cell
  // between them is crossed by both rays and carved negative — the evidence
  // cancels out and the wall disappears instead. so the endpoint uses a
  // small kernel (see _splat).
  integrateRay(ox, oy, oz, hx, hy, hz, hit, nx = 0, ny = 0, nz = 0) {
    this.rayCount += 1;
    const v = this.voxel;
    const o = this.origin;

    let dx = hx - ox, dy = hy - oy, dz = hz - oz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    dx /= len; dy /= len; dz /= len;

    // surface pull-back: the endpoint has to be pushed into free space
    // along the hit normal before being floored into a cell.
    //
    // pulling back along the ray is wrong: a grazing hit on a horizontal
    // base has dy≈0, so pulling back barely changes Y and the whole top
    // face of the step still gets deterministically sucked to the inside
    // of the solid — it looks like a fixed-depth sunken layer spanning the
    // entire base. the PLY confirmed that layers at y=-19.7/-3.5/-13.1 and
    // others are 78%+ inside the solid.
    //
    // the normal comes from the sensor at intersection time (an AABB has
    // only 6 directions) and points into free space. surfaceBias is in
    // units of voxel edge length, 0.5 = push out half a cell along the
    // normal.
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
        // fallback for old events / missing normals: pull back along
        // the ray (useless for grazing hits, but better than not pulling
        // back at all)
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

    // parametric distance to the next cell boundary; an axis whose
    // component is 0 is never crossed
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

    // step cap: measured to the endpoint that was floored into a cell.
    // after a hit is pulled back the endpoint is closer, so using the
    // original len only costs a few extra steps, but the end cell has
    // changed and ex,ey,ez remain authoritative.
    const endLen = Math.hypot(ehx - ox, ehy - oy, ehz - oz);
    const maxSteps = Math.ceil(endLen / v) + 3;
    for (let s = 0; s < maxSteps; s += 1) {
      if (ix === ex && iy === ey && iz === ez) break;
      // everything along the way is free space — the ray passing through
      // proves it empty. this is free-space carving: the only
      // counter-evidence that can take evidence back down, and the whole
      // basis for separating dynamic targets.
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

  // endpoint kernel: full weight on the endpoint, reduced weight on the
  // six face neighbours. the kernel cannot get any bigger — the bigger it
  // is the "thicker" the map, and narrow gaps get smeared shut, when
  // passing through narrow gaps is exactly what we want to show.
  //
  // the kernel is one-sided: it only spreads towards the side the ray came
  // from, never into the solid. with symmetric spreading half of the six
  // neighbours land inside the surface — the measured point cloud had 41%
  // of its points shallowly buried in solid. those points are not wrong
  // (they are within 1 cell of the surface), but they carry no information
  // while making the shell thicker and narrow gaps easier to smear shut.
  // the test is simply the ray direction: a neighbour in the same direction
  // as the ray = deeper into the solid, skip it.
  _splat(ix, iy, iz, dx, dy, dz) {
    this._bump(ix, iy, iz, MAP.hitWeight);
    const side = MAP.kernelWeight;
    if (side <= 0) return;
    // a dot product > 0 means "along the ray's direction of travel" = the
    // inside of the solid. leave a little margin for grazing angles.
    const EPS = 0.15;
    if (dx < EPS) this._bump(ix + 1, iy, iz, side);
    if (-dx < EPS) this._bump(ix - 1, iy, iz, side);
    if (dy < EPS) this._bump(ix, iy + 1, iz, side);
    if (-dy < EPS) this._bump(ix, iy - 1, iz, side);
    if (dz < EPS) this._bump(ix, iy, iz + 1, side);
    if (-dz < EPS) this._bump(ix, iy, iz - 1, side);
  }

  // consume a batch of events from the event bus
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

  // ── horizontal coverage (plan-view projection) ─────────────────────────
  //
  // flatten the coarse grid along height and only ask "did this xz column
  // measure anything at all". ignoring height is deliberate: deciding "has
  // this area been swept" needs plan-view coverage, not "every layer has
  // been mapped" — the latter could only be satisfied once the mission is
  // over.
  //
  // it is the switch criterion from free roam to frontier exploration: roam
  // is responsible for covering the whole area once, and once that is good
  // enough frontier goes in to chew on the details. the other way round,
  // starting with frontier, the swarm dives straight into the nearest
  // boundary and large areas are never visited at all (measured coverage
  // actually came out lower).
  //
  // this assumes the floor exists — otherwise columns under open water can
  // never be hit and this ratio never reaches the threshold.
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

  // plan-view heat map (display only, does not feed the frontier/coverage
  // criteria).
  //
  // the decision-side coarse cell is 8×voxel ≈ 4.8 m, which would look like
  // mosaic if drawn directly. the display side uses a finer xz bin (2
  // voxels = 1.2 m by default) and paints from the sparse free/occupied
  // lists instead of scanning the whole grid.
  //   0 = unknown  1 = free only  2 = occupied seen
  // returns { map, width, height, bin }; map can be reused.
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

    // free first, occupied second, so occupied paints over free
    for (let s = 0; s < this.freeCount; s += 1) paint(this.free[s], 1);
    for (let s = 0; s < this.occupiedCount; s += 1) paint(this.occupied[s], 2);

    return { map: out, width, height, bin };
  }

  get coverage() {
    return this.occupiedCount / this.total;
  }

  // ── export ─────────────────────────────────────────────────────────────
  //
  // PLY rather than a custom extension: CloudCompare / MeshLab / Open3D /
  // Blender all open PLY directly, and an export only counts as a real
  // export when other tools can read it.
  //
  // carry a confidence scalar: a point cloud is not only geometry, every
  // point also has "how many times it was observed", which is how this
  // project tells terrain from creatures — drop it and the work was for
  // nothing.
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
    // chunked concatenation: joining 60000 points in one go builds one
    // huge intermediate array; chunking gives the GC a chance to reclaim
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
