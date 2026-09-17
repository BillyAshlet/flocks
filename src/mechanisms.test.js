import test from 'node:test';
import assert from 'node:assert/strict';
import { MECHANISMS, mechanismFor } from './mechanisms.js';
import { VISUALS } from './school-visualizer.js';

test('parameters map to their mechanism for any school index', () => {
  assert.equal(mechanismFor('schools.0.separationWeight'), 'separation');
  assert.equal(mechanismFor('schools.4.targetNeighbors'), 'cohesion');
  assert.equal(mechanismFor('schools.1.alignmentRadius'), 'alignment');
  assert.equal(mechanismFor('perception.radiusMode'), 'cohesion');
  assert.equal(mechanismFor('locomotion.recenterDelay'), 'walls');
  assert.equal(mechanismFor('schools.0.count'), null);
  assert.equal(mechanismFor('relations.signalRadiusFactor'), 'emergency');
  assert.equal(mechanismFor('relations.signalThreshold'), 'alarm');
  assert.equal(mechanismFor('relations.panicScatterEnter'), 'scatter');
  assert.equal(mechanismFor('relations.panicRiseRate'), 'flee');
  assert.equal(mechanismFor('ecology.desperationSpeedBoost'), 'desperation');
  assert.equal(mechanismFor('ecology.planktonEnergy'), 'plankton');
  assert.equal(mechanismFor('ecology.basalRate'), 'energy');
  assert.equal(mechanismFor('schools.2.maxSpeed'), 'body');
});

test('every mechanism names its tier and at least one parameter', () => {
  for (const [key, mechanism] of Object.entries(MECHANISMS)) {
    assert.ok(mechanism.tier >= 1 && mechanism.tier <= 6, key);
    assert.ok(mechanism.paths.length > 0, key);
  }
});

test('a tank overlay is drawn in the color of the mechanism it shows', () => {
  for (const [key, mechanism] of [
    ['separation', 'separation'],
    ['alignment', 'alignment'],
    ['cohesion', 'cohesion'],
    ['ray', 'walls'],
    ['turn', 'walls'],
    ['recenter', 'walls'],
    ['farSense', 'hunting'],
    ['nearLock', 'hunting'],
    ['blindCone', 'vision'],
    ['threat', 'flee'],
    ['signal', 'emergency'],
  ]) {
    assert.equal(VISUALS[key].color, MECHANISMS[mechanism].color, key);
  }
});
