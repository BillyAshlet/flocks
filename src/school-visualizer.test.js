import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig } from './experiment-config.js';
import { deriveExperiment } from './experiment-model.js';
import {
  SchoolVisualizer,
  VISUAL_KEYS,
  allVisualLayers,
  visualOffered,
  visualsForField,
  visualsForPath,
} from './school-visualizer.js';
import { tierPanelScope } from './tiers.js';

function fakeScene() {
  return {
    children: [],
    add(...objects) {
      this.children.push(...objects);
    },
  };
}

// Two schools, two fish each, no one dead unless a test says so.
function fakeSimulation(config) {
  const derived = deriveExperiment(config);
  const positions = new Float32Array([0, 0, 0, 0.5, 0, 0, 1, 0, 0, 1.2, 0, 0]);
  const velocities = new Float32Array([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0]);
  const simulation = {
    derived: { ...derived, schools: derived.schools.slice(0, 2) },
    positions,
    alive: new Uint8Array([1, 1, 1, 1]),
    avoidanceDirections: new Float32Array(12),
    pursuitTargets: new Int32Array([-1, -1, -1, -1]),
    schoolRanges: [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ],
    fish(index) {
      const offset = index * 3;
      return {
        alive: Boolean(this.alive[index]),
        position: [...positions.slice(offset, offset + 3)],
        velocity: [...velocities.slice(offset, offset + 3)],
      };
    },
  };
  return simulation;
}

test('each school anchors its own overlay and draws only the visuals switched on', () => {
  const config = createDefaultConfig();
  const simulation = fakeSimulation(config);
  const visualizer = new SchoolVisualizer(fakeScene());
  const first = { ...allVisualLayers(false), cohesion: true };
  const second = { ...allVisualLayers(false), farSense: true };

  visualizer.update(simulation, config, [first, second], -1);
  const [a, b] = visualizer.overlays;
  assert.equal(a.anchor, 0);
  assert.equal(b.anchor, 2);
  assert.equal(a.cohesion.visible, true);
  assert.equal(a.separation.visible, false);
  assert.equal(a.farSense.visible, false);
  assert.equal(b.cohesion.visible, false);
  assert.equal(b.nearLock.visible, false);
  assert.equal(
    a.cohesion.scale.x,
    simulation.derived.schools[0].cohesionRadius
  );
  // Far sense is detection x schoolSenseFactor, not detection alone.
  assert.equal(
    b.farSense.scale.x,
    simulation.derived.schools[1].detectionLength * config.relations.schoolSenseFactor
  );
});

test('the selected fish becomes the anchor of its school; a dead anchor moves on', () => {
  const config = createDefaultConfig();
  const simulation = fakeSimulation(config);
  const visualizer = new SchoolVisualizer(fakeScene());
  const layers = [{ cohesion: true }, { cohesion: true }];

  visualizer.update(simulation, config, layers, 1);
  assert.equal(visualizer.overlays[0].anchor, 1);
  assert.equal(visualizer.overlays[1].anchor, 2);

  simulation.alive[1] = 0;
  visualizer.update(simulation, config, layers, -1);
  assert.equal(visualizer.overlays[0].anchor, 0);

  simulation.alive[0] = 0;
  visualizer.update(simulation, config, layers, -1);
  assert.equal(visualizer.overlays[0].group.visible, false);
});

test('blind cone appears only with a real field of view', () => {
  const config = createDefaultConfig();
  const simulation = fakeSimulation(config);
  const visualizer = new SchoolVisualizer(fakeScene());
  const layers = [{ blindCone: true }, {}];

  config.perception.fovDegrees = 360;
  visualizer.update(simulation, config, layers);
  assert.equal(visualizer.overlays[0].blindCone.visible, false);

  config.perception.fovDegrees = 300;
  visualizer.update(simulation, config, layers);
  assert.equal(visualizer.overlays[0].blindCone.visible, true);
  assert.ok(Math.abs(visualizer.overlays[0].blindAngle - Math.PI / 6) < 1e-9);
});

test('look-ahead ray is faint when clear and cut at a hit; the turn arrow shows only on a hit', () => {
  const config = createDefaultConfig();
  const simulation = fakeSimulation(config);
  simulation.avoidanceHits = new Float32Array(4).fill(Infinity);
  const visualizer = new SchoolVisualizer(fakeScene());
  const layers = [{ ray: true, turn: true }, {}];
  const length = config.locomotion.avoidanceLookAhead;

  visualizer.update(simulation, config, layers);
  const overlay = visualizer.overlays[0];
  const end = () => overlay.ray.geometry.attributes.position.getX(1);
  assert.equal(overlay.ray.visible, true);
  assert.ok(Math.abs(end() - length) < 1e-6);
  assert.ok(overlay.ray.material.opacity < 0.5);
  assert.equal(overlay.turnArrow.visible, false);

  simulation.avoidanceHits[0] = 0.1;
  simulation.avoidanceDirections[1] = 1;
  visualizer.update(simulation, config, layers);
  assert.ok(Math.abs(end() - 0.1) < 1e-6);
  assert.ok(overlay.ray.material.opacity > 0.9);
  assert.equal(overlay.turnArrow.visible, true);
});

test('panel rows map to the visuals they shape', () => {
  assert.deepEqual(visualsForField('targetNeighbors'), ['cohesion']);
  assert.deepEqual(visualsForPath('perception.fovDegrees'), ['blindCone']);
  assert.deepEqual(visualsForPath('perception.detectionLengthFactor'), [
    'farSense',
    'nearLock',
    'threat',
  ]);
  assert.deepEqual(visualsForPath('relations.k'), []);
});

test('tiers offer visuals together with the rows that switch them', () => {
  const offered = (tier) =>
    VISUAL_KEYS.filter((key) => visualOffered(key, tierPanelScope(tier)));
  const reynolds = ['separation', 'alignment', 'cohesion', 'ray', 'turn', 'recenter'];
  assert.deepEqual(offered(1), reynolds);
  assert.deepEqual(offered(2), reynolds);
  assert.deepEqual(offered(3), [...reynolds, 'farSense', 'nearLock']);
  // The threat radius waits for prey to react; the alarm signal radius
  // belongs to emergency alignment (tier 6).
  assert.deepEqual(offered(4), [
    'separation',
    'alignment',
    'cohesion',
    'blindCone',
    ...reynolds.slice(3),
    'farSense',
    'nearLock',
    'threat',
  ]);
  assert.deepEqual(offered(6), VISUAL_KEYS);
});
