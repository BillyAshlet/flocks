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
    watch:
      'Red swings through wide arcs while Gold turns tightly; each schools only with its own kind.',
  },
  3: {
    added: 'Larger fish hunt smaller ones; prey do not react yet.',
    watch:
      'A hunter picking a target, giving up when it is not closing, and switching to a nearer fish.',
  },
  4: {
    added:
      'Prey flee what they see, panic spreads by alarm pulses, and vision becomes a forward cone.',
    watch: 'A startle crossing a school from the side nearest the predator.',
  },
  5: {
    added:
      'Energy and plankton: fish must eat or starve; a middle species, Blue, joins.',
    watch:
      'A hungry Red too weak to sprint catches less, grows hungrier, and starves.',
  },
  6: {
    added: 'The finer mechanisms, each with its own switch.',
    watch:
      'A starving Red sprinting on borrowed energy, and schools breaking apart under heavy panic.',
  },
};
