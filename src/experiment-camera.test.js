import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_MODE,
  cameraModeAfterEscape,
} from './experiment-camera.js';

test('escape returns both fullscreen fish views to global mode', () => {
  assert.equal(
    cameraModeAfterEscape(CAMERA_MODE.CLOSEUP),
    CAMERA_MODE.GLOBAL
  );
  assert.equal(
    cameraModeAfterEscape(CAMERA_MODE.FOLLOW),
    CAMERA_MODE.GLOBAL
  );
  assert.equal(
    cameraModeAfterEscape(CAMERA_MODE.GLOBAL),
    CAMERA_MODE.GLOBAL
  );
});
