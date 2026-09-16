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
    paths: ['schools.*.separationWeight', 'perception.separationRadiusFactor'],
  },
  alignment: {
    tier: 1,
    color: '#5b8743',
    paths: ['schools.*.alignmentWeight', 'perception.alignmentRadiusFactor'],
  },
  cohesion: {
    tier: 1,
    color: '#2f6e73',
    paths: ['schools.*.cohesionWeight', 'schools.*.targetNeighbors'],
  },
  walls: {
    tier: 1,
    color: '#9a6a45',
    paths: ['locomotion.avoidance*', 'locomotion.recenter*'],
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

/** The mechanism a parameter belongs to, or null. */
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
