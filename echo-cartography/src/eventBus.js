// event bus -- layer L2. the swarm emits into it, the terminal reads from it.
//
// it is also the point where bandwidth is measured: the central claim of
// the whole project is that "sending events is one to two orders of
// magnitude cheaper than sending raw data", so that number has to be
// computed, not written down as a constant in a document. that is why the
// byte counts here are accumulated field by field instead of being a
// single fixed number.
//
// this file does not import three.js.

import { buildFan, decodeFace } from './sensor.js';

// ── byte budget (real packed sizes, no transport wrapper such as JSON) ──
//
// one emission (ping) = one event, rather than one event per ray:
//   origin 3xf32(12) + heading 3xf32(12) + half-angle u8(1) + hit mask u8(1)
//   + t f32(4) + id u16(2)                                  = 32 bytes fixed
//   + one f32 for each ray that actually hit                + 4 x hit count
//
// rays that missed cost no float: the mask already says they missed, and
// the length of a miss is the sensor range, which is a known quantity.
//
// [measured result, which did not match the first estimate; written down
//  here so it does not get miscalculated again]
//   on average only 1.22 rays per emission hit (not all five); the other
//   3.78 are misses.
//   packed, that averages 36.9 bytes; the same hits sent as one event each
//   would be 39.1 bytes.
//   so packing only saves 1.06x in bytes -- the original 3.1x estimate,
//   which assumed all five rays hit, was wrong.
//
// why it is still worth doing: when the rays are sent separately, the
// misses are thrown away entirely. the packed version spends almost the
// same bytes and additionally carries 3.78 pieces of free-space evidence
// per emission -- and free-space carving is the only way to tell static
// geometry from dynamic targets.
//   → the same bandwidth, several times the information.
//
// what is saved is not a compression trick, it is redundancy: the five
// rays share one origin, and their directions are fully determined by the
// heading plus the fan geometry -- anything derivable does not need to be
// uploaded. a real sonar also sends one packet of beams per ping, not one
// packet per beam.
//
// the real large cut still has to come from spatial deduplication (no
// repeated emissions while flying flat along a wall); that is M1's job.
//
// panic event  pos(12) + intensity(4) + t(4) + id(2) + type(1) = 23 → 24
//
// baseline for comparison (fully centralised, all poses)
//           pos(12) + vel(12) + quat(16) + t(4) = 44, and it has to be sent
//           at 60 Hz
export const BYTES = { panic: 24, pose: 44 };

export function pingBytes(hitCount) {
  return 32 + 4 * hitCount;
}

// direction buffer used for decoding, cached by ray count so that every
// event does not allocate a new array
let _dirsCache = null;
function _decodeDirs(n) {
  if (!_dirsCache || _dirsCache.length !== n * 3) _dirsCache = new Float32Array(n * 3);
  return _dirsCache;
}

const MAX_LOG = 200000; // ~20 min at typical event rates; drops oldest when full

export class EventBus {
  constructor() {
    this.log = [];
    this.frame = []; // events new this frame; the terminal consumes them each frame
    this.subscribers = [];

    // rolling one-second window of statistics. it uses a queue of
    // timestamps rather than "zero the counters every second", otherwise
    // the reading jumps around at each reset and looks like a bug.
    this._window = [];
    this.eventsPerSec = 0;
    this.bytesPerSec = 0;
    this.totalEvents = 0;
    this.totalBytes = 0;
  }

  _push(e, bytes) {
    e.bytes = bytes;
    this.log.push(e);
    if (this.log.length > MAX_LOG) this.log.shift();
    this.frame.push(e);
    this._window.push(e);
    this.totalEvents += 1;
    this.totalBytes += bytes;
    for (const fn of this.subscribers) fn(e);
  }

  // one emission. ts holds the hit distance of each ray (-1 = miss) and a
  // copy is taken -- what comes in is the scratch array the sensor reuses
  // every frame, and without the copy the next device would overwrite it.
  ping(ox, oy, oz, dx, dy, dz, halfAngleDeg, ts, faces, bnd, rayCount, range, t, id, vertHalfAngleDeg) {
    const copy = new Float32Array(rayCount);
    const faceCopy = new Uint8Array(rayCount);
    let mask = 0;
    let bmask = 0;
    let hitCount = 0;
    for (let k = 0; k < rayCount; k += 1) {
      copy[k] = ts[k];
      faceCopy[k] = faces ? faces[k] : 0;
      if (ts[k] >= 0) {
        mask |= 1 << k;
        hitCount += 1;
        // the rays that hit the mission boundary still carry their real
        // distance (free space has to be carved right up to the wall), but
        // they are flagged so the terminal does not deposit them as terrain.
        if (bnd && bnd[k]) bmask |= 1 << k;
      }
    }
    // all N distances are still kept in memory (it makes decoding easy),
    // but only the rays that hit are billed -- in a real packed message the
    // rays that missed take no float at all, the mask is enough.
    // bandwidth is the central claim of this project, so this number has to
    // reflect what is really uploaded.
    // face costs 1 byte per hit: it encodes only 6 axis-aligned directions,
    // so it adds almost no bandwidth.
    this._push(
      { type: 'ping', ox, oy, oz, dx, dy, dz, halfAngleDeg, vertHalfAngleDeg: vertHalfAngleDeg == null ? halfAngleDeg : vertHalfAngleDeg, ts: copy, faces: faceCopy, mask, bmask, range, t, id },
      pingBytes(hitCount) + hitCount
    );
  }

  panic(x, y, z, intensity, t, id) {
    this._push({ type: 'panic', x, y, z, intensity, t, id }, BYTES.panic);
  }

  // ── decoding ────────────────────────────────────────────────
  //
  // what the terminal receives is a compact ping, but the map builder wants
  // individual rays. this function unpacks the emission back into rays, so
  // that L3 never has to know anything about the fan geometry -- saving
  // bandwidth on the uplink is L2's business, and L3's interface stays in
  // the plainest possible form, one ray at a time.
  //
  // the callback is invoked per ray as (ox,oy,oz, hx,hy,hz, hit, nx,ny,nz):
  //   hit=true  → the endpoint is occupied and origin→hit is free along the
  //               way; n* is the surface normal pointing into free space
  //   hit=false → the whole origin→endpoint segment is free (no echo is a
  //               measurement too)
  forEachRay(e, cb) {
    if (e.type !== 'ping') return;
    const n = e.ts.length;
    const dirs = buildFan(e.dx, e.dy, e.dz, e.halfAngleDeg, n, _decodeDirs(n), undefined, undefined, e.vertHalfAngleDeg);
    const normal = [0, 0, 0];
    for (let k = 0; k < n; k += 1) {
      const t = e.ts[k];
      const reached = t >= 0;
      // rays that hit the mission bounds: the length used is the real
      // distance (free space has to be carved all the way to the wall), but
      // hit=false -- that wall is not terrain and should leave no point on
      // the map. measured, it once made up 28.4% of the point cloud.
      const isBoundary = reached && !!((e.bmask || 0) & (1 << k));
      const hit = reached && !isBoundary;
      const len = reached ? t : e.range;
      const o = k * 3;
      if (hit && e.faces) decodeFace(e.faces[k], normal);
      else normal[0] = normal[1] = normal[2] = 0;
      cb(
        e.ox, e.oy, e.oz,
        e.ox + dirs[o] * len,
        e.oy + dirs[o + 1] * len,
        e.oz + dirs[o + 2] * len,
        hit,
        normal[0], normal[1], normal[2],
        k
      );
    }
  }

  subscribe(fn) {
    this.subscribers.push(fn);
    return () => {
      const i = this.subscribers.indexOf(fn);
      if (i >= 0) this.subscribers.splice(i, 1);
    };
  }

  // called at the end of each frame: roll the stats window, clear the frame queue
  tick(time) {
    const cutoff = time - 1;
    while (this._window.length && this._window[0].t < cutoff) {
      this._window.shift();
    }
    this.eventsPerSec = this._window.length;
    let bytes = 0;
    for (const e of this._window) bytes += e.bytes;
    this.bytesPerSec = bytes;
    this.frame.length = 0;
  }

  // baseline for comparison: how much bandwidth these same devices would
  // need if they switched to uploading full poses every frame
  centralizedBytesPerSec(agentCount, hz = 60) {
    return agentCount * hz * BYTES.pose;
  }

  reset() {
    this.log.length = 0;
    this.frame.length = 0;
    this._window.length = 0;
    this.eventsPerSec = 0;
    this.bytesPerSec = 0;
    this.totalEvents = 0;
    this.totalBytes = 0;
  }
}
