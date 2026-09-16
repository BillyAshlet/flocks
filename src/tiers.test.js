import test from 'node:test';
import assert from 'node:assert/strict';
import { TIERS, tierPanelScope } from './tiers.js';

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
