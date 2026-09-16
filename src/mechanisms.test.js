import test from 'node:test';
import assert from 'node:assert/strict';
import { MECHANISMS, mechanismFor } from './mechanisms.js';
import { VISUALS } from './school-visualizer.js';

test('parameters map to their mechanism for any school index', () => {
  assert.equal(mechanismFor('schools.0.separationWeight'), 'separation');
  assert.equal(mechanismFor('schools.4.targetNeighbors'), 'cohesion');
  assert.equal(mechanismFor('perception.alignmentRadiusFactor'), 'alignment');
  assert.equal(mechanismFor('locomotion.recenterDelay'), 'walls');
  assert.equal(mechanismFor('schools.0.count'), null);
});

test('a tank overlay is drawn in the color of the mechanism it shows', () => {
  for (const [key, mechanism] of [
    ['separation', 'separation'],
    ['alignment', 'alignment'],
    ['cohesion', 'cohesion'],
    ['ray', 'walls'],
    ['turn', 'walls'],
    ['recenter', 'walls'],
  ]) {
    assert.equal(VISUALS[key].color, MECHANISMS[mechanism].color, key);
  }
});
