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
  'relations.hysteresis',
  'relations.pursuitWeight',
  'relations.schoolSenseFactor',
  'relations.burstRadiusFactor',
  'perception.detectionLengthFactor',
  'relations.burstWeight',
  'relations.giveUpSeconds',
  'relations.targetTieTolerance',
  'capture.*',
  'locomotion.burst*',
  'locomotion.interceptLookAhead',
];
const PANIC = [
  'perception.fovDegrees',
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
// Panic knobs beyond the core six (vision cone, flee strength, pulse
// threshold, refractory time, rise and decay). They tune how panic feels
// rather than what it is, so they wait for tier 6's finer mechanisms and
// tier 4 stays readable. The mechanisms themselves stay on at their defaults.
const PANIC_FINE = [
  'relations.evadePanicBoost',
  'relations.evadeLateralWeight',
  'relations.directOn',
  'relations.directOff',
  'relations.holdTime',
  'relations.signalDecayTime',
  'relations.escapePredictionTime',
  'relations.cohesionDrop',
  'relations.panicTurnBoost',
  'relations.panicMinTrigger',
  'locomotion.panicSpeedFactor',
];
// Body size slows sustained speed and turning; arrives with species.
const TRAITS = ['traits.*'];
const ECOLOGY = ['ecology.*', 'plankton.*'];
// The prey size window. With only Gold and Red (tiers 3 and 4) it reads as
// a broken switch: KMax at or below k means "no upper edge", so dragging it
// turns hunting on, off, then on again. With three sizes it is what it is
// meant to be: the edge that decides whether the largest fish also eats the
// smallest (a web) or only the middle one (a chain).
const FOOD_WEB = ['relations.KMax'];
// Energy and plankton knobs beyond tier 5's core: living cost, hunting cost,
// what a catch and a plankton bite are worth, how a meal is shared, and how
// fast plankton regrows.
// The rest shape the numbers rather than the idea, so they wait for tier 6,
// like PANIC_FINE. Display-only paths (carcasses, particles) are not listed;
// they stay under Non-research settings.
const ECOLOGY_FINE = [
  'ecology.enabled',
  'ecology.seekHungerRatio',
  'ecology.energyCapacity',
  'ecology.capacitySizeExponent',
  'ecology.initialEnergyRatio',
  'ecology.initialEnergyJitter',
  'ecology.energyShareRadius',
  'ecology.basalSizeExponent',
  'ecology.minBurstEnergyRatio',
  'ecology.burstSizeScaled',
  'ecology.grazeSizeExponent',
  'ecology.grazeHungerRatio',
  'plankton.enabled',
  'plankton.halfSaturationFraction',
  'plankton.forageRadius',
  'plankton.senseRadius',
  'plankton.usesPerParticle',
  'plankton.maxIntakePerFish',
];
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
// Tier 6 unhides everything, about sixty research knobs at once. Its core is
// the switch and main knobs of each mechanism it adds; the rest of what it
// adds is shown folded under More and not marked as new.
const FULL_CORE = [
  'relations.emergencyAlignment',
  'relations.emergencyAlignmentWeight',
  'relations.signalRadiusFactor',
  'relations.scatterLatch',
  'relations.panicScatterEnter',
  'ecology.desperation',
  'ecology.desperationEnterRatio',
  'ecology.desperationSpeedBoost',
  'ecology.desperationDebt',
  'ecology.debtSettleSeconds',
];

const REYNOLDS_FIELDS = [
  'count',
  'separationRadius',
  'alignmentRadius',
  'cohesionRadius',
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
    configure(config) {
      keepSchools(config, ['gold']);
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
    configure(config) {
      keepSchools(config, ['gold', 'red']);
      withoutFieldOfView(config);
      withoutEcology(config);
      withoutPredation(config);
    },
    globals: [...BASICS, ...TRAITS],
    schoolFields: [...REYNOLDS_FIELDS, ...SPECIES_FIELDS],
    // From the second species on, readers can add and remove schools.
    allowSchoolEditing: true,
  },
  {
    number: 3,
    title: 'Predation',
    configure(config) {
      keepSchools(config, ['gold', 'red']);
      withoutFieldOfView(config);
      withoutEcology(config);
      withoutPanic(config);
    },
    globals: [...BASICS, ...TRAITS, ...PREDATION],
    schoolFields: [...REYNOLDS_FIELDS, ...SPECIES_FIELDS],
    allowSchoolEditing: true,
  },
  {
    number: 4,
    title: 'Panic',
    configure(config) {
      keepSchools(config, ['gold', 'red']);
      withoutEcology(config);
      withoutDetails(config);
    },
    globals: [...BASICS, ...TRAITS, ...PREDATION, ...PANIC],
    hidden: [...DETAILS, ...PANIC_FINE],
    schoolFields: [...REYNOLDS_FIELDS, ...SPECIES_FIELDS],
    allowSchoolEditing: true,
  },
  {
    number: 5,
    title: 'Energy and plankton',
    configure(config) {
      withoutDetails(config);
    },
    globals: [...BASICS, ...TRAITS, ...PREDATION, ...PANIC, ...FOOD_WEB, ...ECOLOGY],
    hidden: [...DETAILS, ...PANIC_FINE, ...ECOLOGY_FINE],
    schoolFields: [...REYNOLDS_FIELDS, ...SPECIES_FIELDS, ...ENERGY_FIELDS],
    allowSchoolEditing: true,
  },
  {
    number: 6,
    title: 'Full ecosystem',
    configure() {},
    // null = no filter: every parameter, and schools can be added or removed.
    globals: null,
    schoolFields: null,
    core: FULL_CORE,
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
  // Without a `core` list everything a tier adds is core.
  const isCore = (path) => !tier.core || matchesPath(tier.core, path);
  const isNewGlobal = isNew('global');
  const isNewSchoolField = isNew('schoolField');
  return {
    eyebrow: `TIER ${tier.number}`,
    // Tier 1 has nothing before it, so nothing is "new"; its page introduces
    // every mechanism it shows.
    firstTier: before === null,
    allowSchoolEditing: tier.allowSchoolEditing ?? false,
    isNewSchoolEditing:
      before !== null &&
      (tier.allowSchoolEditing ?? false) &&
      !(previous.allowSchoolEditing ?? false),
    showGlobal: shown.global,
    showSchoolField: shown.schoolField,
    isNewGlobal,
    isNewSchoolField,
    // What the panel marks as new: added here and part of the tier's core.
    isNewCoreGlobal: (spec) => isNewGlobal(spec) && isCore(spec.path),
    isNewCoreSchoolField: (field) =>
      isNewSchoolField(field) && isCore(`schools.${field}`),
    // Added here but not core: folded under More.
    isDetailGlobal: (spec) => isNewGlobal(spec) && !isCore(spec.path),
  };
}
