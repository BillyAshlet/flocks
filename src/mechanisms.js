/**
 * One color per mechanism, shared by everything that shows it: the overlay
 * the tank draws, the panel folder that holds its parameters, and its
 * symbols in the page's formulas. A reader should be able to follow one
 * color from a symbol to a slider to a shape in the tank.
 *
 * Colors stay clear of the species hues (gold, blue, red) so a mechanism is
 * never read as a kind of fish.
 */
export const MECHANISMS = {
  separation: {
    tier: 1,
    color: '#8a5a9c',
    paths: ['schools.*.separationWeight', 'schools.*.separationRadius'],
  },
  alignment: {
    tier: 1,
    color: '#5b8743',
    paths: ['schools.*.alignmentWeight', 'schools.*.alignmentRadius'],
  },
  cohesion: {
    tier: 1,
    color: '#2f6e73',
    paths: [
      'schools.*.cohesionWeight',
      'schools.*.cohesionRadius',
      'schools.*.targetNeighbors',
      'perception.radiusMode',
    ],
  },
  walls: {
    tier: 1,
    color: '#9a6a45',
    paths: ['locomotion.avoidance*', 'locomotion.recenter*'],
  },
  body: {
    tier: 2,
    color: '#5f6b73',
    paths: [
      'traits.*',
      'schools.*.size',
      'schools.*.cruiseSpeed',
      'schools.*.maxSpeed',
      'schools.*.turnSpeed',
    ],
  },
  hunting: {
    tier: 3,
    color: '#8f2d56',
    paths: [
      'relations.k',
      'relations.hysteresis',
      'relations.pursuitWeight',
      'relations.schoolSenseFactor',
      'relations.burstRadiusFactor',
      'relations.burstWeight',
      'relations.giveUpSeconds',
      'relations.targetTieTolerance',
      'perception.detectionLengthFactor',
      'capture.*',
      'locomotion.burst*',
      'locomotion.interceptLookAhead',
    ],
  },
  vision: {
    tier: 4,
    color: '#6f6a68',
    paths: ['perception.fovDegrees'],
  },
  // Listed before alarm and flee: signalRadiusFactor belongs to emergency
  // alignment even though its name reads like the alarm pulse.
  emergency: {
    tier: 6,
    color: '#b0577f',
    paths: [
      'relations.emergencyAlignment*',
      'relations.alignmentSource*',
      'relations.alignmentReceiver*',
      'relations.signalRadiusFactor',
    ],
  },
  scatter: {
    tier: 6,
    color: '#4a6a8a',
    paths: ['relations.scatterLatch', 'relations.panicScatter*'],
  },
  alarm: {
    tier: 4,
    color: '#8a8a2c',
    paths: [
      'relations.signalThreshold',
      'relations.refractoryTime',
      'relations.signalDecayTime',
    ],
  },
  flee: {
    tier: 4,
    color: '#5b4b8a',
    paths: [
      'relations.evade*',
      'relations.panic*',
      'relations.direct*',
      'relations.holdTime',
      'relations.escapePredictionTime',
      'relations.cohesionDrop',
      'locomotion.panicSpeedFactor',
    ],
  },
  foodWeb: {
    tier: 5,
    color: '#8f2d56',
    paths: ['relations.KMax'],
  },
  desperation: {
    tier: 6,
    color: '#8c7a2e',
    paths: ['ecology.desperation*', 'ecology.debtSettleSeconds'],
  },
  plankton: {
    tier: 5,
    color: '#3d8a7a',
    paths: [
      'plankton.*',
      'ecology.planktonEnergy',
      'ecology.graze*',
      'schools.*.grazeRate',
    ],
  },
  energy: {
    tier: 5,
    color: '#7a5c8a',
    paths: ['ecology.*', 'schools.*.metabolismMultiplier'],
  },
};

/** `schools.3.size` and `schools.*.size` name the same parameter. */
export function normalizeParameterPath(path) {
  return path.replace(/^schools\.\d+\./, 'schools.*.');
}

function matches(pattern, path) {
  return pattern.endsWith('*')
    ? path.startsWith(pattern.slice(0, -1))
    : pattern === path;
}

/** The mechanism a parameter belongs to, or null. The first match wins. */
export function mechanismFor(path) {
  const normalized = normalizeParameterPath(path);
  for (const [key, mechanism] of Object.entries(MECHANISMS)) {
    if (mechanism.paths.some((pattern) => matches(pattern, normalized))) {
      return key;
    }
  }
  return null;
}

/** CSS custom properties, one per mechanism: `--mech-separation` etc. */
export function mechanismCssVariables() {
  return Object.fromEntries(
    Object.entries(MECHANISMS).map(([key, { color }]) => [`--mech-${key}`, color])
  );
}
