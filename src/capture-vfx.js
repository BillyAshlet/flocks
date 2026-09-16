import * as THREE from 'three';

import { CAPTURE_FX_PARAMS } from './evolution-model.js';

const MAX_PARTICLES = 256;
const EPSILON = 1e-8;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _initialVelocity = new THREE.Vector3();
const _radial = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function nonNegative(value, fallback = 0) {
  return Math.max(0, finiteOr(value, fallback));
}

function fibonacciDirection(index, count, out) {
  // Even shell sampling with a tiny deterministic jitter so successive
  // bites never look like the exact same crystal lattice.
  const i = index + 0.5;
  const y = 1 - (2 * i) / count;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = GOLDEN_ANGLE * i;
  const jitter = ((index * 17) % 7) * 0.035;
  out.set(
    Math.cos(theta + jitter) * radius,
    y,
    Math.sin(theta + jitter) * radius
  );
  if (out.lengthSq() < EPSILON) out.set(0, 1, 0);
  return out.normalize();
}

/**
 * Capture debris + bite glow.
 *
 * Cubes are seeded on a Fibonacci sphere around the fish death point.
 * Density scales how many points occupy the shell; upwardSpeed and the
 * predator reverse velocity still dominate the later trajectory. Glow is
 * a transparent billboard ring whose brightness falls off as
 * (1 - r/R) * exp(-k r/R).
 */
export const DEFAULT_STARVATION_VFX = Object.freeze({
  particleCount: 10,
  density: 1.6,
  spawnRadius: 0.05,
  spawnInterval: 0.03,
  cubeSize: 0.02,
  cubeColor: '#8B5A2B',
  radialSpeed: 0.035,
  gravity: -0.05,
  // Starvation debris never fades out; it only settles under gravity.
  persist: true,
});

export class CaptureVfx {
  constructor(scene, params = CAPTURE_FX_PARAMS, starvationParams = DEFAULT_STARVATION_VFX) {
    if (!scene?.add) {
      throw new TypeError('CaptureVfx requires a Three.js Scene');
    }
    this.scene = scene;
    this.params = params;
    this.starvationParams = starvationParams || DEFAULT_STARVATION_VFX;
    // 缸体半尺寸。尸体原来只钳制 y（floorY），x/z 完全不管 —— 带着初速度
    // 就直接飘出侧壁了。null = 不限制（测试路径）。
    this.bounds = null;
    this.particles = [];
    this.glows = [];
    this._nextBurstId = 1;

    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    this.material = new THREE.MeshBasicMaterial({
      color: params.cubeColor || '#1e4f8c',
    });
    this.mesh = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      MAX_PARTICLES
    );
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_PARTICLES * 3),
      3
    );
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this._color = new THREE.Color();

    this.glowGeometry = new THREE.SphereGeometry(1, 20, 14);
    // 颜色可配：辉光是普通混合的半透明球，靠"比背景亮"来读。深水关卡
    // 里白色是对的，但教学关是近白底（#eef1f0），白球等于隐形 ——
    // 那一层恰恰是"咬到了"这一瞬最主要的重音。白底下要换成深色，
    // 让它读成一次暗脉冲而不是一次亮脉冲。
    this.glowMaterial = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    // One reusable glow mesh is enough for the sandbox; new bites just
    // restart the strongest remaining pulse.
    this.glowMesh = new THREE.Mesh(this.glowGeometry, this.glowMaterial);
    this.glowMesh.visible = false;
    this.glowMesh.renderOrder = 2;
    scene.add(this.glowMesh);
  }

  _desiredCount(params = this.params) {
    const P = params;
    const density = nonNegative(P.density, 1);
    const radius = Math.max(nonNegative(P.spawnRadius, 0.04), 0.01);
    // Area of a unit-ish shell around the bite. Density 1 ≈ previous look.
    const byDensity = Math.round(density * 4 * Math.PI * radius * radius * 180);
    const ceiling = Math.min(
      24,
      Math.max(1, Math.round(finiteOr(P.particleCount, 8)))
    );
    // density 0 is a deterministic test/debug path that falls back to the
    // explicit particleCount ceiling instead of estimating shell occupancy.
    if (density <= 0) return ceiling;
    return Math.max(1, Math.min(ceiling, Math.max(1, byDensity)));
  }

  emit(position, predatorVelocity, glowCenter = null) {
    const P = this.params;
    if (!P.enabled || !position || !predatorVelocity) return 0;

    const count = this._desiredCount();
    const interval = nonNegative(P.spawnInterval, 0.02);
    const lifetime = nonNegative(P.lifetime, 0.5);
    const size = nonNegative(P.cubeSize, 0.018);
    const spawnRadius = nonNegative(P.spawnRadius, 0.04);
    const radialSpeed = nonNegative(P.radialSpeed, 0.18);
    if (count === 0 || lifetime <= EPSILON || size <= EPSILON) return 0;

    while (this.particles.length + count > MAX_PARTICLES) {
      const oldestBurstId = this.particles[0]?.burstId;
      if (oldestBurstId === undefined) break;
      let removeCount = 0;
      while (
        removeCount < this.particles.length &&
        this.particles[removeCount].burstId === oldestBurstId
      ) {
        removeCount++;
      }
      this.particles.splice(0, removeCount);
    }

    const burstId = this._nextBurstId++;
    for (let i = 0; i < count; i++) {
      fibonacciDirection(i, count, _radial);
      _initialVelocity
        .copy(_radial)
        .multiplyScalar(radialSpeed)
        .addScaledVector(_up, nonNegative(P.upwardSpeed, 0.12))
        .addScaledVector(
          predatorVelocity,
          -nonNegative(P.reverseVelocityFactor, 0.4)
        );

      this.particles.push({
        burstId,
        style: 'capture',
        origin: position
          .clone()
          .addScaledVector(_radial, spawnRadius * (0.35 + 0.65 * ((i % 5) / 4))),
        initialVelocity: _initialVelocity.clone(),
        gravityY: 0,
        age: -i * interval,
        lifetime,
        size,
        color: P.cubeColor || '#1e4f8c',
      });
    }

    this._emitGlow(glowCenter || position);
    this._writeMatrices();
    return count;
  }

  emitStarvation(position, options = {}) {
    const P = this.starvationParams || DEFAULT_STARVATION_VFX;
    if (!position) return 0;

    const count = this._desiredCount(P);
    const interval = nonNegative(P.spawnInterval, 0.03);
    const size = nonNegative(P.cubeSize, 0.02);
    const spawnRadius = nonNegative(P.spawnRadius, 0.05);
    const radialSpeed = nonNegative(P.radialSpeed, 0.035);
    const gravity = finiteOr(P.gravity, -0.05);
    const floorY = Number.isFinite(options.floorY)
      ? options.floorY
      : Number.isFinite(P.floorY)
        ? P.floorY
        : -Infinity;
    if (count === 0 || size <= EPSILON) return 0;

    while (this.particles.length + count > MAX_PARTICLES) {
      const oldestBurstId = this.particles[0]?.burstId;
      if (oldestBurstId === undefined) break;
      let removeCount = 0;
      while (
        removeCount < this.particles.length &&
        this.particles[removeCount].burstId === oldestBurstId
      ) {
        removeCount++;
      }
      this.particles.splice(0, removeCount);
    }

    const burstId = this._nextBurstId++;
    for (let i = 0; i < count; i++) {
      fibonacciDirection(i, count, _radial);
      _initialVelocity.copy(_radial).multiplyScalar(radialSpeed);
      this.particles.push({
        burstId,
        style: 'starvation',
        origin: position
          .clone()
          .addScaledVector(_radial, spawnRadius * (0.35 + 0.65 * ((i % 5) / 4))),
        initialVelocity: _initialVelocity.clone(),
        gravityY: gravity,
        floorY,
        age: -i * interval,
        // Persistent corpse debris: no lifetime cull and no size fade.
        lifetime: Infinity,
        persist: true,
        size,
        color: P.cubeColor || '#8B5A2B',
      });
    }

    this._writeMatrices();
    return count;
  }

  _emitGlow(position) {
    const P = this.params;
    if (!P.biteGlowEnabled) {
      this.glowMesh.visible = false;
      this.glows.length = 0;
      return;
    }
    const duration = nonNegative(P.biteGlowDuration, 0.35);
    const radius = nonNegative(P.biteGlowRadius, 0.28);
    if (duration <= EPSILON || radius <= EPSILON) return;
    this.glows = [
      {
        origin: position.clone(),
        age: 0,
        duration,
        radius,
        strength: nonNegative(P.biteGlowStrength, 0.55),
        falloff: nonNegative(P.biteGlowFalloff, 2.4),
      },
    ];
  }

  syncMaterial() {
    const next = this.params.cubeColor || '#1e4f8c';
    if (this.material.color.getStyle() !== new THREE.Color(next).getStyle()) {
      this.material.color.set(next);
    }
    const glow = this.params.biteGlowColor || '#ffffff';
    if (this.glowMaterial.color.getStyle() !== new THREE.Color(glow).getStyle()) {
      this.glowMaterial.color.set(glow);
    }
  }

  step(dt) {
    this.syncMaterial();
    if (!(dt > 0)) return;
    // Capture emit may be disabled, but persistent starvation corpses still simulate.

    if (this.particles.length > 0) {
      let writeIndex = 0;
      for (let readIndex = 0; readIndex < this.particles.length; readIndex++) {
        const particle = this.particles[readIndex];
        particle.age += dt;
        // Capture debris still expires. Starvation corpses persist and only
        // leave when capacity eviction removes the oldest burst.
        if (particle.persist || particle.age <= particle.lifetime) {
          this.particles[writeIndex++] = particle;
        }
      }
      this.particles.length = writeIndex;
      this._writeMatrices();
    }

    if (this.glows.length > 0) {
      let write = 0;
      for (let i = 0; i < this.glows.length; i++) {
        const glow = this.glows[i];
        glow.age += dt;
        if (glow.age <= glow.duration) this.glows[write++] = glow;
      }
      this.glows.length = write;
      this._writeGlow();
    } else if (this.glowMesh.visible) {
      this.glowMesh.visible = false;
      this.glowMaterial.opacity = 0;
    }
  }

  /** 设置缸体半尺寸 [hx, hy, hz]，用于把碎屑限制在缸内。 */
  setBounds(half) {
    this.bounds =
      Array.isArray(half) && half.length === 3 && half.every(Number.isFinite)
        ? half.slice()
        : null;
  }

  /** 把位置钳制进缸内（尸体不该穿出玻璃）。 */
  _clampToTank(vec) {
    if (!this.bounds) return vec;
    const margin = nonNegative(this.starvationParams?.wallMargin, 0.01);
    const hx = Math.max(0, this.bounds[0] - margin);
    const hy = Math.max(0, this.bounds[1] - margin);
    const hz = Math.max(0, this.bounds[2] - margin);
    vec.x = Math.min(hx, Math.max(-hx, vec.x));
    vec.y = Math.min(hy, Math.max(-hy, vec.y));
    vec.z = Math.min(hz, Math.max(-hz, vec.z));
    return vec;
  }

  /** 进食特效：一小簇向上飘散的浅色碎屑。 */
  /** 粒子上限保护。 */
  _trim() {
    const cap = Math.max(32, Math.round(nonNegative(this.params?.maxParticles, 600)));
    if (this.particles.length > cap) {
      this.particles.splice(0, this.particles.length - cap);
    }
  }

  emitFeed(x, y, z) {
    const P = this.params || {};
    if (P.feedEnabled === false) return;
    const count = Math.max(1, Math.round(nonNegative(P.feedParticles, 3)));
    const speed = nonNegative(P.feedSpeed, 0.12);
    const size = nonNegative(P.feedSize, 0.009);
    const lifetime = nonNegative(P.feedLifetime, 0.32);
    for (let i = 0; i < count; i += 1) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      this.particles.push({
        age: 0,
        lifetime,
        size,
        origin: new THREE.Vector3(x, y, z),
        initialVelocity: new THREE.Vector3(
          Math.sin(phi) * Math.cos(theta) * speed,
          Math.abs(Math.cos(phi)) * speed + speed * 0.4,
          Math.sin(phi) * Math.sin(theta) * speed
        ),
        color: P.feedColor || '#14532d',
        style: 'feed',
      });
    }
    this._trim();
  }

  _writeMatrices() {
    for (let i = 0; i < this.particles.length; i++) {
      const particle = this.particles[i];
      if (particle.age < 0) {
        _matrix.makeScale(0, 0, 0);
        _matrix.setPosition(particle.origin);
        this.mesh.setMatrixAt(i, _matrix);
        continue;
      }

      if (particle.style === 'starvation' || particle.persist) {
        // Natural corpse sink: x = x0 + v0 t + 1/2 a t^2. No lifetime fade.
        const age = Math.max(0, particle.age);
        _position
          .copy(particle.origin)
          .addScaledVector(particle.initialVelocity, age);
        _position.y += 0.5 * finiteOr(particle.gravityY, -0.05) * age * age;
        if (Number.isFinite(particle.floorY)) {
          _position.y = Math.max(particle.floorY, _position.y);
        }
        this._clampToTank(_position);
        _scale.setScalar(particle.size);
      } else {
        const age = Math.min(particle.age, particle.lifetime);
        const speedRatio = Math.max(0, 1 - age / Math.max(particle.lifetime, EPSILON));
        // Integral of v0(1 - t/L): displacement = v0(t - t²/(2L)).
        const displacement = age - (age * age) / (2 * particle.lifetime);
        _position
          .copy(particle.origin)
          .addScaledVector(particle.initialVelocity, displacement);
        _scale.setScalar(particle.size * speedRatio);
      }
      _matrix.makeScale(_scale.x, _scale.y, _scale.z);
      _matrix.setPosition(this._clampToTank(_position));
      this.mesh.setMatrixAt(i, _matrix);
      this._color.set(particle.color || '#1e4f8c');
      this.mesh.setColorAt(i, this._color);
    }
    this.mesh.count = this.particles.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  worldPositionAt(index, out = _position) {
    const particle = this.particles[index];
    if (!particle) return null;
    if (particle.age < 0) {
      out.copy(particle.origin);
      return out;
    }
    if (particle.style === 'starvation' || particle.persist) {
      const age = Math.max(0, particle.age);
      out
        .copy(particle.origin)
        .addScaledVector(particle.initialVelocity, age);
      out.y += 0.5 * finiteOr(particle.gravityY, -0.05) * age * age;
      if (Number.isFinite(particle.floorY)) {
        out.y = Math.max(particle.floorY, out.y);
      }
      this._clampToTank(out);
      return out;
    }
    const age = Math.min(particle.age, particle.lifetime);
    const displacement = age - (age * age) / (2 * Math.max(particle.lifetime, EPSILON));
    out
      .copy(particle.origin)
      .addScaledVector(particle.initialVelocity, displacement);
    return out;
  }

  /**
   * Eat the nearest visible starvation corpse fragment within radius.
   * Returns true when a fragment was consumed.
   */
  consumeNearestStarvation(position, radius) {
    if (!position || !(radius > 0) || this.particles.length === 0) return false;
    const radius2 = radius * radius;
    let best = -1;
    let bestDistance2 = Infinity;
    for (let i = 0; i < this.particles.length; i += 1) {
      const particle = this.particles[i];
      if (particle.style !== 'starvation' && !particle.persist) continue;
      if (particle.age < 0) continue;
      this.worldPositionAt(i, _position);
      const dx = _position.x - position.x;
      const dy = _position.y - position.y;
      const dz = _position.z - position.z;
      const distance2 = dx * dx + dy * dy + dz * dz;
      if (distance2 <= radius2 && distance2 < bestDistance2) {
        bestDistance2 = distance2;
        best = i;
      }
    }
    if (best < 0) return false;
    this.particles.splice(best, 1);
    this._writeMatrices();
    return true;
  }

  starvationCount() {
    let count = 0;
    for (const particle of this.particles) {
      if (
        (particle.style === 'starvation' || particle.persist) &&
        particle.age >= 0
      ) {
        count += 1;
      }
    }
    return count;
  }

  _writeGlow() {
    const glow = this.glows[0];
    if (!glow) {
      this.glowMesh.visible = false;
      this.glowMaterial.opacity = 0;
      return;
    }
    const u = Math.min(1, Math.max(0, glow.age / glow.duration));
    // Brightest immediately after the bite, then soft release.
    const envelope = Math.exp(-3.2 * u) * (1 - u);
    // Represent the radial falloff profile with a slightly expanding shell
    // whose opacity already encodes the linear*exp center weight.
    const visualRadius = glow.radius * (0.55 + 0.75 * u);
    const centerWeight = Math.exp(-glow.falloff * 0.15);
    this.glowMesh.visible = envelope > 0.01;
    this.glowMesh.position.copy(glow.origin);
    this.glowMesh.scale.setScalar(Math.max(visualRadius, 1e-4));
    this.glowMaterial.opacity = Math.min(
      0.55,
      glow.strength * envelope * centerWeight
    );
  }

  // Public helper for the school brightening pass: returns the strongest
  // lighten factor at a world position using linear * exp falloff.
  sampleLighten(position) {
    let best = 0;
    for (const glow of this.glows) {
      const radius = Math.max(glow.radius, EPSILON);
      const distance = position.distanceTo(glow.origin);
      if (distance >= radius) continue;
      const t = distance / radius;
      const u = Math.min(1, Math.max(0, glow.age / glow.duration));
      const envelope = Math.exp(-3.2 * u) * (1 - u);
      const spatial = (1 - t) * Math.exp(-glow.falloff * t);
      best = Math.max(best, glow.strength * envelope * spatial);
    }
    return best;
  }

  reset() {
    this.particles.length = 0;
    this.glows.length = 0;
    this._nextBurstId = 1;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.glowMesh.visible = false;
    this.glowMaterial.opacity = 0;
  }

  dispose() {
    this.reset();
    this.scene.remove(this.mesh);
    this.scene.remove(this.glowMesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.glowGeometry.dispose();
    this.glowMaterial.dispose();
  }
}
