// Trait translation for the Web behaviour sandbox.
//
// Keep these values separate from the raw boid parameters: BOID_PARAMS
// remains the ordinary Reynolds model and this module describes how an
// inherited phenotype bends that baseline. Every coefficient is exposed in
// Tweakpane, so these are starting hypotheses rather than hidden rules.

export const TRAITS = {
  speed: 50,
  size: 40,
  stamina: 50,
};

export const TRAIT_MAPPING = {
  speedOctaves: 0.5,
  bodyScaleOctaves: 0.45,
  sizeSpeedPenaltyOctaves: 0.2,
  sizeForcePenaltyOctaves: 0.25,
  sizeTurnPenaltyOctaves: 0.55,

  // Positive exponents grow with body size.
  separationRadiusOctaves: 0.7,
  separationWeightOctaves: 0.6,

  // Negative exponents deliberately make small fish more socially coupled:
  // small fish cluster, large fish claim space and disperse.
  alignmentRadiusOctaves: -0.15,
  alignmentWeightOctaves: -0.2,
  cohesionRadiusOctaves: -0.35,
  cohesionWeightOctaves: -0.65,

  staminaCapacityOctaves: 1.0,
};

export const ENERGY_PARAMS = {
  capacityBase: 1.0,
  drainPerSecond: 0.012,
  basalShare: 0.35,
  speedExponent: 3.0,
  sizeExponent: 2.0,
  tiredStart: 0.55,
  exhaustedAt: 0.15,
  minSpeedFactor: 0.38,
  minAlignmentFactor: 0.35,
  minCohesionFactor: 0.3,
};

export const PANIC_PARAMS = {
  alertRadius: 0.38,
  panicRadius: 0.14,
  directOn: 0.55,
  directOff: 0.25,

  signalRadius: 0.24,
  signalThreshold: 0.35,
  signalDecayTime: 0.35,
  senseTime: 0.12,
  holdTime: 0.5,
  refractoryTime: 1.4,
  riseTime: 0.08,
  fallTime: 0.75,

  alignmentSourceBoost: 10.0,
  alignmentReceiverBoost: 1.5,
  alignmentReceiverMax: 2.5,
  // A separate social steering channel. Unlike ordinary alignment this
  // cannot be averaged away by a large number of calm neighbours.
  emergencyAlignmentWeight: 4.0,
  // Full panic multiplies the normal angular turn budget by
  // (1 + panicTurnBoost).
  panicTurnBoost: 1.2,
  cohesionDrop: 0.6,
  speedBoost: 0.65,
  escapeWeight: 2.4,
  predictionTime: 0.15,
};

export const PREDATOR_PARAMS = {
  enabled: true,
  captureEnabled: true,
  count: 3,
  cruiseSpeed: 0.8,
  maxSpeed: 0.96,
  maxForce: 1.1,
  turnSpeed: 3.8,
  bodyScale: 1.8,
  schoolSenseRadius: 1.0,
  schoolAttractionWeight: 1.6,
  targetPursuitWeight: 0.85,
  targetLockTime: 0.8,
  alarmPredatorRadius: 0.18,
  alarmPredatorWeight: 10.0,
  detectionLength: 0.32,
  avoidanceWeight: 2.4,
  predatorSeparationRadius: 0.18,
  predatorSeparationWeight: 1.1,
  captureRadius: 0.065,
  captureCooldown: 0.7,
  targetLeadTime: 0.12,
};

export const SIM_PARAMS = {
  // Multiplies real wall-clock time into the fixed 1/60 s physics clock.
  // 1 = realtime, 2–3 are the practical demo speeds, 0 freezes physics.
  timeScale: 1,
};

export const TANK_VISUAL_PARAMS = {
  // Soft interior grid lines only help depth and camera orientation.
  // They never affect boid / predator physics.
  gridEnabled: true,
  gridOpacity: 0.28,
  gridDivisions: 4,
};

export const CAPTURE_FX_PARAMS = {
  enabled: true,
  // Fibonacci-sphere debris count is driven by density * shell area.
  // particleCount remains a hard clamp / fallback ceiling.
  particleCount: 8,
  density: 1.0,
  spawnRadius: 0.04,
  spawnInterval: 0.02,
  lifetime: 0.5,
  cubeSize: 0.018,
  // Deep blue so the bite trail still reads on the pale tank.
  cubeColor: '#1e4f8c',
  // Half the previous default so debris hangs near the bite instead of
  // rocketing straight up and reading like UI confetti.
  upwardSpeed: 0.12,
  reverseVelocityFactor: 0.4,
  radialSpeed: 0.18,
  // Predator bite flash: log-time progress, exponential fade back.
  biteFlashDuration: 0.2,
  biteFlashScaleBoost: 0.28,
  biteFlashSaturationBoost: 0.55,
  biteFlashDarken: 0.12,
  // Local brightening shell around the predator at the bite moment.
  // Falloff is linear * exp(-k r/R), stronger near the predator center.
  biteGlowEnabled: true,
  biteGlowColor: '#ffffff',
  biteGlowRadius: 0.28,
  biteGlowDuration: 0.35,
  biteGlowStrength: 0.55,
  biteGlowFalloff: 2.4,
};

export function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

export function traitAxis(value) {
  return clamp01(value / 100) * 2 - 1;
}

export function octaveMultiplier(axis, octaves) {
  return 2 ** (axis * octaves);
}

export function smoothstep01(value) {
  const x = clamp01(value);
  return x * x * (3 - 2 * x);
}

export function smoothRange(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  return smoothstep01((value - edge0) / (edge1 - edge0));
}

export function derivePhenotype(
  base,
  traits = TRAITS,
  mapping = TRAIT_MAPPING,
  energy = ENERGY_PARAMS
) {
  const speedAxis = traitAxis(traits.speed);
  const sizeAxis = traitAxis(traits.size);
  const staminaAxis = traitAxis(traits.stamina);

  const speedMultiplier = octaveMultiplier(speedAxis, mapping.speedOctaves);
  const bodyScale = octaveMultiplier(sizeAxis, mapping.bodyScaleOctaves);
  const sizeSpeedPenalty = octaveMultiplier(
    sizeAxis,
    -mapping.sizeSpeedPenaltyOctaves
  );

  return {
    speedAxis,
    sizeAxis,
    staminaAxis,
    bodyScale,
    cruiseSpeed: base.cruiseSpeed * speedMultiplier * sizeSpeedPenalty,
    maxSpeed: base.maxSpeed * speedMultiplier * sizeSpeedPenalty,
    maxForce:
      base.maxForce *
      octaveMultiplier(sizeAxis, -mapping.sizeForcePenaltyOctaves),
    turnSpeed:
      base.turnSpeed *
      octaveMultiplier(sizeAxis, -mapping.sizeTurnPenaltyOctaves),

    separationRadius:
      base.separationRadius *
      octaveMultiplier(sizeAxis, mapping.separationRadiusOctaves),
    separationWeight:
      base.separationWeight *
      octaveMultiplier(sizeAxis, mapping.separationWeightOctaves),
    alignmentRadius:
      base.alignmentRadius *
      octaveMultiplier(sizeAxis, mapping.alignmentRadiusOctaves),
    alignmentWeight:
      base.alignmentWeight *
      octaveMultiplier(sizeAxis, mapping.alignmentWeightOctaves),
    cohesionRadius:
      base.cohesionRadius *
      octaveMultiplier(sizeAxis, mapping.cohesionRadiusOctaves),
    cohesionWeight:
      base.cohesionWeight *
      octaveMultiplier(sizeAxis, mapping.cohesionWeightOctaves),

    energyCapacity:
      energy.capacityBase *
      octaveMultiplier(staminaAxis, mapping.staminaCapacityOctaves),
    baseCruiseSpeed: base.cruiseSpeed,
  };
}

export function energyResponse(ratio, energy = ENERGY_PARAMS) {
  const q = clamp01(ratio);
  const awake = smoothRange(energy.exhaustedAt, energy.tiredStart, q);
  return {
    ratio: q,
    speed:
      energy.minSpeedFactor + (1 - energy.minSpeedFactor) * awake,
    alignment:
      energy.minAlignmentFactor + (1 - energy.minAlignmentFactor) * awake,
    cohesion:
      energy.minCohesionFactor + (1 - energy.minCohesionFactor) * awake,
  };
}

export function energyDrainPerSecond(
  speed,
  phenotype,
  energy = ENERGY_PARAMS
) {
  const relativeSpeed = Math.max(
    Math.abs(speed) / Math.max(phenotype.baseCruiseSpeed, 1e-6),
    0
  );
  const motionCost =
    energy.basalShare +
    (1 - energy.basalShare) * relativeSpeed ** energy.speedExponent;
  const bodyCost = phenotype.bodyScale ** energy.sizeExponent;
  return energy.drainPerSecond * bodyCost * motionCost;
}

export function threatFromDistance(distance, panic = PANIC_PARAMS) {
  if (!Number.isFinite(distance)) return 0;
  return 1 - smoothRange(panic.panicRadius, panic.alertRadius, distance);
}

export function distanceSignal(distance, radius) {
  if (radius <= 0 || distance >= radius) return 0;
  return 1 - smoothstep01(distance / radius);
}

export function exponentialApproach(current, target, dt, timeConstant) {
  if (timeConstant <= 0) return target;
  return target + (current - target) * Math.exp(-dt / timeConstant);
}
