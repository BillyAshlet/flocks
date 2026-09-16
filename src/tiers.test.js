import test from 'node:test';
import assert from 'node:assert/strict';
import { createParameterRegistry } from './experiment-config.js';
import { TIERS, tierConfig, tierPanelScope } from './tiers.js';
import { parameterCategory } from './parameter-categories.js';

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

// Research knobs only: display paths sit under Non-research settings and are
// not part of what a tier teaches.
function introducedResearch(number, pick) {
  const scope = tierPanelScope(number);
  return createParameterRegistry(tierConfig(number))
    .filter(
      (spec) =>
        !spec.path.startsWith('schools.') &&
        ['run', 'environment', 'fish'].includes(parameterCategory(spec)) &&
        pick(scope, spec)
    )
    .map((spec) => spec.path)
    .sort();
}

test('tier 5 introduces the food web and the core energy knobs; the rest wait for tier 6', () => {
  assert.deepEqual(
    introducedResearch(5, (scope, spec) => scope.isNewGlobal(spec)),
    [
      'ecology.basalRate',
      'ecology.burstMetabolicRate',
      'ecology.captureEnergyPerSize',
      'ecology.energyShareLocal',
      'ecology.energyShareSchool',
      'plankton.regrowSeconds',
      'relations.KMax',
    ]
  );
  const scope = tierPanelScope(5);
  assert.equal(scope.isNewSchoolField('grazeRate'), true);
  assert.equal(scope.isNewSchoolField('metabolismMultiplier'), true);
  assert.equal(scope.showGlobal({ path: 'ecology.planktonEnergy' }), false);
  assert.equal(tierPanelScope(6).isDetailGlobal({ path: 'ecology.planktonEnergy' }), true);
});

test('tiers 1 to 5 mark everything they add; tier 6 marks its core and folds the rest', () => {
  for (const number of [1, 2, 3, 4, 5]) {
    assert.deepEqual(
      introducedResearch(number, (scope, spec) => scope.isDetailGlobal(spec)),
      [],
      `tier ${number}`
    );
    assert.deepEqual(
      introducedResearch(number, (scope, spec) => scope.isNewCoreGlobal(spec)),
      introducedResearch(number, (scope, spec) => scope.isNewGlobal(spec)),
      `tier ${number}`
    );
  }
  const core = introducedResearch(6, (scope, spec) => scope.isNewCoreGlobal(spec));
  assert.deepEqual(core, [
    'ecology.debtSettleSeconds',
    'ecology.desperation',
    'ecology.desperationDebt',
    'ecology.desperationEnterRatio',
    'ecology.desperationSpeedBoost',
    'relations.emergencyAlignment',
    'relations.emergencyAlignmentWeight',
    'relations.panicScatterEnter',
    'relations.scatterLatch',
    'relations.signalRadiusFactor',
  ]);
  const scope = tierPanelScope(6);
  assert.equal(scope.isDetailGlobal({ path: 'relations.holdTime' }), true);
  assert.equal(scope.isNewCoreSchoolField('podCount'), false);
});
