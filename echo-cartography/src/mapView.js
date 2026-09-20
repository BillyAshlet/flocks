// Point cloud map window -- what the terminal sees.
//
// This is the central image of the whole project: black at the start, the
// terrain growing bit by bit as the swarm patrols. No camera ever
// photographed this map; it is inferred entirely from near-misses.
//
// It has its own scene and camera, clipped into a DOM box with a scissor
// rect -- it shares the main canvas rather than opening a second WebGL
// context.

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

  // Mission bounding box: it gives the point cloud a reference, otherwise
  // points hanging in space have no readable scale
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

  // ── Point cloud ──
  // The position buffer is allocated at full size once and drawRange
  // controls how much of it is drawn -- rebuilding the BufferGeometry every
  // frame grinds the main thread to a halt, while incremental writes only
  // touch the few slots that are new.
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
  // Frustum culling off: the bounding sphere is computed from the initial
  // (empty) geometry, so with culling on the whole cloud disappears
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

  let written = 0; // slots already written into the buffer

  function paint(slot) {
    const idx = grid.occupied[slot];
    grid.centerOf(idx, _c);
    const o = slot * 3;
    positions[o] = _c[0];
    positions[o + 1] = _c[1];
    positions[o + 2] = _c[2];
    // More observations means brighter. sqrt rather than linear: areas with
    // few observations (the frontier that was just reached) are almost black
    // under a linear mapping, and you cannot see the map growing.
    //
    // But the gain must not be too large either: at ×2.6 the color already
    // saturated once the evidence reached 76, so after two minutes of
    // running the screen was all at the brightest color, the whole cloud
    // smeared into a white slab and the differences in observation density
    // were invisible. The curve now spans the full evidence range, keeping a
    // visible base tone in the dark areas.
    const e = grid.evidence[idx];
    const k = Math.min(1, Math.sqrt(Math.max(0, e) / MAP.evidenceMax) * 1.15);
    _mix.copy(cold).lerp(calm, k);
    if (k > 0.78) _mix.lerp(hot, ((k - 0.78) / 0.22) * 0.45);
    colors[o] = _mix.r;
    colors[o + 1] = _mix.g;
    colors[o + 2] = _mix.b;
  }

  // Called every frame: it writes only the new points, then refreshes the
  // color of a small batch of older ones along the way
  let refreshCursor = 0;
  function sync() {
    if (grid.dirtySlots.length) {
      for (const slot of grid.dirtySlots) {
        if (slot < grid.occupiedCount) paint(slot);
      }
      grid.dirtySlots.length = 0;
    }
    // Evidence for old points keeps rising and the color has to follow, but
    // refreshing all 400,000 points every frame is too expensive, so a small
    // batch is refreshed round-robin -- the brightness changes gradually
    // anyway, so the delay is invisible.
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

    // setViewport/setScissor take logical pixels; three multiplies by the
    // DPR internally. Multiplying again here scales twice and the window
    // overflows the main view.
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
