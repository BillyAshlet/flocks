/**
 * Rendering for the school: the fish instances, their floor shadows and the
 * plankton points. It reads a view of the simulation state and owns every
 * visual-only value (banking roll, last heading, brightness cache), so the
 * engine can run without a scene — and, later, in a worker.
 */
import * as THREE from 'three';
import { SeededRng, metabolicRate } from './experiment-model.js';
import { CaptureVfx } from './capture-vfx.js';

const EPSILON = 1e-8;
const REFERENCE_STEP = 1 / 60; // Banking was tuned against one 1/60 s step.
const FORWARD = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);

// Fish are drawn larger than the rules treat them: at true scale a school
// reads as dust. Rules use school.size; only drawing uses these.
const VISUAL_SIZE_EXPONENT = 1; // 1 = linear; any other value enables the power mapping
const VISUAL_SIZE_ANCHOR = 1.5; // Only used when the exponent is not 1.
const VISUAL_SIZE_GLOBAL = 2.6; // The one knob to tune: global visual scale.
const VISUAL_SIZE_BOOST = Object.freeze({ gold: 1, blue: 1, red: 1 });

// Brightness follows survival time (energy / resting drain), so a fish that
// is running out of energy visibly dims.
const STAMINA_TINT_STRENGTH = 0.45;
const STAMINA_TINT_REFERENCE_SECONDS = 45; // Survival time of balanced traits; neutral brightness.
const STAMINA_TINT_MIN = 0.35; // Darkest, near starvation.
const STAMINA_TINT_MAX = 1.45; // Brightest; caps overexposure.

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function visualSizeOf(size, schoolId) {
  const boost = (VISUAL_SIZE_BOOST[schoolId] ?? 1) * VISUAL_SIZE_GLOBAL;
  if (VISUAL_SIZE_EXPONENT === 1) return size * boost;
  const ratio = Math.max(EPSILON, size / VISUAL_SIZE_ANCHOR);
  return VISUAL_SIZE_ANCHOR * ratio ** VISUAL_SIZE_EXPONENT * boost;
}

function staminaTintFactor(survivalSeconds) {
  if (STAMINA_TINT_STRENGTH === 0) return 1;
  if (!Number.isFinite(survivalSeconds)) return STAMINA_TINT_MAX;
  const relative = survivalSeconds / STAMINA_TINT_REFERENCE_SECONDS;
  return clamp(
    1 + STAMINA_TINT_STRENGTH * (relative - 1),
    STAMINA_TINT_MIN,
    STAMINA_TINT_MAX
  );
}

export class SchoolRenderer {
  constructor(scene) {
    this.scene = scene;
    this.mesh = null;
    this.shadowMesh = null;
    this.planktonMesh = null;
    this.rollAngles = new Float32Array(0);
    this.prevHeadings = new Float32Array(0);
    this.tintFactors = new Float32Array(0);
    this.schoolColors = [];
    this.corpseColor = new THREE.Color('#6b6f74');
    this._instanceColorDirty = false;
    this.vfx = scene?.add ? new CaptureVfx(scene) : null;
    this._capturePosition = new THREE.Vector3();
    this._captureVelocity = new THREE.Vector3();
    this._captureGlow = new THREE.Vector3();
  }

  /** New fish count, new schools or a new tank: build the meshes again. */
  rebuild(view) {
    this.dispose();
    this.rollAngles = new Float32Array(view.count);
    this.prevHeadings = new Float32Array(view.count * 3);
    this.tintFactors = new Float32Array(view.count).fill(-1);
    this.schoolColors = view.config.schools.map((school) => new THREE.Color(school.color));
    this._buildFish(view);
    this._buildPlankton(view);
    this.vfx?.reset();
    this.applyConfig(view);
    this.update(view);
  }

  /** Live edits that only change how the school looks. */
  applyConfig(view) {
    if (this.vfx) {
      this.vfx.params = view.config.captureVfx;
      this.vfx.starvationParams = view.config.starvationVfx;
      this.vfx.setBounds?.([
        view.config.tank.width / 2,
        view.config.tank.height / 2,
        view.config.tank.depth / 2,
      ]);
    }
    this.schoolColors = view.config.schools.map((school) => new THREE.Color(school.color));
    if (!this.mesh) return;
    this.mesh.material.opacity = view.config.visual.opacity;
    this.mesh.material.transparent = view.config.visual.opacity < 1;
    // Base colors reset here only; update() applies stamina brightness every frame.
    for (let index = 0; index < view.count; index += 1) {
      this.mesh.setColorAt(index, this.schoolColors[view.schoolIds[index]]);
    }
    this.tintFactors.fill(-1);
    this.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * One frame. `dt` is real seconds since the last frame: banking follows
   * wall-clock time, so it looks the same at 30, 60 or 120 fps and at any
   * time scale. Per update it would depend on both.
   */
  update(view, dt = REFERENCE_STEP) {
    const step = Math.min(0.1, Math.max(1e-4, dt));
    this._updateFish(view, step);
    this._syncPlankton(view);
    this._playEvents(view);
    if (!view.locomotionPreview) this.vfx?.step(step);
  }

  /** Bites and captures the engine recorded since the last frame. */
  _playEvents(view) {
    const events = view.events;
    if (!events?.length) return;
    if (this.vfx) {
      for (const event of events) {
        if (event.kind === 'feed') {
          this.vfx.emitFeed?.(event.x, event.y, event.z);
        } else if (event.kind === 'capture') {
          this._capturePosition.set(event.x, event.y, event.z);
          this._captureVelocity.set(event.vx, event.vy, event.vz);
          this._captureGlow.set(event.ax, event.ay, event.az);
          this.vfx.emit(
            this._capturePosition,
            this._captureVelocity,
            this._captureGlow
          );
        }
      }
    }
    events.length = 0;
  }

  /** Readouts the dashboard shows but only the renderer knows. */
  vfxStats() {
    return {
      particles: this.vfx?.particles.length ?? 0,
      corpses: this.vfx?.starvationCount?.() ?? 0,
    };
  }

  dispose() {
    this.vfx?.reset();
    for (const key of ['mesh', 'shadowMesh', 'planktonMesh']) {
      const object = this[key];
      if (!object) continue;
      object.removeFromParent();
      object.geometry.dispose();
      object.material.dispose();
      this[key] = null;
    }
  }

  _buildFish(view) {
    if (!this.scene?.add) {
      this.mesh = null;
      return;
    }
    const radialSegments = Math.max(
      3,
      Math.round(view.config.visual.radialSegments)
    );
    const geometry = new THREE.CapsuleGeometry(
      view.config.visual.bodyRadius,
      view.config.visual.bodyLength,
      2,
      radialSegments
    );
    geometry.rotateX(Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: view.config.visual.opacity < 1,
      opacity: view.config.visual.opacity,
    });
    // A little light from above: backs a touch brighter, bellies darker.
    // Unlit on purpose otherwise, so a school's color stays the color the
    // panel shows instead of depending on scene lights.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          'void main() {',
          'varying float vFishLight;\nvoid main() {'
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vec3 fishNormal = normal;
          #ifdef USE_INSTANCING
            fishNormal = mat3( instanceMatrix ) * fishNormal;
          #endif
          fishNormal = normalize( mat3( modelMatrix ) * fishNormal );
          vFishLight = dot( fishNormal, normalize( vec3( 0.3, 1.0, 0.35 ) ) );`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          'varying float vFishLight;\nvoid main() {'
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          diffuseColor.rgb *= mix( 0.74, 1.1, vFishLight * 0.5 + 0.5 );`
        );
    };
    this.mesh = new THREE.InstancedMesh(geometry, material, view.count);
    this.mesh.name = 'experiment-fish';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let index = 0; index < view.count; index += 1) {
      const school = view.config.schools[view.schoolIds[index]];
      this.mesh.setColorAt(index, new THREE.Color(school.color));
    }
    this.mesh.instanceColor.needsUpdate = true;
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this._buildShadows(view);
  }

  // A soft oval under every fish on the tank floor. Fainter and wider the
  // higher the fish swims, so the floor shows where a school is in depth,
  // which a front view alone cannot.
  _buildShadows(view) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: '#4a3f30',
      transparent: true,
      depthWrite: false,
    });
    // Instance color red carries each shadow's opacity; the oval's soft edge
    // comes from the vertex position, so no texture is needed.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          'void main() {',
          'varying vec2 vShadowXZ;\nvarying float vShadowAlpha;\nvoid main() {'
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vShadowXZ = position.xz * 2.0;
          vShadowAlpha = 1.0;
          #ifdef USE_INSTANCING_COLOR
            vShadowAlpha = instanceColor.r;
          #endif`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          'varying vec2 vShadowXZ;\nvarying float vShadowAlpha;\nvoid main() {'
        )
        .replace(
          '#include <color_fragment>',
          'diffuseColor.a *= vShadowAlpha * ( 1.0 - smoothstep( 0.15, 1.0, length( vShadowXZ ) ) );'
        );
    };
    this.shadowMesh = new THREE.InstancedMesh(geometry, material, view.count);
    this.shadowMesh.name = 'experiment-fish-shadows';
    this.shadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const none = new THREE.Color(0, 0, 0);
    for (let index = 0; index < view.count; index += 1) {
      this.shadowMesh.setColorAt(index, none);
    }
    this.shadowMesh.frustumCulled = false;
    this.shadowMesh.renderOrder = -1;
    this.scene.add(this.shadowMesh);
  }

  _buildPlankton(view) {
    if (!this.scene?.add || view.config.plankton.visualCount <= 0) {
      this.planktonMesh = null;
      return;
    }
    const count = Math.max(
      0,
      Math.round(view.config.plankton.visualCount)
    );
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const rng = new SeededRng(
      (Number(view.config.runtime.seed) ^ 0x9e3779b9) >>> 0
    );
    const margin = view.config.tank.wallMargin;
    const half = [
      Math.max(0, view.config.tank.width / 2 - margin),
      Math.max(0, view.config.tank.height / 2 - margin),
      Math.max(0, view.config.tank.depth / 2 - margin),
    ];
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      positions[offset] = rng.range(-half[0], half[0]);
      positions[offset + 1] = rng.range(-half[1], half[1]);
      positions[offset + 2] = rng.range(-half[2], half[2]);
    }
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3)
    );
    const material = new THREE.PointsMaterial({
      color: view.config.plankton.color,
      size: view.config.plankton.pointSize,
      transparent: true,
      opacity: view.config.plankton.opacity,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.planktonMesh = new THREE.Points(geometry, material);
    this.planktonMesh.name = 'experiment-plankton';
    this.planktonMesh.frustumCulled = false;
    this.scene.add(this.planktonMesh);
  }


  _syncPlankton(view) {
    if (!this.planktonMesh) return;
    const visible =
      view.config.ecology?.enabled &&
      view.config.plankton.enabled;
    this.planktonMesh.visible = visible;
    // The points are the model: live particles are compacted into the buffer
    // at their real positions, so what is drawn is exactly the food that
    // remains. Earlier this showed the first N points of a fixed random cloud
    // in proportion to total stock, so fish eating at the top of the tank made
    // points vanish at the bottom. That was a progress bar drawn as dots,
    // depicting spatial food the model did not have.
    let visibleCount = 0;
    if (visible) {
      const array = this.planktonMesh.geometry.attributes.position.array;
      const field = view.food;
      for (let i = 0; i < field.count; i += 1) {
        if (field.uses[i] === 0) continue;
        const from = i * 3;
        const to = visibleCount * 3;
        array[to] = field.positions[from];
        array[to + 1] = field.positions[from + 1];
        array[to + 2] = field.positions[from + 2];
        visibleCount += 1;
      }
      this.planktonMesh.geometry.attributes.position.needsUpdate = true;
    }
    this.planktonMesh.geometry.setDrawRange(0, visibleCount);
    this.planktonMesh.material.size = view.config.plankton.pointSize;
    this.planktonMesh.material.opacity = view.config.plankton.opacity;
    this.planktonMesh.material.color.set(view.config.plankton.color);
  }


  _updateFish(view, dt) {
    if (!this.mesh) return;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const rollQuaternion = new THREE.Quaternion();
    const corpseTint = new THREE.Color();
    const scale = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const shadows = this.shadowMesh;
    const shadowScale = new THREE.Vector3();
    const shadowPosition = new THREE.Vector3();
    const shadowTurn = new THREE.Quaternion();
    const shadowAlpha = new THREE.Color();
    const floorY = -view.config.tank.height / 2 + 0.002;
    const tankHeight = Math.max(EPSILON, view.config.tank.height);
    const bodyLength =
      view.config.visual.bodyLength + 2 * view.config.visual.bodyRadius;
    const bodyWidth = 2 * view.config.visual.bodyRadius;
    // The turn rate below is measured between two frames; scale it to the
    // reference step so bankingGain keeps its meaning, and convert the
    // per-step smoothing into the same fraction of time.
    const steps = dt / REFERENCE_STEP;
    const turnScale = 1 / steps;
    const smoothing = 1 - (1 - view.config.visual.bankingSmoothing) ** steps;
    for (let index = 0; index < view.count; index += 1) {
      let castsShadow = false;
      const offset = index * 3;
      position.set(
        view.positions[offset],
        view.positions[offset + 1],
        view.positions[offset + 2]
      );
      if (index === view.hiddenFish) {
        scale.setScalar(0);
        quaternion.identity();
      } else if (!view.alive[index]) {
        // Corpse: keep the fish model, belly up, grey.
        if (view.corpse[index]) {
          const schoolIndex = view.schoolIds[index];
          const school = view.config.schools[schoolIndex];
          // Body size with the same visual scaling, so size does not jump at death.
          scale.setScalar(visualSizeOf(school.size, school.id));
          const fade = Math.max(
            0.01,
            view.config.ecology.corpseFadeTime ?? 1.6
          );
          const t = clamp(view.corpseAge[index] / fade, 0, 1);
          // Roll gradually from the heading at death to belly up.
          direction
            .set(
              this.prevHeadings[offset],
              this.prevHeadings[offset + 1],
              this.prevHeadings[offset + 2]
            )
            .normalize();
          if (direction.lengthSq() <= EPSILON) direction.copy(FORWARD);
          quaternion.setFromUnitVectors(FORWARD, direction);
          rollQuaternion.setFromAxisAngle(FORWARD, Math.PI * t);
          quaternion.multiply(rollQuaternion);
          // Color fades from the school color to grey.
          if (this.mesh.instanceColor) {
            corpseTint
              .copy(this.schoolColors[schoolIndex])
              .lerp(this.corpseColor, t);
            this.mesh.setColorAt(index, corpseTint);
            this._instanceColorDirty = true;
          }
        } else {
          scale.setScalar(0);
          quaternion.identity();
        }
      } else {
        const school = view.config.schools[view.schoolIds[index]];
        // Rules use school.size; rendering uses visualSizeOf.
        scale.setScalar(visualSizeOf(school.size, school.id));
        // Stamina brightness follows survival time = energy / metabolic rate.
        // In the preview energy stays full, so it shows how long the trait
        // choice lasts; while running it shows how long the fish has left.
        // Burst cost is excluded, otherwise brightness would flicker.
        if (this.mesh.instanceColor && STAMINA_TINT_STRENGTH !== 0) {
          const drain = metabolicRate(view.config, school, false);
          const seconds =
            drain > EPSILON ? view.energy[index] / drain : Infinity;
          const factor = staminaTintFactor(seconds);
          if (Math.abs(factor - this.tintFactors[index]) > 0.004) {
            this.tintFactors[index] = factor;
            corpseTint
              .copy(this.schoolColors[view.schoolIds[index]])
              .multiplyScalar(factor);
            this.mesh.setColorAt(index, corpseTint);
            this._instanceColorDirty = true;
          }
        }
        direction
          .set(
            view.velocities[offset],
            view.velocities[offset + 1],
            view.velocities[offset + 2]
          )
          .normalize();
        if (direction.lengthSq() <= EPSILON) direction.copy(FORWARD);
        // Banking: the turn rate is estimated from the cross product of last and
        // current heading; its vertical component gives the turn direction.
        const visual = view.config.visual;
        const px = this.prevHeadings[offset];
        const py = this.prevHeadings[offset + 1];
        const pz = this.prevHeadings[offset + 2];
        let targetRoll = 0;
        if (px !== 0 || py !== 0 || pz !== 0) {
          const yawRate = pz * direction.x - px * direction.z;
          const maxRoll = (visual.maxRollDegrees * Math.PI) / 180;
          targetRoll = clamp(
            yawRate * turnScale * visual.bankingGain,
            -maxRoll,
            maxRoll
          );
        }
        this.rollAngles[index] +=
          (targetRoll - this.rollAngles[index]) * smoothing;
        this.prevHeadings[offset] = direction.x;
        this.prevHeadings[offset + 1] = direction.y;
        this.prevHeadings[offset + 2] = direction.z;
        quaternion.setFromUnitVectors(FORWARD, direction);
        if (Math.abs(this.rollAngles[index]) > 1e-4) {
          rollQuaternion.setFromAxisAngle(FORWARD, this.rollAngles[index]);
          quaternion.multiply(rollQuaternion);
        }
        if (shadows) {
          const height = clamp((position.y - floorY) / tankHeight, 0, 1);
          const spread = 1 + 1.4 * height;
          shadowPosition.set(position.x, floorY, position.z);
          shadowTurn.setFromAxisAngle(UP, Math.atan2(direction.x, direction.z));
          shadowScale.set(
            bodyWidth * scale.x * 2.2 * spread,
            1,
            bodyLength * scale.x * 1.3 * spread
          );
          matrix.compose(shadowPosition, shadowTurn, shadowScale);
          shadows.setMatrixAt(index, matrix);
          // Faint: a whole school's shadows overlap into one soft patch.
          shadowAlpha.setRGB(0.09 * (1 - 0.7 * height), 0, 0);
          shadows.setColorAt(index, shadowAlpha);
          castsShadow = true;
        }
      }
      if (shadows && !castsShadow) {
        matrix.makeScale(0, 0, 0);
        shadows.setMatrixAt(index, matrix);
      }
      matrix.compose(position, quaternion, scale);
      this.mesh.setMatrixAt(index, matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (shadows) {
      shadows.instanceMatrix.needsUpdate = true;
      shadows.instanceColor.needsUpdate = true;
    }
    if (this._instanceColorDirty && this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
      this._instanceColorDirty = false;
    }
  }

}
