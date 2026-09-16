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
    // 该鱼种分成几个小群（spawnMode='pods' 时生效）。
    // 小群内互相看得见、小群之间看不见 —— 合并与再分裂由 boids 自己完成。
    podCount,
    cruiseSpeed: 0.23,
    maxSpeed: 0.46,
    turnSpeed: 2.8,
    metabolismMultiplier: 1,
    // 觅食效率：同时决定进食【转化率】和【尝试频率】。
    // 小鱼靠浮游为生；中鱼 1/4；大鱼 0.01 ≈ 几乎不主动吃浮游。
    // "优先吃鱼"由代码保证：锁定猎物时不觅食（见 _updateEcology）。
    // 【现在是倍率，不是速率】。真正的滤食频率 = 这个 × size^grazeSizeExponent
    // （见 ecology.grazeSizeExponent）。原来这里是三个手填的数
    // （1 / 0.25 / 0.01），编码的不是物理而是【生态位】—— 而生态位应该
    // 从收支里涌现，不该由人指定。纯捕食者可以设 0。
    grazeRate: 1,
    separationWeight: 0.8,
    alignmentWeight: 0.45,
    cohesionWeight: 0.4,
    spawnRegion: {
      centerX,
      centerY: 0,
      centerZ: 0,
      // 出生 blob 必须明显大于该群的 separationRadius，否则整群在出生瞬间
      // 全部落在彼此的排斥半径内，会被一起炸开。大群的 sepR 最大(0.189)
      // 而原来 blob 最小(0.22) —— 64% 的鱼互斥，这就是"开局往反方向跑"。
      radius: id === 'red' ? 0.45 : 0.36,
    },
    // 全部朝最长轴（x）。原来小/中朝 z，而 z 只有 x 的 1/2.5 长，
    // 整群列队同向出发 → 几秒内一起撞墙。
    initialHeading: { x: 1, y: 0, z: 0 },
  };
}

export const DEFAULT_EXPERIMENT_CONFIG = Object.freeze({
  runtime: {
    project: 'aquarium',
    mode: 'steady',
    populationPreset: 'full',
    seed: 1001,
    // 每次重开是否换新种子。关掉则每局完全一致（调试/复现用）。
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
      color: '#e5a441',
      count: 400,
      size: 1,
      targetNeighbors: 8,
      podCount: 10,
      centerX: 0.32,
    }),
    school({
      id: 'blue',
      name: 'Blue',
      color: '#4f9fcf',
      count: 200,
      size: 1.5,
      targetNeighbors: 8,
      podCount: 8,
      centerX: -0.05,
    }),
    school({
      id: 'red',
      name: 'Red',
      color: '#c95252',
      count: 80,
      size: 2.25,
      targetNeighbors: 5,
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
    minNeighborRadiusFactor: 3,
    // 比例对齐原版 boids.js（sep 0.1 / ali 0.24 / coh 0.45 / detect 0.23）。
    // 原版的 alignment 邻域是 cohesion 的一半以上 —— 对齐邻居多，
    // 才有"整片一起转"的鱼群感；separation 反而更紧，群才压得住。
    alignmentRadiusFactor: 0.533,
    separationRadiusFactor: 0.222,
    detectionLengthFactor: 0.511,
    // 视锥只门控 alignment/cohesion，separation 保持全向（侧线感）。
    // 原版注释：前向视锥打破配对对称性，方向信息必须"传播"过鱼群
    // 而不是瞬间同步 —— 这是鱼群感的来源。
    fovDegrees: 300,
    // 'inverse' = 原版默认，近距离斥力远强于线性
    separationFalloff: 'inverse',
    // 小群内平均间距 = 此系数 × separationRadius。1.5 = 不挤不散。
    podSpacingFactor: 1.5,
    // cohesion 距离衰减。'inverse' 让每条鱼被自己所在的小群主导，
    // 小群才能维持而不是一碰就并；'uniform' 是经典 boids 的无权重质心。
    cohesionFalloff: 'inverse',
    // 出生朝向散布（0 = 整群同向列队，1 = 接近随机）
    spawnHeadingJitter: 0.6,
    // 体型 → 社群倾向：weight ×= size^-exponent。
    // 0 = 体型不影响；越大越强调"大鱼独行、小鱼成群"。
    // spawn-and-variety: 0.6 keeps size personality without collapsing medium/large sociality.
    crossSeparationScale: 0.15,
  },
  relations: {
    // Master switch for predation. When false, every pair of schools is
    // treated as peers and no capture happens, whatever their sizes.
    enabled: true,
    k: 1.35,
    // 【原依据已证伪】此处曾写「见 tools/ecosystem_search.py：搜索 216 种
    // 结构，稳定的前 8 名全部是 KMax=1.667」。该脚本把 Kleiber 写反了
    // （代谢 ∝ 体型^-0.75），并且给鱼加了繁殖 —— 而游戏在该脚本提交前
    // 9 小时就删掉了补充机制。把这两条对齐后重跑：216 种结构 0 种存活，
    // 全部塌成「只剩小鱼」。详见 ECOLOGY-DECISIONS.md。
    // 猎物体型窗口上界。1.667 时 large/small = 2.25 超窗 →「大鱼看不见小鱼」，
    // 大鱼只剩 medium 一种食物。2.5 让它把小鱼也纳入食谱。
    // （教学关四课和三关都自己覆盖了 KMax，这个默认值只影响水族馆。）
    KMax: 2.5,
    hysteresis: 0.1,
    pursuitWeight: 1.05,
    burstRadiusFactor: 0.75,
    burstWeight: 2.2,
    // 追不上就放弃：这么多秒内没有追到新的最近距离，就放掉这条，
    // 并且在它离开 burstRadius 之前不再选它。
    giveUpSeconds: 2,
    // 选目标的平局带：两条鱼距离相差不超过较远那条的这个比例，算一样近，
    // 这时取更顺路的。追着时，新候选也必须跳出这个带才会换过去。
    targetTieTolerance: 0.1,
    // 第一层（朝猎物群质心）的感知半径 = detectionLength × 此系数。
    // 独立捕食者版本是 6 倍左右，所以能从远处平滑接近而不是贴脸猛窜。
    // 大群 targetNeighbors 提高后 detectionLength 也涨了，
    // 这个系数要跟着降，否则 performance 预设下感知半径会超出缸体，
    // 捕食者在任何位置都知道猎物在哪，"远处平滑接近"就失效了。
    schoolSenseFactor: 5,
    evadeWeight: 1.3,
    evadeLateralWeight: 0.32,
    panicRiseRate: 4.5,
    panicDecayRate: 1.35,
    // --- 脉冲/闩锁参数（dev 分支 PANIC_PARAMS 原值）---
    directOn: 0.55,        // 直接威胁闩上的阈值
    directOff: 0.25,       // 松开阈值（滞回，防抖）
    holdTime: 0.5,         // 惊吓后恐慌钉在满值的时长 —— 四散而逃靠它
    refractoryTime: 1.4,   // 不应期，防止脉冲在鱼群里无限回响
    signalDecayTime: 0.35, // alarm 脉冲的指数衰减时间常数
    // 应急对齐：恐慌航向走独立通道，不进普通 alignment 平均，
    // 否则二十条镇定的邻居会把唯一看见危险的那条稀释掉。
    signalRadiusFactor: 0.8,
    signalThreshold: 0.35,
    // Detail switch (tier 6): the emergency heading channel together with its
    // source and receiver gains. Off: panic still spreads, but neighbours do
    // not copy the frightened fish's heading.
    emergencyAlignment: true,
    emergencyAlignmentWeight: 4,
    alignmentSourceBoost: 10,
    // 接收方增益：自己越慌越会听邻居（原版 alignmentReceiverBoost/Max）
    alignmentReceiverBoost: 1.5,
    alignmentReceiverMax: 2.5,
    // 逃逸瞄准捕食者的预测位置，不是当前位置
    escapePredictionTime: 0.15,
    // 受惊时鱼群是散开（flash expansion），不是收紧。原版验证过的方向。
    cohesionDrop: 0.6,
    panicTurnBoost: 1.2,
    // 低于此恐慌不施加逃逸力，避免整缸永远轻微抖动
    panicMinTrigger: 0.06,
    // 【恐慌分段】。低段和高段是【两种不同的行为】，不只是强度不同：
    //
    //   低段：应急对齐照常 → 整群一致急转（协同逃逸）
    //   高段：应急对齐【关掉】+ 内聚崩掉 → 各逃各的（炸开）
    //
    // 不分段的话，对齐会把想散开的鱼一直拽回一致，"各逃各的"永远出不来。
    //
    // 用【门闩】而不是单一阈值：越过 scatterEnter 才进高段，要掉回
    // scatterExit 以下才回低段。否则在阈值附近会来回抖，看起来像抽搐。
    // 两个数拉得比较开，是为了让低段【真的能被看见】—— 否则一局下来
    // 玩家只见得到炸开，见不到那个更好看的整群急转。
    // Detail switch (tier 6). Off: no high-panic segment, so cohesion only
    // drops by cohesionDrop and emergency alignment is never suppressed.
    scatterLatch: true,
    panicScatterEnter: 0.75,
    panicScatterExit: 0.45,
  },
  locomotion: {
    burstFactor: 1.35,
    panicSpeedFactor: 1.15,
    // 冲刺时身体绷直、转不动 —— 会冲过头，这是"像鱼"和"像粒子"的分界
    burstTurnFactor: 0.4,
    // 原版：鱼不会像潜艇一样垂直上下游。俯仰超过此角就压回去。
    maxPitchDegrees: 57,
    // 冲刺时社交权重的压低倍率（脱队扑食，但不脱离物理量级）
    burstSocialSuppression: 0.3,
    // 冲刺时的额外力预算倍率
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
    // 【觅食转向】。饿了才去找食物 —— 权重按「饿」加权，不按「近」加权：
    // 吃饱的鱼完全无视食物，饿的鱼才脱队。这样平时看着还是鱼群，
    // 只有真的快饿死时队形才散 —— 而队形散掉本身就成了饥饿的可见症状。
    // 按「近」加权的强力吸引会直接拆掉 boids 的观感。
    forageWeight: 0.9,
  },
  traits: {
    enabled: false,
    sizeSpeedPenaltyExponent: 0.2,
    minSustainedSpeedFactor: 0.55,
    sizeTurnPenaltyExponent: 0.55,
    minTurnFactor: 0.45,
  },
  ecology: {
    enabled: true,
    energyCapacity: 2 / 3,
    // 【能量罐随体型放大】。原来它是全局常数，也就是大鱼和小鱼的油箱一样大 ——
    // 而消耗按 size^basalSizeExponent 放大，净效果是【体型越大寿命越短】，
    // 和「大鱼吃一顿管很久」正好相反。这是又一个手填常数在偷偷编码体型效应
    // （编码成了"体型不影响储能"）。
    //
    // 寿命 ∝ size^(capacitySizeExponent − basalSizeExponent)：
    //   = 0.75  所有体型寿命相同
    //   = 1.5   大鱼明显更耐饿
    // 两个指数的差就是「体型对寿命的净影响」，一个有意义的旋钮。
    capacitySizeExponent: 1.5,
    initialEnergyRatio: 0.82,
    // 初始能量的个体抖动 ±比例。0 = 同族起点完全相同 → 必然同时饿死。
    initialEnergyJitter: 0.25,
    // 进食所得的倍率（"增加恢复耐力权重"）
    forageEnergyMultiplier: 2.2,
    // 【三档分配】。一餐分成自己 / 附近 / 同族全场三份。
    //
    // 原来只有「按族群平分」一档，而当时浮游是全局标量 —— 所有鱼的摄入
    // 本来就相同，那一档实际只在抹平 RNG 抖动，它要解决的空间不公平
    // 根本还不存在。浮游变成空间的之后不公平才真正出现：
    // 撞进云里的吃饱，队尾的什么都没有。
    //
    // 「附近」那一档是主力，而且【按空间半径分，不按族群 id 分】：
    // 一小群一起吃饱、一小群一起饿死 —— 「一群一群地死」是这么涌现出来的，
    // 不是按 id 分配出来的。
    // 「同族全场」只留一小档当地板，防止一条倒霉鱼在全族吃饱时饿死。
    // 不设跨物种的全局池：那会让猎物吃到的东西喂到捕食者身上。
    energyShareLocal: 0.3,
    energyShareSchool: 0.2,
    // 分给附近的半径。【固定值，不复用内聚半径】——内聚半径是从
    // targetNeighbors 反推的、会随密度漂，共享范围不该跟着社交尺度走。
    energyShareRadius: 0.25,
    // 【由收支平衡反推，不是拍脑袋】。断言：玩家体型(1.5)、耐力倍率 1 的鱼，
    // 在食物管够时刚好收支打平 ——
    //     basalRate × 1.5^0.75 == maxIntakePerFish (0.04)
    //     basalRate = 0.04 / 1.3554 = 0.0295
    // 于是耐力 1.5 有余量、耐力 0.5 消耗翻倍必死，而中性【勉强过线】——
    // 正是「中间刚好活得下去，往外走就死」要的形状，不用手调。
    // ⚠️ 暂定值：整轮改造结束后要连同其他数值一起重定。
    basalRate: 0.0295,
    basalSizeExponent: 0.75,
    burstMetabolicRate: 0.035,
    captureEnergyPerSize: 1,
    // 【孤注一掷】。能量掉到 desperationEnterRatio 之下时进入：冲刺不再被
    // minBurstEnergyRatio 卡住、速度上浮，而当场只扣一部分代价 ——
    // 剩下的记成【债】，在随后 debtSettleSeconds 里慢慢结算。
    //
    // 修的是一个真实的死锁：代谢按体型放大之后大鱼很快掉到 1/3 以下，于是
    // 【冲不动 → 抓不到 → 更饿】。现实里饿的掠食者应该更拼命，不是躺平。
    //
    // 三条让它不变成"白嫖"的规矩：
    // 1. 【债不会被吃饱抹掉】。靠孤注一掷捕食成功的鱼，仍然比从没需要过它的
    //    鱼更差 —— 那才是「代价会被继承」。债扣到能量 0 也会死。
    // 2. 【门闩】用过一次必须回到 desperationRecoverRatio 才能再用。
    // 3. 【时长固定不可延长】。它该有一个戏剧性的形状（你有 N 秒），
    //    不是一种要经营的资源。
    // 计时结束仍没缓过来 → 力竭：速度 ×desperationExhaustedSpeed 直到恢复。
    minBurstEnergyRatio: 1 / 3,
    // Detail switches (tier 6): the last-ditch sprint, and paying for part of
    // it later as debt.
    desperation: true,
    desperationDebt: true,
    desperationEnterRatio: 0.22,
    desperationRecoverRatio: 0.6,
    desperationSeconds: 6,
    desperationSpeedBoost: 1.25,
    // 拼命时【追得更凶】，不只是游得更快。pursuitWeight 是"附近有猎物就
    // 一直施加"的那条力，把它放大才是真的"扑上去"；只加速度的话，
    // 一条又快又不往猎物方向拐的鱼只是在乱窜。
    desperationPursuitBoost: 2,
    desperationCostShare: 0.5,
    debtSettleSeconds: 10,
    desperationExhaustedSpeed: 0.8,
    // 浮尸的【浮力加速度】（真实死鱼因鱼鳔残气多半浮起）。
    // 不是速率：它和 corpseDrag 一起决定终末速度 = 加速度 / 阻尼。
    // 0.15 / 2.4 ≈ 0.0625，和原来那个固定速率 0.06 大致相当，
    // 但多了一段自然的加速过程。
    corpseRiseAccel: 0.15,
    // 死亡渐变时长：颜色 本族→灰、姿态 逐渐翻肚、上浮渐入，都用这个时间常数
    corpseFadeTime: 1.6,
    // 死后残余动量的指数衰减率（滑行一段再停住）
    corpseDrag: 2.4,
    // 冲刺代谢是否按体型缩放（Kleiber）。false = 回到旧的平铺常数
    burstSizeScaled: true,
    // 单次浮游进食的基础能量。
    planktonEnergy: 0.06,
    // 只有能量低于 容量×此比例 才觅食。这是浮游可持续的关键门控：
    // 无门控时 64/s 消耗 vs 18/s 再生，几秒吃光且永不恢复。
    /**
     * 滤食能力随体型的指数。**这一个数替掉了三个手填的生态位常数。**
     *
     * 现实里滤食能力随鳃/口的【面积】走，所以大鱼滤食能力更强、不是更弱。
     * 而消耗是 size^0.75。于是：
     *
     *     滤食收入 / 消耗  ∝  size^(grazeSizeExponent − 0.75)
     *
     * 取 0.45 → 指数差 −0.3：体型 2.25 的鱼靠滤食只能覆盖约 79% 的开销，
     * 剩下的必须靠捕猎。**「大鱼有多依赖捕猎」就是这个指数差**，
     * 不再是「给大鱼填一个 0.01」。
     *
     * 注意捕食【不】取决于饥饿：追猎由关系矩阵驱动，所以大鱼吃得上浮游
     * 也照样捕猎 —— 能量只决定它扑不扑得动。
     */
    grazeSizeExponent: 0.45,
    grazeHungerRatio: 0.8,
    // 【三段，不是两段】。只有一个门槛的话鱼几乎永远在找食，鱼群就永远
    // 不成形。所以：
    //   > 80%  吃饱了，完全无视食物，正常成群
    //   50–80% 顺路吃（grazeHungerRatio），但不脱队去找
    //   < 50%  开始去找（下面这个），越饿转向越强
    seekHungerRatio: 0.5,
  },
  plankton: {
    enabled: true,
    halfSaturationFraction: 0.2,
    // 【单位是「口」】：一次觅食最多吃几口。一颗浮游有 usesPerParticle 口。
    maxIntakePerFish: 4,
    // 一条鱼够得着多远的浮游。【空间浮游的核心尺度】：它同时决定
    // 「附近有多少可吃」的采样半径，和空间网格的格边长。
    // 【必须和颗粒间距同量级】。0.12 时实测鱼到最近颗粒的距离是 0.14–0.39，
    // 也就是一直擦身而过、一口吃不到；0.3 时觅食命中率是 54%。
    // 另一半原因是判定是【静止的点测试】，而鱼在一次觅食尝试（约 1 秒）里
    // 会游过 0.2–0.5 —— 半径大一点等于近似了"扫过"。
    // ⚠️ 暂定值，和其他数一起到第六步重定。
    forageRadius: 0.3,
    // 看得见食物的距离（找食用）。比进食半径大得多，否则身边一空就完全
    // 没有方向。也是空间网格的格边长：找食扫 3×3×3 格就够，
    // 吃则扫同样 27 格再按较小的 forageRadius 过滤。
    senseRadius: 0.6,
    // 一颗能被吃几口。1 = 先到先得、一条鱼吃掉一颗（竞争最凶）。
    usesPerParticle: 3,
    // 吃空之后多久整颗回来。【逐关配置的那个"重置时间"就是这个】——
    // 比 growthRate 那种速率好想得多。
    regrowSeconds: 20,
    energyConversion: 1,
    visualCount: 1200,
    // sizeAttenuation=true，所以这是【世界单位】。0.01 在正常机位下只有
    // 约 1.5 像素 —— 那就是"看不见任何浮游生物"的原因。
    // 0.03 = 4.5 像素，且正好等于鱼体长（bodyLength 0.03），符合"和尸体差不多大"。
    pointSize: 0.03,
    // 深绿让浮游资源在深蓝水体中保持自然的藻类观感，并与蓝/橙/红鱼群区分。
    color: '#14532d',
    opacity: 0.75,
  },
  visual: {
    bodyLength: 0.03,
    bodyRadius: 0.008,
    radialSegments: 6,
    opacity: 0.92,
    // 侧倾：转向率 → 绕自身前进轴的滚转角
    bankingGain: 12,
    maxRollDegrees: 35,
    bankingSmoothing: 0.18,
  },
  capture: {
    // 【顺路吞食】。体型比超出 KMax 的猎物「太小,不值得追」—— 关系是
    // ignore,所以不会锁定、不会追。但现实里鲸不追单只磷虾,却照样会把
    // 游进嘴里的磷虾吞掉。
    //
    // 没有这一条的话,大鱼【只有一种食物】(体型比落在 [k, KMax] 里的那群),
    // 而代谢按体型放大之后那一种根本不够。加上它,大鱼在小鱼群里穿行时
    // 会有稳定的低速进食 —— 这也正是滤食的样子。
    //
    // 不需要锁定、不需要追击,只判定"恰好贴上了"。它的节流来自饱腹感
    // (吃饱了就不再进食),不是冷却。
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
    // 辉光是普通混合的半透明球，靠「比背景亮」来读。深水关卡用白色，
    // 但近白底（教学关）下白球等于隐形，那边会覆盖成深墨色读成暗脉冲。
    biteGlowColor: '#ffffff',
    biteGlowRadius: 0.28,
    biteGlowDuration: 0.45,
    biteGlowStrength: 0.85,
    biteGlowFalloff: 2.4,
    // 进食特效：一小簇向上飘散的浅色碎屑
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
  entry(
    'runtime.populationPreset',
      '运行',
      'population preset',
      'rebuildScene',
      {
        options: {
          '完整 680': 'full',
          '性能 320': 'performance',
          '自定义': 'custom',
        },
      }
  ),
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
  entry(
    'perception.alignmentRadiusFactor',
    '感知',
    'radius ×（全局）',
    'live',
    { min: 0.05, max: 1, step: 0.01 }
  ),
  entry(
    'perception.separationRadiusFactor',
    '感知',
    'radius ×（全局）',
    'live',
    { min: 0.05, max: 1, step: 0.01 }
  ),
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
  entry('relations.KMax', '关系', '猎物体型窗口上界', 'live', {
    min: 1.05,
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
  entry('relations.signalThreshold', '关系', '应急信号阈值', 'live', {
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
  entry('ecology.forageEnergyMultiplier', '生态能量', '进食能量 ×', 'live', {
    min: 0.1,
    max: 8,
    step: 0.05,
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
    'plankton.energyConversion',
    '浮游资源',
    'energy / plankton',
    'live',
    { min: 0, max: 10, step: 0.01 }
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
    // bounds / chamber 是【可选】字段（每鱼群包围盒与隔间隔离，见
    // experiment-simulation.js 的 _refreshSchoolBounds / _isolateChambers）。
    // 校验器是双向的 —— 未登记的字段报错，已登记但缺失的字段同样报错，
    // 所以只能按鱼群实际声明了什么来生成，不能无条件登记。
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
        // Game 的三代乘法遗传不做 silent clamp：三次顶点选择的合法
        // 极值是 1.5 × 0.5³ = 0.1875 与 1.5 × 1.5³ = 5.0625。
        // 只为蓝色玩家鱼放宽；实验调试项目继续使用原安全范围。
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
        // 体型、速度和耐力累计后的三代顶点包络约为
        // 0.0143–23.7874。范围只负责合法承载，不改变或钳制领域值。
        min: gamePlayer ? 0.005 : 0.1,
        max: gamePlayer ? 25 : 5,
        step: 0.01,
      }),
      entry(`${p}.grazeRate`, group, '尸体觅食 ×', 'live', {
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
