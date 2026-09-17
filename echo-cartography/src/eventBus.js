// 事件总线 —— L2 层。集群往这里发，终端从这里读。
//
// 它同时是【带宽的度量点】：整个项目的核心主张是"传事件比传原始数据便宜
// 一到两个数量级"，那么这个数字就必须是【算出来的】，不是文档里写死的。
// 所以这里的字节数按字段逐项累加，不是拍一个常数。
//
// 本文件不 import three.js。

import { buildFan, decodeFace } from './sensor.js';

// ── 字节预算（按真实打包尺寸算，不含 JSON 之类的传输封装）──────────
//
// 一次发射（ping）= 一条事件，而不是每根射线一条：
//   origin 3×f32(12) + 航向 3×f32(12) + 半角 u8(1) + 命中掩码 u8(1)
//   + t f32(4) + id u16(2)                                  = 32 字节定长
//   + 【只有命中的射线】各占一个 f32                          + 4 × 命中数
//
// 漏检的射线不占浮点：掩码已经说明它漏检，而漏检的长度就是探测距离，
// 是已知量。
//
// 【实测结论，与最初的估计不符，记在这里以免以后又算错】
//   平均每次发射只有 1.22 根命中（不是五根全中），另外 3.78 根是漏检。
//   打包后平均 36.9 字节；同样这些命中若拆开各发一条是 39.1 字节。
//   所以打包在【字节上只省 1.06×】—— 最初按"五根全中"估的 3.1× 是错的。
//
// 那它为什么仍然值得做：拆开发时，漏检的射线【整个被丢掉了】。
// 打包版用几乎同样的字节，额外带上了每次发射 3.78 条自由空间证据 ——
// 而自由空间雕刻正是区分静态几何与动态目标的唯一手段。
//   → 同样的带宽，信息量是原来的数倍。
//
// 省下来的那部分不是压缩技巧，是【冗余】：五根射线共用同一个 origin，
// 方向又由航向加扇面几何完全决定 —— 可推导的东西不必上传。
// 真实声呐也是一个 ping 发一包波束，不是一束一包。
//
// 真正的大头削减要靠空间去重（贴壁平飞不重复发射），那是 M1 的事。
//
// 恐慌事件  pos(12) + intensity(4) + t(4) + id(2) + type(1) = 23 → 24
//
// 对照基线（纯集中式全量位姿）
//           pos(12) + vel(12) + quat(16) + t(4) = 44，且要 60 Hz 发
export const BYTES = { panic: 24, pose: 44 };

export function pingBytes(hitCount) {
  return 32 + 4 * hitCount;
}

// 解码用的方向缓冲，按射线数缓存，避免每条事件都新建数组
let _dirsCache = null;
function _decodeDirs(n) {
  if (!_dirsCache || _dirsCache.length !== n * 3) _dirsCache = new Float32Array(n * 3);
  return _dirsCache;
}

const MAX_LOG = 200000; // 约 20 分钟 @ 典型事件率；满了丢最旧的

export class EventBus {
  constructor() {
    this.log = [];
    this.frame = []; // 本帧新产生的事件，终端每帧消费
    this.subscribers = [];

    // 滚动 1 秒窗口统计。用时间戳队列而不是"每秒清零"，
    // 否则读数会跟着清零时刻上下跳，看起来像 bug。
    this._window = [];
    this.eventsPerSec = 0;
    this.bytesPerSec = 0;
    this.totalEvents = 0;
    this.totalBytes = 0;
  }

  _push(e, bytes) {
    e.bytes = bytes;
    this.log.push(e);
    if (this.log.length > MAX_LOG) this.log.shift();
    this.frame.push(e);
    this._window.push(e);
    this.totalEvents += 1;
    this.totalBytes += bytes;
    for (const fn of this.subscribers) fn(e);
  }

  // 一次发射。ts 是各射线的命中距离（−1 = 未命中），会被拷贝一份 ——
  // 传进来的是传感器每帧复用的临时数组，不拷贝就会被下一台设备覆盖掉。
  ping(ox, oy, oz, dx, dy, dz, halfAngleDeg, ts, faces, bnd, rayCount, range, t, id, vertHalfAngleDeg) {
    const copy = new Float32Array(rayCount);
    const faceCopy = new Uint8Array(rayCount);
    let mask = 0;
    let bmask = 0;
    let hitCount = 0;
    for (let k = 0; k < rayCount; k += 1) {
      copy[k] = ts[k];
      faceCopy[k] = faces ? faces[k] : 0;
      if (ts[k] >= 0) {
        mask |= 1 << k;
        hitCount += 1;
        // 打中任务边界的那几根：仍然携带真实距离（自由空间要雕到墙根），
        // 但标出来，终端不把它们当地形沉积。
        if (bnd && bnd[k]) bmask |= 1 << k;
      }
    }
    // 内存里仍存全部 N 个距离（解码方便），但【计费只算命中的那几个】——
    // 漏检的射线在真实打包里根本不占浮点，掩码就够了。
    // 带宽是本项目的核心主张，这个数字必须反映真实上传量。
    // face 每命中 1 字节：只编码 6 个轴对齐方向，几乎不增带宽。
    this._push(
      { type: 'ping', ox, oy, oz, dx, dy, dz, halfAngleDeg, vertHalfAngleDeg: vertHalfAngleDeg == null ? halfAngleDeg : vertHalfAngleDeg, ts: copy, faces: faceCopy, mask, bmask, range, t, id },
      pingBytes(hitCount) + hitCount
    );
  }

  panic(x, y, z, intensity, t, id) {
    this._push({ type: 'panic', x, y, z, intensity, t, id }, BYTES.panic);
  }

  // ── 解码 ────────────────────────────────────────────────────
  //
  // 终端拿到的是紧凑的 ping，但建图那边要的是一条条射线。这个函数把
  // 打包还原成射线，让 L3 完全不必知道扇面几何 —— 上传省带宽是 L2 的事，
  // L3 的接口保持"一条射线"这种最朴素的形式。
  //
  // 对每根射线回调 (ox,oy,oz, hx,hy,hz, hit, nx,ny,nz)：
  //   hit=true  → 端点占据，origin→hit 沿途自由；n* 为指向自由空间的表面法向
  //   hit=false → 整条 origin→端点 都是自由（无回波也是测量）
  forEachRay(e, cb) {
    if (e.type !== 'ping') return;
    const n = e.ts.length;
    const dirs = buildFan(e.dx, e.dy, e.dz, e.halfAngleDeg, n, _decodeDirs(n), undefined, undefined, e.vertHalfAngleDeg);
    const normal = [0, 0, 0];
    for (let k = 0; k < n; k += 1) {
      const t = e.ts[k];
      const reached = t >= 0;
      // 打中任务包围盒的射线：长度用【真实距离】（自由空间要一直雕到墙根），
      // 但 hit=false —— 那面墙不是地形，不该在图上留下点。
      // 实测它曾占点云的 28.4%。
      const isBoundary = reached && !!((e.bmask || 0) & (1 << k));
      const hit = reached && !isBoundary;
      const len = reached ? t : e.range;
      const o = k * 3;
      if (hit && e.faces) decodeFace(e.faces[k], normal);
      else normal[0] = normal[1] = normal[2] = 0;
      cb(
        e.ox, e.oy, e.oz,
        e.ox + dirs[o] * len,
        e.oy + dirs[o + 1] * len,
        e.oz + dirs[o + 2] * len,
        hit,
        normal[0], normal[1], normal[2],
        k
      );
    }
  }

  subscribe(fn) {
    this.subscribers.push(fn);
    return () => {
      const i = this.subscribers.indexOf(fn);
      if (i >= 0) this.subscribers.splice(i, 1);
    };
  }

  // 每帧末尾调用：滚动统计窗口、清空本帧队列
  tick(time) {
    const cutoff = time - 1;
    while (this._window.length && this._window[0].t < cutoff) {
      this._window.shift();
    }
    this.eventsPerSec = this._window.length;
    let bytes = 0;
    for (const e of this._window) bytes += e.bytes;
    this.bytesPerSec = bytes;
    this.frame.length = 0;
  }

  // 对照基线：同样这些设备，如果改成每帧全量位姿上传，要多少带宽
  centralizedBytesPerSec(agentCount, hz = 60) {
    return agentCount * hz * BYTES.pose;
  }

  reset() {
    this.log.length = 0;
    this.frame.length = 0;
    this._window.length = 0;
    this.eventsPerSec = 0;
    this.bytesPerSec = 0;
    this.totalEvents = 0;
    this.totalBytes = 0;
  }
}
