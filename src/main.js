/**
 * flocks — entry point.
 *
 * Boots the aquarium lab: one Three.js scene, the fixed-step world clock,
 * the boid simulation, the camera controller and the parameter panel.
 * Research tiers and routing are layered on top of this in a later step.
 */
import * as THREE from 'three';
import { World, TANK, notifyTankChange } from './world.js';
import { createScene } from './scene.js';
import {
  createDefaultConfig,
  deepClone,
  exportConfigJson,
  importConfigJson,
  validateConfig,
} from './experiment-config.js';
import { DistanceField3D } from './distance-field.js';
import { ExperimentSimulation } from './experiment-simulation.js';
import { ExperimentCameraController } from './experiment-camera.js';
import { createExperimentDebug } from './experiment-debug.js';
import { TimeShortcutController } from './time-shortcuts.js';
import { RadiusVisualizer } from './radius-visualizer.js';

const startup = document.getElementById('startup-status');
const app = document.getElementById('app');

const SCENE_BACKGROUND = '#f4efe6';

function setStartup(message, state = 'loading') {
  startup.textContent = message;
  startup.dataset.state = state;
  startup.hidden = false;
}

function syncTank(config) {
  Object.assign(TANK, {
    width: config.tank.width,
    height: config.tank.height,
    depth: config.tank.depth,
  });
  notifyTankChange();
}

function restoreDefaultSchoolLayout(stage) {
  const defaults = createDefaultConfig();
  for (const school of stage.schools) {
    const original = defaults.schools.find((item) => item.id === school.id);
    if (!original) continue;
    school.spawnRegion = deepClone(original.spawnRegion);
    school.initialHeading = deepClone(original.initialHeading);
  }
}

function applyPopulationPreset(stage) {
  const presets = {
    // The large school needs enough members, otherwise its cohesion radius
    // never reaches the average spacing and it cannot find its own kind.
    full: { small: 400, medium: 200, large: 80 },
    performance: { small: 200, medium: 80, large: 40 },
  };
  const counts = presets[stage.runtime.populationPreset];
  if (!counts) return;
  for (const school of stage.schools) {
    if (counts[school.id] !== undefined) school.count = counts[school.id];
  }
}

function applyProjectPreset(stage) {
  if (stage.runtime.project === 'aquarium') {
    Object.assign(stage.tank, {
      preset: 'aquarium',
      width: 6,
      height: 3.6,
      depth: 2.4,
    });
    stage.obstacles.enabled = false;
    stage.runtime.mode = 'steady';
    stage.traits.enabled = false;
    stage.ecology.enabled = true;
    stage.plankton.enabled = true;
    restoreDefaultSchoolLayout(stage);
  } else if (stage.runtime.project === 'ecology') {
    Object.assign(stage.tank, {
      preset: 'ecology',
      width: 3,
      height: 1.8,
      depth: 1.2,
    });
    stage.obstacles.enabled = false;
    stage.runtime.mode = 'ecology';
    stage.traits.enabled = true;
    stage.ecology.enabled = true;
    stage.plankton.enabled = true;
    restoreDefaultSchoolLayout(stage);
  }
}

function applyTankPreset(stage) {
  if (['aquarium', 'ecology'].includes(stage.tank.preset)) {
    stage.runtime.project = stage.tank.preset;
    applyProjectPreset(stage);
  }
}

async function bootstrap() {
  setStartup('Starting simulation…');
  const world = new World();
  let current = createDefaultConfig();
  let stage = deepClone(current);
  syncTank(current);

  const presentation = createScene(app);
  const { renderer, scene, camera } = presentation;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = false;
  scene.add(
    new THREE.HemisphereLight('#eaf6ff', '#8d806d', 2.1),
    new THREE.DirectionalLight('#fff4dc', 1.45)
  );
  scene.children.at(-1).position.set(1.5, 2.2, 2.4);

  let distanceField = new DistanceField3D(current);
  const simulation = new ExperimentSimulation({
    scene,
    config: current,
    distanceField,
    physics: null,
  });
  world.systems.push(simulation);
  const cameraController = new ExperimentCameraController({
    camera,
    renderer,
    presentation,
    simulation,
  });
  let debug = null;
  let timeShortcuts = null;

  function syncPresentation() {
    app.dataset.project = current.runtime.project;
    app.dataset.timeKeys = '1';
    simulation.setLocomotionPreview(false);
    scene.background?.set?.(SCENE_BACKGROUND);
    presentation.setTankChambers(null);
    cameraController.setInteractionEnabled(true);
    timeShortcuts?.setEnabled(true);
  }

  const controller = {
    get current() {
      return current;
    },
    get stage() {
      return stage;
    },
    setStage(next) {
      const result = validateConfig(next);
      if (!result.valid) throw new Error(result.errors.join('\n'));
      stage = deepClone(next);
      return result;
    },
    applyConfig(mode = 'rebuildScene', sourcePath = '') {
      if (sourcePath === 'runtime.project') applyProjectPreset(stage);
      if (sourcePath === 'tank.preset') applyTankPreset(stage);
      if (sourcePath === 'runtime.populationPreset') {
        applyPopulationPreset(stage);
      } else if (/^schools\.\d+\.count$/.test(sourcePath)) {
        stage.runtime.populationPreset = 'custom';
      }
      const result = validateConfig(stage);
      if (!result.valid) throw new Error(result.errors.join('\n'));
      current = deepClone(stage);
      if (mode === 'live') {
        distanceField.config = current;
        simulation.setConfig(current, 'live');
      } else if (mode === 'reset') {
        distanceField.config = current;
        simulation.setConfig(current, 'reset');
      } else if (mode === 'rebuildField') {
        syncTank(current);
        distanceField.rebuild(current);
        simulation.distanceField = distanceField;
        simulation.setConfig(current, 'reset');
        cameraController.exitView(true);
      } else {
        syncTank(current);
        distanceField = new DistanceField3D(current);
        simulation.distanceField = distanceField;
        simulation.rebuild(current);
        cameraController.onSimulationRebuilt(simulation);
      }
      if (result.warnings.length) {
        console.warn('[flocks config]', ...result.warnings);
      }
      syncPresentation();
      return { config: current, warnings: result.warnings };
    },
    reset() {
      simulation.reset(current.runtime.seed);
      cameraController.exitView(true);
      return simulation.metrics();
    },
    restoreDefaults() {
      stage = createDefaultConfig();
      return this.applyConfig('rebuildScene');
    },
    exportConfig() {
      return exportConfigJson(stage);
    },
    importConfig(text) {
      const imported = importConfigJson(text);
      stage = imported.config;
      this.applyConfig('rebuildScene');
      return imported;
    },
    addSchool(sourceIndex = stage.schools.length - 1) {
      const template = deepClone(
        stage.schools[sourceIndex] ?? stage.schools.at(-1)
      );
      let number = stage.schools.length + 1;
      const ids = new Set(stage.schools.map((school) => school.id));
      while (ids.has(`school-${number}`)) number += 1;
      const palette = ['#7e6db0', '#53a078', '#b16d8a', '#687e9f'];
      template.id = `school-${number}`;
      template.name = `School ${number}`;
      template.color = palette[(number - 1) % palette.length];
      template.count = 40;
      template.size = Number((template.size * 1.25).toFixed(2));
      template.targetNeighbors = Math.min(8, template.count - 1);
      template.spawnRegion.centerX = 0;
      stage.schools.push(template);
      stage.runtime.populationPreset = 'custom';
      return this.applyConfig('rebuildScene');
    },
    removeSchool(index = stage.schools.length - 1) {
      if (stage.schools.length <= 1) {
        throw new Error('Keep at least one school.');
      }
      const safeIndex = Math.max(
        0,
        Math.min(stage.schools.length - 1, index)
      );
      stage.schools.splice(safeIndex, 1);
      stage.runtime.populationPreset = 'custom';
      return this.applyConfig('rebuildScene');
    },
  };

  const radiusVisualizer = new RadiusVisualizer(scene);
  timeShortcuts = new TimeShortcutController({
    setTimeScale(value) {
      stage.runtime.timeScale = value;
      controller.applyConfig('live', 'runtime.timeScale');
      debug?.pane?.refresh();
      return current.runtime.timeScale;
    },
    onDoubleSpace() {
      cameraController.exitView(true);
    },
  });

  // The lab is always in developer mode: the parameter panel is the product.
  app.dataset.developer = '1';
  debug = createExperimentDebug({ controller, simulation });
  debug.rebuildPane();
  syncPresentation();

  // Same path as "reset current project" in the panel: rebuilds the
  // simulation only and never touches the staged parameters.
  const labReset = document.getElementById('lab-reset');
  if (labReset) {
    labReset.hidden = false;
    labReset.addEventListener('click', () => {
      controller.reset();
      world.resetTiming(performance.now());
    });
  }

  const experimentApi = {
    stageConfig(next) {
      if (next === undefined) return deepClone(stage);
      return controller.setStage(next);
    },
    applyConfig(nextOrMode, maybeMode) {
      if (nextOrMode && typeof nextOrMode === 'object') {
        controller.setStage(nextOrMode);
        const result = controller.applyConfig(maybeMode ?? 'rebuildScene');
        debug?.rebuildPane();
        return result;
      }
      return controller.applyConfig(nextOrMode ?? 'rebuildScene');
    },
    exportConfig: () => controller.exportConfig(),
    importConfig(text) {
      const result = controller.importConfig(text);
      debug?.rebuildPane();
      return result;
    },
    reset: () => controller.reset(),
    metrics: () => simulation.metrics(),
    setProject(project) {
      stage.runtime.project = project;
      const result = controller.applyConfig('rebuildScene', 'runtime.project');
      debug?.rebuildPane();
      return result;
    },
  };
  Object.defineProperties(experimentApi, {
    config: { enumerable: true, get: () => current },
    staged: { enumerable: true, get: () => stage },
  });
  window.experiment = experimentApi;

  let lastFrame = performance.now();
  let smoothedFrameMs = 16.7;
  renderer.setAnimationLoop((nowMs) => {
    const realDt = Math.min(0.1, Math.max(0, (nowMs - lastFrame) / 1000));
    lastFrame = nowMs;
    smoothedFrameMs += ((realDt * 1000 || 16.7) - smoothedFrameMs) * 0.06;
    simulation.metricsState.renderFps = 1000 / smoothedFrameMs;
    presentation.updateOrientation();
    presentation.updateCamera();
    world.timeScale = current.runtime.timeScale;
    world.fixedDt = current.runtime.fixedDt;
    world.step(nowMs);
    cameraController.update(realDt);
    renderer.render(scene, camera);
    cameraController.renderPreview();
    timeShortcuts.update(current.runtime.timeScale);
    radiusVisualizer.update(simulation, current);
    debug.update(nowMs);
  });
  setStartup('Ready', 'ready');
  setTimeout(() => {
    startup.hidden = true;
  }, 900);
}

bootstrap().catch((error) => {
  console.error(error);
  setStartup(`Failed to start: ${error.message}`, 'error');
});
