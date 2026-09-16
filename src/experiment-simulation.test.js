import test from 'node:test';
import { sceneClearance } from './distance-field.js';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createDefaultConfig } from './experiment-config.js';
import {
} from './experiment-model.js';
import { ExperimentSimulation } from './experiment-simulation.js';
import { relationForRatio } from './experiment-model.js';

function smallSimulation(mode = 'steady', seed = 1001, withScene = false) {
  const config = createDefaultConfig();
  config.runtime.mode = mode;
  config.runtime.project = mode === 'ecology' ? 'ecology' : 'aquarium';
  config.runtime.seed = seed;
  config.captureVfx.enabled = withScene;
  config.schools[0].count = 6;
  config.schools[1].count = 4;
  config.schools[2].count = 2;
  config.schools[0].targetNeighbors = 3;
  config.schools[1].targetNeighbors = 2;
  config.schools[2].targetNeighbors = 1;
  if (mode === 'ecology') config.traits.enabled = true;
  const neutralField = {
    query: () => ({ clearance: 1, gradient: [0, 0, 0] }),
    clearance: () => 1,
  };
  return new ExperimentSimulation({
    scene: withScene ? new THREE.Scene() : null,
    config,
    distanceField: neutralField,
    physics: null,
  });
}

function burstRadiusOf(simulation, index) {
  const detection =
    simulation.derived.schools[simulation.schoolIds[index]].detectionLength;
  return detection * simulation.config.relations.burstRadiusFactor;
}

function place(simulation, index, x, y = 0, z = 0) {
  simulation.positions[index * 3] = x;
  simulation.positions[index * 3 + 1] = y;
  simulation.positions[index * 3 + 2] = z;
}

test('headless simulation does not require a THREE.Scene adapter', () => {
  const simulation = smallSimulation();
  const school = simulation.metrics().population[0];
  assert.equal(simulation.mesh, null);
  assert.equal(simulation.captureVfx, null);
  assert.equal(school.cohesionRadius, school.neighborRadius);
  // Classic boids proportions: alignment neighborhood is wider than separation.
  assert.ok(school.separationRadius < school.alignmentRadius);
  assert.ok(school.alignmentRadius < school.cohesionRadius);
  simulation._advance(1 / 60);
  assert.ok(simulation.elapsed > 0);
});

test('locomotion preview moves fish without advancing gameplay state', () => {
  const simulation = smallSimulation('steady', 7342);
  const prey = 0;
  const predator = simulation.schoolRanges[1].start;
  simulation.positions[prey * 3] = 0;
  simulation.positions[prey * 3 + 1] = 0;
  simulation.positions[prey * 3 + 2] = 0;
  simulation.positions[predator * 3] = 0.001;
  simulation.positions[predator * 3 + 1] = 0;
  simulation.positions[predator * 3 + 2] = 0;
  simulation.energy[prey] = 0.0001;

  const before = {
    positions: Array.from(simulation.positions),
    energy: Array.from(simulation.energy),
    alive: Array.from(simulation.alive),
    deaths: structuredClone(simulation.deathCounts),
    planktonLevel: simulation.planktonLevel,
    planktonConsumed: simulation.planktonConsumed,
    captures: simulation.metricsState.captures,
  };

  simulation.setLocomotionPreview(true);
  for (let frame = 0; frame < 120; frame += 1) {
    simulation.step(1 / 60);
  }

  assert.ok(
    simulation.positions.some(
      (value, index) => Math.abs(value - before.positions[index]) > 1e-6
    )
  );
  assert.equal(simulation.elapsed, 0);
  assert.deepEqual(Array.from(simulation.energy), before.energy);
  assert.deepEqual(Array.from(simulation.alive), before.alive);
  assert.deepEqual(simulation.deathCounts, before.deaths);
  assert.equal(simulation.planktonLevel, before.planktonLevel);
  assert.equal(simulation.planktonConsumed, before.planktonConsumed);
  assert.equal(simulation.metricsState.captures, before.captures);
  assert.ok(simulation.panic.every((value) => value === 0));
  assert.ok(simulation.alarm.every((value) => value === 0));
  assert.ok(simulation.pursuitTargets.every((value) => value === -1));
  assert.ok(simulation.locomotionStates.every((value) => value === 0));

  const visiblePositions = Array.from(simulation.positions);
  const visibleVelocities = Array.from(simulation.velocities);
  simulation.beginGameplayFromPreview();
  assert.equal(simulation.locomotionPreview, false);
  assert.deepEqual(Array.from(simulation.positions), visiblePositions);
  assert.deepEqual(Array.from(simulation.velocities), visibleVelocities);
  assert.equal(simulation.elapsed, 0);
  simulation.step(1 / 60);
  assert.ok(simulation.elapsed > 0);
});

test('gameplay start canonicalizes relation hysteresis', () => {
  const simulation = smallSimulation('steady', 9917);
  const actorSchoolIndex = 1;
  const targetSchoolIndex = 0;
  const peerConfig = structuredClone(simulation.config);
  const target = peerConfig.schools[targetSchoolIndex];
  const actor = peerConfig.schools[actorSchoolIndex];
  actor.size =
    target.size *
    (peerConfig.relations.k - peerConfig.relations.hysteresis / 2);

  // The prior pursuit relation keeps the live preview inside hysteresis.
  simulation.setConfig(peerConfig, 'live');
  assert.equal(
    simulation.relationMatrix[actorSchoolIndex][targetSchoolIndex],
    'pursuit'
  );
  simulation.beginGameplayFromPreview();
  assert.equal(
    simulation.relationMatrix[actorSchoolIndex][targetSchoolIndex],
    'peer'
  );
});

test('configuration and runtime expose no replenishment mechanism', () => {
  const config = createDefaultConfig();
  const simulation = smallSimulation('steady');
  const metrics = simulation.metrics();
  assert.equal('respawn' in config, false);
  assert.equal('pendingRespawns' in simulation, false);
  assert.equal('respawned' in metrics, false);
  assert.equal('queuedRespawns' in metrics, false);
});

test('simulation exposes no removed cascade runtime surface', () => {
  const simulation = smallSimulation();
  const metrics = simulation.metrics();
  assert.equal('probe' in simulation, false);
  assert.equal('releaseHolding' in simulation, false);
  assert.equal('runBatch' in simulation, false);
  assert.equal('cascade' in metrics, false);
  assert.equal('released' in metrics, false);
});

test('direct threat is proximity-driven even when pursuit target selection loses', () => {
  const simulation = smallSimulation();
  const prey = 0;
  const predator = simulation.schoolRanges[1].start;
  simulation.positions.fill(0);
  simulation.sameNeighbors[prey] = 5;
  simulation.targetAlignment[predator] = 2;
  simulation.targetDistance2[predator] = 0;
  simulation.pursuitTargets[predator] = -1;
  simulation._directedRelation(
    predator,
    prey,
    0.01,
    0,
    0,
    0.01,
    0.0001
  );
  assert.equal(simulation.pursuitTargets[predator], -1);
  assert.equal(simulation.threatCounts[prey], 1);
});

test('predation uses broad prey cohesion before the smaller burst layer', () => {
  const simulation = smallSimulation();
  const prey = 0;
  const predator = simulation.schoolRanges[1].start;
  const detection =
    simulation.derived.schools[simulation.schoolIds[predator]]
      .detectionLength;
  const burstRadius =
    detection * simulation.config.relations.burstRadiusFactor;
  const distance = (detection + burstRadius) / 2;
  simulation.positions.fill(0);
  simulation.positions[prey * 3] = distance;
  simulation.velocities[predator * 3] = 1;
  simulation._directedRelation(
    predator,
    prey,
    distance,
    0,
    0,
    distance,
    distance * distance
  );
  assert.equal(simulation.predationCounts[predator], 1);
  assert.equal(simulation.pursuitTargets[predator], -1);
});

test('predators outside local hunt radius remain ordinary boids', () => {
  const simulation = smallSimulation();
  simulation.config.locomotion.avoidanceWeight = 0;
  simulation.config.locomotion.wanderWeight = 0;
  // Keep school-sense from reaching across the staged gap; this test isolates
  // the local burst/pursuit layer, not the long-range school approach layer.
  simulation.config.relations.schoolSenseFactor = 1;
  simulation.config.relations.pursuitWeight = 0;
  simulation.config.relations.burstWeight = 0;
  for (const school of simulation.config.schools) {
    school.separationWeight = 0;
    school.alignmentWeight = 0;
    school.cohesionWeight = 0;
  }
  for (let index = 0; index < simulation.count; index += 1) {
    const schoolIndex = simulation.schoolIds[index];
    simulation.positions[index * 3] =
      schoolIndex === 0 ? 1 : schoolIndex === 1 ? -1 : 0;
    simulation.positions[index * 3 + 1] = 0;
    simulation.positions[index * 3 + 2] = 0;
    simulation.velocities[index * 3] = 0;
    simulation.velocities[index * 3 + 1] = 0;
    simulation.velocities[index * 3 + 2] =
      simulation.config.schools[schoolIndex].cruiseSpeed;
  }
  simulation._advance(1 / 60);
  const predator = simulation.schoolRanges[1].start;
  assert.ok(Math.abs(simulation.velocities[predator * 3]) < 1e-8);
  assert.equal(simulation.predationCounts[predator], 0);
  assert.equal(simulation.pursuitTargets[predator], -1);
  assert.equal(simulation.threatCounts[0], 0);
  assert.equal('schoolCenters' in simulation, false);
});

test('burst target prefers the nearest prey', () => {
  const simulation = smallSimulation();
  const forwardPrey = 0;
  const nearerSidePrey = 1;
  const predator = simulation.schoolRanges[1].start;
  simulation.positions.fill(0);
  simulation.velocities.fill(0);
  simulation.velocities[predator * 3] = 1;
  simulation._directedRelation(predator, nearerSidePrey, 0, 0.01, 0, 0.01, 0.0001);
  simulation._directedRelation(predator, forwardPrey, 0.02, 0, 0, 0.02, 0.0004);
  assert.equal(simulation.pursuitTargets[predator], nearerSidePrey);
  assert.equal(simulation.locomotionStates[predator], 0);
  assert.equal('stamina' in simulation, false);
  assert.equal('stamina' in simulation.fish(predator), false);
});

test('within the tie band the better-aligned prey wins', () => {
  const simulation = smallSimulation();
  const forwardPrey = 0;
  const sidePrey = 1;
  const predator = simulation.schoolRanges[1].start;
  simulation.positions.fill(0);
  simulation.velocities.fill(0);
  simulation.velocities[predator * 3] = 1;
  // side prey is 5% nearer: inside the 10% band, so heading decides
  simulation._directedRelation(predator, sidePrey, 0, 0.019, 0, 0.019, 0.019 ** 2);
  simulation._directedRelation(predator, forwardPrey, 0.02, 0, 0, 0.02, 0.02 ** 2);
  assert.equal(simulation.pursuitTargets[predator], forwardPrey);
});

test('a locked target is dropped the moment it leaves burst range', () => {
  const simulation = smallSimulation();
  const prey = 0;
  const predator = simulation.schoolRanges[1].start;
  const radius = burstRadiusOf(simulation, predator);
  simulation.positions.fill(0);
  place(simulation, prey, radius * 0.5);
  simulation.pursuitTargets[predator] = prey;
  simulation._resolveLock(predator, 1 / 60);
  assert.equal(simulation.lockedTargets[predator], prey);

  place(simulation, prey, radius * 1.2);
  simulation.pursuitTargets[predator] = -1;
  simulation._resolveLock(predator, 1 / 60);
  assert.equal(simulation.lockedTargets[predator], -1);
  assert.equal(simulation.pursuitTargets[predator], -1);
});

test('while chasing, only a clearly nearer prey steals the lock', () => {
  const simulation = smallSimulation();
  const current = 0;
  const rival = 1;
  const predator = simulation.schoolRanges[1].start;
  const radius = burstRadiusOf(simulation, predator);
  simulation.positions.fill(0);
  place(simulation, current, radius * 0.6);
  simulation.pursuitTargets[predator] = current;
  simulation._resolveLock(predator, 1 / 60);
  assert.equal(simulation.lockedTargets[predator], current);

  // 5% nearer: inside the tie band, keep chasing the current one
  place(simulation, rival, 0, radius * 0.57);
  simulation.pursuitTargets[predator] = rival;
  simulation._resolveLock(predator, 1 / 60);
  assert.equal(simulation.lockedTargets[predator], current);

  // clearly nearer: switch
  place(simulation, rival, 0, radius * 0.3);
  simulation.pursuitTargets[predator] = rival;
  simulation._resolveLock(predator, 1 / 60);
  assert.equal(simulation.lockedTargets[predator], rival);
});

test('a chase that stops closing in is abandoned and the prey stays excluded until it leaves range', () => {
  const simulation = smallSimulation();
  const prey = 0;
  const predator = simulation.schoolRanges[1].start;
  const radius = burstRadiusOf(simulation, predator);
  const giveUp = simulation.config.relations.giveUpSeconds;
  simulation.positions.fill(0);
  place(simulation, prey, radius * 0.5);
  simulation.pursuitTargets[predator] = prey;
  simulation._resolveLock(predator, 1 / 60);
  assert.equal(simulation.lockedTargets[predator], prey);

  // distance never improves; just inside the window: still chasing
  simulation.pursuitTargets[predator] = prey;
  simulation._resolveLock(predator, giveUp * 0.9);
  assert.equal(simulation.lockedTargets[predator], prey);

  // window exceeded: abandoned and excluded
  simulation.pursuitTargets[predator] = prey;
  simulation._resolveLock(predator, giveUp * 0.2);
  assert.equal(simulation.lockedTargets[predator], -1);
  assert.equal(simulation.excludedTargets[predator], prey);

  // selection skips the excluded prey even though it is the nearest
  simulation.targetAlignment.fill(-Infinity);
  simulation.targetDistance2.fill(Infinity);
  simulation.pursuitTargets.fill(-1);
  simulation.velocities.fill(0);
  simulation.velocities[predator * 3] = 1;
  const d = radius * 0.5;
  simulation._directedRelation(predator, prey, d, 0, 0, d, d * d);
  assert.equal(simulation.pursuitTargets[predator], -1);

  // once it leaves range, the exclusion lifts
  place(simulation, prey, radius * 1.5);
  simulation._resolveLock(predator, 1 / 60);
  assert.equal(simulation.excludedTargets[predator], -1);
});

test('predation mode captures at visual distance and death stays permanent', () => {
  const simulation = smallSimulation('steady', 1001, true);
  const prey = 0;
  const predator = simulation.schoolRanges[1].start;
  simulation.positions.fill(0);
  simulation.pursuitTargets[predator] = prey;
  simulation._capture(1 / 60);
  assert.equal(simulation.alive[prey], 0);
  assert.ok(simulation.captureVfx.particles.length > 0);
  assert.equal('pendingRespawns' in simulation, false);
  simulation.elapsed += 30;
  simulation._capture(30);
  assert.equal(simulation.alive[prey], 0);
});

test('seeded initial simulation state is reproducible', () => {
  const a = smallSimulation('steady', 9981);
  const b = smallSimulation('steady', 9981);
  const c = smallSimulation('steady', 9982);
  assert.deepEqual([...a.positions], [...b.positions]);
  assert.deepEqual([...a.velocities], [...b.velocities]);
  assert.notDeepEqual([...a.positions], [...c.positions]);
});

test('random spawn scatters fish across the tank instead of school clusters', () => {
  const simulation = smallSimulation('steady', 4242);
  // Default production mode is pods; this test isolates pure random scatter.
  simulation.config.runtime.spawnMode = 'random';
  simulation.reset(4242);
  assert.equal(simulation.config.runtime.spawnMode, 'random');
  const halfW = simulation.config.tank.width / 2;
  const xs = [];
  for (let i = 0; i < simulation.count; i += 1) {
    xs.push(simulation.positions[i * 3]);
  }
  const spread = Math.max(...xs) - Math.min(...xs);
  assert.ok(spread > halfW, `expected wide random spread, got ${spread}`);

  const clustered = smallSimulation('steady', 4242);
  clustered.config.runtime.spawnMode = 'cluster';
  clustered.reset(4242);
  const school = clustered.config.schools[0];
  const centerX = school.spawnRegion.centerX * clustered.config.tank.width;
  let maxDist = 0;
  const range = clustered.schoolRanges[0];
  for (let i = range.start; i < range.end; i += 1) {
    const dx = clustered.positions[i * 3] - centerX;
    const dy = clustered.positions[i * 3 + 1];
    const dz = clustered.positions[i * 3 + 2];
    maxDist = Math.max(maxDist, Math.hypot(dx, dy, dz));
  }
  assert.ok(
    maxDist <= school.spawnRegion.radius + 1e-6,
    `cluster spawn escaped radius: ${maxDist}`
  );
});

test('ecology capture restores predator energy', () => {
  const simulation = smallSimulation('ecology');
  const prey = 0;
  const predator = simulation.schoolRanges[1].start;
  simulation.positions.fill(0);
  simulation.energy[predator] = 0.1;
  simulation.pursuitTargets[predator] = prey;
  simulation._updateChaseTelemetry(1 / 60);
  simulation.elapsed = 1;
  simulation._capture(1 / 60);
  assert.equal(simulation.alive[prey], 0);
  assert.ok(simulation.energy[predator] > 0.1);
  const pair = simulation
    .metrics()
    .predatorPairs.find(
      (item) => item.actor === 'blue' && item.target === 'gold'
    );
  assert.equal(pair.captures, 1);
  assert.equal(pair.chaseStarts, 1);
  assert.equal(pair.averageCaptureChaseSeconds, 1);
});

test('ecology starvation is real death and sole survivor is terminal', () => {
  const simulation = smallSimulation('ecology');
  simulation.config.plankton.enabled = false;
  simulation.energy[0] = 0.0001;
  simulation._updateEcology(1);
  assert.equal(simulation.alive[0], 0);
  assert.equal(simulation.deathCounts[0].starved, 1);
  if (simulation.captureVfx) {
    assert.ok(
      simulation.captureVfx.particles.some((p) => p.style === 'starvation')
    );
  }

  for (let schoolIndex = 1; schoolIndex < 3; schoolIndex += 1) {
    const range = simulation.schoolRanges[schoolIndex];
    simulation.alive.fill(0, range.start, range.end);
  }
  simulation._updateEcology(0);
  assert.deepEqual(simulation.ecologyStatus, {
    state: 'winner',
    winnerIndex: 0,
  });
  const elapsed = simulation.elapsed;
  simulation._advance(1);
  assert.equal(simulation.elapsed, elapsed);
});


test('aquarium stamina drains without ecology winner freeze', () => {
  const simulation = smallSimulation('steady');
  simulation.config.ecology.enabled = true;
  simulation.config.plankton.enabled = false;
  simulation.energy[0] = 0.0001;
  simulation._updateEcology(1);
  assert.equal(simulation.alive[0], 0);
  assert.equal(simulation.deathCounts[0].starved, 1);
  for (let schoolIndex = 1; schoolIndex < 3; schoolIndex += 1) {
    const range = simulation.schoolRanges[schoolIndex];
    simulation.alive.fill(0, range.start, range.end);
  }
  simulation._updateEcology(0);
  assert.equal(simulation.ecologyStatus.state, 'running');
  const elapsed = simulation.elapsed;
  simulation._advance(1 / 60);
  assert.ok(simulation.elapsed > elapsed);
});


test('low energy blocks burst sprint', () => {
  const simulation = smallSimulation('steady');
  simulation.config.ecology.enabled = true;
  simulation.config.ecology.minBurstEnergyRatio = 1 / 3;
  const predator = simulation.schoolRanges[1].start;
  const prey = 0;
  simulation.pursuitTargets[predator] = prey;
  simulation.energy[predator] =
    simulation.config.ecology.energyCapacity * 0.2;
  assert.equal(simulation._canBurst(predator), false);
  assert.equal(
    simulation._movementState(predator, prey, false),
    'cruise'
  );
  simulation.energy[predator] =
    simulation.config.ecology.energyCapacity * 0.5;
  assert.equal(simulation._canBurst(predator), true);
  assert.equal(
    simulation._movementState(predator, prey, false),
    'burst'
  );
});


// 【删掉了】「浮尸可以吃」那条测试。浮尸不再是食物：它上浮、被墙夹住、
// carrionRadius 只有 0.08，实际几乎吃不到；而且死鱼喂活鱼是正反馈，
// 一批死完剩下的反而更好活，和「一群一群死」正好相反。
// 浮尸的视觉保留。见 ECOLOGY-DECISIONS.md §2。

test('feeding recovery is amplified and shares 40 percent with living schoolmates', () => {
  const simulation = smallSimulation('steady', 20260725);
  const schoolRange = simulation.schoolRanges[0];
  const eater = schoolRange.start;
  const peer = eater + 1;
  simulation.config.ecology.forageEnergyMultiplier = 2.2;
  // 【三档分配】之后这条测的仍然是「同族池」那一档：把附近那一档关掉，
  // 断言和原来一样 —— 一餐的 40% 进族群池、逐帧按存活数平分。
  simulation.config.ecology.energyShareLocal = 0;
  simulation.config.ecology.energyShareSchool = 0.4;
  simulation.config.ecology.planktonEnergy = 0.06;
  simulation.config.plankton.energyConversion = 1;
  simulation.config.plankton.halfSaturationFraction = 0;
  simulation.config.ecology.grazeHungerRatio = 0.2;
  simulation.config.ecology.basalRate = 0;
  simulation.config.ecology.burstMetabolicRate = 0;
  simulation.config.schools[0].grazeRate = 1;
  simulation.energy.fill(1);
  simulation.energy[eater] = 0.1;
  simulation.energy[peer] = 0.3;
  simulation.rng.next = () => 0;

  const consumedBefore = simulation.planktonConsumed;
  simulation._updateEcology(0.25);

  // 【按实际取到的算】。颗粒是离散的，Holling-II 请求多少和真的取到多少
  // 不一定相等 —— 原来这里假设「一定吃满」，那是在测一个已经不成立的前提。
  // planktonConsumed 的增量就是这条鱼真实吃到的量。
  const intake = simulation.planktonConsumed - consumedBefore;
  assert.ok(intake > 0, '这条鱼应该确实吃到了东西');
  const intakeFraction = intake / simulation.config.plankton.maxIntakePerFish;
  const gain = 0.06 * intakeFraction * 2.2;
  const sharedPerFish =
    (gain * 0.4) / (schoolRange.end - schoolRange.start);
  assert.ok(
    Math.abs(
      simulation.energy[eater] -
        (0.1 + gain * 0.6 + sharedPerFish)
    ) < 1e-6
  );
  assert.ok(
    Math.abs(simulation.energy[peer] - (0.3 + sharedPerFish)) < 1e-6
  );
});

test('吃空的颗粒不是免费食物，而且重生是按时间不按帧', () => {
  const simulation = smallSimulation('steady', 20260726);
  const eater = simulation.schoolRanges[0].start;
  simulation.config.ecology.basalRate = 0;
  simulation.config.ecology.burstMetabolicRate = 0;
  simulation.config.ecology.grazeHungerRatio = 0.2;
  simulation.config.schools[0].grazeRate = 1;
  simulation.energy.fill(1);
  simulation.energy[eater] = 0.1;
  simulation.rng.next = () => 0;

  // 【离散次数】之后「种源线」那个概念没了：吃空就是 0 次，不需要底线。
  // 要守的不变量换成两条 —— 空颗粒喂不了鱼，且重生按【时间】不按帧数。
  const field = simulation.food;
  field.uses.fill(0);
  field.spentAt.fill(0);
  field.now = 0;
  field._dirty = true;
  const consumedBefore = simulation.planktonConsumed;

  // 远小于 regrowSeconds：跑再多帧也不该有东西可吃。
  for (let frame = 0; frame < 120; frame += 1) {
    simulation._updateEcology(1 / 600);
  }
  assert.ok(Math.abs(simulation.energy[eater] - 0.1) < 1e-7);
  assert.equal(simulation.planktonConsumed, consumedBefore);
  assert.equal(field.remainingUses, 0);

  // 跨过重置时间之后整颗回来 —— 而且【帧数无关】：
  // 同样的仿真时长，步长细十倍也应该得到同样的结果。
  const coarse = simulation.food;
  coarse.now = 0;
  for (let frame = 0; frame < 20; frame += 1) {
    coarse.regrow(coarse.regrowSeconds / 10);
  }
  const afterCoarse = coarse.remainingUses;
  coarse.uses.fill(0);
  coarse.spentAt.fill(0);
  coarse.now = 0;
  for (let frame = 0; frame < 200; frame += 1) {
    coarse.regrow(coarse.regrowSeconds / 100);
  }
  assert.equal(coarse.remainingUses, afterCoarse, '重生必须与步长无关');
  assert.ok(afterCoarse > 0, '跨过重置时间之后应该回来了');
});

test('chamber isolation makes two sub-tanks invisible to each other', () => {
  // Bounds alone are not enough: a box stops bodies but not sight. The
  // capture radius is wider than the gap and perception spans the tank, so
  // every cross-chamber relation has to be forced to ignore.
  const config = createDefaultConfig();
  config.runtime.randomizeSeed = false;
  config.runtime.seed = 1001;
  config.ecology.enabled = false;
  config.plankton.enabled = false;
  config.schools = config.schools.filter((school) => school.id !== 'red');
  for (const school of config.schools) {
    school.count = 12;
    school.targetNeighbors = Math.min(school.targetNeighbors, 11);
  }
  const gap = 0.1;
  const half = (config.tank.height - gap) / 2;
  for (const school of config.schools) {
    const top = school.id === 'blue';
    school.chamber = top ? 'top' : 'bottom';
    school.bounds = {
      centerY: (top ? 1 : -1) * ((gap + half) / 2),
      height: half,
    };
  }
  const simulation = new ExperimentSimulation({
    scene: null,
    config,
    distanceField: null,
    physics: null,
  });

  const player = config.schools.findIndex((school) => school.id === 'blue');
  const other = config.schools.findIndex((school) => school.id !== 'blue');
  assert.equal(simulation.relationMatrix[player][other], 'ignore');
  assert.equal(simulation.relationMatrix[other][player], 'ignore');

  const before = config.schools.map((_, index) => simulation.aliveCount(index));
  for (let frame = 0; frame < 60 * 20; frame += 1) simulation._advance(1 / 60);

  // With isolation nobody can eat anybody, and no fish leaves its own box.
  config.schools.forEach((_, index) => {
    assert.equal(simulation.aliveCount(index), before[index]);
  });
  for (let index = 0; index < simulation.count; index += 1) {
    if (!simulation.alive[index]) continue;
    const bounds = simulation._schoolBounds[simulation.schoolIds[index]];
    const y = simulation.positions[index * 3 + 1];
    assert.ok(y >= bounds.center[1] - bounds.half[1] - 1e-6);
    assert.ok(y <= bounds.center[1] + bounds.half[1] + 1e-6);
  }
});

test('predation switch turns every size ratio into peers', () => {
  const relations = { ...createDefaultConfig().relations, enabled: false };
  for (const ratio of [0.4, 0.8, 1, 1.5, 2.25, 4]) {
    assert.equal(relationForRatio(ratio, relations), 'peer');
  }
  assert.equal(
    relationForRatio(1.5, { ...relations, enabled: true }),
    'pursuit'
  );
});

test('with predation switched off a predator touching its prey eats nothing', () => {
  const simulation = smallSimulation('steady', 1001, true);
  simulation.config.relations.enabled = false;
  const prey = 0;
  const predator = simulation.schoolRanges[1].start;
  simulation.positions.fill(0);
  simulation.pursuitTargets[predator] = prey;
  simulation._capture(1 / 60);
  assert.equal(simulation.alive[prey], 1);
});

test('a fish heading at a wall within look-ahead turns away; far from it, nothing', () => {
  const simulation = smallSimulation();
  const config = simulation.config;
  const clearanceAt = (point) => sceneClearance(point, config);
  simulation.distanceField = { clearance: clearanceAt };
  const wallX = config.tank.width / 2 - config.tank.wallMargin;
  const length = config.locomotion.avoidanceLookAhead;

  // 0.1 m from the wall, swimming straight at it.
  const near = [wallX - 0.1, 0, 0];
  const urgency = simulation._lookAhead(0, near, 0.23, 0, 0);
  assert.ok(Math.abs(urgency - (1 - 0.1 / length)) < 0.01);
  // First clear yaw direction points back from the wall, level.
  assert.ok(simulation.avoidanceDirections[0] < 1);
  assert.equal(simulation.avoidanceDirections[1], 0);
  assert.ok(Math.abs(simulation.avoidanceHits[0] - 0.1) < 0.01);

  // 1 m from the wall: nothing within look-ahead.
  assert.equal(simulation._lookAhead(0, [wallX - 1, 0, 0], 0.23, 0, 0), 0);
  assert.equal(simulation.avoidanceHits[0], Infinity);
  assert.equal(simulation.avoidanceDirections[0], 0);

  // Parallel to the wall, close to it: the way ahead is clear.
  assert.equal(simulation._lookAhead(0, [wallX - 0.05, 0, 0], 0, 0, 0.23), 0);
});

test('recentering waits after a hit, then acts for its duration, and a hit does not restart it', () => {
  const simulation = smallSimulation();
  Object.assign(simulation.config.locomotion, {
    recenterWeight: 0.5,
    recenterDelay: 0.5,
    recenterDuration: 1,
  });
  const dt = 0.1;
  const steps = [];
  for (let step = 0; step < 20; step += 1) {
    // Hit on the first step and again in the middle of the pull.
    const hit = step === 0 || step === 8;
    steps.push(simulation._recentering(0, hit, dt));
  }
  // Idle without a hit.
  assert.equal(simulation._recentering(1, false, dt), false);
  // About 0.5 s quiet, then about 1 s of pull, then idle. Steps on the exact
  // boundaries are left out of the check.
  assert.deepEqual(steps.slice(0, 4), [false, false, false, false]);
  assert.ok(steps.slice(5, 14).every(Boolean));
  assert.ok(steps.slice(16).every((active) => !active));
});
