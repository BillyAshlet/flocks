/**
 * The worker and the page, talking to each other, outside a browser.
 *
 * The engine runs in a worker and the page draws from snapshots it sends, so
 * the two hold state that was computed at different moments. Unit tests cannot
 * see that: each side is correct on its own. What goes wrong is the pairing —
 * a step computed under one config drawn under another. That is what froze the
 * tank when the tier changed: fish carried a school index the new config's
 * school list did not have.
 *
 * So this drives the real sim-worker and the real WorkerSimClient through a
 * fake channel (messages become direct calls, so no browser is needed), plays
 * out the tier switches by hand, and checks every view the page would have
 * drawn is consistent with itself.
 *
 * Checked against the bug it was written for: put back the line that replaced
 * the config on the step already in hand, and this reports 19 inconsistent
 * views and exits 1. That line looked harmless — the page could redraw the new
 * colors at once — and it is the check right at the moment of the switch that
 * catches it, not the frames after.
 *
 * It takes a couple of seconds, because it waits for the worker's own clock to
 * produce real snapshots. Run it after touching anything on the worker path:
 *
 *   npm run protocol
 */
const SRC = new URL('../src/', import.meta.url).href.replace(/\/$/, '');

// The worker module installs its handler on `self` and answers by calling
// `self.postMessage`; the client is on the other end of both.
const LATENCY_MS = 4;
let clientSide = null;
globalThis.self = {
  onmessage: null,
  postMessage: (message) =>
    setTimeout(() => clientSide?.onmessage?.({ data: message }), LATENCY_MS),
};
await import(`${SRC}/sim-worker.js`);
const toWorker = (message) => globalThis.self.onmessage({ data: message });

// Delivery takes time, both ways, because in a browser the two sides are
// separate threads: a snapshot posted just before the page changed the config
// still arrives after it. Delivered instantly, as a microtask, the worker has
// always applied a config change before its next step, and the page never
// holds a step from before it.
globalThis.Worker = class FakeWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    clientSide = this;
  }
  postMessage(message) {
    setTimeout(() => toWorker(message), LATENCY_MS);
  }
  terminate() {
    toWorker({ type: 'stop' });
  }
};

const { tierConfig, TIER_COUNT } = await import(`${SRC}/tiers.js`);
const { WorkerSimClient } = await import(`${SRC}/sim-client.js`);

const problems = [];
let checked = 0;

/** Everything in one view has to describe the same school of fish. */
function check(view, where) {
  if (!view) return;
  checked += 1;
  const schools = view.config.schools.length;
  if (view.derived.schools.length !== schools) {
    problems.push(
      `${where}: ${view.derived.schools.length} derived schools, ${schools} in the config`
    );
  }
  if (view.schoolRanges.length !== schools) {
    problems.push(`${where}: ${view.schoolRanges.length} ranges, ${schools} schools`);
  }
  for (let index = 0; index < view.count; index += 1) {
    const id = view.schoolIds[index];
    if (!view.config.schools[id]) {
      problems.push(
        `${where}: fish ${index} is in school ${id}, the config has ${schools}`
      );
      break;
    }
  }
  const last = view.schoolRanges.at(-1);
  if (last && last.end !== view.count) {
    problems.push(`${where}: ranges end at ${last.end}, there are ${view.count} fish`);
  }
  if (view.positions.length !== view.count * 3) {
    problems.push(
      `${where}: ${view.positions.length / 3} positions, ${view.count} fish`
    );
  }
  if (view.alive.length !== view.count) {
    problems.push(`${where}: ${view.alive.length} alive flags, ${view.count} fish`);
  }
}

/**
 * Frames the way the page draws them: ask for the latest step, then draw it.
 *
 * At normal speed. The fake worker shares this thread, so a raised time scale
 * does not stress the pairing, it just makes every tick eight steps long and
 * the whole check eight times slower; what is being tested is which config a
 * step is drawn with, and that is the same at any speed.
 */
function frames(client, count, label) {
  return new Promise((resolve) => {
    let drawn = 0;
    const frame = () => {
      check(
        client.step(performance.now(), { timeScale: 1, fixedDt: 1 / 60 }),
        `${label}, frame ${drawn}`
      );
      drawn += 1;
      if (drawn >= count) resolve();
      else setTimeout(frame, 16);
    };
    frame();
  });
}

const client = new WorkerSimClient(tierConfig(TIER_COUNT));
await client.ready;
await frames(client, 20, `tier ${TIER_COUNT}`);

// A tier change hands the page a new config while the step in hand still
// belongs to the old one. Every switch below is checked on the frame it
// happens and for a while after.
for (const tier of [1, TIER_COUNT, 3]) {
  client.applyConfig(tierConfig(tier), 'rebuildScene');
  check(client.view, `the frame tier ${tier} was asked for`);
  await frames(client, 30, `tier ${tier}`);
}

// Several switches before a single step comes back: the page must not end up
// drawing a step under a config it skipped past.
client.applyConfig(tierConfig(2), 'rebuildScene');
client.applyConfig(tierConfig(5), 'rebuildScene');
client.applyConfig(tierConfig(4), 'rebuildScene');
await frames(client, 30, 'three switches with no frame between them');

client.dispose();

console.log(`views checked      ${checked}`);
console.log(`snapshots received ${client.snapshots}`);
console.log(`configs still held ${client.configs.size}`);
if (problems.length) {
  console.log(`\n${problems.length} inconsistent views:`);
  for (const line of problems.slice(0, 10)) console.log(`  ${line}`);
  process.exit(1);
}
console.log('\nno view mixed one config with another step');
process.exit(0);
