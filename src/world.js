import * as THREE from 'three';

// Tank interior, meters — PLATFORM-SPECIFIC (decided 2026-07-15).
// Mobile keeps toy scale (the original toy is small for a reason);
// desktop gets aquarium scale — space to inhabit, and the direct
// experiment for the multi-gyre target. The convention (meters, origin
// at tank center, +Y up) is universal; only the numbers diverge.
//
// Scaling model A (ratified 2026-07-17): ONLY the tank scales. Fish
// size, perception radii, detectionLength, wall margin are creature
// properties and stay fixed — the dimensionless ratios (radius vs tank
// span, fish per volume) ARE the experiment. fishCount is the density
// knob.
export const TANK_PRESETS = {
  mobile: { width: 1.2, height: 0.8, depth: 0.5 },
  desktop: { width: 2.0, height: 1.2, depth: 0.8 },
};
const platform = navigator.maxTouchPoints === 0 ? 'desktop' : 'mobile';
export const TANK = { ...TANK_PRESETS[platform] };

// Dims are live-tunable: the panel mutates TANK.* directly (every
// consumer reads at use time), then calls notifyTankChange() so the
// shell rebuilds and the camera re-homes.
const tankListeners = [];
export function onTankChange(fn) {
  tankListeners.push(fn);
}
export function notifyTankChange() {
  for (const fn of tankListeners) fn();
}

export const GRAVITY = 9.81;

const DEFAULT_FIXED_DT = 1 / 60;
const BASE_MAX_CATCHUP_STEPS = 5; // after a tab-switch, don't replay the whole gap
const MAX_CATCHUP_STEPS_CAP = 48; // hard ceiling so 4× speed cannot melt a phone

export class World {
  constructor() {
    // The one gravity vector. Input writes it; everyone else reads it.
    this.gravity = new THREE.Vector3(0, -GRAVITY, 0);
    // Anything with step(dt), executed in order. Empty until M1.
    this.systems = [];
    // Simulation speed multiplies real elapsed time before the fixed-step
    // integrator. 1 = realtime, 2 = twice as many 1/60 s physics steps.
    this.timeScale = 1;
    this.fixedDt = DEFAULT_FIXED_DT;
    // Cumulative simulated seconds. Advances by fixedDt per physics step, so
    // it already carries timeScale — slow-mo and fast-forward change how fast
    // it moves relative to the wall clock, which is what anything measuring a
    // creature's life (rather than the viewer's patience) wants.
    this.simTime = 0;
    this._accumulator = 0;
    this._lastMs = null;
  }

  // Fixed-timestep physics: however fast the display renders, physics
  // advances in identical 1/60 s steps so the game feels the same on a
  // 60 Hz iPhone and a 120 Hz one. timeScale only changes how many of
  // those steps fire per real second.
  step(nowMs) {
    if (this._lastMs === null) this._lastMs = nowMs;
    const realElapsed = Math.max(0, (nowMs - this._lastMs) / 1000);
    this._lastMs = nowMs;

    const scale = Number.isFinite(this.timeScale)
      ? Math.min(8, Math.max(0, this.timeScale))
      : 1;
    this.timeScale = scale;
    if (scale <= 0) return;

    const fixedDt = Number.isFinite(this.fixedDt)
      ? Math.min(1 / 20, Math.max(1 / 240, this.fixedDt))
      : DEFAULT_FIXED_DT;
    this.fixedDt = fixedDt;
    const simElapsed = realElapsed * scale;
    const maxCatchupSteps = Math.min(
      MAX_CATCHUP_STEPS_CAP,
      Math.max(BASE_MAX_CATCHUP_STEPS, Math.ceil(BASE_MAX_CATCHUP_STEPS * scale))
    );
    this._accumulator = Math.min(
      this._accumulator + simElapsed,
      maxCatchupSteps * fixedDt
    );
    while (this._accumulator >= fixedDt) {
      for (const system of this.systems) system.step(fixedDt);
      this._accumulator -= fixedDt;
      this.simTime += fixedDt;
    }
  }

  resetTiming(nowMs = performance.now()) {
    this._accumulator = 0;
    this._lastMs = Number.isFinite(nowMs) ? nowMs : null;
  }
}
