import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHOOL_EMBEDDED_GLOBAL_PATHS,
  SCHOOL_SECTIONS,
  zoomRangeWindow,
} from './experiment-debug.js';

test('numeric range can zoom in and return to its registered safety range', () => {
  const limits = { min: 0, max: 100, step: 1 };
  const narrowed = zoomRangeWindow(
    { min: 0, max: 100, step: 1 },
    50,
    0.5,
    limits
  );
  assert.deepEqual(narrowed, { min: 25, max: 75, step: 1 });
  assert.deepEqual(zoomRangeWindow(narrowed, 50, 2, limits), {
    min: 0,
    max: 100,
    step: 1,
  });
});

test('range zoom remains inside safety bounds near an edge', () => {
  assert.deepEqual(
    zoomRangeWindow(
      { min: 0, max: 100, step: 0.1 },
      5,
      0.5,
      { min: 0, max: 100, step: 0.1 }
    ),
    { min: 0, max: 50, step: 0.1 }
  );
});

test('boid editor keeps each radius control beside its school weight', () => {
  const sections = Object.fromEntries(
    SCHOOL_SECTIONS.map((section) => [section.title, section])
  );
  assert.deepEqual(sections['分离 · Separation'].fields, [
    'separationRadius',
    'separationWeight',
  ]);
  assert.deepEqual(sections['对齐 · Alignment'].fields, [
    'alignmentRadius',
    'alignmentWeight',
  ]);
  assert.deepEqual(sections['凝聚 · Cohesion'].fields, [
    'cohesionRadius',
    'targetNeighbors',
    'cohesionWeight',
  ]);
  assert.equal(
    sections['凝聚 · Cohesion'].derivedRadius,
    'cohesionRadius'
  );
  assert.deepEqual([...SCHOOL_EMBEDDED_GLOBAL_PATHS], ['perception.radiusMode']);
});
