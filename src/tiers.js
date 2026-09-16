/**
 * Research tiers.
 *
 * Each tier adds one layer of rules on top of the tier before it. A tier is
 * a pure function from the default configuration to that tier's
 * configuration, plus the parameters the panel exposes at that tier.
 *
 * Provisional: a tier only switches off the systems it has not reached yet
 * (ecology, predation, panic). Every finer detail keeps the engine default
 * for now; which details belong to a tier's core and which only arrive in
 * the final tier is still to be decided.
 */
import { createDefaultConfig } from './experiment-config.js';

export const TIER_COUNT = 6;

function keepSchools(config, ids) {
  config.schools = config.schools.filter((school) => ids.includes(school.id));
}

function withoutEcology(config) {
  config.ecology.enabled = false;
  config.plankton.enabled = false;
}

function withoutPredation(config) {
  config.relations.enabled = false;
}

// Prey ignore predators entirely: no escape force, and the panic latch never
// closes (threat reaches 1 only when a predator overlaps its prey exactly).
function withoutPanic(config) {
  Object.assign(config.relations, {
    evadeWeight: 0,
    evadeLateralWeight: 0,
    directOn: 1,
    signalThreshold: 1,
  });
}

// Reynolds proportions carried over from the boid-aquarium preset
// (2 x 1.2 x 0.8 m tank, 500 fish): about 29 neighbours inside the cohesion
// radius, separation radius 40% and alignment radius 35% of it. This engine
// derives radii from neighbour count and density, so the ratios transfer,
// not the absolute radii.
function aquariumProportions(config) {
  Object.assign(config.perception, {
    separationRadiusFactor: 0.12 / 0.3,
    alignmentRadiusFactor: 0.106 / 0.3,
  });
  for (const school of config.schools) {
    Object.assign(school, {
      targetNeighbors: Math.min(29, school.count - 1),
      separationWeight: 0.55,
      alignmentWeight: 0.45,
      cohesionWeight: 0.4,
    });
  }
}

// 360 degrees = the fish see all around. The forward cone arrives in tier 4,
// together with panic, whose signal travels along it.
function withoutFieldOfView(config) {
  config.perception.fovDegrees = 360;
}

// Panel paths. An entry ending in `*` matches every path with that prefix.
const BASICS = [
  'runtime.timeScale',
  'runtime.seed',
  'runtime.randomizeSeed',
  'runtime.spawnMode',
  'debug.*',
  'locomotion.avoidanceWeight',
  'locomotion.boundaryWeight',
];
const PREDATION = [
  'relations.k',
  'relations.KMax',
  'relations.hysteresis',
  'relations.pursuitWeight',
  'relations.schoolSenseFactor',
  'relations.burstRadiusFactor',
  'relations.burstWeight',
  'relations.giveUpSeconds',
  'relations.targetTieTolerance',
  'capture.*',
  'locomotion.burst*',
  'locomotion.interceptLookAhead',
];
const PANIC = [
  'relations.evade*',
  'relations.panic*',
  'relations.direct*',
  'relations.holdTime',
  'relations.refractoryTime',
  'relations.signal*',
  'relations.emergencyAlignmentWeight',
  'relations.alignmentSource*',
  'relations.alignmentReceiver*',
  'relations.escapePredictionTime',
  'relations.cohesionDrop',
  'locomotion.panicSpeedFactor',
];
const ECOLOGY = ['ecology.*', 'plankton.*'];

const REYNOLDS_FIELDS = [
  'count',
  'separationWeight',
  'alignmentWeight',
  'cohesionWeight',
  'targetNeighbors',
];
const SPECIES_FIELDS = ['name', 'color', 'size', 'cruiseSpeed', 'maxSpeed', 'turnSpeed'];
const ENERGY_FIELDS = ['grazeRate', 'metabolismMultiplier'];

export const TIERS = [
  {
    number: 1,
    title: 'Reynolds flocking',
    summary: 'Placeholder: why this tier exists.',
    configure(config) {
      keepSchools(config, ['gold']);
      aquariumProportions(config);
      withoutFieldOfView(config);
      withoutEcology(config);
      withoutPredation(config);
    },
    globals: BASICS,
    schoolFields: REYNOLDS_FIELDS,
  },
  {
    number: 2,
    title: 'Species',
    summary: 'Placeholder: why this tier exists.',
    configure(config) {
      keepSchools(config, ['gold', 'red']);
      withoutFieldOfView(config);
      withoutEcology(config);
      withoutPredation(config);
    },
    globals: BASICS,
    schoolFields: [...REYNOLDS_FIELDS, ...SPECIES_FIELDS],
  },
  {
    number: 3,
    title: 'Predation',
    summary: 'Placeholder: why this tier exists.',
    configure(config) {
      keepSchools(config, ['gold', 'red']);
      withoutFieldOfView(config);
      withoutEcology(config);
      withoutPanic(config);
    },
    globals: [...BASICS, ...PREDATION],
    schoolFields: [...REYNOLDS_FIELDS, ...SPECIES_FIELDS],
  },
  {
    number: 4,
    title: 'Panic',
    summary: 'Placeholder: why this tier exists.',
    configure(config) {
      keepSchools(config, ['gold', 'red']);
      withoutEcology(config);
    },
    globals: [...BASICS, ...PREDATION, ...PANIC],
    schoolFields: [...REYNOLDS_FIELDS, ...SPECIES_FIELDS],
  },
  {
    number: 5,
    title: 'Energy and plankton',
    summary: 'Placeholder: why this tier exists.',
    configure() {},
    globals: [...BASICS, ...PREDATION, ...PANIC, ...ECOLOGY],
    schoolFields: [...REYNOLDS_FIELDS, ...SPECIES_FIELDS, ...ENERGY_FIELDS],
  },
  {
    number: 6,
    title: 'Full ecosystem',
    summary: 'Placeholder: why this tier exists.',
    configure() {},
    // null = no filter: every parameter, and schools can be added or removed.
    globals: null,
    schoolFields: null,
    allowSchoolEditing: true,
  },
];

export function tierByNumber(number) {
  return TIERS.find((tier) => tier.number === number) ?? null;
}

export function tierConfig(number) {
  const tier = tierByNumber(number);
  if (!tier) throw new Error(`Unknown tier: ${number}`);
  const config = createDefaultConfig();
  tier.configure(config);
  return config;
}

function matchesPath(patterns, path) {
  return patterns.some((pattern) =>
    pattern.endsWith('*')
      ? path.startsWith(pattern.slice(0, -1))
      : path === pattern
  );
}

export function tierPanelScope(number) {
  const tier = tierByNumber(number);
  if (!tier) throw new Error(`Unknown tier: ${number}`);
  return {
    eyebrow: `TIER ${tier.number}`,
    allowSchoolEditing: tier.allowSchoolEditing ?? false,
    showGlobal: (spec) =>
      tier.globals === null || matchesPath(tier.globals, spec.path),
    showSchoolField: (field) =>
      tier.schoolFields === null || tier.schoolFields.includes(field),
  };
}
