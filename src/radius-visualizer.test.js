import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultConfig } from './experiment-config.js';
import { deriveExperiment } from './experiment-model.js';
import { RadiusVisualizer } from './radius-visualizer.js';

test('debug config exposes panel toggles for fish-0 radius spheres', () => {
  const config = createDefaultConfig();
  assert.equal(config.debug.perceptionRadii, false);
  assert.equal(config.debug.combatRadii, false);
});

test('radius visualizer anchors on fish 0 and scales live derived radii', () => {
  const scene = {
    children: [],
    add(child) {
      this.children.push(child);
    },
  };
  const visualizer = new RadiusVisualizer(scene);
  const config = createDefaultConfig();
  config.debug.perceptionRadii = true;
  const derived = deriveExperiment(config);
  const simulation = {
    derived,
    fish(index) {
      if (index !== 0) return null;
      return {
        alive: true,
        schoolIndex: 0,
        position: [0.1, 0.2, 0.3],
      };
    },
  };

  visualizer.update(simulation, config);
  assert.equal(visualizer.group.visible, true);
  assert.equal(
    visualizer.boid.cohesion.scale.x,
    derived.schools[0].cohesionRadius
  );
  assert.equal(visualizer.combat.hunt.visible, false);

  config.debug.perceptionRadii = false;
  config.debug.combatRadii = true;
  visualizer.update(simulation, config);
  assert.equal(visualizer.combat.hunt.visible, true);
  assert.equal(
    visualizer.combat.burst.scale.x,
    derived.schools[0].detectionLength * config.relations.burstRadiusFactor
  );

  simulation.fish = () => ({
    alive: false,
    schoolIndex: 0,
    position: [0, 0, 0],
  });
  visualizer.update(simulation, config);
  assert.equal(visualizer.group.visible, false);
});
