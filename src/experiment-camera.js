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

/**
 * Looking around from a chase camera, without leaving it.
 *
 * CLOSEUP and FOLLOW point where the fish points, which is the whole idea and
 * also means there is no way to glance at a fish from the side without
 * switching to ORBIT and losing the chase. Dragging now swings the camera
 * around the fish and letting go brings it back, so a glance costs a gesture
 * instead of a mode.
 *
 * ORBIT still earns its place: this returns, deliberately, and comparing two
 * body sizes needs a view that stays where it was put.
 *
 * There is no angle the drag stops at. Instead the raw drag is pulled through
 * a tanh, so the first pixels move the view most and each further pixel moves
 * it less: the view can be swung all the way behind the fish, it just takes
 * more and more asking. That also keeps pitch clear of straight up and down,
 * where lookAt has no answer.
 */
/**
 * The heading the camera frames from is filtered; the fish's own is not.
 *
 * A fish's heading is its velocity, and that moves with every tail beat and
 * every nudge from a neighbour. Framing straight off it puts all of that in
 * the picture. At rest it reads as the liveliness of a chase; the moment the
 * view is swung round to look at the fish, it is just shake. This cuts what is
 * fast and small and keeps what is a real turn. How much is
 * camera.headingSmoothing, since how steady a chase should look is a matter of
 * taste and the panel is where taste belongs.
 *
 * The marker and ORBIT still use the true heading: they point at the fish, and
 * pointing is not framing.
 */
/**
 * At rest the camera looks a little ahead of the fish, leaving room in front,
 * the way a camera operator follows a runner. That lead is what the view turns
 * around, though, so swinging the view round it puts the fish off to one side
 * and the turn appears to pivot about a point in open water. The lead fades
 * out as the view is swung, and the fish itself becomes the pivot.
 */
const LOOK_LEAD_FADE = 0.12;
/**
 * While the view is being swung, the camera is posed with this much more of
 * its damping.
 *
 * At rest the lag is the point: it is what makes a chase look handheld rather
 * than bolted on. Under a drag it is the opposite. The look angle is filtered,
 * then the camera's position is eased toward the pose, then its orientation —
 * about a quarter of a second end to end, and the fish swims on through all of
 * it, so the swing traced a spiral around where the fish used to be instead of
 * a circle around the fish. Stiffening while the view is away and relaxing as
 * it returns keeps both.
 */
const LOOK_STIFFNESS = 4;

/**
 * Leaning in, on the same terms as looking around: the wheel, or two fingers
 * on a trackpad, pull the camera closer or push it back, and it returns after
 * the same half-second hold.
 *
 * This moves the camera rather than changing the focal length, which is the
 * opposite of ORBIT. ORBIT is parked in to compare two body sizes, so its
 * proportions have to stay put; this always comes back, so there is no wrong
 * proportion to be left stranded at, and stepping closer to a fish is what the
 * gesture means here.
 */
const ZOOM_PER_DELTA = 0.0016;
// exp(0.8) and exp(-0.8): between two and a half times out and a little under
// half way in, which stays clear of the near plane at the smallest body size.
const ZOOM_LIMIT = 0.8;

const LOOK_YAW_PER_PIXEL = 0.005;
const LOOK_PITCH_PER_PIXEL = 0.004;
const LOOK_YAW_LIMIT = Math.PI * 0.95;
const LOOK_PITCH_LIMIT = 1.25;
// Let go and the view holds where it was left, then swings back. Returning at
// once feels like the view is taken away the moment the fish is interesting.
const LOOK_HOLD_SECONDS = 0.5;
const LOOK_RETURN_SECONDS = 1;
// The angles the camera is posed from follow the dragged ones through this, so
// a shaky hand or a coarse mouse does not shake the picture.
const LOOK_SMOOTHING = 14;

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
  constructor({ camera, renderer, presentation, scene, view, pickMesh, setHiddenFish }) {
    this.camera = camera;
    this.renderer = renderer;
    this.presentation = presentation;
    this.scene = scene;
    // One step of the simulation, read only. Replaced every frame.
    this.view = view;
    // The fish instances belong to the renderer; picking raycasts against them.
    this.pickMesh = pickMesh ?? (() => null);
    // Hiding the followed fish is a command to the engine, not a read.
    this.setHiddenFish = setHiddenFish ?? (() => {});
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
    // Looking around from the chase camera. `rawYaw`/`rawPitch` are what the
    // pointer has asked for and are unbounded; `yaw`/`pitch` are what the
    // camera is posed from, smoothed and saturated. `returning` runs from 0 to
    // 1 over LOOK_RETURN_SECONDS once the hold is over.
    this.look = {
      yaw: 0,
      pitch: 0,
      rawYaw: 0,
      rawPitch: 0,
      heldFor: 0,
      dragging: false,
      zoom: 0,
      rawZoom: 0,
      releasedYaw: 0,
      releasedPitch: 0,
      releasedZoom: 0,
    };
    // The filtered heading the chase camera frames from. Null until a fish is
    // followed, and reset when the followed fish changes so the camera does
    // not swing across the tank from the last one's heading.
    this.smoothForward = null;
    // The look drag in progress, whichever surface started it.
    this.lookDrag = null;
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
    this.scene.add(marker);
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
    const viewport = inspector.querySelector('#fish-preview-viewport');
    viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.lookDrag = { x: event.clientX, y: event.clientY, moved: false };
      this.look.dragging = true;
      viewport.setPointerCapture?.(event.pointerId);
    });
    viewport.addEventListener('pointermove', (event) => {
      if (this.lookDrag) this._lookDragMove(event);
    });
    const endInsetDrag = (event) => {
      if (!this.lookDrag) return;
      this.lookDrag = null;
      this.look.dragging = false;
      this._releaseLook();
      viewport.releasePointerCapture?.(event.pointerId);
    };
    viewport.addEventListener('pointerup', endInsetDrag);
    viewport.addEventListener('pointercancel', endInsetDrag);
    viewport.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this._lookZoom(event.deltaY);
      },
      { passive: false }
    );
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
      if (!this.interactionEnabled || event.button !== 0 || !this._dragMode()) {
        return;
      }
      this.dragPointer = event.pointerId;
      this.dragStart = {
        x: event.clientX,
        y: event.clientY,
        moved: false,
      };
      if (this._looksAround()) this.look.dragging = true;
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
      if (this._looksAround()) {
        this.lookDrag = this.dragStart;
        this._lookDragMove(event);
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
      if (this.look.dragging) {
        this.look.dragging = false;
        this.lookDrag = null;
        this._releaseLook();
      }
      canvas.releasePointerCapture?.(event.pointerId);
      if (!wasMoved && this.mode === CAMERA_MODE.GLOBAL) {
        this._handleClick(event);
      }
    });
    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!this.interactionEnabled) return;
        if (this._looksAround()) {
          // A trackpad's two fingers and a mouse wheel arrive the same way;
          // a pinch arrives as one too, with ctrlKey set.
          event.preventDefault();
          this._lookZoom(event.deltaY);
          return;
        }
        if (this.mode !== CAMERA_MODE.ORBIT) return;
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
    const mesh = this.pickMesh();
    if (!mesh) return -1;
    const hit = this.raycaster.intersectObject(mesh, false)[0];
    if (
      !hit ||
      hit.instanceId === undefined ||
      !this.view.alive[hit.instanceId]
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
    const fish = this.view.fish(index);
    if (!fish?.alive) return false;
    this.selected = index;
    // A different fish has a different heading; starting from the last one's
    // would swing the camera across the tank on the way to the new fish.
    this.smoothForward = null;
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
      this.view.relationMatrix[fish.schoolIndex] ?? [];
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
    this.look.dragging = false;
    this._releaseLook();
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
    this.setHiddenFish(-1);
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
    const base = this.view.config.camera.fov;
    return clampNumber(this.orbit.fov ?? base, ORBIT_FOV_MIN, ORBIT_FOV_MAX);
  }

  // Derive the spherical angles from the current camera so entering ORBIT does not jump.
  _seedOrbitFromCamera() {
    const fish = this.view.fish(this.selected);
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
    this.setHiddenFish(-1);
    if (clearSelection) {
      this.clearSelection();
    } else if (this.selected >= 0) {
      this.marker.visible = true;
      this.inspector.hidden = false;
    }
    return true;
  }

  onSimulationRebuilt(view) {
    this.exitView(true);
    this.view = view;
  }

  _fallbackIfDead() {
    if (this.selected < 0 || this.view.alive[this.selected]) return;
    const fallback = this.view.nearestAliveSameSchool(this.selected);
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

  /**
   * The look gesture, shared by the main canvas and the little specimen view.
   *
   * The inset is the only sight of a fish while the tank is on screen, so it
   * takes the gesture whatever the camera mode is; the canvas takes it only in
   * the chase views, where the main camera is the one being swung.
   */
  _lookDragMove(event) {
    const start = this.lookDrag;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    start.x = event.clientX;
    start.y = event.clientY;
    start.moved = true;
    this.look.rawYaw -= dx * LOOK_YAW_PER_PIXEL;
    this.look.rawPitch += dy * LOOK_PITCH_PER_PIXEL;
  }

  _lookZoom(deltaY) {
    this.look.rawZoom += deltaY * ZOOM_PER_DELTA;
    this._releaseLook();
  }

  /** Modes that answer a drag at all. */
  _dragMode() {
    return (
      this.mode === CAMERA_MODE.GLOBAL ||
      this.mode === CAMERA_MODE.ORBIT ||
      this._looksAround()
    );
  }

  /** The chase views, where a drag is a glance the camera returns from. */
  _looksAround() {
    return (
      this.mode === CAMERA_MODE.CLOSEUP || this.mode === CAMERA_MODE.FOLLOW
    );
  }

  /**
   * Restart the hold from wherever the view is now. Called when a drag ends
   * and on every scroll, so a gesture that keeps going keeps holding; it
   * leaves `dragging` alone, since scrolling in the middle of a drag should
   * not end the drag.
   */
  _releaseLook() {
    this.look.heldFor = 0;
    this.look.releasedYaw = this.look.rawYaw;
    this.look.releasedPitch = this.look.rawPitch;
    this.look.releasedZoom = this.look.rawZoom;
  }

  /**
   * 1 at rest, LOOK_STIFFNESS while the view is swung away, and in between on
   * the way back, so the camera loosens as the framing comes home.
   */
  _lookStiffness() {
    const swung = Math.hypot(this.look.yaw, this.look.pitch);
    const zoomed = Math.abs(this.look.zoom);
    const away = Math.min(1, Math.max(swung / LOOK_YAW_LIMIT, zoomed / ZOOM_LIMIT) * 6);
    if (this.look.dragging) return LOOK_STIFFNESS;
    return 1 + (LOOK_STIFFNESS - 1) * away;
  }

  _advanceLook(dt) {
    const look = this.look;
    if (!look.dragging) {
      look.heldFor += dt;
      const returning = look.heldFor - LOOK_HOLD_SECONDS;
      if (returning > 0) {
        // Cosine, so the swing back leaves and arrives at rest instead of
        // starting at full speed the instant the hold is over.
        const t = Math.min(1, returning / LOOK_RETURN_SECONDS);
        const remaining = 0.5 * (1 + Math.cos(Math.PI * t));
        look.rawYaw = look.releasedYaw * remaining;
        look.rawPitch = look.releasedPitch * remaining;
        look.rawZoom = look.releasedZoom * remaining;
      }
    }
    // Saturate, then smooth. The tanh is what makes the far side of the fish
    // expensive to reach rather than impossible; the smoothing is what keeps a
    // jittery pointer out of the picture.
    const wantYaw = LOOK_YAW_LIMIT * Math.tanh(look.rawYaw / LOOK_YAW_LIMIT);
    const wantPitch =
      LOOK_PITCH_LIMIT * Math.tanh(look.rawPitch / LOOK_PITCH_LIMIT);
    const wantZoom = ZOOM_LIMIT * Math.tanh(look.rawZoom / ZOOM_LIMIT);
    const alpha = dampAlpha(LOOK_SMOOTHING, dt);
    look.yaw += (wantYaw - look.yaw) * alpha;
    look.pitch += (wantPitch - look.pitch) * alpha;
    look.zoom += (wantZoom - look.zoom) * alpha;
  }

  /** Advance the filtered heading. Called once a frame, before the pose. */
  _advanceHeading(fish, dt) {
    const raw = new THREE.Vector3(...fish.velocity);
    if (raw.lengthSq() < 1e-9) {
      if (!this.smoothForward) this.smoothForward = FORWARD.clone();
      return;
    }
    raw.normalize();
    if (!this.smoothForward) {
      this.smoothForward = raw;
      return;
    }
    const rate = this.view.config.camera.headingSmoothing ?? 4;
    this.smoothForward.lerp(raw, dampAlpha(rate, dt));
    if (this.smoothForward.lengthSq() < 1e-9) this.smoothForward.copy(raw);
    else this.smoothForward.normalize();
  }

  _closeupPose(fish) {
    const config = this.view.config.camera;
    const frame = this._fishFrame(fish);
    // Frame from the filtered heading, not the fish's own.
    if (this.smoothForward) {
      frame.forward = this.smoothForward.clone();
      const right = new THREE.Vector3().crossVectors(UP, frame.forward);
      frame.right = right.lengthSq() < 1e-9 ? frame.right : right.normalize();
    }
    // Zoom scales the whole framing offset, so the camera keeps its angle on
    // the fish and only its distance changes.
    const framingScale =
      Math.max(0.2, fish.school.size) * Math.exp(this.look.zoom);
    // The camera swings around the fish rather than turning on the spot, so
    // the fish stays framed and it is the fish that is seen from elsewhere.
    const offset = new THREE.Vector3()
      .addScaledVector(
        frame.forward,
        -config.closeupDistance * framingScale
      )
      .addScaledVector(frame.right, config.closeupSide * framingScale)
      .addScaledVector(UP, config.closeupHeight * framingScale);
    if (this.look.yaw !== 0) offset.applyAxisAngle(UP, this.look.yaw);
    if (this.look.pitch !== 0) {
      const pitchAxis = new THREE.Vector3().crossVectors(UP, offset);
      if (pitchAxis.lengthSq() > 1e-9) {
        offset.applyAxisAngle(pitchAxis.normalize(), this.look.pitch);
      }
    }
    const cameraPosition = frame.position.clone().add(offset);
    // The lead in front of the fish fades out as the view is swung, so what
    // the camera turns around is the fish and not a point ahead of it.
    const swung = Math.hypot(this.look.yaw, this.look.pitch);
    const lead = Math.max(0, 1 - swung / LOOK_LEAD_FADE);
    const lookTarget = frame.position
      .clone()
      .addScaledVector(frame.forward, config.lookAhead * 0.08 * lead);
    return { ...frame, cameraPosition, lookTarget };
  }

  _applyPose(targetCamera, pose, dt, fov, stiffness = 1) {
    const config = this.view.config.camera;
    targetCamera.position.lerp(
      pose.cameraPosition,
      dampAlpha(config.positionDamping * stiffness, dt)
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
      dampAlpha(config.orientationDamping * stiffness, dt)
    );
    targetCamera.fov = fov;
    targetCamera.near = config.globalNear;
    targetCamera.updateProjectionMatrix();
  }

  update(dt) {
    this._advanceLook(dt);
    const before = this.selected;
    this._fallbackIfDead();
    if (this.selected !== before) this.smoothForward = null;
    const fish = this.view.fish(this.selected);
    if (!fish?.alive) return;
    this._advanceHeading(fish, dt);
    this._refreshLabels(fish);
    const config = this.view.config.camera;
    const frame = this._fishFrame(fish);
    this.marker.position.copy(frame.position);
    this.marker.quaternion.setFromUnitVectors(FORWARD, frame.forward);

    const closeupPose = this._closeupPose(fish);
    const stiffness = this._lookStiffness();
    this._applyPose(
      this.previewCamera,
      closeupPose,
      dt,
      config.closeupFov,
      stiffness
    );

    if (this.mode === CAMERA_MODE.GLOBAL) {
      this.marker.visible = true;
      return;
    }
    this.marker.visible = true;
    if (this.mode === CAMERA_MODE.CLOSEUP) {
      this._applyPose(
        this.camera,
        closeupPose,
        dt,
        config.closeupFov,
        stiffness
      );
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
    this.renderer.setClearColor('#e6e0d3', 1);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.previewCamera);
    this.renderer.setClearColor(oldColor, oldAlpha);
    this.renderer.setViewport(oldViewport);
    this.renderer.setScissor(oldScissor);
    this.renderer.setScissorTest(oldScissorTest);
  }
}
