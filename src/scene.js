import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TANK, onTankChange } from './world.js';
import { TANK_VISUAL_PARAMS } from './evolution-model.js';

// Presentation: canonical landscape → viewport. The CSS rotation comes
// from input.js (R = −(hold + framebuffer), see the frame model there);
// this module just applies whatever R says and owns the geometry:
// dimension swap, camera framing, and viewport→canonical coordinates.
//
// Camera policy (revised M1): "fixed camera, world tilts" is a MOBILE
// GAME rule — camera motion must never fight tilt gravity. Desktop is
// the world, and you can walk around a world: OrbitControls (drag
// orbit / right-drag pan / wheel zoom), 0 = home, 1/3/7 = front/side/
// top view snaps. Mobile keeps the fixed auto-framing camera untouched.
export function createScene(wrapper, getRotation = () => 0) {
  const isDesktop = navigator.maxTouchPoints === 0;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  wrapper.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#f4efe6');

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

  // Tank shell: a soft open laboratory volume in pale beige space.
  // BackSide draws the far interior faces while leaving the near wall open,
  // so the fish, predator and capture cubes remain readable. A light face
  // grid is layered on top so orbiting still reads as a 3D aquarium rather
  // than a flat silhouette.
  let shell = null;
  let shells = [];

  function buildFaceGridGeometry(width, height, depth, divisions) {
    const div = Math.max(1, Math.round(divisions));
    const positions = [];
    const hw = width / 2;
    const hh = height / 2;
    const hd = depth / 2;

    const pushLine = (ax, ay, az, bx, by, bz) => {
      positions.push(ax, ay, az, bx, by, bz);
    };

    // Each face gets a u/v lattice. Shared box edges are drawn twice; that is
    // intentional and cheap, and keeps the helper independent of EdgesGeometry.
    for (let i = 0; i <= div; i++) {
      const t = i / div;
      const x = -hw + width * t;
      const y = -hh + height * t;
      const z = -hd + depth * t;

      // ±Z faces (front / back)
      pushLine(x, -hh, -hd, x, hh, -hd);
      pushLine(-hw, y, -hd, hw, y, -hd);
      pushLine(x, -hh, hd, x, hh, hd);
      pushLine(-hw, y, hd, hw, y, hd);

      // ±X faces (left / right)
      pushLine(-hw, y, -hd, -hw, y, hd);
      pushLine(-hw, -hh, z, -hw, hh, z);
      pushLine(hw, y, -hd, hw, y, hd);
      pushLine(hw, -hh, z, hw, hh, z);

      // ±Y faces (floor / ceiling)
      pushLine(x, -hh, -hd, x, -hh, hd);
      pushLine(-hw, -hh, z, hw, -hh, z);
      pushLine(x, hh, -hd, x, hh, hd);
      pushLine(-hw, hh, z, hw, hh, z);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3)
    );
    return geometry;
  }

  function syncTankGrid() {
    if (!shell?.grid) return;
    const enabled = Boolean(TANK_VISUAL_PARAMS.gridEnabled);
    const opacity = Math.min(
      1,
      Math.max(0, Number(TANK_VISUAL_PARAMS.gridOpacity) || 0)
    );
    for (const item of shells) {
      item.grid.visible = enabled && opacity > 0;
      item.grid.material.opacity = opacity;
      item.grid.material.transparent = opacity < 1;
      item.grid.material.depthWrite = opacity >= 1;
      item.grid.material.needsUpdate = true;
    }
  }

  // 分缸：教学关 T2 需要【两个看得出是两个】的缸。
  //
  // 仿真那边早就是隔离的（school.bounds 硬钳制 + school.chamber 把跨隔间
  // 关系降为 ignore），所以这里只是视觉 —— 但只画一条隔板不行：那读起来
  // 是"一个缸被莫名其妙分成两半"，不是"两个缸"。真正分开画两个盒子、
  // 中间留空，才是玩家一眼能读对的东西。
  // null = 整缸一个盒子（所有非教学场景的现有行为）。
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
      scene.remove(item.edges, item.panes, item.grid);
      item.box.dispose();
      item.edgesGeo.dispose();
      item.edges.material.dispose();
      item.panes.material.dispose();
      item.gridGeo.dispose();
      item.grid.material.dispose();
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
        color: '#7f9bb2',
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
        color: '#e8f1f7',
        side: THREE.BackSide, // far walls only; the front stays clear glass
      })
    );
    const gridGeo = buildFaceGridGeometry(
      TANK.width,
      height,
      TANK.depth,
      TANK_VISUAL_PARAMS.gridDivisions
    );
    const grid = new THREE.LineSegments(
      gridGeo,
      new THREE.LineBasicMaterial({
        color: '#9eb8cf',
        transparent: true,
        opacity: TANK_VISUAL_PARAMS.gridOpacity,
        depthWrite: false,
      })
    );
    for (const node of [panes, edges, grid]) node.position.y = centerY;
    scene.add(panes, edges, grid);
    return { box, edgesGeo, edges, panes, gridGeo, grid };
  }
  buildShell();

  // Distance that fits a (halfW × halfH) face plus margin, then backed
  // off by the tank's half-extent along the viewing axis.
  function fitDistance(halfW, halfH, halfAlong) {
    const margin = 1.25;
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

  let rotationDeg = 0;
  let appliedKey = '';

  function computeRotation() {
    if (isDesktop) return 0; // desktop never rotates
    return getRotation();
  }

  // Cheap enough to call every frame: bails unless rotation state or
  // viewport actually changed.
  function apply() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Hidden tabs and mid-rotation iOS can report a 0×0 viewport; a 0
    // aspect would NaN the camera. Skip — the settle timer / next
    // resize retries once the viewport is real.
    if (vw === 0 || vh === 0) return;
    rotationDeg = computeRotation();
    const key = `${rotationDeg}:${vw}x${vh}`;
    if (key === appliedKey) return;
    appliedKey = key;

    const swap = rotationDeg === 90 || rotationDeg === 270;
    const w = swap ? vh : vw;
    const h = swap ? vw : vh;

    // transform-origin is top-left (index.html); transforms compose
    // right-to-left, so the translate positions the box, the rotation
    // lands it exactly on the viewport — fullscreen, no letterbox.
    wrapper.style.width = `${w}px`;
    wrapper.style.height = `${h}px`;
    if (rotationDeg === 90) {
      wrapper.style.transform = 'rotate(90deg) translateY(-100%)';
    } else if (rotationDeg === 270) {
      wrapper.style.transform = 'rotate(-90deg) translateX(-100%)';
    } else if (rotationDeg === 180) {
      wrapper.style.transform = 'rotate(180deg) translate(-100%, -100%)';
    } else {
      wrapper.style.transform = 'none';
    }

    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Auto-framing home pose — but never stomp a camera the user has
    // deliberately moved (desktop navigation owns it after first drag).
    if (!userMoved) home();
  }

  // iOS reports stale innerWidth/Height mid-rotation; re-measure after
  // things settle.
  let settleTimer = 0;
  function onResize() {
    apply();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(apply, 300);
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  apply();

  // Tank dims changed: new shell, and the old camera pose is framing a
  // tank that no longer exists — go home.
  onTankChange(() => {
    buildShell();
    home();
  });

  // CSS transforms rotate pixels, not coordinates: touch positions
  // arrive in viewport space. ALL canvas-space touch math (M3 touch
  // zones, raycasts) must pass through here — never use clientX/Y raw.
  function viewportToCanonical(sx, sy) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    switch (rotationDeg) {
      case 90:
        return { x: sy, y: vw - sx };
      case 270:
        return { x: vh - sy, y: sx };
      case 180:
        return { x: vw - sx, y: vh - sy };
      default:
        return { x: sx, y: sy };
    }
  }

  let lastGridDivisions = Math.round(TANK_VISUAL_PARAMS.gridDivisions);

  return {
    setTankChambers,
    renderer,
    scene,
    camera,
    viewportToCanonical,
    rotationDeg: () => rotationDeg,
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
