import { PLAN } from './params.js';
// 终端面板 —— 集中式决策层被看见的地方。
//
// 它和参数面板是两种东西，不该混在一起：
//   参数面板 = 开发工具，调参用的旋钮
//   终端面板 = 【作品的一部分】。本项目是分布式 + 集中式的混合智能，
//              个体那半边在三维场景里看得见（集群在游、在避障、在恐慌），
//              集中式那半边如果不显示出来，观众只会看到一群鱼。
//
// 所以这里显示的是终端【知道什么、决定了什么】：
// 重建出的地图、俯视覆盖到哪了、还剩几块没探、正在派谁去哪、上行占了多少带宽。
//
// 本文件只碰 DOM，不碰 three.js（点云仍由 mapView 用 scissor 画进 #map）。

const STORE = 'echo-terminal-ui-v2';

export function createTerminalPanel({ root, i18n, grid, terminal, bus, flock, mapView, frontier }) {
  // 折叠状态存本地：调完一次面板，刷新后不该又全弹回来
  let ui = { min: false, map: true, cover: true, front: true, link: true };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved) ui = { ...ui, ...saved };
  } catch { /* 存坏了就用默认值，不值得为此报错 */ }
  const save = () => {
    try {
      localStorage.setItem(STORE, JSON.stringify(ui));
    } catch { /* flocks: storage can be unavailable; folds are then not remembered */ }
  };

  const $ = (id) => root.querySelector(id);
  const sections = {
    map: { el: $('#tp-map'), key: 'map' },
    cover: { el: $('#tp-cover'), key: 'cover' },
    front: { el: $('#tp-front'), key: 'front' },
    link: { el: $('#tp-link'), key: 'link' },
  };

  function applyUi() {
    root.classList.toggle('min', ui.min);
    for (const k in sections) {
      sections[k].el.classList.toggle('folded', !ui[k]);
    }
    save();
  }

  // 每个小节的标题栏点一下折叠。整块面板右上角的按钮最小化。
  for (const k in sections) {
    sections[k].el.querySelector('.tp-h').addEventListener('click', () => {
      ui[k] = !ui[k];
      applyUi();
    });
  }
  $('#tp-min').addEventListener('click', (e) => {
    e.stopPropagation();
    ui.min = !ui.min;
    applyUi();
  });
  applyUi();

  const bar = (el, ratio, label) => {
    if (!el) return;
    const pct = Math.max(0, Math.min(1, ratio || 0)) * 100;
    el.querySelector('.tp-fill').style.width = pct.toFixed(1) + '%';
    el.querySelector('.tp-num').textContent = label ?? pct.toFixed(1) + '%';
  };

  // ── 俯视热力图 ────────────────────────────────────────────
  const planCanvas = $('#tp-plan');
  const planCtx = planCanvas.getContext('2d', { alpha: false });
  let columnMap = null;
  let planImage = null;
  let lastPlanDraw = -Infinity;
  // 颜色：未知 / 自由柱 / 占据柱（俯视覆盖命中）
  // flocks: light page colors (unknown = page line, free = pale blue,
  // occupied = rock brown, target = gold, swarm = blue).
  const COL_UNK = [226, 220, 207];
  const COL_FREE = [185, 205, 222];
  const COL_OCC = [143, 128, 104];
  const COL_TGT = [216, 160, 60];
  const COL_SWARM = [91, 144, 196];

  function worldToPlan(x, z, w, h) {
    const o = grid.origin;
    const spanX = grid.dim[0] * grid.voxel;
    const spanZ = grid.dim[2] * grid.voxel;
    const u = (x - o[0]) / spanX;
    const v = (z - o[2]) / spanZ;
    return [u * w, v * h];
  }

  function drawPlan(now) {
    // 折叠或最小化时不画，省 CPU
    if (ui.min || !ui.cover) return;
    // 热力底图 8Hz 够用
    if (now - lastPlanDraw < 0.12) return;
    lastPlanDraw = now;

    // 热力图分辨率随阶段变细：roam 粗 → plan/frontier 细
    const phase = terminal.phase || 'roam';
    const bins = PLAN.displayBin || {};
    const bin = bins[phase] || PLAN.bin || 1;
    const plan = grid.fillPlanMap(columnMap, bin);
    columnMap = plan.map;
    const nx = plan.width;
    const nz = plan.height;
    if (!nx || !nz) return;

    if (planCanvas.width !== nx || planCanvas.height !== nz) {
      planCanvas.width = nx;
      planCanvas.height = nz;
      planImage = planCtx.createImageData(nx, nz);
    }
    if (!planImage || planImage.width !== nx || planImage.height !== nz) {
      planImage = planCtx.createImageData(nx, nz);
    }
    const data = planImage.data;
    for (let i = 0; i < nx * nz; i += 1) {
      const kind = columnMap[i];
      const c = kind === 2 ? COL_OCC : kind === 1 ? COL_FREE : COL_UNK;
      const o = i * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
    }
    planCtx.putImageData(planImage, 0, 0);

    const w = nx;
    const h = nz;
    // 更细的网格上标记稍大一点，才看得见
    const markR = Math.max(1, Math.round(Math.min(nx, nz) / 80));
    const mark = (x, z, rgb, r) => {
      const [px, py] = worldToPlan(x, z, w, h);
      const ix = Math.round(px);
      const iy = Math.round(py);
      planCtx.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
      planCtx.fillRect(ix - r, iy - r, r * 2 + 1, r * 2 + 1);
    };

    // 集群质心（分布式那半边在地图上的位置）
    if (flock && flock.count > 0) {
      let sx = 0;
      let sz = 0;
      const p = flock.positions;
      const n = flock.count;
      for (let i = 0; i < n; i += 1) {
        const o = i * 3;
        sx += p[o];
        sz += p[o + 2];
      }
      mark(sx / n, sz / n, COL_SWARM, markR);
    }

    // 终端下发的前沿目标（集中式决策）
    const targets = terminal.targets || (terminal.target
      ? [[terminal.target.x, terminal.target.y, terminal.target.z]]
      : []);
    for (let i = 0; i < targets.length; i += 1) {
      const t = targets[i];
      if (!t) continue;
      const x = Array.isArray(t) ? t[0] : t.x;
      const z = Array.isArray(t) ? t[2] : t.z;
      mark(x, z, COL_TGT, markR + 1);
    }
  }

  function refreshLabels() {
    $('#tp-title').textContent = i18n.t('tpTitle');
    $('#tp-map .tp-h span').textContent = i18n.t('tpMap');
    $('#tp-cover .tp-h span').textContent = i18n.t('tpCover');
    $('#tp-front .tp-h span').textContent = i18n.t('tpFrontier');
    $('#tp-link .tp-h span').textContent = i18n.t('tpUplink');
    $('#tp-cover-a .tp-lbl').textContent = i18n.t('tpPlan');
    const fineLbl = $('#tp-cover-fine .tp-lbl');
    if (fineLbl) fineLbl.textContent = i18n.t('tpFine');
    const set = (id, key) => {
      const el = $(id);
      if (el) el.textContent = i18n.t(key);
    };
    set('#tp-lg-unk', 'tpLgUnk');
    set('#tp-lg-free', 'tpLgFree');
    set('#tp-lg-occ', 'tpLgOcc');
    set('#tp-lg-tgt', 'tpLgTgt');
    set('#tp-lg-swarm', 'tpLgSwarm');
    if (elRecallBtn && !terminal.formationReady) {
      elRecallBtn.textContent = i18n.t('tpRecallForming');
    }
  }

  const elPhase = $('#tp-phase');
  const elPipe = $('#tp-pipeline');
  const elNote = $('#tp-phase-note');
  const pipeSteps = elPipe ? Array.from(elPipe.querySelectorAll('.tp-step')) : [];
  const order = ['roam', 'plan', 'frontier', 'recall'];
  const elFrontier = $('#tp-frontier-n');
  const elCluster = $('#tp-cluster-n');
  const elTargets = $('#tp-targets');
  const elUp = $('#tp-up');
  const elRatio = $('#tp-ratio');
  const elPts = $('#tp-pts');
  const elRecallBar = $('#tp-recall-bar');
  const elRecallBtn = $('#tp-recall-btn');
  if (elRecallBtn) {
    elRecallBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (terminal.confirmDepart) {
        terminal.confirmDepart();
        if (flock) flock.departed = !!terminal.departed;
      }
    });
  }

  function update() {
    const phase = terminal.phase || 'roam';
    elPhase.textContent = i18n.t('tpPhase_' + phase);
    elPhase.dataset.phase = phase;
    root.dataset.phase = phase;
    root.classList.toggle('phase-plan', phase === 'plan');
    root.classList.toggle('phase-frontier', phase === 'frontier');

    const idx = Math.max(0, order.indexOf(phase));
    for (const el of pipeSteps) {
      const si = order.indexOf(el.dataset.step);
      el.className = 'tp-step';
      if (si >= 0 && si < idx) el.classList.add('on');
      if (si === idx) el.classList.add('on', 'now-' + phase);
    }
    if (elNote) {
      const noteKey = terminal.phaseNote || terminal.autoStartReason || '';
      const lived = terminal.phaseEnteredAt
        ? Math.max(0, (flock.time || 0) - terminal.phaseEnteredAt)
        : 0;
      if (terminal.departed) {
        elNote.textContent = i18n.t('tpNote_departed');
      } else if (noteKey) {
        const label = i18n.t('tpNote_' + noteKey);
        const nice = label && !String(label).startsWith('tpNote_') ? label : noteKey;
        elNote.textContent = nice + ' · ' + lived.toFixed(0) + 's';
      } else if (phase === 'plan') {
        elNote.textContent = i18n.t('tpPlanHint') + ' · ' + lived.toFixed(0) + 's';
      } else {
        elNote.textContent = '';
      }
    }

    // 只保留俯视覆盖：任务开始只知道平面任务区，不假装知道纵深完成度。
    bar($('#tp-cover-a'), terminal.columnCoverage);
    bar($('#tp-cover-fine'), terminal.fineCoverage);
    // 当前热力图格距（随阶段变）
    {
      const ph = terminal.phase || 'roam';
      const b = (PLAN.displayBin && PLAN.displayBin[ph]) || PLAN.bin || 1;
      const meters = (b * (grid.voxel || 0.6)).toFixed(1);
      const resEl = $('#tp-plan-res');
      if (resEl) resEl.textContent = meters + 'm/格';
    }
    drawPlan(flock && Number.isFinite(flock.time) ? flock.time : performance.now() / 1000);

    elFrontier.textContent = terminal.frontierCount ?? 0;
    elCluster.textContent = terminal.clusterCount ?? 0;
    const t = terminal.targets || [];
    elTargets.textContent = t.length
      ? t.map((p) => '(' + p[0].toFixed(0) + ', ' + p[2].toFixed(0) + ')').join('  ')
      : '—';

    const kb = bus.bytesPerSec / 1024;
    const ckb = bus.centralizedBytesPerSec(flock.count) / 1024;
    elUp.textContent = kb.toFixed(1) + ' KB/s';
    // 样本太少时比值会趋于无穷，显示"70000×"只会误导人
    elRatio.textContent = bus.eventsPerSec >= 20 ? (ckb / kb).toFixed(1) + '×' : '—';
    elPts.textContent = grid.occupiedCount.toLocaleString();

    if (elRecallBar && elRecallBtn) {
      const inRecall = (terminal.phase || '') === 'recall';
      elRecallBar.hidden = !inRecall || !!terminal.departed;
      const ready = !!terminal.formationReady && !terminal.departed;
      elRecallBtn.disabled = !ready;
      elRecallBtn.textContent = ready
        ? i18n.t('tpRecallConfirm')
        : i18n.t('tpRecallForming');
    }
  }

  return { update, refreshLabels };
}

