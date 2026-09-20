// M2: exploration phase machine + frontier extraction + virtual altitude.
//
// phases: ROAM → PLAN → FRONTIER → RECALL
//   ROAM     free roam; coarse plan-view coverage stalls or hits its
//            target → PLAN
//   PLAN     fill the gaps in the fine plan view (columns and pits are not
//            distinguished); fine coverage stalls, hits its target, or
//            times out → FRONTIER
//   FRONTIER coarse cells that are free ∩ unknown; assignable clusters
//            exhausted → RECALL
//
// this file does not import three.js.

import { FRONTIER, PLAN, MAP, ALTITUDE, FLOCK, RECALL, TANK } from './params.js';

const _c = [0, 0, 0];
const NEI = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];
// plan-view 4-connectivity (xz plane, walked on the plan map's linear index)
const NEI4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class Terminal {
  constructor(grid) {
    this.grid = grid;
    this.lastUpdate = -Infinity;
    this.frontierCount = 0;
    this.clusterCount = 0;
    this.target = null;
    this.targets = null;
    this.params = null;
    this.phase = 'roam';
    this.columnCoverage = 0;
    this.fineCoverage = 0;
    this.recalled = false;
    this._stamp = 1;
    this._nextExpandAt = 0;
    this._coarseHist = null;
    this._fineHist = null;
    this._planEnteredAt = -Infinity;
    this._planMap = null;
  }

  _clampBand() {
    let lo = ALTITUDE.yMin;
    let hi = ALTITUDE.yMax;
    if (lo > hi) {
      const t = lo;
      lo = hi;
      hi = t;
    }
    ALTITUDE.yMin = Math.max(ALTITUDE.absMin, lo);
    ALTITUDE.yMax = Math.min(ALTITUDE.absMax, hi);
  }

  _expandAltitude(time) {
    if (!ALTITUDE.enabled || !ALTITUDE.autoExpand) return;
    if (time < this._nextExpandAt) return;
    this._nextExpandAt = time + ALTITUDE.expandEvery;
    const step = ALTITUDE.expandStep;
    ALTITUDE.yMin -= step;
    if (ALTITUDE.yMax < 8) {
      ALTITUDE.yMax = Math.min(ALTITUDE.absMax, ALTITUDE.yMax + step * 0.25);
    }
    this._clampBand();
  }

  _inBand(y, margin = 0) {
    return y >= ALTITUDE.yMin - margin && y <= ALTITUDE.yMax + margin;
  }

  _clampY(y) {
    const pad = 0.5;
    return Math.max(ALTITUDE.yMin + pad, Math.min(ALTITUDE.yMax - pad, y));
  }

  reset() {
    this.lastUpdate = -Infinity;
    this.frontierCount = 0;
    this.clusterCount = 0;
    this.target = null;
    this.targets = null;
    this._nextExpandAt = 0;
    this._coarseHist = null;
    this._fineHist = null;
    this._planEnteredAt = -Infinity;
    this.columnCoverage = 0;
    this.fineCoverage = 0;
    this.recalled = false;
    this.departed = false;
    this._frontHist = null;
    this.phase = 'roam';
    this.phaseEnteredAt = 0;
    this.phaseNote = '';
    // the automatic pipeline restarts from ROAM; with FRONTIER.enabled
    // left on manually it goes straight to frontier
    if (FRONTIER.autoStart) FRONTIER.enabled = false;
    this.params = null;
  }

  _pack({ mode, target, targets, seekWeight, verticalWeight, sep, coh, ali }) {
    return {
      mode,
      frontier: mode === 'frontier' || mode === 'plan' || mode === 'recall',
      target: target ? [target.x, target.y, target.z] : null,
      targets: targets || null,
      seekWeight: seekWeight || 0,
      verticalWeight: verticalWeight || 0,
      separationScale: sep == null ? 1 : sep,
      cohesionScale: coh == null ? 1 : coh,
      alignmentScale: ali == null ? 1 : ali,
    };
  }

  _centroid(flock, out) {
    const n = flock.count;
    if (n <= 0) {
      out[0] = out[1] = out[2] = 0;
      return out;
    }
    let x = 0;
    let y = 0;
    let z = 0;
    const p = flock.positions;
    for (let i = 0; i < n; i += 1) {
      const o = i * 3;
      x += p[o];
      y += p[o + 1];
      z += p[o + 2];
    }
    const inv = 1 / n;
    out[0] = x * inv;
    out[1] = y * inv;
    out[2] = z * inv;
    return out;
  }

  _pushHist(hist, value, window) {
    if (!hist) hist = [];
    hist.push(value);
    if (hist.length > window) hist.shift();
    return hist;
  }

  _stalled(hist, window, delta, minCov, value) {
    return (
      hist &&
      hist.length >= window &&
      hist[hist.length - 1] - hist[0] < delta &&
      value >= minCov
    );
  }

  // fine plan-view coverage + list of gaps (map value 0 = gap)
  _updateFine() {
    const plan = this.grid.fillPlanMap(this._planMap, PLAN.bin);
    this._planMap = plan.map;
    const n = plan.width * plan.height;
    let known = 0;
    for (let i = 0; i < n; i += 1) if (this._planMap[i] !== 0) known += 1;
    this.fineCoverage = n > 0 ? known / n : 0;
    return plan;
  }

  // plan view B: connected components of gaps → the target is the
  // component centroid (go into the hole), not the nearest outer edge to
  // the swarm.
  // scoring: bigger components first, components touching existing solid
  // first, ones that are too far away penalised.
  _planClusters(plan, flock) {
    const map = plan.map;
    const W = plan.width;
    const H = plan.height;
    const bin = plan.bin;
    const n = W * H;
    if (!this._pvisited || this._pvisited.length !== n) {
      this._pvisited = new Int32Array(n);
      this._pstamp = 1;
    }
    this._pstamp += 1;
    if (this._pstamp > 0x7ffffffe) {
      this._pvisited.fill(0);
      this._pstamp = 1;
    }
    const visited = this._pvisited;
    const stamp = this._pstamp;

    this._centroid(flock, _c);
    const fx = _c[0];
    const fy = _c[1];
    const fz = _c[2];
    const midY = ALTITUDE.enabled
      ? 0.5 * (ALTITUDE.yMin + ALTITUDE.yMax)
      : fy;

    const o = this.grid.origin;
    const cell = bin * this.grid.voxel;
    const worldX = (px) => o[0] + (px + 0.5) * cell;
    const worldZ = (pz) => o[2] + (pz + 0.5) * cell;

    const soft = PLAN.distSoft || 28;
    const occBonus = PLAN.occAdjacentBonus || 1.45;
    const sizePow = PLAN.sizePower || 0.65;
    const maxD = PLAN.maxAssignDist || 95;

    const clusters = [];
    for (let i = 0; i < n; i += 1) {
      if (map[i] !== 0 || visited[i] === stamp) continue;
      const q = [i];
      visited[i] = stamp;
      let head = 0;
      let count = 0;
      let sumX = 0;
      let sumZ = 0;
      let touchOcc = 0;
      while (head < q.length) {
        const idx = q[head++];
        const px = idx % W;
        const pz = (idx / W) | 0;
        sumX += worldX(px);
        sumZ += worldZ(pz);
        count += 1;
        for (let k = 0; k < 4; k += 1) {
          const nx = px + NEI4[k][0];
          const nz = pz + NEI4[k][1];
          if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
          const j = nz * W + nx;
          const kind = map[j];
          // touching an occupied column = more like a top or a pit edge
          // than the empty space outside the mission box
          if (kind === 2) touchOcc += 1;
          if (visited[j] === stamp) continue;
          if (kind !== 0) continue;
          visited[j] = stamp;
          q.push(j);
        }
      }
      if (count < PLAN.minCluster) continue;
      const x = sumX / count;
      const z = sumZ / count;
      const dx = x - fx;
      const dz = z - fz;
      const dist2 = dx * dx + dz * dz;
      const dist = Math.sqrt(dist2);
      if (dist > maxD) continue; // too far away, do not assign it yet
      // score: size × solid-adjacency bonus / soft distance penalty
      let score = Math.pow(count, sizePow) / (1 + dist / soft);
      if (touchOcc > 0) score *= occBonus * (1 + Math.min(touchOcc, 24) * 0.02);
      clusters.push({
        x,
        y: midY,
        z,
        size: count,
        dist2,
        touchOcc,
        score,
      });
    }
    return clusters;
  }

  // plan-view-specific picking: highest combined score first (big / near /
  // touching solid), then spatial spread
  _pickPlanTargets(clusters, flock) {
    const G = Math.max(1, FLOCK.groupCount);
    const targets = [];
    if (!clusters.length) return { best: null, targets };

    const pool = clusters.slice().sort((a, b) => b.score - a.score);
    // first pick: the highest combined score (not simply the nearest outer
    // edge)
    const picked = [pool.shift()];

    while (picked.length < G && pool.length) {
      let bi = 0;
      let bScore = -Infinity;
      for (let i = 0; i < pool.length; i += 1) {
        const c = pool[i];
        let minD = Infinity;
        for (const q of picked) {
          const d = (c.x - q.x) ** 2 + (c.z - q.z) ** 2;
          if (d < minD) minD = d;
        }
        // spread × original combined score
        const score = Math.sqrt(minD) * (0.35 + c.score);
        if (score > bScore) {
          bScore = score;
          bi = i;
        }
      }
      picked.push(pool.splice(bi, 1)[0]);
    }

    const bandOn = ALTITUDE.enabled;
    const spread = PLAN.verticalSpread || 0;
    for (let gi = 0; gi < G; gi += 1) {
      const c = picked[gi % picked.length];
      let y = c.y;
      // half the subgroups biased up, half down: probe up and down once
      // inside the gap
      if (spread > 0) y += (gi % 2 === 0 ? 1 : -1) * spread;
      if (bandOn) y = this._clampY(y);
      targets.push([c.x, y, c.z]);
    }
    let best = {
      x: picked[0].x,
      y: bandOn ? this._clampY(targets[0][1]) : targets[0][1],
      z: picked[0].z,
      size: picked[0].size,
      dist2: picked[0].dist2,
      score: picked[0].score,
    };
    return { best, targets };
  }

  _pickDispersed(clusters, flock) {
    const G = Math.max(1, FLOCK.groupCount);
    const targets = [];
    if (!clusters.length) return { best: null, targets };

    this._centroid(flock, _c);
    // ensure dist2 relative to flock if missing
    for (const c of clusters) {
      if (c.dist2 == null) {
        const dx = c.x - _c[0];
        const dy = c.y - _c[1];
        const dz = c.z - _c[2];
        c.dist2 = dx * dx + dy * dy + dz * dz;
      }
    }

    const pool = clusters.slice();
    let first = 0;
    for (let i = 1; i < pool.length; i += 1) {
      if (pool[i].dist2 < pool[first].dist2) first = i;
    }
    const picked = [pool.splice(first, 1)[0]];

    while (picked.length < G && pool.length) {
      let bi = 0;
      let bScore = -Infinity;
      for (let i = 0; i < pool.length; i += 1) {
        const c = pool[i];
        let minD = Infinity;
        for (const q of picked) {
          const d = (c.x - q.x) ** 2 + (c.y - q.y) ** 2 + (c.z - q.z) ** 2;
          if (d < minD) minD = d;
        }
        const score = minD * (1 + Math.min(c.size, 40) * 0.01);
        if (score > bScore) {
          bScore = score;
          bi = i;
        }
      }
      picked.push(pool.splice(bi, 1)[0]);
    }

    const bandOn = ALTITUDE.enabled;
    for (let gi = 0; gi < G; gi += 1) {
      const c = picked[gi % picked.length];
      targets.push([c.x, bandOn ? this._clampY(c.y) : c.y, c.z]);
    }
    let best = picked[0];
    if (bandOn) {
      best = {
        x: best.x,
        y: this._clampY(best.y),
        z: best.z,
        size: best.size,
        dist2: best.dist2,
      };
    }
    return { best, targets };
  }

  _runFrontier(flock) {
    const grid = this.grid;
    const cdim = grid.cdim;
    const ctotal = grid.ctotal;

    if (!this._cvisited || this._cvisited.length !== ctotal) {
      this._cvisited = new Int32Array(ctotal);
      this._cfront = new Uint8Array(ctotal);
      this._stamp = 1;
    }
    this._stamp += 1;
    if (this._stamp > 0x7ffffffe) {
      this._cvisited.fill(0);
      this._stamp = 1;
    }
    const visited = this._cvisited;
    const stamp = this._stamp;
    const isFrontier = this._cfront;
    isFrontier.fill(0);

    const cIdx = (x, y, z) => (z * cdim[1] + y) * cdim[0] + x;
    const decode = (ci) => [
      ci % cdim[0],
      ((ci / cdim[0]) | 0) % cdim[1],
      (ci / (cdim[0] * cdim[1])) | 0,
    ];

    const frontiers = [];
    let known = 0;
    for (let ci = 0; ci < ctotal; ci += 1) {
      const st = grid.coarseState(ci);
      if (st !== 0) known += 1;
      if (st !== -1) continue;
      const [ix, iy, iz] = decode(ci);
      for (let k = 0; k < 6; k += 1) {
        const jx = ix + NEI[k][0];
        const jy = iy + NEI[k][1];
        const jz = iz + NEI[k][2];
        if (jx < 0 || jy < 0 || jz < 0 || jx >= cdim[0] || jy >= cdim[1] || jz >= cdim[2]) continue;
        if (grid.coarseState(cIdx(jx, jy, jz)) === 0) {
          isFrontier[ci] = 1;
          frontiers.push(ci);
          break;
        }
      }
    }
    this.frontierCount = frontiers.length;
    this.exploredRatio = known / ctotal;

    this._centroid(flock, _c);
    const fx = _c[0];
    const fy = _c[1];
    const fz = _c[2];

    const clusters = [];
    for (let i = 0; i < frontiers.length; i += 1) {
      const seed = frontiers[i];
      if (visited[seed] === stamp) continue;
      const q = [seed];
      visited[seed] = stamp;
      let head = 0;
      let count = 0;
      let bestLocalD = Infinity;
      let bx = 0;
      let by = 0;
      let bz = 0;
      while (head < q.length) {
        const idx = q[head++];
        grid.coarseCenter(idx, _c);
        const dx = _c[0] - fx;
        const dy = _c[1] - fy;
        const dz = _c[2] - fz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestLocalD) {
          bestLocalD = d;
          bx = _c[0];
          by = _c[1];
          bz = _c[2];
        }
        count += 1;
        const [ix, iy, iz] = decode(idx);
        for (let k = 0; k < 6; k += 1) {
          const jx = ix + NEI[k][0];
          const jy = iy + NEI[k][1];
          const jz = iz + NEI[k][2];
          if (jx < 0 || jy < 0 || jz < 0 || jx >= cdim[0] || jy >= cdim[1] || jz >= cdim[2]) continue;
          const j = cIdx(jx, jy, jz);
          if (visited[j] === stamp) continue;
          if (!isFrontier[j]) continue;
          visited[j] = stamp;
          q.push(j);
        }
      }
      if (count < FRONTIER.minCluster) continue;
      clusters.push({ x: bx, y: by, z: bz, size: count, dist2: bestLocalD });
    }
    this.clusterCount = clusters.length;
    // recall no longer requires frontier == 0 (unreachable noise would
    // stall it forever). the real decision is made in update from "the
    // frontier count has stalled"; this only flags the "completely
    // exhausted" shortcut.
    this._frontierEmpty = clusters.length === 0;
    return clusters;
  }


  // holding array overhead: a roughly square grid, centred on the swarm
  // centroid in xz, at a height near the top of the box
  _buildFormation(flock) {
    const n = flock.count;
    const slots = new Array(n);
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    const rows = Math.max(1, Math.ceil(n / cols));
    const sp = RECALL.spacing || 2;
    this._centroid(flock, _c);
    const y = TANK.height / 2 - (RECALL.exitMargin || 2.5);
    const x0 = _c[0] - (cols - 1) * sp * 0.5;
    const z0 = _c[2] - (rows - 1) * sp * 0.5;
    for (let i = 0; i < n; i += 1) {
      const r = (i / cols) | 0;
      const c = i % cols;
      slots[i] = [x0 + c * sp, y, z0 + r * sp];
    }
    return slots;
  }

  // UI click on "confirm recall": hold the formation in place first, and
  // only then actually depart and hide
  confirmDepart() {
    if (this.phase !== 'recall') return false;
    if (!this.formationReady) return false;
    this.departed = true;
    this.phaseNote = 'departed';
    if (this.params) this.params.departed = true;
    return true;
  }
  update(time, flock) {
    this._expandAltitude(time);

    const periodDue = time - this.lastUpdate >= FRONTIER.period;

    // keep coverage updating (the HUD must not freeze)
    if (periodDue) {
      this.columnCoverage = this.grid.columnCoverage();
      this._updateFine();
    }

    // manually forcing frontier: skip ROAM/PLAN
    if (FRONTIER.enabled && (this.phase === 'roam' || this.phase === 'plan')) {
      // turning frontier on by hand can skip PLAN; the automatic pipeline
      // never sets enabled to true while in ROAM
      if (this.phase !== 'frontier') {
        this.phase = 'frontier';
        this.phaseEnteredAt = time;
        this.phaseNote = 'manual';
      }
    }

    // ── ROAM → PLAN (coarse plan view) ──
    if (this.phase === 'roam' && FRONTIER.autoStart && periodDue) {
      this._coarseHist = this._pushHist(
        this._coarseHist,
        this.columnCoverage,
        FRONTIER.stallWindow
      );
      const stalled = this._stalled(
        this._coarseHist,
        FRONTIER.stallWindow,
        FRONTIER.stallDelta,
        FRONTIER.stallMinCoverage,
        this.columnCoverage
      );
      if (stalled || this.columnCoverage >= FRONTIER.autoStartCoverage) {
        this.phase = 'plan';
        this.phaseEnteredAt = time;
        this._planEnteredAt = time;
        this._fineHist = null;
        this.autoStartReason = stalled ? 'coarse-stall' : 'coarse-threshold';
        this.phaseNote = this.autoStartReason;
      }
    }

    // ── PLAN → FRONTIER (fine plan view / horizontal fill) ──
    // frontier handles the vertical wall faces; the plan view handles
    // spreading out horizontally.
    // main exit: fine coverage "stops rising much" (stall); gaps exhausted,
    // nearly full, and timeout are secondary.
    if (this.phase === 'plan' && periodDue) {
      this._fineHist = this._pushHist(
        this._fineHist,
        this.fineCoverage,
        PLAN.stallWindow
      );
      const lived = time - this._planEnteredAt;
      const stalled = this._stalled(
        this._fineHist,
        PLAN.stallWindow,
        PLAN.stallDelta,
        PLAN.stallMinCoverage,
        this.fineCoverage
      );
      const timedOut = lived >= PLAN.maxDuration;
      // clusterCount is from the previous period and gets recomputed at
      // the end of this one. mark it pending and test it again in the plan
      // branch.
      this._planExitCheck = { stalled, timedOut, lived };
    }

    // off-period: just feed back the previous params
    if (!periodDue) {
      if (flock && flock.setTerminalParams) flock.setTerminalParams(this.params);
      return this.params;
    }
    this.lastUpdate = time;

    // ── produce targets per phase ──
    if (this.phase === 'roam') {
      this.frontierCount = 0;
      this.clusterCount = 0;
      this.target = null;
      this.targets = null;
      this.recalled = false;
      this.params = null;
      if (flock && flock.setTerminalParams) flock.setTerminalParams(null);
      return this.params;
    }

    if (this.phase === 'plan') {
      const plan = this.grid.fillPlanMap(this._planMap, PLAN.bin);
      this._planMap = plan.map;
      // sync fine coverage (from the same map as the gaps)
      {
        const n = plan.width * plan.height;
        let known = 0;
        for (let i = 0; i < n; i += 1) if (plan.map[i] !== 0) known += 1;
        this.fineCoverage = n > 0 ? known / n : 0;
      }
      const clusters = this._planClusters(plan, flock);
      this.clusterCount = clusters.length;
      this.frontierCount = 0;

      // exit (squeeze the horizontal plan view dry, then hand the vertical
      // faces over to frontier):
      //  1) fine coverage stalls (main path: it stops increasing much)
      //  2) gap clusters exhausted
      //  3) nearly fully covered
      //  4) timeout as a fallback
      const chk = this._planExitCheck || {};
      const noGaps = clusters.length === 0;
      const covered = this.fineCoverage >= PLAN.autoStartCoverage;
      const stalledOut = !!chk.stalled; // already includes stallMinCoverage
      if (stalledOut || noGaps || covered || chk.timedOut) {
        this.phase = 'frontier';
        this.phaseEnteredAt = time;
        this._frontHist = null; // restart the frontier stall window
        this._planHoldUntil = -Infinity;
        this._planHoldTargets = null;
        this._planHoldBest = null;
        this._clusterHist = null;
        FRONTIER.enabled = true;
        this.autoStartReason = stalledOut
          ? 'fine-stall'
          : noGaps
            ? 'plan-gaps-empty'
            : chk.timedOut
              ? 'plan-timeout'
              : 'fine-threshold';
        this.phaseNote = this.autoStartReason;
        this._planExitCheck = null;
        // falls through into the frontier branch below
      } else {
        // dwell: once at a gap, sweep up and down for a while before
        // switching components, so it does not just brush the outer edge
        const dwell = PLAN.dwellSeconds || 0;
        let best = this._planHoldBest;
        let targets = this._planHoldTargets;
        const holdOk =
          targets &&
          targets.length &&
          this._planHoldUntil != null &&
          time < this._planHoldUntil;
        if (!holdOk) {
          const picked = this._pickPlanTargets(clusters, flock);
          best = picked.best;
          targets = picked.targets;
          this._planHoldBest = best;
          this._planHoldTargets = targets;
          this._planHoldUntil = time + dwell;
        }
        // during the dwell, sweep the target height slowly up and down
        // (xz stays put)
        if (targets && targets.length && (PLAN.probeAmplitude || 0) > 0) {
          const amp = PLAN.probeAmplitude;
          const per = Math.max(0.5, PLAN.probePeriod || 3);
          const wob = Math.sin((time * Math.PI * 2) / per) * amp;
          targets = targets.map((t, gi) => {
            const base = (this._planHoldTargets && this._planHoldTargets[gi]) || t;
            let y = base[1] + wob * (gi % 2 === 0 ? 1 : -0.85);
            if (ALTITUDE.enabled) y = this._clampY(y);
            return [base[0], y, base[2]];
          });
          if (best) {
            best = {
              x: best.x,
              y: targets[0][1],
              z: best.z,
              size: best.size,
              dist2: best.dist2,
              score: best.score,
            };
          }
        }
        this.target = best;
        this.targets = targets;
        this.recalled = false;
        this.params = this._pack({
          mode: 'plan',
          target: best,
          targets: targets && targets.length ? targets : null,
          seekWeight: PLAN.seekWeight,
          verticalWeight: PLAN.verticalWeight,
          sep: PLAN.separationScale,
          coh: PLAN.cohesionScale,
          ali: PLAN.alignmentScale,
        });
        if (flock && flock.setTerminalParams) flock.setTerminalParams(this.params);
        return this.params;
      }
    }

    // frontier or recall
    const clusters = this._runFrontier(flock);

    // ── recall decision (a compromise) ─────────────────────────────────
    // 1) assignable clusters == 0 → classic exhaustion
    // 2) only ≤softMax clusters left and the frontier count flat over a
    //    short window → approximate exhaustion (without waiting for zero)
    // 3) the frontier phase times out → forced wrap-up
    if (this.phase !== 'recall') {
      const livedF = time - (this.phaseEnteredAt || time);
      const win = RECALL.frontierStallWindow || 12;
      this._frontHist = this._pushHist(
        this._frontHist,
        this.frontierCount,
        win
      );
      // also track the trend in the number of assignable clusters
      this._clusterHist = this._pushHist(
        this._clusterHist,
        this.clusterCount,
        win
      );
      const h = this._frontHist;
      const ch = this._clusterHist;
      const dMax = RECALL.frontierStallDelta || 3;
      const minT = RECALL.frontierMinTime || 14;
      const softMax = RECALL.frontierSoftMaxClusters ?? 2;
      const maxT = RECALL.frontierMaxTime || 75;
      const inFront = this.phase === 'frontier';
      const flat =
        inFront &&
        h && h.length >= win &&
        Math.abs(h[h.length - 1] - h[0]) <= dMax &&
        ch && ch.length >= win &&
        Math.abs(ch[ch.length - 1] - ch[0]) <= 1 &&
        livedF >= minT;
      const softEmpty =
        inFront && flat && this.clusterCount <= softMax;
      const timedOut = inFront && livedF >= maxT;
      const hardEmpty = !!this._frontierEmpty;
      this.recalled = hardEmpty || softEmpty || timedOut;
      if (hardEmpty) this.phaseNote = 'frontier-empty';
      else if (softEmpty) this.phaseNote = 'frontier-soft-empty';
      else if (timedOut) this.phaseNote = 'frontier-timeout';
    }

    if (this.recalled || this.phase === 'recall') {
      // recall has two steps: (1) form up and hold overhead, (2) only
      // hide and depart once the user clicks confirm
      if (this.phase !== 'recall') {
        this.phase = 'recall';
        this.phaseEnteredAt = time;
        this.formationReady = false;
        this.departed = false;
        if (flock) flock.departed = false;
        this._formation = this._buildFormation(flock);
        if (!this.phaseNote || this.phaseNote === 'manual') {
          this.phaseNote = this._frontierEmpty ? 'frontier-empty' : 'frontier-stall';
        }
      }
      if (!this._formation || this._formation.length !== flock.count) {
        this._formation = this._buildFormation(flock);
      }
      this.frontierCount = this.frontierCount; // keep last known for HUD if any
      // the formation phase stops refreshing the frontier count (it keeps
      // the meaning it had on entry)
      const lived = time - (this.phaseEnteredAt || time);
      if (!this.formationReady && lived >= (RECALL.formSeconds || 6)) {
        this.formationReady = true;
        this.phaseNote = 'formation-ready';
      }
      // never set departed automatically before confirm has been clicked
      if (!this.departed) {
        this.params = this._pack({
          mode: 'recall',
          target: null,
          targets: null,
          seekWeight: RECALL.seekWeight,
          verticalWeight: 0,
          sep: RECALL.separationScale,
          coh: RECALL.cohesionScale,
          ali: RECALL.alignmentScale,
        });
        this.params.slots = this._formation;
        this.params.formationReady = !!this.formationReady;
        this.params.departed = false;
        this.params.gatherProgress = Math.min(1, lived / Math.max(0.1, RECALL.formSeconds || 6));
      } else {
        this.params = this._pack({
          mode: 'recall',
          seekWeight: 0,
          sep: 1,
          coh: 1,
          ali: 1,
        });
        this.params.departed = true;
        this.params.formationReady = true;
        this.phaseNote = 'departed';
      }
      if (flock && flock.setTerminalParams) flock.setTerminalParams(this.params);
      if (flock) flock.departed = !!this.departed;
      return this.params;
    }

    this.phase = 'frontier';
    FRONTIER.enabled = true;
    const { best, targets } = this._pickDispersed(clusters, flock);
    this.target = best;
    this.targets = targets;
    this.params = this._pack({
      mode: 'frontier',
      target: best,
      targets: targets.length ? targets : null,
      seekWeight: FRONTIER.seekWeight,
      verticalWeight: 0,
      sep: FRONTIER.separationScale,
      coh: FRONTIER.cohesionScale,
      ali: FRONTIER.alignmentScale,
    });
    if (flock && flock.setTerminalParams) flock.setTerminalParams(this.params);
    return this.params;
  }
}

