const EPSILON = 1e-8;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function length3(x, y, z) {
  return Math.hypot(x, y, z);
}

export function toObstacleLocal(point, obstacle) {
  let x = point[0] - obstacle.x;
  let y = point[1] - obstacle.y;
  let z = point[2] - obstacle.z;

  // Inverse XYZ Euler: undo Z, then Y, then X.
  let angle = -obstacle.rotationZ;
  let cosine = Math.cos(angle);
  let sine = Math.sin(angle);
  [x, y] = [cosine * x - sine * y, sine * x + cosine * y];
  angle = -obstacle.rotationY;
  cosine = Math.cos(angle);
  sine = Math.sin(angle);
  [x, z] = [cosine * x + sine * z, -sine * x + cosine * z];
  angle = -obstacle.rotationX;
  cosine = Math.cos(angle);
  sine = Math.sin(angle);
  [y, z] = [cosine * y - sine * z, sine * y + cosine * z];
  return [x, y, z];
}

export function signedDistanceBox(point, halfExtents) {
  const qx = Math.abs(point[0]) - halfExtents[0];
  const qy = Math.abs(point[1]) - halfExtents[1];
  const qz = Math.abs(point[2]) - halfExtents[2];
  const outside = length3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  const inside = Math.min(Math.max(qx, Math.max(qy, qz)), 0);
  return outside + inside;
}

export function signedDistanceCappedCylinderZ(point, radius, halfDepth) {
  const radial = Math.hypot(point[0], point[1]) - radius;
  const axial = Math.abs(point[2]) - halfDepth;
  return (
    Math.hypot(Math.max(radial, 0), Math.max(axial, 0)) +
    Math.min(Math.max(radial, axial), 0)
  );
}

export function obstacleSignedDistance(point, obstacle) {
  if (!obstacle.enabled) return Infinity;
  const local = toObstacleLocal(point, obstacle);
  if (obstacle.type === 'ring') {
    const outer = signedDistanceBox(local, [
      obstacle.width / 2,
      obstacle.height / 2,
      obstacle.thickness / 2,
    ]);
    const holeRadius = obstacle.holeDiameter / 2;
    const hole = signedDistanceCappedCylinderZ(
      local,
      holeRadius,
      obstacle.thickness
    );
    const piercedPanel = Math.max(outer, -hole);

    // A shallow annular lip makes frameDepth an actual geometric control,
    // while preserving exactly the configured clear hole.
    const outerLip = signedDistanceCappedCylinderZ(
      local,
      holeRadius + obstacle.frameDepth,
      obstacle.thickness
    );
    const innerLip = signedDistanceCappedCylinderZ(
      local,
      holeRadius,
      obstacle.thickness * 1.25
    );
    return Math.min(piercedPanel, Math.max(outerLip, -innerLip));
  }
  return signedDistanceBox(local, [
    obstacle.width / 2,
    obstacle.height / 2,
    obstacle.depth / 2,
  ]);
}

export function tankWallClearance(point, tank) {
  return Math.min(
    tank.width / 2 - Math.abs(point[0]),
    tank.height / 2 - Math.abs(point[1]),
    tank.depth / 2 - Math.abs(point[2])
  );
}

export function enabledObstacleSpecs(config) {
  if (!config.obstacles.enabled) return [];
  return Object.entries(config.obstacles)
    .filter(
      ([key, value]) =>
        key !== 'enabled' &&
        value &&
        typeof value === 'object' &&
        value.enabled
    )
    .map(([id, value]) => ({ id, ...value }));
}

export function sceneClearance(point, config, includeWalls = true) {
  let distance = includeWalls
    ? tankWallClearance(point, config.tank)
    : Infinity;
  for (const obstacle of enabledObstacleSpecs(config)) {
    distance = Math.min(distance, obstacleSignedDistance(point, obstacle));
  }
  return distance;
}

export function numericGradient(sample, point, epsilon) {
  const e = Math.max(EPSILON, epsilon);
  const x =
    sample([point[0] + e, point[1], point[2]]) -
    sample([point[0] - e, point[1], point[2]]);
  const y =
    sample([point[0], point[1] + e, point[2]]) -
    sample([point[0], point[1] - e, point[2]]);
  const z =
    sample([point[0], point[1], point[2] + e]) -
    sample([point[0], point[1], point[2] - e]);
  const magnitude = Math.hypot(x, y, z);
  if (magnitude <= EPSILON) return [0, 0, 0];
  return [x / magnitude, y / magnitude, z / magnitude];
}

function insideRingAabb(point, obstacle, margin) {
  if (!obstacle.enabled || obstacle.type !== 'ring') return false;
  const local = toObstacleLocal(point, obstacle);
  return (
    Math.abs(local[0]) <= obstacle.width / 2 + margin &&
    Math.abs(local[1]) <= obstacle.height / 2 + margin &&
    Math.abs(local[2]) <= obstacle.thickness / 2 + margin
  );
}

export class DistanceField3D {
  constructor(config) {
    this.rebuild(config);
  }

  rebuild(config) {
    this.config = config;
    this.cellSize = config.distanceField.cellSize;
    this.padding = Math.max(
      1,
      Math.round(config.distanceField.paddingCells)
    );
    const tank = config.tank;
    this.origin = [
      -tank.width / 2 - this.padding * this.cellSize,
      -tank.height / 2 - this.padding * this.cellSize,
      -tank.depth / 2 - this.padding * this.cellSize,
    ];
    this.dimensions = [
      Math.ceil(tank.width / this.cellSize) + 1 + this.padding * 2,
      Math.ceil(tank.height / this.cellSize) + 1 + this.padding * 2,
      Math.ceil(tank.depth / this.cellSize) + 1 + this.padding * 2,
    ];
    const [nx, ny, nz] = this.dimensions;
    this.values = new Float32Array(nx * ny * nz);
    let offset = 0;
    for (let z = 0; z < nz; z += 1) {
      const pz = this.origin[2] + z * this.cellSize;
      for (let y = 0; y < ny; y += 1) {
        const py = this.origin[1] + y * this.cellSize;
        for (let x = 0; x < nx; x += 1) {
          const px = this.origin[0] + x * this.cellSize;
          this.values[offset] = sceneClearance([px, py, pz], config);
          offset += 1;
        }
      }
    }
    return this;
  }

  index(x, y, z) {
    const [nx, ny] = this.dimensions;
    return x + nx * (y + ny * z);
  }

  valueAt(x, y, z) {
    const [nx, ny, nz] = this.dimensions;
    const ix = clamp(x, 0, nx - 1);
    const iy = clamp(y, 0, ny - 1);
    const iz = clamp(z, 0, nz - 1);
    return this.values[this.index(ix, iy, iz)];
  }

  sample(point) {
    const gridX = (point[0] - this.origin[0]) / this.cellSize;
    const gridY = (point[1] - this.origin[1]) / this.cellSize;
    const gridZ = (point[2] - this.origin[2]) / this.cellSize;
    const x0 = Math.floor(gridX);
    const y0 = Math.floor(gridY);
    const z0 = Math.floor(gridZ);
    const tx = clamp(gridX - x0, 0, 1);
    const ty = clamp(gridY - y0, 0, 1);
    const tz = clamp(gridZ - z0, 0, 1);
    const lerp = (a, b, t) => a + (b - a) * t;
    const c000 = this.valueAt(x0, y0, z0);
    const c100 = this.valueAt(x0 + 1, y0, z0);
    const c010 = this.valueAt(x0, y0 + 1, z0);
    const c110 = this.valueAt(x0 + 1, y0 + 1, z0);
    const c001 = this.valueAt(x0, y0, z0 + 1);
    const c101 = this.valueAt(x0 + 1, y0, z0 + 1);
    const c011 = this.valueAt(x0, y0 + 1, z0 + 1);
    const c111 = this.valueAt(x0 + 1, y0 + 1, z0 + 1);
    const c00 = lerp(c000, c100, tx);
    const c10 = lerp(c010, c110, tx);
    const c01 = lerp(c001, c101, tx);
    const c11 = lerp(c011, c111, tx);
    return lerp(lerp(c00, c10, ty), lerp(c01, c11, ty), tz);
  }

  query(point) {
    if (!this.config.distanceField.enabled) {
      const clearance = sceneClearance(point, this.config);
      return {
        clearance,
        gradient: numericGradient(
          (candidate) => sceneClearance(candidate, this.config),
          point,
          this.config.distanceField.gradientEpsilon
        ),
        analytic: true,
      };
    }
    let clearance = this.sample(point);
    const refineDistance =
      this.config.distanceField.analyticRefineDistance;
    const refine =
      Math.abs(clearance) < refineDistance ||
      enabledObstacleSpecs(this.config).some((obstacle) =>
        insideRingAabb(point, obstacle, refineDistance)
      );
    const sampler = refine
      ? (candidate) => sceneClearance(candidate, this.config)
      : (candidate) => this.sample(candidate);
    if (refine) clearance = sampler(point);
    return {
      clearance,
      gradient: numericGradient(
        sampler,
        point,
        this.config.distanceField.gradientEpsilon
      ),
      analytic: refine,
    };
  }
}
