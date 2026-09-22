/**
 * The engine, in its own thread.
 *
 * It owns the simulation, the distance field and the fixed-step clock, runs
 * on its own timer, and posts a snapshot of each step to the page. Nothing
 * here touches the DOM or three.js, so a slow step delays the school, never
 * the interface.
 *
 * Messages in:  init | config | reset | hidden | preview | pacing | renderFps
 *               | running (pause while the page is not visible)
 * Messages out: ready (after init or a rebuild) | snapshot
 */
import { DistanceField3D } from './distance-field.js';
import { ExperimentSimulation } from './experiment-simulation.js';
import { World } from './world.js';
import { snapshotOf } from './simulation-view.js';

const TARGET_INTERVAL_MS = 1000 / 60;
// Metrics walk every fish, so they are refreshed a few times a second rather
// than every step; the dashboard updates more slowly than that anyway.
const METRICS_EVERY = 6;

let simulation = null;
let distanceField = null;
let world = null;
let config = null;
let pacing = { timeScale: 1, fixedDt: 1 / 60 };
let timer = null;
let ticks = 0;
let metrics = null;
// Bumped when the engine is rebuilt: the page rebuilds its meshes to match.
let generation = 0;

function post(message, transfers = []) {
  self.postMessage(message, transfers);
}

function tick() {
  timer = null;
  const started = performance.now();
  world.timeScale = pacing.timeScale;
  world.fixedDt = pacing.fixedDt;
  world.step(started);
  ticks += 1;
  if (ticks % METRICS_EVERY === 0 || metrics === null) {
    metrics = simulation.metrics();
  }
  const { data, transfers } = snapshotOf(simulation, { metrics });
  data.generation = generation;
  post({ type: 'snapshot', data }, transfers);
  // Keep a steady cadence, and always yield: a step that overruns the frame
  // simply makes the next one late instead of starving the message queue.
  const elapsed = performance.now() - started;
  timer = setTimeout(tick, Math.max(0, TARGET_INTERVAL_MS - elapsed));
}

function start() {
  if (timer === null) timer = setTimeout(tick, 0);
}

function stop() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function applyConfig(next, mode) {
  config = next;
  if (mode === 'live' || mode === 'reset') {
    distanceField.config = config;
    simulation.setConfig(config, mode === 'live' ? 'live' : 'reset');
    return;
  }
  if (mode === 'rebuildField') {
    distanceField.rebuild(config);
    simulation.distanceField = distanceField;
    simulation.setConfig(config, 'reset');
    return;
  }
  distanceField = new DistanceField3D(config);
  simulation.distanceField = distanceField;
  simulation.rebuild(config);
  generation += 1;
}

self.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case 'init': {
      config = message.config;
      distanceField = new DistanceField3D(config);
      simulation = new ExperimentSimulation({ config, distanceField });
      world = new World();
      world.systems.push(simulation);
      metrics = simulation.metrics();
      post({ type: 'ready' });
      start();
      break;
    }
    case 'config': {
      applyConfig(message.config, message.mode);
      world.resetTiming(performance.now());
      post({ type: 'ready' });
      break;
    }
    case 'reset': {
      simulation.reset(message.seed);
      world.resetTiming(performance.now());
      break;
    }
    case 'hidden':
      simulation.setHiddenFish(message.index);
      break;
    case 'preview':
      simulation.setLocomotionPreview(message.enabled);
      break;
    case 'pacing':
      pacing = { timeScale: message.timeScale, fixedDt: message.fixedDt };
      break;
    case 'renderFps':
      simulation.metricsState.renderFps = message.fps;
      break;
    case 'resetTiming':
      world.resetTiming(performance.now());
      break;
    case 'running':
      // The page is hidden: stop stepping rather than burn a background CPU.
      if (message.value) {
        world.resetTiming(performance.now());
        start();
      } else {
        stop();
      }
      break;
    case 'stop':
      stop();
      break;
    default:
      break;
  }
};
