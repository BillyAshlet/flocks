import * as THREE from 'three';

const FORWARD = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);

export const CAMERA_MODE = Object.freeze({
  GLOBAL: 'global',
  CLOSEUP: 'closeup',
  FOLLOW: 'follow',
  // ORBIT follows the fish's position, but the viewer drags the view angle freely.
  // CLOSEUP and FOLLOW both derive the camera from frame.forward, which locks the view
  // to the fish's heading: when the fish turns the whole world turns with it, so there
  // was no way to look around a fish. Comparing body sizes by circling a fish needs a
  // mode whose world frame stays still.
  ORBIT: 'orbit',
});

export function cameraModeAfterEscape(mode) {
  return mode === CAMERA_MODE.GLOBAL ? CAMERA_MODE.GLOBAL : CAMERA_MODE.GLOBAL;
}

const ORBIT_YAW_PER_PIXEL = 0.0065;
const ORBIT_PITCH_PER_PIXEL = 0.0055;
const ORBIT_PITCH_LIMIT = 1.45; // just under π/2, so lookAt does not degenerate straight above or below
const ORBIT_ZOOM_PER_DELTA = 0.0012;
const ORBIT_DISTANCE_MIN = 0.16;
const ORBIT_DISTANCE_MAX = 3.2;
/**
 * In orbit view the wheel changes focal length; it does not dolly the camera.
 *
 * This is a framing choice: the stance is an observer at a lab bench, who leans into
 * the lens rather than walking over. Dollying also changes perspective, so the same
 * fish looks proportioned differently at different zoom levels, and body size is exactly
 * what the viewer is here to read; zooming only magnifies and keeps proportions fixed.
 * It also avoids a practical problem: dollying in to 0.16 pushes the near clipping
 * plane into the fish's body.
 *
 * The cost is that a long lens flattens depth: at 6° fish at different depths lose
 * their separation. The 6°–60° range was tuned by feel, not derived.
 */
const ORBIT_FOV_MIN = 6;
const ORBIT_FOV_MAX = 60;

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function dampAlpha(rate, dt) {
  return 1 - Math.exp(-Math.max(0, rate) * Math.max(0, dt));
}

export class ExperimentCameraController {
  constructor({ camera, renderer, presentation, simulation }) {
    this.camera = camera;
    this.renderer = renderer;
    this.presentation = presentation;
    this.simulation = simulation;
    this.selected = -1;
    this.mode = CAMERA_MODE.GLOBAL;
    this.interactionEnabled = true;
    this.dragPointer = null;
    this.dragStart = null;
    this.savedPose = null;
    // Orbit state: yaw/pitch are spherical angles in world space and do not follow the
    // fish's heading. distance only sets the camera position on entering ORBIT and then
    // stays fixed; zoom goes through fov.
    this.orbit = { yaw: 0, pitch: 0.28, distance: 0.9, fov: null };
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.previewCamera = new THREE.PerspectiveCamera(34, 1, 0.01, 10);
    this.marker = this._createMarker();
    this.inspector = this._createInspector();
    this.viewHud = this._createViewHud();
    this.app = document.getElementById('app');
    this.app.dataset.cameraMode = CAMERA_MODE.GLOBAL;
    this._bindEvents();
  }

  _createMarker() {
    const marker = new THREE.Mesh(
      new THREE.TorusGeometry(0.022, 0.002, 5, 20),
      new THREE.MeshBasicMaterial({
        color: '#233b4b',
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      })
    );
    marker.visible = false;
    marker.renderOrder = 10;
    this.simulation.scene.add(marker);
    return marker;
  }

  _createInspector() {
    const inspector = document.createElement('aside');
    inspector.id = 'fish-inspector';
    inspector.hidden = true;
    inspector.setAttribute('aria-label', 'Fish inspector');
    inspector.innerHTML = `
      <header>
        <span class="fish-inspector-index">SPECIMEN VIEW</span>
        <button type="button" id="fish-inspector-close" aria-label="Close fish inspector">×</button>
      </header>
      <div id="fish-preview-viewport" aria-label="Live third-person view of the fish">
        <span>LIVE · THIRD PERSON</span>
      </div>
      <div class="fish-inspector-copy">
        <strong id="fish-inspector-title">—</strong>
        <span id="fish-inspector-detail">—</span>
      </div>
      <div class="fish-inspector-actions" role="group" aria-label="Camera views">
        <button type="button" id="fish-enter-closeup">Close-up · fullscreen</button>
        <button type="button" id="fish-enter-follow">Follow · fullscreen</button>
        <button type="button" id="fish-enter-orbit">Orbit · fullscreen</button>
      </div>
    `;
    (document.getElementById('stage') ?? document.getElementById('app')).appendChild(inspector);
    inspector
      .querySelector('#fish-inspector-close')
      .addEventListener('click', () => this.clearSelection());
    inspector
      .querySelector('#fish-enter-closeup')
      .addEventListener('click', () => this.enterCloseup());
    inspector
      .querySelector('#fish-enter-follow')
      .addEventListener('click', () => this.enterFollow());
    inspector
      .querySelector('#fish-enter-orbit')
      .addEventListener('click', () => this.enterOrbit());
    return inspector;
  }

  _createViewHud() {
    const hud = document.createElement('div');
    hud.id = 'fish-view-hud';
    hud.hidden = true;
    hud.innerHTML = `
      <span id="fish-view-mode">—</span>
      <strong id="fish-view-name">—</strong>
      <kbd>ESC to exit</kbd>
    `;
    (document.getElementById('stage') ?? document.getElementById('app')).appendChild(hud);
    return hud;
  }

  _bindEvents() {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (event) => {
      if (
        !this.interactionEnabled ||
        event.button !== 0 ||
        (this.mode !== CAMERA_MODE.GLOBAL && this.mode !== CAMERA_MODE.ORBIT)
      ) {
        return;
      }
      this.dragPointer = event.pointerId;
      this.dragStart = {
        x: event.clientX,
        y: event.clientY,
        moved: false,
      };
      canvas.setPointerCapture?.(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (event.pointerId !== this.dragPointer || !this.dragStart) return;
      if (this.mode === CAMERA_MODE.ORBIT) {
        const dx = event.clientX - this.dragStart.x;
        const dy = event.clientY - this.dragStart.y;
        this.dragStart.x = event.clientX;
        this.dragStart.y = event.clientY;
        this.dragStart.moved = true;
        this.orbit.yaw -= dx * ORBIT_YAW_PER_PIXEL;
        this.orbit.pitch = clampNumber(
          this.orbit.pitch + dy * ORBIT_PITCH_PER_PIXEL,
          -ORBIT_PITCH_LIMIT,
          ORBIT_PITCH_LIMIT
        );
        return;
      }
      if (
        Math.hypot(
          event.clientX - this.dragStart.x,
          event.clientY - this.dragStart.y
        ) > 4
      ) {
        this.dragStart.moved = true;
      }
    });
    canvas.addEventListener('pointerup', (event) => {
      if (event.pointerId !== this.dragPointer) return;
      const wasMoved = this.dragStart?.moved;
      this.dragPointer = null;
      this.dragStart = null;
      canvas.releasePointerCapture?.(event.pointerId);
      if (!wasMoved && this.mode === CAMERA_MODE.GLOBAL) {
        this._handleClick(event);
      }
    });
    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!this.interactionEnabled || this.mode !== CAMERA_MODE.ORBIT) return;
        event.preventDefault();
        this.orbit.fov = clampNumber(
          this._orbitFov() * Math.exp(event.deltaY * ORBIT_ZOOM_PER_DELTA),
          ORBIT_FOV_MIN,
          ORBIT_FOV_MAX
        );
      },
      { passive: false }
    );
    window.addEventListener('keydown', (event) => {
      // One key hides all debug UI, for demos, screenshots and recordings.
      // Digits 0/1/3/7 are already taken by the Blender-style view presets in
      // scene.js (Digit1 = front view), so this uses H (hide).
      if (event.key === 'h' || event.key === 'H') {
        const node = event.target;
        if (node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA')) {
          return;
        }
        event.preventDefault();
        const app = document.getElementById('app');
        app.dataset.uiHidden = app.dataset.uiHidden === '1' ? '' : '1';
        return;
      }
      if (event.key !== 'Escape') return;
      if (this.mode !== CAMERA_MODE.GLOBAL || this.selected >= 0) {
        event.preventDefault();
        this.exitView(true);
      }
    });
  }

  _pick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(
      this.simulation.mesh,
      false
    )[0];
    if (
      !hit ||
      hit.instanceId === undefined ||
      !this.simulation.alive[hit.instanceId]
    ) {
      return -1;
    }
    return hit.instanceId;
  }

  _handleClick(event) {
    const hit = this._pick(event);
    if (hit < 0) {
      this.clearSelection();
      return;
    }
    this.select(hit);
  }

  select(index) {
    if (!this.interactionEnabled) return false;
    const fish = this.simulation.fish(index);
    if (!fish?.alive) return false;
    this.selected = index;
    this.app.dataset.selectedFish = String(index);
    this.marker.visible = true;
    this.inspector.hidden = false;
    this.presentation.cameraSettings.orbitEnabled = true;
    this._refreshLabels(fish);
    return true;
  }

  clearSelection() {
    if (this.mode !== CAMERA_MODE.GLOBAL) this.exitView(false);
    this.selected = -1;
    delete this.app.dataset.selectedFish;
    this.marker.visible = false;
    this.inspector.hidden = true;
    this.viewHud.hidden = true;
    this.presentation.cameraSettings.orbitEnabled = true;
  }

  setInteractionEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.interactionEnabled) return;
    this.interactionEnabled = next;
    this.dragPointer = null;
    this.dragStart = null;
    if (!next) this.exitView(true);
  }

  _refreshLabels(fish) {
    const relations =
      this.simulation.relationMatrix[fish.schoolIndex] ?? [];
    const hunts = relations.filter((value) => value === 'pursuit').length;
    const flees = relations.filter((value) => value === 'evade').length;
    const role =
      hunts && flees
        ? 'predator / prey'
        : hunts
          ? 'predator'
          : flees
            ? 'prey'
            : 'peer';
    const title = `${fish.school.name} #${fish.index}`;
    const detail =
      `${role} · panic ${fish.panic.toFixed(2)} · ` +
      `speed ${Math.hypot(...fish.velocity).toFixed(2)}`;
    this.inspector.querySelector('#fish-inspector-title').textContent = title;
    this.inspector.querySelector('#fish-inspector-detail').textContent = detail;
    this.viewHud.querySelector('#fish-view-name').textContent = title;
  }

  _enterMode(mode) {
    if (!this.select(this.selected) || mode === CAMERA_MODE.GLOBAL) return false;
    if (this.mode === CAMERA_MODE.GLOBAL) {
      this.savedPose = {
        position: this.camera.position.clone(),
        quaternion: this.camera.quaternion.clone(),
        near: this.camera.near,
        fov: this.camera.fov,
      };
    }
    this.mode = mode;
    this.app.dataset.cameraMode = mode;
    this.inspector.hidden = true;
    this.marker.visible = true;
    this.viewHud.hidden = false;
    this.viewHud.querySelector('#fish-view-mode').textContent =
      mode === CAMERA_MODE.CLOSEUP
        ? 'FULLSCREEN · CLOSE-UP'
        : mode === CAMERA_MODE.ORBIT
          ? 'FULLSCREEN · ORBIT · drag to rotate / scroll to zoom'
          : 'FULLSCREEN · FOLLOW';
    if (mode === CAMERA_MODE.ORBIT) this._seedOrbitFromCamera();
    this.presentation.cameraSettings.orbitEnabled = false;
    this.simulation.setHiddenFish(-1);
    return true;
  }

  enterCloseup(index = this.selected) {
    if (index !== this.selected && !this.select(index)) return false;
    return this._enterMode(CAMERA_MODE.CLOSEUP);
  }

  enterFollow(index = this.selected) {
    if (index !== this.selected && !this.select(index)) return false;
    return this._enterMode(CAMERA_MODE.FOLLOW);
  }

  enterOrbit(index = this.selected) {
    if (index !== this.selected && !this.select(index)) return false;
    return this._enterMode(CAMERA_MODE.ORBIT);
  }

  /** Current focal length; before any wheel input, the configured camera FOV. */
  _orbitFov() {
    const base = this.simulation.config.camera.fov;
    return clampNumber(this.orbit.fov ?? base, ORBIT_FOV_MIN, ORBIT_FOV_MAX);
  }

  // Derive the spherical angles from the current camera so entering ORBIT does not jump.
  _seedOrbitFromCamera() {
    const fish = this.simulation.fish(this.selected);
    if (!fish) return;
    const offset = this.camera.position
      .clone()
      .sub(new THREE.Vector3(...fish.position));
    const length = offset.length();
    if (length < 1e-4) return;
    this.orbit.distance = clampNumber(
      length,
      ORBIT_DISTANCE_MIN,
      ORBIT_DISTANCE_MAX
    );
    // Reset focal length on every entry. Otherwise the long lens left over from the
    // previous fish carries over to the next one, which looks like a broken camera.
    this.orbit.fov = null;
    this.orbit.yaw = Math.atan2(offset.x, offset.z);
    this.orbit.pitch = clampNumber(
      Math.asin(offset.y / length),
      -ORBIT_PITCH_LIMIT,
      ORBIT_PITCH_LIMIT
    );
  }

  exitView(clearSelection = false) {
    if (this.mode !== CAMERA_MODE.GLOBAL && this.savedPose) {
      this.camera.position.copy(this.savedPose.position);
      this.camera.quaternion.copy(this.savedPose.quaternion);
      this.camera.near = this.savedPose.near;
      this.camera.fov = this.savedPose.fov;
      this.camera.updateProjectionMatrix();
    }
    this.mode = cameraModeAfterEscape(this.mode);
    this.app.dataset.cameraMode = CAMERA_MODE.GLOBAL;
    this.savedPose = null;
    this.viewHud.hidden = true;
    this.presentation.cameraSettings.orbitEnabled = true;
    this.simulation.setHiddenFish(-1);
    if (clearSelection) {
      this.clearSelection();
    } else if (this.selected >= 0) {
      this.marker.visible = true;
      this.inspector.hidden = false;
    }
    return true;
  }

  onSimulationRebuilt(simulation) {
    this.exitView(true);
    this.simulation = simulation;
  }

  _fallbackIfDead() {
    if (this.selected < 0 || this.simulation.alive[this.selected]) return;
    const fallback = this.simulation.nearestAliveSameSchool(this.selected);
    if (fallback >= 0) {
      this.selected = fallback;
      this.app.dataset.selectedFish = String(fallback);
    } else {
      this.exitView(true);
    }
  }

  _fishFrame(fish) {
    const position = new THREE.Vector3(...fish.position);
    const forward = new THREE.Vector3(...fish.velocity);
    if (forward.lengthSq() < 1e-9) forward.copy(FORWARD);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(UP, forward);
    if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
    right.normalize();
    return { position, forward, right };
  }

  _closeupPose(fish) {
    const config = this.simulation.config.camera;
    const frame = this._fishFrame(fish);
    const framingScale = Math.max(0.2, fish.school.size);
    const cameraPosition = frame.position
      .clone()
      .addScaledVector(
        frame.forward,
        -config.closeupDistance * framingScale
      )
      .addScaledVector(frame.right, config.closeupSide * framingScale)
      .addScaledVector(UP, config.closeupHeight * framingScale);
    const lookTarget = frame.position
      .clone()
      .addScaledVector(frame.forward, config.lookAhead * 0.08);
    return { ...frame, cameraPosition, lookTarget };
  }

  _applyPose(targetCamera, pose, dt, fov) {
    const config = this.simulation.config.camera;
    targetCamera.position.lerp(
      pose.cameraPosition,
      dampAlpha(config.positionDamping, dt)
    );
    const matrix = new THREE.Matrix4().lookAt(
      targetCamera.position,
      pose.lookTarget,
      UP
    );
    const targetQuaternion = new THREE.Quaternion().setFromRotationMatrix(
      matrix
    );
    targetCamera.quaternion.slerp(
      targetQuaternion,
      dampAlpha(config.orientationDamping, dt)
    );
    targetCamera.fov = fov;
    targetCamera.near = config.globalNear;
    targetCamera.updateProjectionMatrix();
  }

  update(dt) {
    this._fallbackIfDead();
    const fish = this.simulation.fish(this.selected);
    if (!fish?.alive) return;
    this._refreshLabels(fish);
    const config = this.simulation.config.camera;
    const frame = this._fishFrame(fish);
    this.marker.position.copy(frame.position);
    this.marker.quaternion.setFromUnitVectors(FORWARD, frame.forward);

    const closeupPose = this._closeupPose(fish);
    this._applyPose(
      this.previewCamera,
      closeupPose,
      dt,
      config.closeupFov
    );

    if (this.mode === CAMERA_MODE.GLOBAL) {
      this.marker.visible = true;
      return;
    }
    this.marker.visible = true;
    if (this.mode === CAMERA_MODE.CLOSEUP) {
      this._applyPose(this.camera, closeupPose, dt, config.closeupFov);
      return;
    }

    if (this.mode === CAMERA_MODE.ORBIT) {
      // The key difference: the offset is computed in world space, not from
      // frame.forward. When the fish turns the camera stays put, so the viewer
      // sees the fish turn rather than the world.
      const cos = Math.cos(this.orbit.pitch);
      const orbitPosition = frame.position
        .clone()
        .add(
          new THREE.Vector3(
            this.orbit.distance * cos * Math.sin(this.orbit.yaw),
            this.orbit.distance * Math.sin(this.orbit.pitch),
            this.orbit.distance * cos * Math.cos(this.orbit.yaw)
          )
        );
      this._applyPose(
        this.camera,
        { cameraPosition: orbitPosition, lookTarget: frame.position.clone() },
        dt,
        this._orbitFov()
      );
      return;
    }

    const followPosition = frame.position
      .clone()
      .addScaledVector(
        frame.forward,
        -config.focusDistance * Math.max(0.2, fish.school.size)
      )
      .addScaledVector(
        UP,
        config.focusHeight * Math.max(0.2, fish.school.size)
      );
    const followTarget = frame.position
      .clone()
      .addScaledVector(frame.forward, config.lookAhead * 0.18);
    this._applyPose(
      this.camera,
      {
        cameraPosition: followPosition,
        lookTarget: followTarget,
      },
      dt,
      config.fov
    );
  }

  renderPreview() {
    if (
      this.mode !== CAMERA_MODE.GLOBAL ||
      this.inspector.hidden ||
      this.selected < 0
    ) {
      return;
    }
    const viewport = this.inspector.querySelector('#fish-preview-viewport');
    const targetRect = viewport.getBoundingClientRect();
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    if (
      targetRect.width <= 1 ||
      targetRect.height <= 1 ||
      canvasRect.width <= 1 ||
      canvasRect.height <= 1
    ) {
      return;
    }

    // WebGLRenderer.setViewport/setScissor accept logical pixels and apply
    // the renderer pixel ratio internally. Multiplying by DPR here would
    // double-scale the preview and make it spill over the main view.
    const x = targetRect.left - canvasRect.left;
    const y = canvasRect.bottom - targetRect.bottom;
    const width = targetRect.width;
    const height = targetRect.height;
    this.previewCamera.aspect = targetRect.width / targetRect.height;
    this.previewCamera.updateProjectionMatrix();

    const oldViewport = this.renderer.getViewport(new THREE.Vector4());
    const oldScissor = this.renderer.getScissor(new THREE.Vector4());
    const oldScissorTest = this.renderer.getScissorTest();
    const oldColor = this.renderer.getClearColor(new THREE.Color()).clone();
    const oldAlpha = this.renderer.getClearAlpha();
    this.renderer.setViewport(x, y, width, height);
    this.renderer.setScissor(x, y, width, height);
    this.renderer.setScissorTest(true);
    this.renderer.setClearColor('#e6e4db', 1);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.simulation.scene, this.previewCamera);
    this.renderer.setClearColor(oldColor, oldAlpha);
    this.renderer.setViewport(oldViewport);
    this.renderer.setScissor(oldScissor);
    this.renderer.setScissorTest(oldScissorTest);
  }
}
