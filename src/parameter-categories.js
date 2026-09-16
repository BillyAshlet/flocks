/**
 * Top-level panel categories, for readers who came for the model.
 *
 * run          time scale and seed.
 * environment  the world the fish live in: the tank and the plankton.
 * fish         every rule a fish follows, each species' own settings, and what
 *              happens between species.
 * display      how things are drawn. Changing it does not change the model.
 *              A school's color is not display: it tells species apart.
 * internal     engine plumbing a reader never needs (project, fixed time step).
 * obstacles    a later tier that is not in this build; never shown.
 *
 * Categories sit on top of the registry's groups rather than replacing them,
 * so a group can be split: plankton growth is environment, the way plankton
 * dots are drawn is display.
 */

export const PANEL_CATEGORIES = [
  'run',
  'environment',
  'fish',
  'display',
  'internal',
  'obstacles',
];

const DISPLAY_PATHS = [
  /^ecology\.corpse/,
  /^plankton\.(visualCount|pointSize|color|opacity)$/,
];

const GROUP_CATEGORY = new Map([
  ['运行', 'run'],
  ['缸体', 'environment'],
  ['Advanced · Tank', 'environment'],
  ['浮游资源', 'environment'],
  ['感知', 'fish'],
  ['运动', 'fish'],
  ['生态能量', 'fish'],
  ['Trait Coupling', 'fish'],
  ['关系', 'fish'],
  ['捕食', 'fish'],
  ['跨鱼群作用', 'fish'],
  ['视觉', 'display'],
  ['Advanced · Visual', 'display'],
  ['捕获特效', 'display'],
  ['耐力死亡特效', 'display'],
  ['相机', 'display'],
  ['Advanced · Camera', 'display'],
  ['项目', 'internal'],
  ['Advanced · Runtime', 'internal'],
  ['障碍', 'obstacles'],
  ['障碍距离场', 'obstacles'],
  ['Advanced · Distance Field', 'obstacles'],
]);

/** The category of a registry spec, or null if its group is not mapped. */
export function parameterCategory(spec) {
  if (spec.path.startsWith('schools.')) return 'fish';
  if (DISPLAY_PATHS.some((pattern) => pattern.test(spec.path))) return 'display';
  const group = spec.group ?? '';
  if (group.startsWith('障碍 ·')) return 'obstacles';
  return GROUP_CATEGORY.get(group) ?? null;
}
