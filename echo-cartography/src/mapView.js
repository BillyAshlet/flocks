// 点云地图窗口 —— 终端看到的东西。
//
// 这是整个项目的核心画面：一开始全黑，随集群巡游一点一点长出地形。
// 这张地图从来没有被任何一台相机拍到过，它完全是由"险些撞上"反推出来的。
//
// 独立的 scene + camera，用 scissor 裁进一个 DOM 方框 —— 与主画面共用
// 同一块画布，不额外开 WebGL 上下文。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TANK, MAP, PALETTE } from './params.js';

const _c = [0, 0, 0];

export function createMapView(grid, renderer, hostEl) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.background);

  const camera = new THREE.PerspectiveCamera(46, 1, 0.5, 1200);
  const dist = TANK.width * 1.25;
  camera.position.set(dist * 0.55, dist * 0.5, dist * 0.72);

  const controls = new OrbitControls(camera, hostEl);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 20;
  controls.maxDistance = TANK.width * 3;
  controls.target.set(0, -TANK.height * 0.15, 0);

  // 任务包围盒：给点云一个参照，否则悬空的点看不出尺度
  scene.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(
        new THREE.BoxGeometry(TANK.width, TANK.height, TANK.depth)
      ),
      new THREE.LineBasicMaterial({
        color: PALETTE.boundsEdge, transparent: true, opacity: 0.35,
      })
    )
  );

  // ── 点云 ──
  // 位置缓冲一次性开满，靠 drawRange 控制画多少 —— 每帧重建 BufferGeometry
  // 会把主线程拖死，而增量写入只碰新增的那几个槽位。
  const positions = new Float32Array(MAP.maxPoints * 3);
  const colors = new Float32Array(MAP.maxPoints * 3);
  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const colAttr = new THREE.BufferAttribute(colors, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('color', colAttr);
  geometry.setDrawRange(0, 0);
  // 关掉视锥剔除：包围球是按初始（空）几何算的，不关会整片消失
  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      // flocks: small mid-tone points vanish into a light background, so
      // they are drawn larger and darker than on the original dark page.
      size: MAP.pointSize * 1.8,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    })
  );
  points.frustumCulled = false;
  scene.add(points);

  const calm = new THREE.Color('#3f6f9a');
  const hot = new THREE.Color('#c98a1f');
  const cold = new THREE.Color('#6f624d');
  const _mix = new THREE.Color();

  let written = 0; // 已写进缓冲的槽位数

  function paint(slot) {
    const idx = grid.occupied[slot];
    grid.centerOf(idx, _c);
    const o = slot * 3;
    positions[o] = _c[0];
    positions[o + 1] = _c[1];
    positions[o + 2] = _c[2];
    // 观测越多越亮。用 sqrt 而不是线性：低观测区（刚探到的边缘）
    // 在线性映射下几乎是黑的，看不出"地图正在长"。
    //
    // 但增益也不能太大：×2.6 时证据到 76 就已经封顶，跑两分钟后满屏都是
    // 最亮色，整片点云糊成一块白板，观测密度的差异完全看不出来。
    // 现在让曲线铺满整个证据范围，暗处保留可见的底色。
    const e = grid.evidence[idx];
    const k = Math.min(1, Math.sqrt(Math.max(0, e) / MAP.evidenceMax) * 1.15);
    _mix.copy(cold).lerp(calm, k);
    if (k > 0.78) _mix.lerp(hot, ((k - 0.78) / 0.22) * 0.45);
    colors[o] = _mix.r;
    colors[o + 1] = _mix.g;
    colors[o + 2] = _mix.b;
  }

  // 每帧调用：只写新增的点，再顺带刷新一小批老点的颜色
  let refreshCursor = 0;
  function sync() {
    if (grid.dirtySlots.length) {
      for (const slot of grid.dirtySlots) {
        if (slot < grid.occupiedCount) paint(slot);
      }
      grid.dirtySlots.length = 0;
    }
    // 老点的证据还在涨，颜色要跟上；但每帧全刷 40 万点太贵，
    // 所以轮转刷新一小批 —— 亮度变化本来就是渐进的，看不出延迟。
    const budget = Math.min(3000, grid.occupiedCount);
    for (let n = 0; n < budget; n += 1) {
      if (grid.occupiedCount === 0) break;
      refreshCursor = (refreshCursor + 1) % grid.occupiedCount;
      paint(refreshCursor);
    }

    if (grid.occupiedCount !== written || budget > 0) {
      written = grid.occupiedCount;
      geometry.setDrawRange(0, written);
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
    }
  }

  function render() {
    if (!hostEl || hostEl.hidden) return;
    const r = hostEl.getBoundingClientRect();
    const c = renderer.domElement.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return;

    controls.update();
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();

    // setViewport/setScissor 收的是逻辑像素，three 内部会自己乘 DPR。
    // 在这里再乘一次会双重缩放，窗口会溢出主画面。
    const x = r.left - c.left;
    const y = c.bottom - r.bottom;
    const oldViewport = renderer.getViewport(new THREE.Vector4());
    const oldScissor = renderer.getScissor(new THREE.Vector4());
    const oldTest = renderer.getScissorTest();
    renderer.setViewport(x, y, r.width, r.height);
    renderer.setScissor(x, y, r.width, r.height);
    renderer.setScissorTest(true);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    renderer.setViewport(oldViewport);
    renderer.setScissor(oldScissor);
    renderer.setScissorTest(oldTest);
  }

  function reset() {
    written = 0;
    refreshCursor = 0;
    geometry.setDrawRange(0, 0);
  }

  function setPointSize(size) {
    points.material.size = size * 1.8;
  }

  return { scene, camera, controls, sync, render, reset, setPointSize };
}
