import test from 'node:test';
import assert from 'node:assert/strict';
import { createParameterRegistry } from './experiment-config.js';
import { TIERS, tierConfig, tierPanelScope } from './tiers.js';

const KMAX = { path: 'relations.KMax' };

test('the prey size window (KMax) first appears with the third species, at tier 5', () => {
  for (const number of [1, 2, 3, 4]) {
    assert.equal(tierPanelScope(number).showGlobal(KMAX), false, `tier ${number}`);
  }
  assert.equal(tierPanelScope(5).showGlobal(KMAX), true);
  assert.equal(tierPanelScope(5).isNewGlobal(KMAX), true);
  assert.equal(tierPanelScope(6).showGlobal(KMAX), true);
  assert.equal(tierPanelScope(6).isNewGlobal(KMAX), false);
});

test('schools can be added and removed from tier 2 on', () => {
  assert.equal(tierPanelScope(1).allowSchoolEditing, false);
  for (const { number } of TIERS.filter((tier) => tier.number >= 2)) {
    assert.equal(tierPanelScope(number).allowSchoolEditing, true, `tier ${number}`);
  }
  assert.deepEqual(
    TIERS.map(({ number }) => tierPanelScope(number).isNewSchoolEditing),
    [false, true, false, false, false, false]
  );
});

test('tier 4 introduces only the six core panic knobs; the finer ones wait for tier 6', () => {
  const core = [
    'perception.fovDegrees',
    'relations.evadeWeight',
    'relations.signalThreshold',
    'relations.refractoryTime',
    'relations.panicRiseRate',
    'relations.panicDecayRate',
  ];
  const fine = [
    'relations.evadePanicBoost',
    'relations.evadeLateralWeight',
    'relations.directOn',
    'relations.directOff',
    'relations.holdTime',
    'relations.signalDecayTime',
    'relations.escapePredictionTime',
    'relations.cohesionDrop',
    'relations.panicTurnBoost',
    'relations.panicMinTrigger',
    'locomotion.panicSpeedFactor',
  ];
  const scope = tierPanelScope(4);
  const introduced = createParameterRegistry(tierConfig(4))
    .filter((spec) => !spec.path.startsWith('schools.') && scope.isNewGlobal(spec))
    .map((spec) => spec.path)
    .sort();
  assert.deepEqual(introduced, [...core].sort());
  for (const number of [4, 5]) {
    for (const path of fine) {
      assert.equal(tierPanelScope(number).showGlobal({ path }), false, `tier ${number}: ${path}`);
    }
  }
  for (const path of fine) {
    assert.equal(tierPanelScope(6).isNewGlobal({ path }), true, `tier 6: ${path}`);
  }
});
