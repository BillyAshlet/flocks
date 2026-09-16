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
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] ?? '.');
const load = (file) =>
  import(pathToFileURL(path.join(root, 'src', file)).href);

const { createDefaultConfig } = await load('experiment-config.js');
const { ExperimentSimulation } = await load('experiment-simulation.js');
const { DistanceField3D } = await load('distance-field.js');

const DT = 1 / 30;
const SECONDS = 20;
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

for (const [name, tweak] of SCENARIOS) {
  for (const seed of SEEDS) {
    const config = createDefaultConfig();
    config.runtime.randomizeSeed = false;
    config.runtime.seed = seed;
    config.captureVfx.enabled = false;
    for (const school of config.schools) {
      if (COUNTS[school.id] === undefined) continue;
      school.count = COUNTS[school.id];
      school.targetNeighbors = Math.min(school.targetNeighbors, school.count - 1);
    }
    tweak(config);

    const sim = new ExperimentSimulation({
      scene: null,
      config,
      distanceField: new DistanceField3D(config),
    });
    while (sim.elapsed < SECONDS) sim._advance(DT);

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
}
