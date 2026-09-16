/**
 * flocks — entry point.
 *
 * Boots the aquarium lab: one Three.js scene, the fixed-step world clock,
 * the boid simulation, the camera controller and the parameter panel.
 * Routes: `/` is the home page (the full ecosystem, view only) and
 * `/tier/1` … `/tier/6` are the research tiers.
 */
import * as THREE from 'three';
import '@fontsource-variable/source-serif-4';
import { World, TANK, notifyTankChange } from './world.js';
import { createScene, SCENE_BACKGROUND } from './scene.js';
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
import { SchoolVisualizer } from './school-visualizer.js';
import { TIER_COUNT, TIERS, tierByNumber, tierConfig, tierPanelScope } from './tiers.js';
import { renderPaper } from './paper.js';

const startup = document.getElementById('startup-status');
const app = document.getElementById('app');
const stageElement = document.getElementById('stage');

function parseRoute(pathname) {
  const match = pathname.match(/^\/tier\/(\d+)\/?$/);
  if (match && tierByNumber(Number(match[1]))) {
    return { page: 'tier', number: Number(match[1]) };
  }
  return { page: 'home' };
}

function routePath(route) {
  return route.page === 'tier' ? `/tier/${route.number}` : '/';
}

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
  let route = parseRoute(window.location.pathname);
  let current = tierConfig(route.page === 'tier' ? route.number : TIER_COUNT);
  let stage = deepClone(current);
  syncTank(current);

  const presentation = createScene(stageElement);
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

  // The home page is view only: no panel, no fish picking, no time keys.
  function syncPresentation() {
    const onTier = route.page === 'tier';
    app.dataset.page = route.page;
    app.dataset.project = current.runtime.project;
    app.dataset.developer = onTier ? '1' : '';
    app.dataset.timeKeys = onTier ? '1' : '';
    simulation.setLocomotionPreview(false);
    scene.background?.set?.(SCENE_BACKGROUND);
    presentation.setTankChambers(null);
    cameraController.setInteractionEnabled(onTier);
    timeShortcuts?.setEnabled(onTier);
  }

  const controller = {
    // Set per route; narrows the parameter panel to one tier.
    panelScope: null,
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
    // The defaults of the tier on screen. Using the full default config here
    // once turned tier 1 into the whole ecosystem.
    restoreDefaults() {
      stage = tierConfig(route.page === 'tier' ? route.number : TIER_COUNT);
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
      return this.applyConfig('rebuildScene');
    },
  };

  const schoolVisualizer = new SchoolVisualizer(scene);
  timeShortcuts = new TimeShortcutController({
    root: stageElement,
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

  debug = createExperimentDebug({ controller, simulation });

  const labReset = document.getElementById('lab-reset');
  const tierSteps = document.getElementById('tier-steps');
  const tierPrev = document.getElementById('tier-prev');
  const tierNext = document.getElementById('tier-next');
  const paper = document.getElementById('paper');
  const panelToggle = document.getElementById('panel-toggle');
  const home = document.getElementById('home');

  // One link per tier, all alike; the current one is marked, not the rest.
  for (const tier of TIERS) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `/tier/${tier.number}`;
    link.dataset.tier = String(tier.number);
    link.innerHTML = '<span class="step-number"></span><span class="step-title"></span>';
    link.querySelector('.step-number').textContent = String(tier.number);
    link.querySelector('.step-title').textContent = tier.title;
    link.title = tier.title;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      goToTier(tier.number);
    });
    item.appendChild(link);
    tierSteps.appendChild(item);
  }

  // Dragging the paper's edge widens it, for formulas that do not fit.
  // Remembered per browser; storage can be missing (private mode), which only
  // means the width is not remembered.
  const PAPER_WIDTH_KEY = 'flocks.paperWidth';
  const resizer = document.getElementById('paper-resizer');
  function setPaperWidth(px) {
    if (px === null) {
      app.style.removeProperty('--paper-custom');
      return;
    }
    const panel = document.getElementById('panel-column').offsetWidth;
    const max = Math.max(320, window.innerWidth - panel - 320);
    app.style.setProperty('--paper-custom', `${Math.round(Math.min(max, Math.max(320, px)))}px`);
  }
  try {
    const saved = Number(localStorage.getItem(PAPER_WIDTH_KEY));
    if (saved > 0) setPaperWidth(saved);
  } catch {}
  resizer.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    app.dataset.resizing = '1';
  });
  resizer.addEventListener('pointermove', (event) => {
    if (app.dataset.resizing === '1') setPaperWidth(event.clientX);
  });
  const endResize = () => {
    if (app.dataset.resizing !== '1') return;
    app.dataset.resizing = '';
    try {
      localStorage.setItem(PAPER_WIDTH_KEY, String(paper.offsetWidth));
    } catch {}
  };
  resizer.addEventListener('pointerup', endResize);
  resizer.addEventListener('pointercancel', endResize);
  resizer.addEventListener('dblclick', () => {
    setPaperWidth(null);
    try {
      localStorage.removeItem(PAPER_WIDTH_KEY);
    } catch {}
  });

  function setPanelCollapsed(collapsed) {
    app.dataset.panelCollapsed = collapsed ? '1' : '';
    panelToggle.textContent = collapsed ? '‹' : 'Hide ›';
    panelToggle.title = collapsed ? 'Show parameters' : 'Hide parameters';
    panelToggle.setAttribute('aria-expanded', String(!collapsed));
  }
  panelToggle.addEventListener('click', () => {
    setPanelCollapsed(app.dataset.panelCollapsed !== '1');
  });
  setPanelCollapsed(false);

  // A formula symbol opens its slider, bringing the panel back if folded.
  function openParameter(path) {
    if (app.dataset.panelCollapsed === '1') setPanelCollapsed(false);
    debug.revealParameter(path);
  }

  function renderChrome() {
    const onTier = route.page === 'tier';
    home.hidden = onTier;
    labReset.hidden = !onTier;
    if (!onTier) {
      document.title = 'flocks';
      return;
    }
    const tier = tierByNumber(route.number);
    for (const link of tierSteps.querySelectorAll('a')) {
      if (Number(link.dataset.tier) === tier.number) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    }
    tierPrev.disabled = tier.number === 1;
    tierNext.disabled = tier.number === TIER_COUNT;
    renderPaper(paper, tier, TIER_COUNT, { onParameter: openParameter });
    document.title = `flocks · ${tier.title}`;
  }

  // Every route change rebuilds the scene from that tier's configuration.
  // Home runs the final tier so visitors first see the full ecosystem.
  function showRoute(next, { push = false } = {}) {
    route = next;
    const number = route.page === 'tier' ? route.number : TIER_COUNT;
    controller.panelScope = tierPanelScope(number);
    stage = tierConfig(number);
    controller.applyConfig('rebuildScene');
    if (route.page === 'tier') debug.rebuildPane();
    renderChrome();
    if (push) history.pushState(null, '', routePath(route));
    world.resetTiming(performance.now());
  }

  // Only tier pages draw overlays; the panel decides which (see the visual
  // rows in experiment-debug.js).
  function visibleLayers() {
    if (route.page !== 'tier' || !debug) return [];
    return debug
      .visualLayersBySchool(current.schools.length)
      .map((layers) => layers ?? {});
  }

  function goToTier(number) {
    showRoute({ page: 'tier', number }, { push: true });
  }

  tierPrev.addEventListener('click', () => goToTier(route.number - 1));
  tierNext.addEventListener('click', () => goToTier(route.number + 1));
  for (const link of document.querySelectorAll('[data-route]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      showRoute(parseRoute(link.getAttribute('href')), { push: true });
    });
  }
  window.addEventListener('popstate', () => {
    showRoute(parseRoute(window.location.pathname));
  });

  // Same path as "reset current project" in the panel: rebuilds the
  // simulation only and never touches the staged parameters.
  labReset.addEventListener('click', () => {
    controller.reset();
    world.resetTiming(performance.now());
  });

  showRoute(route);

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
    goToTier,
    goHome: () => showRoute({ page: 'home' }, { push: true }),
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
    schoolVisualizer.update(
      simulation,
      current,
      visibleLayers(),
      cameraController.selected
    );
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
