import test from 'node:test';
import assert from 'node:assert/strict';
import { createParameterRegistry } from './experiment-config.js';
import { PANEL_CATEGORIES, parameterCategory } from './parameter-categories.js';
import { TIERS, tierConfig } from './tiers.js';

test('every parameter at every tier belongs to a panel category', () => {
  for (const { number } of TIERS) {
    for (const spec of createParameterRegistry(tierConfig(number))) {
      const category = parameterCategory(spec);
      assert.ok(
        PANEL_CATEGORIES.includes(category),
        `tier ${number}: ${spec.path} (group "${spec.group}") has no category`
      );
    }
  }
});

test('categories follow what a parameter does to the model', () => {
  const byPath = (path) => {
    const spec = createParameterRegistry(tierConfig(6)).find((item) => item.path === path);
    assert.ok(spec, path);
    return parameterCategory(spec);
  };
  assert.equal(byPath('runtime.timeScale'), 'run');
  assert.equal(byPath('tank.width'), 'environment');
  assert.equal(byPath('plankton.regrowSeconds'), 'environment');
  assert.equal(byPath('plankton.color'), 'display');
  assert.equal(byPath('ecology.corpseDrag'), 'display');
  assert.equal(byPath('ecology.basalRate'), 'fish');
  assert.equal(byPath('relations.KMax'), 'fish');
  assert.equal(byPath('camera.fov'), 'display');
  assert.equal(byPath('runtime.fixedDt'), 'internal');
  assert.equal(byPath('obstacles.enabled'), 'obstacles');
  // A school's color tells species apart; it is not decoration.
  assert.equal(byPath('schools.0.color'), 'fish');
});
