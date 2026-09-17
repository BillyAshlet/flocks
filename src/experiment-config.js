const TAU = Math.PI * 2;

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function school({
  id,
  name,
  color,
  count,
  size,
  targetNeighbors,
  radii,
  podCount,
  centerX,
}) {
  return {
    id,
    name,
    color,
    count,
    size,
    targetNeighbors,
    // Neighbor radii, one set per species: how close a neighbor must be to
    // push away from (separation), to match heading with (alignment) and to
    // move toward (cohesion). Set directly by default, as in the original
    // aquarium. With perception.radiusMode 'neighbors' the cohesion radius is
    // computed from targetNeighbors instead (see deriveSchool).
    separationRadius: radii.separation,
    alignmentRadius: radii.alignment,
    cohesionRadius: radii.cohesion,
    // Number of pods this school is split into (used when spawnMode is 'pods').
    // Fish see each other within a pod but not across pods; merging and
    // splitting afterwards is left to the boids rules.
    podCount,
    cruiseSpeed: 0.23,
    maxSpeed: 0.46,
    turnSpeed: 2.8,
    metabolismMultiplier: 1,
    // Grazing multiplier. The actual grazing rate is this × size^grazeSizeExponent
    // (see ecology.grazeSizeExponent). Hunting fish first is guaranteed in code:
    // a fish locked onto prey does not graze (see _updateEcology). A pure
    // predator can use 0. Earlier this held three hand-set rates (1 / 0.25 / 0.01
    // for small / medium / large), which encoded ecological niche rather than
    // physics; the niche should emerge from the energy budget, not be assigned.
    grazeRate: 1,
    separationWeight: 0.8,
    alignmentWeight: 0.45,
    cohesionWeight: 0.4,
    spawnRegion: {
      centerX,
      centerY: 0,
      centerZ: 0,
      // The spawn blob must be clearly larger than the school's separationRadius,
      // or every fish starts inside its neighbours' repulsion radius and the
      // school is blown apart on the first frame. Earlier the large school had the
      // largest separation radius (0.189) but the smallest blob (0.22), so 64% of
      // its fish repelled each other and the school ran the wrong way at start.
      radius: id === 'red' ? 0.45 : 0.36,
    },
    // All schools head along the longest axis (x). Earlier the small and medium
    // schools headed along z, which is only 1/2.5 the length of x, so they set
    // off in formation and hit the wall within seconds.
    initialHeading: { x: 1, y: 0, z: 0 },
  };
}

export const DEFAULT_EXPERIMENT_CONFIG = Object.freeze({
  runtime: {
    project: 'aquarium',
    mode: 'steady',
    seed: 1001,
    // Pick a new seed on every restart. Turn off for identical, reproducible runs.
    randomizeSeed: true,
    timeScale: 1,
    fixedDt: 1 / 60,
    initialSpawnAttempts: 16,
    spawnMode: 'pods',
  },
  schools: [
    school({
      id: 'gold',
      name: 'Gold',
      color: '#d8a03c',
      count: 400,
      size: 1,
      targetNeighbors: 8,
      // These equal what targetNeighbors gave before radii could be set
      // directly, so switching the default did not change any school.
      radii: { separation: 0.139, alignment: 0.335, cohesion: 0.628 },
      podCount: 10,
      centerX: 0.32,
    }),
    school({
      id: 'blue',
      name: 'Blue',
      color: '#5b90c4',
      count: 200,
      size: 1.5,
      targetNeighbors: 8,
      radii: { separation: 0.176, alignment: 0.422, cohesion: 0.791 },
      podCount: 8,
      centerX: -0.05,
    }),
    school({
      id: 'red',
      name: 'Red',
      color: '#bc4b3f',
      // The large school needs enough members. With too few, its cohesion radius
      // never reaches the average spacing and it cannot find its own kind.
      count: 80,
      size: 2.25,
      targetNeighbors: 5,
      radii: { separation: 0.204, alignment: 0.489, cohesion: 0.918 },
      podCount: 8,
      centerX: -0.38,
    }),
  ],
  tank: {
    preset: 'aquarium',
    width: 6,
    height: 3.6,
    depth: 2.4,
    wallMargin: 0.035,
  },
  perception: {
    // How each school's cohesion radius is set.
    //   'fixed'      the school's cohesionRadius, as set. The original aquarium
    //                worked this way, and a radius you set is a radius you can
    //                reason about.
    //   'neighbors'  computed from targetNeighbors: the radius of a sphere that
    //                would hold that many fish if the school were spread evenly
    //                through the tank. The reach then follows density: more
    //                fish or a smaller tank shrink it, so the expected number
    //                of neighbors stays put when the school or tank changes.
    // Separation and alignment radii are always set directly. They used to be
    // fixed fractions of the cohesion radius (0.222 and 0.533); that tied three
    // forces that act differently to one number.
    radiusMode: 'fixed',
    // Floor on the computed cohesion radius, in body lengths ('neighbors' only).
    minNeighborRadiusFactor: 3,
    detectionLengthFactor: 0.511,
    // The view cone gates only alignment and cohesion; separation stays
    // omnidirectional (lateral line). As the original notes, a forward cone
    // breaks pairwise symmetry, so heading changes have to propagate through the
    // school instead of syncing instantly, and that is what makes it read as a school.
    fovDegrees: 300,
    // 'inverse' is the original default: close-range repulsion far stronger than linear.
    separationFalloff: 'inverse',
    // Mean spacing within a pod = this × separationRadius. 1.5 is neither crowded nor sparse.
    podSpacingFactor: 1.5,
    // Cohesion distance falloff. 'inverse' lets each fish be dominated by its own
    // pod, so pods persist instead of merging on first contact; 'uniform' is the
    // classic unweighted boids centroid.
    cohesionFalloff: 'inverse',
    // Spread of initial headings (0 = whole school in formation, 1 = close to random).
    spawnHeadingJitter: 0.6,
    // spawn-and-variety: 0.6 keeps size personality without collapsing medium/large sociality.
    crossSeparationScale: 0.15,
  },
  relations: {
    // Master switch for predation. When false, every pair of schools is
    // treated as peers and no capture happens, whatever their sizes.
    enabled: true,
    k: 1.35,
    // Upper bound of the prey size window. At 1.667, large/small = 2.25 fell
    // outside the window, so large fish could not see small fish and had only
    // the medium school to eat. 2.5 puts small fish back on their menu.
    KMax: 2.5,
    hysteresis: 0.1,
    pursuitWeight: 1.05,
    burstRadiusFactor: 0.75,
    burstWeight: 2.2,
    // Give up on a chase when no new closest distance is reached within this many
    // seconds, and do not pick that fish again until it leaves burstRadius.
    giveUpSeconds: 2,
    // Tie band for choosing a target: two fish whose distances differ by less than
    // this fraction of the farther one count as equally near, and the one more on
    // the way wins. While chasing, a new candidate must beat this band to switch.
    targetTieTolerance: 0.1,
    // Sensing radius of the first layer (steering toward the prey school's
    // centroid) = detectionLength × this. Around 6 lets predators approach
    // smoothly from afar instead of lunging at close range. Raising the large
    // school's targetNeighbors also raised detectionLength, so the factor had to
    // come down: otherwise the radius exceeds the tank under the performance
    // preset, predators always know where prey is, and the smooth approach is lost.
    schoolSenseFactor: 5,
    evadeWeight: 1.3,
    // Escape force x (1 + evadePanicBoost x panic).
    evadePanicBoost: 1,
    evadeLateralWeight: 0.32,
    panicRiseRate: 4.5,
    panicDecayRate: 1.35,
    // Panic pulse and latch parameters.
    directOn: 0.55,        // Threshold at which a direct threat latches on
    directOff: 0.25,       // Release threshold (hysteresis against flicker)
    holdTime: 0.5,         // How long panic stays pinned at full after a scare; scattering depends on it
    refractoryTime: 1.4,   // Refractory period, so a pulse cannot echo through the school forever
    signalDecayTime: 0.35, // Exponential decay time constant of the alarm pulse
    // Emergency alignment: the panic heading travels on its own channel, not
    // through the normal alignment average; otherwise twenty calm neighbours
    // would dilute the one fish that saw the danger.
    signalRadiusFactor: 0.8,
    signalThreshold: 0.35,
    // Detail switch (tier 6): the emergency heading channel together with its
    // source and receiver gains. Off: panic still spreads, but neighbours do
    // not copy the frightened fish's heading.
    emergencyAlignment: true,
    emergencyAlignmentWeight: 4,
    alignmentSourceBoost: 10,
    // Receiver gain on alignment: 1 + boost x neighbor panic x own panic,
    // capped at alignmentReceiverMax.
    alignmentReceiverBoost: 1.5,
    alignmentReceiverMax: 2.5,
    // Escape aims at the predator's predicted position, not its current one.
    escapePredictionTime: 0.15,
    // A frightened school spreads out (flash expansion) rather than tightening,
    // the direction verified in the original.
    cohesionDrop: 0.6,
    panicTurnBoost: 1.2,
    // Below this panic level no escape force is applied, so the tank does not
    // jitter slightly forever.
    panicMinTrigger: 0.06,
    // Panic segments. Low and high panic are two different behaviours, not just
    // two strengths:
    //
    //   low:  emergency alignment stays on, so the whole school turns sharply together
    //   high: emergency alignment is off and cohesion collapses, so each fish flees
    //         on its own (scatter)
    //
    // Without segments, alignment keeps pulling fish that want to scatter back
    // into line, and independent fleeing never appears.
    //
    // A latch rather than a single threshold: panic must rise above
    // panicScatterEnter to enter the high segment and fall below panicScatterExit
    // to leave it. A single threshold flickers near the boundary and looks like
    // twitching. The two values are far apart so the low segment is actually
    // visible; otherwise a viewer only ever sees the scatter, never the more
    // striking coordinated turn.
    // Detail switch (tier 6). Off: no high-panic segment, so cohesion only
    // drops by cohesionDrop and emergency alignment is never suppressed.
    scatterLatch: true,
    panicScatterEnter: 0.75,
    panicScatterExit: 0.45,
  },
  locomotion: {
    burstFactor: 1.35,
    panicSpeedFactor: 1.15,
    // Sprinting stiffens the body and limits turning, so fish overshoot. This is
    // the line between moving like a fish and moving like a particle.
    burstTurnFactor: 0.4,
    // From the original: fish do not swim straight up and down like submarines.
    // Pitch beyond this angle is pushed back.
    maxPitchDegrees: 57,
    // Social weights are scaled by this while sprinting (break formation to strike,
    // but stay within the same force range).
    burstSocialSuppression: 0.3,
    // Extra force budget multiplier while sprinting.
    burstForceBudget: 1.6,
    maxForce: 5.2,
    interceptLookAhead: 1.3,
    // Wall and obstacle avoidance, from the original boids: a ray along the
    // heading; when it hits within avoidanceLookAhead, turn in
    // avoidanceAngleStep increments until the way is clear.
    avoidanceWeight: 1.0,
    avoidanceLookAhead: 0.23,
    avoidanceAngleStep: 18,
    // Compensation, not physics: after the ray hits, wait recenterDelay
    // seconds, then pull weakly toward the tank centre for recenterDuration
    // seconds. Keeps fish from sliding along walls forever.
    recenterWeight: 0.5,
    recenterDelay: 0.5,
    recenterDuration: 5,
    wanderWeight: 0.08,
    // Foraging steer, weighted by hunger rather than proximity: a fed fish ignores
    // food entirely and only a hungry fish leaves the school. The school still
    // looks like a school most of the time, formation breaks only near
    // starvation, and the break-up itself becomes a visible symptom of hunger.
    // A strong proximity-weighted pull would wreck the boids look.
    forageWeight: 0.9,
  },
  traits: {
    enabled: true,
    sizeSpeedPenaltyExponent: 0.2,
    minSustainedSpeedFactor: 0.55,
    sizeTurnPenaltyExponent: 0.55,
    minTurnFactor: 0.45,
  },
  ecology: {
    enabled: true,
    energyCapacity: 2 / 3,
    // Energy capacity scales with size. Earlier it was a global constant, so large
    // and small fish had the same tank while drain grows as size^basalSizeExponent;
    // the net effect was that larger fish starved sooner, the opposite of a big
    // fish living long on one meal. A hand-set constant was quietly encoding a
    // size effect (that size does not affect storage).
    //
    // Time to starve ∝ size^(capacitySizeExponent − basalSizeExponent):
    //   0.75  every size lasts equally long
    //   1.5   large fish clearly outlast hunger
    // The difference between the two exponents is the net effect of size on
    // endurance, which makes it a meaningful knob.
    capacitySizeExponent: 1.5,
    initialEnergyRatio: 0.82,
    // Per-fish jitter of initial energy, as a ± fraction. 0 gives every fish of a
    // school the same start, so they all starve at the same moment.
    initialEnergyJitter: 0.25,
    // Three-way split of every meal: the eater, nearby fish, and the whole school.
    //
    // Earlier there was only an even split across the school, while plankton was
    // a global scalar. Every fish already had the same intake, so that split only
    // smoothed out RNG noise; the spatial unfairness it was meant to fix did not
    // exist yet. Unfairness appeared once plankton became spatial: fish that swim
    // into a cloud eat their fill and fish at the tail get nothing.
    //
    // The nearby share does most of the work, and it is split by spatial radius
    // among fish of the eater's own species: a pod eats well together or starves
    // together, so pods dying off one after another emerges instead of being
    // assigned by id. The school-wide share is only a small floor, so one
    // unlucky fish does not starve while the rest of its school is fed. Nothing
    // crosses species, since that would pass what prey eat on to predators; the
    // nearby share once did, going to any fish in the radius, so a predator
    // swimming beside grazing prey was fed by them.
    energyShareLocal: 0.3,
    energyShareSchool: 0.2,
    // Radius for the nearby share. A fixed value, not the cohesion radius: that one
    // is derived from targetNeighbors and drifts with density, and the sharing
    // range should not follow the social scale.
    energyShareRadius: 0.25,
    // Derived from energy balance, not guessed. Requirement: a size-1.5 fish with
    // metabolism multiplier 1 exactly breaks even when food is plentiful:
    //     basalRate × 1.5^0.75 == maxIntakePerFish (0.04)
    //     basalRate = 0.04 / 1.3554 = 0.0295
    // A fish with lower drain then has margin, one with double drain starves, and
    // a neutral fish just clears the bar: survival in the middle and death toward
    // the edges, without hand tuning.
    // Provisional value.
    basalRate: 0.0295,
    basalSizeExponent: 0.75,
    burstMetabolicRate: 0.035,
    captureEnergyPerSize: 1,
    // Last-ditch sprint. Entered when energy falls below desperationEnterRatio:
    // sprinting is no longer blocked by minBurstEnergyRatio, speed rises, and only
    // part of the cost is paid on the spot. The rest becomes debt, settled over
    // the following debtSettleSeconds.
    //
    // It fixes a real deadlock: once metabolism scaled with size, large fish soon
    // fell below 1/3 energy and got stuck in "too weak to sprint, so no catch, so
    // hungrier". A hungry predator should try harder, not give up.
    //
    // Three rules keep it from being free:
    // 1. Eating does not erase debt. A fish that caught prey through a last-ditch
    //    sprint is still worse off than one that never needed it, so the cost
    //    carries forward. Debt that drains energy to 0 also kills.
    // 2. Latch: after one use, energy must return to desperationRecoverRatio
    //    before it can be used again.
    // 3. Fixed duration that cannot be extended. It should have a dramatic shape
    //    (you have N seconds), not be a resource to manage.
    // If the timer runs out before recovery, the fish is exhausted: speed ×
    // desperationExhaustedSpeed until it recovers.
    minBurstEnergyRatio: 1 / 3,
    // Detail switches (tier 6): the last-ditch sprint, and paying for part of
    // it later as debt.
    desperation: true,
    desperationDebt: true,
    desperationEnterRatio: 0.22,
    desperationRecoverRatio: 0.6,
    desperationSeconds: 6,
    desperationSpeedBoost: 1.25,
    // A desperate fish also pursues harder, not just faster. pursuitWeight is the
    // force applied whenever prey is near, and amplifying it is what makes the
    // fish actually lunge; with extra speed alone, a fast fish that does not turn
    // toward prey just darts around.
    desperationPursuitBoost: 2,
    desperationCostShare: 0.5,
    debtSettleSeconds: 10,
    desperationExhaustedSpeed: 0.8,
    // Buoyant acceleration of a corpse (real dead fish mostly float on gas left in
    // the swim bladder). Not a velocity: together with corpseDrag it sets the
    // terminal speed = acceleration / drag. 0.15 / 2.4 ≈ 0.0625 is close to the
    // earlier fixed rate of 0.06, but adds a natural acceleration phase.
    corpseRiseAccel: 0.15,
    // Time constant of the death transition: colour fades to grey, the body rolls
    // belly-up, and the rise eases in.
    corpseFadeTime: 1.6,
    // Exponential decay rate of leftover momentum after death (glides, then stops).
    corpseDrag: 2.4,
    // Whether sprint metabolism scales with size (Kleiber). false = the old flat constant.
    burstSizeScaled: true,
    // Energy of one full plankton bite. This used to be the product of three
    // knobs that all scaled the same gain (planktonEnergy 0.06, a feeding
    // multiplier 2.2 and plankton.energyConversion 1), so moving any one of
    // them looked like a separate mechanism. They are folded into this value.
    planktonEnergy: 0.132,
    /**
     * Exponent of grazing capacity with body size. This one number replaces three
     * hand-set niche constants.
     *
     * Grazing capacity follows gill and mouth area, so larger fish graze more, not
     * less, while drain follows size^0.75. So:
     *
     *     grazing income / drain  ∝  size^(grazeSizeExponent − 0.75)
     *
     * At 0.45 the difference is −0.3: a size-2.25 fish covers only about 79% of its
     * costs by grazing and has to hunt for the rest. How much large fish depend on
     * hunting is this exponent difference, not a hand-entered 0.01.
     *
     * Predation does not depend on hunger: pursuit is driven by the relation
     * matrix, so large fish hunt even when plankton is available. Energy only
     * decides whether they can still sprint.
     */
    grazeSizeExponent: 0.45,
    // Fish graze only when energy is below capacity × this ratio. This gate keeps
    // plankton sustainable: without it, consumption was 64/s against 18/s
    // regrowth, so plankton was eaten out in seconds and never recovered.
    grazeHungerRatio: 0.8,
    // Three bands, not two. With a single threshold fish are almost always looking
    // for food and the school never forms. So:
    //   > 80%   fed: ignore food entirely and school normally
    //   50–80%  graze in passing (grazeHungerRatio) but do not leave the school
    //   < 50%   go looking for food (this value), steering harder the hungrier the fish
    seekHungerRatio: 0.5,
  },
  plankton: {
    enabled: true,
    halfSaturationFraction: 0.2,
    // Measured in bites: the most bites one feeding can take. One particle holds
    // usesPerParticle bites.
    maxIntakePerFish: 4,
    // How far a fish can reach to eat plankton, the core scale of spatial plankton.
    // It sets both the sampling radius for how much food is nearby and the cell
    // size of the spatial grid. It must be on the order of particle spacing: at
    // 0.12 the measured distance from fish to the nearest particle was 0.14–0.39,
    // so fish kept brushing past without a single bite; at 0.3 the foraging hit
    // rate is 54%. The other half of the reason is that the check is a static point
    // test, while a fish swims 0.2–0.5 during one foraging attempt (about 1 s), so
    // a larger radius approximates a sweep.
    // Provisional value.
    forageRadius: 0.3,
    // How far food can be seen (for seeking). Much larger than the eating radius,
    // or a fish with nothing right beside it has no direction at all. Also the
    // cell size of the spatial grid: seeking scans the 3×3×3 block, and eating
    // scans the same 27 cells and filters by the smaller forageRadius.
    senseRadius: 0.6,
    // How many bites one particle holds. 1 = first come, first served, one fish
    // per particle (the fiercest competition).
    usesPerParticle: 3,
    // How long an eaten-out particle takes to come back whole. Much easier to reason
    // about than a growth rate.
    regrowSeconds: 20,
    visualCount: 1200,
    // sizeAttenuation is on, so this is in world units. Earlier 0.01 was only
    // about 1.5 px at the normal camera distance, which is why no plankton was
    // visible at all. 0.03 is about 4.5 px and equals the fish body length
    // (bodyLength 0.03), roughly the size of a corpse.
    pointSize: 0.03,
    // Dark green keeps plankton looking like natural algae in deep blue water and
    // distinct from the blue, orange and red schools.
    color: '#14532d',
    opacity: 0.75,
  },
  visual: {
    bodyLength: 0.03,
    bodyRadius: 0.008,
    radialSegments: 6,
    opacity: 0.92,
    // Banking: turn rate → roll angle around the fish's forward axis.
    bankingGain: 12,
    maxRollDegrees: 35,
    bankingSmoothing: 0.18,
  },
  capture: {
    // Incidental swallowing. Prey whose size ratio exceeds KMax is too small to be
    // worth chasing: the relation is ignore, so there is no lock-on and no pursuit.
    // But a whale that does not chase a single krill still swallows the krill
    // that drift into its mouth.
    //
    // Without this, large fish have only one food source (the school whose size
    // ratio falls in [k, KMax]), and once metabolism scaled with size that one
    // source was not enough. With it, a large fish crossing a small-fish school
    // feeds at a steady low rate, which is also what filter feeding looks like.
    //
    // No lock-on or chase, only a check for actual contact. It is throttled by
    // satiety (a fed fish stops eating), not by a cooldown.
    incidentalCapture: true,
    captureLengthFactor: 0.5,
  },
  captureVfx: {
    enabled: true,
    particleCount: 12,
    density: 2,
    spawnRadius: 0.055,
    spawnInterval: 0.02,
    lifetime: 0.75,
    cubeSize: 0.022,
    cubeColor: '#1e4f8c',
    upwardSpeed: 0.12,
    reverseVelocityFactor: 0.4,
    radialSpeed: 0.22,
    biteGlowEnabled: true,
    // The glow is a normally blended translucent sphere that reads by being
    // brighter than the background. White suits deep water; on a near-white
    // background it is invisible and should be a dark ink colour instead.
    biteGlowColor: '#ffffff',
    biteGlowRadius: 0.28,
    biteGlowDuration: 0.45,
    biteGlowStrength: 0.85,
    biteGlowFalloff: 2.4,
    // Feeding effect: a small cluster of light debris drifting upward.
    feedEnabled: true,
    feedParticles: 3,
    feedSpeed: 0.12,
    feedSize: 0.009,
    feedLifetime: 0.32,
    feedColor: '#14532d',
    maxParticles: 600,
  },
  starvationVfx: {
    particleCount: 10,
    density: 1.6,
    spawnRadius: 0.05,
    spawnInterval: 0.03,
    cubeSize: 0.02,
    cubeColor: '#8B5A2B',
    radialSpeed: 0.035,
    gravity: -0.05,
    persist: true,
  },
  distanceField: {
    enabled: true,
    cellSize: 0.05,
    paddingCells: 1,
    analyticRefineDistance: 0.1,
  },
  obstacles: {
    enabled: false,
    ringA: {
      enabled: true,
      type: 'ring',
      x: -0.42,
      y: 0.05,
      z: 0,
      rotationX: 0,
      rotationY: 0.22,
      rotationZ: 0,
      width: 0.82,
      height: 0.72,
      thickness: 0.08,
      holeDiameter: 0.48,
      frameDepth: 0.12,
    },
    ringB: {
      enabled: true,
      type: 'ring',
      x: 0.46,
      y: -0.08,
      z: -0.06,
      rotationX: 0,
      rotationY: -0.28,
      rotationZ: 0,
      width: 0.76,
      height: 0.68,
      thickness: 0.08,
      holeDiameter: 0.48,
      frameDepth: 0.12,
    },
    blockA: {
      enabled: true,
      type: 'box',
      x: -0.68,
      y: -0.54,
      z: 0.28,
      rotationX: 0,
      rotationY: 0.15,
      rotationZ: 0,
      width: 0.42,
      height: 0.28,
      depth: 0.34,
    },
    blockB: {
      enabled: true,
      type: 'box',
      x: 0.58,
      y: -0.48,
      z: 0.22,
      rotationX: 0,
      rotationY: -0.22,
      rotationZ: 0,
      width: 0.54,
      height: 0.2,
      depth: 0.3,
    },
  },
  camera: {
    fov: 45,
    globalNear: 0.01,
    focusDistance: 0.3,
    focusHeight: 0.09,
    closeupDistance: 0.11,
    closeupSide: 0.07,
    closeupHeight: 0.04,
    closeupFov: 30,
    lookAhead: 0.2,
    positionDamping: 12,
    orientationDamping: 9,
  },
});

export function createDefaultConfig() {
  return deepClone(DEFAULT_EXPERIMENT_CONFIG);
}

function entry(path, group, label, applyMode, options = {}) {
  return { path, group, label, applyMode, ...options };
}

const scalarEntries = [
  entry('runtime.project', '项目', 'project', 'rebuildScene', {
    options: {
      '主项目 · 水族馆': 'aquarium',
      '子实验 · 生态淘汰': 'ecology',
    },
  }),
  entry('runtime.mode', 'Advanced · Runtime', 'mode', 'reset', {
    options: {
      'Predation · permanent death': 'steady',
      Ecology: 'ecology',
    },
  }),
  entry('runtime.randomizeSeed', '运行', '每局随机种子', 'live'),
  entry('runtime.seed', '运行', 'seed', 'reset', {
    min: 1,
    max: 999999,
    step: 1,
  }),
  entry('runtime.timeScale', '运行', 'time scale', 'live', {
    min: 0,
    max: 4,
    step: 0.1,
  }),
  entry('runtime.fixedDt', 'Advanced · Runtime', 'fixed dt', 'reset', {
    min: 1 / 240,
    max: 1 / 20,
    step: 1 / 240,
  }),
  entry(
    'runtime.initialSpawnAttempts',
    'Advanced · Runtime',
    'initial spawn attempts',
    'rebuildScene',
    {
      min: 1,
      max: 100,
      step: 1,
    }
  ),
  entry('runtime.spawnMode', '运行', 'spawn mode', 'reset', {
    options: {
      '分小群（fission-fusion）': 'pods',
      '全缸随机': 'random',
      '整群一团': 'cluster',
    },
  }),
  entry('tank.preset', '缸体', 'preset', 'rebuildScene', {
    options: {
      Aquarium: 'aquarium',
      Ecology: 'ecology',
      Custom: 'custom',
    },
  }),
  entry('tank.width', '缸体', 'width', 'rebuildScene', {
    min: 1,
    max: 12,
    step: 0.05,
  }),
  entry('tank.height', '缸体', 'height', 'rebuildScene', {
    min: 0.6,
    max: 7.2,
    step: 0.05,
  }),
  entry('tank.depth', '缸体', 'depth', 'rebuildScene', {
    min: 0.4,
    max: 4.8,
    step: 0.05,
  }),
  entry(
    'tank.wallMargin',
    'Advanced · Tank',
    'wall margin · 硬边界',
    'live',
    {
      min: 0,
      max: 0.2,
      step: 0.005,
    }
  ),
  entry(
    'perception.minNeighborRadiusFactor',
    '感知',
    'min radius / body',
    'reset',
    { min: 1, max: 8, step: 0.1 }
  ),
  entry('perception.radiusMode', '感知', 'cohesion radius from', 'reset', {
    options: { 'radius as set': 'fixed', 'target neighbors': 'neighbors' },
  }),
  entry(
    'perception.detectionLengthFactor',
    '感知',
    'hunt / panic radius × cohesion',
    'live',
    { min: 0.1, max: 2, step: 0.01 }
  ),
  entry('perception.fovDegrees', '感知', '视锥角度', 'live', {
    min: 60,
    max: 360,
    step: 5,
  }),
  entry('perception.separationFalloff', '感知', '分离衰减', 'live', {
    options: { Inverse: 'inverse', Linear: 'linear', InvLog: 'invlog' },
  }),
  entry('perception.podSpacingFactor', '感知', '小群内间距 ×', 'reset', {
    min: 0.6,
    max: 4,
    step: 0.05,
  }),
  entry('perception.cohesionFalloff', '感知', 'cohesion 衰减', 'live', {
    options: { 'Inverse（小群可维持）': 'inverse', 'Uniform（经典 boids）': 'uniform' },
  }),
  entry('perception.spawnHeadingJitter', '感知', '出生朝向散布', 'reset', {
    min: 0,
    max: 1.5,
    step: 0.05,
  }),
  entry(
    'perception.crossSeparationScale',
    '跨鱼群作用',
    'cross separation radius / size',
    'live',
    { min: 0.02, max: 0.5, step: 0.01 }
  ),
  entry('relations.enabled', '关系', 'predation enabled', 'live'),
  // At or below k, KMax means "no upper edge" (relationForRatio), so a slider
  // that crosses k turns hunting on, off, then on again. k tops out at 2, so a
  // floor just above that keeps the window a window.
  entry('relations.KMax', '关系', '猎物体型窗口上界', 'live', {
    min: 2.01,
    max: 6,
    step: 0.01,
  }),
  entry('relations.k', '关系', '捕食体型阈值 k', 'live', {
    min: 1.01,
    max: 2,
    step: 0.01,
  }),
  entry('relations.hysteresis', '关系', 'hysteresis δ', 'live', {
    min: 0,
    max: 0.5,
    step: 0.01,
  }),
  entry('relations.pursuitWeight', '关系', '捕猎凝聚 weight', 'live', {
    min: 0,
    max: 4,
    step: 0.05,
  }),
  entry(
    'relations.burstRadiusFactor',
    '关系',
    'burst radius × 大范围',
    'live',
    { min: 0.05, max: 1, step: 0.01 }
  ),
  entry('relations.burstWeight', '关系', 'burst weight', 'live', {
    min: 0,
    max: 20,
    step: 0.25,
  }),
  entry('relations.evadeWeight', '关系', 'evade weight', 'live', {
    min: 0,
    max: 4,
    step: 0.05,
  }),
  entry('relations.evadePanicBoost', '关系', 'evade × panic boost', 'live', {
    min: 0,
    max: 4,
    step: 0.05,
  }),
  entry(
    'relations.evadeLateralWeight',
    '关系',
    'evade lateral',
    'live',
    { min: 0, max: 2, step: 0.02 }
  ),
  entry('relations.panicRiseRate', '关系', 'panic rise /s', 'live', {
    min: 0.1,
    max: 20,
    step: 0.1,
  }),
  entry('relations.panicDecayRate', '关系', 'panic decay /s', 'live', {
    min: 0.1,
    max: 10,
    step: 0.05,
  }),
  entry('relations.schoolSenseFactor', '关系', '群体感知 ×', 'live', {
    min: 1,
    max: 12,
    step: 0.25,
  }),
  entry('relations.giveUpSeconds', '关系', 'give up after (s)', 'live', {
    min: 0.1,
    max: 10,
    step: 0.1,
  }),
  entry('relations.targetTieTolerance', '关系', 'target tie band', 'live', {
    min: 0,
    max: 0.5,
    step: 0.01,
  }),
  entry('relations.signalRadiusFactor', '关系', '应急信号半径 ×', 'live', {
    min: 0.1,
    max: 3,
    step: 0.05,
  }),
  // Named "alarm", not "emergency": from tier 4 this threshold gates the
  // panic pulse a fish hears, long before emergency alignment exists at tier 6
  // (where it also gates which senders count as panicked).
  entry('relations.signalThreshold', '关系', '警报信号阈值', 'live', {
    min: 0,
    max: 1,
    step: 0.01,
  }),
  entry('relations.directOn', '关系', '直接威胁闩上', 'live', {
    min: 0,
    max: 1,
    step: 0.01,
  }),
  entry('relations.directOff', '关系', '直接威胁松开', 'live', {
    min: 0,
    max: 1,
    step: 0.01,
  }),
  entry('relations.holdTime', '关系', '惊吓保持时长', 'live', {
    min: 0,
    max: 3,
    step: 0.05,
  }),
  entry('relations.refractoryTime', '关系', '不应期', 'live', {
    min: 0,
    max: 6,
    step: 0.05,
  }),
  entry('relations.signalDecayTime', '关系', '脉冲衰减时间', 'live', {
    min: 0.05,
    max: 2,
    step: 0.01,
  }),
  entry('relations.emergencyAlignment', '关系', 'emergency alignment enabled', 'live'),
  entry('relations.emergencyAlignmentWeight', '关系', '应急对齐权重', 'live', {
    min: 0,
    max: 12,
    step: 0.1,
  }),
  entry('relations.alignmentSourceBoost', '关系', '应急航向优先度', 'live', {
    min: 0,
    max: 30,
    step: 0.5,
  }),
  entry('relations.alignmentReceiverBoost', '关系', '恐慌时倾听增益', 'live', {
    min: 0,
    max: 6,
    step: 0.05,
  }),
  entry('relations.alignmentReceiverMax', '关系', '倾听增益上限', 'live', {
    min: 1,
    max: 6,
    step: 0.05,
  }),
  entry('relations.escapePredictionTime', '关系', '逃逸预判时间', 'live', {
    min: 0,
    max: 1,
    step: 0.01,
  }),
  entry('relations.cohesionDrop', '关系', 'panic → cohesion 下降', 'live', {
    min: 0,
    max: 1,
    step: 0.01,
  }),
  entry('relations.panicTurnBoost', '关系', 'panic → 转向加成', 'live', {
    min: 0,
    max: 4,
    step: 0.05,
  }),
  entry('relations.panicMinTrigger', '关系', 'panic 触发下限', 'live', {
    min: 0,
    max: 0.5,
    step: 0.01,
  }),
  entry('relations.scatterLatch', '关系', 'scatter latch enabled', 'live'),
  entry('relations.panicScatterEnter', '关系', '炸开·进入恐慌值', 'live', {
    min: 0,
    max: 1,
    step: 0.01,
  }),
  entry('relations.panicScatterExit', '关系', '炸开·退出恐慌值', 'live', {
    min: 0,
    max: 1,
    step: 0.01,
  }),
  entry('locomotion.burstTurnFactor', '运动', '冲刺转向 ×', 'live', {
    min: 0.05,
    max: 1,
    step: 0.01,
  }),
  entry('locomotion.maxPitchDegrees', '运动', '最大俯仰角', 'live', {
    min: 5,
    max: 90,
    step: 1,
  }),
  entry('locomotion.burstSocialSuppression', '运动', '冲刺时社交压低 ×', 'live', {
    min: 0,
    max: 1,
    step: 0.01,
  }),
  entry('locomotion.burstForceBudget', '运动', '冲刺力预算 ×', 'live', {
    min: 1,
    max: 6,
    step: 0.05,
  }),
  entry('locomotion.burstFactor', '运动', 'pursuit burst ×', 'live', {
    min: 1,
    max: 3,
    step: 0.01,
  }),
  entry(
    'locomotion.panicSpeedFactor',
    '运动',
    'panic speed ×',
    'live',
    { min: 1, max: 3, step: 0.01 }
  ),
  entry('locomotion.maxForce', '运动', 'max steering', 'live', {
    min: 0.05,
    max: 10,
    step: 0.01,
  }),
  entry(
    'locomotion.interceptLookAhead',
    '运动',
    'intercept look-ahead',
    'live',
    { min: 0, max: 5, step: 0.05 }
  ),
  entry('locomotion.avoidanceWeight', '运动', 'avoidance weight', 'live', {
    min: 0,
    max: 8,
    step: 0.05,
  }),
  entry(
    'locomotion.avoidanceLookAhead',
    '运动',
    'avoidance look-ahead (m)',
    'live',
    { min: 0, max: 1, step: 0.01 }
  ),
  entry(
    'locomotion.avoidanceAngleStep',
    '运动',
    'avoidance angle step (°)',
    'live',
    { min: 1, max: 90, step: 1 }
  ),
  entry('locomotion.recenterWeight', '运动', 'recenter weight', 'live', {
    min: 0,
    max: 2,
    step: 0.01,
  }),
  entry('locomotion.recenterDelay', '运动', 'recenter delay (s)', 'live', {
    min: 0,
    max: 10,
    step: 0.1,
  }),
  entry('locomotion.recenterDuration', '运动', 'recenter duration (s)', 'live', {
    min: 0,
    max: 10,
    step: 0.1,
  }),
  entry('locomotion.forageWeight', '运动', '觅食转向 weight', 'live', {
    min: 0,
    max: 5,
    step: 0.05,
  }),
  entry('ecology.seekHungerRatio', '生态能量', '开始找食的能量比', 'live', {
    min: 0,
    max: 1,
    step: 0.01,
  }),
  entry('locomotion.wanderWeight', '运动', 'wander weight', 'live', {
    min: 0,
    max: 1,
    step: 0.01,
  }),
  entry('traits.enabled', 'Trait Coupling', '体型耦合启用', 'live'),
  entry(
    'traits.sizeSpeedPenaltyExponent',
    'Trait Coupling',
    'size → speed exponent',
    'live',
    { min: 0, max: 2, step: 0.01 }
  ),
  entry(
    'traits.minSustainedSpeedFactor',
    'Trait Coupling',
    'min sustained speed ×',
    'live',
    { min: 0.1, max: 1, step: 0.01 }
  ),
  entry(
    'traits.sizeTurnPenaltyExponent',
    'Trait Coupling',
    'size → turn exponent',
    'live',
    { min: 0, max: 2, step: 0.01 }
  ),
  entry(
    'traits.minTurnFactor',
    'Trait Coupling',
    'min turn ×',
    'live',
    { min: 0.1, max: 1, step: 0.01 }
  ),
  entry('ecology.enabled', '生态能量', '耐力系统启用', 'reset'),
  entry(
    'ecology.energyCapacity',
    '生态能量',
    'energy capacity',
    'reset',
    { min: 0.05, max: 20, step: 0.05 }
  ),
  entry('ecology.capacitySizeExponent', '生态能量', '能量罐→体型指数', 'reset', {
    min: 0,
    max: 3,
    step: 0.05,
  }),
  entry(
    'ecology.initialEnergyRatio',
    '生态能量',
    'initial energy',
    'reset',
    { min: 0.01, max: 1, step: 0.01 }
  ),
  entry('ecology.initialEnergyJitter', '生态能量', '初始能量抖动 ±', 'reset', {
    min: 0,
    max: 0.8,
    step: 0.01,
  }),
  entry('ecology.energyShareLocal', '生态能量', '分给附近的比例', 'live', {
    min: 0,
    max: 1,
    step: 0.01,
  }),
  entry('ecology.energyShareSchool', '生态能量', '分给同族全场的比例', 'live', {
    min: 0,
    max: 1,
    step: 0.01,
  }),
  entry('ecology.energyShareRadius', '生态能量', '共享半径', 'live', {
    min: 0.02,
    max: 2,
    step: 0.01,
  }),
  entry('ecology.basalRate', '生态能量', 'basal drain /s', 'live', {
    min: 0,
    max: 1,
    step: 0.001,
  }),
  entry(
    'ecology.basalSizeExponent',
    '生态能量',
    'basal size exponent',
    'live',
    { min: 0, max: 3, step: 0.01 }
  ),
  entry(
    'ecology.burstMetabolicRate',
    '生态能量',
    'burst drain /s',
    'live',
    { min: 0, max: 2, step: 0.005 }
  ),
  entry(
    'ecology.captureEnergyPerSize',
    '生态能量',
    'capture energy / prey size',
    'live',
    { min: 0, max: 10, step: 0.05 }
  ),
  entry(
    'ecology.minBurstEnergyRatio',
    '生态能量',
    'min energy to burst',
    'live',
    { min: 0, max: 1, step: 0.01 }
  ),
  entry('ecology.corpseFadeTime', '生态能量', '死亡渐变时长', 'live', {
    min: 0.1,
    max: 8,
    step: 0.1,
  }),
  entry('ecology.corpseDrag', '生态能量', '尸体阻尼', 'live', {
    min: 0,
    max: 12,
    step: 0.1,
  }),
  entry('ecology.burstSizeScaled', '生态能量', '冲刺代谢按体型缩放', 'live'),
  entry('ecology.desperation', '生态能量', 'last-ditch sprint enabled', 'live'),
  entry('ecology.desperationDebt', '生态能量', 'sprint debt enabled', 'live'),
  entry('ecology.desperationEnterRatio', '生态能量', '孤注一掷·进入能量比', 'live', { min: 0, max: 1, step: 0.01 }),
  entry('ecology.desperationRecoverRatio', '生态能量', '孤注一掷·解锁能量比', 'live', { min: 0, max: 1, step: 0.01 }),
  entry('ecology.desperationSeconds', '生态能量', '孤注一掷·时长 (s)', 'live', { min: 0.5, max: 60, step: 0.5 }),
  entry('ecology.desperationSpeedBoost', '生态能量', '孤注一掷·速度倍率', 'live', { min: 1, max: 3, step: 0.05 }),
  entry('ecology.desperationPursuitBoost', '生态能量', '孤注一掷·追猎倍率', 'live', { min: 1, max: 6, step: 0.1 }),
  entry('ecology.desperationCostShare', '生态能量', '孤注一掷·当场付的比例', 'live', { min: 0, max: 1, step: 0.05 }),
  entry('ecology.debtSettleSeconds', '生态能量', '债的结算时长 (s)', 'live', { min: 0.5, max: 120, step: 0.5 }),
  entry('ecology.desperationExhaustedSpeed', '生态能量', '力竭速度倍率', 'live', { min: 0.1, max: 1, step: 0.05 }),
  entry('ecology.corpseRiseAccel', '生态能量', '浮尸浮力加速度', 'live', {
    min: 0,
    max: 1.5,
    step: 0.01,
  }),
  entry('ecology.planktonEnergy', '生态能量', '浮游单次能量', 'live', {
    min: 0,
    max: 1,
    step: 0.005,
  }),
  entry('ecology.grazeSizeExponent', '生态能量', '滤食能力→体型指数', 'live', {
    min: 0,
    max: 2,
    step: 0.05,
  }),
  entry('ecology.grazeHungerRatio', '生态能量', '觅食饥饿阈值', 'live', {
    min: 0.1,
    max: 1,
    step: 0.01,
  }),
  entry('plankton.enabled', '浮游资源', 'plankton enabled', 'live'),
  entry(
    'plankton.halfSaturationFraction',
    '浮游资源',
    'half saturation',
    'live',
    { min: 0.001, max: 1, step: 0.001 }
  ),
  entry(
    'plankton.forageRadius',
    '浮游资源',
    '进食半径',
    'reset',
    { min: 0.02, max: 1, step: 0.01 }
  ),
  entry('plankton.senseRadius', '浮游资源', '感知半径', 'reset', {
    min: 0.05,
    max: 4,
    step: 0.05,
  }),
  entry('plankton.usesPerParticle', '浮游资源', '每颗可吃次数', 'reset', {
    min: 1,
    max: 20,
    step: 1,
  }),
  entry('plankton.regrowSeconds', '浮游资源', '重置时间 (s)', 'live', {
    min: 0.5,
    max: 120,
    step: 0.5,
  }),
  entry(
    'plankton.maxIntakePerFish',
    '浮游资源',
    '每次最多吃几口',
    'live',
    { min: 0, max: 40, step: 1 }
  ),
  entry(
    'plankton.visualCount',
    '浮游资源',
    'visible particles',
    'rebuildScene',
    { min: 0, max: 10000, step: 1 }
  ),
  entry('plankton.pointSize', '浮游资源', 'particle size', 'live', {
    min: 0.001,
    max: 0.08,
    step: 0.001,
  }),
  entry('plankton.color', '浮游资源', 'particle color', 'live'),
  entry('plankton.opacity', '浮游资源', 'particle opacity', 'live', {
    min: 0.05,
    max: 1,
    step: 0.01,
  }),
  entry('visual.bodyLength', 'Advanced · Visual', 'body length', 'rebuildScene', {
    min: 0.005,
    max: 0.12,
    step: 0.001,
  }),
  entry('visual.bodyRadius', 'Advanced · Visual', 'body radius', 'rebuildScene', {
    min: 0.002,
    max: 0.04,
    step: 0.001,
  }),
  entry(
    'visual.radialSegments',
    'Advanced · Visual',
    'radial segments',
    'rebuildScene',
    { min: 3, max: 16, step: 1 }
  ),
  entry('visual.bankingGain', '视觉', '侧倾强度', 'live', {
    min: 0,
    max: 40,
    step: 0.5,
  }),
  entry('visual.maxRollDegrees', '视觉', '最大侧倾角', 'live', {
    min: 0,
    max: 80,
    step: 1,
  }),
  entry('visual.bankingSmoothing', '视觉', '侧倾平滑', 'live', {
    min: 0.02,
    max: 1,
    step: 0.01,
  }),
  entry('visual.opacity', 'Advanced · Visual', 'fish opacity', 'live', {
    min: 0.1,
    max: 1,
    step: 0.01,
  }),
  entry('capture.incidentalCapture', '捕食', '顺路吞食（太小的猎物）', 'live'),
  entry(
    'capture.captureLengthFactor',
    '捕食',
    'capture length ×',
    'live',
    { min: 0.1, max: 2, step: 0.01 }
  ),
  entry('captureVfx.enabled', '捕获特效', '特效启用', 'live'),
  entry('captureVfx.biteGlowColor', '捕获特效', '咬合脉冲颜色', 'live'),
  entry('captureVfx.particleCount', '捕获特效', '碎片数量上限', 'live', {
    min: 1,
    max: 24,
    step: 1,
  }),
  entry('captureVfx.density', '捕获特效', '碎片密度', 'live', {
    min: 0,
    max: 12,
    step: 0.1,
  }),
  entry('captureVfx.spawnRadius', '捕获特效', '生成半径', 'live', {
    min: 0,
    max: 0.3,
    step: 0.002,
  }),
  entry('captureVfx.spawnInterval', '捕获特效', '碎片间隔', 'live', {
    min: 0,
    max: 0.2,
    step: 0.002,
  }),
  entry('captureVfx.lifetime', '捕获特效', '碎片寿命', 'live', {
    min: 0.05,
    max: 3,
    step: 0.05,
  }),
  entry('captureVfx.cubeSize', '捕获特效', '碎片尺寸', 'live', {
    min: 0.002,
    max: 0.08,
    step: 0.001,
  }),
  entry('captureVfx.cubeColor', '捕获特效', '碎片颜色', 'live'),
  entry('captureVfx.upwardSpeed', '捕获特效', '上浮速度', 'live', {
    min: 0,
    max: 2,
    step: 0.01,
  }),
  entry(
    'captureVfx.reverseVelocityFactor',
    '捕获特效',
    '捕食者反向速度',
    'live',
    { min: 0, max: 2, step: 0.01 }
  ),
  entry('captureVfx.radialSpeed', '捕获特效', '径向速度', 'live', {
    min: 0,
    max: 2,
    step: 0.01,
  }),
  entry('captureVfx.biteGlowEnabled', '捕获特效', '咬合闪光', 'live'),
  entry('captureVfx.biteGlowRadius', '捕获特效', '闪光半径', 'live', {
    min: 0.01,
    max: 1,
    step: 0.01,
  }),
  entry('captureVfx.biteGlowDuration', '捕获特效', '闪光时长', 'live', {
    min: 0.02,
    max: 2,
    step: 0.01,
  }),
  entry('captureVfx.biteGlowStrength', '捕获特效', '闪光强度', 'live', {
    min: 0,
    max: 3,
    step: 0.01,
  }),
  entry('captureVfx.feedEnabled', '捕获特效', '进食特效', 'live'),
  entry('captureVfx.feedParticles', '捕获特效', '进食碎屑数', 'live', {
    min: 1, max: 12, step: 1,
  }),
  entry('captureVfx.feedSpeed', '捕获特效', '进食扩散速度', 'live', {
    min: 0, max: 1, step: 0.01,
  }),
  entry('captureVfx.feedSize', '捕获特效', '进食碎屑尺寸', 'live', {
    min: 0.002, max: 0.04, step: 0.001,
  }),
  entry('captureVfx.feedLifetime', '捕获特效', '进食碎屑寿命', 'live', {
    min: 0.05, max: 2, step: 0.01,
  }),
  entry('captureVfx.feedColor', '捕获特效', '进食碎屑颜色', 'live'),
  entry('captureVfx.maxParticles', '捕获特效', '粒子上限', 'live', {
    min: 32, max: 4000, step: 8,
  }),
  entry('captureVfx.biteGlowFalloff', '捕获特效', '闪光衰减', 'live', {
    min: 0,
    max: 12,
    step: 0.1,
  }),
  entry('starvationVfx.particleCount', '耐力死亡特效', '碎片数量上限', 'live', {
    min: 1,
    max: 24,
    step: 1,
  }),
  entry('starvationVfx.density', '耐力死亡特效', '碎片密度', 'live', {
    min: 0,
    max: 12,
    step: 0.1,
  }),
  entry('starvationVfx.spawnRadius', '耐力死亡特效', '生成半径', 'live', {
    min: 0,
    max: 0.3,
    step: 0.002,
  }),
  entry('starvationVfx.spawnInterval', '耐力死亡特效', '碎片间隔', 'live', {
    min: 0,
    max: 0.2,
    step: 0.002,
  }),
  entry('starvationVfx.cubeSize', '耐力死亡特效', '碎片尺寸', 'live', {
    min: 0.002,
    max: 0.08,
    step: 0.001,
  }),
  entry('starvationVfx.cubeColor', '耐力死亡特效', '碎片颜色', 'live'),
  entry('starvationVfx.persist', '耐力死亡特效', '尸体不消失', 'live'),
  entry('starvationVfx.radialSpeed', '耐力死亡特效', '初始散射速度', 'live', {
    min: 0,
    max: 0.5,
    step: 0.001,
  }),
  entry('starvationVfx.gravity', '耐力死亡特效', '竖直加速度', 'live', {
    min: -1,
    max: 0,
    step: 0.001,
  }),
  entry('distanceField.enabled', '障碍距离场', 'distance field enabled', 'rebuildField'),
  entry('distanceField.cellSize', '障碍距离场', 'field cell size', 'rebuildField', {
    min: 0.02,
    max: 0.2,
    step: 0.005,
  }),
  entry(
    'distanceField.paddingCells',
    'Advanced · Distance Field',
    'padding cells',
    'rebuildField',
    { min: 1, max: 4, step: 1 }
  ),
  entry(
    'distanceField.analyticRefineDistance',
    '障碍距离场',
    'analytic refine distance',
    'live',
    { min: 0, max: 0.5, step: 0.005 }
  ),
  entry('obstacles.enabled', '障碍', 'map enabled', 'rebuildField'),
  entry('camera.fov', '相机', 'FOV', 'live', {
    min: 20,
    max: 100,
    step: 1,
  }),
  entry('camera.globalNear', 'Advanced · Camera', 'global near', 'live', {
    min: 0.001,
    max: 0.2,
    step: 0.001,
  }),
  entry('camera.focusDistance', '相机', '跟随后距 / size', 'live', {
    min: 0.08,
    max: 2,
    step: 0.01,
  }),
  entry('camera.focusHeight', '相机', '跟随高度 / size', 'live', {
    min: -0.5,
    max: 1,
    step: 0.01,
  }),
  entry('camera.closeupDistance', '相机', '特写后距 / size', 'live', {
    min: 0.04,
    max: 1,
    step: 0.01,
  }),
  entry('camera.closeupSide', '相机', '特写侧移 / size', 'live', {
    min: -1,
    max: 1,
    step: 0.01,
  }),
  entry('camera.closeupHeight', '相机', '特写高度 / size', 'live', {
    min: -0.5,
    max: 1,
    step: 0.01,
  }),
  entry('camera.closeupFov', '相机', '特写 FOV', 'live', {
    min: 15,
    max: 90,
    step: 1,
  }),
  entry('camera.lookAhead', '相机', 'look ahead', 'live', {
    min: 0.02,
    max: 1,
    step: 0.01,
  }),
  entry('camera.positionDamping', '相机', 'position damping', 'live', {
    min: 0.1,
    max: 40,
    step: 0.1,
  }),
  entry('camera.orientationDamping', '相机', 'orientation damping', 'live', {
    min: 0.1,
    max: 40,
    step: 0.1,
  }),
];

function schoolEntries(config) {
  return config.schools.flatMap((item, index) => {
    const p = `schools.${index}`;
    const group = `鱼群 · ${item.name}`;
    const gamePlayer =
      config.runtime?.project === 'game' && item.id === 'blue';
    // bounds and chamber are optional fields (per-school bounding box and chamber
    // isolation; see _refreshSchoolBounds / _isolateChambers in
    // experiment-simulation.js). The validator checks both ways: unregistered
    // fields are errors and so are registered fields that are missing, so
    // entries are generated only for what a school actually declares.
    const optional = [];
    if (item.chamber !== undefined) {
      optional.push(entry(`${p}.chamber`, group, '隔间', 'rebuildScene'));
    }
    if (item.bounds && typeof item.bounds === 'object') {
      for (const key of Object.keys(item.bounds)) {
        optional.push(entry(`${p}.bounds.${key}`, group, `活动范围 · ${key}`, 'live'));
      }
    }
    return [
      ...optional,
      entry(`${p}.id`, group, 'id', 'rebuildScene'),
      entry(`${p}.name`, group, 'name', 'rebuildScene'),
      entry(`${p}.color`, group, 'color', 'live'),
      entry(`${p}.count`, group, 'count', 'rebuildScene', {
        min: 1,
        max: 2000,
        step: 1,
      }),
      entry(`${p}.size`, group, 'size', 'live', {
        min: gamePlayer ? 0.18 : 0.2,
        max: gamePlayer ? 5.1 : 5,
        step: 0.01,
      }),
      entry(`${p}.podCount`, group, '小群数量', 'reset', {
        min: 1,
        max: 80,
        step: 1,
      }),
      entry(
        `${p}.targetNeighbors`,
        group,
        'target neighbors（当前鱼群）',
        'reset',
        {
          min: 1,
          max: 64,
          step: 1,
        }
      ),
      entry(`${p}.separationRadius`, group, 'separation radius', 'live', {
        min: 0.01,
        max: 2,
        step: 0.005,
      }),
      entry(`${p}.alignmentRadius`, group, 'alignment radius', 'live', {
        min: 0.01,
        max: 2,
        step: 0.005,
      }),
      entry(`${p}.cohesionRadius`, group, 'cohesion radius', 'live', {
        min: 0.01,
        max: 2,
        step: 0.005,
      }),
      entry(`${p}.cruiseSpeed`, group, 'cruise speed', 'live', {
        min: 0.01,
        max: 2,
        step: 0.01,
      }),
      entry(`${p}.maxSpeed`, group, 'max speed', 'live', {
        min: 0.01,
        max: 3,
        step: 0.01,
      }),
      entry(`${p}.turnSpeed`, group, 'turn speed', 'live', {
        min: 0.1,
        max: 12,
        step: 0.1,
      }),
      entry(`${p}.metabolismMultiplier`, group, 'metabolism ×', 'live', {
        min: gamePlayer ? 0.005 : 0.1,
        max: gamePlayer ? 25 : 5,
        step: 0.01,
      }),
      // Once labelled "carrion foraging", left over from when carcasses were
      // food. It scales how often a fish grazes plankton.
      entry(`${p}.grazeRate`, group, '浮游滤食 ×', 'live', {
        min: 0,
        max: 4,
        step: 0.01,
      }),
      entry(`${p}.separationWeight`, group, 'weight（当前鱼群）', 'live', {
        min: 0,
        max: 6,
        step: 0.05,
      }),
      entry(`${p}.alignmentWeight`, group, 'weight（当前鱼群）', 'live', {
        min: 0,
        max: 6,
        step: 0.05,
      }),
      entry(`${p}.cohesionWeight`, group, 'weight（当前鱼群）', 'live', {
        min: 0,
        max: 6,
        step: 0.05,
      }),
      ...['centerX', 'centerY', 'centerZ'].map((axis) =>
        entry(`${p}.spawnRegion.${axis}`, group, `spawn ${axis}`, 'reset', {
          min: -0.5,
          max: 0.5,
          step: 0.01,
        })
      ),
      entry(`${p}.spawnRegion.radius`, group, 'spawn radius', 'reset', {
        min: 0.02,
        max: 1.5,
        step: 0.01,
      }),
      ...['x', 'y', 'z'].map((axis) =>
        entry(`${p}.initialHeading.${axis}`, group, `heading ${axis}`, 'reset', {
          min: -1,
          max: 1,
          step: 0.05,
        })
      ),
    ];
  });
}

function obstacleEntries(config) {
  const result = [];
  for (const [key, obstacle] of Object.entries(config.obstacles)) {
    if (key === 'enabled') continue;
    const group = `障碍 · ${key}`;
    for (const [field, value] of Object.entries(obstacle)) {
      const path = `obstacles.${key}.${field}`;
      if (field === 'type') {
        result.push(
          entry(path, group, 'type', 'rebuildField', {
            options: { Ring: 'ring', Box: 'box' },
          })
        );
      } else if (typeof value === 'boolean') {
        result.push(entry(path, group, field, 'rebuildField'));
      } else {
        const rotation = field.startsWith('rotation');
        const dimension = [
          'width',
          'height',
          'depth',
          'thickness',
          'holeDiameter',
          'frameDepth',
        ].includes(field);
        result.push(
          entry(path, group, field, 'rebuildField', {
            min: rotation ? -Math.PI : dimension ? 0.01 : -3,
            max: rotation ? Math.PI : 3,
            step: rotation ? TAU / 360 : 0.01,
          })
        );
      }
    }
  }
  return result;
}

export function createParameterRegistry(config = createDefaultConfig()) {
  return [
    ...scalarEntries,
    ...schoolEntries(config),
    ...obstacleEntries(config),
  ];
}

export function getPath(root, path) {
  return path.split('.').reduce((value, key) => value?.[key], root);
}

export function setPath(root, path, value) {
  const keys = path.split('.');
  const leaf = keys.pop();
  const parent = keys.reduce((object, key) => object[key], root);
  parent[leaf] = value;
}

export function listLeafPaths(value, prefix = '') {
  if (value === null || typeof value !== 'object') return [prefix];
  const paths = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.push(...listLeafPaths(child, path));
  }
  return paths;
}

export function validateConfig(candidate) {
  const errors = [];
  const warnings = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { valid: false, errors: ['Config must be an object'], warnings };
  }
  if (!Array.isArray(candidate.schools) || candidate.schools.length < 1) {
    errors.push('At least one school is required');
    return { valid: false, errors, warnings };
  }
  let registry;
  try {
    registry = createParameterRegistry(candidate);
  } catch {
    errors.push('Config structure is incomplete');
    return { valid: false, errors, warnings };
  }
  const registered = new Set(registry.map((item) => item.path));
  for (const path of listLeafPaths(candidate)) {
    if (!registered.has(path)) errors.push(`Unregistered parameter: ${path}`);
  }
  for (const spec of registry) {
    const value = getPath(candidate, spec.path);
    if (value === undefined) {
      errors.push(`Missing parameter: ${spec.path}`);
      continue;
    }
    if (spec.options && !Object.values(spec.options).includes(value)) {
      errors.push(`${spec.path} is not an allowed value`);
    }
    if (spec.min !== undefined) {
      if (!Number.isFinite(value)) errors.push(`${spec.path} must be a finite number`);
      if (value < spec.min || value > spec.max) {
        errors.push(`${spec.path} is outside ${spec.min}–${spec.max}`);
      }
      if (spec.step === 1 && !Number.isInteger(value)) {
        errors.push(`${spec.path} must be an integer`);
      }
    }
  }
  const ids = candidate.schools?.map((item) => item.id) ?? [];
  if (new Set(ids).size !== ids.length) errors.push('School ids must be unique');
  for (const school of candidate.schools) {
    if (school.maxSpeed < school.cruiseSpeed) {
      errors.push(`${school.id}: maxSpeed must not be less than cruiseSpeed`);
    }
    const headingLength = Math.hypot(
      school.initialHeading.x,
      school.initialHeading.y,
      school.initialHeading.z
    );
    if (headingLength <= 1e-8) {
      errors.push(`${school.id}: initialHeading must not be a zero vector`);
    }
  }
  for (const [id, obstacle] of Object.entries(candidate.obstacles)) {
    if (id === 'enabled' || obstacle.type !== 'ring') continue;
    if (
      obstacle.holeDiameter >= obstacle.width ||
      obstacle.holeDiameter >= obstacle.height
    ) {
      errors.push(`${id}: holeDiameter must be smaller than the panel width and height`);
    }
  }
  if (
    candidate.locomotion?.burstFactor <=
    candidate.locomotion?.panicSpeedFactor
  ) {
    warnings.push('burstFactor ≤ panicSpeedFactor: predators may never close the distance');
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function exportConfigJson(config) {
  return JSON.stringify(config, null, 2);
}

export function importConfigJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse JSON: ${error.message}`);
  }
  const result = validateConfig(parsed);
  if (!result.valid) throw new Error(result.errors.join('\n'));
  return { config: deepClone(parsed), warnings: result.warnings };
}
