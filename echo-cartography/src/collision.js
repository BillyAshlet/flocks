// scene-independent hard-collision interface.
//
// soft avoidance (rays) handles "dodge in advance"; hard collision handles
// "you cannot get in at all". the two have different jobs: without hard
// collision, separation and panic can still squeeze a device into a wall,
// and rayAABB returns -1 outright when the origin is already inside a box,
// so the wall turns transparent and the point cloud gets generated inside
// the wall.
//
// multi-scene contract:
//   a scene only has to supply one collider, exposing:
//     resolve(x,y,z, radius, vx,vy,vz) -> {x,y,z, vx,vy,vz, hit}
//   the current deep-sea trench is a soup of AABBs; a later curved-surface
//   scene can swap in a triangle-mesh / SDF backend, with no change needed
//   on the flock side.

import { TANK } from './params.js';

/**
 * build a collision world from a list of AABBs (what the current scene uses).
 * boxes: [{min:{x,y,z}, max:{x,y,z}}]
 */
export function createAabbCollider(boxes = []) {
  const world = {
    boxes: [],
    // uniform grid: each box is registered in every cell it covers, and a
    // query only looks at 3x3x3
    cell: 4,
    origin: [0, 0, 0],
    dim: [1, 1, 1],
    grid: null,
    _candidates: null,
    _seen: null,
    _stamp: 0,
  };

  function rebuild(list) {
    world.boxes = list.map((b) => ({
      minx: b.min.x, miny: b.min.y, minz: b.min.z,
      maxx: b.max.x, maxy: b.max.y, maxz: b.max.z,
    }));
    const n = world.boxes.length;
    if (n === 0) {
      world.grid = null;
      return;
    }

    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (const b of world.boxes) {
      if (b.minx < lo[0]) lo[0] = b.minx;
      if (b.miny < lo[1]) lo[1] = b.miny;
      if (b.minz < lo[2]) lo[2] = b.minz;
      if (b.maxx > hi[0]) hi[0] = b.maxx;
      if (b.maxy > hi[1]) hi[1] = b.maxy;
      if (b.maxz > hi[2]) hi[2] = b.maxz;
    }
    // pad out by one ring, so queries right at the edge do not miss
    const pad = 2;
    lo = [lo[0] - pad, lo[1] - pad, lo[2] - pad];
    hi = [hi[0] + pad, hi[1] + pad, hi[2] + pad];
    const cell = Math.max(2, Math.min(8, Math.cbrt((hi[0]-lo[0])*(hi[1]-lo[1])*(hi[2]-lo[2]) / Math.max(n, 1))));
    world.cell = cell;
    world.origin = lo;
    world.dim = [
      Math.max(1, Math.ceil((hi[0] - lo[0]) / cell)),
      Math.max(1, Math.ceil((hi[1] - lo[1]) / cell)),
      Math.max(1, Math.ceil((hi[2] - lo[2]) / cell)),
    ];
    const total = world.dim[0] * world.dim[1] * world.dim[2];
    const grid = new Array(total);
    for (let i = 0; i < total; i += 1) grid[i] = [];

    const cellCoord = (x, y, z) => [
      Math.max(0, Math.min(world.dim[0] - 1, Math.floor((x - lo[0]) / cell))),
      Math.max(0, Math.min(world.dim[1] - 1, Math.floor((y - lo[1]) / cell))),
      Math.max(0, Math.min(world.dim[2] - 1, Math.floor((z - lo[2]) / cell))),
    ];

    for (let i = 0; i < n; i += 1) {
      const b = world.boxes[i];
      const c0 = cellCoord(b.minx, b.miny, b.minz);
      const c1 = cellCoord(b.maxx, b.maxy, b.maxz);
      for (let z = c0[2]; z <= c1[2]; z += 1)
        for (let y = c0[1]; y <= c1[1]; y += 1)
          for (let x = c0[0]; x <= c1[0]; x += 1)
            grid[(z * world.dim[1] + y) * world.dim[0] + x].push(i);
    }
    world.grid = grid;
    world._candidates = new Int32Array(n);
    world._seen = new Int32Array(n).fill(-1);
    world._stamp = 0;
  }

  rebuild(boxes);

  function gather(x, y, z) {
    if (!world.grid) return 0;
    const c = world.cell;
    const o = world.origin;
    const d = world.dim;
    const ix = Math.max(0, Math.min(d[0] - 1, Math.floor((x - o[0]) / c)));
    const iy = Math.max(0, Math.min(d[1] - 1, Math.floor((y - o[1]) / c)));
    const iz = Math.max(0, Math.min(d[2] - 1, Math.floor((z - o[2]) / c)));
    world._stamp += 1;
    let n = 0;
    for (let dz = -1; dz <= 1; dz += 1) {
      const cz = iz + dz;
      if (cz < 0 || cz >= d[2]) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        const cy = iy + dy;
        if (cy < 0 || cy >= d[1]) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const cx = ix + dx;
          if (cx < 0 || cx >= d[0]) continue;
          const bucket = world.grid[(cz * d[1] + cy) * d[0] + cx];
          for (let k = 0; k < bucket.length; k += 1) {
            const id = bucket[k];
            if (world._seen[id] === world._stamp) continue;
            world._seen[id] = world._stamp;
            world._candidates[n] = id;
            n += 1;
          }
        }
      }
    }
    return n;
  }

  // sphere vs AABB: on penetration, push out along the shortest separating
  // axis and return whether it hit. writes nx,ny,nz = the unit normal
  // pointing into free space (the push-out direction).
  function separateOne(x, y, z, r, b, outN) {
    // the closest point on the box
    const cx = Math.max(b.minx, Math.min(x, b.maxx));
    const cy = Math.max(b.miny, Math.min(y, b.maxy));
    const cz = Math.max(b.minz, Math.min(z, b.maxz));
    let dx = x - cx;
    let dy = y - cy;
    let dz = z - cz;
    const d2 = dx * dx + dy * dy + dz * dz;

    if (d2 > 1e-12) {
      // sphere center is outside the box (or exactly on its surface)
      const dist = Math.sqrt(d2);
      if (dist >= r) return 0;
      const push = (r - dist) / dist;
      outN[0] = dx / dist;
      outN[1] = dy / dist;
      outN[2] = dz / dist;
      return push * dist; // push-out distance
    }

    // sphere center is inside the box: push out along the axis with the
    // shallowest penetration
    const px = Math.min(x - b.minx, b.maxx - x);
    const py = Math.min(y - b.miny, b.maxy - y);
    const pz = Math.min(z - b.minz, b.maxz - z);
    if (px <= py && px <= pz) {
      outN[0] = x >= (b.minx + b.maxx) * 0.5 ? 1 : -1;
      outN[1] = 0;
      outN[2] = 0;
      return px + r;
    }
    if (py <= pz) {
      outN[0] = 0;
      outN[1] = y >= (b.miny + b.maxy) * 0.5 ? 1 : -1;
      outN[2] = 0;
      return py + r;
    }
    outN[0] = 0;
    outN[1] = 0;
    outN[2] = z >= (b.minz + b.maxz) * 0.5 ? 1 : -1;
    return pz + r;
  }

  const _n = [0, 0, 0];

  /**
   * push a sphere out of every obstacle, and remove the inward component of
   * its velocity (slide along the surface rather than bouncing off).
   * iterate a few times: in the corner of a step, one pass may only leave one
   * box and enter another.
   */
  function resolve(x, y, z, radius, vx, vy, vz) {
    const r = Math.max(0, radius);
    let hit = false;
    for (let iter = 0; iter < 4; iter += 1) {
      const count = gather(x, y, z);
      let moved = false;
      // with no grid, fall back to checking all of them
      const nBox = world.boxes.length;
      const useGrid = world.grid && count > 0;
      const total = useGrid ? count : nBox;
      for (let i = 0; i < total; i += 1) {
        const bi = useGrid ? world._candidates[i] : i;
        const b = world.boxes[bi];
        const depth = separateOne(x, y, z, r, b, _n);
        if (depth <= 1e-8) continue;
        x += _n[0] * depth;
        y += _n[1] * depth;
        z += _n[2] * depth;
        // remove the velocity heading into the solid, keep the tangential
        // slide
        const vn = vx * _n[0] + vy * _n[1] + vz * _n[2];
        if (vn < 0) {
          vx -= _n[0] * vn;
          vy -= _n[1] * vn;
          vz -= _n[2] * vn;
        }
        hit = true;
        moved = true;
      }
      if (!moved) break;
    }

    // hard clamp to the inner walls of the mission survey box (TANK is the
    // mission area, not real terrain; this only stops devices swimming out
    // of the simulated range)
    const hx = TANK.width / 2 - r;
    const hy = TANK.height / 2 - r;
    const hz = TANK.depth / 2 - r;
    if (x > hx) { x = hx; if (vx > 0) vx = 0; hit = true; }
    if (x < -hx) { x = -hx; if (vx < 0) vx = 0; hit = true; }
    if (y > hy) { y = hy; if (vy > 0) vy = 0; hit = true; }
    if (y < -hy) { y = -hy; if (vy < 0) vy = 0; hit = true; }
    if (z > hz) { z = hz; if (vz > 0) vz = 0; hit = true; }
    if (z < -hz) { z = -hz; if (vz < 0) vz = 0; hit = true; }

    return { x, y, z, vx, vy, vz, hit };
  }

  return {
    kind: 'aabb',
    resolve,
    setBoxes: rebuild,
    get count() { return world.boxes.length; },
  };
}

/**
 * curved-surface / mesh scenes will go through here later (a placeholder for
 * now, with the interface already lined up).
 * implementation sketch:
 *   - triangle mesh + BVH: sphere vs triangle, pushed outside the triangle
 *   - or SDF: pos -= grad * (radius - dist)
 * flock only knows about resolve() and does not care about the backend.
 */
export function createMeshCollider(/* mesh */) {
  return {
    kind: 'mesh',
    resolve(x, y, z, radius, vx, vy, vz) {
      // returns its input unchanged until this is wired up; fill it in when
      // the scene switches to a mesh
      return { x, y, z, vx, vy, vz, hit: false };
    },
  };
}
