// English / Chinese switch for the parameter panel.
//
// Why a lookup table instead of bilingual strings in the config:
// group names in experiment-config.js double as lookup keys (groupVisible(),
// MAP_GROUPS / ECOLOGY_GROUPS / CAPTURE_GROUPS, SCHOOL_SECTIONS.fields, and
// the folders Map in addGlobalParameters). Turning the source strings into
// { en, zh } objects would break every one of those lookups, so the source
// strings stay unchanged and are translated only at addFolder / addBinding time.
//
// Entry format: 'source string': ['English', 'Chinese'].
// Strings with no entry are returned as-is, so user data such as school
// names and obstacle keys is never translated.

const STORAGE_KEY = 'flocks.panelLanguage';
const FALLBACK = 'en';

let language = FALLBACK;
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'en' || saved === 'zh') language = saved;
} catch {
  // localStorage throws in private browsing; fall back to English.
}

export function getLanguage() {
  return language;
}

export function setLanguage(next) {
  language = next === 'zh' ? 'zh' : 'en';
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // If it cannot be stored, the choice lasts for this session only.
  }
  return language;
}

export function toggleLanguage() {
  return setLanguage(language === 'en' ? 'zh' : 'en');
}

// ---------------------------------------------------------------------------

const DICT = {
  // Groups: top level
  项目: ['Project', '项目'],
  运行: ['Runtime', '运行'],
  缸体: ['Tank', '缸体'],
  感知: ['Perception', '感知'],
  跨鱼群作用: ['Cross-school', '跨鱼群作用'],
  关系: ['Relations', '关系'],
  'predation enabled': ['predation enabled', '启用捕食'],
  'give up after (s)': ['give up after (s)', '追不上放弃 (s)'],
  'target tie band': ['target tie band', '选目标平局带'],
  'avoidance look-ahead (m)': ['avoidance look-ahead (m)', '避障射线长度 (m)'],
  'avoidance angle step (°)': ['avoidance angle step (°)', '避障转向步长 (°)'],
  'recenter weight': ['recenter weight', '回中权重（补偿）'],
  'separation radius': ['separation radius', '分离半径'],
  'alignment radius': ['alignment radius', '对齐半径'],
  'cohesion radius': ['cohesion radius', '聚合半径'],
  'blind cone': ['blind cone', '视锥盲区'],
  'look-ahead ray': ['look-ahead ray', '避障射线'],
  'avoidance turn': ['avoidance turn', '避障转向方向'],
  'recentering pull': ['recentering pull', '回中拉力'],
  'prey sensing radius': ['prey sensing radius', '猎物感知半径'],
  'target lock radius and current target': ['target lock radius and current target', '锁定半径与当前目标'],
  'threat radius': ['threat radius', '威胁半径'],
  'alarm signal radius': ['alarm signal radius', '警报信号半径'],
  'evade × panic boost': ['evade × panic boost', '逃逸力 × 恐慌放大'],
  'emergency alignment enabled': ['emergency alignment enabled', '启用应急对齐'],
  'scatter latch enabled': ['scatter latch enabled', '启用散开门闩'],
  'last-ditch sprint enabled': ['last-ditch sprint enabled', '启用濒死冲刺'],
  'sprint debt enabled': ['sprint debt enabled', '启用延迟债务'],
  'recenter delay (s)': ['recenter delay (s)', '回中延迟 (s)'],
  'recenter duration (s)': ['recenter duration (s)', '回中持续 (s)'],
  运动: ['Motion', '运动'],
  生态能量: ['Ecology · energy', '生态能量'],
  'Trait Coupling': ['Trait Coupling', '体型耦合'],
  浮游资源: ['Plankton', '浮游资源'],
  视觉: ['Visual', '视觉'],
  捕食: ['Predation', '捕食'],
  捕获特效: ['Capture FX', '捕获特效'],
  耐力死亡特效: ['Starvation FX', '耐力死亡特效'],
  障碍距离场: ['Obstacle SDF', '障碍距离场'],
  障碍: ['Obstacle', '障碍'],
  相机: ['Camera', '相机'],
  鱼群: ['School', '鱼群'],

  // Groups: each side of ' · ' is looked up separately, so the fragments are listed here
  Advanced: ['Advanced', '高级'],
  Runtime: ['Runtime', '运行'],
  Tank: ['Tank', '缸体'],
  Visual: ['Visual', '视觉'],
  'Distance Field': ['Distance Field', '距离场'],
  'Physics Spawn': ['Physics Spawn', '物理生成'],
  Camera: ['Camera', '相机'],
  Separation: ['Separation', '分离'],
  Alignment: ['Alignment', '对齐'],
  Cohesion: ['Cohesion', '凝聚'],
  分离: ['Separation', '分离'],
  对齐: ['Alignment', '对齐'],
  凝聚: ['Cohesion', '凝聚'],
  活动范围: ['bounds', '活动范围'],
  硬边界: ['hard boundary', '硬边界'],
  'wall margin': ['wall margin', '边界余量'],
  'wall margin · 硬边界': ['wall margin', '硬边界 · wall margin'],

  // School editor section titles. These source strings are already bilingual
  // (Chinese · English), and per-fragment translation turned them into
  // 'Separation · Separation', so exact entries here bypass the split logic.
  '分离 · Separation': ['Separation', '分离 · Separation'],
  '对齐 · Alignment': ['Alignment', '对齐 · Alignment'],
  '凝聚 · Cohesion': ['Cohesion', '凝聚 · Cohesion'],
  身份与形态: ['Identity & form', '身份与形态'],
  生态角色: ['Ecological role', '生态角色'],
  出生布局: ['Spawn layout', '出生布局'],

  // Panel buttons and titles
  参数: ['Parameters', '参数'],
  配置文件: ['Config file', '配置文件'],
  恢复默认值: ['restore defaults', '恢复默认值'],
  '导出 JSON': ['export JSON', '导出 JSON'],
  '导入 JSON': ['import JSON', '导入 JSON'],
  保存到浏览器: ['save to browser', '保存到浏览器'],
  读取浏览器配置: ['load from browser', '读取浏览器配置'],
  '复制 seed': ['copy seed', '复制 seed'],
  导出实验报告: ['export report', '导出实验报告'],
  'reset current project': ['reset current project', '重置当前项目'],
  主项目操作: ['Main project actions', '主项目操作'],
  生态实验操作: ['Ecology experiment actions', '生态实验操作'],
  子实验操作: ['Sub-experiment actions', '子实验操作'],
  '计算中…': ['computing…', '计算中…'],
  '← 上一个鱼群': ['← previous school', '← 上一个鱼群'],
  '下一个鱼群 →': ['next school →', '下一个鱼群 →'],
  '+ 新增鱼群（复制当前）': ['+ add school (clone current)', '+ 新增鱼群（复制当前）'],
  '− 删除当前鱼群': ['− delete current school', '− 删除当前鱼群'],
  体型自动角色: ['auto role by size', '体型自动角色'],
  对其他鱼群: ['vs other schools', '对其他鱼群'],
  派生感知: ['derived perception', '派生感知'],
  'actual radius': ['actual radius', '实际半径'],

  // Dropdown options
  '主项目 · 水族馆': ['Main · aquarium', '主项目 · 水族馆'],
  '子实验 · 生态淘汰': ['Sub · ecological attrition', '子实验 · 生态淘汰'],
  'Predation · permanent death': ['Predation · permanent death', '捕食 · 永久死亡'],
  Ecology: ['Ecology', '生态'],
  '完整 680': ['Full 680', '完整 680'],
  '性能 320': ['Performance 320', '性能 320'],
  自定义: ['Custom', '自定义'],
  Custom: ['Custom', '自定义'],
  全缸随机: ['Whole tank, random', '全缸随机'],
  整群一团: ['One tight cluster', '整群一团'],
  '分小群（fission-fusion）': ['Pods (fission-fusion)', '分小群（fission-fusion）'],
  'Uniform（经典 boids）': ['Uniform (classic boids)', 'Uniform（经典 boids）'],
  'Inverse（小群可维持）': ['Inverse (small pods hold)', 'Inverse（小群可维持）'],
  Inverse: ['Inverse', 'Inverse'],
  InvLog: ['InvLog', 'InvLog'],
  Linear: ['Linear', 'Linear'],
  Box: ['Box', '方缸'],
  Ring: ['Ring', '环形'],
  Aquarium: ['Aquarium', '水族馆'],
  Game: ['Game', '游戏'],
  Obstacle: ['Obstacle', '障碍'],

  // Parameter labels with English source strings
  project: ['project', '项目'],
  mode: ['mode', '模式'],
  'population preset': ['population preset', '总量预设'],
  seed: ['seed', '随机种子'],
  'time scale': ['time scale', '时间倍率'],
  'fixed dt': ['fixed dt', '固定步长'],
  preset: ['preset', '预设'],
  width: ['width', '宽'],
  height: ['height', '高'],
  depth: ['depth', '深'],
  padding: ['padding', '内缩'],
  id: ['id', 'id'],
  name: ['name', '名称'],
  color: ['color', '颜色'],
  count: ['count', '数量'],
  size: ['size', '体型'],
  'cruise speed': ['cruise speed', '巡航速度'],
  'max speed': ['max speed', '最大速度'],
  'turn speed': ['turn speed', '转向速度'],
  'max steering': ['max steering', '最大转向力'],
  'metabolism ×': ['metabolism ×', '代谢 ×'],
  'target neighbors（当前鱼群）': ['target neighbors (this school)', '目标邻居数（当前鱼群）'],
  'weight（当前鱼群）': ['weight (this school)', '权重（当前鱼群）'],
  'radius ×（全局）': ['radius × (global)', '半径 ×（全局）'],
  'wander weight': ['wander weight', '游荡权重'],
  'avoidance weight': ['avoidance weight', '避障权重'],
  'evade weight': ['evade weight', '逃逸权重'],
  'evade lateral': ['evade lateral', '逃逸横移'],
  'burst weight': ['burst weight', '冲刺权重'],
  'burst radius × 大范围': ['burst radius × long range', '冲刺半径 × 大范围'],
  'burst drain /s': ['burst drain /s', '冲刺消耗 /s'],
  'basal drain /s': ['basal drain /s', '基础代谢 /s'],
  'basal size exponent': ['basal size exponent', '基础代谢体型指数'],
  'min energy to burst': ['min energy to burst', '冲刺所需最低能量'],
  'initial energy': ['initial energy', '初始能量'],
  'energy capacity': ['energy capacity', '能量上限'],
  'energy / plankton': ['energy / plankton', '每颗浮游的能量'],
  'capture energy / prey size': ['capture energy / prey size', '捕食能量 / 猎物体型'],
  'capture length ×': ['capture length ×', '捕食距离 ×'],
  'half saturation': ['half saturation', '半饱和常数'],
  'visible particles': ['visible particles', '可见粒子数'],
  'particle size': ['particle size', '粒子大小'],
  'particle color': ['particle color', '粒子颜色'],
  'particle opacity': ['particle opacity', '粒子不透明度'],
  'plankton enabled': ['plankton enabled', '启用浮游'],
  'map enabled': ['map enabled', '启用地图'],
  'distance field enabled': ['distance field enabled', '启用距离场'],
  'field cell size': ['field cell size', '场格边长'],
  'padding cells': ['padding cells', '外扩格数'],
  'analytic refine distance': ['analytic refine distance', '解析细化距离'],
  'min radius / body': ['min radius / body', '最小半径 / 体长'],
  'body length': ['body length', '体长'],
  'body radius': ['body radius', '体半径'],
  'radial segments': ['radial segments', '径向分段'],
  'fish opacity': ['fish opacity', '鱼的不透明度'],
  FOV: ['FOV', '视场角'],
  'global near': ['global near', '全局近裁面'],
  'look ahead': ['look ahead', '前视距离'],
  'intercept look-ahead': ['intercept look-ahead', '拦截预判'],
  'pursuit burst ×': ['pursuit burst ×', '追击冲刺 ×'],
  'hunt / panic radius × cohesion': ['hunt / panic radius × cohesion', '捕食/恐慌半径 × 凝聚'],
  'cross separation radius / size': ['cross separation radius / size', '跨群分离半径 / 体型'],
  'cohesion 衰减': ['cohesion falloff', '凝聚衰减'],
  分离衰减: ['separation falloff', '分离衰减'],
  'hysteresis δ': ['hysteresis δ', '迟滞 δ'],
  'panic rise /s': ['panic rise /s', '恐慌上升 /s'],
  'panic decay /s': ['panic decay /s', '恐慌衰减 /s'],
  'panic speed ×': ['panic speed ×', '恐慌速度 ×'],
  'panic → cohesion 下降': ['panic → cohesion drop', '恐慌 → 凝聚下降'],
  'panic → 转向加成': ['panic → turn bonus', '恐慌 → 转向加成'],
  'panic 触发下限': ['panic threshold', '恐慌触发下限'],
  'spawn mode': ['spawn mode', '生成方式'],
  'spawn radius': ['spawn radius', '生成半径'],
  'initial spawn attempts': ['initial spawn attempts', '初始生成尝试次数'],
  'position damping': ['position damping', '位置阻尼'],
  'orientation damping': ['orientation damping', '朝向阻尼'],
  density: ['density', '密度'],
  'min sustained speed ×': ['min sustained speed ×', '最低持续速度 ×'],
  'min turn ×': ['min turn ×', '最低转向 ×'],
  'size → speed exponent': ['size → speed exponent', '体型 → 速度指数'],
  'size → turn exponent': ['size → turn exponent', '体型 → 转向指数'],
  'capture length': ['capture length', '捕食距离'],
  'burst radius': ['burst radius', '冲刺半径'],

  // Obstacle fields: these labels are generated directly from object keys
  type: ['type', '类型'],
  enabled: ['enabled', '启用'],
  x: ['x', 'x'],
  y: ['y', 'y'],
  z: ['z', 'z'],
  rotationX: ['rotation X', '旋转 X'],
  rotationY: ['rotation Y', '旋转 Y'],
  rotationZ: ['rotation Z', '旋转 Z'],
  thickness: ['thickness', '厚度'],
  frameDepth: ['frame depth', '框体厚度'],
  holeDiameter: ['hole diameter', '孔径'],
  ring: ['ring', '环形'],
  cube: ['cube', '立方体'],
  column: ['column', '圆柱'],

  // Parameter labels with Chinese source strings
  隔间: ['chamber', '隔间'],
  小群数量: ['pod count', '小群数量'],
  '小群内间距 ×': ['in-pod spacing ×', '小群内间距 ×'],
  '尸体觅食 ×': ['carrion foraging ×', '尸体觅食 ×'],
  出生朝向散布: ['initial heading spread', '出生朝向散布'],
  初始散射速度: ['initial scatter speed', '初始散射速度'],
  '初始能量抖动 ±': ['initial energy jitter ±', '初始能量抖动 ±'],
  感知半径: ['sense radius', '感知半径'],
  进食半径: ['forage radius', '进食半径'],
  每颗可吃次数: ['uses per particle', '每颗可吃次数'],
  每次最多吃几口: ['max bites / fish /s', '每次最多吃几口'],
  '重置时间 (s)': ['regrow seconds', '重生时间 (s)'],
  浮游单次能量: ['energy per bite', '浮游单次能量'],
  开始找食的能量比: ['seek hunger ratio', '开始找食的能量比'],
  '觅食转向 weight': ['forage weight', '觅食转向权重'],
  觅食饥饿阈值: ['forage hunger threshold', '觅食饥饿阈值'],
  粒子上限: ['particle cap', '粒子上限'],
  共享半径: ['share radius', '共享半径'],
  分给附近的比例: ['share to nearby', '分给附近的比例'],
  分给同族全场的比例: ['share to whole school', '分给同族全场的比例'],
  '滤食能力→体型指数': ['filter ability → size exponent', '滤食能力 → 体型指数'],
  '能量罐→体型指数': ['capacity → size exponent', '能量罐 → 体型指数'],
  冲刺代谢按体型缩放: ['burst metabolism scales with size', '冲刺代谢按体型缩放'],
  '冲刺力预算 ×': ['burst force budget ×', '冲刺力预算 ×'],
  '冲刺转向 ×': ['burst turn ×', '冲刺转向 ×'],
  '冲刺时社交压低 ×': ['social suppression while bursting ×', '冲刺时社交压低 ×'],
  力竭速度倍率: ['exhausted speed ×', '力竭速度倍率'],
  '孤注一掷·进入能量比': ['desperation · enter energy ratio', '孤注一掷 · 进入能量比'],
  '孤注一掷·解锁能量比': ['desperation · release energy ratio', '孤注一掷 · 解锁能量比'],
  '孤注一掷·时长 (s)': ['desperation · duration (s)', '孤注一掷 · 时长 (s)'],
  '孤注一掷·速度倍率': ['desperation · speed ×', '孤注一掷 · 速度倍率'],
  '孤注一掷·追猎倍率': ['desperation · pursuit ×', '孤注一掷 · 追猎倍率'],
  '孤注一掷·当场付的比例': ['desperation · paid up front', '孤注一掷 · 当场付的比例'],
  '债的结算时长 (s)': ['debt settle seconds', '债的结算时长 (s)'],
  '捕猎凝聚 weight': ['hunt cohesion weight', '捕猎凝聚权重'],
  '捕食体型阈值 k': ['predation size threshold k', '捕食体型阈值 k'],
  猎物体型窗口上界: ['prey size window upper bound', '猎物体型窗口上界'],
  '顺路吞食（太小的猎物）': ['incidental swallow (too-small prey)', '顺路吞食（太小的猎物）'],
  捕食者反向速度: ['predator counter-speed', '捕食者反向速度'],
  不应期: ['refractory period', '不应期'],
  逃逸预判时间: ['evade look-ahead time', '逃逸预判时间'],
  惊吓保持时长: ['startle hold duration', '惊吓保持时长'],
  直接威胁闩上: ['direct threat latch on', '直接威胁闩上'],
  直接威胁松开: ['direct threat latch off', '直接威胁松开'],
  '炸开·进入恐慌值': ['scatter · enter panic', '炸开 · 进入恐慌值'],
  '炸开·退出恐慌值': ['scatter · exit panic', '炸开 · 退出恐慌值'],
  '应急信号半径 ×': ['emergency signal radius ×', '应急信号半径 ×'],
  应急信号阈值: ['emergency signal threshold', '应急信号阈值'],
  应急对齐权重: ['emergency alignment weight', '应急对齐权重'],
  应急航向优先度: ['emergency heading priority', '应急航向优先度'],
  恐慌时倾听增益: ['listening gain when panicked', '恐慌时倾听增益'],
  倾听增益上限: ['listening gain cap', '倾听增益上限'],
  '群体感知 ×': ['group perception ×', '群体感知 ×'],
  体型耦合启用: ['trait coupling enabled', '体型耦合启用'],
  耐力系统启用: ['stamina system enabled', '耐力系统启用'],
  特效启用: ['effects enabled', '特效启用'],
  进食特效: ['feeding effect', '进食特效'],
  进食扩散速度: ['feed burst speed', '进食扩散速度'],
  进食碎屑数: ['feed debris count', '进食碎屑数'],
  进食碎屑尺寸: ['feed debris size', '进食碎屑尺寸'],
  进食碎屑寿命: ['feed debris lifetime', '进食碎屑寿命'],
  进食碎屑颜色: ['feed debris color', '进食碎屑颜色'],
  '进食能量 ×': ['feed energy ×', '进食能量 ×'],
  咬合闪光: ['bite flash', '咬合闪光'],
  咬合脉冲颜色: ['bite pulse color', '咬合脉冲颜色'],
  闪光半径: ['flash radius', '闪光半径'],
  闪光强度: ['flash intensity', '闪光强度'],
  闪光时长: ['flash duration', '闪光时长'],
  闪光衰减: ['flash falloff', '闪光衰减'],
  脉冲衰减时间: ['pulse decay time', '脉冲衰减时间'],
  碎片数量上限: ['shard cap', '碎片数量上限'],
  碎片密度: ['shard density', '碎片密度'],
  碎片尺寸: ['shard size', '碎片尺寸'],
  碎片寿命: ['shard lifetime', '碎片寿命'],
  碎片间隔: ['shard interval', '碎片间隔'],
  碎片颜色: ['shard color', '碎片颜色'],
  死亡渐变时长: ['death fade duration', '死亡渐变时长'],
  尸体不消失: ['corpses persist', '尸体不消失'],
  尸体阻尼: ['corpse damping', '尸体阻尼'],
  上浮速度: ['rise speed', '上浮速度'],
  浮尸浮力加速度: ['corpse rise acceleration', '浮尸浮力加速度'],
  竖直加速度: ['vertical acceleration', '竖直加速度'],
  径向速度: ['radial speed', '径向速度'],
  生成半径: ['spawn radius', '生成半径'],
  每局随机种子: ['per-run seed', '每局随机种子'],
  视锥角度: ['view cone angle', '视锥角度'],
  最大俯仰角: ['max pitch', '最大俯仰角'],
  最大侧倾角: ['max roll', '最大侧倾角'],
  侧倾强度: ['roll strength', '侧倾强度'],
  侧倾平滑: ['roll smoothing', '侧倾平滑'],
  '特写 FOV': ['close-up FOV', '特写 FOV'],
  '特写后距 / size': ['close-up distance / size', '特写后距 / size'],
  '特写高度 / size': ['close-up height / size', '特写高度 / size'],
  '特写侧移 / size': ['close-up lateral / size', '特写侧移 / size'],
  '跟随后距 / size': ['follow distance / size', '跟随后距 / size'],
  '跟随高度 / size': ['follow height / size', '跟随高度 / size'],
};

// Labels built at runtime: ${kind} spawn ${axis} / heading ${axis} / spawn ${axis}.
// The axis (x/y/z) and kind are data and stay untranslated.
const PATTERNS = [
  [/^heading (.+)$/, (m) => `朝向 ${m[1]}`],
  [/^spawn (.+)$/, (m) => `出生位置 ${m[1]}`],
  [/^(\S+) spawn (.+)$/, (m) => `${t(m[1], 'zh')} 出生位置 ${m[2]}`],
];

const SEPARATOR = ' · ';

function lookup(text, lang) {
  const row = DICT[text];
  if (!row) return null;
  return lang === 'zh' ? row[1] : row[0];
}

/**
 * Translate a UI string. Strings with no entry are returned as-is, since
 * user data such as school names and obstacle keys must not be translated.
 */
export function t(text, lang = language) {
  if (typeof text !== 'string' || text === '') return text;

  const exact = lookup(text, lang);
  if (exact !== null) return exact;

  // Compound titles such as 'Advanced · Runtime': translate each side, then rejoin.
  if (text.includes(SEPARATOR)) {
    const parts = text.split(SEPARATOR);
    const translated = parts.map((part) => lookup(part.trim(), lang));
    if (translated.some((part) => part !== null)) {
      return parts
        .map((part, index) => translated[index] ?? part)
        .join(SEPARATOR);
    }
  }

  if (lang === 'zh') {
    for (const [pattern, build] of PATTERNS) {
      const match = pattern.exec(text);
      if (match) return build(match);
    }
  }

  return text;
}

/** Translate a Tweakpane options map (keys are display names, values are the option values). */
export function translateOptions(options, lang = language) {
  const result = {};
  for (const [display, value] of Object.entries(options)) {
    result[t(display, lang)] = value;
  }
  return result;
}
