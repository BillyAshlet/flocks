/**
 * The page's handle on the engine.
 *
 * Everything the page can ask the simulation to do goes through this: apply a
 * config, reset, step time, hide a fish. Everything it reads comes back as a
 * view (see simulation-view.js). LocalSimClient keeps the engine in this
 * thread; a worker client will offer the same methods and answer with
 * messages, so main.js does not change when the engine moves off the main
 * thread.
 */
import { DistanceField3D } from './distance-field.js';
import { ExperimentSimulation } from './experiment-simulation.js';
import { World } from './world.js';
import { viewFromSnapshot, viewOf } from './simulation-view.js';

export class LocalSimClient {
  constructor(config) {
    this.distanceField = new DistanceField3D(config);
    this.simulation = new ExperimentSimulation({
      config,
      distanceField: this.distanceField,
    });
    this.world = new World();
    this.world.systems.push(this.simulation);
    // Bumped whenever the engine is rebuilt, so the page knows its meshes no
    // longer match the arrays it is being handed.
    this.generation = 0;
    this.view = this._view();
    this.ready = Promise.resolve(this.view);
  }

  _view() {
    const view = viewOf(this.simulation);
    view.generation = this.generation;
    return view;
  }

  /**
   * How much of the engine a config change touches:
   *   live         parameters only
   *   reset        parameters, then restart the run
   *   rebuildField the tank changed, so the distance field is rebuilt
   *   rebuildScene counts or schools changed, so the engine is rebuilt
   * Returns what the page must redraw: 'config', 'rebuild' or nothing.
   */
  applyConfig(config, mode = 'rebuildScene') {
    if (mode === 'live') {
      this.distanceField.config = config;
      this.simulation.setConfig(config, 'live');
      this.view = this._view();
      return 'config';
    }
    if (mode === 'reset') {
      this.distanceField.config = config;
      this.simulation.setConfig(config, 'reset');
      this.view = this._view();
      return 'config';
    }
    if (mode === 'rebuildField') {
      this.distanceField.rebuild(config);
      this.simulation.distanceField = this.distanceField;
      this.simulation.setConfig(config, 'reset');
      this.view = this._view();
      return 'config';
    }
    this.distanceField = new DistanceField3D(config);
    this.simulation.distanceField = this.distanceField;
    this.simulation.rebuild(config);
    this.generation += 1;
    this.view = this._view();
    return 'rebuild';
  }

  reset(seed) {
    this.simulation.reset(seed);
    this.view = this._view();
  }

  setHiddenFish(index) {
    this.simulation.setHiddenFish(index);
  }

  setLocomotionPreview(enabled) {
    this.simulation.setLocomotionPreview(enabled);
  }

  /** Frame rate is measured by the page and only shown on the dashboard. */
  setRenderFps(fps) {
    this.simulation.metricsState.renderFps = fps;
  }

  metrics() {
    return this.simulation.metrics();
  }

  resetTiming(nowMs) {
    this.world.resetTiming(nowMs);
  }

  /** Advance to `nowMs`; returns the view of the step that came out. */
  step(nowMs, { timeScale = 1, fixedDt = 1 / 60 } = {}) {
    this.world.timeScale = timeScale;
    this.world.fixedDt = fixedDt;
    this.world.step(nowMs);
    this.view = this._view();
    return this.view;
  }
}

/**
 * The same handle, with the engine in a worker.
 *
 * Reads answer from the last snapshot that arrived, so they never block on a
 * step in flight; writes are messages. The page may therefore draw a school
 * that is a frame or two old, which is the point: a heavy step delays the
 * fish, not the interface.
 */
export class WorkerSimClient {
  constructor(config) {
    this.config = config;
    this.view = null;
    this.lastMetrics = null;
    this.pacing = { timeScale: null, fixedDt: null };
    this.worker = new Worker(new URL('./sim-worker.js', import.meta.url), {
      type: 'module',
      name: 'flocks-simulation',
    });
    // Resolves on the first snapshot: the page cannot build its meshes until
    // it knows how many fish there are.
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.worker.onmessage = (event) => this._receive(event.data);
    this.worker.postMessage({ type: 'init', config });
  }

  _receive(message) {
    if (message.type !== 'snapshot') return;
    if (message.data.metrics) this.lastMetrics = message.data.metrics;
    this.view = viewFromSnapshot(message.data, this.config);
    this.view.generation = message.data.generation;
    this._resolveReady?.(this.view);
    this._resolveReady = null;
  }

  applyConfig(config, mode = 'rebuildScene') {
    this.config = config;
    this.worker.postMessage({ type: 'config', config, mode });
    // The view keeps the arrays of the step already in hand; only the config
    // it carries is replaced, so the page can redraw at once.
    if (this.view) this.view.config = config;
    return mode === 'rebuildField' || mode === 'live' || mode === 'reset'
      ? 'config'
      : 'rebuild';
  }

  reset(seed) {
    this.worker.postMessage({ type: 'reset', seed });
  }

  setHiddenFish(index) {
    this.worker.postMessage({ type: 'hidden', index });
  }

  setLocomotionPreview(enabled) {
    this.worker.postMessage({ type: 'preview', enabled });
  }

  setRenderFps(fps) {
    this.worker.postMessage({ type: 'renderFps', fps });
  }

  metrics() {
    return this.lastMetrics;
  }

  resetTiming() {
    this.worker.postMessage({ type: 'resetTiming' });
  }

  /** The worker keeps its own clock; the page only sends the pace. */
  step(_nowMs, { timeScale = 1, fixedDt = 1 / 60 } = {}) {
    if (
      timeScale !== this.pacing.timeScale ||
      fixedDt !== this.pacing.fixedDt
    ) {
      this.pacing = { timeScale, fixedDt };
      this.worker.postMessage({ type: 'pacing', timeScale, fixedDt });
    }
    return this.view;
  }

  dispose() {
    this.worker.postMessage({ type: 'stop' });
    this.worker.terminate();
  }
}

/**
 * Workers are the default. `?worker=off` keeps the engine on the main thread,
 * which is the way to tell a worker problem from an engine one.
 */
export function createSimClient(config, { search = '' } = {}) {
  const wanted = new URLSearchParams(search).get('worker');
  const useWorker = wanted !== 'off' && typeof Worker !== 'undefined';
  return useWorker ? new WorkerSimClient(config) : new LocalSimClient(config);
}
