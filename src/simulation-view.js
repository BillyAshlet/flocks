/**
 * A read-only view of one simulation step.
 *
 * Everything outside the engine — the renderer, the camera, the visuals, the
 * dashboard — reads a view instead of the engine itself. In the same thread a
 * view just points at the engine's arrays, so nothing is copied; once the
 * engine runs in a worker, the same shape arrives as transferred arrays and
 * the readers do not change.
 */

export const LOCOMOTION_LABEL = Object.freeze(['cruise', 'burst', 'evade']);

/** One fish, as plain values. `state` is a view or the engine itself. */
export function fishOf(state, index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.count) {
    return null;
  }
  const offset = index * 3;
  const schoolIndex = state.schoolIds[index];
  return {
    index,
    alive: Boolean(state.alive[index]),
    schoolIndex,
    school: state.config.schools[schoolIndex],
    position: [
      state.positions[offset],
      state.positions[offset + 1],
      state.positions[offset + 2],
    ],
    velocity: [
      state.velocities[offset],
      state.velocities[offset + 1],
      state.velocities[offset + 2],
    ],
    panic: state.panic[index],
    energy: state.energy[index],
    locomotionState: LOCOMOTION_LABEL[state.locomotionStates[index]],
  };
}

/** The nearest living fish of the same school, or -1. Used when a followed fish dies. */
export function nearestAliveSameSchoolOf(state, index) {
  const source = fishOf(state, index);
  if (!source) return -1;
  let result = -1;
  let distance2 = Infinity;
  const range = state.schoolRanges[source.schoolIndex];
  for (let other = range.start; other < range.end; other += 1) {
    if (other === index || !state.alive[other]) continue;
    const offset = other * 3;
    const dx = state.positions[offset] - source.position[0];
    const dy = state.positions[offset + 1] - source.position[1];
    const dz = state.positions[offset + 2] - source.position[2];
    const candidate = dx * dx + dy * dy + dz * dz;
    if (candidate < distance2) {
      result = other;
      distance2 = candidate;
    }
  }
  return result;
}

export class SimulationView {
  constructor(data) {
    Object.assign(this, data);
  }

  fish(index) {
    return fishOf(this, index);
  }

  nearestAliveSameSchool(index) {
    return nearestAliveSameSchoolOf(this, index);
  }
}

/**
 * The view of an engine running in this thread: the arrays are the engine's
 * own, so this costs one small object per frame and no copying.
 */
export function viewOf(simulation) {
  return new SimulationView({
    count: simulation.count,
    config: simulation.config,
    derived: simulation.derived,
    schoolRanges: simulation.schoolRanges,
    relationMatrix: simulation.relationMatrix,
    schoolIds: simulation.schoolIds,
    positions: simulation.positions,
    velocities: simulation.velocities,
    alive: simulation.alive,
    corpse: simulation.corpse,
    corpseAge: simulation.corpseAge,
    energy: simulation.energy,
    panic: simulation.panic,
    locomotionStates: simulation.locomotionStates,
    avoidanceDirections: simulation.avoidanceDirections,
    avoidanceHits: simulation.avoidanceHits,
    recenterTimers: simulation.recenterTimers,
    pursuitTargets: simulation.pursuitTargets,
    hiddenFish: simulation.hiddenFish,
    locomotionPreview: simulation.locomotionPreview,
    events: simulation.events,
    plankton: {
      count: simulation.food?.count ?? 0,
      uses: simulation.food?.uses ?? null,
      positions: simulation.food?.positions ?? null,
    },
  });
}

/** Arrays a snapshot carries; each is copied and transferred to the page. */
const SNAPSHOT_ARRAYS = [
  'schoolIds',
  'positions',
  'velocities',
  'alive',
  'corpse',
  'corpseAge',
  'energy',
  'panic',
  'locomotionStates',
  'avoidanceDirections',
  'avoidanceHits',
  'recenterTimers',
  'pursuitTargets',
];

/**
 * A snapshot of the engine that can cross a thread boundary: copies of the
 * arrays, plus the small values the readers need. The config is not sent —
 * the page already has it and hands it back in viewFromSnapshot.
 */
export function snapshotOf(simulation, { metrics = null } = {}) {
  const data = {
    count: simulation.count,
    derived: simulation.derived,
    schoolRanges: simulation.schoolRanges,
    relationMatrix: simulation.relationMatrix,
    hiddenFish: simulation.hiddenFish,
    locomotionPreview: simulation.locomotionPreview,
    events: simulation.events.slice(),
    plankton: {
      count: simulation.food?.count ?? 0,
      uses: simulation.food?.uses?.slice() ?? null,
      positions: simulation.food?.positions?.slice() ?? null,
    },
    metrics,
  };
  simulation.events.length = 0;
  const transfers = [];
  for (const key of SNAPSHOT_ARRAYS) {
    const array = simulation[key];
    if (!array) continue;
    data[key] = array.slice();
    transfers.push(data[key].buffer);
  }
  if (data.plankton.uses) transfers.push(data.plankton.uses.buffer);
  if (data.plankton.positions) transfers.push(data.plankton.positions.buffer);
  return { data, transfers };
}

/** The page's side: a snapshot plus the config it already holds. */
export function viewFromSnapshot(data, config) {
  return new SimulationView({ ...data, config });
}
