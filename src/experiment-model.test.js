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
  visualLength,
} from './experiment-model.js';
import { createDefaultConfig } from './experiment-config.js';

test('default aquarium is doubled and dynamic radii follow its density', () => {
  const config = createDefaultConfig();
  assert.deepEqual(
    [config.tank.width, config.tank.height, config.tank.depth],
    [6, 3.6, 2.4]
  );
  const derived = deriveExperiment(config);
  assert.ok(Math.abs(derived.schools[0].neighborRadius - 0.628) < 0.002);
  assert.ok(Math.abs(derived.schools[1].neighborRadius - 0.791) < 0.002);
  // 大群改为 count 80 / targetNeighbors 5：原来 n=2 算出的 cohesionRadius
  // (0.853) 小于全缸随机出生时的平均间距 (1.090)，它从第一帧就感知不到同伴。
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

test('visual-length lower bound prevents dense configurations from tunneling', () => {
  const config = createDefaultConfig();
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

test('main project derives predator and prey roles from live body size', () => {
  const config = createDefaultConfig();
  const [small, medium, large] = config.schools;
  assert.equal(relationBetween(medium, small, config.relations), 'pursuit');
  assert.equal(relationBetween(large, medium, config.relations), 'pursuit');
  // KMax=1.667 引入后：大/小 = 2.25 超出猎物体型窗口 → 互相忽略。
  // 这正是三层食物链（小←中←大）成立的条件；没有上界时大群会直接
  // 吃小群，中群被绕过。见 tools/ecosystem_search.py
  assert.equal(relationBetween(large, small, config.relations), 'ignore');
  // 关系是对称的：大群吃不到小群，小群自然也不怕它。
  assert.equal(relationBetween(small, large, config.relations), 'ignore');
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
  assert.equal(
    effectiveMaxSpeed(config, medium, 'pursuit'),
    medium.maxSpeed * config.locomotion.burstFactor
  );
  assert.equal(
    effectiveMaxSpeed(config, small, 'evade'),
    small.maxSpeed * config.locomotion.panicSpeedFactor
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
  // 【方向是刻意翻转过的】。原来断言 largeRate < smallRate（大鱼更省），
  // 依据是 Kleiber —— 但 Kleiber 说的是「单位体重」耗能下降，「绝对」耗能
  // 是上升的。按绝对耗能用除法，等于「体型大 → 更耐饿」，和三轴语义
  // （体型大 → 耐力降）正好相反：单形在输入侧收了体型的耐力税，代谢又在
  // 输出侧退了回去。改成乘之后这条耦合才是自洽的。
  // 见 ECOLOGY-DECISIONS.md §1。
  assert.ok(largeRate > smallRate, '体型越大，绝对代谢越高');
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
