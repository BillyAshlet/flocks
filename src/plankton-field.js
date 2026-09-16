/**
 * Plankton field: particles with positions, not a single pool number.
 *
 * Why not a global scalar: food used to be one number, `planktonLevel`, that every fish
 * drew from wherever it was. The 700 dots on screen were scattered once, never moved, and
 * the first N were shown by ratio, so fish eating at the top of the tank made dots vanish
 * at the bottom. It was a progress bar drawn as dots, and the picture claimed spatial food
 * that the model did not have.
 *
 * Why particles rather than a concentration grid:
 * 1. A field is too smooth. Every fish gets "some" food decided by arithmetic, which is
 *    deterministic and collapses into a step function. Discrete particles are lumpy: food
 *    happens to be nearby or not. That lumpiness is the source of individual variation,
 *    and individual variation adds up to a survival gradient at the population level.
 * 2. Foraging is simpler and more realistic. A field needs gradient climbing, and gradients
 *    vanish in uniform regions; particles only need "how many are nearby". At high density
 *    this becomes filter feeding, so particulate and filter feeding emerge rather than being
 *    coded.
 * 3. Patches maintain themselves: food starts patchy, and emptied areas wait for regrowth.
 *
 * Why uses rather than mass: a particle can be bitten N times, disappears when spent, and
 * returns whole after `regrowSeconds`. Compared with continuous mass plus logistic growth,
 * there is no floating-point accumulation, and "an empty particle returns after 20 s" is
 * easier to reason about than a growth rate. N = 1 is the most competitive case: first
 * come, first served, one fish per particle.
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
    // All food is counted in bites. Earlier, bites were converted into an abstract stock
    // (capacity / (particles x uses)), which made one bite 0.167 while maxIntakePerFish was
    // 0.04: a bite was four times the intake limit, so fish could never eat a single one.
    // The two numbers came from separate sources with no common scale. Now availableAt
    // returns bites, maxIntakePerFish is the most bites per feeding, halfSaturation is in
    // bites, and total food = particles x uses per particle.

    // reach: how close a particle must be to eat it. sense: how far away food can be seen.
    this.reach = Math.max(1e-4, config.plankton.forageRadius ?? 0.12);
    this.sense = Math.max(this.reach, config.plankton.senseRadius ?? 0.6);

    this._buildGrid();
    this.reset();
  }

  /**
   * Fixed-size grid indexed by flat array offsets, not a Map with string keys. The tank is
   * bounded, so the cell count is fixed. SpatialHash3D in experiment-model.js builds 27
   * string keys per query, which came to about 2.2 million allocations per second at
   * 679 fish; this grid avoids repeating that.
   *
   * Cell size is the sensing radius, not the eating reach, so foraging needs only the 3x3x3
   * block; eating scans the same 27 cells and filters by the smaller reach. One grid, one
   * scan, two radii.
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

  /** Initial distribution is patchy, not uniform. Uniform food would make swimming toward food pointless. */
  reset() {
    const margin = this.config.tank.wallMargin;
    const half = [
      Math.max(0, this.config.tank.width / 2 - margin),
      Math.max(0, this.config.tank.height / 2 - margin),
      Math.max(0, this.config.tank.depth / 2 - margin),
    ];
    // Patch radius is three times the eating reach so one cloud can hold a small group,
    // letting a school feed together or miss together.
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

  /** Total food in the tank, in bites. */
  get capacity() {
    return this.count * this.usesPerParticle;
  }

  /** Total remaining food in bites, kept for callers that read or set a tank-wide plankton level. */
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
   * Holling type II half-saturation constant, in bites.
   *
   * The reference amount is the bites one fish can reach when food fills the whole tank,
   * so halfSaturationFraction is a fraction of one fish's full local share. Its meaning is
   * unchanged from when it was measured against the whole tank's abstract stock; only the
   * reference moved to one fish's reach and the unit to bites.
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

  /** A depleted particle comes back whole once its timer expires; it does not grow back gradually. */
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

  /** Bites within eating reach at this point. Local, not tank-wide. */
  availableAt(x, y, z) {
    let sum = 0;
    this._forEachNear(x, y, z, this.reach, (p) => {
      sum += this.uses[p];
    });
    return sum;
  }

  /**
   * Foraging direction: the weighted centroid of all particles within sensing range.
   *
   * Not "toward the nearest particle": with a single target the fish locks on and jitters.
   * Weight = remaining uses / distance. 1/d rather than 1/d^2, because squared falloff
   * also makes the fish lock onto the nearest particle; 1/d still steers toward dense
   * patches while giving closer particles more pull.
   * Returns null when nothing is in range, so the fish does not act on information it lacks.
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

  /** Take bites from this neighbourhood, nearest particles first. Returns the amount actually taken. */
  take(x, y, z, amount) {
    if (!(amount > 0)) return 0;
    const near = [];
    this._forEachNear(x, y, z, this.reach, (p, d2) => near.push([d2, p]));
    if (!near.length) return 0;
    near.sort((a, b) => a[0] - b[0]);
    // Units are bites, so only whole bites can be taken: a request for 2.7 takes 2.
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

  /** Counting-sort rebuild: two O(n) passes, no allocation. */
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

  /** Scan the 3x3x3 block of cells and call cb(index, squaredDistance) for each particle with uses left within radius. */
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
