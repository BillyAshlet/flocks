import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from './world.js';

test('resetTiming prevents pre-transition RAF time from leaking into gameplay', () => {
  const world = new World();
  let steps = 0;
  world.systems.push({
    step() {
      steps += 1;
    },
  });

  world.step(100);
  world.step(150);
  assert.ok(steps > 0);

  const beforeTransition = steps;
  world.resetTiming(900);
  world.step(900);
  assert.equal(steps, beforeTransition);

  world.step(917);
  assert.equal(steps, beforeTransition + 1);
});
