import * as THREE from 'three';
import { SpatialPlanktonField } from './plankton-field.js';
import {
  RelationMatrix,
  SeededRng,
  SpatialHash3D,
  captureRadius,
  deriveExperiment,
  ecologyOutcome,
  effectiveMaxSpeed,
  energyCapacityFor,
  effectiveTurnSpeed,
  metabolicRate,
  planktonIntake,
  relationBetween,
  sustainedSpeedScale,
  tankVolume,
} from './experiment-model.js';
import { castRay, sceneClearance } from './distance-field.js';
import { CaptureVfx } from './capture-vfx.js';

const EPSILON = 1e-8;
const CHAMBER_EASE_RATE = 4;
const CHAMBER_STOP_EPSILON = 0.02;
const FORWARD = new THREE.Vector3(0, 0, 1);
const LOCOMOTION = Object.freeze({
  CRUISE: 0,
  BURST: 1,
  EVADE: 2,
});
const LOCOMOTION_LABEL = Object.freeze([
  'cruise',
  'burst',
  'evade',
]);

// ── Trait legibility: appearance only, never read by any rule ──
// The trait controller maps weights to multipliers with a flat middle, so a
// half-way drag moves a trait by only about 10%, which the eye cannot see.
// The constants below amplify the chosen traits visually; all rules keep
// using the real values. Each can be set to its "off" value.

// Body size: visual size = anchor * (size / anchor) ^ exponent * global.
// Fish visual length is 0.046 * visual size and plankton points are 0.03, so
// at exponent 1.8 a small fish (size 0.75) rendered exactly as large as
// plankton and vanished into the food. Exponent 0.9 looked the same as linear
// but added a concept. Linear is used because proportions stay exact (twice
// as large looks twice as large), and visibility comes from the global scale:
// a 20% change is obvious on a 0.18 m fish but invisible on a 0.03 m one.
// Capture radius, predation, metabolism and speed all read school.size; only
// the setMatrixAt scale changes here.
const VISUAL_SIZE_EXPONENT = 1; // 1 = linear; any other value enables the power mapping
const VISUAL_SIZE_ANCHOR = 1.5; // Only used when the exponent is not 1.
const VISUAL_SIZE_GLOBAL = 2.6; // The one knob to tune: global visual scale.

// Per-school multiplier applied after the global scale.
const VISUAL_SIZE_BOOST = Object.freeze({
  gold: 1,
  blue: 1,
  red: 1,
});

// Stamina brightness: brightness follows survival time, i.e. current energy
// divided by metabolic rate per second. Metabolism is inverse to stamina and
// survival time is inverse to metabolism, so survival time is exactly linear
// in the stamina multiplier (measured: stamina 0.5/0.75/1.0/1.25/1.5 gives
// 22.6/33.9/45.2/56.5/67.8 s). Mapping the metabolic multiplier directly
// would be wrong: maxing speed moves it only to x1.01, while maxing size
// moves it to x2.66, so brightness would duplicate size and hide speed.
// While energy is full, brightness shows how long a trait choice lasts;
// once energy drains, it shows how long the fish has left. 0 strength = off.

// Hunger response: low energy slows fish and loosens the formation.
// Kept at 0 (off). Measured at strengths 1.0, 0.5 and 0.25, it made outcomes
// easier rather than harder, because it also slows predators so they stop
// catching prey. Even 0.25 reshuffled which trait choices survive, so there
// is no safe low setting; it perturbs a chaotic system rather than shifting
// difficulty. Enabling it changes behavior, not appearance: consider applying
// it to prey only, and recheck survival outcomes afterwards.
const HUNGER_RESPONSE_STRENGTH = 0;
const HUNGER_TIRED_AT = 0.55; // Energy ratio below which fish start to weaken.
const HUNGER_EXHAUSTED_AT = 0.15; // Energy ratio at which weakness is maximal.
const HUNGER_MIN_SPEED = 0.38;
const HUNGER_MIN_ALIGNMENT = 0.35;
const HUNGER_MIN_COHESION = 0.3;

const STAMINA_TINT_STRENGTH = 0.45;
const STAMINA_TINT_REFERENCE_SECONDS = 45; // Survival time of balanced traits; neutral brightness.
const STAMINA_TINT_MIN = 0.35; // Darkest, near starvation.
const STAMINA_TINT_MAX = 1.45; // Brightest; caps overexposure.

function visualSizeOf(size, schoolId) {
  const boost = (VISUAL_SIZE_BOOST[schoolId] ?? 1) * VISUAL_SIZE_GLOBAL;
  if (VISUAL_SIZE_EXPONENT === 1) return size * boost;
  const ratio = Math.max(EPSILON, size / VISUAL_SIZE_ANCHOR);
  return VISUAL_SIZE_ANCHOR * ratio ** VISUAL_SIZE_EXPONENT * boost;
}

// Energy ratio -> multipliers for speed, alignment and cohesion; null when unaffected.
function hungerResponse(ratio) {
  if (HUNGER_RESPONSE_STRENGTH === 0) return null;
  const q = clamp(ratio, 0, 1);
  if (q >= HUNGER_TIRED_AT) return null;
  const span = HUNGER_TIRED_AT - HUNGER_EXHAUSTED_AT;
  const t = span > EPSILON ? clamp((q - HUNGER_EXHAUSTED_AT) / span, 0, 1) : 0;
  const awake = t * t * (3 - 2 * t); // smoothstep
  const fade = HUNGER_RESPONSE_STRENGTH * (1 - awake);
  return {
    speed: 1 - fade * (1 - HUNGER_MIN_SPEED),
    alignment: 1 - fade * (1 - HUNGER_MIN_ALIGNMENT),
    cohesion: 1 - fade * (1 - HUNGER_MIN_COHESION),
  };
}

// Survival time -> brightness multiplier.
function staminaTintFactor(survivalSeconds) {
  if (STAMINA_TINT_STRENGTH === 0) return 1;
  if (!Number.isFinite(survivalSeconds)) return STAMINA_TINT_MAX;
  const relative = survivalSeconds / STAMINA_TINT_REFERENCE_SECONDS;
  return clamp(
    1 + STAMINA_TINT_STRENGTH * (relative - 1),
    STAMINA_TINT_MIN,
    STAMINA_TINT_MAX
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function approach(current, target, rate, dt) {
  const alpha = 1 - Math.exp(-Math.max(0, rate) * dt);
  return current + (target - current) * alpha;
}

function normalize3(x, y, z) {
  const magnitude = Math.hypot(x, y, z);
  if (magnitude <= EPSILON) return [0, 0, 0, 0];
  return [x / magnitude, y / magnitude, z / magnitude, magnitude];
}

// Reynolds-style steering: each rule becomes a desired velocity at maxSpeed,
// minus the current velocity, clamped to maxForce, and only then weighted.
// Earlier the rules summed raw magnitudes (cohesion ~ distance, alignment ~
// velocity difference, separation ~ 1/d^2). Those units differ, so the
// effective weight ratios drifted with density and distance; that was the
// root cause of the motion not looking like classic boids.
function steerToward(dx, dy, dz, vx, vy, vz, maxSpeed, maxForce, out) {
  const length = Math.hypot(dx, dy, dz);
  if (length <= EPSILON) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return out;
  }
  const scale = maxSpeed / length;
  let sx = dx * scale - vx;
  let sy = dy * scale - vy;
  let sz = dz * scale - vz;
  const magnitude = Math.hypot(sx, sy, sz);
  if (magnitude > maxForce) {
    const clamp = maxForce / magnitude;
    sx *= clamp;
    sy *= clamp;
    sz *= clamp;
  }
  out[0] = sx;
  out[1] = sy;
  out[2] = sz;
  return out;
}

const STEER_SCRATCH = new Float64Array(3);

function add3(array, index, x, y, z) {
  const offset = index * 3;
  array[offset] += x;
  array[offset + 1] += y;
  array[offset + 2] += z;
}

function set3(array, index, x, y, z) {
  const offset = index * 3;
  array[offset] = x;
  array[offset + 1] = y;
  array[offset + 2] = z;
}

export class ExperimentSimulation {
  constructor({ scene, config, distanceField }) {
    this.scene = scene;
    this.config = config;
    this.distanceField = distanceField;
    this.relations = new RelationMatrix();
    this.hash = new SpatialHash3D(1);
    this.hiddenFish = -1;
    this.locomotionPreview = false;
    this.captureVfx = null;
    this.planktonMesh = null;
    this.metricsState = {
      frameMs: 0,
      fps: 0,
      pairCount: 0,
      captures: 0,
    };
    this.rebuild(config);
  }

  dispose() {
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
    if (this.planktonMesh) {
      this.planktonMesh.removeFromParent();
      this.planktonMesh.geometry.dispose();
      this.planktonMesh.material.dispose();
      this.planktonMesh = null;
    }
    this.captureVfx?.dispose();
    this.captureVfx = null;
  }

  rebuild(config = this.config) {
    this.config = config;
    this.dispose();
    this.derived = deriveExperiment(config);
    this.count = this.derived.totalCount;
    this.positions = new Float32Array(this.count * 3);
    this.velocities = new Float32Array(this.count * 3);
    this.forces = new Float32Array(this.count * 3);
    this.separation = new Float32Array(this.count * 3);
    this.cohesionSums = new Float32Array(this.count * 3);
    this.predationSums = new Float32Array(this.count * 3);
    this.alignmentSums = new Float32Array(this.count * 3);
    this.evadeForces = new Float32Array(this.count * 3);
    // Per step, for steering and the visualizer: the direction a fish turns
    // to when its look-ahead ray hits something (zero when clear), and the
    // hit distance (Infinity when clear).
    this.avoidanceDirections = new Float32Array(this.count * 3);
    this.avoidanceHits = new Float32Array(this.count).fill(Infinity);
    // Seconds left on each fish's recentering timer; 0 = idle.
    this.recenterTimers = new Float32Array(this.count);
    this.schoolIds = new Uint16Array(this.count);
    this.alive = new Uint8Array(this.count);
    this.panic = new Float32Array(this.count);
    // Panic propagation: direct threat level, neighbor panic, neighbor escape direction.
    this.threatLevel = new Float32Array(this.count);
    this.neighborPanic = new Float32Array(this.count);
    // Emergency alignment channel: panicked headings stay out of the normal alignment average.
    this.emergencyAlign = new Float32Array(this.count * 3);
    this.emergencyUrgency = new Float32Array(this.count);
    // Target lock. Pick the nearest prey; candidates within targetTieTolerance
    // count as tied, and ties go to the one most in line with the heading.
    // A lock is dropped only when the target leaves burstRadius, when no new
    // closest distance is reached within giveUpSeconds (the target is then
    // excluded until it leaves range once), or when a clearly nearer fish
    // appears outside the tie band. The tie band also stops flip-flopping
    // between two equally distant fish.
    this.lockedTargets = new Int32Array(this.count).fill(-1);
    this.excludedTargets = new Int32Array(this.count).fill(-1);
    this.chaseBestDistance2 = new Float32Array(this.count).fill(Infinity);
    this.chaseStall = new Float32Array(this.count);
    // Pulse-and-latch panic. Continuous tracking never produces a startle, and
    // social spread without a refractory period echoes forever.
    this.alarm = new Float32Array(this.count);       // Discrete pulse, decays exponentially.
    this.heardSignal = new Float32Array(this.count); // Social signal received this step.
    this.panicHold = new Float32Array(this.count);   // Hold timer at full panic.
    this.refractory = new Float32Array(this.count);  // Refractory timer.
    this.directLatch = new Uint8Array(this.count);   // Direct-threat latch (hysteresis).
    // Roll: the body banks into turns. Visual only.
    this.rollAngles = new Float32Array(this.count);
    this.prevHeadings = new Float32Array(this.count * 3);
    this.energy = new Float32Array(this.count);
    // One shared energy pool per school: part of each meal flows in and is split evenly each step.
    this.energyPools = new Float64Array(config.schools.length);
    // Scatter latch: set above panicScatterEnter, cleared only below
    // panicScatterExit. A single threshold jitters at the boundary.
    // Desperation states: armed is a latch that resets only after recovery.
    // armed=1 is normal; armed=0 before desperationUntil is a desperate sprint;
    // armed=0 after it is exhaustion.
    // Corpse: 1 = floating body (visible, grey, rising, edible); 0 = alive or eaten.
    this.scattering = new Uint8Array(this.count);
    this.desperation = new Uint8Array(this.count);
    this.desperationArmed = new Uint8Array(this.count);
    this.desperationUntil = new Float32Array(this.count);
    this.debt = new Float32Array(this.count);
    this.corpse = new Uint8Array(this.count);
    // Seconds since death; drives color fade, belly-up roll and rise.
    this.corpseAge = new Float32Array(this.count);
    // Last written brightness multiplier, to skip unchanged setColorAt calls.
    this.tintFactors = new Float32Array(this.count).fill(-1);
    this.corpseColor = new THREE.Color('#6b6f74');
    this.schoolColors = config.schools.map((sc) => new THREE.Color(sc.color));
    this.locomotionStates = new Uint8Array(this.count);
    this.wanderPhases = new Float32Array(this.count);
    this.wanderRates = new Float32Array(this.count);
    this.sameNeighbors = new Uint16Array(this.count);
    this.cohesionCounts = new Uint16Array(this.count);
    this.predationCounts = new Uint16Array(this.count);
    this.alignmentCounts = new Uint16Array(this.count);
    this.threatCounts = new Uint16Array(this.count);
    this.pursuitTargets = new Int32Array(this.count);
    this.lastPursuitTargets = new Int32Array(this.count);
    this.chaseStartTimes = new Float64Array(this.count);
    this.targetAlignment = new Float32Array(this.count);
    this.targetDistance2 = new Float32Array(this.count);
    this.schoolRanges = [];
    let cursor = 0;
    for (
      let schoolIndex = 0;
      schoolIndex < config.schools.length;
      schoolIndex += 1
    ) {
      const start = cursor;
      cursor += this.derived.schools[schoolIndex].count;
      this.schoolRanges.push({ start, end: cursor });
      this.schoolIds.fill(schoolIndex, start, cursor);
    }
    if (this.scene?.add) {
      this.captureVfx = new CaptureVfx(
        this.scene,
        this.config.captureVfx,
        this.config.starvationVfx
      );
    }
    this._buildMesh();
    this._buildPlanktonMesh();
    this.reset(config.runtime.seed);
  }

  _buildMesh() {
    if (!this.scene?.add) {
      this.mesh = null;
      return;
    }
    const radialSegments = Math.max(
      3,
      Math.round(this.config.visual.radialSegments)
    );
    const geometry = new THREE.CapsuleGeometry(
      this.config.visual.bodyRadius,
      this.config.visual.bodyLength,
      2,
      radialSegments
    );
    geometry.rotateX(Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: this.config.visual.opacity < 1,
      opacity: this.config.visual.opacity,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, this.count);
    this.mesh.name = 'experiment-fish';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let index = 0; index < this.count; index += 1) {
      const school = this.config.schools[this.schoolIds[index]];
      this.mesh.setColorAt(index, new THREE.Color(school.color));
    }
    this.mesh.instanceColor.needsUpdate = true;
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  _buildPlanktonMesh() {
    if (!this.scene?.add || this.config.plankton.visualCount <= 0) {
      this.planktonMesh = null;
      return;
    }
    const count = Math.max(
      0,
      Math.round(this.config.plankton.visualCount)
    );
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const rng = new SeededRng(
      (Number(this.config.runtime.seed) ^ 0x9e3779b9) >>> 0
    );
    const margin = this.config.tank.wallMargin;
    const half = [
      Math.max(0, this.config.tank.width / 2 - margin),
      Math.max(0, this.config.tank.height / 2 - margin),
      Math.max(0, this.config.tank.depth / 2 - margin),
    ];
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      positions[offset] = rng.range(-half[0], half[0]);
      positions[offset + 1] = rng.range(-half[1], half[1]);
      positions[offset + 2] = rng.range(-half[2], half[2]);
    }
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3)
    );
    const material = new THREE.PointsMaterial({
      color: this.config.plankton.color,
      size: this.config.plankton.pointSize,
      transparent: true,
      opacity: this.config.plankton.opacity,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.planktonMesh = new THREE.Points(geometry, material);
    this.planktonMesh.name = 'experiment-plankton';
    this.planktonMesh.frustumCulled = false;
    this.scene.add(this.planktonMesh);
  }

  reset(seed = undefined) {
    // A fresh random seed per run by default. The simulation is deterministic,
    // so a fixed seed gives identical spawn positions, velocities and wander
    // phases, and every run plays out exactly the same.
    if (seed === undefined) {
      seed = this.config.runtime.randomizeSeed
        ? (Math.random() * 0xffffffff) >>> 0
        : this.config.runtime.seed;
    }
    this.rng = new SeededRng(seed);
    this.seed = Number(seed);
    this.config.runtime.seed = this.seed;
    this.elapsed = 0;
    this.relations.reset();
    this.relationMatrix = this.relations.update(
      this.config.schools,
      this.config.relations
    );
    this._isolateChambers();
    this.metricsState.pairCount = 0;
    this.metricsState.captures = 0;
    this.chaseTelemetry = new Map();
    this.deathCounts = this.config.schools.map(() => ({
      captured: 0,
      starved: 0,
    }));
    // Spatial food field: particles have positions, deplete locally and regrow in place.
    this.food = new SpatialPlanktonField(
      this.config,
      this.config.runtime.seed
    );
    this.planktonConsumed = 0;
    this.ecologyStatus = { state: 'running', winnerIndex: null };
    this.captureVfx?.reset();
    this.alive.fill(1);
    this.panic.fill(0);
    this.lockedTargets.fill(-1);
    this.excludedTargets.fill(-1);
    this.chaseBestDistance2.fill(Infinity);
    this.chaseStall.fill(0);
    this.alarm.fill(0);
    this.heardSignal.fill(0);
    this.panicHold.fill(0);
    this.refractory.fill(0);
    this.directLatch.fill(0);
    this.rollAngles.fill(0);
    this.prevHeadings.fill(0);
    // Initial energy needs per-fish jitter. Earlier every fish in a school
    // started with the same energy, and metabolism is deterministic
    // (basalRate / size^0.75), so the first wave starved in the same second.
    {
      const jitter = Math.max(0, this.config.ecology.initialEnergyJitter ?? 0);
      const ratio = this.config.ecology.initialEnergyRatio;
      for (let index = 0; index < this.count; index += 1) {
        // Capacity scales with body size, so use this fish's own school.
        const capacity = energyCapacityFor(
          this.config,
          this.config.schools[this.schoolIds[index]]
        );
        const factor = jitter > 0 ? 1 + this.rng.range(-jitter, jitter) : 1;
        this.energy[index] = Math.min(
          capacity,
          Math.max(0, capacity * ratio * factor)
        );
      }
    }
    this.energyPools.fill(0);
    this.scattering.fill(0);
    this.desperation.fill(0);
    this.desperationArmed.fill(1);
    this.desperationUntil.fill(0);
    this.debt.fill(0);
    this.corpse.fill(0);
    this.corpseAge.fill(0);
    this.locomotionStates.fill(LOCOMOTION.CRUISE);
    this.pursuitTargets.fill(-1);
    this.targetAlignment.fill(-Infinity);
    this.targetDistance2.fill(Infinity);
    this.lastPursuitTargets.fill(-1);
    this.chaseStartTimes.fill(-1);
    this.recenterTimers.fill(0);
    this.hiddenFish = -1;

    for (
      let schoolIndex = 0;
      schoolIndex < this.config.schools.length;
      schoolIndex += 1
    ) {
      const school = this.config.schools[schoolIndex];
      const range = this.schoolRanges[schoolIndex];
      const rawMode = this.config.runtime.spawnMode;
      const spawnMode =
        rawMode === 'cluster' || rawMode === 'pods' ? rawMode : 'random';
      const center = [
        school.spawnRegion.centerX * this.config.tank.width,
        school.spawnRegion.centerY * this.config.tank.height,
        school.spawnRegion.centerZ * this.config.tank.depth,
      ];
      const heading = normalize3(
        school.initialHeading.x,
        school.initialHeading.y,
        school.initialHeading.z
      );
      const wall = this.config.tank.wallMargin;
      const half = [
        this.config.tank.width / 2 - wall,
        this.config.tank.height / 2 - wall,
        this.config.tank.depth / 2 - wall,
      ];

      // Pod spawning (fission-fusion): a school starts as several separate
      // pods. Merging and splitting need no extra logic: with spacing inside
      // a pod below cohesionRadius and between pods above it, boids keep
      // pods apart, merge them on contact and regroup after scattering.
      let podCenters = null;
      let podRadius = 0;
      if (spawnMode === 'pods') {
        const desired = Math.max(1, Math.round(school.podCount ?? 1));
        const count = Math.max(1, range.end - range.start);
        const pods = Math.min(desired, count);
        // Pod radius must follow the fish count per pod, not cohesionRadius:
        //   mean spacing = podRadius * (4*pi/(3m))^(1/3) ~ k * separationRadius
        //   => podRadius = k * sepR * (3m/(4*pi))^(1/3)
        // Too small and the pod explodes on spawn; too large and neighboring
        // pods overlap cohesionRadius and merge immediately.
        const perPod = count / pods;
        podRadius =
          (this.config.perception.podSpacingFactor ?? 1.5) *
          this.derived.schools[schoolIndex].separationRadius *
          Math.cbrt((3 * perPod) / (4 * Math.PI));
        podCenters = [];
        for (let p = 0; p < pods; p += 1) {
          let best = null;
          let bestScore = -Infinity;
          // Best of several candidates: farthest from existing pods.
          for (let attempt = 0; attempt < 12; attempt += 1) {
            const candidate = [
              this.rng.range(-half[0] + podRadius, half[0] - podRadius),
              this.rng.range(-half[1] + podRadius, half[1] - podRadius),
              this.rng.range(-half[2] + podRadius, half[2] - podRadius),
            ];
            let nearest = Infinity;
            for (const existing of podCenters) {
              const dx = candidate[0] - existing[0];
              const dy = candidate[1] - existing[1];
              const dz = candidate[2] - existing[2];
              nearest = Math.min(nearest, dx * dx + dy * dy + dz * dz);
            }
            if (nearest > bestScore) {
              bestScore = nearest;
              best = candidate;
            }
          }
          podCenters.push(best);
        }
      }

      for (let index = range.start; index < range.end; index += 1) {
        const podCenter = podCenters
          ? podCenters[(index - range.start) % podCenters.length]
          : null;
        let spawn =
          spawnMode === 'cluster'
            ? center.slice()
            : podCenter
            ? podCenter.slice()
            : [
                this.rng.range(-half[0], half[0]),
                this.rng.range(-half[1], half[1]),
                this.rng.range(-half[2], half[2]),
              ];
        for (
          let attempt = 0;
          attempt < this.config.runtime.initialSpawnAttempts;
          attempt += 1
        ) {
          let candidate;
          if (spawnMode === 'cluster' || podCenter) {
            const point = this.rng.inUnitSphere();
            const origin = podCenter ?? center;
            const radius = podCenter ? podRadius : school.spawnRegion.radius;
            candidate = [
              clamp(origin[0] + point[0] * radius, -half[0], half[0]),
              clamp(origin[1] + point[1] * radius, -half[1], half[1]),
              clamp(origin[2] + point[2] * radius, -half[2], half[2]),
            ];
          } else {
            candidate = [
              this.rng.range(-half[0], half[0]),
              this.rng.range(-half[1], half[1]),
              this.rng.range(-half[2], half[2]),
            ];
          }
          spawn = candidate;
          if (
            sceneClearance(candidate, this.config) >
            this.derived.schools[schoolIndex].visualLength / 2
          ) {
            break;
          }
        }
        set3(
          this.positions,
          index,
          spawn[0],
          spawn[1],
          spawn[2]
        );
        let direction;
        if (spawnMode === 'cluster') {
          const jitter = this.rng.unitVector();
          // Too little spread sends the school off in formation into a wall.
          const spread = this.config.perception.spawnHeadingJitter ?? 0.6;
          direction = normalize3(
            heading[0] + jitter[0] * spread,
            heading[1] + jitter[1] * spread,
            heading[2] + jitter[2] * spread
          );
        } else {
          direction = this.rng.unitVector();
        }
        set3(
          this.velocities,
          index,
          direction[0] * school.cruiseSpeed,
          direction[1] * school.cruiseSpeed,
          direction[2] * school.cruiseSpeed
        );
        this.wanderPhases[index] = this.rng.range(0, Math.PI * 2);
        // Earlier the rate came from index % 13, only 13 distinct values, and
        // the school showed visibly synchronized wander. Now it is continuous.
        this.wanderRates[index] = this.rng.range(0.55, 0.95);
      }
    }
    this.hash.cellSize = Math.max(EPSILON, this.derived.cellSize);
    this._syncVfxBounds();
    this._syncPlanktonVisual();
    this.updateMesh();
    return this;
  }

  setConfig(config, mode = 'live') {
    this.config = config;
    if (this.captureVfx) {
      this.captureVfx.params = config.captureVfx;
      this.captureVfx.starvationParams = config.starvationVfx;
    }
    this.derived = deriveExperiment(config);
    this.hash.cellSize = Math.max(EPSILON, this.derived.cellSize);
    this.relationMatrix = this.relations.update(
      config.schools,
      config.relations
    );
    this._isolateChambers();
    if (mode !== 'live') {
      this.reset(config.runtime.seed);
    } else {
    }
    if (this.mesh) {
      this.mesh.material.opacity = config.visual.opacity;
      this.mesh.material.transparent = config.visual.opacity < 1;
      // Base colors reset here only; updateMesh applies stamina brightness every frame.
      for (let index = 0; index < this.count; index += 1) {
        this.mesh.setColorAt(
          index,
          new THREE.Color(config.schools[this.schoolIds[index]].color)
        );
      }
      this.mesh.instanceColor.needsUpdate = true;
    }
    this._syncPlanktonVisual();
  }

  setLocomotionPreview(enabled) {
    const next = Boolean(enabled);
    if (next === this.locomotionPreview) return;
    this.locomotionPreview = next;
    if (!next) return;
    this._clearGameplayInteractionState();
  }


  _clearGameplayInteractionState() {
    // The locomotion preview is clean and non-scoring. Clearing every interaction
    // latch here guarantees a previous scene can never leak panic or pursuit
    // state into the selection screen.
    this.panic.fill(0);
    this.threatLevel.fill(0);
    this.neighborPanic.fill(0);
    this.emergencyAlign.fill(0);
    this.emergencyUrgency.fill(0);
    this.evadeForces.fill(0);
    this.lockedTargets.fill(-1);
    this.excludedTargets.fill(-1);
    this.chaseBestDistance2.fill(Infinity);
    this.chaseStall.fill(0);
    this.alarm.fill(0);
    this.heardSignal.fill(0);
    this.panicHold.fill(0);
    this.refractory.fill(0);
    this.directLatch.fill(0);
    this.pursuitTargets.fill(-1);
    this.lastPursuitTargets.fill(-1);
    this.chaseStartTimes.fill(-1);
    this.locomotionStates.fill(LOCOMOTION.CRUISE);
  }

  beginGameplayFromPreview() {
    const visibleMotion = {
      positions: this.positions.slice(),
      velocities: this.velocities.slice(),
      rollAngles: this.rollAngles.slice(),
      prevHeadings: this.prevHeadings.slice(),
    };
    this.locomotionPreview = false;
    // Reset from the submitted config so relation hysteresis,
    // energy and the future ecology RNG exactly match direct balance trials.
    // Restore only visible kinematics afterward; no frame is rendered between
    // reset and restore, so Start remains spatially continuous.
    this.reset(this.config.runtime.seed);
    this.positions.set(visibleMotion.positions);
    this.velocities.set(visibleMotion.velocities);
    this.rollAngles.set(visibleMotion.rollAngles);
    this.prevHeadings.set(visibleMotion.prevHeadings);
    this.updateMesh();
  }

  _syncVfxBounds() {
    this.captureVfx?.setBounds?.([
      this.config.tank.width / 2,
      this.config.tank.height / 2,
      this.config.tank.depth / 2,
    ]);
  }

  _syncPlanktonVisual() {
    if (!this.planktonMesh) return;
    const visible =
      this.config.ecology?.enabled &&
      this.config.plankton.enabled;
    this.planktonMesh.visible = visible;
    // The points are the model: live particles are compacted into the buffer
    // at their real positions, so what is drawn is exactly the food that
    // remains. Earlier this showed the first N points of a fixed random cloud
    // in proportion to total stock, so fish eating at the top of the tank made
    // points vanish at the bottom. That was a progress bar drawn as dots,
    // depicting spatial food the model did not have.
    let visibleCount = 0;
    if (visible) {
      const array = this.planktonMesh.geometry.attributes.position.array;
      const field = this.food;
      for (let i = 0; i < field.count; i += 1) {
        if (field.uses[i] === 0) continue;
        const from = i * 3;
        const to = visibleCount * 3;
        array[to] = field.positions[from];
        array[to + 1] = field.positions[from + 1];
        array[to + 2] = field.positions[from + 2];
        visibleCount += 1;
      }
      this.planktonMesh.geometry.attributes.position.needsUpdate = true;
    }
    this.planktonMesh.geometry.setDrawRange(0, visibleCount);
    this.planktonMesh.material.size = this.config.plankton.pointSize;
    this.planktonMesh.material.opacity = this.config.plankton.opacity;
    this.planktonMesh.material.color.set(this.config.plankton.color);
  }

  _clearAccumulators() {
    this.forces.fill(0);
    this.separation.fill(0);
    this.cohesionSums.fill(0);
    this.predationSums.fill(0);
    this.alignmentSums.fill(0);
    this.evadeForces.fill(0);
    this.sameNeighbors.fill(0);
    this.cohesionCounts.fill(0);
    this.predationCounts.fill(0);
    this.alignmentCounts.fill(0);
    this.threatCounts.fill(0);
    this.threatLevel.fill(0);
    this.neighborPanic.fill(0);
    this.heardSignal.fill(0);
    this.emergencyAlign.fill(0);
    this.emergencyUrgency.fill(0);
    this.pursuitTargets.fill(-1);
    this.targetAlignment.fill(-Infinity);
    this.targetDistance2.fill(Infinity);
    this.metricsState.pairCount = 0;
  }

  _telemetryFor(actorSchool, targetSchool) {
    const key = `${actorSchool}>${targetSchool}`;
    let record = this.chaseTelemetry.get(key);
    if (!record) {
      record = {
        starts: 0,
        pursuitFrames: 0,
        captures: 0,
        abandoned: 0,
        active: 0,
        completedDuration: 0,
        capturedDuration: 0,
        burstSeconds: 0,
      };
      this.chaseTelemetry.set(key, record);
    }
    return record;
  }

  _finishChase(predator, prey, captured) {
    if (prey < 0 || this.chaseStartTimes[predator] < 0) return;
    const actorSchool = this.schoolIds[predator];
    const targetSchool = this.schoolIds[prey];
    const record = this._telemetryFor(actorSchool, targetSchool);
    const duration = Math.max(
      0,
      this.elapsed - this.chaseStartTimes[predator]
    );
    record.completedDuration += duration;
    if (captured) {
      record.captures += 1;
      record.capturedDuration += duration;
    } else {
      record.abandoned += 1;
    }
    this.lastPursuitTargets[predator] = -1;
    this.chaseStartTimes[predator] = -1;
  }

  _updateChaseTelemetry(dt) {
    for (const record of this.chaseTelemetry.values()) record.active = 0;
    for (let predator = 0; predator < this.count; predator += 1) {
      if (!this.alive[predator]) {
        this._finishChase(
          predator,
          this.lastPursuitTargets[predator],
          false
        );
        continue;
      }
      const next = this.pursuitTargets[predator];
      const previous = this.lastPursuitTargets[predator];
      if (next !== previous) {
        this._finishChase(predator, previous, false);
        if (next >= 0 && this.alive[next]) {
          const actorSchool = this.schoolIds[predator];
          const targetSchool = this.schoolIds[next];
          const record = this._telemetryFor(actorSchool, targetSchool);
          record.starts += 1;
          this.lastPursuitTargets[predator] = next;
          this.chaseStartTimes[predator] = this.elapsed;
        }
      }
      const activeTarget = this.lastPursuitTargets[predator];
      if (activeTarget < 0 || !this.alive[activeTarget]) continue;
      const record = this._telemetryFor(
        this.schoolIds[predator],
        this.schoolIds[activeTarget]
      );
      record.active += 1;
      record.pursuitFrames += 1;
      if (this.locomotionStates[predator] === LOCOMOTION.BURST) {
        record.burstSeconds += dt;
      }
    }
  }

  _sameSchoolPair(
    i,
    j,
    dx,
    dy,
    dz,
    distance2,
    interactionsEnabled = true
  ) {
    const schoolIndex = this.schoolIds[i];
    const derived = this.derived.schools[schoolIndex];
    const perception = this.config.perception;
    const relations = this.config.relations;

    // Field of view gates alignment and cohesion only; separation stays
    // omnidirectional. A forward cone breaks pair symmetry, so heading
    // information has to propagate fish by fish instead of syncing instantly.
    // This is the main thing that makes it read as a school, not a particle blob.
    let seeIJ = true;
    let seeJI = true;
    if (perception.fovDegrees < 360) {
      const cosHalf = Math.cos((perception.fovDegrees * Math.PI) / 360);
      const inverse = 1 / Math.sqrt(Math.max(distance2, EPSILON));
      const io = i * 3;
      const jo = j * 3;
      const hi = normalize3(
        this.velocities[io],
        this.velocities[io + 1],
        this.velocities[io + 2]
      );
      const hj = normalize3(
        this.velocities[jo],
        this.velocities[jo + 1],
        this.velocities[jo + 2]
      );
      seeIJ = (dx * hi[0] + dy * hi[1] + dz * hi[2]) * inverse >= cosHalf;
      seeJI = (-dx * hj[0] - dy * hj[1] - dz * hj[2]) * inverse >= cosHalf;
    }

    // Emergency alignment: panicked headings travel on a separate channel.
    const signalRadius = derived.alignmentRadius * relations.signalRadiusFactor;
    const signalRadius2 = signalRadius * signalRadius;
    const emergencyOn = relations.emergencyAlignment !== false;
    const emitEmergency = (receiver, sender, canSee) => {
      if (!emergencyOn || !canSee || distance2 >= signalRadius2) return false;
      const urgency = this.panic[sender];
      if (urgency < relations.signalThreshold) return false;
      const distance = Math.sqrt(Math.max(distance2, EPSILON));
      const proximity = 1 - distance / signalRadius;
      const boost = relations.alignmentSourceBoost;
      const weight = proximity * urgency * (1 + boost * urgency * urgency);
      if (weight <= 1e-6) return false;
      const so = sender * 3;
      const heading = normalize3(
        this.velocities[so],
        this.velocities[so + 1],
        this.velocities[so + 2]
      );
      add3(
        this.emergencyAlign,
        receiver,
        heading[0] * weight,
        heading[1] * weight,
        heading[2] * weight
      );
      const urgencySignal = proximity * urgency;
      if (urgencySignal > this.emergencyUrgency[receiver]) {
        this.emergencyUrgency[receiver] = urgencySignal;
      }
      return true;
    };
    const emergencyIJ = interactionsEnabled
      ? emitEmergency(i, j, seeIJ)
      : false;
    const emergencyJI = interactionsEnabled
      ? emitEmergency(j, i, seeJI)
      : false;

    if (distance2 <= derived.cohesionRadius ** 2) {
      this.sameNeighbors[i] += 1;
      this.sameNeighbors[j] += 1;
      // Startle wave: the alarm pulse and panic level spread along neighbor
      // chains (reading last step's values). It also respects the field of
      // view, so the wave is directional instead of spreading everywhere at
      // once. The escape direction does not spread: fish that never saw the
      // predator turn with the school through alignment.
      if (interactionsEnabled && seeIJ) {
        // The social signal carries the alarm pulse, not the panic value: the
        // pulse decays to zero, while a continuous value would echo forever.
        const signal =
          this.alarm[j] * (1 - Math.sqrt(distance2) / derived.cohesionRadius);
        if (signal > this.heardSignal[i]) this.heardSignal[i] = signal;
        if (this.panic[j] > this.neighborPanic[i]) {
          this.neighborPanic[i] = this.panic[j];
        }
      }
      if (interactionsEnabled && seeJI) {
        const signalBack =
          this.alarm[i] * (1 - Math.sqrt(distance2) / derived.cohesionRadius);
        if (signalBack > this.heardSignal[j]) this.heardSignal[j] = signalBack;
        if (this.panic[i] > this.neighborPanic[j]) {
          this.neighborPanic[j] = this.panic[i];
        }
      }
      // Cohesion weight: 'inverse' weights by 1/(d^2 + soft^2), a cheap
      // approximation of topological interaction (Ballerini et al.: starlings
      // track about 7 nearest neighbors regardless of distance). Each fish is
      // dominated by its own pod, so a distant pod cannot pull it over and
      // pods persist instead of merging on first contact.
      let cohW = 1;
      if (perception.cohesionFalloff === 'inverse') {
        const soft = derived.cohesionRadius * 0.15;
        cohW = 1 / (distance2 + soft * soft);
      }
      if (seeIJ) {
        this.cohesionCounts[i] += cohW;
        add3(
          this.cohesionSums,
          i,
          this.positions[j * 3] * cohW,
          this.positions[j * 3 + 1] * cohW,
          this.positions[j * 3 + 2] * cohW
        );
      }
      if (seeJI) {
        this.cohesionCounts[j] += cohW;
        add3(
          this.cohesionSums,
          j,
          this.positions[i * 3] * cohW,
          this.positions[i * 3 + 1] * cohW,
          this.positions[i * 3 + 2] * cohW
        );
      }
    }
    if (distance2 <= derived.alignmentRadius ** 2) {
      if (seeIJ && !emergencyIJ) {
        this.alignmentCounts[i] += 1;
        add3(
          this.alignmentSums,
          i,
          this.velocities[j * 3],
          this.velocities[j * 3 + 1],
          this.velocities[j * 3 + 2]
        );
      }
      if (seeJI && !emergencyJI) {
        this.alignmentCounts[j] += 1;
        add3(
          this.alignmentSums,
          j,
          this.velocities[i * 3],
          this.velocities[i * 3 + 1],
          this.velocities[i * 3 + 2]
        );
      }
    }
    if (distance2 <= derived.separationRadius ** 2) {
      // Identical positions produce 0 * Infinity = NaN; skip or floor distance.
      if (distance2 <= EPSILON) {
        // Deterministic tiny push so overlapping agents do not poison forces.
        const push = 1 / EPSILON;
        add3(this.separation, i, -push, 0, 0);
        add3(this.separation, j, push, 0, 0);
      } else {
        const distance = Math.sqrt(distance2);
        const radius = derived.separationRadius;
        // Default is inverse: close-range repulsion is much stronger than
        // linear, so schools pack tightly without interpenetrating.
        let scale;
        if (perception.separationFalloff === 'linear') {
          scale = (radius - distance) / (radius * distance);
        } else if (perception.separationFalloff === 'invlog') {
          scale = Math.log(radius / distance) / distance;
        } else {
          scale = 1 / distance2;
        }
        add3(this.separation, i, -dx * scale, -dy * scale, -dz * scale);
        add3(this.separation, j, dx * scale, dy * scale, dz * scale);
      }
    }
  }

  _crossSchoolPair(
    i,
    j,
    dx,
    dy,
    dz,
    distance2,
    interactionsEnabled = true
  ) {
    const schoolI = this.schoolIds[i];
    const schoolJ = this.schoolIds[j];
    const configSchoolI = this.config.schools[schoolI];
    const configSchoolJ = this.config.schools[schoolJ];
    const distance = Math.sqrt(Math.max(EPSILON, distance2));
    const crossRadius =
      this.config.perception.crossSeparationScale *
      Math.max(configSchoolI.size, configSchoolJ.size);
    if (distance < crossRadius) {
      const strength = 1 - distance / crossRadius;
      const scale = strength / distance;
      add3(this.separation, i, -dx * scale, -dy * scale, -dz * scale);
      add3(this.separation, j, dx * scale, dy * scale, dz * scale);
    }

    if (interactionsEnabled) {
      this._directedRelation(i, j, dx, dy, dz, distance, distance2);
      this._directedRelation(j, i, -dx, -dy, -dz, distance, distance2);
    }
  }

  _directedRelation(
    actor,
    target,
    dx,
    dy,
    dz,
    distance,
    distance2
  ) {
    const actorSchool = this.schoolIds[actor];
    const targetSchool = this.schoolIds[target];
    const relation = this.relationMatrix[actorSchool][targetSchool];
    if (relation !== 'pursuit') return;
    const actorDetection =
      this.derived.schools[actorSchool].detectionLength;
    // Long range: cruise toward the prey school's centroid. The sense radius
    // is several times detectionLength, so predators close in smoothly from
    // afar instead of darting only once they are near.
    const senseRadius =
      actorDetection * this.config.relations.schoolSenseFactor;
    if (distance2 <= senseRadius * senseRadius) {
      add3(
        this.predationSums,
        actor,
        this.positions[target * 3],
        this.positions[target * 3 + 1],
        this.positions[target * 3 + 2]
      );
      this.predationCounts[actor] += 1;
    }

    const burstRadius =
      actorDetection * this.config.relations.burstRadiusFactor;
    if (distance2 <= burstRadius * burstRadius) {
      const actorOffset = actor * 3;
      const speed = normalize3(
        this.velocities[actorOffset],
        this.velocities[actorOffset + 1],
        this.velocities[actorOffset + 2]
      );
      const inverseDistance = 1 / Math.max(distance, EPSILON);
      const alignment =
        speed[0] * dx * inverseDistance +
        speed[1] * dy * inverseDistance +
        speed[2] * dz * inverseDistance;
      // A target given up on is not eligible again until it leaves range.
      if (
        target !== this.excludedTargets[actor] &&
        this._preferCandidate(
          distance2,
          alignment,
          this.targetDistance2[actor],
          this.targetAlignment[actor]
        )
      ) {
        this.pursuitTargets[actor] = target;
        this.targetAlignment[actor] = alignment;
        this.targetDistance2[actor] = distance2;
      }
    }

    // directThreat belongs to the prey and is proximity-driven. It does
    // not care whether this predator won target selection or is cooling down.
    const preyDetection =
      this.derived.schools[targetSchool].panicRadius;
    if (distance2 <= preyDetection * preyDetection) {
      this.threatCounts[target] += 1;
      // Distance falloff: without it, every fish in a small tank would sit
      // at full panic permanently.
      const proximity = 1 - distance / Math.max(preyDetection, EPSILON);
      if (proximity > this.threatLevel[target]) {
        this.threatLevel[target] = proximity;
      }
      // Flee from the predator's predicted position, not its current one.
      const lead = this.config.relations.escapePredictionTime;
      const ao = actor * 3;
      // dx points from predator to prey, so the vector from the predator's
      // position after vel * lead to the prey is dx - vel * lead.
      const px = dx - this.velocities[ao] * lead;
      const py = dy - this.velocities[ao + 1] * lead;
      const pz = dz - this.velocities[ao + 2] * lead;
      const inverse = 1 / Math.max(Math.hypot(px, py, pz), EPSILON);
      const awayX = px * inverse;
      const awayY = py * inverse;
      const awayZ = pz * inverse;
      const velocityOffset = target * 3;
      const lateral = normalize3(
        this.velocities[velocityOffset + 1] * awayZ -
          this.velocities[velocityOffset + 2] * awayY,
        this.velocities[velocityOffset + 2] * awayX -
          this.velocities[velocityOffset] * awayZ,
        this.velocities[velocityOffset] * awayY -
          this.velocities[velocityOffset + 1] * awayX
      );
      add3(
        this.evadeForces,
        target,
        awayX +
          lateral[0] * this.config.relations.evadeLateralWeight,
        awayY +
          lateral[1] * this.config.relations.evadeLateralWeight,
        awayZ +
          lateral[2] * this.config.relations.evadeLateralWeight
      );
    }
  }

  _pairPasses(interactionsEnabled = true) {
    this.hash.forEachPair((i, j) => {
      this.metricsState.pairCount += 1;
      const io = i * 3;
      const jo = j * 3;
      const dx = this.positions[jo] - this.positions[io];
      const dy = this.positions[jo + 1] - this.positions[io + 1];
      const dz = this.positions[jo + 2] - this.positions[io + 2];
      const distance2 = dx * dx + dy * dy + dz * dz;
      if (this.schoolIds[i] === this.schoolIds[j]) {
        this._sameSchoolPair(
          i,
          j,
          dx,
          dy,
          dz,
          distance2,
          interactionsEnabled
        );
      }
    });
    this.hash.forEachPair((i, j) => {
      if (this.schoolIds[i] === this.schoolIds[j]) return;
      const io = i * 3;
      const jo = j * 3;
      const dx = this.positions[jo] - this.positions[io];
      const dy = this.positions[jo + 1] - this.positions[io + 1];
      const dz = this.positions[jo + 2] - this.positions[io + 2];
      const distance2 = dx * dx + dy * dy + dz * dz;
      this._crossSchoolPair(
        i,
        j,
        dx,
        dy,
        dz,
        distance2,
        interactionsEnabled
      );
    });
  }

  /**
   * Wall and obstacle avoidance, as in the original boids.
   *
   * Cast a ray along the heading. If a surface is closer than the look-ahead
   * distance, turn the heading left and right (yaw) in angle steps until a
   * ray is clear; failing that, try pitching up or down; failing that, head
   * for the tank centre. Fish prefer turning to climbing.
   *
   * Leaves the chosen direction in avoidanceDirections and the hit distance
   * in avoidanceHits. Returns urgency: 0 when the way ahead is clear, rising
   * to 1 as the surface gets closer.
   */
  _lookAhead(index, point, vx, vy, vz) {
    const offset = index * 3;
    const locomotion = this.config.locomotion;
    const length = locomotion.avoidanceLookAhead;
    const margin = this.config.tank.wallMargin;
    this.avoidanceDirections[offset] = 0;
    this.avoidanceDirections[offset + 1] = 0;
    this.avoidanceDirections[offset + 2] = 0;
    this.avoidanceHits[index] = Infinity;
    const speed = Math.hypot(vx, vy, vz);
    if (length <= 0 || speed <= EPSILON) return 0;

    const field = this.distanceField;
    const clearanceAt = field?.clearance
      ? (candidate) => field.clearance(candidate)
      : (candidate) => sceneClearance(candidate, this.config);
    const heading = [vx / speed, vy / speed, vz / speed];
    const hit = castRay(clearanceAt, point, heading, length, margin);
    if (hit === Infinity) return 0;
    this.avoidanceHits[index] = hit;
    const clear = (direction) =>
      castRay(clearanceAt, point, direction, length, margin) === Infinity;

    const candidate = [0, 0, 0];
    let found = false;
    // Yaw sweep around the vertical axis, alternating left and right.
    const stepRadians = (locomotion.avoidanceAngleStep * Math.PI) / 180;
    const tries = Math.ceil(Math.PI / stepRadians);
    for (let k = 1; k <= tries && !found; k += 1) {
      for (const side of [1, -1]) {
        const angle = side * k * stepRadians;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        candidate[0] = heading[0] * cos + heading[2] * sin;
        candidate[1] = heading[1];
        candidate[2] = -heading[0] * sin + heading[2] * cos;
        if (clear(candidate)) {
          found = true;
          break;
        }
      }
    }
    // Pitch fallback, about the horizontal axis perpendicular to the heading
    // (floor or ceiling ahead).
    if (!found) {
      const axisLength = Math.hypot(heading[2], heading[0]);
      if (axisLength > EPSILON) {
        const ax = heading[2] / axisLength;
        const az = -heading[0] / axisLength;
        for (const angle of [0.6, -0.6, 1.1, -1.1]) {
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          // Rodrigues' rotation; the axis is perpendicular to the heading.
          candidate[0] = heading[0] * cos - az * heading[1] * sin;
          candidate[1] = heading[1] * cos + (az * heading[0] - ax * heading[2]) * sin;
          candidate[2] = heading[2] * cos + ax * heading[1] * sin;
          if (clear(candidate)) {
            found = true;
            break;
          }
        }
      }
    }
    if (!found) {
      candidate[0] = -point[0];
      candidate[1] = -point[1];
      candidate[2] = -point[2];
    }
    const norm = Math.hypot(candidate[0], candidate[1], candidate[2]);
    if (norm <= EPSILON) return 0;
    this.avoidanceDirections[offset] = candidate[0] / norm;
    this.avoidanceDirections[offset + 1] = candidate[1] / norm;
    this.avoidanceDirections[offset + 2] = candidate[2] / norm;
    return 1 - hit / length;
  }

  /**
   * Recentering: a compensation term, not a physical rule.
   *
   * A fish that turns parallel to a wall sees a clear ray and can slide along
   * the wall indefinitely. So once the ray hits, a timer starts: after
   * recenterDelay seconds, a weak pull toward the tank centre acts for
   * recenterDuration seconds. Hits while the timer runs do not restart it;
   * the next hit after it ends starts a new one.
   *
   * Returns whether the pull acts this step.
   */
  _recentering(index, hit, dt) {
    const { recenterWeight, recenterDelay, recenterDuration } =
      this.config.locomotion;
    if (recenterWeight <= 0 || recenterDuration <= 0) {
      this.recenterTimers[index] = 0;
      return false;
    }
    if (this.recenterTimers[index] <= 0) {
      if (!hit) return false;
      this.recenterTimers[index] = recenterDelay + recenterDuration;
    }
    this.recenterTimers[index] = Math.max(0, this.recenterTimers[index] - dt);
    return this.recenterTimers[index] > 0 && this.recenterTimers[index] <= recenterDuration;
  }

  _energyRatio(index) {
    const capacity = Math.max(
      EPSILON,
      energyCapacityFor(this.config, this.config.schools[this.schoolIds[index]])
    );
    return this.energy[index] / capacity;
  }

  _canBurst(index) {
    if (!this.config.ecology?.enabled) return true;
    // A desperate fish ignores the energy threshold. This is the main reason
    // desperation exists: earlier a fish below 1/3 energy never lunged again,
    // so "too weak to sprint -> cannot catch -> hungrier" was a deadlock.
    if (this.desperation[index]) return true;
    const minRatio = Number.isFinite(this.config.ecology.minBurstEnergyRatio)
      ? this.config.ecology.minBurstEnergyRatio
      : 1 / 3;
    return this._energyRatio(index) >= minRatio;
  }

  /**
   * Desperation boosts pursuit speed only; exhaustion slows the fish everywhere.
   *
   * The boost must be limited to BURST. Otherwise fleeing fish speed up too,
   * prey and predator accelerate together, and the net effect is that large
   * fish can no longer catch small ones, the opposite of the intent.
   * Exhaustion is real weakness, so it applies in every state.
   */
  _desperationSpeedScale(index, state) {
    if (!this.config.ecology?.enabled) return 1;
    if (this.desperation[index]) {
      return state === 'burst'
        ? Math.max(1, this.config.ecology.desperationSpeedBoost ?? 1)
        : 1;
    }
    // Not armed and outside the desperation window: used up and not yet
    // recovered, i.e. exhausted.
    if (!this.desperationArmed[index]) {
      return Math.max(
        0.05,
        this.config.ecology.desperationExhaustedSpeed ?? 1
      );
    }
    return 1;
  }

  _movementState(index, target, threatened) {
    const state =
      target >= 0 && this.alive[target] && this._canBurst(index)
        ? 'burst'
        : threatened
          ? 'evade'
          : 'cruise';
    this.locomotionStates[index] =
      state === 'burst'
        ? LOCOMOTION.BURST
        : state === 'evade'
          ? LOCOMOTION.EVADE
          : LOCOMOTION.CRUISE;
    return state;
  }

  // Candidate comparison: nearest first. Distances within targetTieTolerance
  // of the farther one count as tied; ties go to the better aligned
  // candidate, then to the nearer one.
  _preferCandidate(distance2, alignment, bestDistance2, bestAlignment) {
    if (!(bestDistance2 < Infinity)) return true;
    if (!this._withinTieBand(distance2, bestDistance2)) {
      return distance2 < bestDistance2;
    }
    if (alignment !== bestAlignment) return alignment > bestAlignment;
    return distance2 < bestDistance2;
  }

  _withinTieBand(distanceA2, distanceB2) {
    const a = Math.sqrt(distanceA2);
    const b = Math.sqrt(distanceB2);
    return (
      Math.abs(a - b) <=
      this.config.relations.targetTieTolerance * Math.max(a, b)
    );
  }

  _distance2(a, b) {
    const ao = a * 3;
    const bo = b * 3;
    const dx = this.positions[bo] - this.positions[ao];
    const dy = this.positions[bo + 1] - this.positions[ao + 1];
    const dz = this.positions[bo + 2] - this.positions[ao + 2];
    return dx * dx + dy * dy + dz * dz;
  }

  _resolveLock(index, dt) {
    const relations = this.config.relations;
    const detection =
      this.derived.schools[this.schoolIds[index]].detectionLength;
    const burstRadius = detection * relations.burstRadiusFactor;
    const range2 = burstRadius * burstRadius;

    // A given-up target stops being excluded once it dies or leaves range.
    const excluded = this.excludedTargets[index];
    if (
      excluded >= 0 &&
      (!this.alive[excluded] || this._distance2(index, excluded) > range2)
    ) {
      this.excludedTargets[index] = -1;
    }

    const previous = this.lockedTargets[index];
    let next = -1;
    let previousDistance2 = Infinity;
    if (previous >= 0 && this.alive[previous]) {
      previousDistance2 = this._distance2(index, previous);
      // Leaving burstRadius drops the lock.
      if (previousDistance2 <= range2) {
        // Give up if no new closest distance is reached within giveUpSeconds.
        if (previousDistance2 < this.chaseBestDistance2[index]) {
          this.chaseBestDistance2[index] = previousDistance2;
          this.chaseStall[index] = 0;
          next = previous;
        } else {
          this.chaseStall[index] += dt;
          if (this.chaseStall[index] >= relations.giveUpSeconds) {
            this.excludedTargets[index] = previous;
          } else {
            next = previous;
          }
        }
      }
    }

    // Best candidate this step (_directedRelation already picked nearest first
    // and skipped the excluded target). With no lock, take it; with a lock,
    // switch only if it is clearly nearer, outside the tie band.
    const fresh = this.pursuitTargets[index];
    if (
      fresh >= 0 &&
      fresh !== next &&
      this.alive[fresh] &&
      fresh !== this.excludedTargets[index]
    ) {
      const freshDistance2 = this._distance2(index, fresh);
      if (
        next < 0 ||
        (freshDistance2 < previousDistance2 &&
          !this._withinTieBand(freshDistance2, previousDistance2))
      ) {
        next = fresh;
      }
    }

    if (next !== previous) {
      this.chaseBestDistance2[index] =
        next >= 0 ? this._distance2(index, next) : Infinity;
      this.chaseStall[index] = 0;
    }
    this.lockedTargets[index] = next;
    this.pursuitTargets[index] = next;
  }

  _steerFish(index, dt, interactionsEnabled = true) {
    if (this._isFrozen(index)) return;
    if (!this.alive[index]) return;
    if (interactionsEnabled) this._resolveLock(index, dt);
    const offset = index * 3;
    const schoolIndex = this.schoolIds[index];
    const school = this.config.schools[schoolIndex];
    const cohesionCount = this.cohesionCounts[index];
    const alignmentCount = this.alignmentCounts[index];

    // Panic comes first because it scales alignment and cohesion. It combines
    // what the fish sees itself (continuous, distance-scaled) with what it
    // inherits from neighbors (the startle wave).
    const relations = this.config.relations;
    // The direct threat uses hysteresis: it latches above directOn and
    // releases only below directOff.
    let panic = 0;
    if (interactionsEnabled) {
      const threat = this.threatLevel[index];
      const wasLatched = this.directLatch[index] === 1;
      if (!wasLatched && threat >= relations.directOn) {
        this.directLatch[index] = 1;
      } else if (wasLatched && threat < relations.directOff) {
        this.directLatch[index] = 0;
      }
      const latched = this.directLatch[index] === 1;
      const enteredDirect = latched && !wasLatched;

      this.panicHold[index] = Math.max(0, this.panicHold[index] - dt);
      this.refractory[index] = Math.max(0, this.refractory[index] - dt);

      // Social trigger: the heard pulse is strong enough, the fish is not
      // latched by a direct threat, and it is not refractory. The refractory
      // period is essential; without it the pulse reflects around the school
      // forever.
      let emitPulse = enteredDirect;
      if (
        !latched &&
        this.heardSignal[index] >= relations.signalThreshold &&
        this.refractory[index] <= 0
      ) {
        emitPulse = true;
        this.refractory[index] = relations.refractoryTime;
      }
      if (emitPulse) this.panicHold[index] = relations.holdTime;
      if (enteredDirect) {
        this.refractory[index] = Math.max(
          this.refractory[index],
          relations.refractoryTime
        );
      }

      // During a startle panic is pinned at full, which is what makes fish scatter.
      const panicTarget = Math.max(
        latched ? threat : 0,
        this.panicHold[index] > 0 ? 1 : 0
      );
      const rising = panicTarget > this.panic[index];
      this.panic[index] = approach(
        this.panic[index],
        panicTarget,
        rising ? relations.panicRiseRate : relations.panicDecayRate,
        dt
      );
      this.alarm[index] = emitPulse
        ? 1
        : this.alarm[index] *
          Math.exp(-dt / Math.max(relations.signalDecayTime, 1e-6));
      panic = this.panic[index];
    }
    // Scatter latch: enter above panicScatterEnter, leave only below
    // panicScatterExit. A single threshold flickers at the boundary.
    if (interactionsEnabled && relations.scatterLatch !== false) {
      const enter = relations.panicScatterEnter ?? 1;
      const exit = relations.panicScatterExit ?? 0;
      if (this.scattering[index]) {
        if (panic <= exit) this.scattering[index] = 0;
      } else if (panic >= enter) {
        this.scattering[index] = 1;
      }
    } else {
      this.scattering[index] = 0;
    }

    // Under threat cohesion drops (flash expansion). Synchrony comes from the
    // separate emergency alignment channel below, not from a larger
    // alignmentWeight. While bursting, social weights are suppressed instead
    // of multiplying the pursuit force by 10: the predator breaks away to
    // lunge, but the total force stays in range, motion stays smooth, and it
    // rejoins the school afterwards.
    const lockedOn =
      interactionsEnabled &&
      this.pursuitTargets[index] >= 0 && this.alive[this.pursuitTargets[index]];
    const socialScale = lockedOn
      ? this.config.locomotion.burstSocialSuppression
      : 1;
    // Body size deliberately does not make fish more solitary. A size-to-
    // sociality exponent was removed: it was a third size coupling, while size
    // should only trade against speed and stamina. Every hidden coupling adds
    // a balance dimension whose source nobody can trace.
    // Hunger loosens the school: alignment and cohesion fade as energy drops.
    const hunger = hungerResponse(this._energyRatio(index));
    // While scattering, cohesion goes to zero rather than being scaled by
    // cohesionDrop; that is what makes every fish flee on its own.
    const cohesionWeight =
      school.cohesionWeight *
      (this.scattering[index]
        ? 0
        : Math.max(0, 1 - panic * relations.cohesionDrop)) *
      socialScale *
      (hunger ? hunger.cohesion : 1);
    // Receiver gain: a fish listens harder to its neighbors when they are
    // panicked and it is panicked too (neighbor panic x own panic), which lets
    // the wave push through layer by layer. This only strengthens alignment
    // steering; it does not raise panic, so it cannot feed itself.
    const receiverBoost = interactionsEnabled && relations.emergencyAlignment !== false
      ? Math.min(
          1 + relations.alignmentReceiverBoost * this.neighborPanic[index] * panic,
          relations.alignmentReceiverMax
        )
      : 1;
    const alignmentWeight =
      school.alignmentWeight *
      receiverBoost *
      socialScale *
      (hunger ? hunger.alignment : 1);

    const vx = this.velocities[offset];
    const vy = this.velocities[offset + 1];
    const vz = this.velocities[offset + 2];
    const ruleMaxSpeed = school.maxSpeed;
    const ruleMaxForce = this.config.locomotion.maxForce;
    let fx = 0;
    let fy = 0;
    let fz = 0;
    const applyRule = (dxr, dyr, dzr, weight) => {
      if (weight === 0) return;
      steerToward(
        dxr,
        dyr,
        dzr,
        vx,
        vy,
        vz,
        ruleMaxSpeed,
        ruleMaxForce,
        STEER_SCRATCH
      );
      fx += STEER_SCRATCH[0] * weight;
      fy += STEER_SCRATCH[1] * weight;
      fz += STEER_SCRATCH[2] * weight;
    };

    // Separation uses a higher safetySpeed under panic, so fleeing fish give
    // way to each other more strongly.
    const safetySpeed = ruleMaxSpeed * (1 + 0.25 * panic);
    steerToward(
      this.separation[offset],
      this.separation[offset + 1],
      this.separation[offset + 2],
      vx,
      vy,
      vz,
      safetySpeed,
      ruleMaxForce,
      STEER_SCRATCH
    );
    fx += STEER_SCRATCH[0] * school.separationWeight;
    fy += STEER_SCRATCH[1] * school.separationWeight;
    fz += STEER_SCRATCH[2] * school.separationWeight;
    if (cohesionCount > 0) {
      applyRule(
        this.cohesionSums[offset] / cohesionCount - this.positions[offset],
        this.cohesionSums[offset + 1] / cohesionCount -
          this.positions[offset + 1],
        this.cohesionSums[offset + 2] / cohesionCount -
          this.positions[offset + 2],
        cohesionWeight
      );
    }
    if (alignmentCount > 0) {
      applyRule(
        this.alignmentSums[offset] / alignmentCount,
        this.alignmentSums[offset + 1] / alignmentCount,
        this.alignmentSums[offset + 2] / alignmentCount,
        alignmentWeight
      );
    }

    // Escape direction. Design rule: only fish that directly perceive a
    // predator get a geometric escape vector. Socially panicked fish know only
    // their neighbors' headings, not the predator's position; anything else
    // would be omniscience. They turn with the school through alignment.
    const ex = this.evadeForces[offset];
    const ey = this.evadeForces[offset + 1];
    const ez = this.evadeForces[offset + 2];
    const escapeMagnitude = Math.hypot(ex, ey, ez);
    const inverseEscape = escapeMagnitude > EPSILON ? 1 / escapeMagnitude : 0;
    // Emergency alignment: one fish that sees danger outweighs the average of
    // twenty calm neighbors. This is what actually carries the startle wave.
    // It is off while scattering; otherwise it keeps pulling fish that want to
    // split back onto one heading, and they never flee separately.
    if (
      interactionsEnabled &&
      this.emergencyUrgency[index] > 0 &&
      !this.scattering[index]
    ) {
      const emergency = normalize3(
        this.emergencyAlign[offset],
        this.emergencyAlign[offset + 1],
        this.emergencyAlign[offset + 2]
      );
      applyRule(
        emergency[0],
        emergency[1],
        emergency[2],
        relations.emergencyAlignmentWeight * this.emergencyUrgency[index]
      );
    }

    // Escape strength follows how close the nearest predator is (directThreat:
    // 1 at contact, 0 at the edge of panicRadius), amplified by the fish's own
    // panic. The amplifier is 1 + k * panic rather than k * panic, so a fish
    // that sees a predator before its panic latches still moves away.
    const directThreat = interactionsEnabled
      ? this.threatLevel[index]
      : 0;
    const threatened =
      interactionsEnabled && panic > relations.panicMinTrigger;
    if (directThreat > 0) {
      applyRule(
        ex * inverseEscape,
        ey * inverseEscape,
        ez * inverseEscape,
        relations.evadeWeight *
          directThreat *
          (1 + (relations.evadePanicBoost ?? 0) * panic)
      );
    }

    const localPredationCount = interactionsEnabled
      ? this.predationCounts[index]
      : 0;
    // Hunting steer has two mutually exclusive states:
    //   locked  a target is locked -> steer toward that fish only
    //   scan    no lock            -> steer toward the centroid of prey in
    //                                 sensing range (long-range approach)
    // Earlier both forces were applied together. When the locked prey sat at
    // the edge of its school, the centroid force pulled toward the school
    // center and the lunge pulled toward the one fish; at 1.05 : 2.2 the
    // centroid force was strong enough to bend the lunge but not to dominate,
    // so the sum cut diagonally into the empty space between them. That was
    // the odd turning during hunts.
    // A lock ends scanning whether or not the fish can burst. Capture has no
    // burst requirement (a locked target inside capture radius is eaten even
    // by a fish too weak to sprint), so keeping the centroid force on low
    // energy tied two independent things together. Once the target is chosen,
    // pulling toward the prey school's centroid only drags the predator away
    // from it.
    // Both states use the same pursuitWeight; only the direction changes. The
    // burst force is added on top when energy allows and is not part of this
    // choice.
    const lockedTarget = interactionsEnabled ? this.pursuitTargets[index] : -1;
    const hasLock = lockedTarget >= 0 && this.alive[lockedTarget];
    const bursting = hasLock && this._canBurst(index);
    const huntState = hasLock ? 'locked' : localPredationCount > 0 ? 'scan' : null;
    if (huntState) {
      let hx;
      let hy;
      let hz;
      if (huntState === 'locked') {
        const lo = lockedTarget * 3;
        hx = this.positions[lo] - this.positions[offset];
        hy = this.positions[lo + 1] - this.positions[offset + 1];
        hz = this.positions[lo + 2] - this.positions[offset + 2];
      } else {
        hx = this.predationSums[offset] / localPredationCount - this.positions[offset];
        hy =
          this.predationSums[offset + 1] / localPredationCount -
          this.positions[offset + 1];
        hz =
          this.predationSums[offset + 2] / localPredationCount -
          this.positions[offset + 2];
      }
      applyRule(
        hx,
        hy,
        hz,
        // A desperate fish also pursues harder. Speed alone gives a fast fish
        // that does not turn toward its prey, which just darts around.
        this.config.relations.pursuitWeight *
          (this.desperation[index]
            ? Math.max(1, this.config.ecology?.desperationPursuitBoost ?? 1)
            : 1)
      );
    }

    const target = lockedTarget;
    if (bursting) {
      const targetOffset = target * 3;
      // Use the distance to the locked fish. targetDistance2 belongs to this
      // step's best candidate, which can be a different fish; earlier this read
      // it and computed the lead on the wrong fish.
      const distance = Math.sqrt(this._distance2(index, target));
      const lookAhead = Math.min(
        this.config.locomotion.interceptLookAhead,
        distance / Math.max(EPSILON, school.maxSpeed)
      );
      const ix =
        this.positions[targetOffset] +
        this.velocities[targetOffset] * lookAhead;
      const iy =
        this.positions[targetOffset + 1] +
        this.velocities[targetOffset + 1] * lookAhead;
      const iz =
        this.positions[targetOffset + 2] +
        this.velocities[targetOffset + 2] * lookAhead;
      const pursuit = normalize3(
        ix - this.positions[offset],
        iy - this.positions[offset + 1],
        iz - this.positions[offset + 2]
      );
      // Burst pursuit also goes through normalized steering. Earlier it was a
      // raw force x10, more than twice all other rules combined, with no
      // velocity subtraction and no maxForce clamp: a locked fish effectively
      // left its school, which made multi-school scenes look like colliding ions.
      applyRule(
        pursuit[0],
        pursuit[1],
        pursuit[2],
        this.config.relations.burstWeight
      );
    }

    // Foraging steer, only when actually hungry (see ecology.seekHungerRatio
    // in experiment-config.js). The direction is the 1/d-weighted centroid of
    // particles in sensing range, not the nearest particle, which makes a fish
    // fixate and jitter when only one is left. With no particle in range there
    // is no force: the fish does not know where to go and does not pretend to.
    if (this.config.ecology?.enabled && this.config.plankton?.enabled) {
      const seekGate =
        energyCapacityFor(this.config, school) *
        (this.config.ecology.seekHungerRatio ?? 0.5);
      const energy = this.energy[index];
      if (energy < seekGate && seekGate > EPSILON) {
        // Urgency runs from 0 at the threshold to 1 at empty; hungrier fish turn harder.
        const urgency = Math.min(1, Math.max(0, 1 - energy / seekGate));
        const toFood = this.food.directionAt(
          this.positions[offset],
          this.positions[offset + 1],
          this.positions[offset + 2]
        );
        if (toFood) {
          applyRule(
            toFood[0],
            toFood[1],
            toFood[2],
            this.config.locomotion.forageWeight * urgency
          );
        }
      }
    }

    const point = [
      this.positions[offset],
      this.positions[offset + 1],
      this.positions[offset + 2],
    ];
    const avoidanceUrgency = this._lookAhead(index, point, vx, vy, vz);
    if (avoidanceUrgency > 0) {
      applyRule(
        this.avoidanceDirections[offset],
        this.avoidanceDirections[offset + 1],
        this.avoidanceDirections[offset + 2],
        this.config.locomotion.avoidanceWeight * (1 + avoidanceUrgency * 2)
      );
    }
    if (this._recentering(index, avoidanceUrgency > 0, dt)) {
      applyRule(
        -point[0],
        -point[1],
        -point[2],
        this.config.locomotion.recenterWeight
      );
    }

    this.wanderPhases[index] += dt * this.wanderRates[index];
    const phase = this.wanderPhases[index];
    fx += Math.sin(phase * 1.31) * this.config.locomotion.wanderWeight;
    fy += Math.sin(phase * 1.73 + 2.1) * this.config.locomotion.wanderWeight;
    fz += Math.cos(phase * 1.17) * this.config.locomotion.wanderWeight;

    const force = normalize3(fx, fy, fz);
    // Bursting gets a modest extra force budget. Earlier the budget was
    // multiplied by burstWeight (10), which raised the clamp from 5.2 to 52
    // and effectively removed it.
    const forceBudget =
      target >= 0 && this.alive[target]
        ? this.config.locomotion.maxForce *
          this.config.locomotion.burstForceBudget
        : this.config.locomotion.maxForce;
    const forceMagnitude = Math.min(
      forceBudget,
      force[3]
    );
    const oldVx = this.velocities[offset];
    const oldVy = this.velocities[offset + 1];
    const oldVz = this.velocities[offset + 2];
    let nextVx = oldVx + force[0] * forceMagnitude * dt;
    let nextVy = oldVy + force[1] * forceMagnitude * dt;
    let nextVz = oldVz + force[2] * forceMagnitude * dt;
    const nextDirection = normalize3(nextVx, nextVy, nextVz);
    const oldDirection = normalize3(oldVx, oldVy, oldVz);
    const dot = clamp(
      oldDirection[0] * nextDirection[0] +
        oldDirection[1] * nextDirection[1] +
        oldDirection[2] * nextDirection[2],
      -1,
      1
    );
    const angle = Math.acos(dot);
    // Turning ability drops sharply while bursting: when prey dodges, the
    // predator overshoots and circles back. This step's lock is read directly
    // to avoid last step's locomotionStates.
    const burstingNow = target >= 0 && this.alive[target];
    const turnSpeed =
      effectiveTurnSpeed(this.config, school) *
      (burstingNow ? this.config.locomotion.burstTurnFactor : 1) *
      (1 + this.panic[index] * this.config.relations.panicTurnBoost);
    const turnAlpha =
      angle <= EPSILON
        ? 1
        : Math.min(1, (turnSpeed * dt) / angle);
    let turned = normalize3(
      oldDirection[0] * (1 - turnAlpha) + nextDirection[0] * turnAlpha,
      oldDirection[1] * (1 - turnAlpha) + nextDirection[1] * turnAlpha,
      oldDirection[2] * (1 - turnAlpha) + nextDirection[2] * turnAlpha
    );
    // Pitch clamp: fish do not climb or dive vertically like submarines.
    // Without it, fleeing fish would shoot straight up and down.
    const maxPitch = (this.config.locomotion.maxPitchDegrees * Math.PI) / 180;
    const horizontal = Math.hypot(turned[0], turned[2]);
    const pitch = Math.atan2(turned[1], Math.max(horizontal, EPSILON));
    if (Math.abs(pitch) > maxPitch) {
      turned = normalize3(
        turned[0],
        Math.max(horizontal, EPSILON) * Math.tan(Math.sign(pitch) * maxPitch),
        turned[2]
      );
    }
    let desiredSpeed = nextDirection[3];
    const cruiseSpeed =
      school.cruiseSpeed * sustainedSpeedScale(this.config, school);
    if (desiredSpeed < cruiseSpeed) {
      desiredSpeed = approach(desiredSpeed, cruiseSpeed, 3, dt);
    }
    const state = this._movementState(index, target, threatened);
    const maxSpeed = effectiveMaxSpeed(this.config, school, state);
    desiredSpeed = Math.min(maxSpeed, desiredSpeed);
    const hungerSpeed = hungerResponse(this._energyRatio(index));
    if (hungerSpeed) desiredSpeed *= hungerSpeed.speed;
    desiredSpeed *= this._desperationSpeedScale(index, state);
    nextVx = turned[0] * desiredSpeed;
    nextVy = turned[1] * desiredSpeed;
    nextVz = turned[2] * desiredSpeed;
    set3(this.velocities, index, nextVx, nextVy, nextVz);
  }

  /**
   * Schools in different chambers do not exist for each other: every relation
   * between them becomes ignore.
   *
   * Separate bounds are not enough, because a box stops bodies but not sight.
   * Measured with a 0.10 m gap between sub-tanks, the 0.33 m capture radius
   * reached across the divider (2 captures in 30 s); even with a 1.0 m gap
   * the 1.18 m sensing radius still covered the full tank height, panic still
   * reached 0.895 and pursuits still started. Widening the gap does not fix it.
   *
   * The relation matrix is the cheapest cut: predation, evasion, panic and
   * target locking all read it, so one ignore makes the two sides mutually
   * invisible, which is what two tanks really means. Social forces
   * (alignment, cohesion) only act within a school and are unaffected.
   */
  _isolateChambers() {
    const schools = this.config.schools;
    if (!schools.some((school) => school.chamber !== undefined)) return;
    for (let a = 0; a < schools.length; a += 1) {
      for (let b = 0; b < schools.length; b += 1) {
        if (a === b) continue;
        if (schools[a].chamber === schools[b].chamber) continue;
        this.relationMatrix[a][b] = 'ignore';
      }
    }
  }

  /**
  /**
   * Freeze some chambers: fish there hold still and take no part in predation.
   *
   * With two tanks on screen, simultaneous chases on both sides are too much
   * to follow. Freezing is per chamber rather than a global pause: a global
   * pause stops both sides together, while a per-chamber freeze lets the
   * viewer watch one side at a time.
   *
   * This is runtime state rather than config, because changing config
   * triggers validation and a rebuild, and pausing should not rearrange fish.
   */
  setFrozenChambers(chambers = []) {
    const frozen = new Set(chambers);
    const count = this.config.schools.length;
    if (!this.chamberTargets || this.chamberTargets.length !== count) {
      this.chamberTargets = new Float32Array(count).fill(1);
      this.chamberScales = new Float32Array(count).fill(1);
    }
    this.config.schools.forEach((school, index) => {
      this.chamberTargets[index] =
        school.chamber !== undefined && frozen.has(school.chamber) ? 0 : 1;
    });
  }

  /**
   * Each chamber's time scale approaches its target exponentially instead of
   * jumping to 0 or 1.
   *
   * A hard freeze looks stuck; easing in and out looks like stopping. Below a
   * threshold the value snaps to 0: an exponential never reaches 0, so
   * without the snap fish would drift forever at an invisible speed and
   * capture checks would keep running.
   */
  _easeChamberScales(dt) {
    if (!this.chamberTargets) return;
    const k = 1 - Math.exp(-CHAMBER_EASE_RATE * dt);
    for (let i = 0; i < this.chamberTargets.length; i += 1) {
      const target = this.chamberTargets[i];
      let value = this.chamberScales[i] + (target - this.chamberScales[i]) * k;
      if (target === 0 && value < CHAMBER_STOP_EPSILON) value = 0;
      else if (target === 1 && value > 1 - CHAMBER_STOP_EPSILON) value = 1;
      this.chamberScales[i] = value;
    }
  }

  /** This fish's current time scale: 1 = normal, 0 = fully stopped. */
  _timeScaleFor(index) {
    return this.chamberScales?.[this.schoolIds[index]] ?? 1;
  }

  _isFrozen(index) {
    return this._timeScaleFor(index) === 0;
  }

  /**
   * Per-school activity bounds. A school without bounds uses the whole tank.
   *
   * The tank walls are a hard clamp (_integrate rewrites coordinates rather
   * than adding a force), so splitting that box per school is enough to show
   * two tanks with zero leakage, without actually creating a second tank.
   *
   * A partition obstacle would not work: obstacle avoidance is a soft
   * steering force, not a hard constraint, and a startled fish fleeing at
   * full speed can push straight through it. Two isolated environments cannot
   * be shown with a wall that leaks.
   */
  _refreshSchoolBounds() {
    const tank = this.config.tank;
    const margin = tank.wallMargin;
    this._schoolBounds = this.config.schools.map((school) => {
      const box = school.bounds;
      return {
        center: [box?.centerX ?? 0, box?.centerY ?? 0, box?.centerZ ?? 0],
        half: [
          Math.max(EPSILON, (box?.width ?? tank.width) / 2 - margin),
          Math.max(EPSILON, (box?.height ?? tank.height) / 2 - margin),
          Math.max(EPSILON, (box?.depth ?? tank.depth) / 2 - margin),
        ],
      };
    });
  }

  _integrate(index, dt) {
    if (!this.alive[index] || this._isFrozen(index)) return;
    const offset = index * 3;
    this.positions[offset] += this.velocities[offset] * dt;
    this.positions[offset + 1] += this.velocities[offset + 1] * dt;
    this.positions[offset + 2] += this.velocities[offset + 2] * dt;
    if (!this._schoolBounds) this._refreshSchoolBounds();
    const bounds = this._schoolBounds[this.schoolIds[index]];
    for (let axis = 0; axis < 3; axis += 1) {
      const low = bounds.center[axis] - bounds.half[axis];
      const high = bounds.center[axis] + bounds.half[axis];
      if (this.positions[offset + axis] < low) {
        this.positions[offset + axis] = low;
        this.velocities[offset + axis] = Math.abs(
          this.velocities[offset + axis]
        );
      } else if (this.positions[offset + axis] > high) {
        this.positions[offset + axis] = high;
        this.velocities[offset + axis] = -Math.abs(
          this.velocities[offset + axis]
        );
      }
    }
  }

  /**
   * Transitional. External code (metrics, the panel, tests, fingerprint
   * tooling) still reads and writes a tank-wide plankton total. This accessor
   * should go together with the move to spatial plankton, after which a total
   * is no longer a meaningful quantity.
   */
  get planktonLevel() {
    return this.food.level;
  }

  set planktonLevel(value) {
    this.food.level = value;
  }

  /**
   * Number of living fish in a school, looked up by school id. Callers that
   * poll every frame should use this rather than metrics(), which also
   * computes predator pairs, telemetry and closure times. Returns 0 when the
   * school is not found (the config can briefly disagree during a switch).
   *
   * It must not be named aliveCount: the class already has an aliveCount that
   * takes an index. The later definition would silently override the earlier
   * one, the id would be used as an index into schoolRanges, and it would
   * crash on range.start.
   */
  aliveCountFor(schoolId) {
    const index = this.config.schools.findIndex(
      (school) => school.id === schoolId
    );
    if (index < 0 || !this.schoolRanges?.[index]) return 0;
    return this._activeSchoolCount(index);
  }

  _activeSchoolCount(schoolIndex) {
    const range = this.schoolRanges[schoolIndex];
    let count = 0;
    for (let index = range.start; index < range.end; index += 1) {
      count += this.alive[index];
    }
    return count;
  }

  /** Corpses rise slowly to the surface and stay there. */
  _floatCorpses(dt) {
    // Rising is an acceleration, not a fixed rate. Earlier riseSpeed * t was
    // added as a velocity offset, with the fade progress t hand-building a
    // "barely moves right after death" ease-in. With buoyant acceleration that
    // ease-in comes for free, since velocity grows from 0 on its own. Together
    // with the existing drag it gives a terminal velocity of accel / drag: the
    // corpse speeds up, then drifts steadily, the real shape of buoyancy
    // against water resistance.
    const riseAccel = Math.max(
      0,
      this.config.ecology.corpseRiseAccel ?? 0.15
    );
    const drag = Math.max(0, this.config.ecology.corpseDrag ?? 2.4);
    const margin = this.config.tank.wallMargin;
    const half = [
      this.config.tank.width / 2 - margin,
      this.config.tank.height / 2 - margin,
      this.config.tank.depth / 2 - margin,
    ];
    for (let index = 0; index < this.count; index += 1) {
      if (!this.corpse[index]) continue;
      this.corpseAge[index] += dt;
      const offset = index * 3;
      // Leftover momentum decays exponentially, so the body glides and stops.
      const damping = Math.exp(-drag * dt);
      this.velocities[offset] *= damping;
      this.velocities[offset + 1] *= damping;
      this.velocities[offset + 2] *= damping;
      // Buoyancy adds a little upward velocity each step. Drag has already
      // been applied above, so the two converge to riseAccel / drag.
      this.velocities[offset + 1] += riseAccel * dt;
      this.positions[offset] += this.velocities[offset] * dt;
      this.positions[offset + 1] += this.velocities[offset + 1] * dt;
      this.positions[offset + 2] += this.velocities[offset + 2] * dt;
      for (let axis = 0; axis < 3; axis += 1) {
        const limit = half[axis];
        const value = this.positions[offset + axis];
        if (value > limit) this.positions[offset + axis] = limit;
        else if (value < -limit) this.positions[offset + axis] = -limit;
      }
    }
  }

  _killFish(index, reason) {
    if (!this.alive[index]) return false;
    this.alive[index] = 0;
    const schoolIndex = this.schoolIds[index];
    if (reason === 'captured') {
      this.deathCounts[schoolIndex].captured += 1;
    } else if (reason === 'starved') {
      this.deathCounts[schoolIndex].starved += 1;
      // The corpse is the fish model itself: it stays in place, turns grey and
      // slowly rises. Real dead fish mostly float on gas left in the swim bladder.
      this.corpse[index] = 1;
      this.corpseAge[index] = 0;
      // Velocity is not zeroed: the body glides on its momentum before
      // stopping, so death has a visible process.
    }
    return true;
  }

  _updateEcology(dt) {
    if (!this.config.ecology?.enabled) return;
    this.food.regrow(dt);
    // Each meal is split three ways: the fish itself, nearby fish, and the
    // whole school. See experiment-config.js.
    const localShare = clamp(this.config.ecology.energyShareLocal ?? 0, 0, 1);
    const schoolShare = clamp(this.config.ecology.energyShareSchool ?? 0, 0, 1);
    const shareFraction = Math.min(1, localShare + schoolShare);
    const shareRadius = Math.max(
      0,
      this.config.ecology.energyShareRadius ?? 0
    );
    const shareRadius2 = shareRadius * shareRadius;
    const planktonEnergy = Math.max(
      0,
      this.config.ecology.planktonEnergy ?? 0.132
    );

    const planktonOn = this.config.plankton.enabled && this.food.hasFood;

    for (let index = 0; index < this.count; index += 1) {
      if (!this.alive[index]) continue;
      const schoolIndex = this.schoolIds[index];
      const school = this.config.schools[schoolIndex];
      if (!(school.grazeRate > 0)) continue;
      // Grazing rate scales with body size. school.grazeRate is a multiplier;
      // the real rate also multiplies size^grazeSizeExponent. Larger fish
      // graze more (gill and mouth area), but not enough to cover their
      // size^0.75 metabolism, and the gap is what they have to hunt for.
      const grazeRate =
        school.grazeRate *
        Math.pow(
          Math.max(EPSILON, school.size),
          this.config.ecology.grazeSizeExponent ?? 0
        );
      // Hunting comes first: a fish locked on prey does not graze. Medium and
      // large schools are almost always hunting, so they graze least; the
      // small school never hunts (its size ratios fall on the evade side), so
      // it lives on plankton.
      if (this.pursuitTargets[index] >= 0) continue;
      // Capacity scales with body size, so the limit is per fish, not computed
      // once outside the loop.
      const capacityLimit = energyCapacityFor(this.config, school);
      // Hunger gate: a full fish does not eat. This is what keeps plankton
      // sustainable. Earlier, unconstrained grazing consumed 64/s against 18/s
      // of regrowth, emptied the stock within seconds, and at level 0 it never
      // recovered. Eating only below the threshold settles at about 4/s, a
      // 4.5x margin.
      const hungerGate =
        capacityLimit * (this.config.ecology.grazeHungerRatio ?? 0.8);
      if (this.energy[index] >= hungerGate) continue;
      const attemptChance = Math.min(1, grazeRate * dt * 4);
      if (this.rng.next() > attemptChance) continue;

      const offset = index * 3;
      let gain = 0;
      let ate = false;

      // Corpses are no longer food. They rise and get pinned against the
      // walls, and carrionRadius was only 0.08, so they were almost never
      // eaten: dead code with a config knob. More importantly, dead fish
      // feeding living ones is positive feedback: after one wave dies the rest
      // survive more easily, the opposite of schools dying off group by group.
      // The floating corpse visual stays, since a fish rising belly-up is the
      // only visible sign that one just died.
      if (planktonOn) {
        const maxIntake = Math.max(
          0,
          this.config.plankton.maxIntakePerFish
        );
        // Food available here, not tank-wide: bites within reach of this
        // position.
        const available = this.food.availableAt(
          this.positions[offset],
          this.positions[offset + 1],
          this.positions[offset + 2]
        );
        const requested = planktonIntake({
          available,
          maxIntake,
          // Half-saturation on the local scale. available is already the
          // stock within reach; a constant based on whole-tank capacity would
          // make the saturation term crush intake to zero.
          halfSaturation: this.food.halfSaturation,
        });
        // Energy follows what was actually taken, not what was requested.
        // Holling type II gives the desired intake, but particles are discrete
        // (whole bites only), so the actual amount is often smaller. Earlier
        // energy was granted on the request and take()'s return value was
        // discarded, so the reported intake and the fish's energy gain disagreed.
        const intake =
          requested > 0
            ? this.food.take(
                this.positions[offset],
                this.positions[offset + 1],
                this.positions[offset + 2],
                requested
              )
            : 0;
        if (intake > 0) {
          this.planktonConsumed += intake;
          // Full intake keeps the existing recovery; scarce food scales it down
          // with actual intake. Earlier the energy conversion knob was never
          // read here and only appeared in the panel.
          const intakeFraction =
            maxIntake > EPSILON ? intake / maxIntake : 0;
          // Not multiplied by grazeRate, which already sets how often a fish
          // eats; multiplying the gain too would square the same parameter.
          // Under the default config that gave a large fish with grazeRate
          // 0.01 one ten-thousandth of a small fish's plankton income, while
          // its drain was 1.8x. What a bite is worth should not depend on who
          // eats it.
          gain = planktonEnergy * intakeFraction;
          ate = true;
        }
      }

      if (!ate || gain <= 0) continue;
      this.energy[index] = Math.min(
        capacityLimit,
        this.energy[index] + gain * (1 - shareFraction)
      );
      // The school-wide share goes to the pool, split among living fish each step.
      this.energyPools[schoolIndex] += gain * schoolShare;
      // The nearby share is split on the spot among whoever is physically
      // close, regardless of school id. Small groups eat well together and
      // starve together, which is how dying off group by group emerges.
      if (localShare > 0 && shareRadius2 > 0) {
        const neighbours = [];
        this.hash.forEachCandidate(index, (other) => {
          if (other === index || !this.alive[other]) return;
          const oo = other * 3;
          const dx = this.positions[oo] - this.positions[offset];
          const dy = this.positions[oo + 1] - this.positions[offset + 1];
          const dz = this.positions[oo + 2] - this.positions[offset + 2];
          if (dx * dx + dy * dy + dz * dz <= shareRadius2) neighbours.push(other);
        });
        if (neighbours.length > 0) {
          const each = (gain * localShare) / neighbours.length;
          for (const other of neighbours) {
            this.energy[other] = Math.min(
              capacityLimit,
              this.energy[other] + each
            );
          }
        } else {
          // No fish nearby: this share goes to the eater; loners are not penalized.
          this.energy[index] = Math.min(
            capacityLimit,
            this.energy[index] + gain * localShare
          );
        }
      }
      this.captureVfx?.emitFeed?.(
        this.positions[offset],
        this.positions[offset + 1],
        this.positions[offset + 2]
      );
    }

    // Distribute each school's pool evenly among its living fish. Energy above
    // capacity is discarded, not carried to the next step.
    const perFishShare = this.energyPools.map((pool, schoolIndex) => {
      if (!(pool > 0)) return 0;
      const alive = this._activeSchoolCount(schoolIndex);
      return alive > 0 ? pool / alive : 0;
    });
    this.energyPools.fill(0);
    for (let index = 0; index < this.count; index += 1) {
      if (!this.alive[index]) continue;
      const schoolIndex = this.schoolIds[index];
      const bonus = perFishShare[schoolIndex];
      if (bonus > 0) {
        this.energy[index] = Math.min(
          energyCapacityFor(this.config, this.config.schools[schoolIndex]),
          this.energy[index] + bonus
        );
      }
    }

    const eco = this.config.ecology;
    // Detail switches (tier 6). Without desperation a starving fish never
    // enters the sprint; without debt the sprint pays its whole cost at once.
    const desperationOn = eco.desperation !== false;
    const costShare =
      eco.desperationDebt === false ? 1 : clamp(eco.desperationCostShare ?? 1, 0, 1);
    const settleSeconds = Math.max(0.01, eco.debtSettleSeconds ?? 10);

    const starved = [];
    for (let index = 0; index < this.count; index += 1) {
      if (!this.alive[index]) continue;
      const school = this.config.schools[this.schoolIds[index]];
      // Thresholds follow this fish's own capacity.
      const fishCapacity = energyCapacityFor(this.config, school);
      const enterAt = fishCapacity * (eco.desperationEnterRatio ?? 0);
      const recoverAt = fishCapacity * (eco.desperationRecoverRatio ?? 1);
      let drain =
        metabolicRate(
          this.config,
          school,
          this.locomotionStates[index] === LOCOMOTION.BURST
        ) * dt;

      // Desperation. The latch re-arms once energy reaches the recovery line,
      // which also ends exhaustion.
      if (this.energy[index] >= recoverAt) this.desperationArmed[index] = 1;
      if (this.desperation[index]) {
        // Timer expired without recovering: leave desperation and become
        // exhausted (armed stays 0, speed x0.8).
        if (this.elapsed >= this.desperationUntil[index]) {
          this.desperation[index] = 0;
        }
      } else if (
        desperationOn &&
        this.desperationArmed[index] &&
        enterAt > EPSILON &&
        this.energy[index] < enterAt
      ) {
        this.desperation[index] = 1;
        this.desperationArmed[index] = 0;
        this.desperationUntil[index] =
          this.elapsed + Math.max(0, eco.desperationSeconds ?? 0);
      }

      // During desperation only part of the cost is paid now; the rest becomes
      // debt. Eating does not erase debt: it keeps draining energy and can
      // still kill at 0, so the fish dies of the bill coming due. That is what
      // an inherited cost looks like for a single fish.
      if (this.desperation[index] && costShare < 1) {
        const deferred = drain * (1 - costShare);
        this.debt[index] += deferred;
        drain -= deferred;
      }
      if (this.debt[index] > 0) {
        const settle = Math.min(
          this.debt[index],
          (this.debt[index] / settleSeconds) * dt
        );
        this.debt[index] -= settle;
        drain += settle;
      }

      // Subtraction needs no upper clamp (x - drain <= x <= capacity). Earlier
      // a Math.min copied from the energy-gain code sat here and never fired.
      this.energy[index] -= drain;
      if (this.energy[index] <= 0) starved.push(index);
    }
    for (const index of starved) this._killFish(index, 'starved');
    this._floatCorpses(dt);
    if (this.config.runtime.mode === 'ecology') {
      const aliveCounts = this.config.schools.map((_, schoolIndex) =>
        this._activeSchoolCount(schoolIndex)
      );
      this.ecologyStatus = ecologyOutcome(aliveCounts);
    }
    this._syncPlanktonVisual();
  }

  /**
   * Incidental prey: a fish too small to be worth chasing (size ratio above
   * KMax) that happens to be within reach.
   *
   * No lock and no chase, only "it is already at the mouth". This fills a
   * real gap: a large fish's active prey is only the school with size ratio
   * in [k, KMax], and once metabolism scales with size that school alone
   * cannot feed it. A whale does not chase a single krill, but swallows krill
   * as it swims through a cloud.
   */
  _findIncidentalPrey(predator) {
    const predatorSchool = this.schoolIds[predator];
    const predatorConf = this.config.schools[predatorSchool];
    const kMax = this.config.relations.KMax;
    if (!(kMax > 0)) return -1;
    // The hash is built in each _advance step. Tests call _capture directly
    // and skip the step, leaving it empty; no neighbors means nothing in reach.
    if (!this.hash?.positions) return -1;
    const po = predator * 3;
    let best = -1;
    let bestDistance2 = Infinity;
    this.hash.forEachCandidate(predator, (other) => {
      if (other === predator || !this.alive[other]) return;
      const otherSchool = this.schoolIds[other];
      if (otherSchool === predatorSchool) return;
      const otherConf = this.config.schools[otherSchool];
      // Only prey too small to be targeted; normal prey goes through the lock.
      if (predatorConf.size / otherConf.size <= kMax) return;
      const radius = captureRadius(this.config, predatorConf, otherConf);
      const oo = other * 3;
      const dx = this.positions[oo] - this.positions[po];
      const dy = this.positions[oo + 1] - this.positions[po + 1];
      const dz = this.positions[oo + 2] - this.positions[po + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > radius * radius || d2 >= bestDistance2) return;
      bestDistance2 = d2;
      best = other;
    });
    return best;
  }

  _capture(dt) {
    if (this.config.relations.enabled === false) return;
    const incidentalOn = this.config.capture.incidentalCapture !== false;
    for (let predator = 0; predator < this.count; predator += 1) {
      if (this._isFrozen(predator) || !this.alive[predator]) {
        continue;
      }
      // Priority: eat the locked target if it is in reach; only otherwise
      // check for anything else at the mouth. The first version looked for
      // incidental prey only when there was no lock, and it never fired,
      // because large fish are almost always locked on a medium fish. The
      // lock decides where to swim, not what the mouth touches.
      let prey = -1;
      let incidental = false;
      const locked = this.pursuitTargets[predator];
      if (locked >= 0 && this.alive[locked]) {
        const lo = locked * 3;
        const po0 = predator * 3;
        const r = captureRadius(
          this.config,
          this.config.schools[this.schoolIds[predator]],
          this.config.schools[this.schoolIds[locked]]
        );
        const dx = this.positions[lo] - this.positions[po0];
        const dy = this.positions[lo + 1] - this.positions[po0 + 1];
        const dz = this.positions[lo + 2] - this.positions[po0 + 2];
        if (dx * dx + dy * dy + dz * dz <= r * r) prey = locked;
      }
      if (prey < 0 && incidentalOn) {
        prey = this._findIncidentalPrey(predator);
        incidental = prey >= 0;
      }
      if (prey < 0 || !this.alive[prey]) continue;
      const predatorSchool = this.schoolIds[predator];
      const preySchool = this.schoolIds[prey];
      if (
        !incidental &&
        relationBetween(
          this.config.schools[predatorSchool],
          this.config.schools[preySchool],
          this.config.relations
        ) !== 'pursuit'
      ) {
        continue;
      }
      const po = predator * 3;
      const qo = prey * 3;
      const distance = Math.hypot(
        this.positions[qo] - this.positions[po],
        this.positions[qo + 1] - this.positions[po + 1],
        this.positions[qo + 2] - this.positions[po + 2]
      );
      const radius = captureRadius(
        this.config,
        this.config.schools[predatorSchool],
        this.config.schools[preySchool]
      );
      if (distance > radius) continue;
      this.captureVfx?.emit(
        new THREE.Vector3(
          this.positions[qo],
          this.positions[qo + 1],
          this.positions[qo + 2]
        ),
        new THREE.Vector3(
          this.velocities[po],
          this.velocities[po + 1],
          this.velocities[po + 2]
        ),
        new THREE.Vector3(
          this.positions[po],
          this.positions[po + 1],
          this.positions[po + 2]
        )
      );
      this._finishChase(predator, prey, true);
      this._killFish(prey, 'captured');
      this.metricsState.captures += 1;
      if (this.config.ecology?.enabled) {
        const captureGain =
          this.config.ecology.captureEnergyPerSize *
          this.config.schools[preySchool].size;
        const captureShare = clamp(
          (this.config.ecology.energyShareLocal ?? 0) +
            (this.config.ecology.energyShareSchool ?? 0),
          0,
          1
        );
        this.energyPools[predatorSchool] += captureGain * captureShare;
        this.energy[predator] = Math.min(
          energyCapacityFor(
            this.config,
            this.config.schools[predatorSchool]
          ),
          this.energy[predator] + captureGain * (1 - captureShare)
        );
      }
    }
  }

  _advance(dt) {
    if (
      this.config.runtime.mode === 'ecology' &&
      this.ecologyStatus.state !== 'running'
    ) {
      return;
    }
    this.elapsed += dt;
    this.derived = deriveExperiment(this.config);
    this.hash.cellSize = Math.max(EPSILON, this.derived.cellSize);
    this._refreshSchoolBounds();
    this.relationMatrix = this.relations.update(
      this.config.schools,
      this.config.relations
    );
    this._isolateChambers();
    this._clearAccumulators();
    this.hash.build(this.positions, this.alive, this.count);
    this._easeChamberScales(dt);
    this._pairPasses();
    for (let index = 0; index < this.count; index += 1) {
      this._steerFish(index, dt * this._timeScaleFor(index));
    }
    this._updateChaseTelemetry(dt);
    for (let index = 0; index < this.count; index += 1) {
      this._integrate(index, dt * this._timeScaleFor(index));
    }
    this._capture(dt);
    this._updateEcology(dt);
    this.updateMesh();
  }

  _advanceLocomotionPreview(dt) {
    this.derived = deriveExperiment(this.config);
    this.hash.cellSize = Math.max(EPSILON, this.derived.cellSize);
    this._refreshSchoolBounds();
    this.relationMatrix = this.relations.update(
      this.config.schools,
      this.config.relations
    );
    this._isolateChambers();
    this._clearAccumulators();
    this.hash.build(this.positions, this.alive, this.count);
    this._pairPasses(false);
    for (let index = 0; index < this.count; index += 1) {
      this._steerFish(index, dt, false);
    }
    for (let index = 0; index < this.count; index += 1) {
      this._integrate(index, dt);
    }
    this.updateMesh();
  }

  step(dt) {
    const start = performance.now();
    if (this.locomotionPreview) {
      this._advanceLocomotionPreview(dt);
    } else {
      this._advance(dt);
    }
    const frameMs = performance.now() - start;
    this.metricsState.frameMs = approach(
      this.metricsState.frameMs,
      frameMs,
      4,
      dt
    );
    this.metricsState.fps =
      this.metricsState.frameMs > 0
        ? Math.min(999, 1000 / this.metricsState.frameMs)
        : 0;
    if (!this.locomotionPreview) this.captureVfx?.step(dt);
  }

  updateMesh() {
    if (!this.mesh) return;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const rollQuaternion = new THREE.Quaternion();
    const corpseTint = new THREE.Color();
    const scale = new THREE.Vector3();
    const direction = new THREE.Vector3();
    for (let index = 0; index < this.count; index += 1) {
      const offset = index * 3;
      position.set(
        this.positions[offset],
        this.positions[offset + 1],
        this.positions[offset + 2]
      );
      if (index === this.hiddenFish) {
        scale.setScalar(0);
        quaternion.identity();
      } else if (!this.alive[index]) {
        // Corpse: keep the fish model, belly up, grey.
        if (this.corpse[index]) {
          const schoolIndex = this.schoolIds[index];
          const school = this.config.schools[schoolIndex];
          // Body size with the same visual scaling, so size does not jump at death.
          scale.setScalar(visualSizeOf(school.size, school.id));
          const fade = Math.max(
            0.01,
            this.config.ecology.corpseFadeTime ?? 1.6
          );
          const t = clamp(this.corpseAge[index] / fade, 0, 1);
          // Roll gradually from the heading at death to belly up.
          direction
            .set(
              this.prevHeadings[offset],
              this.prevHeadings[offset + 1],
              this.prevHeadings[offset + 2]
            )
            .normalize();
          if (direction.lengthSq() <= EPSILON) direction.copy(FORWARD);
          quaternion.setFromUnitVectors(FORWARD, direction);
          rollQuaternion.setFromAxisAngle(FORWARD, Math.PI * t);
          quaternion.multiply(rollQuaternion);
          // Color fades from the school color to grey.
          if (this.mesh.instanceColor) {
            corpseTint
              .copy(this.schoolColors[schoolIndex])
              .lerp(this.corpseColor, t);
            this.mesh.setColorAt(index, corpseTint);
            this._instanceColorDirty = true;
          }
        } else {
          scale.setScalar(0);
          quaternion.identity();
        }
      } else {
        const school = this.config.schools[this.schoolIds[index]];
        // Rules use school.size; rendering uses visualSizeOf.
        scale.setScalar(visualSizeOf(school.size, school.id));
        // Stamina brightness follows survival time = energy / metabolic rate.
        // In the preview energy stays full, so it shows how long the trait
        // choice lasts; while running it shows how long the fish has left.
        // Burst cost is excluded, otherwise brightness would flicker.
        if (this.mesh.instanceColor && STAMINA_TINT_STRENGTH !== 0) {
          const drain = metabolicRate(this.config, school, false);
          const seconds =
            drain > EPSILON ? this.energy[index] / drain : Infinity;
          const factor = staminaTintFactor(seconds);
          if (Math.abs(factor - this.tintFactors[index]) > 0.004) {
            this.tintFactors[index] = factor;
            corpseTint
              .copy(this.schoolColors[this.schoolIds[index]])
              .multiplyScalar(factor);
            this.mesh.setColorAt(index, corpseTint);
            this._instanceColorDirty = true;
          }
        }
        direction
          .set(
            this.velocities[offset],
            this.velocities[offset + 1],
            this.velocities[offset + 2]
          )
          .normalize();
        if (direction.lengthSq() <= EPSILON) direction.copy(FORWARD);
        // Banking: the turn rate is estimated from the cross product of last and
        // current heading; its vertical component gives the turn direction.
        const visual = this.config.visual;
        const px = this.prevHeadings[offset];
        const py = this.prevHeadings[offset + 1];
        const pz = this.prevHeadings[offset + 2];
        let targetRoll = 0;
        if (px !== 0 || py !== 0 || pz !== 0) {
          const yawRate = pz * direction.x - px * direction.z;
          const maxRoll = (visual.maxRollDegrees * Math.PI) / 180;
          targetRoll = clamp(yawRate * visual.bankingGain, -maxRoll, maxRoll);
        }
        this.rollAngles[index] +=
          (targetRoll - this.rollAngles[index]) * visual.bankingSmoothing;
        this.prevHeadings[offset] = direction.x;
        this.prevHeadings[offset + 1] = direction.y;
        this.prevHeadings[offset + 2] = direction.z;
        quaternion.setFromUnitVectors(FORWARD, direction);
        if (Math.abs(this.rollAngles[index]) > 1e-4) {
          rollQuaternion.setFromAxisAngle(FORWARD, this.rollAngles[index]);
          quaternion.multiply(rollQuaternion);
        }
      }
      matrix.compose(position, quaternion, scale);
      this.mesh.setMatrixAt(index, matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this._instanceColorDirty && this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
      this._instanceColorDirty = false;
    }
  }

  averageNeighbors(schoolIndex) {
    const range = this.schoolRanges[schoolIndex];
    let total = 0;
    let count = 0;
    for (let index = range.start; index < range.end; index += 1) {
      if (!this.alive[index]) continue;
      total += this.sameNeighbors[index];
      count += 1;
    }
    return count > 0 ? total / count : 0;
  }

  averageEnergy(schoolIndex) {
    const range = this.schoolRanges[schoolIndex];
    let total = 0;
    let count = 0;
    for (let index = range.start; index < range.end; index += 1) {
      if (!this.alive[index]) continue;
      total +=
        this.energy[index] /
        Math.max(
          EPSILON,
          energyCapacityFor(this.config, this.config.schools[schoolIndex])
        );
      count += 1;
    }
    return count > 0 ? total / count : 0;
  }

  aliveCount(schoolIndex) {
    return this._activeSchoolCount(schoolIndex);
  }

  fish(index) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.count
    ) {
      return null;
    }
    const offset = index * 3;
    return {
      index,
      alive: Boolean(this.alive[index]),
      schoolIndex: this.schoolIds[index],
      school: this.config.schools[this.schoolIds[index]],
      position: [
        this.positions[offset],
        this.positions[offset + 1],
        this.positions[offset + 2],
      ],
      velocity: [
        this.velocities[offset],
        this.velocities[offset + 1],
        this.velocities[offset + 2],
      ],
      panic: this.panic[index],
      energy: this.energy[index],
      locomotionState: LOCOMOTION_LABEL[this.locomotionStates[index]],
    };
  }

  nearestAliveSameSchool(index) {
    const source = this.fish(index);
    if (!source) return -1;
    let result = -1;
    let distance2 = Infinity;
    const range = this.schoolRanges[source.schoolIndex];
    for (let other = range.start; other < range.end; other += 1) {
      if (other === index || !this.alive[other]) continue;
      const offset = other * 3;
      const dx = this.positions[offset] - source.position[0];
      const dy = this.positions[offset + 1] - source.position[1];
      const dz = this.positions[offset + 2] - source.position[2];
      const candidate = dx * dx + dy * dy + dz * dz;
      if (candidate < distance2) {
        result = other;
        distance2 = candidate;
      }
    }
    return result;
  }

  setHiddenFish(index = -1) {
    this.hiddenFish = index;
    this.updateMesh();
  }

  metrics() {
    const predatorPairs = [];
    for (let actor = 0; actor < this.config.schools.length; actor += 1) {
      for (let target = 0; target < this.config.schools.length; target += 1) {
        if (this.relationMatrix[actor][target] !== 'pursuit') continue;
        const actorSchool = this.config.schools[actor];
        const targetSchool = this.config.schools[target];
        const telemetry = this._telemetryFor(actor, target);
        const radius = captureRadius(
          this.config,
          actorSchool,
          targetSchool
        );
        const pursuitSpeed = effectiveMaxSpeed(
          this.config,
          actorSchool,
          'burst'
        );
        const evadeSpeed = effectiveMaxSpeed(
          this.config,
          targetSchool,
          'evade'
        );
        const closingSpeed = pursuitSpeed - evadeSpeed;
        predatorPairs.push({
          actor: actorSchool.id,
          target: targetSchool.id,
          captureRadius: radius,
          pursuitSpeed,
          evadeSpeed,
          closingSpeed,
          nominalClosureSeconds:
            closingSpeed > EPSILON
              ? Math.max(
                  0,
                  this.derived.schools[actor].detectionLength - radius
                ) / closingSpeed
              : Infinity,
          chaseStarts: telemetry.starts,
          pursuitFrames: telemetry.pursuitFrames,
          activeChases: telemetry.active,
          captures: telemetry.captures,
          abandoned: telemetry.abandoned,
          conversion:
            telemetry.starts > 0
              ? telemetry.captures / telemetry.starts
              : 0,
          averageChaseSeconds:
            telemetry.captures + telemetry.abandoned > 0
              ? telemetry.completedDuration /
                (telemetry.captures + telemetry.abandoned)
              : 0,
          averageCaptureChaseSeconds:
            telemetry.captures > 0
              ? telemetry.capturedDuration / telemetry.captures
              : 0,
          burstSeconds: telemetry.burstSeconds,
        });
      }
    }
    const ecologyWinner =
      this.ecologyStatus.winnerIndex === null
        ? null
        : this.config.schools[this.ecologyStatus.winnerIndex];
    const warnings = [];
    if (
      this.config.locomotion.burstFactor <=
      this.config.locomotion.panicSpeedFactor
    ) {
      warnings.push('burstFactor ≤ panicSpeedFactor');
    }
    if (predatorPairs.some((pair) => pair.closingSpeed <= 0)) {
      warnings.push('At least one predator pair has a nominal closing speed ≤ 0');
    }
    return {
      seed: this.seed,
      elapsed: this.elapsed,
      // Which branch the simulation runs. true = _advanceLocomotionPreview
      // (motion only; predation, ecology and time are skipped). Check this
      // first when fish swim but nothing happens: earlier, without it, an
      // elapsed stuck at 0 was misread as elapsed not being simulation time.
      locomotionPreview: this.locomotionPreview,
      project: this.config.runtime.project,
      mode: this.config.runtime.mode,
      population: this.config.schools.map((school, index) => ({
        id: school.id,
        name: school.name,
        color: school.color,
        size: school.size,
        alive: this.aliveCount(index),
        target: this.derived.schools[index].count,
        neighborRadius: this.derived.schools[index].neighborRadius,
        separationRadius:
          this.derived.schools[index].separationRadius,
        alignmentRadius:
          this.derived.schools[index].alignmentRadius,
        cohesionRadius:
          this.derived.schools[index].cohesionRadius,
        detectionLength: this.derived.schools[index].detectionLength,
        panicRadius: this.derived.schools[index].panicRadius,
        burstRadius:
          this.derived.schools[index].detectionLength *
          this.config.relations.burstRadiusFactor,
        measuredNeighbors: this.averageNeighbors(index),
        averageEnergy: this.averageEnergy(index),
        deaths: { ...this.deathCounts[index] },
      })),
      relationMatrix: this.relationMatrix,
      pairCount: this.metricsState.pairCount,
      captures: this.metricsState.captures,
      captureParticles: this.captureVfx?.particles.length ?? 0,
      simulationMs: this.metricsState.frameMs,
      simulationFps: this.metricsState.fps,
      renderFps: this.metricsState.renderFps ?? 0,
      predatorPairs,
      ecology: {
        state: this.ecologyStatus.state,
        winnerId: ecologyWinner?.id ?? null,
        winnerName: ecologyWinner?.name ?? null,
        plankton: {
          // Field names are historical: level = starvation corpses currently
          // shown, consumed = plankton bites eaten so far.
          level: this.captureVfx?.starvationCount?.() ?? 0,
          capacity: 0,
          fraction: 0,
          consumed: this.planktonConsumed,
        },
        deaths: this.deathCounts.map((entry, schoolIndex) => ({
          schoolId: this.config.schools[schoolIndex].id,
          ...entry,
        })),
      },
      tankVolume: tankVolume(this.config.tank),
      warnings,
    };
  }
}
