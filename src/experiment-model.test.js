import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SeededRng,
  SpatialHash3D,
  captureRadius,
  deriveExperiment,
  ecologyOutcome,
  effectiveMaxSpeed,
  effectiveTurnSpeed,
  metabolicRate,
  planktonIntake,
  relationBetween,
  relationForRatio,
  sustainedSpeedScale,
  visualLength,
} from './experiment-model.js';
import { createDefaultConfig } from './experiment-config.js';

test('radii computed from target neighbors follow the aquarium density', () => {
  const config = createDefaultConfig();
  assert.deepEqual(
    [config.tank.width, config.tank.height, config.tank.depth],
    [6, 3.6, 2.4]
  );
  config.perception.radiusMode = 'neighbors';
  const derived = deriveExperiment(config);
  assert.ok(Math.abs(derived.schools[0].neighborRadius - 0.628) < 0.002);
  assert.ok(Math.abs(derived.schools[1].neighborRadius - 0.791) < 0.002);
  // The large school uses count 80 / targetNeighbors 5. With n=2 its
  // cohesionRadius (0.853) was below the mean spacing at random spawn (1.090),
  // so it could not sense any schoolmate from the first frame.
  assert.ok(Math.abs(derived.schools[2].neighborRadius - 0.918) < 0.002);
  // detectionLengthFactor is aligned to classic boids (~0.511 of neighbor radius).
  assert.ok(Math.abs(derived.schools[0].detectionLength - 0.3208) < 0.002);
  assert.ok(Math.abs(derived.schools[1].detectionLength - 0.4042) < 0.002);
  assert.ok(Math.abs(derived.schools[2].detectionLength - 0.4691) < 0.002);
  assert.equal(
    derived.schools[0].panicRadius,
    derived.schools[0].detectionLength
  );
});

test('set radii are the defaults and equal what target neighbors gives', () => {
  const config = createDefaultConfig();
  assert.equal(config.perception.radiusMode, 'fixed');
  const set = deriveExperiment(config).schools;
  config.perception.radiusMode = 'neighbors';
  const computed = deriveExperiment(config).schools;
  for (let index = 0; index < set.length; index += 1) {
    const school = config.schools[index];
    assert.equal(set[index].separationRadius, school.separationRadius);
    assert.equal(set[index].alignmentRadius, school.alignmentRadius);
    assert.equal(set[index].cohesionRadius, school.cohesionRadius);
    // Switching the default must not have changed any school's behavior.
    assert.ok(Math.abs(set[index].cohesionRadius - computed[index].cohesionRadius) < 0.001);
  }
});

test('in target-neighbors mode only the cohesion radius is computed', () => {
  const config = createDefaultConfig();
  config.perception.radiusMode = 'neighbors';
  config.schools[0].count = 800;
  const derived = deriveExperiment(config).schools[0];
  assert.ok(derived.cohesionRadius < 0.6, 'more fish, shorter reach');
  assert.equal(derived.separationRadius, config.schools[0].separationRadius);
  assert.equal(derived.alignmentRadius, config.schools[0].alignmentRadius);
});

test('the hash cell fits a radius set wider than the cohesion radius', () => {
  const config = createDefaultConfig();
  config.schools[0].alignmentRadius = 1.6;
  assert.ok(deriveExperiment(config).cellSize >= 1.6);
});

test('visual-length lower bound prevents dense configurations from tunneling', () => {
  const config = createDefaultConfig();
  config.perception.radiusMode = 'neighbors';
  config.schools[0].count = 20000;
  config.schools[0].targetNeighbors = 1;
  const derived = deriveExperiment(config).schools[0];
  assert.equal(
    derived.neighborRadius,
    config.perception.minNeighborRadiusFactor *
      visualLength(config.schools[0].size, config.visual)
  );
});

test('spatial hash finds adjacent-cell neighbors and emits each pair once', () => {
  const positions = new Float32Array([
    0.99, 0, 0,
    1.01, 0, 0,
    1.8, 0, 0,
  ]);
  const alive = new Uint8Array([1, 1, 1]);
  const hash = new SpatialHash3D(1).build(positions, alive);
  const pairs = [];
  hash.forEachPair((a, b) => pairs.push(`${a}-${b}`));
  assert.deepEqual(pairs.sort(), ['0-1', '0-2', '1-2']);
  assert.equal(new Set(pairs).size, pairs.length);

  const symmetric = new Float64Array(3);
  hash.forEachPair((a, b) => {
    symmetric[a] -= 1;
    symmetric[b] += 1;
  });
  assert.equal(
    symmetric.reduce((sum, value) => sum + value, 0),
    0
  );
});

test('the grid and the map hand back exactly the same pairs', () => {
  // The map is the fallback for inputs the grid cannot take, so the two have
  // to agree. Random positions across several cells, including negative
  // coordinates, which is where an off-by-one in the grid origin would show.
  let seed = 20260923;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const fish = 240;
  const positions = new Float32Array(fish * 3);
  const alive = new Uint8Array(fish);
  for (let index = 0; index < fish; index += 1) {
    const offset = index * 3;
    positions[offset] = random() * 6 - 3;
    positions[offset + 1] = random() * 4 - 2;
    positions[offset + 2] = random() * 5 - 2.5;
    alive[index] = random() < 0.85 ? 1 : 0;
  }

  const collect = (hash) => {
    const pairs = [];
    hash.forEachPair((a, b) => pairs.push(`${a}-${b}`));
    const candidates = [];
    for (const index of [0, 7, 100, fish - 1]) {
      const seen = [];
      hash.forEachCandidate(index, (other) => seen.push(other));
      candidates.push(seen.join(','));
    }
    return { pairs, candidates };
  };

  for (const cellSize of [0.3, 0.9, 2.5]) {
    const grid = new SpatialHash3D(cellSize).build(positions, alive, fish);
    const map = new SpatialHash3D(cellSize);
    map._buildMap(positions, alive, fish);
    const fromGrid = collect(grid);
    const fromMap = collect(map);
    assert.ok(grid._grid, `cell size ${cellSize} should use the grid`);
    assert.ok(fromGrid.pairs.length > 0);
    // Same pairs, in the same order: the order neighbours arrive in decides
    // the order forces are summed, and float addition is not associative.
    assert.deepEqual(fromGrid.pairs, fromMap.pairs, `pairs at cell size ${cellSize}`);
    assert.deepEqual(
      fromGrid.candidates,
      fromMap.candidates,
      `candidates at cell size ${cellSize}`
    );
  }
});

test('the grid steps aside for positions it cannot file', () => {
  // A grid needs a box, and a position that is not a number has no cell to put
  // it in, so that build falls back to the map rather than guessing a bound.
  // The fish that do have positions still find each other; the one that does
  // not is near nothing, which is what the map did before the grid existed.
  const positions = new Float32Array([0.1, 0, 0, 0.2, 0, 0, Number.NaN, 0, 0]);
  const alive = new Uint8Array([1, 1, 1]);
  const hash = new SpatialHash3D(1).build(positions, alive, 3);
  assert.equal(hash._grid, false, 'a position that is not finite has no cell');
  const pairs = [];
  hash.forEachPair((a, b) => pairs.push(`${a}-${b}`));
  assert.deepEqual(pairs, ['0-1']);
});

test('an empty tank and a tank of one fish are both fine', () => {
  const positions = new Float32Array([1.5, -2.5, 0.5]);
  const empty = new SpatialHash3D(1).build(positions, new Uint8Array([0]), 1);
  const pairs = [];
  empty.forEachPair((a, b) => pairs.push(`${a}-${b}`));
  empty.forEachCandidate(0, () => pairs.push('candidate'));
  assert.deepEqual(pairs, []);

  const alone = new SpatialHash3D(1).build(positions, new Uint8Array([1]), 1);
  alone.forEachPair((a, b) => pairs.push(`${a}-${b}`));
  alone.forEachCandidate(0, (other) => pairs.push(`${other}`));
  assert.deepEqual(pairs, []);
});

test('main project derives predator and prey roles from live body size', () => {
  const config = createDefaultConfig();
  const [small, medium, large] = config.schools;
  assert.equal(relationBetween(medium, small, config.relations), 'pursuit');
  assert.equal(relationBetween(large, medium, config.relations), 'pursuit');
  // KMax = 2.5 puts large/small = 2.25 inside the prey size window, so the
  // large school also hunts the small one. With KMax = 1.667 it was outside,
  // the large school had only the medium school to eat, and it starved.
  assert.equal(relationBetween(large, small, config.relations), 'pursuit');
  assert.equal(relationBetween(small, large, config.relations), 'evade');
  assert.equal(relationBetween(small, small, config.relations), 'peer');

  small.size = 3.2;
  assert.equal(relationBetween(small, large, config.relations), 'pursuit');
  assert.equal(relationBetween(large, small, config.relations), 'evade');
  assert.equal(
    relationForRatio(1.3, config.relations, 'pursuit'),
    'pursuit'
  );
  assert.equal(
    relationForRatio(1.2, config.relations, 'pursuit'),
    'peer'
  );
});

test('burst, panic speed and visual capture distance are derived', () => {
  const config = createDefaultConfig();
  const [small, medium] = config.schools;
  // Trait coupling scales the sustained top speed by body size; burst and
  // panic multiply that scaled speed.
  assert.equal(
    effectiveMaxSpeed(config, medium, 'pursuit'),
    medium.maxSpeed *
      sustainedSpeedScale(config, medium) *
      config.locomotion.burstFactor
  );
  assert.equal(
    effectiveMaxSpeed(config, small, 'evade'),
    small.maxSpeed *
      sustainedSpeedScale(config, small) *
      config.locomotion.panicSpeedFactor
  );
  assert.equal(
    captureRadius(config, medium, small),
    config.capture.captureLengthFactor *
      (visualLength(medium.size, config.visual) +
        visualLength(small.size, config.visual))
  );
});

test('seeded RNG is reproducible without importing the rendering engine', () => {
  const rngA = new SeededRng(44);
  const rngB = new SeededRng(44);
  assert.deepEqual(
    Array.from({ length: 20 }, () => rngA.next()),
    Array.from({ length: 20 }, () => rngB.next())
  );
});

test('ecology helpers implement logistic food, size-scaled drain and terminal outcomes', () => {
  const config = createDefaultConfig();
  const smallRate = metabolicRate(config, config.schools[0]);
  const largeRate = metabolicRate(config, config.schools[2]);
  // Direction deliberately flipped. Earlier this asserted largeRate < smallRate
  // citing Kleiber, but Kleiber lowers energy use per unit mass while absolute
  // use still rises. Dividing by size made large fish more starvation-resistant,
  // refunding on the output side the stamina cost the trait model charges on the
  // input side (larger body -> lower stamina). Multiplying keeps them consistent.
  assert.ok(largeRate > smallRate, 'larger body size means higher absolute metabolism');
  assert.deepEqual(ecologyOutcome([3, 0, 0]), {
    state: 'winner',
    winnerIndex: 0,
  });
  assert.deepEqual(ecologyOutcome([0, 0, 0]), {
    state: 'collapse',
    winnerIndex: null,
  });
  assert.equal(ecologyOutcome([3, 2, 0]).state, 'running');
});

test('plankton half saturation reduces intake only when stock is scarce', () => {
  assert.equal(
    planktonIntake({
      available: 10,
      maxIntake: 2,
      halfSaturation: 0,
    }),
    2
  );
  assert.equal(
    planktonIntake({
      available: 10,
      maxIntake: 2,
      halfSaturation: 10,
    }),
    1
  );
  const scarce = planktonIntake({
    available: 0.25,
    maxIntake: 2,
    halfSaturation: 10,
  });
  assert.ok(scarce > 0);
  assert.ok(scarce < 0.25);
});

test('school metabolism multiplier scales basal and burst drain together', () => {
  const config = createDefaultConfig();
  const school = config.schools[1];
  const basal = metabolicRate(config, school);
  const burst = metabolicRate(config, school, true);
  school.metabolismMultiplier = 1.75;
  assert.ok(
    Math.abs(metabolicRate(config, school) - basal * 1.75) < 1e-12
  );
  assert.ok(
    Math.abs(metabolicRate(config, school, true) - burst * 1.75) <
      1e-12
  );
});
test('trait coupling penalizes sustained speed and turning while preserving burst state', () => {
  const config = createDefaultConfig();
  config.traits.enabled = true;
  const small = config.schools[0];
  const large = config.schools[2];
  assert.ok(
    effectiveMaxSpeed(config, large, 'cruise') <
      effectiveMaxSpeed(config, small, 'cruise')
  );
  assert.ok(
    effectiveTurnSpeed(config, large) <
      effectiveTurnSpeed(config, small)
  );
  assert.ok(
    effectiveMaxSpeed(config, large, 'burst') >
      effectiveMaxSpeed(config, large, 'cruise')
  );
});
