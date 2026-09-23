/**
 * Simulation fingerprint: run a few deterministic scenarios and print the
 * full-precision state.
 *
 *   node tools/fingerprint.mjs              # this repository
 *   node tools/fingerprint.mjs <repo-root>  # any repository with the same engine layout
 *
 * It is a guard for pure refactors: moving code around or swapping data
 * structures must leave the output bit-identical. Any commit that changes
 * behavior on purpose will change the fingerprint, and that is not a
 * regression.
 *
 * -----------------------------------------------------------------------
 *
 *   node tools/fingerprint.mjs --against <other-repo-root>
 *
 * runs this engine and that one side by side, a step at a time, and says
 * where they first part company. Comparing only the end state cannot answer
 * the question that matters, because the school is chaotic: a difference of
 * one bit in the last place grows into a completely different tank within
 * twenty seconds. So a refactor that only changes the ORDER floating-point
 * numbers are added in — merging the two neighbour passes, resizing the grid
 * cell — reads exactly like a broken one, and the plain fingerprint can only
 * say "different", never "different how".
 *
 * Stepping both at once separates the two. Numbers may drift apart from
 * rounding, but the counts cannot: if a refactor still finds every fish the
 * same neighbours, then how many neighbours each fish has, which fish it is
 * chasing and what state it is in stay identical while the positions are only
 * drifting. Those are integers; rounding cannot move them. So:
 *
 *   counts hold for a long time, numbers start apart by ~1e-16   order changed
 *   counts differ in the first steps, or numbers start apart big  behavior changed
 *
 * To compare against another commit, give it a worktree of that commit:
 *
 *   git worktree add /tmp/flocks-base main
 *   node tools/fingerprint.mjs --against /tmp/flocks-base
 *   git worktree remove /tmp/flocks-base
 *
 * Each side loads its own engine AND its own default config, so a changed
 * parameter shows up here too, as it should.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DT = 1 / 30;
const SECONDS = 20;
const STEPS = Math.round(SECONDS / DT);
const SEEDS = [11, 4242];
// Scaled-down populations keep the run fast while exercising every rule.
const COUNTS = { gold: 60, blue: 30, red: 12 };

const SCENARIOS = [
  ['aquarium', () => {}],
  [
    'no-ecology',
    (config) => {
      config.ecology.enabled = false;
      config.plankton.enabled = false;
    },
  ],
  [
    'all-peers',
    (config) => {
      config.ecology.enabled = false;
      config.plankton.enabled = false;
      config.relations.k = 6;
    },
  ],
];

/**
 * Whole numbers: how many neighbours a fish found, which fish it is chasing,
 * whether it is alive, which gait it is in. Re-ordering additions cannot move
 * any of these, so they are what tells a reordering from a real change.
 */
const COUNTED = [
  'alive',
  'corpse',
  'locomotionStates',
  'pursuitTargets',
  'sameNeighbors',
  'alignmentCounts',
  'predationCounts',
];

/** Measured quantities, which rounding may move in the last place. */
const MEASURED = [
  'positions',
  'velocities',
  'energy',
  'panic',
  'cohesionCounts',
  'threatLevel',
];

// A difference this small at the very first step is one or two bits in the
// last place of a float32, which is what a changed order of additions looks
// like. Anything larger is a different calculation, not a different order.
const ROUNDING = 1e-5;
// How long the counts have to agree for a drift to be believable as rounding.
// One simulated second: long enough that a missed neighbour or a mis-sized
// radius would have shown by now, short enough that chaos has not yet moved a
// fish across a radius boundary on its own.
const COUNTS_MUST_HOLD = 30;

async function loadEngine(root) {
  const load = (file) =>
    import(pathToFileURL(path.join(path.resolve(root), 'src', file)).href);
  const [config, simulation, field] = await Promise.all([
    load('experiment-config.js'),
    load('experiment-simulation.js'),
    load('distance-field.js'),
  ]);
  return {
    createDefaultConfig: config.createDefaultConfig,
    ExperimentSimulation: simulation.ExperimentSimulation,
    DistanceField3D: field.DistanceField3D,
  };
}

function build(engine, tweak, seed) {
  const config = engine.createDefaultConfig();
  config.runtime.randomizeSeed = false;
  config.runtime.seed = seed;
  config.captureVfx.enabled = false;
  for (const school of config.schools) {
    if (COUNTS[school.id] === undefined) continue;
    school.count = COUNTS[school.id];
    school.targetNeighbors = Math.min(school.targetNeighbors, school.count - 1);
  }
  tweak(config);
  return new engine.ExperimentSimulation({
    scene: null,
    config,
    distanceField: new engine.DistanceField3D(config),
  });
}

function summarise(sim, name, seed) {
  let alive = 0;
  let energy = 0;
  let px = 0;
  let py = 0;
  let pz = 0;
  let vx = 0;
  let vy = 0;
  let vz = 0;
  for (let i = 0; i < sim.count; i += 1) {
    const o = i * 3;
    px += sim.positions[o];
    py += sim.positions[o + 1];
    pz += sim.positions[o + 2];
    vx += sim.velocities[o];
    vy += sim.velocities[o + 1];
    vz += sim.velocities[o + 2];
    if (!sim.alive[i]) continue;
    alive += 1;
    energy += sim.energy[i];
  }
  const metrics = sim.metrics();
  const counts = metrics.population
    .map((school) => `${school.id}=${school.alive}`)
    .join(' ');
  const captures = metrics.predatorPairs
    .map((pair) => `${pair.actor}>${pair.target}:${pair.captures}`)
    .join(' ');
  console.log(
    `${name} seed=${seed}  alive=${alive}  ${counts}\n` +
      `    captures=${captures}\n` +
      `    corpses=${metrics.ecology.plankton.level} planktonBites=${metrics.ecology.plankton.consumed}\n` +
      `    energy=${energy}\n` +
      `    pos=${px},${py},${pz}\n` +
      `    vel=${vx},${vy},${vz}`
  );
}

/** The first index where two arrays differ, or -1. */
function firstDifference(a, b) {
  if (!a || !b) return a === b ? -1 : 0;
  if (a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return -1;
}

function widestGap(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let worst = 0;
  for (let i = 0; i < a.length; i += 1) {
    const gap = Math.abs(a[i] - b[i]);
    if (gap > worst) worst = gap;
  }
  return worst;
}

/**
 * Both halves of the answer, every step: whether any count differs, and how
 * far the measured values have drifted. The counts used to short-circuit the
 * drift, which reported a run that broke on the first step as "apart by 0".
 */
function compareStep(mine, theirs) {
  let counted = null;
  for (const field of COUNTED) {
    const at = firstDifference(mine[field], theirs[field]);
    if (at >= 0) {
      counted = {
        counted: field,
        fish: at,
        mine: mine[field][at],
        theirs: theirs[field][at],
      };
      break;
    }
  }
  let worst = 0;
  let worstField = null;
  for (const field of MEASURED) {
    const gap = widestGap(mine[field], theirs[field]);
    if (gap > worst) {
      worst = gap;
      worstField = field;
    }
  }
  return { ...counted, gap: worst, field: worstField };
}

async function run(root, otherRoot) {
  const engine = await loadEngine(root);
  const other = otherRoot ? await loadEngine(otherRoot) : null;
  let behaviorChanged = false;
  let anyDifference = false;

  for (const [name, tweak] of SCENARIOS) {
    for (const seed of SEEDS) {
      const sim = build(engine, tweak, seed);
      if (!other) {
        while (sim.elapsed < SECONDS) sim._advance(DT);
        summarise(sim, name, seed);
        continue;
      }

      const mirror = build(other, tweak, seed);
      let countsHeldUntil = STEPS;
      let countsBroke = null;
      let firstGap = 0;
      let firstGapField = null;
      let gapAtEnd = 0;
      for (let step = 1; step <= STEPS; step += 1) {
        sim._advance(DT);
        mirror._advance(DT);
        const result = compareStep(sim, mirror);
        if (result.counted && countsBroke === null) {
          countsBroke = { step, ...result };
          countsHeldUntil = step - 1;
        }
        if (firstGap === 0 && result.gap > 0) {
          firstGap = result.gap;
          firstGapField = result.field;
        }
        gapAtEnd = result.gap;
      }

      const identical = countsBroke === null && firstGap === 0;
      if (!identical) anyDifference = true;
      let verdict;
      if (identical) {
        verdict = 'identical';
      } else if (
        firstGap > ROUNDING ||
        (countsBroke && countsBroke.step <= COUNTS_MUST_HOLD)
      ) {
        verdict = 'BEHAVIOR CHANGED';
        behaviorChanged = true;
      } else {
        verdict = 'order of additions only';
      }

      console.log(`${name} seed=${seed}  ${verdict}`);
      if (identical) continue;
      console.log(
        `    first difference: ${firstGapField ?? 'none'} by ${firstGap}` +
          ` (rounding is at or below ${ROUNDING})`
      );
      console.log(
        countsBroke
          ? `    counts held ${countsHeldUntil} steps, then ${countsBroke.counted}` +
            ` differed on fish ${countsBroke.fish}: ${countsBroke.mine} here,` +
            ` ${countsBroke.theirs} there (step ${countsBroke.step} of ${STEPS})`
          : `    counts identical for all ${STEPS} steps`
      );
      console.log(`    apart by ${gapAtEnd} after ${SECONDS}s of chaos`);
    }
  }

  if (!other) return 0;
  console.log(
    behaviorChanged
      ? '\nSomething is computed differently, not merely in a different order.'
      : anyDifference
        ? '\nEvery difference is consistent with a changed order of additions:\n' +
          'the counts hold, and the numbers start apart by a bit in the last place.'
        : '\nBit-identical.'
  );
  return behaviorChanged ? 1 : 0;
}

const args = process.argv.slice(2);
const againstAt = args.indexOf('--against');
const otherRoot = againstAt >= 0 ? args[againstAt + 1] : null;
if (againstAt >= 0 && !otherRoot) {
  console.error('--against needs a path to another checkout of this repository');
  process.exit(2);
}
const root = args.find((arg, index) => !arg.startsWith('--') && index !== againstAt + 1) ?? '.';
process.exit(await run(root, otherRoot));
