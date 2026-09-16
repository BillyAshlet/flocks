import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig } from './experiment-config.js';
import { deriveExperiment } from './experiment-model.js';
import {
  SchoolVisualizer,
  emptyVisualLayers,
  wallSteering,
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

test('each school anchors its own overlay and draws only its layers', () => {
  const config = createDefaultConfig();
  const simulation = fakeSimulation(config);
  const visualizer = new SchoolVisualizer(fakeScene());
  const first = { ...emptyVisualLayers(), reynolds: true };
  const second = { ...emptyVisualLayers(), hunting: true };

  visualizer.update(simulation, config, [first, second], -1);
  const [a, b] = visualizer.overlays;
  assert.equal(a.anchor, 0);
  assert.equal(b.anchor, 2);
  assert.equal(a.reynolds.visible, true);
  assert.equal(a.hunting.visible, false);
  assert.equal(b.reynolds.visible, false);
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
  const layers = [{ reynolds: true }, { reynolds: true }];

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
  const layers = [{ fieldOfView: true }, {}];

  config.perception.fovDegrees = 360;
  visualizer.update(simulation, config, layers);
  assert.equal(visualizer.overlays[0].blindCone.visible, false);

  config.perception.fovDegrees = 300;
  visualizer.update(simulation, config, layers);
  assert.equal(visualizer.overlays[0].blindCone.visible, true);
  assert.ok(Math.abs(visualizer.overlays[0].blindAngle - Math.PI / 6) < 1e-9);
});

test('wall steering is silent mid-tank and points inward near a wall', () => {
  const config = createDefaultConfig();
  const simulation = fakeSimulation(config);
  assert.equal(wallSteering(simulation, config, 0), null);

  simulation.positions[0] = config.tank.width / 2 - 0.02;
  const steering = wallSteering(simulation, config, 0);
  assert.ok(steering);
  assert.ok(steering.direction.x < 0);
  assert.ok(steering.urgency > 0.8);
});

test('tiers offer visualization layers together with their rules', () => {
  const offered = (tier) =>
    ['reynolds', 'walls', 'fieldOfView', 'hunting', 'panic'].filter((layer) =>
      tierPanelScope(tier).showVisual(layer)
    );
  assert.deepEqual(offered(1), ['reynolds', 'walls']);
  assert.deepEqual(offered(2), ['reynolds', 'walls']);
  assert.deepEqual(offered(3), ['reynolds', 'walls', 'hunting']);
  assert.deepEqual(offered(4), ['reynolds', 'walls', 'fieldOfView', 'hunting', 'panic']);
  assert.deepEqual(offered(6), ['reynolds', 'walls', 'fieldOfView', 'hunting', 'panic']);
});
