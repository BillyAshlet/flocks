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
import { viewOf } from './simulation-view.js';

export class LocalSimClient {
  constructor(config) {
    this.distanceField = new DistanceField3D(config);
    this.simulation = new ExperimentSimulation({
      config,
      distanceField: this.distanceField,
    });
    this.world = new World();
    this.world.systems.push(this.simulation);
    this.view = viewOf(this.simulation);
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
      this.view = viewOf(this.simulation);
      return 'config';
    }
    if (mode === 'reset') {
      this.distanceField.config = config;
      this.simulation.setConfig(config, 'reset');
      this.view = viewOf(this.simulation);
      return 'config';
    }
    if (mode === 'rebuildField') {
      this.distanceField.rebuild(config);
      this.simulation.distanceField = this.distanceField;
      this.simulation.setConfig(config, 'reset');
      this.view = viewOf(this.simulation);
      return 'config';
    }
    this.distanceField = new DistanceField3D(config);
    this.simulation.distanceField = this.distanceField;
    this.simulation.rebuild(config);
    this.view = viewOf(this.simulation);
    return 'rebuild';
  }

  reset(seed) {
    this.simulation.reset(seed);
    this.view = viewOf(this.simulation);
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
    this.view = viewOf(this.simulation);
    return this.view;
  }
}
