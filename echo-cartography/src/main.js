/**
 * Echo Cartography on flocks (echo-cartography/index.html, served at /echo):
 * the swarm, the predators, the event uplink, the terminal's map and
 * exploration, running on their own engine.
 *
 * Adapted from the original project's main.js: no cover, pitch deck,
 * parameter panel, language switch or pilot mode. The page opens paused on
 * the empty map; "Release the swarm" (or Space) starts it.
 */
import '@fontsource-variable/source-serif-4';
import { createScene } from './scene.js';
import { Flock } from './flock.js';
import { CreaturePack } from './creature.js';
import { EventBus } from './eventBus.js';
import { OccupancyGrid } from './grid.js';
import { createMapView } from './mapView.js';
import { createTerminalPanel } from './terminalPanel.js';
import { I18n } from './i18n.js';
import { CREATURE, SIM, FRONTIER, ALTITUDE } from './params.js';
import { Terminal } from './terminal.js';
import { BONUS_CHAPTER, CHAPTERS, chapterHref, neighborChapter } from '../../src/chapters.js';

// ── Top bar: the same chapters as the main page, as plain links ─────────
{
  const steps = document.getElementById('tier-steps');
  for (const chapter of CHAPTERS) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = chapterHref(chapter);
    link.title = chapter.title;
    const number = document.createElement('span');
    number.className = 'step-number';
    number.textContent = chapter.label ?? String(chapter.number);
    const title = document.createElement('span');
    title.className = 'step-title';
    title.textContent = chapter.title;
    link.append(number, title);
    if (chapter === BONUS_CHAPTER) link.setAttribute('aria-current', 'page');
    item.append(link);
    steps.append(item);
  }
  const previous = neighborChapter(BONUS_CHAPTER, -1);
  const next = neighborChapter(BONUS_CHAPTER, 1);
  if (previous) document.getElementById('tier-prev').href = chapterHref(previous);
  if (next) document.getElementById('tier-next').href = chapterHref(next);
}

const i18n = new I18n();
const view = createScene(document.getElementById('scene'));
const { renderer, scene, camera, obstacles } = view;

const bus = new EventBus();
const flock = new Flock(obstacles, bus);
const creatures = new CreaturePack(obstacles);
// Large creatures are visible to the rays: a sensor cannot tell rock from a
// fish, only that something is there. Free-space carving is what removes them
// from the map, not recognition.
flock.sensor.dynamic = creatures.members.map((c) => ({
  position: c.position,
  radius: CREATURE.bodyRadius * 1.6,
}));

// ── The terminal: events → occupancy grid → point cloud ──────────────────
const grid = new OccupancyGrid();
const terminal = new Terminal(grid);
const mapView = createMapView(grid, renderer, document.getElementById('map'));
const terminalRoot = document.getElementById('terminal');
const tpanel = createTerminalPanel({
  root: terminalRoot,
  i18n,
  grid,
  terminal,
  bus,
  flock,
  mapView,
  frontier: FRONTIER,
});
tpanel.refreshLabels();

// The map window's orbit controls sit on #map, which also holds the buttons;
// without stopping the pointer events there, the buttons never get a click.
function wireMapButton(button, onClick) {
  const stop = (event) => event.stopPropagation();
  button.addEventListener('pointerdown', stop);
  button.addEventListener('pointerup', stop);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
}
const mapStat = document.getElementById('map-stat');
const mapReset = document.getElementById('map-reset');
const mapSave = document.getElementById('map-save');
mapReset.textContent = i18n.t('mapReset');
mapSave.textContent = i18n.t('mapSave');
wireMapButton(mapReset, () => {
  grid.reset();
  mapView.reset();
  terminal.reset();
});
wireMapButton(mapSave, () => {
  if (grid.occupiedCount === 0) return;
  const blob = new Blob([grid.toPLY()], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `echo-cartography-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.ply`;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking at once can cancel the download before it starts.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

// ── Main loop: fixed-step physics, one render per frame ──────────────────
const hud = document.getElementById('hud');
const FIXED_DT = 1 / 60;
let accumulator = 0;
let last = performance.now();
let frames = 0;
let fps = 0;
let windowStart = performance.now();
// Opens paused: the map starts empty, and the first thing a reader does is
// release the swarm and watch it grow.
let paused = true;

function tick(now) {
  const elapsed = Math.min((now - last) / 1000, 0.1);
  last = now;
  const speed = Math.max(1, SIM.speed || 1);
  if (!paused) accumulator += elapsed * speed;
  const maxSteps = Math.min(64, Math.ceil(4 * speed));
  let steps = 0;
  while (accumulator >= FIXED_DT && steps < maxSteps) {
    creatures.step(FIXED_DT);
    flock.step(FIXED_DT, creatures);
    // The terminal reads this frame's events before bus.tick clears them.
    grid.consume(bus, bus.frame);
    terminal.update(flock.time, flock);
    bus.tick(flock.time);
    accumulator -= FIXED_DT;
    steps += 1;
  }
  if (accumulator > FIXED_DT * maxSteps) accumulator = FIXED_DT * maxSteps;

  view.syncFlock(flock);
  view.syncCreatures(creatures);
  view.updateCamera(flock, elapsed);
  mapView.sync();
  renderer.render(scene, camera);
  // The map window is scissored into the same canvas after the main view.
  mapView.render();

  frames += 1;
  if (now - windowStart > 500) {
    fps = Math.round((frames * 1000) / (now - windowStart));
    frames = 0;
    windowStart = now;
    const metrics = flock.metrics();
    const kb = bus.bytesPerSec / 1024;
    const centralKb = bus.centralizedBytesPerSec(flock.count) / 1024;
    // With very few events the ratio runs to infinity; show nothing instead.
    const ratio = bus.eventsPerSec >= 20 ? `${(centralKb / kb).toFixed(1)}×` : '—';
    const band = ALTITUDE.enabled
      ? `<i></i>${i18n.t('hudBand')} <b>${ALTITUDE.yMin.toFixed(1)}~${ALTITUDE.yMax.toFixed(1)}</b>`
      : '';
    hud.innerHTML =
      `<b>${fps}</b> fps` +
      `<i></i>${i18n.t('hudDevices')} <b>${metrics.total}</b> ` +
      `${i18n.t('hudPanic')} <b>${metrics.panicking}</b>` +
      `<i></i>${i18n.t('hudEvents')} <b>${bus.eventsPerSec}</b>/s` +
      `<i></i>${i18n.t('hudUplink')} <b>${kb.toFixed(1)}</b> KB/s` +
      `<i></i>${i18n.t('hudCentral')} ${centralKb.toFixed(0)} KB/s` +
      `<i></i><em>${ratio}</em>` +
      band;
    mapStat.textContent = i18n.t('mapStat', grid.occupiedCount, grid.rayCount);
    tpanel.update();
  }
}
renderer.setAnimationLoop(tick);

// ── Release / pause ──────────────────────────────────────────────────────
const startButtons = document.querySelectorAll('[data-start]');
function setPaused(next) {
  paused = next;
  // Time kept passing while paused; clear it so resuming does not jump ahead.
  accumulator = 0;
  last = performance.now();
  document.body.classList.toggle('sim-paused', paused);
  for (const button of startButtons) {
    button.textContent = paused ? 'Release the swarm' : 'Pause';
  }
}
for (const button of startButtons) {
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    setPaused(!paused);
  });
}
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space') return;
  const target = event.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON')) {
    return;
  }
  event.preventDefault();
  setPaused(!paused);
});
setPaused(true);

window.echo = { flock, creatures, bus, grid, terminal, mapView, view, setPaused };
