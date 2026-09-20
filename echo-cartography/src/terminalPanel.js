import { PLAN } from './params.js';
// Terminal panel -- where the centralized decision layer becomes visible.
//
// It and the parameter panel are two different things and should not be
// mixed together:
//   parameter panel = a development tool, the knobs used for tuning
//   terminal panel  = part of the work itself. This project is a hybrid of
//                     distributed and centralized intelligence; the
//                     individual half is visible in the 3d scene (the swarm
//                     swimming, avoiding obstacles, panicking), and if the
//                     centralized half is not displayed, the audience only
//                     sees a school of fish.
//
// So what is shown here is what the terminal knows and what it has decided:
// the reconstructed map, how far plan-view coverage has got, how many
// patches are still unexplored, who is being sent where, and how much
// bandwidth the uplink is taking.
//
// This file only touches the DOM, never three.js (the point cloud is still
// drawn into #map by mapView with a scissor rect).

const STORE = 'echo-terminal-ui-v2';

export function createTerminalPanel({ root, i18n, grid, terminal, bus, flock, mapView, frontier }) {
  // Fold state is kept in local storage: once the panel has been arranged,
  // a reload should not pop every section open again
  let ui = { min: false, map: true, cover: true, front: true, link: true };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved) ui = { ...ui, ...saved };
  } catch { /* a corrupt value just means defaults; not worth an error */ }
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

  // Clicking a section's header bar folds it. The button in the top right
  // corner of the panel minimizes the whole thing.
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

  // ── Plan-view heat map ───────────────────────────────────────────────────
  const planCanvas = $('#tp-plan');
  const planCtx = planCanvas.getContext('2d', { alpha: false });
  let columnMap = null;
  let planImage = null;
  let lastPlanDraw = -Infinity;
  // Colors: unknown / free column / occupied column (hit by plan-view
  // coverage)
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
    // Nothing is drawn while folded or minimized, to save CPU
    if (ui.min || !ui.cover) return;
    // 8 Hz is enough for the heat map underlay
    if (now - lastPlanDraw < 0.12) return;
    lastPlanDraw = now;

    // The heat map resolution gets finer with the phase: coarse during roam
    // → finer during plan/frontier
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
    // On a finer grid the markers have to be a bit larger to stay visible
    const markR = Math.max(1, Math.round(Math.min(nx, nz) / 80));
    const mark = (x, z, rgb, r) => {
      const [px, py] = worldToPlan(x, z, w, h);
      const ix = Math.round(px);
      const iy = Math.round(py);
      planCtx.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
      planCtx.fillRect(ix - r, iy - r, r * 2 + 1, r * 2 + 1);
    };

    // Swarm centroid (where the distributed half sits on the map)
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

    // Frontier targets issued by the terminal (the centralized decision)
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

    // Only plan-view coverage is kept: at the start of a mission all we know
    // is the flat mission area, so we do not pretend to know how complete
    // the depth is.
    bar($('#tp-cover-a'), terminal.columnCoverage);
    bar($('#tp-cover-fine'), terminal.fineCoverage);
    // Current heat map cell spacing (it varies with the phase)
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
    // With too few samples the ratio runs off toward infinity, and showing
    // "70000×" would only mislead
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

