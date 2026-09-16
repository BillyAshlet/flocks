import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DistanceField3D,
  castRay,
  obstacleSignedDistance,
  sceneClearance,
} from './distance-field.js';
import { createDefaultConfig } from './experiment-config.js';

test('tank wall clearance grows away from every wall', () => {
  const config = createDefaultConfig();
  config.obstacles.enabled = false;
  const field = new DistanceField3D(config);
  const nearX = config.tank.width / 2 - 0.02;
  assert.ok(Math.abs(field.clearance([nearX, 0, 0]) - 0.02) < 1e-6);
  assert.ok(field.clearance([nearX - 0.05, 0, 0]) > field.clearance([nearX, 0, 0]));
  const nearFloor = -config.tank.height / 2 + 0.02;
  assert.ok(field.clearance([0, nearFloor + 0.05, 0]) > field.clearance([0, nearFloor, 0]));
  assert.equal(field.config.distanceField.paddingCells >= 1, true);
});

test('box obstacle field is signed, continuous and grows away from solid', () => {
  const config = createDefaultConfig();
  config.obstacles.enabled = true;
  for (const [key, obstacle] of Object.entries(config.obstacles)) {
    if (key !== 'enabled') obstacle.enabled = key === 'blockA';
  }
  Object.assign(config.obstacles.blockA, {
    x: 0,
    y: 0,
    z: 0,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    width: 0.4,
    height: 0.4,
    depth: 0.4,
  });
  const field = new DistanceField3D(config);
  assert.ok(sceneClearance([0, 0, 0], config) < 0);
  const outside = field.clearance([0.27, 0, 0]);
  assert.ok(outside > 0);
  assert.ok(field.clearance([0.32, 0, 0]) > outside);
  const a = field.sample([0.28, 0.1, 0]);
  const b = field.sample([0.29, 0.1, 0]);
  assert.ok(Math.abs(a - b) < 0.03);
});

test('analytic ring SDF keeps the hole open while marking the panel solid', () => {
  const config = createDefaultConfig();
  const ring = {
    ...config.obstacles.ringA,
    enabled: true,
    x: 0,
    y: 0,
    z: 0,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
  };
  assert.ok(obstacleSignedDistance([0, 0, 0], ring) > 0);
  assert.ok(
    obstacleSignedDistance([ring.holeDiameter / 2 + 0.03, 0, 0], ring) <
      0
  );
  assert.ok(obstacleSignedDistance([ring.width, 0, 0], ring) > 0);
});

test('look-ahead ray hits tank walls and obstacles alike', () => {
  const config = createDefaultConfig();
  config.obstacles.enabled = true;
  for (const [key, obstacle] of Object.entries(config.obstacles)) {
    if (key !== 'enabled') obstacle.enabled = key === 'blockA';
  }
  Object.assign(config.obstacles.blockA, {
    x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0,
    width: 0.4, height: 0.4, depth: 0.4,
  });
  const field = new DistanceField3D(config);
  const clearanceAt = (point) => field.clearance(point);
  const wallX = config.tank.width / 2;

  // Toward the box face at x = -0.2, from 0.5 m away.
  const toBox = castRay(clearanceAt, [-0.7, 0, 0], [1, 0, 0], 1);
  assert.ok(Math.abs(toBox - 0.5) < 0.01);
  // Same distance, but only 0.3 m of look-ahead: clear.
  assert.equal(castRay(clearanceAt, [-0.7, 0, 0], [1, 0, 0], 0.3), Infinity);
  // Toward the +x wall, stopping at the wall margin.
  const toWall = castRay(clearanceAt, [wallX - 0.2, 1, 0], [1, 0, 0], 1, 0.05);
  assert.ok(Math.abs(toWall - 0.15) < 0.01);
  // Swimming away from the wall.
  assert.equal(castRay(clearanceAt, [wallX - 0.2, 1, 0], [-1, 0, 0], 0.5, 0.05), Infinity);
});
