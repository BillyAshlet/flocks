import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TANK, onTankChange } from './world.js';

const TANK_VISUAL_PARAMS = {
  // Soft grid lines only help depth and camera orientation; they never affect
  // the simulation. A full-strength lattice on every face was tiring to look
  // at for long and competed with the fish, so each face's grid fades with
  // how squarely it faces the camera: the back wall shows it, walls seen
  // edge-on barely do, and walls between the camera and the fish not at all.
  gridEnabled: true,
  gridOpacity: 0.5,
  gridDivisions: 6,
};

export const SCENE_BACKGROUND = '#eee9df';

// Presentation: the canvas fills `wrapper` (the page's middle column) and
// follows its size. flocks is a desktop page, so the old screen-rotation
// support for phones is gone.
//
// Camera policy: touch devices keep the fixed auto-framing camera. Desktop
// is a world you can walk around: OrbitControls (drag orbit / right-drag
// pan / wheel zoom), 0 = home, 1/3/7 = front/side/top view snaps.
export function createScene(wrapper) {
  const isDesktop = navigator.maxTouchPoints === 0;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  wrapper.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SCENE_BACKGROUND);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 50);
  // Mutable on purpose: the lab panel and console both operate this same
  // object, while updateCamera() applies it to Three.js every frame.
  const cameraSettings = {
    fov: 45,
    orbitEnabled: true,
    autoRotate: false,
    autoRotateSpeed: 0.65,
    damping: 0.08,
  };

  // Tank shell: a soft open volume on a warm grey plate.
  // BackSide draws the far interior faces while leaving the near wall open,
  // so the fish, predator and capture cubes remain readable. A light face
  // grid is layered on top so orbiting still reads as a 3D aquarium rather
  // than a flat silhouette.
  let shell = null;
  let shells = [];

  // One grid per face, with square-ish cells: `divisions` along the tank's
  // longest side. Each keeps its outward normal and center for the fading.
  function buildFaceGrids(width, height, depth, divisions) {
    const cell = Math.max(width, height, depth) / Math.max(1, Math.round(divisions));
    const hw = width / 2;
    const hh = height / 2;
    const hd = depth / 2;
    const X = [1, 0, 0];
    const Y = [0, 1, 0];
    const Z = [0, 0, 1];
    const faces = [
      { normal: [0, 0, -1], center: [0, 0, -hd], u: X, v: Y, uLen: width, vLen: height },
      { normal: [0, 0, 1], center: [0, 0, hd], u: X, v: Y, uLen: width, vLen: height },
      { normal: [-1, 0, 0], center: [-hw, 0, 0], u: Z, v: Y, uLen: depth, vLen: height },
      { normal: [1, 0, 0], center: [hw, 0, 0], u: Z, v: Y, uLen: depth, vLen: height },
      { normal: [0, -1, 0], center: [0, -hh, 0], u: X, v: Z, uLen: width, vLen: depth },
      { normal: [0, 1, 0], center: [0, hh, 0], u: X, v: Z, uLen: width, vLen: depth },
    ];
    return faces.map((face) => {
      const positions = [];
      const point = (a, b) =>
        [0, 1, 2].map((k) => face.center[k] + face.u[k] * a + face.v[k] * b);
      const nu = Math.max(1, Math.round(face.uLen / cell));
      const nv = Math.max(1, Math.round(face.vLen / cell));
      for (let i = 1; i < nu; i++) {
        const a = -face.uLen / 2 + (face.uLen * i) / nu;
        positions.push(...point(a, -face.vLen / 2), ...point(a, face.vLen / 2));
      }
      for (let i = 1; i < nv; i++) {
        const b = -face.vLen / 2 + (face.vLen * i) / nv;
        positions.push(...point(-face.uLen / 2, b), ...point(face.uLen / 2, b));
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const lines = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({
          color: '#c3b9a5',
          transparent: true,
          opacity: 0,
          depthWrite: false,
        })
      );
      lines.userData.normal = new THREE.Vector3(...face.normal);
      lines.userData.center = new THREE.Vector3(...face.center);
      return lines;
    });
  }

  const toCamera = new THREE.Vector3();
  function syncTankGrid() {
    const enabled = Boolean(TANK_VISUAL_PARAMS.gridEnabled);
    const base = Math.min(1, Math.max(0, Number(TANK_VISUAL_PARAMS.gridOpacity) || 0));
    for (const item of shells) {
      for (const grid of item.grids) {
        toCamera
          .copy(camera.position)
          .sub(grid.userData.center)
          .sub(grid.position)
          .normalize();
        // Positive for a far face: the camera is on its inner side.
        const facing = Math.max(0, -toCamera.dot(grid.userData.normal));
        const opacity = base * facing ** 1.5;
        grid.visible = enabled && opacity > 0.01;
        grid.material.opacity = opacity;
      }
    }
  }

  // Split tank. The simulation already isolates chambers (school.bounds clamps
  // positions and school.chamber turns cross-chamber relations into ignore), so
  // this is visual only. A single divider reads as one tank cut in half, not as
  // two tanks; drawing two separate boxes with a gap between them reads correctly.
  // null = one box for the whole tank.
  let chamberBoxes = null;
  function setTankChambers(chambers) {
    const next = Array.isArray(chambers) && chambers.length ? chambers : null;
    const same =
      JSON.stringify(next ?? null) === JSON.stringify(chamberBoxes ?? null);
    if (same) return;
    chamberBoxes = next;
    buildShell();
  }

  function buildShell() {
    for (const item of shells) {
      scene.remove(item.edges, item.panes, ...item.grids);
      item.box.dispose();
      item.edgesGeo.dispose();
      item.edges.material.dispose();
      item.panes.material.dispose();
      for (const grid of item.grids) {
        grid.geometry.dispose();
        grid.material.dispose();
      }
    }
    shells = [];
    const boxes = chamberBoxes ?? [{ centerY: 0, height: TANK.height }];
    for (const spec of boxes) shells.push(buildOneShell(spec));
    shell = shells[0];
    syncTankGrid();
  }

  function buildOneShell({ centerY = 0, height = TANK.height } = {}) {
    const box = new THREE.BoxGeometry(TANK.width, height, TANK.depth);
    const edgesGeo = new THREE.EdgesGeometry(box);
    const edges = new THREE.LineSegments(
      edgesGeo,
      new THREE.LineBasicMaterial({
        color: '#9a9384',
        // Perspective aquarium: silhouette edges must keep a uniform weight
        // even when a far pane would otherwise depth-occlude them.
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
      })
    );
    edges.renderOrder = 3;
    const panes = new THREE.Mesh(
      box,
      new THREE.MeshBasicMaterial({
        color: '#f6f2ea',
        side: THREE.BackSide, // far walls only; the front stays clear glass
      })
    );
    const grids = buildFaceGrids(
      TANK.width,
      height,
      TANK.depth,
      TANK_VISUAL_PARAMS.gridDivisions
    );
    for (const node of [panes, edges, ...grids]) node.position.y = centerY;
    scene.add(panes, edges, ...grids);
    return { box, edgesGeo, edges, panes, grids };
  }
  buildShell();

  // Distance that fits a (halfW × halfH) face plus margin, then backed
  // off by the tank's half-extent along the viewing axis.
  function fitDistance(halfW, halfH, halfAlong) {
    const margin = 1.1;
    const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2;
    const dH = (halfH * margin) / Math.tan(halfFov);
    const dW = (halfW * margin) / (Math.tan(halfFov) * camera.aspect);
    return Math.max(dH, dW) + halfAlong;
  }

  // --- Desktop navigation ---
  let controls = null;
  let userMoved = false; // once true, resizes stop stomping the camera

  function setView(position) {
    if (controls) {
      // Burn leftover drag momentum on the OLD pose first: an undamped
      // update applies-and-zeroes the internal delta. Doing this after
      // placing the camera would fling it off the new pose instead
      // (field-tested: home landed 1.4 units away).
      controls.enableDamping = false;
      controls.update();
    }
    camera.position.copy(position);
    camera.lookAt(0, 0, 0);
    if (controls) {
      controls.target.set(0, 0, 0);
      controls.update();
      controls.enableDamping = true;
    }
  }

  function home() {
    userMoved = false;
    setView(
      new THREE.Vector3(
        0,
        0,
        fitDistance(TANK.width / 2, TANK.height / 2, TANK.depth / 2)
      )
    );
  }

  // Named views are shared by keyboard shortcuts, the tuning panel and
  // automated demos. They remain available on touch devices even though
  // free orbit is intentionally desktop-only.
  function setViewPreset(name = 'home') {
    switch (name) {
      case 'front':
        userMoved = true;
        setView(
          new THREE.Vector3(
            0,
            0,
            fitDistance(TANK.width / 2, TANK.height / 2, TANK.depth / 2)
          )
        );
        break;
      case 'side':
      case 'right':
        userMoved = true;
        setView(
          new THREE.Vector3(
            fitDistance(TANK.depth / 2, TANK.height / 2, TANK.width / 2),
            0,
            0
          )
        );
        break;
      case 'top':
        userMoved = true;
        setView(
          new THREE.Vector3(
            0,
            fitDistance(TANK.width / 2, TANK.depth / 2, TANK.height / 2),
            0.001
          )
        );
        break;
      case 'home':
      default:
        home();
        break;
    }
  }

  if (isDesktop) {
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = cameraSettings.damping;
    controls.minDistance = 0.1;
    controls.maxDistance = 30;
    controls.addEventListener('start', () => {
      userMoved = true;
    });

    window.addEventListener('keydown', (e) => {
      // Never hijack typing in the panel's text fields.
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      switch (e.code) {
        case 'Digit0':
        case 'Numpad0':
          setViewPreset('home');
          break;
        case 'Digit1':
        case 'Numpad1': // front
          setViewPreset('front');
          break;
        case 'Digit3':
        case 'Numpad3': // right side
          setViewPreset('side');
          break;
        case 'Digit7':
        case 'Numpad7': // top (tiny z offset keeps OrbitControls off the pole)
          setViewPreset('top');
          break;
      }
    });
  }

  let appliedKey = '';

  // Cheap enough to call every frame: bails unless the column's size changed.
  function apply() {
    const w = wrapper.clientWidth;
    const h = wrapper.clientHeight;
    // A hidden column reports 0×0, and a 0 aspect would NaN the camera. Skip;
    // the next resize retries once it has a size.
    if (w === 0 || h === 0) return;
    const key = `${w}x${h}`;
    if (key === appliedKey) return;
    appliedKey = key;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Auto-framing home pose — but never stomp a camera the user has
    // deliberately moved (desktop navigation owns it after first drag).
    if (!userMoved) home();
  }

  // The column changes size without a window resize when the panel folds.
  new ResizeObserver(apply).observe(wrapper);
  apply();

  // Tank dims changed: new shell, and the old camera pose is framing a
  // tank that no longer exists — go home.
  onTankChange(() => {
    buildShell();
    home();
  });

  let lastGridDivisions = Math.round(TANK_VISUAL_PARAMS.gridDivisions);

  return {
    setTankChambers,
    renderer,
    scene,
    camera,
    updateOrientation: apply,
    cameraSettings,
    tankVisual: TANK_VISUAL_PARAMS,
    setViewPreset,
    rebuildTankShell: buildShell,
    syncTankGrid,
    // Damped/auto-rotate controls need a per-frame tick; no-op on mobile.
    // FOV still remains live on every platform. Grid opacity is also cheap
    // enough to refresh here so the tank panel feels immediate.
    updateCamera: () => {
      const nextFov = THREE.MathUtils.clamp(cameraSettings.fov, 20, 100);
      if (camera.fov !== nextFov) {
        camera.fov = nextFov;
        camera.updateProjectionMatrix();
      }
      const nextDivisions = Math.max(
        1,
        Math.round(Number(TANK_VISUAL_PARAMS.gridDivisions) || 1)
      );
      if (nextDivisions !== lastGridDivisions) {
        lastGridDivisions = nextDivisions;
        TANK_VISUAL_PARAMS.gridDivisions = nextDivisions;
        buildShell();
      } else {
        syncTankGrid();
      }
      if (controls) {
        controls.enabled = cameraSettings.orbitEnabled;
        controls.autoRotate = cameraSettings.autoRotate;
        controls.autoRotateSpeed = cameraSettings.autoRotateSpeed;
        controls.dampingFactor = cameraSettings.damping;
        // A fullscreen fish close-up or follow view owns the camera transform.
        // OrbitControls.update() still rewrites the camera while input is
        // disabled, so it must not run until ownership returns to orbit mode.
        if (controls.enabled) controls.update();
      }
    },
    home,
  };
}
