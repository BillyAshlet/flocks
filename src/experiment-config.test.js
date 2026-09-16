import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultConfig,
  createParameterRegistry,
  exportConfigJson,
  importConfigJson,
  listLeafPaths,
  validateConfig,
} from './experiment-config.js';

test('every configurable leaf has exactly one panel registry entry', () => {
  const config = createDefaultConfig();
  const leaves = listLeafPaths(config).sort();
  const registered = createParameterRegistry(config)
    .map((item) => item.path)
    .sort();
  assert.deepEqual(registered, leaves);
  assert.equal(new Set(registered).size, registered.length);
  for (const spec of createParameterRegistry(config)) {
    assert.ok(spec.label);
    assert.ok(spec.group);
    assert.ok(
      ['live', 'reset', 'rebuildField', 'rebuildScene'].includes(
        spec.applyMode
      )
    );
  }
});

test('config JSON round-trips without loss and validates atomically', () => {
  const original = createDefaultConfig();
  original.runtime.seed = 424242;
  original.schools[1].cohesionWeight = 1.73;
  const imported = importConfigJson(exportConfigJson(original));
  assert.deepEqual(imported.config, original);
  assert.equal(validateConfig(imported.config).valid, true);
  assert.throws(
    () => importConfigJson('{"runtime":{"seed":3}}'),
    /At least one school is required/
  );
});

test('default project is the live size-derived aquarium', () => {
  const config = createDefaultConfig();
  const registry = createParameterRegistry(config);
  const projectOptions = Object.values(
    registry.find((spec) => spec.path === 'runtime.project').options
  );
  const modeOptions = Object.values(
    registry.find((spec) => spec.path === 'runtime.mode').options
  );
  assert.equal(config.runtime.project, 'aquarium');
  assert.equal(config.runtime.mode, 'steady');
  assert.equal(config.ecology.enabled, true);
  // Plankton is on as the small school's staple food.
  assert.equal(config.plankton.enabled, true);
  assert.equal(config.plankton.color, '#14532d');
  assert.equal(config.captureVfx.feedColor, '#14532d');
  assert.ok(Math.abs(config.ecology.energyCapacity - 2 / 3) < 1e-12);
  assert.equal(config.ecology.minBurstEnergyRatio, 1 / 3);
  assert.deepEqual(projectOptions, ['aquarium', 'ecology']);
  assert.deepEqual(modeOptions, ['steady', 'ecology']);
  assert.equal('policy' in config.relations, false);
  assert.equal('holding' in config, false);
  assert.equal('cascadeJudge' in config, false);
  assert.equal('globalCohesionFactor' in config.perception, false);
  assert.equal('staminaDrainRate' in config.traits, false);
  assert.equal('stalkSpeedFactor' in config.traits, false);
  assert.equal(config.relations.burstRadiusFactor < 1, true);
  assert.equal(
    config.relations.burstWeight > config.relations.pursuitWeight,
    true
  );
  assert.deepEqual(
    config.schools.map((school) => [
      school.separationWeight,
      school.alignmentWeight,
      school.cohesionWeight,
    ]),
    // Earlier these weights scaled raw vector magnitudes. steerToward now
    // normalizes first, so they scale steering force and can match classic
    // boids.js directly (0.8 / 0.45 / 0.4).
    config.schools.map(() => [0.8, 0.45, 0.4])
  );
  assert.equal(config.locomotion.maxForce, 5.2);
  assert.equal(config.perception.detectionLengthFactor, 0.511);
  assert.equal(config.captureVfx.enabled, true);
  assert.deepEqual(
    config.schools.map((school) => school.metabolismMultiplier),
    config.schools.map(() => 1)
  );
});

test('removed cascade project fails closed during config import', () => {
  const legacy = createDefaultConfig();
  legacy.runtime.project = 'cascade';
  legacy.runtime.mode = 'cascade';
  assert.throws(
    () => importConfigJson(exportConfigJson(legacy)),
    /runtime\.(project|mode) is not an allowed value/
  );
});

test('removed global cohesion fails closed during config import', () => {
  const legacy = createDefaultConfig();
  legacy.perception.globalCohesionFactor = 0.35;
  assert.throws(
    () => importConfigJson(exportConfigJson(legacy)),
    /Unregistered parameter: perception\.globalCohesionFactor/
  );
});

test('invalid predation geometry warns without partially rejecting config', () => {
  const config = createDefaultConfig();
  config.locomotion.burstFactor = 1.1;
  config.locomotion.panicSpeedFactor = 1.2;
  const result = validateConfig(config);
  assert.equal(result.valid, true);
  assert.match(result.warnings.join(' '), /may never close the distance/);
});
