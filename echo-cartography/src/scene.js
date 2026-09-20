// Rendering layer. The algorithm side never imports this file, and the
// dependency stays one-way in the other direction too: here we only read
// simulation state, we never write back to it.
//
// The scene is a trench: stepped walls close in as they descend, leaving a
// channel open down the middle. The walls are assembled from axis-aligned
// boxes -- not out of laziness, but because ray intersection and
// ground-truth voxelization are both analytically exact on an AABB (see
// TERRAIN-SPEC.md). If it needs to look better, drape another mesh over it;
// that layer takes no part in the physics.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TANK, PALETTE, AGENT, CREATURE, CAMERA } from './params.js';

const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _camTarget = new THREE.Vector3();
const _lookAt = new THREE.Vector3();
const _calm = new THREE.Color(PALETTE.agentCalm);
const _afraid = new THREE.Color(PALETTE.agentPanic);
const _mix = new THREE.Color();
const _glowCalm = new THREE.Color(PALETTE.agentGlowCalm);
const _glowPanic = new THREE.Color(PALETTE.agentGlowPanic);
const _glowMix = new THREE.Color();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _bodyQ = new THREE.Quaternion();
const ROV_URL = new URL('../assets/models/industrial-deep-sea-inspection-rov.glb', import.meta.url).href;
const PREDATOR_URL = new URL('../assets/models/predator-red-fish.glb', import.meta.url).href;

// Fake light near the body: a translucent additive glow, with no real
// Point/SpotLight created.
// flocks: on a light background an additive glow disappears, so the halos
// are drawn with normal blending and kept faint.
const GLOW = {
  coreScale: 5,   // relative to bodyLength
  haloScale: 12,
  coreOpacity: 0.12,
  haloOpacity: 0.04,
};

// Dark red fake light for the predator: heavier and more menacing than the
// ROV's warm amber.
const CREATURE_GLOW = {
  coreScale: 3.2,  // relative to bodyLength
  haloScale: 8.5,
  coreOpacity: 0.14,
  haloOpacity: 0.05,
};

// The ROV's original materials are a cold cyan industrial palette, which
// clashes with the warm deep sea of the scene (bone white, ochre,
// trench-wall brown). They are remapped by role into a warm abyssal brass:
// warm grey shell, dark brown frame, brass fittings, amber lamps.
const ROV_TONE = {
  shell: new THREE.Color('#4f463c'),
  frame: new THREE.Color('#1b1713'),
  accent: new THREE.Color('#9a7d55'),
  eye: new THREE.Color('#e6c78a'),
  eyeEmissive: new THREE.Color('#a67c3a'),
};

function toneRovMaterial(base, emissive) {
  const eSum = emissive.r + emissive.g + emissive.b;
  const sum = base.r + base.g + base.b;
  // Originally bright cyan lamps / anything emissive → survey lamps go amber
  if (eSum > 0.15 || (base.b > 0.65 && base.g > 0.55)) {
    return { color: ROV_TONE.eye.clone(), emissive: ROV_TONE.eyeEmissive.clone() };
  }
  // Originally mid-bright cyan parts → brass fittings
  if (base.b > 0.25 && base.g > 0.2 && base.r < 0.15) {
    return { color: ROV_TONE.accent.clone(), emissive: new THREE.Color(0x000000) };
  }
  // Near-black structural frame
  if (sum < 0.12) {
    return { color: ROV_TONE.frame.clone(), emissive: new THREE.Color(0x000000) };
  }
  // Main shell
  return { color: ROV_TONE.shell.clone(), emissive: new THREE.Color(0x000000) };
}

// ── Spindle-shaped agent ───────────────────────────────────────────────────
// The low-drag body shape shared by real fish and underwater vehicles:
// tapered at both ends, thickest in the middle. It is made by revolving a
// profile line with LatheGeometry, with a small cone joined on as the tail.
function buildAgentGeometry() {
  const segments = 14;
  const profile = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    // The sine curve is raised to the power 0.75: fuller than plain sine,
    // while head and tail still taper to a point
    const r = AGENT.bodyRadius * Math.pow(Math.sin(Math.PI * t), 0.75);
    profile.push(new THREE.Vector2(Math.max(r, 1e-4), (t - 0.5) * AGENT.bodyLength));
  }
  const body = new THREE.LatheGeometry(profile, 10);

  const tail = new THREE.ConeGeometry(AGENT.tailRadius, AGENT.tailLength, 6, 1, true);
  tail.scale(1, 1, 0.35); // flattened into a tail fin rather than a cone
  tail.rotateX(Math.PI); // cone tip points at -Y (backwards)
  tail.translate(0, -AGENT.bodyLength / 2 - AGENT.tailLength / 2 + 0.06, 0);

  const merged = BufferGeometryUtils.mergeGeometries([body, tail], false);
  merged.rotateX(Math.PI / 2); // long axis turned from +Y to +Z = forward
  return merged;
}


// Bakes the multi-material low-poly ROV into a single BufferGeometry for an
// InstancedMesh.
// - the original model faces +X with the eyes on +X; this project's
//   convention is +Z forward, so it is rotated -90 degrees about Y
// - vertex colors keep the shell's material zones; instanceColor then adds
//   the calm/panic tint on top
// - no textures, no skeleton: after loading only one merged geometry is kept
async function loadRovAgentGeometry() {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(ROV_URL);
  const parts = [];
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;

    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const groups = (obj.geometry.groups && obj.geometry.groups.length)
      ? obj.geometry.groups
      : [{ start: 0, count: (obj.geometry.index ? obj.geometry.index.count : obj.geometry.attributes.position.count), materialIndex: 0 }];

    // Several primitives may be collapsed by the loader into a single mesh
    // with groups, so the vertex colors are baked group by group
    for (const group of groups) {
      const geom = obj.geometry.clone();
      // Keep only this group's index range
      if (obj.geometry.index) {
        const src = obj.geometry.index;
        const slice = new src.array.constructor(group.count);
        for (let i = 0; i < group.count; i += 1) slice[i] = src.array[group.start + i];
        geom.setIndex(new THREE.BufferAttribute(slice, 1));
      }
      geom.applyMatrix4(obj.matrixWorld);

      const mat = mats[group.materialIndex || 0] || mats[0] || {};
      const base = mat.color ? mat.color.clone() : new THREE.Color(0xffffff);
      const emissive = mat.emissive ? mat.emissive.clone() : new THREE.Color(0x000000);
      // Drop the original cold cyan and bake in the warm abyssal role
      // color; the lamps keep a little emissive brightness
      const toned = toneRovMaterial(base, emissive);
      const display = toned.color.clone().add(toned.emissive);
      // Lifted a little so it reads through the fog, but kept inside the
      // terrain's warm brown family (no longer leaning blue)
      display.r = Math.min(1, display.r * 1.18 + 0.04);
      display.g = Math.min(1, display.g * 1.12 + 0.03);
      display.b = Math.min(1, display.b * 1.05 + 0.02);

      const n = geom.attributes.position.count;
      const colors = new Float32Array(n * 3);
      for (let i = 0; i < n; i += 1) {
        colors[i * 3] = display.r;
        colors[i * 3 + 1] = display.g;
        colors[i * 3 + 2] = display.b;
      }
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      if (geom.attributes.normal) geom.deleteAttribute('normal');
      if (geom.attributes.uv) geom.deleteAttribute('uv');
      // Clear the groups so nothing is left over after the merge
      geom.clearGroups();
      parts.push(geom);
    }
  });

  if (!parts.length) throw new Error('ROV glb contained no meshes');

  let merged = BufferGeometryUtils.mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  if (!merged) throw new Error('failed to merge ROV geometries');

  // +X forward → +Z forward
  merged.rotateY(-Math.PI / 2);
  merged.computeBoundingBox();
  const center = new THREE.Vector3();
  merged.boundingBox.getCenter(center);
  merged.translate(-center.x, -center.y, -center.z);

  merged.computeBoundingBox();
  const size = new THREE.Vector3();
  merged.boundingBox.getSize(size);
  // Match the long axis to bodyLength. The ROV is fatter than the spindle
  // fish, so the Z extent is used rather than the diagonal, otherwise it
  // ends up scaled down too far.
  const s = AGENT.bodyLength / Math.max(size.z, 1e-6);
  merged.scale(s, s, s);
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

function makeGlowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.12)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildCreatureGeometry() {
  const segments = 16;
  const profile = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const r = CREATURE.bodyRadius * Math.pow(Math.sin(Math.PI * t), 0.7);
    profile.push(new THREE.Vector2(Math.max(r, 1e-4), (t - 0.5) * CREATURE.bodyLength));
  }
  const body = new THREE.LatheGeometry(profile, 14);
  const tail = new THREE.ConeGeometry(CREATURE.bodyRadius * 2.1, CREATURE.bodyLength * 0.34, 6, 1, true);
  tail.scale(1, 1, 0.22);
  tail.rotateX(Math.PI);
  tail.translate(0, -CREATURE.bodyLength / 2 - CREATURE.bodyLength * 0.14, 0);
  const merged = BufferGeometryUtils.mergeGeometries([body, tail], false);
  merged.rotateX(Math.PI / 2);
  return merged;
}

// Bakes the low-poly red fish into a single BufferGeometry for the predator
// Mesh.
// - the original model faces +X (snout at +X, tail fin at -X); this
//   project's convention is +Z forward → rotate -90 degrees about Y
// - vertex colors keep the material zones and add a dark red emissive
//   brightness, so the silhouette still reads through the fog
function tonePredatorMaterial(base) {
  const sum = base.r + base.g + base.b;
  // Near-black eye socket: keep a little dark red emission, like a pupil in
  // the abyss
  if (sum < 0.08) {
    return {
      color: new THREE.Color('#120303'),
      emissive: new THREE.Color('#4a0808'),
    };
  }
  // Brighter belly / fin edges → a hotter dark red
  if (base.r > 0.55) {
    return {
      color: new THREE.Color('#6e1610'),
      emissive: new THREE.Color('#5a0e0a'),
    };
  }
  // Main shell: deep dark red
  return {
    color: new THREE.Color('#3a0f0c'),
    emissive: new THREE.Color('#2a0806'),
  };
}

async function loadPredatorGeometry() {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(PREDATOR_URL);
  const parts = [];
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;

    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const groups = (obj.geometry.groups && obj.geometry.groups.length)
      ? obj.geometry.groups
      : [{ start: 0, count: (obj.geometry.index ? obj.geometry.index.count : obj.geometry.attributes.position.count), materialIndex: 0 }];

    for (const group of groups) {
      const geom = obj.geometry.clone();
      if (obj.geometry.index) {
        const src = obj.geometry.index;
        const slice = new src.array.constructor(group.count);
        for (let i = 0; i < group.count; i += 1) slice[i] = src.array[group.start + i];
        geom.setIndex(new THREE.BufferAttribute(slice, 1));
      }
      geom.applyMatrix4(obj.matrixWorld);

      const mat = mats[group.materialIndex || 0] || mats[0] || {};
      const base = mat.color ? mat.color.clone() : new THREE.Color(0x3a1210);
      const toned = tonePredatorMaterial(base);
      // display = albedo + part of the emissive, so both an InstancedMesh
      // and a single Mesh read as carrying a red glow
      const display = toned.color.clone().add(toned.emissive.clone().multiplyScalar(0.85));
      display.r = Math.min(1, display.r * 1.12 + 0.03);
      display.g = Math.min(1, display.g * 0.95);
      display.b = Math.min(1, display.b * 0.9);

      const n = geom.attributes.position.count;
      const colors = new Float32Array(n * 3);
      for (let i = 0; i < n; i += 1) {
        colors[i * 3] = display.r;
        colors[i * 3 + 1] = display.g;
        colors[i * 3 + 2] = display.b;
      }
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      if (geom.attributes.normal) geom.deleteAttribute('normal');
      if (geom.attributes.uv) geom.deleteAttribute('uv');
      geom.clearGroups();
      parts.push(geom);
    }
  });

  if (!parts.length) throw new Error('predator glb contained no meshes');

  let merged = BufferGeometryUtils.mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  if (!merged) throw new Error('failed to merge predator geometries');

  // +X forward → +Z forward
  merged.rotateY(-Math.PI / 2);
  merged.computeBoundingBox();
  const center = new THREE.Vector3();
  merged.boundingBox.getCenter(center);
  merged.translate(-center.x, -center.y, -center.z);

  merged.computeBoundingBox();
  const size = new THREE.Vector3();
  merged.boundingBox.getSize(size);
  const s = CREATURE.bodyLength / Math.max(size.z, 1e-6);
  merged.scale(s, s, s);
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}


// ── Trench terrain ─────────────────────────────────────────────────────────
// The structure is a groove cut into a plateau, not a filled box.
//
// That distinction is not an art preference -- if the rock filled all the
// way up to the top of the bounding box, the near wall would hide the whole
// inside of the trench from any oblique plan view, and something nobody can
// see might as well not have been built. A real trench is also a cut
// through a seabed plateau with open water above it, and the swarm descends
// into it from exactly that open water.
const BED_TOP = -TANK.height / 2 + TANK.height * 0.5; // seabed plateau height

function buildTrench() {
  const specs = [];
  const halfW = TANK.width / 2;
  const halfH = TANK.height / 2;
  const halfD = TANK.depth / 2;
  const LEVELS = 8;
  const SEGMENTS = 18; // sliced along x; each slice has its own channel center
  const bedH = BED_TOP - -halfH;
  const levelH = bedH / LEVELS;
  const segW = TANK.width / SEGMENTS;

  for (let s = 0; s < SEGMENTS; s += 1) {
    const x0 = -halfW + s * segW;
    const cx = x0 + segW / 2;
    // Lateral drift of the channel center plus a variation in width --
    // without it the trench is a straight corridor
    const drift = Math.sin(cx * 0.048) * halfD * 0.2 + Math.sin(cx * 0.11) * halfD * 0.06;
    const widen = 1 + Math.sin(cx * 0.085 + 1.7) * 0.22;

    for (let l = 0; l < LEVELS; l += 1) {
      const yLow = -halfH + l * levelH;
      // Channel half-width: narrowest at the bottom, opening upward into a V
      const t = (l + 0.5) / LEVELS;
      const channel = halfD * (0.2 + 0.46 * t * t) * widen;
      const left = drift - channel;
      const right = drift + channel;

      if (left > -halfD + 0.5) {
        specs.push({ min: [x0, yLow, -halfD], max: [x0 + segW, yLow + levelH, left] });
      }
      if (right < halfD - 0.5) {
        specs.push({ min: [x0, yLow, right], max: [x0 + segW, yLow + levelH, halfD] });
      }
    }
  }

  // ── Seabed floor ──
  //
  // The bottom of the channel originally had no solid body at all: it relied
  // on the inner wall of the mission bounding box. Once the bounds stopped
  // going into the map (they are a frame we drew, not terrain), the floor
  // disappeared entirely: the point cloud floated, the mesh had no bottom,
  // and when coverage was counted per xz column, whole bands of columns were
  // permanently zero. So there has to be a real floor. Thin, just something
  // solid for the rays to hit.
  specs.push({
    min: [-halfW, -halfH, -halfD],
    max: [halfW, -halfH + 1.2, halfD],
  });

  // ── Spires in the trench ──
  //
  // A flat trench floor has little to measure; the point cloud comes out as
  // a flat slab. The spires are what supply vertical structure: they show
  // best of all in the point cloud, and the narrow gaps between a spire and
  // the trench wall create real occlusion -- the swarm has to work its way
  // in before it can measure there, and only then does coverage become a
  // real problem.
  //
  // Boxes stacked and narrowing layer by layer, the same language as the
  // stepped walls: low poly with hard edges.
  const spire = (sx, szOff, height, baseW, baseD, layers = 5) => {
    const drift = Math.sin(sx * 0.048) * halfD * 0.2 + szOff;
    const layerH = height / layers;
    for (let l = 0; l < layers; l += 1) {
      const t = 1 - l / layers; // narrowing from the bottom up
      const w = baseW * (0.28 + 0.72 * t);
      const d = baseD * (0.28 + 0.72 * t);
      // A slight offset per layer, so it does not stack into a perfect pyramid
      const jx = Math.sin(sx * 0.7 + l * 1.9) * baseW * 0.08;
      const jz = Math.cos(sx * 0.5 + l * 2.3) * baseD * 0.08;
      specs.push({
        min: [sx - w / 2 + jx, -halfH + l * layerH, drift - d / 2 + jz],
        max: [sx + w / 2 + jx, -halfH + (l + 1) * layerH, drift + d / 2 + jz],
      });
    }
  };

  // Uneven heights: some almost reach the rim of the trench, others are only
  // low mounds -- the tall ones cut the trench into sections the swarm has
  // to go around, which is exactly the problem we want to set the terminal.
  spire(-56, 2, bedH * 0.86, 13, 12);
  spire(-40, -9, bedH * 0.42, 10, 11, 4);
  spire(-22, 5, bedH * 0.95, 15, 13, 6);
  spire(-4, -6, bedH * 0.55, 11, 10, 4);
  spire(12, 7, bedH * 0.78, 12, 14);
  spire(30, -4, bedH * 0.36, 14, 10, 3);
  spire(46, 6, bedH * 0.9, 13, 12, 6);
  spire(62, -7, bedH * 0.5, 11, 12, 4);

  // Loose rocks on the floor: small-scale detail, so the point cloud is not
  // made of large flat faces alone
  const rocks = [
    [-48, 6, 7, 5, 6], [-30, -3, 9, 4, 7], [-12, 8, 6, 6, 5],
    [4, -8, 8, 5, 8], [22, 3, 7, 7, 6], [38, -6, 9, 4, 7],
    [54, 4, 6, 6, 6], [68, -2, 8, 5, 7],
  ];
  for (const [rx, rzOff, w, h, d] of rocks) {
    const drift = Math.sin(rx * 0.048) * halfD * 0.2 + rzOff;
    specs.push({
      min: [rx - w / 2, -halfH, drift - d / 2],
      max: [rx + w / 2, -halfH + h, drift + d / 2],
    });
  }
  return specs;
}

export function createScene(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.background);
  scene.fog = new THREE.Fog(PALETTE.fog, PALETTE.fogNear, PALETTE.fogFar);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 900);
  camera.position.set(
    0,
    CAMERA.overviewDistance * Math.sin(CAMERA.overviewPitch),
    CAMERA.overviewDistance * Math.cos(CAMERA.overviewPitch)
  );

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.maxDistance = 400;
  controls.minDistance = 8;
  controls.target.set(0, -TANK.height * 0.12, 0);

  // Ambient light kept low and the key light raised: with too much ambient,
  // every face is lit to the same brightness, the steps and spires lose all
  // sense of volume, and the whole terrain smears into one even brown.
  scene.add(new THREE.AmbientLight(PALETTE.ambient, 1.12));
  // The key light comes in obliquely from above -- in the deep sea the only
  // light there can be comes from up there
  const key = new THREE.DirectionalLight(PALETTE.keyLight, 2.45);
  key.position.set(30, 90, 40);
  scene.add(key);
  // The fill light comes from below, to lift the trench floor out of pure
  // black. Physically it makes no sense (there is no light source under the
  // seabed), but without it the floor is dead black, and the floor is
  // exactly what we want people to look at.
  const rim = new THREE.DirectionalLight(PALETTE.rimLight, 1.25);
  rim.position.set(-40, -30, -30);
  scene.add(rim);

  // ── Mission bounding box (survey area limits) ──
  const boundsGeo = new THREE.BoxGeometry(TANK.width, TANK.height, TANK.depth);
  scene.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(boundsGeo),
      new THREE.LineBasicMaterial({
        color: PALETTE.boundsEdge, transparent: true, opacity: 0.5,
      })
    )
  );

  // ── Trench ──
  const obstacles = [];
  const terrainMat = new THREE.MeshStandardMaterial({
    color: PALETTE.terrain, roughness: 0.95, metalness: 0.02, flatShading: true,
  });
  const edgeMat = new THREE.LineBasicMaterial({
    color: PALETTE.terrainEdge, transparent: true, opacity: 0.35,
  });
  const parts = [];
  for (const spec of buildTrench()) {
    const w = spec.max[0] - spec.min[0];
    const h = spec.max[1] - spec.min[1];
    const d = spec.max[2] - spec.min[2];
    if (w <= 0 || h <= 0 || d <= 0) continue;
    const cx = (spec.min[0] + spec.max[0]) / 2;
    const cy = (spec.min[1] + spec.max[1]) / 2;
    const cz = (spec.min[2] + spec.max[2]) / 2;
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(cx, cy, cz);
    parts.push(g);
    obstacles.push({
      min: new THREE.Vector3(spec.min[0], spec.min[1], spec.min[2]),
      max: new THREE.Vector3(spec.max[0], spec.max[1], spec.max[2]),
    });
  }
  // Hundreds of boxes merged into a single mesh: draw calls drop from
  // hundreds to one
  const terrainGeo = BufferGeometryUtils.mergeGeometries(parts, false);
  scene.add(new THREE.Mesh(terrainGeo, terrainMat));
  scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(terrainGeo, 40), edgeMat));

  // ── Swarm (ROV model + fake light near the body) ──
  // A procedural spindle stands in first and the geometry is hot-swapped
  // once the GLB is ready, so the first frame is not blocked on loading.
  let agentGeo = buildAgentGeometry();
  let agentUsesVertexColors = false;
  let flockMesh = null;
  let glowCoreMesh = null;
  let glowHaloMesh = null;
  const glowTexture = makeGlowTexture();
  const glowPlane = new THREE.PlaneGeometry(1, 1);

  function disposeInstanced(mesh) {
    if (!mesh) return;
    scene.remove(mesh);
    // The geometry may be shared with the ROV or the placeholder, so it is
    // not disposed here
    if (mesh.material) mesh.material.dispose();
    mesh.dispose();
  }

  function buildFlockMesh(count) {
    disposeInstanced(flockMesh);
    disposeInstanced(glowCoreMesh);
    disposeInstanced(glowHaloMesh);

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: agentUsesVertexColors ? 0.42 : 0.55,
      metalness: agentUsesVertexColors ? 0.28 : 0.05,
      vertexColors: agentUsesVertexColors,
      // A little emission: in the deep sea the body carries some brightness
      // of its own, and the fake light then spreads a ring around it
      emissive: new THREE.Color(agentUsesVertexColors ? '#2a2218' : '#000000'),
      emissiveIntensity: agentUsesVertexColors ? 0.34 : 0.0,
    });

    flockMesh = new THREE.InstancedMesh(agentGeo, bodyMat, count);
    flockMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    flockMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    flockMesh.frustumCulled = false;
    scene.add(flockMesh);

    // Two-layer billboard glow: a bright core and a diffuse halo. A plane
    // plus additive blending is two orders of magnitude cheaper than a real
    // light.
    const mkGlowMat = (opacity) => new THREE.MeshBasicMaterial({
      map: glowTexture,
      color: 0xffffff,
      transparent: true,
      opacity,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      toneMapped: false,
    });

    glowCoreMesh = new THREE.InstancedMesh(glowPlane, mkGlowMat(GLOW.coreOpacity), count);
    glowHaloMesh = new THREE.InstancedMesh(glowPlane, mkGlowMat(GLOW.haloOpacity), count);
    for (const gmesh of [glowCoreMesh, glowHaloMesh]) {
      gmesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      gmesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
      gmesh.frustumCulled = false;
      gmesh.renderOrder = 2;
      scene.add(gmesh);
    }

    return flockMesh;
  }

  // Swap in the industrial deep-sea ROV asynchronously; on failure the
  // spindle placeholder is kept silently and the simulation is not blocked.
  loadRovAgentGeometry().then((geo) => {
    const old = agentGeo;
    agentGeo = geo;
    agentUsesVertexColors = true;
    if (flockMesh) buildFlockMesh(flockMesh.count);
    // The placeholder geometry can be released; the ROV geometry is shared
    // by every later flockMesh
    if (old && old !== geo) old.dispose();
  }).catch((err) => {
    console.warn('[scene] ROV model load failed, keeping procedural agents', err);
  });

  // ── Large creature (low-poly red fish + dark red fake light) ──
  // A procedural spindle stands in first; the geometry is hot-swapped once
  // the GLB is ready.
  let creatureGeo = buildCreatureGeometry();
  let creatureUsesModel = false;
  let creatureMat = new THREE.MeshStandardMaterial({
    color: PALETTE.creature, roughness: 0.7, metalness: 0.1,
  });
  const creatureMeshes = [];
  const creatureGlowCores = [];
  const creatureGlowHalos = [];
  const _creatureGlowCore = new THREE.Color(PALETTE.creatureGlowCore || '#a01812');
  const _creatureGlowHalo = new THREE.Color(PALETTE.creatureGlowHalo || '#5c100c');

  function disposeCreatureVisuals() {
    for (const mesh of creatureMeshes) {
      scene.remove(mesh);
      mesh.traverse((obj) => {
        if (obj.geometry && obj.geometry !== creatureGeo) obj.geometry.dispose();
        if (obj.material && obj.material !== creatureMat) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
    }
    creatureMeshes.length = 0;
    for (const g of [...creatureGlowCores, ...creatureGlowHalos]) {
      scene.remove(g);
      if (g.material) g.material.dispose();
    }
    creatureGlowCores.length = 0;
    creatureGlowHalos.length = 0;
  }

  function makeCreatureGlowMat(opacity) {
    return new THREE.MeshBasicMaterial({
      map: glowTexture,
      color: 0xffffff,
      transparent: true,
      opacity,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      toneMapped: false,
    });
  }

  function buildCreatures(n) {
    while (creatureMeshes.length < n) {
      const mesh = new THREE.Mesh(creatureGeo, creatureMat);
      if (!creatureUsesModel) {
        mesh.add(new THREE.LineSegments(
          new THREE.EdgesGeometry(creatureGeo, 30),
          new THREE.LineBasicMaterial({ color: PALETTE.creatureEdge, transparent: true, opacity: 0.55 })
        ));
      }
      scene.add(mesh);
      creatureMeshes.push(mesh);

      const core = new THREE.Mesh(glowPlane, makeCreatureGlowMat(CREATURE_GLOW.coreOpacity));
      const halo = new THREE.Mesh(glowPlane, makeCreatureGlowMat(CREATURE_GLOW.haloOpacity));
      for (const g of [core, halo]) {
        g.renderOrder = 2;
        g.raycast = () => {}; // the glow must not steal picking
        scene.add(g);
      }
      core.material.color.copy(_creatureGlowCore);
      halo.material.color.copy(_creatureGlowHalo);
      creatureGlowCores.push(core);
      creatureGlowHalos.push(halo);
    }
  }

  function applyPredatorGeometry(geo) {
    const old = creatureGeo;
    const had = creatureMeshes.length;
    disposeCreatureVisuals();
    creatureGeo = geo;
    creatureUsesModel = true;
    if (creatureMat) creatureMat.dispose();
    creatureMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.48,
      metalness: 0.18,
      vertexColors: true,
      // The body carries its own dark red underglow, with a billboard fake
      // light layered around the outside
      emissive: new THREE.Color('#2a0806'),
      emissiveIntensity: 0.72,
    });
    if (had > 0) buildCreatures(had);
    if (old && old !== geo) old.dispose();
  }

  loadPredatorGeometry().then((geo) => {
    applyPredatorGeometry(geo);
  }).catch((err) => {
    console.warn('[scene] predator model load failed, keeping procedural creature', err);
  });

  // flocks: the canvas fills its column, not the window. The terminal panel
  // covers the right edge of it, so the picture is centered on what is left:
  // a view offset shifts it left by half the covered width.
  function resize() {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    const covered = Math.min(w * 0.45, Number(container.dataset.coveredRight) || 0);
    // With a view offset, aspect describes the full virtual frame.
    camera.aspect = (w + covered) / h;
    if (covered > 0) camera.setViewOffset(w + covered, h, covered, 0, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  function orient(dx, dy, dz, matrix) {
    _dir.set(dx, dy, dz);
    if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1);
    _dir.normalize();
    _right.crossVectors(UP, _dir);
    if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_dir, _right).normalize();
    matrix.makeBasis(_right, _up, _dir);
  }

  function syncFlock(flock) {
    if (!flockMesh || flockMesh.count !== flock.count) buildFlockMesh(flock.count);

    // The glow faces the camera: billboarding off the camera's orientation
    // keeps an additive spot from collapsing into a line when seen edge-on
    camera.getWorldQuaternion(_q);

    // Recall complete: the whole swarm is hidden (it has left)
    if (flock.departed) {
      const hide = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let i = 0; i < flock.count; i += 1) {
        flockMesh.setMatrixAt(i, hide);
        if (glowCoreMesh) glowCoreMesh.setMatrixAt(i, hide);
        if (glowHaloMesh) glowHaloMesh.setMatrixAt(i, hide);
      }
      flockMesh.instanceMatrix.needsUpdate = true;
      if (glowCoreMesh) glowCoreMesh.instanceMatrix.needsUpdate = true;
      if (glowHaloMesh) glowHaloMesh.instanceMatrix.needsUpdate = true;
      return;
    }

    for (let i = 0; i < flock.count; i += 1) {
      const o = i * 3;
      _pos.set(flock.positions[o], flock.positions[o + 1], flock.positions[o + 2]);
      // When the formation is holding still velocity is 0, so a separate
      // heading is used for orientation; otherwise they snap to the default
      // direction or spin wildly on noise
      if (flock.headings) {
        orient(flock.headings[o], flock.headings[o + 1], flock.headings[o + 2], _m);
      } else {
        orient(flock.velocities[o], flock.velocities[o + 1], flock.velocities[o + 2], _m);
      }
      _m.setPosition(_pos.x, _pos.y, _pos.z);
      flockMesh.setMatrixAt(i, _m);

      // A curve rather than a linear ramp: measured panic values for a fish
      // that caught it from a neighbor usually sit between 0.2 and 0.5, and
      // under a linear mapping the color barely changes, which wastes the
      // ripple entirely. With sqrt, 0.25 already turns clearly ochre.
      const heat = Math.min(1, Math.sqrt(Math.max(0, flock.panic[i])) * 1.15);
      _mix.copy(_calm).lerp(_afraid, heat);
      flockMesh.setColorAt(i, _mix);

      _glowMix.copy(_glowCalm).lerp(_glowPanic, heat);
      const pulse = 1 + 0.22 * heat;
      const core = AGENT.bodyLength * GLOW.coreScale * pulse;
      const halo = AGENT.bodyLength * GLOW.haloScale * pulse;

      // Billboard matrix: rotation from the camera, scale per core/halo,
      // position at the body
      _m.compose(_pos, _q, _scale.set(core, core, core));
      glowCoreMesh.setMatrixAt(i, _m);
      glowCoreMesh.setColorAt(i, _glowMix);

      _m.compose(_pos, _q, _scale.set(halo, halo, halo));
      glowHaloMesh.setMatrixAt(i, _m);
      glowHaloMesh.setColorAt(i, _glowMix);
    }

    flockMesh.instanceMatrix.needsUpdate = true;
    if (flockMesh.instanceColor) flockMesh.instanceColor.needsUpdate = true;
    glowCoreMesh.instanceMatrix.needsUpdate = true;
    glowHaloMesh.instanceMatrix.needsUpdate = true;
    if (glowCoreMesh.instanceColor) glowCoreMesh.instanceColor.needsUpdate = true;
    if (glowHaloMesh.instanceColor) glowHaloMesh.instanceColor.needsUpdate = true;
  }

  function syncCreatures(pack) {
    buildCreatures(pack.members.length);
    camera.getWorldQuaternion(_q);
    pack.members.forEach((c, i) => {
      const mesh = creatureMeshes[i];
      mesh.position.set(c.position.x, c.position.y, c.position.z);
      orient(c.velocity.x, c.velocity.y, c.velocity.z, _m);
      // The body points along its velocity; the glow faces the camera
      // separately
      _bodyQ.setFromRotationMatrix(_m);
      mesh.quaternion.copy(_bodyQ);

      const core = creatureGlowCores[i];
      const halo = creatureGlowHalos[i];
      if (!core || !halo) return;
      const pulse = 1 + 0.08 * Math.sin((performance.now() * 0.001) + i * 1.7);
      const coreSize = CREATURE.bodyLength * CREATURE_GLOW.coreScale * pulse;
      const haloSize = CREATURE.bodyLength * CREATURE_GLOW.haloScale * pulse;
      core.position.copy(mesh.position);
      halo.position.copy(mesh.position);
      core.quaternion.copy(_q);
      halo.quaternion.copy(_q);
      core.scale.set(coreSize, coreSize, coreSize);
      halo.scale.set(haloSize, haloSize, haloSize);
    });
  }

  // ── Camera: overview (orbit) / follow (click an agent, Esc to exit) ──
  let followIndex = -1;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  // Returns { kind:'agent'|'creature', index } or null.
  // The large creature wins: it is far bigger, so when the two overlap it is
  // almost certainly what the user meant to click.
  function pick(clientX, clientY) {
    // Use the canvas's own rect rather than window.innerWidth: the canvas
    // does not necessarily fill the window, and when the window size is 0
    // the division yields NaN, so the ray silently fails with no way to see
    // why.
    const r = renderer.domElement.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    pointer.x = ((clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((clientY - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    const cHits = raycaster.intersectObjects(creatureMeshes, false);
    if (cHits.length) {
      const idx = creatureMeshes.indexOf(cHits[0].object);
      if (idx >= 0) return { kind: 'creature', index: idx };
    }
    if (flockMesh) {
      const hits = raycaster.intersectObject(flockMesh, false);
      if (hits.length) return { kind: 'agent', index: hits[0].instanceId };
    }
    return null;
  }

  function setFollow(index) {
    followIndex = index;
    controls.enabled = index < 0;
  }

  function updateCamera(flock, dt) {
    if (followIndex < 0 || followIndex >= flock.count) {
      controls.update();
      return;
    }
    const o = followIndex * 3;
    _dir.set(flock.velocities[o], flock.velocities[o + 1], flock.velocities[o + 2]);
    if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1);
    _dir.normalize();
    _camTarget
      .set(flock.positions[o], flock.positions[o + 1], flock.positions[o + 2])
      .addScaledVector(_dir, -CAMERA.followBack)
      .addScaledVector(UP, CAMERA.followUp);
    // Exponential lag rather than hard following; otherwise the sharp turns
    // during panic throw the view around
    camera.position.lerp(_camTarget, 1 - Math.exp(-CAMERA.followLag * dt));
    _lookAt
      .set(flock.positions[o], flock.positions[o + 1], flock.positions[o + 2])
      .addScaledVector(_dir, 6);
    camera.lookAt(_lookAt);
  }

  // ── Picture-in-picture: the creature's first-person view ─────────────────
  // The same scene is rendered again with a second camera, clipped into a
  // DOM box with a scissor rect.
  const previewCamera = new THREE.PerspectiveCamera(72, 1, 0.05, 900);
  const _pvFwd = new THREE.Vector3();
  const _pvEye = new THREE.Vector3();

  function renderPreview(el, creature, pilot) {
    if (!el || el.hidden || !creature) return;
    const r = el.getBoundingClientRect();
    const c = renderer.domElement.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return;

    // The heading comes from the pilot's line of sight when there is one;
    // with nobody driving it falls back to the creature's own velocity
    if (pilot && pilot.active) pilot.forward(_pvFwd);
    else _pvFwd.set(creature.velocity.x, creature.velocity.y, creature.velocity.z);
    if (_pvFwd.lengthSq() < 1e-8) _pvFwd.set(0, 0, 1);
    _pvFwd.normalize();

    // The eye point is pushed slightly forward, outside the body, or it
    // sees the inside of its own shell
    _pvEye
      .set(creature.position.x, creature.position.y, creature.position.z)
      .addScaledVector(_pvFwd, CREATURE.bodyLength * 0.55);
    previewCamera.position.copy(_pvEye);
    previewCamera.lookAt(
      _pvEye.x + _pvFwd.x, _pvEye.y + _pvFwd.y, _pvEye.z + _pvFwd.z
    );
    previewCamera.aspect = r.width / r.height;
    previewCamera.updateProjectionMatrix();

    // setViewport/setScissor take logical pixels; three multiplies by the
    // DPR internally. Multiplying again here scales twice and the inset
    // window overflows the main view.
    const x = r.left - c.left;
    const y = c.bottom - r.bottom;

    const oldViewport = renderer.getViewport(new THREE.Vector4());
    const oldScissor = renderer.getScissor(new THREE.Vector4());
    const oldTest = renderer.getScissorTest();
    renderer.setViewport(x, y, r.width, r.height);
    renderer.setScissor(x, y, r.width, r.height);
    renderer.setScissorTest(true);
    renderer.clear(true, true, true);
    renderer.render(scene, previewCamera);
    renderer.setViewport(oldViewport);
    renderer.setScissor(oldScissor);
    renderer.setScissorTest(oldTest);
  }

  return {
    renderer, scene, camera, controls, obstacles,
    syncFlock, syncCreatures, updateCamera, pick, setFollow, renderPreview,
    getFollow: () => followIndex,
  };
}
