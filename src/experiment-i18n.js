// 参数面板的中英切换。
//
// 【为什么是查表，不是把 config 里的字符串改成双语】
// experiment-config.js 里的 group 名同时是**查找键**：groupVisible()、
// MAP_GROUPS / ECOLOGY_GROUPS / CAPTURE_GROUPS、SCHOOL_SECTIONS.fields，
// 还有 addGlobalParameters 里 folders 这个 Map 的 key。
// 把源字符串改成 { en, zh } 会把这些查找全部打断。
// 所以：源字符串保持不变，只在 addFolder / addBinding 的那一刻翻译。
//
// 词条形式：'源字符串': ['English', '中文']。
// 查不到的原样返回 —— 鱼群名、障碍 key 这类用户数据不该被翻译。

const STORAGE_KEY = 'downstream.panelLanguage';
const FALLBACK = 'en';

let language = FALLBACK;
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'en' || saved === 'zh') language = saved;
} catch {
  // 隐私模式下 localStorage 会抛，默认英文就行。
}

export function getLanguage() {
  return language;
}

export function setLanguage(next) {
  language = next === 'zh' ? 'zh' : 'en';
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // 存不下就只在本次会话生效。
  }
  return language;
}

export function toggleLanguage() {
  return setLanguage(language === 'en' ? 'zh' : 'en');
}

// ---------------------------------------------------------------------------

const DICT = {
  // 分组 —— 顶层
  项目: ['Project', '项目'],
  运行: ['Runtime', '运行'],
  缸体: ['Tank', '缸体'],
  感知: ['Perception', '感知'],
  跨鱼群作用: ['Cross-school', '跨鱼群作用'],
  关系: ['Relations', '关系'],
  'predation enabled': ['predation enabled', '启用捕食'],
  运动: ['Motion', '运动'],
  生态能量: ['Ecology · energy', '生态能量'],
  'Trait Coupling': ['Trait Coupling', '三轴耦合'],
  浮游资源: ['Plankton', '浮游资源'],
  视觉: ['Visual', '视觉'],
  可视化: ['Visualization', '可视化'],
  捕食: ['Predation', '捕食'],
  捕获特效: ['Capture FX', '捕获特效'],
  耐力死亡特效: ['Starvation FX', '耐力死亡特效'],
  障碍距离场: ['Obstacle SDF', '障碍距离场'],
  障碍: ['Obstacle', '障碍'],
  'Rapier 物理': ['Rapier physics', 'Rapier 物理'],
  相机: ['Camera', '相机'],
  鱼群: ['School', '鱼群'],

  // 分组 —— ' · ' 的两侧会各自查表，所以这些片段单列
  Advanced: ['Advanced', '高级'],
  Runtime: ['Runtime', '运行'],
  Tank: ['Tank', '缸体'],
  Visual: ['Visual', '视觉'],
  'Spatial Hash': ['Spatial Hash', '空间哈希'],
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
  '0号鱼': ['fish #0', '0号鱼'],
  同群三力半径: ['same-school radii', '同群三力半径'],
  '捕食/逃逸半径': ['hunt / evade radius', '捕食/逃逸半径'],
  软转向带: ['soft steering band', '软转向带'],
  硬边界: ['hard boundary', '硬边界'],
  'edge softness': ['edge softness', '软边宽度'],
  'wall margin': ['wall margin', '边界余量'],
  'edge softness · 软转向带': ['edge softness', '软转向带 · edge softness'],
  'wall margin · 硬边界': ['wall margin', '硬边界 · wall margin'],

  // 鱼群编辑器的分区标题。
  // 这三条源字符串本来就是双语写的（'分离 · Separation'），逐段翻译会
  // 折成 'Separation · Separation'，所以在这里精确命中，绕过分段逻辑。
  '分离 · Separation': ['Separation', '分离 · Separation'],
  '对齐 · Alignment': ['Alignment', '对齐 · Alignment'],
  '凝聚 · Cohesion': ['Cohesion', '凝聚 · Cohesion'],
  身份与形态: ['Identity & form', '身份与形态'],
  生态角色: ['Ecological role', '生态角色'],
  出生布局: ['Spawn layout', '出生布局'],

  // 面板自己的按钮 / 标题
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
  'spawn ring': ['spawn ring', '生成环形'],
  'spawn cube': ['spawn cube', '生成立方体'],
  'spawn column': ['spawn column', '生成圆柱'],
  '← 上一个鱼群': ['← previous school', '← 上一个鱼群'],
  '下一个鱼群 →': ['next school →', '下一个鱼群 →'],
  '+ 新增鱼群（复制当前）': ['+ add school (clone current)', '+ 新增鱼群（复制当前）'],
  '− 删除当前鱼群': ['− delete current school', '− 删除当前鱼群'],
  体型自动角色: ['auto role by size', '体型自动角色'],
  对其他鱼群: ['vs other schools', '对其他鱼群'],
  派生感知: ['derived perception', '派生感知'],
  'actual radius': ['actual radius', '实际半径'],

  // 下拉选项
  '主项目 · 水族馆': ['Main · aquarium', '主项目 · 水族馆'],
  '游戏 · 三代进化': ['Game · three generations', '游戏 · 三代进化'],
  '子实验 · 地图与刚体': ['Sub · map & rigid bodies', '子实验 · 地图与刚体'],
  '子实验 · 生态淘汰': ['Sub · ecological attrition', '子实验 · 生态淘汰'],
  '教学 · 新手指引': ['Tutorial · onboarding', '教学 · 新手指引'],
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

  // 参数标签 —— 源是英文的，补中文
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
  'ring radius': ['ring radius', '环半径'],
  'ring tube': ['ring tube', '环管粗细'],
  padding: ['padding', '内缩'],
  'AABB padding': ['AABB padding', 'AABB 内缩'],
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
  'boundary weight': ['boundary weight', '边界权重'],
  'wander weight': ['wander weight', '游荡权重'],
  'avoidance weight': ['avoidance weight', '避障权重'],
  'avoidance inertia': ['avoidance inertia', '避障惯性'],
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
  'carrying capacity': ['carrying capacity', '环境容纳量'],
  'logistic growth /s': ['logistic growth /s', '逻辑斯蒂增长 /s'],
  'half saturation': ['half saturation', '半饱和常数'],
  'initial fraction': ['initial fraction', '初始占比'],
  'visible particles': ['visible particles', '可见粒子数'],
  'particle size': ['particle size', '粒子大小'],
  'particle color': ['particle color', '粒子颜色'],
  'particle opacity': ['particle opacity', '粒子不透明度'],
  'plankton enabled': ['plankton enabled', '启用浮游'],
  'physics enabled': ['physics enabled', '启用物理'],
  'hash enabled': ['hash enabled', '启用空间哈希'],
  'map enabled': ['map enabled', '启用地图'],
  'distance field enabled': ['distance field enabled', '启用距离场'],
  'field cell size': ['field cell size', '场格边长'],
  'padding cells': ['padding cells', '外扩格数'],
  'gradient epsilon': ['gradient epsilon', '梯度采样步长'],
  'analytic refine distance': ['analytic refine distance', '解析细化距离'],
  'interaction radius': ['interaction radius', '作用半径'],
  'min radius / body': ['min radius / body', '最小半径 / 体长'],
  'body length': ['body length', '体长'],
  'body radius': ['body radius', '体半径'],
  'base radius': ['base radius', '基准半径'],
  'base height': ['base height', '基准高度'],
  'column radius': ['column radius', '柱半径'],
  'column height': ['column height', '柱高'],
  'cube size': ['cube size', '立方体边长'],
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
  'threat panic target': ['threat panic target', '威胁恐慌目标值'],
  'panic rise /s': ['panic rise /s', '恐慌上升 /s'],
  'panic decay /s': ['panic decay /s', '恐慌衰减 /s'],
  'panic speed ×': ['panic speed ×', '恐慌速度 ×'],
  'panic avoidance suppression': ['panic avoidance suppression', '恐慌压低避障'],
  'panic → cohesion 下降': ['panic → cohesion drop', '恐慌 → 凝聚下降'],
  'panic → 转向加成': ['panic → turn bonus', '恐慌 → 转向加成'],
  'panic 触发下限': ['panic threshold', '恐慌触发下限'],
  'panic 邻居传播': ['panic contagion', '恐慌邻居传播'],
  'starvation effect': ['starvation effect', '力竭死亡特效'],
  'spawn defaults': ['spawn defaults', '生成默认值'],
  'spawn mode': ['spawn mode', '生成方式'],
  'spawn radius': ['spawn radius', '生成半径'],
  'initial spawn attempts': ['initial spawn attempts', '初始生成尝试次数'],
  'fish impulse': ['fish impulse', '鱼的冲量'],
  'impulse limit': ['impulse limit', '冲量上限'],
  'linear damping': ['linear damping', '线性阻尼'],
  'angular damping': ['angular damping', '角阻尼'],
  'position damping': ['position damping', '位置阻尼'],
  'orientation damping': ['orientation damping', '朝向阻尼'],
  restitution: ['restitution', '弹性'],
  density: ['density', '密度'],
  'gravity X': ['gravity X', '重力 X'],
  'gravity Y': ['gravity Y', '重力 Y'],
  'gravity Z': ['gravity Z', '重力 Z'],
  'min sustained speed ×': ['min sustained speed ×', '最低持续速度 ×'],
  'min turn ×': ['min turn ×', '最低转向 ×'],
  'size → speed exponent': ['size → speed exponent', '体型 → 速度指数'],
  'size → turn exponent': ['size → turn exponent', '体型 → 转向指数'],
  'capture length': ['capture length', '捕食距离'],
  'burst radius': ['burst radius', '冲刺半径'],

  // 障碍物字段 —— 这些标签是从对象的键名直接生成的
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

  // 参数标签 —— 源是中文的，补英文
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
  存量下限比例: ['stock floor ratio', '存量下限比例'],
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
  目标锁定时长: ['target lock duration', '目标锁定时长'],
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

// 动态拼出来的标签：${kind} spawn ${axis} / heading ${axis} / spawn ${axis}。
// 轴名（x/y/z）和 kind 是数据，不翻译。
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
 * 翻译一个界面字符串。查不到就原样返回 —— 鱼群名、障碍 key 这类
 * 用户数据本来就不该被翻译。
 */
export function t(text, lang = language) {
  if (typeof text !== 'string' || text === '') return text;

  const exact = lookup(text, lang);
  if (exact !== null) return exact;

  // 'Advanced · Runtime'、'鱼群 · 大' 这种复合标题：两侧各自查表再拼回去。
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

/** 翻译 Tweakpane 的 options 映射（键是显示名，值是取值）。 */
export function translateOptions(options, lang = language) {
  const result = {};
  for (const [display, value] of Object.entries(options)) {
    result[t(display, lang)] = value;
  }
  return result;
}
