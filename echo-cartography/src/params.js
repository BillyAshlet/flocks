// All tunable parameters.
//
// On scale: this project moved from "the player chases fish" to "a swarm maps
// a trench", and the scene grew to 96×40×64 (four times the original
// 24×10×16). Every length-type parameter is scaled up by SCALE = 3 --
// staying proportional is the key: the panic contagion tuning (the ratio of
// panicRadius to alignmentRadius) depends on the ratio, not on absolute
// values, so scaling everything by the same factor keeps that measured result
// exactly as it was.
const SCALE = 3;

// The survey bounding box. It is also the mission boundary for frontier
// exploration -- voxels outside the box are marked "outside the mission"
// rather than "unknown", otherwise frontiers in the open directions never run
// out and the mission can never end.
//
// Scaled up by 1.5, but the detection range is deliberately not scaled with
// it. Scaling everything proportionally has zero effect on coverage -- the
// fish, the rays and the terrain all multiplied by k leaves relative coverage
// unchanged, the picture just gets bigger. For "there is more than can be
// surveyed" to become a real problem, the scene has to grow relative to the
// sensor.
export const TANK = { width: 144, height: 52, depth: 88 };

// Simulation clock. speed=4 means physics advances at 4× (a few extra fixed
// steps per frame). Rendering still follows the screen refresh; what is sped
// up is the swarm and the mapping, not "faking it by skipping frames".
export const SIM = {
  speed: 1, // 1..16
};

export const FLOCK = {
  count: 260,
  // -- the three boid rules (radii already ×SCALE) --
  separationRadius: 0.55 * SCALE,
  separationWeight: 0.8,
  alignmentRadius: 1.5 * SCALE,
  alignmentWeight: 0.45,
  cohesionRadius: 2.2 * SCALE,
  cohesionWeight: 0.4,
  // -- kinematics --
  cruiseSpeed: 2.6 * SCALE,
  maxSpeed: 4.2 * SCALE,
  maxForce: 5.2 * SCALE,
  turnSpeed: 2.8,
  maxPitchDegrees: 55,
  // Field of view: a neighbor beyond this angle is not seen. That is why the
  // panic wave is directional.
  fovDegrees: 300,
  // -- boundaries and obstacle avoidance --
  wallMargin: 0.6 * SCALE,
  edgeSoftness: 2.4 * SCALE,
  boundaryWeight: 2.2,
  // Obstacle avoidance weight (direction now from the ray fan, see SENSOR)
  obstacleWeight: 6.0,
  // Number of subgroups. During frontier exploration the terminal gives each
  // subgroup its own target.
  // One shared target for the whole swarm = turning 260 devices into 1:
  // measured swarm radius 42.4 → 14.5, and point cloud output dropped 24%
  // instead. Cohesion only acts inside a group, otherwise they are pulled
  // back together right after spreading out.
  groupCount: 4,
  // -- wander noise --
  wanderWeight: 0.35,
  // Negative-buoyancy descent bias (the P0 cold start for PLAN). Physically
  // this is just ballast making it sink.
  //
  // The weight has to be smaller than the obstacle avoidance weight, or the
  // swarm gets flattened against the trench floor.
  // It solves the "behavior" half (the swarm does not drift up into open
  // water); the "map" half needs the ceiling of the bounding box -- unknown
  // voxels above the swarm are still frontier by definition, and a descent
  // bias alone cannot remove them.
  // A single mechanism covers both the entry descent and depth keeping:
  // force ∝ (working depth − current depth).
  //
  // Tried "constant descent, decaying to zero once at depth" and both ends
  // were wrong: left on all the time, the swarm crawls along the trench floor
  // hugging the terrain; after it decays to zero, it drifts back up above the
  // shelf, which amounts to leaving the trench.
  // Real survey AUVs do not work that way either -- they trim to the working
  // depth and then hold it.
  descentWeight: 0, // no continuous depth hold; ALTITUDE band instead
  // The working depth is a fraction of the bounding box height rather than a
  // hard-coded number -- as soon as the scene grows, a hard-coded number
  // suddenly lands in the open water above the trench and the whole swarm
  // surfaces out of it.
  workingDepth: -52 * 0.25, // trench top 0, floor −26, so mid-trench
  depthBand: 11, // how far off depth before the hold force maxes out
};

// Ray fan sensor -- the core addition in M0.
//
// It replaces the old closest-point-on-box repulsion field. That thing could
// avoid obstacles, but it was not a measurement: with no ray there is no
// origin→hit segment, so the input to free-space carving does not exist at
// all.
export const SENSOR = {
  // Detection range. It has to be larger than the distance at which obstacle
  // avoidance takes effect, otherwise the device has already turned away
  // before it records anything and the map fills with holes. Constraint:
  // range > obstacle avoidance distance > individual radius.
  range: 4.0 * SCALE,
  // Five rays: center plus up, down, left and right.
  // One ray only looks straight ahead, so a wall coming from the side cannot
  // be avoided, and a single trigger yields only one measurement; five rays
  // give five measurements from different angles at once -- which is exactly
  // what the endpoint decision kernel needs.
  rayCount: 5,
  fanHalfAngleDeg: 25,
  // Emission guard time. Without it, 60 Hz × 260 devices × 5 rays ≈ 78000
  // events per second and the bandwidth advantage goes straight to zero --
  // this is not an optimization, it is the precondition for the core claim to
  // hold.
  // Calibration: speed ~2.6, voxel 0.5 m → crossing one cell takes 0.19 s →
  // 5 Hz is already enough not to miss a cell, so 10 Hz leaves a factor of 2
  // of headroom. That also happens to be the order of a real sonar's sample
  // rate.
  emitHz: 10,
  // Open water does not trigger obstacle avoidance, so that space would sit
  // at "unknown" forever. A low-rate clear event fills it in -- a real
  // sonar's "no echo" is itself a valid measurement.
  clearHz: 1,
  // A ray that misses is a vote for "head into the empty space".
  // Normal repulsion alone stalls against a wall hit head on (the repulsion
  // is antiparallel to the heading, so the net effect is only slowing down).
  openVote: 0.45,
};

// The former heritage-lab PANIC_PARAMS, semantics kept item by item.
export const PANIC = {
  // Threat perception radius: how far away a fish gets scared (knob #1)
  // The original 3.0 was measured as the optimum in the 24×10×16 tank: it has
  // to be small for there to be a ripple to see -- when the radius is too
  // large, nearly every fish "sees the threat directly" and social
  // transmission has no room to work.
  // Measured: at the peak of 83 panicking fish, 65 (78%) were infected by a
  // neighbor; at radius 6.0 only 45% were.
  // After the scene grew it is scaled by SCALE, which preserves its ratio to
  // alignmentRadius.
  panicRadius: 3.0 * SCALE,
  // Hysteresis latch for a direct threat: it latches only above On, and
  // releases only after falling below Off
  directOn: 0.55,
  directOff: 0.25,

  // Social signal
  signalRadiusFactor: 1.0, // × alignmentRadius
  signalThreshold: 0.35,
  signalDecayTime: 0.35,
  holdTime: 0.5,
  // Refractory period: without it, a pulse reflects back and forth through
  // the school and never stops
  refractoryTime: 1.4,

  // Panic rise and fall (fast up, slow down) -- contagion speed (knob #3)
  riseTime: 0.08,
  fallTime: 0.75,

  // Emergency alignment channel
  alignmentSourceBoost: 10.0,
  alignmentReceiverBoost: 1.5,
  alignmentReceiverMax: 2.5,
  emergencyAlignmentWeight: 4.0,

  // Kinematic consequences of panic -- escape strength (knob #2)
  escapeWeight: 2.4,
  speedBoost: 0.65,
  panicTurnBoost: 1.2,
  cohesionDrop: 0.6,
  // Flee in the direction opposite the predator's predicted position
  escapePredictionTime: 0.15,
};

// Large creature -- replaces the former player, roaming on its own as a
// moving threat source.
//
// Dropping the player is not just "removing one control mode": what this
// project sets out to show is that the swarm completes the survey
// autonomously, with no human intervention, and holding a fish in your hand
// turns the whole argument into a performance.
// It also lines up exactly with the dynamic disturbance source in the
// proposal (large deep-sea creatures), so the purpose of the panic mechanism
// is "keep the devices from being smashed by a big fish", not "let the player
// ram the fish".
export const CREATURE = {
  count: 2,
  speed: 9,
  turnRate: 0.35, // rate of wander direction change; lower is lazier
  bodyLength: 7,
  bodyRadius: 1.5,
  margin: 6, // how far from the box wall it starts turning
  // Terrain avoidance. There was none at all before -- the big fish went
  // straight through the rock.
  avoidMargin: 4.5, // extra clearance beyond the body surface
  avoidWeight: 6, // must beat wander noise, or it scrapes in along the rock
};

// Individual body shape. Fusiform -- the low-drag shape shared by real fish
// and underwater vehicles.
export const AGENT = {
  bodyLength: 1.15,
  bodyRadius: 0.2,
  tailLength: 0.5,
  tailRadius: 0.3,
};

// ── Palette ────────────────────────────────────────────────────
// Warm dark tones with ochre accents, taken from the visual language of
// Downstream.
// The key trade-off: bone white for the calm state rather than cyan-blue --
// the deep sea has no color of its own, blue-green is an "aquarium"
// association, and this project is about "places people cannot reach". Warm
// gray is closer to the texture of sonar imaging.
export const PALETTE = {
  // flocks: the light warm page from the rest of the site, instead of the
  // original dark deep-sea palette. The swarm is blue at rest and gold when
  // panicked, the predators red, as the species colors elsewhere on the site.
  background: '#eee9df',
  fog: '#eee9df',
  fogNear: 140,
  fogFar: 520,

  ambient: '#ffffff',
  keyLight: '#fffaf0',
  rimLight: '#c9b89c',

  terrain: '#cdbfa8',
  terrainEdge: '#8f8068',
  floor: '#d8ccb8',
  boundsEdge: '#9a9384',

  agentCalm: '#5b90c4',
  agentPanic: '#d8a03c',
  agentGlowCalm: '#8fb3d6',
  agentGlowPanic: '#e6b766',
  creature: '#bc4b3f',
  creatureEdge: '#8e3a30',
  creatureGlowCore: '#bc4b3f',
  creatureGlowHalo: '#e0a19a',

  accent: '#b07a24',
  text: '#3d3a35',
  textDim: '#716c62',
};



// ── Virtual altitude (terminal horizontal walls + weak negative buoyancy) ──
// No prior knowledge of the terrain → do not hard-code workingDepth.
//
// Measured lesson: shrinking [yMin,yMax] into a "working layer" and adding an
// attraction to the middle of the band freezes the school into a horizontal
// pancake stuck to the upper layer -- a soft wall only constrains, it does
// not create a motive to descend, and the pull toward the midline cannot beat
// cohesion.
//
// Current strategy (ceiling + weak negative buoyancy):
//   - yMax: virtual ceiling for deployment / the sea surface (a mission
//     constraint, not terrain)
//   - yMin: near the bottom of the mission box, only there to stop them
//     dropping out of the simulation; by default opened up close to absMin
//   - sinkWeight: weak negative buoyancy, provides the motive to descend; the
//     real floor is held by obstacle rays plus hard collision
//   - centerWeight: 0 by default (the knob is kept for comparison, not
//     recommended)
//
// Note: TANK is the mission survey box, not objective terrain. The soft
// boundary / hard clamp at the tank walls means "do not swim out of the
// mission area".
export const ALTITUDE = {
  enabled: true,
  // Put the lower bound right near the bottom of the mission box, do not
  // shrink it into a "working layer"
  yMin: -52 * 0.5 + 2,
  yMax: 24,
  softMargin: 3,
  softWeight: 2.0, // mainly the ceiling; too strong at the edge jitters
  hard: false, // a hard clamp tends to flatten the swarm to one layer
  // Weak negative buoyancy (not depth hold). Around 0.5: enough to descend,
  // still not enough to beat obstacleWeight=6
  sinkWeight: 0.55,
  // Attraction to the middle of the band: off by default. Turning it on
  // reintroduces a "preferred depth" and tends to make them clump
  centerWeight: 0,
  // No need to expand while the band already covers the mission height; the
  // switch is kept for when the band is narrowed by hand
  autoExpand: false,
  expandEvery: 8,
  expandStep: 3,
  absMin: -52 * 0.5 + 1.5,
  absMax: 52 * 0.5 - 1.5,
};

// ── Exploration phase machine (ROAM → PLAN → FRONTIER → RECALL) ────────────
//
// Division of labor:
//   ROAM     free roaming, uses coarse plan-view coverage to decide whether
//            to spread out
//   PLAN     fine plan-view fill-in: go wherever fine coverage is thin (no
//            notion of columns or pits)
//   FRONTIER frontier refinement: the free ∩ unknown boundary
//   RECALL   assignable frontiers exhausted
//
// Coarse plan view is only used for ROAM→PLAN; fine plan view only for
// PLAN→FRONTIER.
// Starting the frontier phase early holds things back (measured), so PLAN
// sits in between, and autoStart is on by default.

export const PLAN = {
  // Fine plan view for the decision: bin=1 → 0.6 m. The frontier phase gnaws
  // at vertical walls; plan view is there to fill in horizontal coverage.
  bin: 1,
  // The absolute threshold is very high and only serves as a shortcut exit
  // for "almost fully covered"; the main exit is "stops rising".
  autoStartCoverage: 0.995,
  // Fine coverage stalling = the horizontal plane has been squeezed dry
  // (places that cannot be reached will not falsely count as done)
  stallWindow: 20, // ~10s
  stallDelta: 0.0003, // stricter: only counts as stalled once nearly flat
  stallMinCoverage: 0.93, // a stall only counts above 93% horizontal
  maxDuration: 150,
  minCluster: 2,
  // B: into the interior of the thin (poorly covered) areas + prefer large
  // blocks or ones that can hug solid + dwell and probe up and down
  dwellSeconds: 4.5,
  occAdjacentBonus: 1.45, // thin areas touching solid first (tops, pit edges)
  sizePower: 0.65, // weights larger blocks
  distSoft: 28, // scale of the soft distance penalty (meters)
  maxAssignDist: 95, // too-far thin areas are skipped (likely unreachable)
  seekWeight: 2.0,
  verticalWeight: 1.0,
  verticalSpread: 10,
  // amplitude of the up-down sweep while dwelling (meters)
  probeAmplitude: 8,
  probePeriod: 3.2,
  // Sensor in PLAN: still forward-facing, but the vertical half-angle is
  // widened to fill in horizontal tops and floors; left and right open a bit
  sensorFanHalfDeg: 30,
  sensorFanVertHalfDeg: 42,
  maxPitchDegrees: 72,
  separationScale: 0.9,
  cohesionScale: 0.22,
  alignmentScale: 0.65,
  // the heat map gets finer with each phase
  displayBin: {
    roam: 8,
    plan: 1,
    frontier: 1,
    recall: 1,
  },
};

// ── Recall / return ──────────────────────────────────────
// Once the mission ends at sufficient resolution: first gather with high
// cohesion, then rise, leave and hide.
export const RECALL = {
  // Formation: high cohesion + one slot per fish; hover first, no automatic
  // hiding
  cohesionScale: 3.6,
  separationScale: 0.25,
  alignmentScale: 0.9,
  seekWeight: 2.2, // pull to each slot, has to be clearly visible
  // how long the formation takes to form (then "confirm recall" exits)
  formSeconds: 6,
  // formation height: margin below the top of the box
  exitMargin: 2.5,
  // spacing between slots (meters)
  spacing: 2.0,
  // radius within which an arrived fish counts as at rest; outside it, or in
  // danger, it returns to its slot or avoids
  holdRadius: 1.2,
  // radius at which it starts braking and locking its heading near the slot
  settleRadius: 3.5,
  brakeWeight: 6.0, // braking on arrival
  returnWeight: 2.6, // back to the slot after avoiding a big fish
  // on the way back it can move near normally; what really has to be locked
  // is the linear and angular velocity after the formation is up
  approachSpeed: 2.4,
  // turn multiplier after forming up (no predator); 0 = heading frozen
  holdTurnScale: 0,
  // Frontier → recall (a compromise):
  //  1) assignable clusters exhausted = the classic ending
  //  2) only a few noise clusters left + a short stall = close enough to
  //     exhausted (no need to wait for zero)
  //  3) a total time limit as a backstop
  frontierStallWindow: 12, // ~6s, enough to see the trend
  frontierStallDelta: 3,
  frontierMinTime: 14, // gnaw at it seriously for at least this long
  frontierSoftMaxClusters: 2, // ≤2 assignable clusters and flat → about done
  frontierMaxTime: 75, // longer than this forces forming up, no dragging on
};

export const FRONTIER = {
  enabled: false, // manual override; in auto the phase machine sets it
  // Automatic phase machine: ROAM → PLAN → FRONTIER
  autoStart: true,
  // ── ROAM → PLAN: coarse plan view ──
  autoStartCoverage: 0.85,
  stallWindow: 6,
  stallDelta: 0.004,
  stallMinCoverage: 0.5,
  period: 0.5,
  minCluster: 3, // raised a bit: tiny noise clusters are not assignable
  seekWeight: 0.45,
  separationScale: 0.75,
  cohesionScale: 0.5,
  alignmentScale: 0.85,
};

// ── Mapping ────────────────────────────────────────────────────
export const MAP = {
  // Voxel edge length. At 0.6 m the 144×52×88 scene is 240×87×147 ≈ 3.07
  // million cells, and storing the evidence as Int16 is about 6 MB -- fixed,
  // it does not grow with mission length.
  // Any finer and the point cloud gets too dense to see the structure; any
  // coarser and narrow gaps cannot be told apart.
  voxel: 0.6,

  // How far the hit point is pulled back along the ray into free space, in
  // units of voxel edge length.
  // 0.5: back off half a cell, specifically to kill the deterministic bias
  // where an AABB surface is sucked to the inside of the solid by floor.
  // 0: off (the old behavior). >1 pushes the whole shell outside the surface,
  // and narrow gaps may come out empty.
  surfaceBias: 0.5,

  hitWeight: 3, // endpoint score
  kernelWeight: 1, // score for the six face neighbors (endpoint kernel)
  // Free-space carving: every cell a ray passes through loses score.
  // This is the only counter-evidence that can subtract evidence back out,
  // and it is the entire basis for separating dynamic targets -- the seabed
  // cannot be passed through so it is never subtracted, while a swimming
  // creature is passed through by later rays as soon as it moves away.
  // The weight has to be smaller than hitWeight (if one pass-through erased a
  // surface, quantization error at grazing angles would chew holes in real
  // walls), but it cannot be much smaller -- this ratio is exactly "how many
  // times more pass-throughs than hits it takes to erase a dynamic target".
  // At 3:1 it was measured as too weak to erase anything.
  carveWeight: 2,

  occupiedThreshold: 4, // net evidence at which a cell is confirmed solid
  // evidence <= this counts as free (negative after carving); 0 stays unknown.
  freeThreshold: -1,

  // The cap is what decides whether the map can forget old things; it is not
  // a minor guard against overflow.
  //
  // It used to be 512: a big fish lingering for 40 scans accumulated 120 of
  // evidence, after which it took 60 pass-throughs to drop back below the
  // threshold -- measured, after 40 pass-throughs it was still sitting firmly
  // on the map.
  // If evidence can accumulate without limit, a dynamic target that stays put
  // long enough becomes permanent.
  //
  // The tight clamp on log-odds in a standard occupancy grid exists for
  // exactly this reason:
  // bound the confidence, and only then can the map change its mind.
  // Capped at 20: once saturated, about 9 pass-throughs are enough to erase
  // it, while solid is never passed through.
  evidenceMin: -12,
  evidenceMax: 20,

  // Point cloud limit. Past it nothing new is added -- better to draw fewer
  // points than to let the buffer overrun.
  maxPoints: 400000,
  pointSize: 0.42,

  // ── Coarse grid: for frontier exploration ────────────────────────
  //
  // Frontier detection cannot run over 3.07 million voxels. But this is not
  // only a performance problem: at fine resolution the "frontier count" is
  // essentially the surface area of the explored space -- the more is
  // explored, the larger that surface, so it only rises and never falls, and
  // the recall condition is never met.
  // Measured: within 60 seconds the frontier count went from 23,000 to
  // 145,000, with no sign of coming back down.
  //
  // The coarse grid asks a different question: "has this chunk been surveyed
  // or not".
  // That is the granularity the terminal actually needs for macro decisions,
  // and the only one that can be exhausted.
  // 8³ voxels merge into one cell → 30×11×19 = 6270 cells, and scanning all
  // of them takes microseconds.
  coarseFactor: 8,
  // what fraction of the voxels in a coarse cell must be confirmed free
  // before the chunk counts as "passable"
  coarseFreeRatio: 0.06,
};

// ── Camera ─────────────────────────────────────────────────────
export const CAMERA = {
  // Overview: orbit camera, drag with the mouse to rotate, scroll to zoom.
  // The pitch has to be steep enough to see into the trench -- too flat a
  // view is blocked entirely by the near trench wall.
  // flocks: farther back, so the canyon fits beside the terminal panel.
  overviewDistance: 240,
  overviewPitch: 0.7,
  // Follow: click any individual to enter, Esc to leave
  followBack: 4.5,
  followUp: 1.6,
  followLag: 6,
};
