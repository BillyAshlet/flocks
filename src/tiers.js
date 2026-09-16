/**
 * Research tiers.
 *
 * Each tier adds one layer of rules on top of the tier before it. A tier is
 * a pure function from the default configuration to that tier's
 * configuration, plus the parameters the panel exposes at that tier.
 *
 * A tier switches off the systems it has not reached yet (ecology,
 * predation, panic). The finer mechanisms in withoutDetails stay off until
 * tier 6, where each has its own switch.
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

// Finer mechanisms that arrive only in the final tier, where each has its
// own switch: emergency alignment (with its gains), the scatter latch, the
// last-ditch sprint and its debt.
function withoutDetails(config) {
  config.relations.emergencyAlignment = false;
  config.relations.scatterLatch = false;
  config.ecology.desperation = false;
  config.ecology.desperationDebt = false;
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
  'locomotion.avoidance*',
  'locomotion.recenter*',
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
// Body size slows sustained speed and turning; arrives with species.
const TRAITS = ['traits.*'];
const ECOLOGY = ['ecology.*', 'plankton.*'];
// Parameters of withoutDetails' mechanisms; hidden until tier 6.
const DETAILS = [
  'relations.emergencyAlignment*',
  'relations.alignmentSource*',
  'relations.alignmentReceiver*',
  'relations.signalRadiusFactor',
  'relations.scatterLatch',
  'relations.panicScatter*',
  'ecology.desperation*',
  'ecology.debtSettleSeconds',
];

const REYNOLDS_FIELDS = [
  'count',
  'separationWeight',
  'alignmentWeight',
  'cohesionWeight',
  'targetNeighbors',
];
const SPECIES_FIELDS = ['name', 'color', 'size', 'cruiseSpeed', 'maxSpeed', 'turnSpeed'];
const ENERGY_FIELDS = ['grazeRate', 'metabolismMultiplier'];

// Visualization layers (see school-visualizer.js) arrive with the rules they
// draw.
const REYNOLDS_VISUALS = ['reynolds', 'walls'];
const PREDATION_VISUALS = [...REYNOLDS_VISUALS, 'hunting'];
const PANIC_VISUALS = [...PREDATION_VISUALS, 'fieldOfView', 'panic'];

export const TIERS = [
  {
    number: 1,
    title: 'Reynolds flocking',
    summary: 'Placeholder: why this tier exists.',
    configure(config) {
      keepSchools(config, ['gold']);
      withoutFieldOfView(config);
      withoutEcology(config);
      withoutPredation(config);
    },
    globals: BASICS,
    schoolFields: REYNOLDS_FIELDS,
    visuals: REYNOLDS_VISUALS,
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
    globals: [...BASICS, ...TRAITS],
    schoolFields: [...REYNOLDS_FIELDS, ...SPECIES_FIELDS],
    visuals: REYNOLDS_VISUALS,
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
    globals: [...BASICS, ...TRAITS, ...PREDATION],
    schoolFields: [...REYNOLDS_FIELDS, ...SPECIES_FIELDS],
    visuals: PREDATION_VISUALS,
  },
  {
    number: 4,
    title: 'Panic',
    summary: 'Placeholder: why this tier exists.',
    configure(config) {
      keepSchools(config, ['gold', 'red']);
      withoutEcology(config);
      withoutDetails(config);
    },
    globals: [...BASICS, ...TRAITS, ...PREDATION, ...PANIC],
    hidden: DETAILS,
    schoolFields: [...REYNOLDS_FIELDS, ...SPECIES_FIELDS],
    visuals: PANIC_VISUALS,
  },
  {
    number: 5,
    title: 'Energy and plankton',
    summary: 'Placeholder: why this tier exists.',
    configure(config) {
      withoutDetails(config);
    },
    globals: [...BASICS, ...TRAITS, ...PREDATION, ...PANIC, ...ECOLOGY],
    hidden: DETAILS,
    schoolFields: [...REYNOLDS_FIELDS, ...SPECIES_FIELDS, ...ENERGY_FIELDS],
    visuals: PANIC_VISUALS,
  },
  {
    number: 6,
    title: 'Full ecosystem',
    summary: 'Placeholder: why this tier exists.',
    configure() {},
    // null = no filter: every parameter, and schools can be added or removed.
    globals: null,
    schoolFields: null,
    visuals: null,
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

function visibility(tier) {
  return {
    global: (spec) =>
      (tier.globals === null || matchesPath(tier.globals, spec.path)) &&
      !matchesPath(tier.hidden ?? [], spec.path),
    schoolField: (field) =>
      tier.schoolFields === null || tier.schoolFields.includes(field),
    visual: (layer) => tier.visuals === null || tier.visuals.includes(layer),
  };
}

export function tierPanelScope(number) {
  const tier = tierByNumber(number);
  if (!tier) throw new Error(`Unknown tier: ${number}`);
  const shown = visibility(tier);
  // "New" = shown here but not in the tier before. Tier 1 has nothing to
  // compare against, so nothing is marked there.
  const previous = tierByNumber(number - 1);
  const before = previous ? visibility(previous) : null;
  const isNew = (kind) => (item) =>
    before !== null && shown[kind](item) && !before[kind](item);
  return {
    eyebrow: `TIER ${tier.number}`,
    allowSchoolEditing: tier.allowSchoolEditing ?? false,
    isNewSchoolEditing:
      before !== null &&
      (tier.allowSchoolEditing ?? false) &&
      !(previous.allowSchoolEditing ?? false),
    showGlobal: shown.global,
    showSchoolField: shown.schoolField,
    showVisual: shown.visual,
    isNewGlobal: isNew('global'),
    isNewSchoolField: isNew('schoolField'),
    isNewVisual: isNew('visual'),
  };
}
