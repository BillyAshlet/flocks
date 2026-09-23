const EPSILON = 1e-9;

export class SeededRng {
  constructor(seed = 1) {
    this.setSeed(seed);
  }

  setSeed(seed) {
    const normalized = Number.isFinite(Number(seed)) ? Number(seed) : 1;
    this.seed = normalized >>> 0;
    this.state = this.seed || 0x6d2b79f5;
    return this;
  }

  next() {
    // Mulberry32: compact, stable across browsers and sufficient for simulation.
    let value = (this.state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    value = ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    return value;
  }

  range(min, max) {
    return min + (max - min) * this.next();
  }

  integer(min, maxInclusive) {
    return Math.floor(this.range(min, maxInclusive + 1));
  }

  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }

  unitVector() {
    const z = this.range(-1, 1);
    const angle = this.range(0, Math.PI * 2);
    const radius = Math.sqrt(Math.max(0, 1 - z * z));
    return [radius * Math.cos(angle), radius * Math.sin(angle), z];
  }

  inUnitSphere() {
    const direction = this.unitVector();
    const radius = Math.cbrt(this.next());
    return direction.map((value) => value * radius);
  }
}
export function tankVolume(tank) {
  return tank.width * tank.height * tank.depth;
}

export function visualLength(size, visual) {
  return (visual.bodyLength + 2 * visual.bodyRadius) * size;
}

export function deriveSchool(config, school) {
  const count = Math.max(1, Math.round(school.count));
  const desired = Math.min(
    Math.max(0, school.targetNeighbors),
    Math.max(0, count - 1)
  );
  const rawRadius =
    desired <= 0
      ? 0
      : Math.cbrt(
          (3 * desired * tankVolume(config.tank)) /
            (4 * Math.PI * count)
        );
  const length = visualLength(school.size, config.visual);
  // perception.radiusMode: the cohesion radius is either set directly or
  // computed from targetNeighbors (see the comment in experiment-config.js).
  const neighborRadius =
    config.perception.radiusMode === 'neighbors'
      ? Math.max(rawRadius, config.perception.minNeighborRadiusFactor * length)
      : Math.max(EPSILON, school.cohesionRadius);
  return {
    id: school.id,
    count,
    visualLength: length,
    rawRadius,
    neighborRadius,
    cohesionRadius: neighborRadius,
    alignmentRadius: Math.max(EPSILON, school.alignmentRadius),
    separationRadius: Math.max(EPSILON, school.separationRadius),
    detectionLength:
      neighborRadius * config.perception.detectionLengthFactor,
    panicRadius:
      neighborRadius * config.perception.detectionLengthFactor,
  };
}

export function deriveExperiment(config) {
  const schools = config.schools.map((school) => deriveSchool(config, school));
  let cellSize = 0;
  for (const value of schools) {
    // Every radius a pair test uses must fit in one hash cell. Once separation
    // and alignment radii were set directly they could exceed the cohesion
    // radius, and pairs beyond the cell would silently be missed.
    cellSize = Math.max(
      cellSize,
      value.cohesionRadius,
      value.alignmentRadius,
      value.separationRadius,
      value.detectionLength
    );
  }
  for (let a = 0; a < config.schools.length; a += 1) {
    for (let b = a + 1; b < config.schools.length; b += 1) {
      cellSize = Math.max(
        cellSize,
        config.perception.crossSeparationScale *
          Math.max(config.schools[a].size, config.schools[b].size)
      );
    }
  }
  const totalCount = schools.reduce((sum, item) => sum + item.count, 0);
  return { schools, cellSize, totalCount };
}

export function captureRadius(config, predatorSchool, preySchool) {
  return (
    config.capture.captureLengthFactor *
    (visualLength(predatorSchool.size, config.visual) +
      visualLength(preySchool.size, config.visual))
  );
}

export function sustainedSpeedScale(config, school) {
  if (!config.traits?.enabled) return 1;
  return Math.max(
    config.traits.minSustainedSpeedFactor,
    school.size ** -config.traits.sizeSpeedPenaltyExponent
  );
}

export function effectiveTurnSpeed(config, school) {
  if (!config.traits?.enabled) return school.turnSpeed;
  return (
    school.turnSpeed *
    Math.max(
      config.traits.minTurnFactor,
      school.size ** -config.traits.sizeTurnPenaltyExponent
    )
  );
}

export function effectiveMaxSpeed(config, school, state = 'cruise') {
  const sustainedScale = sustainedSpeedScale(config, school);
  const sustainedMax = school.maxSpeed * sustainedScale;
  if (state === 'pursuit' || state === 'burst') {
    return sustainedMax * config.locomotion.burstFactor;
  }
  if (state === 'evade') {
    return sustainedMax * config.locomotion.panicSpeedFactor;
  }
  return sustainedMax;
}

/**
 * Energy capacity of this school, scaled by body size (ecology.capacitySizeExponent).
 * Paired with metabolicRate: one sets how much is stored, the other how fast it burns;
 * the difference between the two exponents sets the net effect of size on lifespan.
 */
export function energyCapacityFor(config, school) {
  const base = Math.max(0, config.ecology.energyCapacity);
  const exponent = config.ecology.capacitySizeExponent;
  if (!Number.isFinite(exponent)) return base;
  return base * Math.max(EPSILON, school.size) ** exponent;
}

export function metabolicRate(config, school, bursting = false) {
  const ecology = config.ecology;
  const multiplier = Math.max(0, school.metabolismMultiplier);
  const sizeScale = Math.max(
    EPSILON,
    school.size ** ecology.basalSizeExponent
  );
  // Multiply, not divide. Kleiber's law says energy use per unit body mass falls
  // with size, but absolute energy use rises: a large animal eats more per day.
  // This used to divide, which claimed large fish burn less per second and made them
  // more starvation-resistant, the opposite of the trait model (larger body -> lower
  // endurance): the trait coupling charged size an endurance cost on the input side
  // and metabolism refunded it on the output side. Multiplying makes "larger body,
  // lower endurance" hold physically rather than only in bookkeeping. The cost is that
  // large fish do starve sooner: at size 2.25 basal cost is 1.84x baseline instead of
  // the old 0.54x, a 3.4x swing in the expected direction.
  const basal = ecology.basalRate * sizeScale * multiplier;
  if (!bursting) return basal;
  const burstScale = ecology.burstSizeScaled === false ? 1 : sizeScale;
  return basal + ecology.burstMetabolicRate * burstScale * multiplier;
}

export function planktonIntake({
  available,
  maxIntake,
  halfSaturation,
}) {
  const stock = Math.max(0, available);
  const limit = Math.max(0, maxIntake);
  const half = Math.max(0, halfSaturation);
  if (stock <= EPSILON || limit <= EPSILON) return 0;
  // Michaelis-Menten / Holling-II resource response: abundant plankton
  // approaches the per-attempt ceiling, while sparse stock yields less food
  // without ever consuming the protected seed floor.
  const saturation = stock / (stock + half);
  return Math.min(stock, limit * saturation);
}

export function ecologyOutcome(aliveCounts) {
  const surviving = aliveCounts
    .map((count, index) => ({ count, index }))
    .filter((item) => item.count > 0);
  if (surviving.length === 0) {
    return { state: 'collapse', winnerIndex: null };
  }
  if (surviving.length === 1) {
    return { state: 'winner', winnerIndex: surviving[0].index };
  }
  return { state: 'running', winnerIndex: null };
}

export function relationForRatio(ratio, relations, previous = 'ignore') {
  const { k, hysteresis } = relations;
  if (!Number.isFinite(ratio) || ratio <= 0) return 'ignore';
  // Predation switched off: sizes still differ, but nobody hunts anybody.
  if (relations.enabled === false) return 'peer';
  // Upper bound of the prey size window: predators only take prey within a size
  // band (a whale does not chase a single krill). KMax <= 0 or unset falls back to
  // the plain threshold. When k x KMax equals the large/small size ratio, the
  // "can eat" and "can be eaten" ranges coincide exactly, so a school is either
  // inside the food chain (eats and is eaten) or outside it (safe but unfed).
  const kMax = relations.KMax > k ? relations.KMax : Infinity;
  const upper = kMax === Infinity ? Infinity : kMax + hysteresis;
  if (
    previous === 'pursuit' &&
    ratio >= Math.max(1, k - hysteresis) &&
    ratio <= upper
  ) {
    return 'pursuit';
  }
  if (
    previous === 'evade' &&
    ratio <= 1 / Math.max(1 + EPSILON, k - hysteresis) &&
    ratio >= 1 / upper
  ) {
    return 'evade';
  }
  if (ratio >= k && ratio <= kMax) return 'pursuit';
  if (ratio <= 1 / k && ratio >= 1 / kMax) return 'evade';
  if (ratio > 1 / k && ratio < k) return 'peer';
  return 'ignore';
}

export function relationBetween(
  actorSchool,
  targetSchool,
  relations,
  previous = 'ignore'
) {
  if (actorSchool.id === targetSchool.id) return 'peer';
  return relationForRatio(
    actorSchool.size / targetSchool.size,
    relations,
    previous
  );
}

export class RelationMatrix {
  constructor() {
    this.previous = new Map();
  }

  update(schools, relations) {
    const matrix = schools.map(() => schools.map(() => 'ignore'));
    for (let a = 0; a < schools.length; a += 1) {
      for (let b = 0; b < schools.length; b += 1) {
        const key = `${schools[a].id}>${schools[b].id}`;
        const value = relationBetween(
          schools[a],
          schools[b],
          relations,
          this.previous.get(key) ?? 'ignore'
        );
        matrix[a][b] = value;
        this.previous.set(key, value);
      }
    }
    return matrix;
  }

  reset() {
    this.previous.clear();
  }
}

/**
 * How many cells the flat grid may allocate before the map is used instead.
 * Four million cells is 16 MB of Int32 and only a configuration nobody runs
 * reaches it — a tank ten times wider on every side while the perception
 * radii shrink fivefold. The map has no bounds at all, so it is always there
 * to fall back on.
 */
const MAX_GRID_CELLS = 4_000_000;

/**
 * Which fish are near which fish.
 *
 * Fish are filed into cells of the side of the widest radius any pair test
 * uses, so every neighbour within that radius is in the fish's own cell or one
 * of the 26 around it. That part has not changed.
 *
 * What the fish are filed into has. Cells used to be a Map keyed by the string
 * `"3,-2,7"`: every one of the 27 lookups a fish makes built a string first,
 * which at 680 fish and two passes is some thirty-seven thousand strings per
 * step, all of them garbage immediately. Now the occupied cells are numbered
 * and the fish indices sit in one flat array, sorted by cell, with a second
 * array saying where each cell starts. Building it is a counting sort into
 * arrays that are kept between steps, so a step allocates nothing.
 *
 * A fish's cell is still floor(x / cellSize), on the same lattice as before —
 * the grid is only that lattice cropped to the box the fish occupy. So which
 * fish share a cell, and the order neighbours are handed back in, are
 * unchanged, and so is everything computed from them.
 */
export class SpatialHash3D {
  constructor(cellSize = 1) {
    this.cellSize = Math.max(EPSILON, cellSize);
    // Only the fallback fills this now.
    this.cells = new Map();
    this.positions = null;
    this.alive = null;
    this.count = 0;
    // The flat grid. `_grid` false means the last build used the map.
    this._grid = false;
    this._minX = 0;
    this._minY = 0;
    this._minZ = 0;
    this._nx = 0;
    this._ny = 0;
    this._nz = 0;
    this._cellCount = 0;
    this._start = new Int32Array(0);
    this._cursor = new Int32Array(0);
    this._items = new Int32Array(0);
  }

  key(ix, iy, iz) {
    return `${ix},${iy},${iz}`;
  }

  cellOf(x, y, z) {
    const scale = 1 / this.cellSize;
    return [
      Math.floor(x * scale),
      Math.floor(y * scale),
      Math.floor(z * scale),
    ];
  }

  build(positions, alive, count = alive.length) {
    this.positions = positions;
    this.alive = alive;
    this.count = count;
    const scale = 1 / this.cellSize;

    // The box of cells the living fish occupy. A coordinate that is not finite
    // has no cell, so that build goes to the map, which can key anything.
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let live = 0;
    for (let index = 0; index < count; index += 1) {
      if (!alive[index]) continue;
      const offset = index * 3;
      const x = positions[offset];
      const y = positions[offset + 1];
      const z = positions[offset + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return this._buildMap(positions, alive, count);
      }
      const ix = Math.floor(x * scale);
      const iy = Math.floor(y * scale);
      const iz = Math.floor(z * scale);
      if (ix < minX) minX = ix;
      if (ix > maxX) maxX = ix;
      if (iy < minY) minY = iy;
      if (iy > maxY) maxY = iy;
      if (iz < minZ) minZ = iz;
      if (iz > maxZ) maxZ = iz;
      live += 1;
    }

    this._grid = true;
    this.cells.clear();
    if (live === 0) {
      this._cellCount = 0;
      this._nx = 0;
      this._ny = 0;
      this._nz = 0;
      return this;
    }

    const nx = maxX - minX + 1;
    const ny = maxY - minY + 1;
    const nz = maxZ - minZ + 1;
    const cells = nx * ny * nz;
    if (!Number.isFinite(cells) || cells > MAX_GRID_CELLS) {
      return this._buildMap(positions, alive, count);
    }

    this._minX = minX;
    this._minY = minY;
    this._minZ = minZ;
    this._nx = nx;
    this._ny = ny;
    this._nz = nz;
    this._cellCount = cells;

    if (this._start.length < cells + 1) {
      this._start = new Int32Array(cells + 1);
      this._cursor = new Int32Array(cells);
    } else {
      this._start.fill(0, 0, cells + 1);
    }
    if (this._items.length < live) this._items = new Int32Array(live);
    const start = this._start;
    const cursor = this._cursor;
    const items = this._items;

    // Counting sort: count each cell, turn the counts into starting offsets,
    // then place the fish. Ascending fish index throughout, which is the order
    // the map's buckets were filled in.
    for (let index = 0; index < count; index += 1) {
      if (!alive[index]) continue;
      const offset = index * 3;
      const cell =
        ((Math.floor(positions[offset] * scale) - minX) * ny +
          (Math.floor(positions[offset + 1] * scale) - minY)) *
          nz +
        (Math.floor(positions[offset + 2] * scale) - minZ);
      start[cell + 1] += 1;
    }
    for (let cell = 0; cell < cells; cell += 1) {
      start[cell + 1] += start[cell];
      cursor[cell] = start[cell];
    }
    for (let index = 0; index < count; index += 1) {
      if (!alive[index]) continue;
      const offset = index * 3;
      const cell =
        ((Math.floor(positions[offset] * scale) - minX) * ny +
          (Math.floor(positions[offset + 1] * scale) - minY)) *
          nz +
        (Math.floor(positions[offset + 2] * scale) - minZ);
      items[cursor[cell]] = index;
      cursor[cell] += 1;
    }
    return this;
  }

  /** The old map, kept for the cases the grid cannot take. */
  _buildMap(positions, alive, count = alive.length) {
    this.positions = positions;
    this.alive = alive;
    this.count = count;
    this._grid = false;
    this.cells.clear();
    for (let index = 0; index < count; index += 1) {
      if (!alive[index]) continue;
      const offset = index * 3;
      const [ix, iy, iz] = this.cellOf(
        positions[offset],
        positions[offset + 1],
        positions[offset + 2]
      );
      const key = this.key(ix, iy, iz);
      let bucket = this.cells.get(key);
      if (!bucket) {
        bucket = [];
        this.cells.set(key, bucket);
      }
      bucket.push(index);
    }
    return this;
  }

  forEachCandidate(index, callback) {
    if (!this.alive[index]) return;
    if (!this._grid) return this._mapCandidates(index, callback);
    const offset = index * 3;
    const scale = 1 / this.cellSize;
    const cx = Math.floor(this.positions[offset] * scale) - this._minX;
    const cy = Math.floor(this.positions[offset + 1] * scale) - this._minY;
    const cz = Math.floor(this.positions[offset + 2] * scale) - this._minZ;
    const nx = this._nx;
    const ny = this._ny;
    const nz = this._nz;
    const start = this._start;
    const items = this._items;
    // Cells outside the grid hold no fish, so skipping them is the same as the
    // map finding nothing there.
    for (let x = cx - 1; x <= cx + 1; x += 1) {
      if (x < 0 || x >= nx) continue;
      for (let y = cy - 1; y <= cy + 1; y += 1) {
        if (y < 0 || y >= ny) continue;
        const row = (x * ny + y) * nz;
        for (let z = cz - 1; z <= cz + 1; z += 1) {
          if (z < 0 || z >= nz) continue;
          const cell = row + z;
          const end = start[cell + 1];
          for (let i = start[cell]; i < end; i += 1) {
            const other = items[i];
            if (other !== index) callback(other);
          }
        }
      }
    }
  }

  _mapCandidates(index, callback) {
    const offset = index * 3;
    const [cx, cy, cz] = this.cellOf(
      this.positions[offset],
      this.positions[offset + 1],
      this.positions[offset + 2]
    );
    for (let x = cx - 1; x <= cx + 1; x += 1) {
      for (let y = cy - 1; y <= cy + 1; y += 1) {
        for (let z = cz - 1; z <= cz + 1; z += 1) {
          const bucket = this.cells.get(this.key(x, y, z));
          if (!bucket) continue;
          for (const other of bucket) {
            if (other !== index) callback(other);
          }
        }
      }
    }
  }

  /**
   * Every pair once, the lower index first.
   *
   * The cell walk is written out again rather than calling forEachCandidate,
   * because this is the hottest loop in a step: going through it would build a
   * closure per fish and add a call per candidate, and there are some three
   * hundred thousand candidates in a step.
   */
  forEachPair(callback) {
    if (!this._grid) {
      for (let index = 0; index < this.count; index += 1) {
        if (!this.alive[index]) continue;
        this._mapCandidates(index, (other) => {
          if (other > index) callback(index, other);
        });
      }
      return;
    }
    const positions = this.positions;
    const alive = this.alive;
    const scale = 1 / this.cellSize;
    const nx = this._nx;
    const ny = this._ny;
    const nz = this._nz;
    const start = this._start;
    const items = this._items;
    for (let index = 0; index < this.count; index += 1) {
      if (!alive[index]) continue;
      const offset = index * 3;
      const cx = Math.floor(positions[offset] * scale) - this._minX;
      const cy = Math.floor(positions[offset + 1] * scale) - this._minY;
      const cz = Math.floor(positions[offset + 2] * scale) - this._minZ;
      for (let x = cx - 1; x <= cx + 1; x += 1) {
        if (x < 0 || x >= nx) continue;
        for (let y = cy - 1; y <= cy + 1; y += 1) {
          if (y < 0 || y >= ny) continue;
          const row = (x * ny + y) * nz;
          for (let z = cz - 1; z <= cz + 1; z += 1) {
            if (z < 0 || z >= nz) continue;
            const cell = row + z;
            const end = start[cell + 1];
            for (let i = start[cell]; i < end; i += 1) {
              const other = items[i];
              if (other > index) callback(index, other);
            }
          }
        }
      }
    }
  }
}
