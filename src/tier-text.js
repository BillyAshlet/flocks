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
const FS = sym('perception.separationRadiusFactor', 'f_s');
const FA = sym('perception.alignmentRadiusFactor', 'f_a');
const WS = sym('schools.*.separationWeight', 'w_s');
const WA = sym('schools.*.alignmentWeight', 'w_a');
const WC = sym('schools.*.cohesionWeight', 'w_c');
const LOOK = sym('locomotion.avoidanceLookAhead', '\\ell');
const STEP = sym('locomotion.avoidanceAngleStep', '\\theta');
const WAV = sym('locomotion.avoidanceWeight', 'w_{\\text{wall}}');
const WRC = sym('locomotion.recenterWeight', 'w_{\\text{home}}');
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
const WP = sym('relations.pursuitWeight', 'w_p');
const WB = sym('relations.burstWeight', 'w_b');
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
const WE = sym('relations.evadeWeight', 'w_e');
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
const WEM = sym('relations.emergencyAlignmentWeight', 'w_{\\text{copy}}');
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
  linear: { g: '\\left(1 - \\frac{d_{ij}}{R_s}\\right)', words: 'a share that falls linearly to zero at the separation radius' },
  invlog: { g: '\\ln\\frac{R_s}{d_{ij}}', words: 'the log of the separation radius over its distance' },
};
const separationFalloff = (config) =>
  SEPARATION_FALLOFF[config.perception.separationFalloff] ?? SEPARATION_FALLOFF.inverse;
const inverseCohesion = (config) => config.perception.cohesionFalloff === 'inverse';

export const TIER_TEXT = {
  1: {
    added: 'Three rules per fish (separation, alignment, cohesion) and walls.',
    why: [
      "This project started from two things colliding: a water-jet ring-toss toy I played with as a kid, and Craig Reynolds' boids. They share one idea: simple rules, complex systems. Each fish follows three rules (keep a little distance, match your neighbors' direction, move toward your neighbors) and only looks at the fish around it. No leader, no choreography.",
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
            "Each fish looks at the fish of its own school within a radius, in every direction. The radius is not set by hand. It is the radius of a sphere that would hold k fish if the school were spread evenly through the tank, so asking for more neighbors widens every fish's reach. Separation and alignment use fixed fractions of it.",
          ],
          formulas: [
            `R_c = \\max\\!\\left(\\sqrt[3]{\\dfrac{3\\,${K}\\,V}{4\\pi\\,${N}}},\\; 0.138\\right)`,
            `R_s = ${FS}\\,R_c,\\qquad R_a = ${FA}\\,R_c`,
          ],
          note: 'V is the tank volume, 6 × 3.6 × 2.4. The floor 0.138 is three body lengths.',
          live: [
            { tex: K, value: ({ school }) => school.targetNeighbors },
            { tex: N, value: ({ school }) => school.count },
            { tex: FS, value: ({ config }) => config.perception.separationRadiusFactor },
            { tex: FA, value: ({ config }) => config.perception.alignmentRadiusFactor },
            { tex: 'R_c', value: ({ derived }) => derived.cohesionRadius },
            { tex: 'R_s', value: ({ derived }) => derived.separationRadius },
            { tex: 'R_a', value: ({ derived }) => derived.alignmentRadius },
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
              `\\mathbf{s}_i = -\\!\\!\\sum_{d_{ij} < R_s}\\! \\hat{\\mathbf{d}}_{ij}\\, ${separationFalloff(config).g},\\qquad \\hat{\\mathbf{d}}_{ij} = \\frac{\\mathbf{x}_j - \\mathbf{x}_i}{d_{ij}}`,
            `\\mathbf{a}_i = \\frac{1}{n_a}\\!\\sum_{d_{ij} < R_a}\\! \\mathbf{v}_j`,
            (config) =>
              inverseCohesion(config)
                ? `\\mathbf{c}_i = \\frac{\\sum_{d_{ij} < R_c} \\omega_j\\,\\mathbf{x}_j}{\\sum_{d_{ij} < R_c} \\omega_j} - \\mathbf{x}_i,\\qquad \\omega_j = \\frac{1}{d_{ij}^{2} + (0.15\\,R_c)^{2}}`
                : `\\mathbf{c}_i = \\frac{1}{n_c}\\!\\sum_{d_{ij} < R_c}\\! \\mathbf{x}_j - \\mathbf{x}_i`,
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
          note: 'The wander term is a small, slow wobble with weight 0.08.',
          live: [
            { tex: WS, value: ({ school }) => school.separationWeight },
            { tex: WA, value: ({ school }) => school.alignmentWeight },
            { tex: WC, value: ({ school }) => school.cohesionWeight },
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
          note: 'The ray has length ℓ; d_hit is how far along it the wall is.',
          live: [
            { tex: WAV, value: ({ config }) => config.locomotion.avoidanceWeight },
            { tex: LOOK, value: ({ config }) => config.locomotion.avoidanceLookAhead },
            { tex: STEP, value: ({ config }) => config.locomotion.avoidanceAngleStep, unit: '°' },
            { tex: WRC, value: ({ config }) => config.locomotion.recenterWeight },
            { tex: TDELAY, value: ({ config }) => config.locomotion.recenterDelay, unit: ' s' },
            { tex: TPULL, value: ({ config }) => config.locomotion.recenterDuration, unit: ' s' },
          ],
        },
        {
          title: 'Where this differs from textbook boids',
          list: [
            'The neighbor radius comes from a density (how many neighbors a fish should have), not a fixed distance.',
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
          live: [
            { tex: B, value: ({ school }) => school.size },
            { tex: '\\sigma_v', value: ({ config, school }) => sustainedSpeedScale(config, school) },
            { tex: 'v_{\\max}', value: ({ config, school }) => effectiveMaxSpeed(config, school) },
            { tex: '\\omega', value: ({ config, school }) => effectiveTurnSpeed(config, school), unit: ' rad/s' },
          ],
          note: 'Steering aims at the same scaled top speed. Size also sets body length, which sets the smallest neighbor radius (three body lengths).',
        },
        {
          title: 'Species keep apart',
          text: [
            'Fish of different species only push each other away, and only at close range. They do not align with or move toward each other, so each species schools with its own kind. The push goes into the same separation sum as tier 1, fading to zero at a radius set by the larger of the two fish.',
          ],
          formulas: [
            `\\mathbf{s}_i \\mathrel{+}= -\\!\\!\\sum_{\\substack{\\text{other species}\\\\ d_{ij} < R_x}}\\! \\hat{\\mathbf{d}}_{ij}\\left(1 - \\frac{d_{ij}}{R_x}\\right),\\qquad R_x = 0.15\\,\\max(b_i, b_j)`,
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
          live: [
            { tex: 'D', value: ({ derived }) => derived.detectionLength },
            { tex: 'R_{\\text{sense}}', value: ({ config, derived }) => derived.detectionLength * config.relations.schoolSenseFactor },
            { tex: 'R_{\\text{lock}}', value: ({ config, derived }) => derived.detectionLength * config.relations.burstRadiusFactor },
          ],
          note: 'Radii are for the school being edited in the panel.',
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
        },
        {
          title: 'The lunge',
          text: [
            'A locked hunter steers at its target, and sprints: an extra force aims at where the target will be a moment ahead. While sprinting, its pull toward its own school weakens, its top speed rises, its force budget grows and its turning stiffens, so it overshoots when the prey swerves.',
          ],
          formulas: [
            `\\begin{aligned}\\mathbf{F}^{\\text{hunt}}_i ={} & ${WP}\\,\\operatorname{steer}(\\mathbf{x}_t - \\mathbf{x}_i) \\\\ & + ${WB}\\,\\operatorname{steer}\\!\\left(\\mathbf{x}_t + \\mathbf{v}_t\\,\\min\\!\\left(${TLEAD},\\tfrac{d}{v_0}\\right) - \\mathbf{x}_i\\right)\\end{aligned}`,
            `w_a, w_c \\times ${SOCIAL},\\qquad v_{\\max} \\times ${BURST},\\qquad \\omega \\times ${BTURN},\\qquad F_{\\max} \\times ${BUDGET}`,
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
          live: [{ tex: FOV, value: ({ config }) => config.perception.fovDegrees, unit: '°' }],
        },
        {
          title: 'Sensing a hunter',
          text: [
            'A fish senses any fish that hunts its species within its threat radius, in every direction. Threat grows linearly from zero at the edge to one at contact.',
          ],
          formulas: [
            `R_p = ${FD}\\,R_c,\\qquad T_i = \\max_{\\text{hunters}} \\left(1 - \\frac{d}{R_p}\\right)`,
          ],
          live: [{ tex: 'R_p', value: ({ derived }) => derived.panicRadius }],
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
          live: [
            { tex: ETA, value: ({ config }) => config.relations.signalThreshold },
            { tex: TREF, value: ({ config }) => config.relations.refractoryTime, unit: ' s' },
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
          live: [
            { tex: RISE, value: ({ config }) => config.relations.panicRiseRate, unit: '/s' },
            { tex: DECAY, value: ({ config }) => config.relations.panicDecayRate, unit: '/s' },
          ],
        },
        {
          title: 'Fleeing',
          text: [
            'Only a fish that senses a hunter itself gets an escape direction: away from where the hunter will be 0.15 s ahead, plus a little sideways. Fish that are only alarmed know nothing about the hunter; they turn with the school through alignment. Panic also loosens cohesion, speeds up turning and raises the top speed.',
          ],
          formulas: [
            `\\mathbf{F}^{\\text{flee}}_i = ${WE}\\,T_i\\,(1 + p)\\,\\operatorname{steer}(\\mathbf{e}_i)`,
            `w_c \\times \\max(0,\\,1 - 0.6\\,p),\\qquad \\omega \\times (1 + 1.2\\,p),\\qquad v_{\\max} \\times 1.15 \\text{ when } p > 0.06`,
          ],
          live: [{ tex: WE, value: ({ config }) => config.relations.evadeWeight }],
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
          live: [
            { tex: 'b', value: ({ school }) => school.size },
            { tex: 'E_{\\max}', value: ({ config, school }) => energyCapacityFor(config, school) },
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
          live: [
            { tex: MU0, value: ({ config }) => config.ecology.basalRate, unit: '/s' },
            { tex: MUB, value: ({ config }) => config.ecology.burstMetabolicRate, unit: '/s' },
            { tex: '\\text{at rest}', value: ({ config, school }) => metabolicRate(config, school, false), unit: '/s' },
            { tex: 't_{\\text{starve}}', value: ({ config, school }) => energyCapacityFor(config, school) / metabolicRate(config, school, false), unit: ' s' },
          ],
          note: 't_starve is how long a full fish of the edited school lasts at rest.',
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
          live: [
            { tex: EP, value: ({ config }) => config.ecology.planktonEnergy },
            { tex: TREGROW, value: ({ config }) => config.plankton.regrowSeconds, unit: ' s' },
            { tex: GRAZE, value: ({ school }) => school.grazeRate },
          ],
          note: 'S is the number of bites within reach (0.3) of the fish. At most 4 bites are taken at once.',
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
          live: [
            { tex: SNEAR, value: ({ config }) => config.ecology.energyShareLocal },
            { tex: SSCHOOL, value: ({ config }) => config.ecology.energyShareSchool },
            { tex: KAPPA, value: ({ config }) => config.ecology.captureEnergyPerSize },
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
          live: [{ tex: KMAX, value: ({ config }) => config.relations.KMax }],
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
            `R_{\\text{sig}} = ${FSIG}\\,R_a,\\qquad \\omega_j = \\left(1 - \\frac{d_{ij}}{R_{\\text{sig}}}\\right) p_j \\left(1 + ${BSRC}\\,p_j^{2}\\right) \\quad (p_j \\ge \\eta)`,
            `\\mathbf{F}^{\\text{copy}}_i = ${WEM}\\,\\max_j\\!\\left[\\left(1 - \\frac{d_{ij}}{R_{\\text{sig}}}\\right) p_j\\right] \\operatorname{steer}\\!\\Big(\\sum_j \\omega_j\\,\\hat{\\mathbf{v}}_j\\Big)`,
            `w_a \\times \\min\\!\\left(1 + ${BRCV}\\,\\bar{p}_{\\text{nbr}}\\,p_i,\\ ${RCVMAX}\\right)`,
          ],
          live: [
            { tex: WEM, value: ({ config }) => config.relations.emergencyAlignmentWeight },
            { tex: FSIG, value: ({ config }) => config.relations.signalRadiusFactor },
            { tex: 'R_{\\text{sig}}', value: ({ config, derived }) => derived.alignmentRadius * config.relations.signalRadiusFactor },
          ],
          note: 'p̄_nbr is the highest panic among the neighbors the fish can see.',
        },
        {
          title: 'Tipping point',
          text: [
            'Each fish has a latch. It trips when the fish’s panic reaches p_in and resets only when panic falls to p_out. While tripped, the fish ignores cohesion and heading copying: it flees on its own. Everything else stays as it was.',
          ],
          formulas: [
            `\\text{scatter on when } p_i \\ge ${PIN},\\qquad \\text{off when } p_i \\le ${POUT}`,
            `\\text{while scattered: } w_c = 0,\\quad \\mathbf{F}^{\\text{copy}}_i = 0`,
          ],
          live: [
            { tex: PIN, value: ({ config }) => config.relations.panicScatterEnter },
            { tex: POUT, value: ({ config }) => config.relations.panicScatterExit },
          ],
        },
        {
          title: 'Adrenaline',
          text: [
            'When a fish’s energy drops below a fraction q_in of its store, it becomes desperate for t_d seconds: it may sprint whatever its energy, sprints faster and pursues harder. Afterwards it is exhausted, slower in everything, until it has eaten back up to q_out of its store. Only then can it become desperate again.',
          ],
          formulas: [
            `\\text{desperate for } ${TDESP} \\text{ s once } E < ${QIN}\\,E_{\\max}`,
            `\\text{sprint speed} \\times ${BDESP},\\qquad w_p \\times ${PDESP},\\qquad \\text{then all speeds} \\times ${EXH} \\text{ until } E \\ge ${QOUT}\\,E_{\\max}`,
          ],
          live: [
            { tex: QIN, value: ({ config }) => config.ecology.desperationEnterRatio },
            { tex: BDESP, value: ({ config }) => config.ecology.desperationSpeedBoost },
            { tex: TDESP, value: ({ config }) => config.ecology.desperationSeconds, unit: ' s' },
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
          live: [
            { tex: CNOW, value: ({ config }) => config.ecology.desperationCostShare },
            { tex: TSETTLE, value: ({ config }) => config.ecology.debtSettleSeconds, unit: ' s' },
          ],
          note: 'c_rest and c_sprint are the resting and sprint costs from tier 5; D_last is the debt right after the latest sprint added to it. Outside desperation the paid-now share is 1.',
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
