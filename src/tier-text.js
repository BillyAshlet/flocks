/**
 * The paper column's text, one entry per tier: what was added, why, what to
 * watch, and the model.
 *
 * `added` and `watch` were written against each tier's configuration in
 * tiers.js. `why` is the author's; a tier without one shows a placeholder.
 * The model describes what the code computes, not textbook boids: when the
 * code changes, this has to change with it.
 *
 * Symbols tied to a slider are written with `sym(path, tex)`. The page colors
 * them by mechanism and clicking one opens that slider. A quantity this tier
 * does not let the reader change is written as its number instead.
 *
 * A paragraph or formula may be a function of the running config, for rules
 * with several forms (separation has three falloffs): the page redraws it
 * when the form changes. `live` lists values shown under a section, read
 * from the running simulation and lit up when they change.
 */

import {
  effectiveMaxSpeed,
  effectiveTurnSpeed,
  energyCapacityFor,
  metabolicRate,
  sustainedSpeedScale,
} from './experiment-model.js';

/** A formula symbol linked to the panel parameter at `path`. */
export function sym(path, tex) {
  return `\\htmlData{param=${path}}{${tex}}`;
}

const K = sym('schools.*.targetNeighbors', 'k');
const N = sym('schools.*.count', 'N');
// Each species' three radii. In 'neighbors' mode the cohesion radius is
// computed, so it is written plain (not a slider) there.
const RS = sym('schools.*.separationRadius', 'R_s');
const RA = sym('schools.*.alignmentRadius', 'R_a');
const RC_SET = sym('schools.*.cohesionRadius', 'R_c');
const fromNeighbors = (config) => config.perception.radiusMode === 'neighbors';
const rc = (config) => (fromNeighbors(config) ? 'R_c' : RC_SET);
// Weights are upright w: an italic w reads like omega.
const WS = sym('schools.*.separationWeight', '\\mathrm{w}_s');
const WA = sym('schools.*.alignmentWeight', '\\mathrm{w}_a');
const WC = sym('schools.*.cohesionWeight', '\\mathrm{w}_c');
const LOOK = sym('locomotion.avoidanceLookAhead', '\\ell');
const STEP = sym('locomotion.avoidanceAngleStep', '\\theta');
const WAV = sym('locomotion.avoidanceWeight', '\\mathrm{w}_{\\text{wall}}');
const WRC = sym('locomotion.recenterWeight', '\\mathrm{w}_{\\text{home}}');
const TDELAY = sym('locomotion.recenterDelay', 't_{\\text{wait}}');
const TPULL = sym('locomotion.recenterDuration', 't_{\\text{pull}}');

// Tier 2
const B = sym('schools.*.size', 'b');
const U0 = sym('schools.*.cruiseSpeed', 'u_0');
const V0 = sym('schools.*.maxSpeed', 'v_0');
const OMEGA0 = sym('schools.*.turnSpeed', '\\omega_0');
const ALPHA_V = sym('traits.sizeSpeedPenaltyExponent', '\\alpha_v');
const PHI_V = sym('traits.minSustainedSpeedFactor', '\\phi_v');
const ALPHA_W = sym('traits.sizeTurnPenaltyExponent', '\\alpha_\\omega');
const PHI_W = sym('traits.minTurnFactor', '\\phi_\\omega');
// Tier 3
const KREL = sym('relations.k', 'k_{\\text{hunt}}');
const HYST = sym('relations.hysteresis', 'h');
const FD = sym('perception.detectionLengthFactor', 'f_D');
const FSENSE = sym('relations.schoolSenseFactor', 'f_{\\text{sense}}');
const FLOCK = sym('relations.burstRadiusFactor', 'f_{\\text{lock}}');
const WP = sym('relations.pursuitWeight', '\\mathrm{w}_p');
const WB = sym('relations.burstWeight', '\\mathrm{w}_b');
const TIE = sym('relations.targetTieTolerance', '\\tau');
const TGIVE = sym('relations.giveUpSeconds', 't_{\\text{give}}');
const TLEAD = sym('locomotion.interceptLookAhead', 't_{\\text{lead}}');
const SOCIAL = sym('locomotion.burstSocialSuppression', '\\gamma_{\\text{social}}');
const BURST = sym('locomotion.burstFactor', '\\beta');
const BTURN = sym('locomotion.burstTurnFactor', '\\gamma_\\omega');
const BUDGET = sym('locomotion.burstForceBudget', '\\gamma_F');
const CAPTURE = sym('capture.captureLengthFactor', 'c');
// Tier 4
const FOV = sym('perception.fovDegrees', '\\varphi');
const WE = sym('relations.evadeWeight', '\\mathrm{w}_e');
const ETA = sym('relations.signalThreshold', '\\eta');
const TREF = sym('relations.refractoryTime', 't_{\\text{ref}}');
const RISE = sym('relations.panicRiseRate', '\\lambda_{\\uparrow}');
const DECAY = sym('relations.panicDecayRate', '\\lambda_{\\downarrow}');
// Tier 5
const MU0 = sym('ecology.basalRate', '\\mu_0');
const MUB = sym('ecology.burstMetabolicRate', '\\mu_b');
const MULT = sym('schools.*.metabolismMultiplier', 'm');
const GRAZE = sym('schools.*.grazeRate', 'g');
const EP = sym('ecology.planktonEnergy', 'e_p');
const TREGROW = sym('plankton.regrowSeconds', 't_{\\text{regrow}}');
const SNEAR = sym('ecology.energyShareLocal', 's_{\\text{near}}');
const SSCHOOL = sym('ecology.energyShareSchool', 's_{\\text{school}}');
const KAPPA = sym('ecology.captureEnergyPerSize', '\\kappa');
const KMAX = sym('relations.KMax', 'k_{\\max}');
// Tier 6
const WEM = sym('relations.emergencyAlignmentWeight', '\\mathrm{w}_{\\text{copy}}');
const FSIG = sym('relations.signalRadiusFactor', 'f_{\\text{sig}}');
const BSRC = sym('relations.alignmentSourceBoost', '\\beta_{\\text{src}}');
const BRCV = sym('relations.alignmentReceiverBoost', '\\beta_{\\text{rcv}}');
const RCVMAX = sym('relations.alignmentReceiverMax', '\\beta_{\\max}');
const PIN = sym('relations.panicScatterEnter', 'p_{\\text{in}}');
const POUT = sym('relations.panicScatterExit', 'p_{\\text{out}}');
const QIN = sym('ecology.desperationEnterRatio', 'q_{\\text{in}}');
const QOUT = sym('ecology.desperationRecoverRatio', 'q_{\\text{out}}');
const TDESP = sym('ecology.desperationSeconds', 't_d');
const BDESP = sym('ecology.desperationSpeedBoost', '\\beta_d');
const PDESP = sym('ecology.desperationPursuitBoost', '\\beta_p');
const EXH = sym('ecology.desperationExhaustedSpeed', '\\epsilon');
const CNOW = sym('ecology.desperationCostShare', 'c_{\\text{now}}');
const TSETTLE = sym('ecology.debtSettleSeconds', 't_{\\text{settle}}');

// The forms a rule can take, as they are in experiment-simulation.js.
const SEPARATION_FALLOFF = {
  inverse: { g: '\\frac{1}{d_{ij}}', words: 'one over its distance' },
  linear: { g: `\\left(1 - \\frac{d_{ij}}{${RS}}\\right)`, words: 'a share that falls linearly to zero at the separation radius' },
  invlog: { g: `\\ln\\frac{${RS}}{d_{ij}}`, words: 'the log of the separation radius over its distance' },
};
const separationFalloff = (config) =>
  SEPARATION_FALLOFF[config.perception.separationFalloff] ?? SEPARATION_FALLOFF.inverse;
const inverseCohesion = (config) => config.perception.cohesionFalloff === 'inverse';

export const TIER_TEXT = {
  1: {
    added: 'Three rules per fish (separation, alignment, cohesion) and walls.',
    why: [
      "This project started from two things colliding: a water-jet ring-toss toy I played with as a kid, and Craig Reynolds' boids. I first set out to rebuild the toy as a game; I didn't carry on with the game, but the fish stayed. The toy and boids share one idea: simple rules, complex systems. Each fish follows three rules (keep a little distance, match your neighbors' direction, move toward your neighbors) and only looks at the fish around it. No leader, no choreography.",
      "The interesting part is tuning. Each rule has a strength and a reach, and small changes swing the whole school between two dead ends: too tidy, and everything locks into one regular loop; too loose, and it's just noise. What I was looking for is the narrow band in between: regular enough that you sense a pattern, irregular enough that you can't describe it in one sentence.",
      "Tuning also showed me the three rules don't do the same job. Separation mostly just keeps fish from bumping into each other. The large shapes come from alignment and cohesion.",
    ],
    watch:
      'Pods form, merge and split, though no fish knows the shape of its school.',
    model: {
      draft:
        'Draft: written from the code, not yet checked by the author.',
      sections: [
        {
          title: 'Who counts as a neighbor',
          text: [
            (config) =>
              fromNeighbors(config)
                ? "Each fish looks at the fish of its own school within three radii, one per rule. Separation and alignment radii are set for each species. The cohesion radius is computed here: it is the radius of a sphere that would hold k fish if the school were spread evenly through the tank."
                : "Each fish looks at the fish of its own school within three radii, one per rule, set for each species: the closest neighbors it pushes away from, a wider ring whose heading it matches, and the widest it moves toward. They are set separately because the three forces act differently; separation, for one, grows sharply as a neighbor comes close.",
            (config) =>
              fromNeighbors(config)
                ? "The reach then follows density: more fish or a smaller tank shrink the cohesion radius, so a fish keeps about k neighbors on average whatever the school or tank size. The switch \"cohesion radius from\" in the Cohesion folder sets it back to a radius set directly, and the formula below changes with it."
                : "The cohesion radius can instead be computed from a target number of neighbors (the switch \"cohesion radius from\" in the Cohesion folder). Then the reach follows density, so a fish keeps about the same number of neighbors when fish are added or the tank changes size. The formula below changes with the switch.",
          ],
          formulas: [
            (config) =>
              `\\mathcal{N}^{s}_i = \\{\\, j : d_{ij} < ${RS} \\,\\},\\qquad \\mathcal{N}^{a}_i = \\{\\, j : d_{ij} < ${RA} \\,\\},\\qquad \\mathcal{N}^{c}_i = \\{\\, j : d_{ij} < ${rc(config)} \\,\\}`,
            (config) =>
              fromNeighbors(config)
                ? `R_c = \\max\\!\\left(\\sqrt[3]{\\dfrac{3\\,${K}\\,V}{4\\pi\\,${N}}},\\; 0.138\\right)`
                : `${RC_SET},\\ ${RS},\\ ${RA}\\ \\text{set for each species}`,
          ],
          where: [
            { tex: '\\mathcal{N}^{s}_i,\\ \\mathcal{N}^{a}_i,\\ \\mathcal{N}^{c}_i', name: 'neighbor sets', meaning: 'the fish of i’s own school that each rule looks at' },
            { tex: 'd_{ij}', name: 'distance', meaning: 'between fish i and fish j' },
            { tex: RS, name: 'separation radius', meaning: 'how close a neighbor must be to push away from', value: ({ derived }) => derived.separationRadius },
            { tex: RA, name: 'alignment radius', meaning: 'how close a neighbor must be to match its heading', value: ({ derived }) => derived.alignmentRadius },
            { tex: RC_SET, name: 'cohesion radius', meaning: 'how far a fish looks for neighbors to move toward', value: ({ derived }) => derived.cohesionRadius },
            { tex: K, name: 'target neighbors', meaning: 'computed mode only: how many fish the cohesion radius would hold if the school were spread evenly', value: ({ school }) => school.targetNeighbors },
            { tex: N, name: 'school size', meaning: 'number of fish in the school', value: ({ school }) => school.count },
            { tex: 'V', name: 'tank volume', meaning: 'width × height × depth', value: ({ config }) => config.tank.width * config.tank.height * config.tank.depth },
            { tex: '0.138', name: 'radius floor', meaning: 'computed mode only: three body lengths; the cohesion radius never gets smaller' },
          ],
        },
        {
          title: 'The three rules',
          text: [
            (config) =>
              `Separation pushes away from each close neighbor, along the line between them, by ${separationFalloff(config).words}. Alignment is the average velocity of the neighbors. ` +
              (inverseCohesion(config)
                ? 'Cohesion points at a weighted center of the neighbors, where close fish count much more than far ones, so a fish belongs to its own pod before the school as a whole.'
                : 'Cohesion points at the plain center of the neighbors, as in classic boids.'),
          ],
          formulas: [
            (config) =>
              `\\mathbf{s}_i = -\\!\\!\\sum_{d_{ij} < ${RS}}\\! \\hat{\\mathbf{d}}_{ij}\\, ${separationFalloff(config).g},\\qquad \\hat{\\mathbf{d}}_{ij} = \\frac{\\mathbf{x}_j - \\mathbf{x}_i}{d_{ij}}`,
            `\\mathbf{a}_i = \\frac{1}{n_a}\\!\\sum_{d_{ij} < ${RA}}\\! \\mathbf{v}_j`,
            (config) =>
              inverseCohesion(config)
                ? `\\mathbf{c}_i = \\frac{\\sum_{d_{ij} < ${rc(config)}} q_j\\,\\mathbf{x}_j}{\\sum_{d_{ij} < ${rc(config)}} q_j} - \\mathbf{x}_i,\\qquad q_j = \\frac{1}{d_{ij}^{2} + (0.15\\,${rc(config)})^{2}}`
                : `\\mathbf{c}_i = \\frac{1}{n_c}\\!\\sum_{d_{ij} < ${rc(config)}}\\! \\mathbf{x}_j - \\mathbf{x}_i`,
          ],
          where: [
            { tex: '\\mathbf{s}_i', name: 'separation', meaning: 'direction fish i wants to move to get away from close neighbors' },
            { tex: '\\mathbf{a}_i', name: 'alignment', meaning: 'the average velocity of its neighbors' },
            { tex: '\\mathbf{c}_i', name: 'cohesion', meaning: 'from fish i toward the (weighted) center of its neighbors' },
            { tex: '\\mathbf{x}_i,\\ \\mathbf{x}_j', name: 'positions', meaning: 'of fish i and of a neighbor j' },
            { tex: '\\mathbf{v}_j', name: 'velocity', meaning: 'of neighbor j' },
            { tex: 'd_{ij}', name: 'distance', meaning: 'between fish i and neighbor j' },
            { tex: '\\hat{\\mathbf{d}}_{ij}', name: 'unit direction', meaning: 'from i toward j' },
            { tex: 'n_a,\\ n_c', name: 'neighbor counts', meaning: 'inside the alignment radius and inside the cohesion radius' },
            { tex: 'q_j', name: 'closeness', meaning: 'how much neighbor j counts in the cohesion center; near fish count far more' },
          ],
        },
        {
          title: 'From rules to motion',
          text: [
            "Each rule becomes a steering force the way Reynolds did it: the velocity the rule asks for, at full speed, minus the velocity the fish has now. Only a rule's direction matters, so a crowd pushes no harder than one neighbor. The weights decide how much each rule counts.",
            'The fish then turns toward the new velocity, but no faster than 2.8 rad/s and never steeper than 57° up or down. Its speed is pulled gently up toward 0.23 and never goes above 0.46. Every step is 1/60 s.',
          ],
          formulas: [
            `\\operatorname{steer}(\\mathbf{u}) = 0.46\\,\\hat{\\mathbf{u}} - \\mathbf{v}_i`,
            `\\begin{aligned}\\mathbf{F}_i ={} & ${WS}\\,\\operatorname{steer}(\\mathbf{s}_i) + ${WA}\\,\\operatorname{steer}(\\mathbf{a}_i) + ${WC}\\,\\operatorname{steer}(\\mathbf{c}_i) \\\\ & + \\mathbf{F}^{\\text{wall}}_i + \\mathbf{F}^{\\text{wander}}_i\\end{aligned}`,
            `\\mathbf{v}_i \\leftarrow \\mathbf{v}_i + \\mathbf{F}_i\\,\\Delta t,\\qquad \\mathbf{x}_i \\leftarrow \\mathbf{x}_i + \\mathbf{v}_i\\,\\Delta t`,
          ],
          where: [
            { tex: '\\operatorname{steer}(\\mathbf{u})', name: 'steering', meaning: 'the push that turns the current velocity toward direction u at top speed' },
            { tex: '\\mathbf{F}_i', name: 'total force', meaning: 'on fish i this step' },
            { tex: WS, name: 'separation weight', meaning: 'how much separation counts', value: ({ school }) => school.separationWeight },
            { tex: WA, name: 'alignment weight', meaning: 'how much alignment counts', value: ({ school }) => school.alignmentWeight },
            { tex: WC, name: 'cohesion weight', meaning: 'how much cohesion counts', value: ({ school }) => school.cohesionWeight },
            { tex: '\\mathbf{F}^{\\text{wall}}_i', name: 'wall force', meaning: 'see Walls below' },
            { tex: '\\mathbf{F}^{\\text{wander}}_i', name: 'wander', meaning: 'a small, slow wobble with weight 0.08' },
            { tex: '\\mathbf{v}_i', name: 'velocity', meaning: 'of fish i' },
            { tex: '\\Delta t', name: 'time step', meaning: '1/60 s' },
          ],
        },
        {
          title: 'Walls',
          text: [
            "A fish casts a ray ahead of it. If the ray reaches a wall, the fish tries headings turned further and further to either side until one is clear, and steers toward it, harder the closer the wall. After a hit it also waits a moment and then pulls gently toward the middle of the tank for a while, so fish do not slide along a wall forever.",
          ],
          formulas: [
            `\\mathbf{F}^{\\text{wall}}_i = ${WAV}\\,(1 + 2u)\\,\\operatorname{steer}(\\mathbf{h}),\\qquad u = 1 - \\frac{d_{\\text{hit}}}{${LOOK}}`,
            `\\mathbf{h} = \\text{first clear heading among } \\pm${STEP},\\ \\pm 2${STEP},\\ \\dots`,
            `\\begin{aligned}\\mathbf{F}^{\\text{home}}_i &= ${WRC}\\,\\operatorname{steer}(-\\mathbf{x}_i) \\\\ &\\text{on from } ${TDELAY} \\text{ to } ${TDELAY} + ${TPULL} \\text{ after a hit}\\end{aligned}`,
          ],
          where: [
            { tex: LOOK, name: 'look-ahead', meaning: 'length of the ray cast along the heading', value: ({ config }) => config.locomotion.avoidanceLookAhead },
            { tex: 'd_{\\text{hit}}', name: 'hit distance', meaning: 'how far along the ray the wall is' },
            { tex: 'u', name: 'urgency', meaning: '0 when the wall is at the ray’s tip, 1 at contact' },
            { tex: '\\mathbf{h}', name: 'escape heading', meaning: 'the first turned heading whose ray is clear' },
            { tex: STEP, name: 'turn step', meaning: 'how much each tried heading turns further', value: ({ config }) => config.locomotion.avoidanceAngleStep, unit: '°' },
            { tex: WAV, name: 'wall weight', meaning: 'how hard a fish steers off a wall', value: ({ config }) => config.locomotion.avoidanceWeight },
            { tex: WRC, name: 'home weight', meaning: 'how hard it pulls back toward the tank center', value: ({ config }) => config.locomotion.recenterWeight },
            { tex: TDELAY, name: 'wait', meaning: 'delay after a hit before the pull starts', value: ({ config }) => config.locomotion.recenterDelay, unit: ' s' },
            { tex: TPULL, name: 'pull duration', meaning: 'how long the pull lasts', value: ({ config }) => config.locomotion.recenterDuration, unit: ' s' },
          ],
        },
        {
          title: 'Where this differs from textbook boids',
          list: [
            'Each rule has its own radius for each species, and the cohesion radius can follow density (a target number of neighbors) instead of being set.',
            'Cohesion is weighted by inverse squared distance rather than a plain average, which keeps pods apart.',
            'Separation, alignment and cohesion ignore vision here: every fish sees all around it.',
            'Turning is limited to a maximum rate, so no fish can reverse on the spot.',
          ],
        },
      ],
    },
  },
  2: {
    added: 'A second, larger species; body size slows speed and turning.',
    why: [
      'One species was already interesting, so I wanted to see two. At this tier the only thing between species is that they don’t stick together; nobody hunts anyone yet.',
      'What this tier is really about is body size. A bigger fish is slower and turns more slowly. With the current settings, Red is 2.25 times Gold’s size, and its top speed is 85% of Gold’s while its turning rate is only 64%. So the difference shows up much more in how they turn than in how fast they go: Red swings through wide arcs where Gold turns on the spot.',
    ],
    watch:
      'Red swings through wide arcs while Gold turns tightly; each schools only with its own kind.',
    model: {
      draft: 'Draft: written from the code, not yet checked by the author.',
      sections: [
        {
          title: 'Body size costs speed and turning',
          text: [
            'Each species has a body size b and base speeds. Size scales them down by power laws with a floor, so a very large fish is slow but never frozen. Turning pays a steeper price than speed.',
          ],
          formulas: [
            `\\sigma_v = \\max\\!\\left(${PHI_V},\\ ${B}^{-${ALPHA_V}}\\right),\\qquad v_{\\text{cruise}} = \\sigma_v\\,${U0},\\qquad v_{\\max} = \\sigma_v\\,${V0}`,
            `\\omega = ${OMEGA0}\\,\\max\\!\\left(${PHI_W},\\ ${B}^{-${ALPHA_W}}\\right)`,
          ],
          where: [
            { tex: B, name: 'body size', meaning: 'size relative to Gold, which is 1', value: ({ school }) => school.size },
            { tex: '\\sigma_v', name: 'speed scale', meaning: 'how much of its base speeds a fish of this size keeps', value: ({ config, school }) => sustainedSpeedScale(config, school) },
            { tex: PHI_V, name: 'speed floor', meaning: 'the smallest share of base speed any size keeps', value: ({ config }) => config.traits.minSustainedSpeedFactor },
            { tex: ALPHA_V, name: 'speed size exponent', meaning: 'how steeply speed falls with size', value: ({ config }) => config.traits.sizeSpeedPenaltyExponent },
            { tex: U0, name: 'base cruise speed', meaning: 'the speed a fish drifts back up to before scaling', value: ({ school }) => school.cruiseSpeed },
            { tex: V0, name: 'base top speed', meaning: 'the top speed before scaling', value: ({ school }) => school.maxSpeed },
            { tex: 'v_{\\text{cruise}}', name: 'cruise speed', meaning: 'the scaled cruise speed', value: ({ config, school }) => school.cruiseSpeed * sustainedSpeedScale(config, school) },
            { tex: 'v_{\\max}', name: 'top speed', meaning: 'the scaled top speed; steering aims at it and speed never exceeds it', value: ({ config, school }) => effectiveMaxSpeed(config, school) },
            { tex: OMEGA0, name: 'base turn rate', meaning: 'the fastest turn before scaling, in radians per second', value: ({ school }) => school.turnSpeed },
            { tex: PHI_W, name: 'turning floor', meaning: 'the smallest share of base turn rate any size keeps', value: ({ config }) => config.traits.minTurnFactor },
            { tex: ALPHA_W, name: 'turning size exponent', meaning: 'how steeply turning falls with size', value: ({ config }) => config.traits.sizeTurnPenaltyExponent },
            { tex: '\\omega', name: 'turn rate', meaning: 'the scaled fastest turn', value: ({ config, school }) => effectiveTurnSpeed(config, school), unit: ' rad/s' },
          ],
          note: 'Steering aims at the same scaled top speed. When the cohesion radius is computed from target neighbors, size also sets body length, which sets its floor (three body lengths).',
        },
        {
          title: 'Species keep apart',
          text: [
            'Fish of different species only push each other away, and only at close range. They do not align with or move toward each other, so each species schools with its own kind. The push goes into the same separation sum as tier 1, fading to zero at a radius set by the larger of the two fish.',
          ],
          formulas: [
            `\\mathbf{s}_i \\mathrel{+}= -\\!\\!\\sum_{\\substack{\\text{other species}\\\\ d_{ij} < R_x}}\\! \\hat{\\mathbf{d}}_{ij}\\left(1 - \\frac{d_{ij}}{R_x}\\right),\\qquad R_x = 0.15\\,\\max(b_i, b_j)`,
          ],
          where: [
            { tex: '\\mathbf{s}_i', name: 'separation', meaning: 'the push away from close fish, the same sum as tier 1' },
            { tex: 'd_{ij}', name: 'distance', meaning: 'distance between the two fish' },
            { tex: '\\hat{\\mathbf{d}}_{ij}', name: 'direction', meaning: 'unit vector from fish i toward the other fish' },
            { tex: 'R_x', name: 'cross-species radius', meaning: 'how close a fish of another species must be to push away from' },
            { tex: 'b_i,\\ b_j', name: 'body sizes', meaning: 'sizes of the two fish; the larger one sets the radius' },
            { tex: '0.15', name: 'cross-species scale', meaning: 'radius per unit of body size; adjustable at tier 6' },
          ],
        },
        {
          title: 'Where this differs from textbook boids',
          list: [
            'Boids have one kind of agent; here each species has its own size, speeds and turning, and the rules act within a species.',
            'Body size is the only trait that couples to motion; it does not make fish more or less social.',
          ],
        },
      ],
    },
  },
  3: {
    added: 'Larger fish hunt smaller ones; prey do not react yet.',
    why: [
      'Once there are two species, the next question is obvious: what if one eats the other? I didn’t want to hard-code who is the predator and who is the prey, so the ratio of their body sizes decides.',
      'Hunting works on two radii. From far away, a hunter only drifts toward where the prey are. Only when it gets close does it lock onto one single fish. It picks the nearest one; if two are about equally near, it takes the one more in its path. If it chases for a while without closing in, it gives up and looks for another, because a hunter chasing a fish it can never catch looks broken.',
      'An older version had one capture quota shared by the whole predator school, so whether a fish could eat depended on how many of its kind existed, even on the other side of the tank. Taking that out made the motion look noticeably more organic.',
      'The prey don’t react yet. That’s the next tier.',
      'One thing I chose not to do: sweeping the catch along the hunter’s path. The prey would have no room to escape, which is too harsh for fish.',
    ],
    watch:
      'A hunter picking a target, giving up when it is not closing, and switching to a nearer fish.',
    model: {
      draft: 'Draft: written from the code, not yet checked by the author.',
      sections: [
        {
          title: 'Who hunts whom',
          text: [
            'Only size decides. A fish hunts another species when it is at least k times larger, up to an upper edge of the size window (2.5 here; it becomes adjustable at tier 5). A small margin h keeps a hunt from flickering on and off at the edge.',
          ],
          formulas: [
            `r = \\frac{b_{\\text{hunter}}}{b_{\\text{prey}}},\\qquad \\text{hunts if } ${KREL} \\le r \\le 2.5,\\qquad \\text{keeps hunting while } ${KREL} - ${HYST} \\le r \\le 2.5 + ${HYST}`,
          ],
          where: [
            { tex: 'r', name: 'size ratio', meaning: 'the hunter’s body size over the prey’s' },
            { tex: KREL, name: 'hunting threshold', meaning: 'how many times larger a fish must be to hunt another', value: ({ config }) => config.relations.k },
            { tex: HYST, name: 'margin', meaning: 'extra room before an ongoing hunt stops, so it does not flicker', value: ({ config }) => config.relations.hysteresis },
            { tex: '2.5', name: 'upper edge', meaning: 'beyond this ratio prey is too small to chase; adjustable at tier 5' },
          ],
        },
        {
          title: 'Two radii',
          text: [
            'Both radii grow with the hunter’s own neighbor radius. Out to the sensing radius, a hunter with no target steers toward the plain center of the prey it senses. Within the lock radius it picks one fish.',
          ],
          formulas: [
            `D = ${FD}\\,R_c,\\qquad R_{\\text{sense}} = ${FSENSE}\\,D,\\qquad R_{\\text{lock}} = ${FLOCK}\\,D`,
            `\\mathbf{F}^{\\text{scan}}_i = ${WP}\\,\\operatorname{steer}\\!\\left(\\bar{\\mathbf{x}}_{\\text{prey}} - \\mathbf{x}_i\\right)`,
          ],
          where: [
            { tex: 'D', name: 'detection length', meaning: 'the hunter’s base reach, a share of its cohesion radius', value: ({ derived }) => derived.detectionLength },
            { tex: FD, name: 'detection factor', meaning: 'detection length as a share of the cohesion radius', value: ({ config }) => config.perception.detectionLengthFactor },
            { tex: 'R_c', name: 'cohesion radius', meaning: 'the hunter’s own neighbor radius from tier 1', value: ({ derived }) => derived.cohesionRadius },
            { tex: FSENSE, name: 'sensing factor', meaning: 'sensing radius in detection lengths', value: ({ config }) => config.relations.schoolSenseFactor },
            { tex: 'R_{\\text{sense}}', name: 'sensing radius', meaning: 'how far a hunter senses prey', value: ({ config, derived }) => derived.detectionLength * config.relations.schoolSenseFactor },
            { tex: FLOCK, name: 'lock factor', meaning: 'lock radius in detection lengths', value: ({ config }) => config.relations.burstRadiusFactor },
            { tex: 'R_{\\text{lock}}', name: 'lock radius', meaning: 'how close prey must be to be picked as a target', value: ({ config, derived }) => derived.detectionLength * config.relations.burstRadiusFactor },
            { tex: WP, name: 'pursuit weight', meaning: 'how strongly a hunter steers toward prey', value: ({ config }) => config.relations.pursuitWeight },
            { tex: '\\bar{\\mathbf{x}}_{\\text{prey}}', name: 'prey center', meaning: 'plain average position of the prey the hunter senses' },
          ],
        },
        {
          title: 'Choosing and giving up',
          text: [
            'The nearest prey inside the lock radius wins. Two candidates count as equally near when their distances differ by less than a fraction τ of the farther one; then the one more in front of the hunter wins. A locked hunter switches only to a fish that is clearly nearer. If no new closest distance is reached for t_give seconds, it gives up and ignores that fish until it leaves the lock radius.',
          ],
          formulas: [
            `|d_a - d_b| \\le ${TIE}\\,\\max(d_a, d_b) \;\\Rightarrow\; \\text{prefer larger } \\hat{\\mathbf{v}}_i \\cdot \\hat{\\mathbf{d}}`,
            `\\text{give up if } \\min_{t' \\in [t - ${TGIVE},\\,t]} d(t') \\text{ is no new minimum}`,
          ],
          where: [
            { tex: 'd_a,\\ d_b', name: 'candidate distances', meaning: 'distances from the hunter to two possible targets' },
            { tex: TIE, name: 'tie tolerance', meaning: 'how close two distances must be to count as equally near', value: ({ config }) => config.relations.targetTieTolerance },
            { tex: '\\hat{\\mathbf{v}}_i \\cdot \\hat{\\mathbf{d}}', name: 'in front', meaning: 'how directly ahead of the hunter a candidate is, from −1 behind to 1 straight ahead' },
            { tex: TGIVE, name: 'give-up time', meaning: 'seconds without getting any closer before a hunter gives up', value: ({ config }) => config.relations.giveUpSeconds, unit: ' s' },
          ],
        },
        {
          title: 'The lunge',
          text: [
            'A locked hunter steers at its target, and sprints: an extra force aims at where the target will be a moment ahead. While sprinting, its pull toward its own school weakens, its top speed rises, its force budget grows and its turning stiffens, so it overshoots when the prey swerves.',
          ],
          formulas: [
            `\\begin{aligned}\\mathbf{F}^{\\text{hunt}}_i ={} & ${WP}\\,\\operatorname{steer}(\\mathbf{x}_t - \\mathbf{x}_i) \\\\ & + ${WB}\\,\\operatorname{steer}\\!\\left(\\mathbf{x}_t + \\mathbf{v}_t\\,\\min\\!\\left(${TLEAD},\\tfrac{d}{v_0}\\right) - \\mathbf{x}_i\\right)\\end{aligned}`,
            `\\mathrm{w}_a, \\mathrm{w}_c \\times ${SOCIAL},\\qquad v_{\\max} \\times ${BURST},\\qquad \\omega \\times ${BTURN},\\qquad F_{\\max} \\times ${BUDGET}`,
          ],
          where: [
            { tex: '\\mathbf{x}_t,\\ \\mathbf{v}_t', name: 'target', meaning: 'position and velocity of the locked prey' },
            { tex: 'd', name: 'distance', meaning: 'distance from the hunter to its target' },
            { tex: WB, name: 'lunge weight', meaning: 'how strongly the hunter steers at where the target is heading', value: ({ config }) => config.relations.burstWeight },
            { tex: TLEAD, name: 'lead time', meaning: 'the longest look ahead along the target’s motion', value: ({ config }) => config.locomotion.interceptLookAhead, unit: ' s' },
            { tex: 'v_0', name: 'base top speed', meaning: 'the hunter’s top speed before size scaling', value: ({ school }) => school.maxSpeed },
            { tex: SOCIAL, name: 'social damping', meaning: 'how much of its pull toward its school a lunging hunter keeps', value: ({ config }) => config.locomotion.burstSocialSuppression },
            { tex: BURST, name: 'sprint speed', meaning: 'top speed multiplier while lunging', value: ({ config }) => config.locomotion.burstFactor },
            { tex: BTURN, name: 'sprint turning', meaning: 'turn rate multiplier while lunging', value: ({ config }) => config.locomotion.burstTurnFactor },
            { tex: BUDGET, name: 'sprint force', meaning: 'force cap multiplier while lunging', value: ({ config }) => config.locomotion.burstForceBudget },
            { tex: 'F_{\\max}', name: 'force cap', meaning: 'the largest steering force a fish can apply' },
          ],
        },
        {
          title: 'Capture',
          text: [
            'A locked target within reach of the mouth is eaten and removed. Reach is a fraction of the two body lengths together. Prey too small to be worth a chase (beyond the size window) are also eaten if they drift into the mouth.',
          ],
          formulas: [
            `d \\le ${CAPTURE}\\,(L_{\\text{hunter}} + L_{\\text{prey}})`,
          ],
          where: [
            { tex: CAPTURE, name: 'reach factor', meaning: 'mouth reach as a share of both body lengths together', value: ({ config }) => config.capture.captureLengthFactor },
            { tex: 'L_{\\text{hunter}},\\ L_{\\text{prey}}', name: 'body lengths', meaning: 'lengths of the hunter and the prey' },
          ],
        },
        {
          title: 'Where this differs from textbook boids',
          list: [
            'Predator and prey roles are not assigned; they follow from the size ratio and can change when sizes change.',
            'The lunge aims a short time ahead of the target (at most 1.3 s of its current velocity).',
            'A hunter never coordinates with others of its school; any group hunting is emergent.',
          ],
        },
      ],
    },
  },
  4: {
    added:
      'Prey flee hunters they sense, panic spreads by alarm pulses, and vision becomes a forward cone.',
    why: [
      'Panic was actually the first idea I had, before hunting. I designed the two to mirror each other, and both work on two radii: a hunter drifts toward prey from far away and locks on up close; a fish senses a predator from far away and panics fully up close.',
      'Distance alone could say how scared one fish is. It can’t explain the two things I find most beautiful: fish that never saw the predator fleeing because their neighbors flee, and a school staying jumpy after the threat has gone. So a scared fish sends a pulse to the neighbors it can see, and a strong enough pulse scares them too. The more scared a fish is, the harder it flees. After sending, a fish has to wait before it can send again; without that wait, the scare would bounce around the school forever.',
      'This is also where vision becomes a forward cone, because the pulse travels along what fish can see. My guess is that when information has to travel fish by fish, instead of reaching everyone at once, small whirls inside the school can survive. Separation still works all around: it models the lateral line, the flow sense along a fish’s sides, and a fish blind behind would get rear-ended.',
      'Adding panic is when the whole school suddenly started to look alive.',
    ],
    watch: 'A startle crossing a school from the side nearest the predator.',
    model: {
      draft: 'Draft: written from the code, not yet checked by the author.',
      sections: [
        {
          title: 'A forward cone',
          text: [
            'A fish now sees only neighbors in front of it, within a cone of angle φ. The cone limits alignment, cohesion and who hears an alarm. Separation still works all around.',
          ],
          formulas: [
            `j \\text{ seen by } i \\iff \\hat{\\mathbf{v}}_i \\cdot \\hat{\\mathbf{d}}_{ij} \\ge \\cos\\frac{${FOV}}{2}`,
          ],
          where: [
            { tex: FOV, name: 'field of view', meaning: 'the full opening angle of the cone', value: ({ config }) => config.perception.fovDegrees, unit: '°' },
            { tex: '\\hat{\\mathbf{v}}_i', name: 'heading', meaning: 'the direction fish i is swimming' },
            { tex: '\\hat{\\mathbf{d}}_{ij}', name: 'direction', meaning: 'unit vector from fish i toward fish j' },
          ],
        },
        {
          title: 'Sensing a hunter',
          text: [
            'A fish senses any fish that hunts its species within its threat radius, in every direction. Threat grows linearly from zero at the edge to one at contact.',
          ],
          formulas: [
            `R_p = ${FD}\\,R_c,\\qquad T_i = \\max_{\\text{hunters}} \\left(1 - \\frac{d}{R_p}\\right)`,
          ],
          where: [
            { tex: 'R_p', name: 'threat radius', meaning: 'how far a fish senses a hunter', value: ({ derived }) => derived.panicRadius },
            { tex: FD, name: 'detection factor', meaning: 'threat radius as a share of the fish’s cohesion radius', value: ({ config }) => config.perception.detectionLengthFactor },
            { tex: 'R_c', name: 'cohesion radius', meaning: 'the fish’s own neighbor radius from tier 1', value: ({ derived }) => derived.cohesionRadius },
            { tex: 'T_i', name: 'threat', meaning: 'how close the nearest hunter is, 0 at the edge and 1 at contact' },
            { tex: 'd', name: 'distance', meaning: 'distance to a hunter' },
          ],
        },
        {
          title: 'The alarm pulse',
          text: [
            'A fish sends a pulse when a threat first grips it (T passes 0.55; it lets go below 0.25), or when the pulse it hears from neighbors it can see passes a threshold η. A pulse starts at 1 and fades within a fraction of a second. After sending, a fish cannot send again for a refractory time.',
          ],
          formulas: [
            `h_i = \\max_{j \\text{ seen},\\ d_{ij} < R_c} a_j\\left(1 - \\frac{d_{ij}}{R_c}\\right),\\qquad \\text{send if } h_i \\ge ${ETA} \\text{ and } ${TREF} \\text{ has passed}`,
            `a_i \\leftarrow 1 \\text{ on sending},\\qquad a_i \\leftarrow a_i\\,e^{-\\Delta t / 0.35} \\text{ otherwise}`,
          ],
          where: [
            { tex: 'h_i', name: 'heard pulse', meaning: 'the strongest pulse fish i hears from neighbors it can see' },
            { tex: 'a_j', name: 'pulse', meaning: 'the pulse neighbor j is sending, 1 when sent and fading after' },
            { tex: ETA, name: 'alarm threshold', meaning: 'how strong a heard pulse must be to set a fish off', value: ({ config }) => config.relations.signalThreshold },
            { tex: TREF, name: 'refractory time', meaning: 'seconds before a fish can send again', value: ({ config }) => config.relations.refractoryTime, unit: ' s' },
            { tex: '0.35', name: 'fade time', meaning: 'seconds for a pulse to fall to about a third; adjustable at tier 6' },
          ],
        },
        {
          title: 'Panic',
          text: [
            'Sending a pulse pins panic at full for half a second. Otherwise panic heads toward the threat the fish senses itself, rising and falling at their own rates.',
          ],
          formulas: [
            `p^{*} = \\max\\!\\left(T_i \\text{ if gripped},\\ 1 \\text{ for } 0.5\\text{ s after sending}\\right)`,
            `p \\leftarrow p + (p^{*} - p)\\left(1 - e^{-\\lambda\\,\\Delta t}\\right),\\qquad \\lambda = \\begin{cases} ${RISE} & p^{*} > p \\\\ ${DECAY} & \\text{otherwise} \\end{cases}`,
          ],
          where: [
            { tex: 'p', name: 'panic', meaning: 'how scared a fish is, from 0 to 1' },
            { tex: 'p^{*}', name: 'panic target', meaning: 'the level panic is heading toward' },
            { tex: RISE, name: 'rise rate', meaning: 'how fast panic climbs toward its target', value: ({ config }) => config.relations.panicRiseRate, unit: '/s' },
            { tex: DECAY, name: 'decay rate', meaning: 'how fast panic falls back', value: ({ config }) => config.relations.panicDecayRate, unit: '/s' },
            { tex: '0.5\\text{ s}', name: 'hold time', meaning: 'how long panic stays full after sending a pulse; adjustable at tier 6' },
          ],
        },
        {
          title: 'Fleeing',
          text: [
            'Only a fish that senses a hunter itself gets an escape direction: away from where the hunter will be 0.15 s ahead, plus a little sideways. Fish that are only alarmed know nothing about the hunter; they turn with the school through alignment. Panic also loosens cohesion, speeds up turning and raises the top speed.',
          ],
          formulas: [
            `\\mathbf{F}^{\\text{flee}}_i = ${WE}\\,T_i\\,(1 + p)\\,\\operatorname{steer}(\\mathbf{e}_i)`,
            `\\mathrm{w}_c \\times \\max(0,\\,1 - 0.6\\,p),\\qquad \\omega \\times (1 + 1.2\\,p),\\qquad v_{\\max} \\times 1.15 \\text{ when } p > 0.06`,
          ],
          where: [
            { tex: WE, name: 'flee weight', meaning: 'how strongly a threatened fish steers away', value: ({ config }) => config.relations.evadeWeight },
            { tex: '\\mathbf{e}_i', name: 'escape direction', meaning: 'away from where the hunters will be 0.15 s ahead, plus a little sideways' },
            { tex: 'T_i,\\ p', name: 'threat and panic', meaning: 'from the sections above' },
            { tex: '0.6,\\ 1.2,\\ 1.15,\\ 0.06', name: 'panic effects', meaning: 'cohesion loss, turning gain, speed gain and the panic needed for it; adjustable at tier 6' },
          ],
        },
        {
          title: 'Where this differs from textbook boids',
          list: [
            'What spreads is a short pulse, not the panic level itself, so a scare passes through a school instead of echoing in it.',
            'The cone limits who a fish follows and hears, but not who it keeps its distance from.',
            'Threat is sensed in every direction; only the social signals travel through the cone.',
          ],
        },
      ],
    },
  },
  5: {
    added:
      'Energy and plankton: fish must eat or starve; a middle species, Blue, joins.',
    why: [
      'Without energy, nothing has a reason to hunt. But once hunters have to eat, the smallest fish would simply be eaten out, so I added plankton: the small fish need something to live on.',
      'Plankton grows in actual places in the water. Where fish graze, it runs out and slowly grows back. It used to be a single number for the whole tank with dots drawn on top; the picture was showing food that existed nowhere in the model, so I made it real.',
      'Swimming costs energy, and swimming fast costs much more. I got one thing backwards at first. Kleiber’s law says energy use per kilogram falls as animals get bigger, but total energy use still rises: a whale eats more than a minnow. Fixing that, and giving bigger fish bigger energy stores, is what finally let the large fish survive.',
      'A middle species, Blue, joins here, so there is a real food chain.',
      'Energy is shared, a little. When a fish eats, it keeps half. Three tenths go to fish of its own species near it, within a fixed radius, and one fifth goes to its whole school. I wanted it to be a bit more balanced: the nearby share means a pod eats well together or starves together, and the school-wide share is a small floor so one unlucky fish doesn’t starve while the rest are fed. Nothing crosses species, because that would pass what prey eat on to their predators.',
      'Who hunts whom is decided by body size, but only inside a window. A fish hunts another only if it is at least 1.35 times bigger and at most 2.5 times bigger. Beyond that, the prey is too small to be worth chasing, the way a whale doesn’t chase a single krill. With three species, this window shapes the whole food web. Gold is size 1, Blue 1.5, Red 2.25. With the upper edge at 2.5, Red eats both Blue and Gold, and Blue eats Gold. Pull the upper edge below 2.25 and Red stops treating Gold as food: the web turns into a straight line, Gold → Blue → Red, and Red can only eat Blue.',
    ],
    watch:
      'A hungry Red too weak to sprint catches less, grows hungrier, and starves.',
    model: {
      draft: 'Draft: written from the code, not yet checked by the author.',
      sections: [
        {
          title: 'Energy store',
          text: [
            'Each fish carries energy E, in abstract units. The store grows faster than body size, so a large fish can go longer without food. Fish start at about 82% full, give or take a quarter, and die when E reaches zero.',
          ],
          formulas: [`E_{\\max} = 0.667\\,b^{1.5}`],
          where: [
            { tex: 'E', name: 'energy', meaning: 'what a fish has left; it dies at zero' },
            { tex: 'E_{\\max}', name: 'energy store', meaning: 'the most a fish of this size can hold', value: ({ config, school }) => energyCapacityFor(config, school) },
            { tex: 'b', name: 'body size', meaning: 'size relative to Gold', value: ({ school }) => school.size },
            { tex: '0.667,\\ 1.5', name: 'store scale and exponent', meaning: 'adjustable at tier 6' },
          ],
        },
        {
          title: 'The cost of living',
          text: [
            'Every fish burns energy all the time, more when it sprints after prey. Both costs rise with size as b^0.75 (Kleiber): a big fish burns more in total, less per unit of body. A fish may only sprint while it holds at least a third of its store.',
          ],
          formulas: [
            `\\frac{dE}{dt} = -\\,${MULT}\\,b^{0.75}\\left(${MU0} + ${MUB}\\,[\\text{sprinting}]\\right) + \\text{income}`,
          ],
          where: [
            { tex: MU0, name: 'resting cost', meaning: 'energy per second a size-1 fish burns just by living', value: ({ config }) => config.ecology.basalRate, unit: '/s' },
            { tex: MUB, name: 'sprint cost', meaning: 'extra energy per second while sprinting', value: ({ config }) => config.ecology.burstMetabolicRate, unit: '/s' },
            { tex: MULT, name: 'metabolism multiplier', meaning: 'this species’ own scaling of both costs', value: ({ school }) => school.metabolismMultiplier },
            { tex: 'b^{0.75}', name: 'Kleiber scaling', meaning: 'costs grow with size, but slower than size' },
            { tex: '[\\text{sprinting}]', name: 'sprinting', meaning: '1 while lunging at prey, 0 otherwise' },
            { tex: 'c_{\\text{rest}}', name: 'burn at rest', meaning: 'what a fish of the edited school burns per second without sprinting', value: ({ config, school }) => metabolicRate(config, school, false), unit: '/s' },
            { tex: 't_{\\text{starve}}', name: 'time to starve', meaning: 'how long a full fish of the edited school lasts at rest', value: ({ config, school }) => energyCapacityFor(config, school) / metabolicRate(config, school, false), unit: ' s' },
          ],
        },
        {
          title: 'Plankton',
          text: [
            'Plankton lives in particles scattered in clumps through the tank. Each holds three bites; an emptied particle comes back whole after t_regrow seconds. A fish that is not chasing prey and is below 80% full tries to graze several times a second, more often if it is big, and takes a few whole bites from what is within reach: fewer where the plankton is thin, but at least one. A fish below half full also steers toward plankton it can sense; while chasing prey that pull is weakened like its pull toward its school.',
          ],
          formulas: [
            `\\text{attempts per second} = 4\\,${GRAZE}\\,b^{0.45},\\qquad n = \\max\\!\\left(1,\\ \\operatorname{round}\\,\\min\\!\\left(S,\\ \\frac{4\\,S}{S + 1.57}\\right)\\right)`,
            `\\text{gain} = ${EP}\\,\\frac{n}{4}`,
          ],
          where: [
            { tex: GRAZE, name: 'grazing rate', meaning: 'how often this species tries to graze', value: ({ school }) => school.grazeRate },
            { tex: 'S', name: 'bites in reach', meaning: 'plankton bites within 0.3 of the fish' },
            { tex: 'n', name: 'bites taken', meaning: 'whole bites taken in one attempt, at most 4' },
            { tex: '1.57', name: 'half-saturation', meaning: 'bites in reach at which a fish gets half its full helping' },
            { tex: EP, name: 'bite energy', meaning: 'energy of a full helping of 4 bites', value: ({ config }) => config.ecology.planktonEnergy },
            { tex: TREGROW, name: 'regrow time', meaning: 'seconds before an emptied particle is whole again', value: ({ config }) => config.plankton.regrowSeconds, unit: ' s' },
          ],
        },
        {
          title: 'Sharing a meal',
          text: [
            'The eater keeps most of a plankton meal. A share is split on the spot among fish of its own species within 0.25, and another goes to a pool that is divided among all living fish of the school on the next step. A caught prey is worth energy in proportion to its size and is split the same way.',
          ],
          formulas: [
            `\\text{eater: } 1 - ${SNEAR} - ${SSCHOOL},\\qquad \\text{nearby, same species: } ${SNEAR},\\qquad \\text{school pool: } ${SSCHOOL}`,
            `\\text{capture gain} = ${KAPPA}\\,b_{\\text{prey}}`,
          ],
          where: [
            { tex: SNEAR, name: 'nearby share', meaning: 'split on the spot among same-species fish within 0.25', value: ({ config }) => config.ecology.energyShareLocal },
            { tex: SSCHOOL, name: 'school share', meaning: 'put in a pool divided among the whole school', value: ({ config }) => config.ecology.energyShareSchool },
            { tex: KAPPA, name: 'catch energy', meaning: 'energy per unit of prey body size', value: ({ config }) => config.ecology.captureEnergyPerSize },
            { tex: 'b_{\\text{prey}}', name: 'prey size', meaning: 'body size of the fish caught' },
          ],
        },
        {
          title: 'The food web',
          text: [
            'The size window from tier 3 now has an adjustable upper edge. With three sizes it decides whether the largest fish also eats the smallest (a web) or only the middle one (a chain).',
          ],
          formulas: [
            `\\text{hunts if } 1.35 \\le \\frac{b_{\\text{hunter}}}{b_{\\text{prey}}} \\le ${KMAX}`,
          ],
          where: [
            { tex: KMAX, name: 'upper edge', meaning: 'the largest size ratio still worth chasing', value: ({ config }) => config.relations.KMax },
            { tex: '1.35', name: 'hunting threshold', meaning: 'the smallest size ratio that makes a hunter, from tier 3' },
          ],
        },
        {
          title: 'Where this differs from textbook boids',
          list: [
            'Boids have no internal state; here every fish carries energy, and hunger decides whether it grazes, steers toward food, or may sprint.',
            'Plankton is spatial and depletable, so where a school swims decides whether it eats.',
            'Fish do not reproduce: a school that loses members does not recover them.',
          ],
        },
      ],
    },
  },
  6: {
    added: 'The finer mechanisms, each with its own switch.',
    why: [
      'The last tier is the small things I tuned so it feels more like biology. Each one has its own switch, so you can turn it off and see what it was doing.',
      'Tipping point. When fear passes a threshold, a school stops turning together and breaks apart, each fish for itself. I used a switch instead of a smooth blend, because I wanted the feeling of something giving way.',
      'Copying heading. Scared fish copy which way their neighbors are going, not where they are. Pulling scared fish toward each other would make them clump, the opposite of a school bursting outward.',
      'Adrenaline. A starving fish gets something like an adrenaline rush: its sprint becomes faster and cheaper. But the cost doesn’t vanish; part of it is paid back over the next seconds. Right after the lunge it seems fine; the bill arrives later, when the fish is already weaker.',
      'Beyond those, a lot of what’s here is small numbers I adjusted by watching.',
      'This is also where I hit a wall. The parameters affect each other in non-linear ways, and tuning them by hand gets very hard. Craig Reynolds describes the same problem in EvoFlock, where he evolves the parameters instead of tuning them by hand.',
    ],
    watch:
      'A starving Red sprinting on borrowed energy, and schools breaking apart under heavy panic.',
    model: {
      draft: 'Draft: written from the code, not yet checked by the author.',
      sections: [
        {
          title: 'Copying heading',
          text: [
            'A fish whose panic has passed the alarm threshold broadcasts its heading to the neighbors that can see it, within a signal radius. Close and very scared senders count far more. A receiver steers along the combined heading, as strongly as its most urgent sender. A scared fish also listens harder to ordinary alignment when its neighbors are scared too. None of this pulls fish together.',
          ],
          formulas: [
            `R_{\\text{sig}} = ${FSIG}\\,R_a,\\qquad q_j = \\left(1 - \\frac{d_{ij}}{R_{\\text{sig}}}\\right) p_j \\left(1 + ${BSRC}\\,p_j^{2}\\right) \\quad (p_j \\ge \\eta)`,
            `\\mathbf{F}^{\\text{copy}}_i = ${WEM}\\,\\max_j\\!\\left[\\left(1 - \\frac{d_{ij}}{R_{\\text{sig}}}\\right) p_j\\right] \\operatorname{steer}\\!\\Big(\\sum_j q_j\\,\\hat{\\mathbf{v}}_j\\Big)`,
            `\\mathrm{w}_a \\times \\min\\!\\left(1 + ${BRCV}\\,\\bar{p}_{\\text{nbr}}\\,p_i,\\ ${RCVMAX}\\right)`,
          ],
          where: [
            { tex: 'R_{\\text{sig}}', name: 'signal radius', meaning: 'how far a heading is broadcast', value: ({ config, derived }) => derived.alignmentRadius * config.relations.signalRadiusFactor },
            { tex: FSIG, name: 'signal factor', meaning: 'signal radius as a share of the alignment radius', value: ({ config }) => config.relations.signalRadiusFactor },
            { tex: 'R_a', name: 'alignment radius', meaning: 'from tier 1', value: ({ derived }) => derived.alignmentRadius },
            { tex: 'q_j', name: 'sender weight', meaning: 'how much sender j counts: closer and more scared counts more' },
            { tex: 'p_j,\\ p_i', name: 'panic', meaning: 'panic of the sender and of the receiver' },
            { tex: BSRC, name: 'sender boost', meaning: 'how much extra a very scared sender counts', value: ({ config }) => config.relations.alignmentSourceBoost },
            { tex: '\\eta', name: 'alarm threshold', meaning: 'the panic a sender needs, from tier 4', value: ({ config }) => config.relations.signalThreshold },
            { tex: WEM, name: 'copy weight', meaning: 'how strongly a receiver steers along the broadcast heading', value: ({ config }) => config.relations.emergencyAlignmentWeight },
            { tex: '\\hat{\\mathbf{v}}_j', name: 'sender heading', meaning: 'the direction sender j is swimming' },
            { tex: BRCV, name: 'listening boost', meaning: 'how much more a scared fish follows scared neighbors', value: ({ config }) => config.relations.alignmentReceiverBoost },
            { tex: '\\bar{p}_{\\text{nbr}}', name: 'neighbor panic', meaning: 'the highest panic among neighbors the fish can see' },
            { tex: RCVMAX, name: 'listening cap', meaning: 'the most ordinary alignment can be multiplied', value: ({ config }) => config.relations.alignmentReceiverMax },
          ],
        },
        {
          title: 'Tipping point',
          text: [
            'Each fish has a latch. It trips when the fish’s panic reaches p_in and resets only when panic falls to p_out. While tripped, the fish ignores cohesion and heading copying: it flees on its own. Everything else stays as it was.',
          ],
          formulas: [
            `\\text{scatter on when } p_i \\ge ${PIN},\\qquad \\text{off when } p_i \\le ${POUT}`,
            `\\text{while scattered: } \\mathrm{w}_c = 0,\\quad \\mathbf{F}^{\\text{copy}}_i = 0`,
          ],
          where: [
            { tex: 'p_i', name: 'panic', meaning: 'the fish’s own panic, from tier 4' },
            { tex: PIN, name: 'scatter threshold', meaning: 'panic at which the fish breaks away', value: ({ config }) => config.relations.panicScatterEnter },
            { tex: POUT, name: 'rejoin threshold', meaning: 'panic it must fall to before it rejoins', value: ({ config }) => config.relations.panicScatterExit },
          ],
        },
        {
          title: 'Adrenaline',
          text: [
            'When a fish’s energy drops below a fraction q_in of its store, it becomes desperate for t_d seconds: it may sprint whatever its energy, sprints faster and pursues harder. Afterwards it is exhausted, slower in everything, until it has eaten back up to q_out of its store. Only then can it become desperate again.',
          ],
          formulas: [
            `\\text{desperate for } ${TDESP} \\text{ s once } E < ${QIN}\\,E_{\\max}`,
            `\\text{sprint speed} \\times ${BDESP},\\qquad \\mathrm{w}_p \\times ${PDESP},\\qquad \\text{then all speeds} \\times ${EXH} \\text{ until } E \\ge ${QOUT}\\,E_{\\max}`,
          ],
          where: [
            { tex: 'E,\\ E_{\\max}', name: 'energy and store', meaning: 'from tier 5' },
            { tex: QIN, name: 'desperation line', meaning: 'share of the store below which a fish becomes desperate', value: ({ config }) => config.ecology.desperationEnterRatio },
            { tex: TDESP, name: 'desperate time', meaning: 'how long desperation lasts', value: ({ config }) => config.ecology.desperationSeconds, unit: ' s' },
            { tex: BDESP, name: 'sprint boost', meaning: 'sprint speed multiplier while desperate', value: ({ config }) => config.ecology.desperationSpeedBoost },
            { tex: PDESP, name: 'pursuit boost', meaning: 'pursuit weight multiplier while desperate', value: ({ config }) => config.ecology.desperationPursuitBoost },
            { tex: EXH, name: 'exhausted speed', meaning: 'speed multiplier after desperation, until the fish recovers', value: ({ config }) => config.ecology.desperationExhaustedSpeed },
            { tex: QOUT, name: 'recovery line', meaning: 'share of the store a fish must eat back to before it can be desperate again', value: ({ config }) => config.ecology.desperationRecoverRatio },
          ],
        },
        {
          title: 'The debt',
          text: [
            'While desperate, a fish pays only part of each sprint at once; the rest becomes debt. Resting costs are always paid in full. Debt is paid off at a steady rate on top of normal costs, so it is gone t_settle seconds after the last sprint that added to it. Eating does not clear it.',
          ],
          formulas: [
            `D \\mathrel{+}= (1 - ${CNOW})\\,c_{\\text{sprint}}\\,\\Delta t \\text{ while desperate},\\qquad \\text{repay } \\frac{D_{\\text{last}}}{${TSETTLE}} \\text{ per second}`,
            `\\frac{dE}{dt} = -\\,c_{\\text{rest}} - ${CNOW}\\,c_{\\text{sprint}} - \\text{repayment} + \\text{income}`,
          ],
          where: [
            { tex: 'D', name: 'debt', meaning: 'energy still owed' },
            { tex: CNOW, name: 'paid-now share', meaning: 'share of each sprint paid at once while desperate; 1 otherwise', value: ({ config }) => config.ecology.desperationCostShare },
            { tex: 'c_{\\text{sprint}},\\ c_{\\text{rest}}', name: 'costs', meaning: 'the sprint and resting costs from tier 5' },
            { tex: TSETTLE, name: 'repayment time', meaning: 'seconds over which a debt is repaid after the latest sprint', value: ({ config }) => config.ecology.debtSettleSeconds, unit: ' s' },
            { tex: 'D_{\\text{last}}', name: 'debt to repay', meaning: 'the debt right after the latest sprint added to it' },
          ],
        },
        {
          title: 'Switches',
          list: [
            'Copying heading off: no heading broadcast and no extra listening; alignment is as in tier 1.',
            'Tipping point off: panic only loosens cohesion, as in tier 4.',
            'Adrenaline off: a fish below a third of its store can no longer sprint, as in tier 5.',
            'Debt off: a desperate fish pays all its costs at once.',
          ],
        },
        {
          title: 'Also open at this tier',
          list: [
            'Tank size, the smallest neighbor radius, and how separation and cohesion fall off with distance.',
            'How strongly species push each other apart, the force cap, the pitch limit and the wander.',
            'The finer panic settings from tier 4: how a threat grips and lets go, how long panic holds, how fast the pulse fades, and how panic changes turning, speed and cohesion.',
            'The finer energy settings from tier 5: store size and its scaling, grazing thresholds and reach, and plankton particle settings.',
          ],
        },
      ],
    },
  },
};
