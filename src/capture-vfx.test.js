import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CaptureVfx } from './capture-vfx.js';

test('starvation corpses are brown, persistent and edible', () => {
  const scene = new THREE.Scene();
  const vfx = new CaptureVfx(
    scene,
    { enabled: true, density: 0, particleCount: 4 },
    {
      particleCount: 4,
      density: 0,
      spawnRadius: 0.05,
      spawnInterval: 0,
      cubeSize: 0.02,
      cubeColor: '#8B5A2B',
      radialSpeed: 0.0,
      gravity: -0.08,
      persist: true,
    }
  );
  const origin = new THREE.Vector3(0, 0.2, 0);
  assert.equal(vfx.emitStarvation(origin, { floorY: -0.5 }), 4);
  assert.ok(vfx.particles.every((p) => p.color === '#8B5A2B'));
  vfx.step(0.5);
  assert.equal(vfx.starvationCount(), 4);
  assert.equal(
    vfx.consumeNearestStarvation(new THREE.Vector3(0, -0.1, 0), 1),
    true
  );
  assert.equal(vfx.starvationCount(), 3);
  vfx.step(10);
  assert.equal(vfx.starvationCount(), 3);
});

test('feed particles fall back to the plankton dark green', () => {
  const scene = new THREE.Scene();
  const vfx = new CaptureVfx(scene, {
    enabled: true,
    density: 0,
    particleCount: 0,
    feedEnabled: true,
    feedParticles: 3,
  });
  vfx.emitFeed(0, 0, 0);
  assert.equal(vfx.particles.length, 3);
  assert.ok(vfx.particles.every((particle) => particle.color === '#14532d'));
  vfx.dispose();
});
