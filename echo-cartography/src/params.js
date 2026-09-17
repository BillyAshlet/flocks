// 全部可调参数。
//
// 尺度说明：本项目已从"玩家追鱼"改为"集群测绘一条海沟"，场景放大到
// 96×40×64（原 24×10×16 的四倍）。所有【长度类】参数按 SCALE = 3 等比放大
// —— 等比是关键：恐慌传染的调校（panicRadius 与 alignmentRadius 的比值）
// 依赖的是【比例】而非绝对值，等比缩放能原样保住那次实测结论。
const SCALE = 3;

// 探测区包围盒。这同时是前沿探索的任务边界 —— 盒外体素标为"任务外"
// 而非"未知"，否则开放方向的前沿永远不会耗尽，任务无法终止。
//
// 放大到 1.5 倍，但【探测距离刻意不跟着放】。
// 等比放大一切对覆盖率是零影响 —— 鱼、射线、地形同乘 k，相对覆盖完全不变，
// 只是画面变大。要让"探不完"成为真问题，场景必须相对于传感器变大。
export const TANK = { width: 144, height: 52, depth: 88 };

// 仿真时钟。speed=4 表示物理以 4 倍速推进（每帧多跑几步固定步长）。
// 渲染仍跟屏幕刷新；加速的是集群/建图，不是“跳帧糊弄”。
export const SIM = {
  speed: 1, // 1..16
};

export const FLOCK = {
  count: 260,
  // —— Boid 三规则（半径已 ×SCALE）——
  separationRadius: 0.55 * SCALE,
  separationWeight: 0.8,
  alignmentRadius: 1.5 * SCALE,
  alignmentWeight: 0.45,
  cohesionRadius: 2.2 * SCALE,
  cohesionWeight: 0.4,
  // —— 运动学 ——
  cruiseSpeed: 2.6 * SCALE,
  maxSpeed: 4.2 * SCALE,
  maxForce: 5.2 * SCALE,
  turnSpeed: 2.8,
  maxPitchDegrees: 55,
  // 视锥：超出这个角度看不见邻居。恐慌波因此有方向性。
  fovDegrees: 300,
  // —— 边界与避障 ——
  wallMargin: 0.6 * SCALE,
  edgeSoftness: 2.4 * SCALE,
  boundaryWeight: 2.2,
  // 障碍物避让权重（方向现由射线扇给出，见 SENSOR）
  obstacleWeight: 6.0,
  // 子群数。前沿探索时终端给每个子群【各自的目标】。
  // 全群共用一个目标 = 把 260 个探测器变成 1 个：实测群半径 42.4 → 14.5，
  // 点云产出反而掉 24%。聚合力只在同组内生效，否则拆完又被拉回来。
  groupCount: 4,
  // —— 游走噪声 ——
  wanderWeight: 0.35,
  // 负浮力下潜偏置（PLAN 的 P0 冷启动）。物理上就是配重下潜。
  //
  // 权重必须【小于】避障权重，否则集群会被压扁在沟底。
  // 它解决的是"行为"（集群不往开放水域上飘），"地图"那一半要靠包围盒天花板
  // —— 集群上方的未知体素按定义仍是前沿，只靠下潜偏置消不掉。
  // 单一机制同时管入场下潜与定深保持：力 ∝ (作业深度 − 当前深度)。
  //
  // 试过"恒定下潜 + 到深度后衰减到零"，两头都不对：一直开着集群趴在沟底
  // 贴地爬；衰减到零之后又飘回台面上方，等于跑出沟外。
  // 真实勘测 AUV 也不是这么干的 —— 它配平到作业深度然后【保持】。
  descentWeight: 0, // 默认关持续定深；改用 ALTITUDE 虚拟高度带
  // 作业深度取包围盒高度的比例而非写死数值 —— 场景一放大，写死的数值
  // 会突然落在沟顶开阔水域里，集群整批浮出沟外。
  workingDepth: -52 * 0.25, // 沟顶 0、沟底 −26，取沟腰
  depthBand: 11, // 偏离多远时定深力达到满值
};

// 射线扇传感器 —— M0 的核心新增。
//
// 它取代了原来的盒体最近点斥力场。那个东西躲得开障碍，但它不是一次测量：
// 没有射线，就没有 origin→hit 这一段，自由空间雕刻的输入根本不存在。
export const SENSOR = {
  // 探测距离。必须【大于】避障起效的距离，否则设备还没记录就已经转开了，
  // 地图上会出现大量空洞。约束：range > 避障生效距离 > 个体半径。
  range: 4.0 * SCALE,
  // 五根：中心 + 上下左右。
  // 一根只看正前方，侧面来的墙躲不掉，而且一次触发只产出一条测量；
  // 五根一次给五条【来自不同角度】的测量 —— 端点判定核要的正是这个。
  rayCount: 5,
  fanHalfAngleDeg: 25,
  // 发射保护时间。没有它，60 Hz × 260 条 × 5 根 ≈ 78000 事件/秒，
  // 带宽优势直接归零 —— 这不是优化项，是核心主张成立的前提。
  // 标定：速度 ~2.6、体素 0.5 m → 穿过一格需 0.19 s → 5 Hz 即不漏格，
  // 取 10 Hz 留 2 倍余量。这也正好是真实声呐采样率的量级。
  emitHz: 10,
  // 开阔水域不触发避障，那片空间会永远停在"未知"。低频补一条清空事件 ——
  // 真实声呐的"无回波"本身也是一次有效测量。
  clearHz: 1,
  // 未命中的射线为"往空处钻"投的票。
  // 只靠法向斥力会在正面撞墙时顶住不动（斥力与航向反平行，净效果只是减速）。
  openVote: 0.45,
};

// 原 heritage-lab PANIC_PARAMS，逐项保留语义。
export const PANIC = {
  // 威胁感知半径：多远的鱼会被吓到（可调 #1）
  // 原值 3.0 是在 24×10×16 缸里实测出来的最优：它必须【小于】才有涟漪可看
  // —— 半径太大时几乎所有鱼都"直接看见威胁"，社会传播没有施展空间。
  // 实测峰值 83 条恐慌中 65 条（78%）是被同伴传染的；半径 6.0 时只有 45%。
  // 场景放大后按 SCALE 等比缩放，保住的是与 alignmentRadius 的比值。
  panicRadius: 3.0 * SCALE,
  // 直接威胁的滞回闩锁：越过 On 才闩上，掉到 Off 以下才松开
  directOn: 0.55,
  directOff: 0.25,

  // 社会信号
  signalRadiusFactor: 1.0, // × alignmentRadius
  signalThreshold: 0.35,
  signalDecayTime: 0.35,
  holdTime: 0.5,
  // 不应期：没有它，脉冲会在鱼群里来回反射永不停止
  refractoryTime: 1.4,

  // 恐慌升降（升快降慢）—— 传染速度（可调 #3）
  riseTime: 0.08,
  fallTime: 0.75,

  // 应急对齐通道
  alignmentSourceBoost: 10.0,
  alignmentReceiverBoost: 1.5,
  alignmentReceiverMax: 2.5,
  emergencyAlignmentWeight: 4.0,

  // 恐慌的运动学后果 —— 逃逸强度（可调 #2）
  escapeWeight: 2.4,
  speedBoost: 0.65,
  panicTurnBoost: 1.2,
  cohesionDrop: 0.6,
  // 逃向捕食者的预测位置的反方向
  escapePredictionTime: 0.15,
};

// 大型生物 —— 取代原来的玩家，作为动态威胁源自主游弋。
//
// 换掉玩家不只是"去掉一个操作模式"：本项目要证明的是集群【自主】在
// 无人干预下完成测绘，手里握着一条鱼会让整个论点变成表演。
// 而且它正好对上提案里的动态干扰源（深海大型生物），恐慌机制的用途因此
// 是"让设备不被大鱼撞坏"，不是"让玩家去撞鱼"。
export const CREATURE = {
  count: 2,
  speed: 9,
  turnRate: 0.35, // 游走方向变化速率，越小越懒散
  bodyLength: 7,
  bodyRadius: 1.5,
  margin: 6, // 离包围盒壁多远开始转向
  // 地形避让。之前完全没有 —— 大鱼是直接从岩体里穿过去的。
  avoidMargin: 4.5, // 体表之外再留这么多余量
  avoidWeight: 6, // 必须压过游走噪声，否则会顺着岩壁一路蹭进去
};

// 个体外形。纺锤形（fusiform）—— 这是真实鱼类与水下航行器共有的低阻体形。
export const AGENT = {
  bodyLength: 1.15,
  bodyRadius: 0.2,
  tailLength: 0.5,
  tailRadius: 0.3,
};

// ── 配色 ───────────────────────────────────────────────────────
// 暖调深色 + 赭石点缀，取自《下游》的视觉语言。
// 关键取舍：冷静态用骨白而非青蓝 —— 深海本就没有颜色，蓝绿是"水族箱"的
// 联想，而这个项目讲的是"人到不了的地方"。暖灰更接近声呐成像的质感。
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



// ── 虚拟高度（终端水平墙 + 弱负浮力）────────────────────────
// 不预知地形 → 不写死 workingDepth。
//
// 实测教训：把 [yMin,yMax] 收成“作业层”再加带宽中线吸引，会把鱼群冻成
// 水平煎饼贴在上层——软墙只约束、不产生下探动机，中线拉力又打不过凝聚。
//
// 现行策略（天花板 + 弱负浮力）：
//   - yMax：投放/海面虚拟天花板（任务约束，不是地形）
//   - yMin：任务盒底附近，只防掉出仿真；默认开到接近 absMin
//   - sinkWeight：弱负浮力，提供下探动机；真实底靠障碍射线 + 硬碰撞顶住
//   - centerWeight 默认 0（保留旋钮做对照，不建议开）
//
// 注意：TANK 是任务探测盒，不是客观地形。缸壁软边界/硬钳 = 别游出任务区。
export const ALTITUDE = {
  enabled: true,
  // 下界直接放到任务盒底附近，不要收成“作业层”
  yMin: -52 * 0.5 + 2,
  yMax: 24,
  softMargin: 3,
  softWeight: 2.0, // 主要管天花板；贴边太猛会抖
  hard: false, // 硬钳容易把群压成单层
  // 弱负浮力（不是定深）。0.5 左右：能下探，又压不过 obstacleWeight=6
  sinkWeight: 0.55,
  // 带宽中线吸引：默认关。开了会重新引入“偏好深度”并容易结团
  centerWeight: 0,
  // 带已覆盖任务高度时不必再扩；保留开关给手动收窄带时用
  autoExpand: false,
  expandEvery: 8,
  expandStep: 3,
  absMin: -52 * 0.5 + 1.5,
  absMax: 52 * 0.5 - 1.5,
};

// ── 探索阶段机（ROAM → PLAN → FRONTIER → RECALL）──────────
//
// 分工：
//   ROAM     自由巡游，用【粗】俯视覆盖判断是否铺开
//   PLAN     细俯视补扫：哪里细覆盖虚就去探（不认柱/坑）
//   FRONTIER 前沿精修：自由∩未知边界
//   RECALL   可派前沿耗尽
//
// 粗俯视只用于 ROAM→PLAN；细俯视只用于 PLAN→FRONTIER。
// 前沿开早会拖后腿（实测），所以中间夹 PLAN，且默认 autoStart。

export const PLAN = {
  // 决策用细俯视：bin=1 → 0.6m。前沿啃竖直墙；俯视专门补水平覆盖。
  bin: 1,
  // 绝对阈值极高，只作「几乎铺满」的快捷出口；主退出是「不再涨」。
  autoStartCoverage: 0.995,
  // 细覆盖停滞 = 水平面已经榨干（到不了的地方也不会假达标）
  stallWindow: 20, // ~10s
  stallDelta: 0.0003, // 更苛刻：几乎完全走平才算停
  stallMinCoverage: 0.93, // 水平至少到 93% 后，停滞才算数
  maxDuration: 150,
  minCluster: 2,
  // B：进虚区内部 + 偏大块/可贴实体 + 驻留上下探
  dwellSeconds: 4.5,
  occAdjacentBonus: 1.45, // 贴着已有实体的虚区优先（顶/坑边）
  sizePower: 0.65, // 大块加权
  distSoft: 28, // 距离软惩罚尺度（米）
  maxAssignDist: 95, // 太远的虚区先不派（多半不可达）
  seekWeight: 2.0,
  verticalWeight: 1.0,
  verticalSpread: 10,
  // 驻留时上下扫的振幅（米）
  probeAmplitude: 8,
  probePeriod: 3.2,
  // PLAN 阶段传感器：仍朝前，但竖直半角拉大补水平顶/底；左右略开
  sensorFanHalfDeg: 30,
  sensorFanVertHalfDeg: 42,
  maxPitchDegrees: 72,
  separationScale: 0.9,
  cohesionScale: 0.22,
  alignmentScale: 0.65,
  // 热力图随阶段变细
  displayBin: {
    roam: 8,
    plan: 1,
    frontier: 1,
    recall: 1,
  },
};

// ── 召回 / 返回 ──────────────────────────────────────────
// 任务在足够分辨率下结束后：先高凝聚收拢，再上浮离场并隐藏。
export const RECALL = {
  // 列阵：高凝聚 + 每鱼一个阵位；先悬浮，不自动隐藏
  cohesionScale: 3.6,
  separationScale: 0.25,
  alignmentScale: 0.9,
  seekWeight: 2.2, // 拉向各自阵位，要够明显
  // 列阵成形时间（之后可点「确认召回」离场）
  formSeconds: 6,
  // 阵面高度：盒顶下边距
  exitMargin: 2.5,
  // 阵位间距（米）
  spacing: 2.0,
  // 到位后视为静止的半径；超出或遇险则归位/避障
  holdRadius: 1.2,
  // 近阵位时开始减速/锁转向的半径
  settleRadius: 3.5,
  brakeWeight: 6.0, // 到位刹车
  returnWeight: 2.6, // 避完大鱼后回到阵位
  // 回阵途中可接近常态；真正要锁的是列阵后的线速度+角速度
  approachSpeed: 2.4,
  // 列阵后（无捕食）转向倍率；0 = 朝向冻结
  holdTurnScale: 0,
  // 前沿→召回（折中）：
  //  1) 可派簇耗尽 = 经典结束
  //  2) 只剩极少噪声簇 + 短停滞 = 近似耗尽（不用等清零）
  //  3) 总时长上限兜底
  frontierStallWindow: 12, // ~6s 看趋势
  frontierStallDelta: 3,
  frontierMinTime: 14, // 至少认真啃一阵
  frontierSoftMaxClusters: 2, // ≤2 个可派簇且走平 → 近似耗尽
  frontierMaxTime: 75, // 再长就强制列阵，避免拖到天荒地老
};

export const FRONTIER = {
  enabled: false, // 手动强制前沿时用；auto 管线里由阶段机置位
  // 自动阶段机：ROAM → PLAN → FRONTIER
  autoStart: true,
  // ── ROAM → PLAN：粗俯视 ──
  autoStartCoverage: 0.85,
  stallWindow: 6,
  stallDelta: 0.004,
  stallMinCoverage: 0.5,
  period: 0.5,
  minCluster: 3, // 略提高：小噪声簇不当可派前沿
  seekWeight: 0.45,
  separationScale: 0.75,
  cohesionScale: 0.5,
  alignmentScale: 0.85,
};

// ── 建图 ───────────────────────────────────────────────────────
export const MAP = {
  // 体素边长。144×52×88 的场景按 0.6 m 是 240×87×147 ≈ 307 万格，
  // Int16 存证据约 6 MB —— 固定不涨，与任务时长无关。
  // 再细会让点云密到看不出结构，再粗则窄缝分辨不出来。
  voxel: 0.6,

  // 命中点沿射线退回自由空间的距离，单位 = 体素边长。
  // 0.5：退半格，专门打掉 AABB 表面被 floor 吸进实体内侧的决定性偏置。
  // 0：关闭（旧行为）。>1 会把壳整体推到表面外侧，窄缝可能变空。
  surfaceBias: 0.5,

  hitWeight: 3, // 端点得分
  kernelWeight: 1, // 六个面邻居的得分（端点判定核）
  // 自由空间雕刻：射线穿过的每一格扣分。
  // 这是唯一能把证据【减回去】的反证，也是分离动态目标的全部依据 ——
  // 海床穿不过去所以永远不被扣，游动的生物一旦游走就会被后续射线穿过。
  // 权重要小于 hitWeight（一次穿过就抹掉表面的话，掠射角的量化误差会把
  // 真实的墙咬出洞），但不能小太多 —— 这个比值就是"抹掉一个动态目标需要
  // 几倍于命中的穿过次数"。3:1 时实测抹不动。
  carveWeight: 2,

  occupiedThreshold: 4, // 净证据达到多少算"确认为实体"
  // evidence<=此值算自由（carve 后为负）。0 仍是未知。
  freeThreshold: -1,

  // 【封顶决定地图能不能忘掉旧东西，不是防溢出的小事。】
  //
  // 原来设 512：一条大鱼停留 40 次扫描，证据累到 120，之后要 60 次穿过
  // 才掉回阈值以下 —— 实测穿了 40 次它仍稳稳留在图上。
  // 证据能无限累积，停久了的动态目标就变成永久的了。
  //
  // 标准占据栅格用 log-odds 的紧夹逼正是为了这件事：
  // 【限制置信度的上限，地图才有能力改变主意。】
  // 封在 20：饱和后约 9 次穿过即可抹除，而实体永远不会被穿过。
  evidenceMin: -12,
  evidenceMax: 20,

  // 点云上限。超出后不再新增 —— 宁可少画一些，也不能让缓冲越界。
  maxPoints: 400000,
  pointSize: 0.42,

  // ── 粗栅格：给前沿探索用 ────────────────────────────────────
  //
  // 前沿检测不能在 307 万个体素上做。但这【不只是性能问题】：
  // 精细分辨率下的"前沿数"本质上是【已探空间的表面积】——
  // 探得越多表面越大，它只涨不跌，召回条件永远不会成立。
  // 实测 60 秒内前沿从 2.3 万涨到 14.5 万，没有任何回落趋势。
  //
  // 粗栅格问的是另一个问题：「这一块探明了没有」。
  // 那才是终端做宏观决策真正需要的粒度，也才可能耗尽。
  // 8³ 个体素合成一格 → 30×11×19 = 6270 格，全量扫一遍是微秒级的事。
  coarseFactor: 8,
  // 一个粗格里有多大比例的体素被确认自由，才算"这块能走"
  coarseFreeRatio: 0.06,
};

// ── 相机 ───────────────────────────────────────────────────────
export const CAMERA = {
  // 总览：轨道相机，鼠标拖拽旋转、滚轮缩放。
  // 俯角要够大才看得进沟里 —— 太平的视角会被近侧沟壁整个挡住。
  // flocks: farther back, so the canyon fits beside the terminal panel.
  overviewDistance: 240,
  overviewPitch: 0.7,
  // 跟随：点击任意个体切入，Esc 退出
  followBack: 4.5,
  followUp: 1.6,
  followLag: 6,
};
