export function resolveHeldTimeScale(heldKeys) {
  const lastKey = heldKeys.at(-1);
  if (lastKey === 'Enter') return 2;
  if (lastKey === 'Space') return 0.2;
  return 1;
}

export class HeldTimeShortcutState {
  constructor() {
    this.keys = [];
  }

  press(code) {
    if (code !== 'Enter' && code !== 'Space') return null;
    const existingIndex = this.keys.indexOf(code);
    if (existingIndex >= 0) this.keys.splice(existingIndex, 1);
    this.keys.push(code);
    return resolveHeldTimeScale(this.keys);
  }

  release(code) {
    const existingIndex = this.keys.indexOf(code);
    if (existingIndex < 0) return null;
    this.keys.splice(existingIndex, 1);
    return resolveHeldTimeScale(this.keys);
  }

  clear() {
    const hadKeys = this.keys.length > 0;
    this.keys.length = 0;
    return hadKeys ? 1 : null;
  }
}

export class SpaceDoubleTapDetector {
  constructor(maxIntervalMs = 200) {
    this.maxIntervalMs = maxIntervalMs;
    this.lastPressAt = -Infinity;
  }

  press(now) {
    const isDoubleTap = now - this.lastPressAt < this.maxIntervalMs;
    this.lastPressAt = isDoubleTap ? -Infinity : now;
    return isDoubleTap;
  }

  clear() {
    this.lastPressAt = -Infinity;
  }
}

export function isEditableShortcutTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const tagName = String(target.tagName ?? '').toUpperCase();
  return (
    ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tagName) ||
    Boolean(target.isContentEditable) ||
    Boolean(target.closest?.('[contenteditable="true"]'))
  );
}

export class TimeShortcutController {
  constructor({
    root = document.getElementById('app'),
    target = window,
    setTimeScale,
    onDoubleSpace = () => {},
    doubleSpaceMs = 200,
  }) {
    this.root = root;
    this.target = target;
    this.setTimeScale = setTimeScale;
    this.onDoubleSpace = onDoubleSpace;
    this.state = new HeldTimeShortcutState();
    this.doubleSpace = new SpaceDoubleTapDetector(doubleSpaceMs);
    this.enabled = true;
    this.hud = this._createHud();
    this.valueLabel = this.hud.querySelector('#time-shortcut-value');
    this.lastDisplayedValue = null;
    this.onKeyDown = (event) => this._handleKeyDown(event);
    this.onKeyUp = (event) => this._handleKeyUp(event);
    this.onBlur = () => this._releaseAll();
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
    this.update(1);
  }

  _createHud() {
    const hud = document.createElement('section');
    hud.id = 'time-shortcut-hud';
    hud.setAttribute('aria-label', '时间快捷键');
    hud.innerHTML = `
      <strong id="time-shortcut-value">1×</strong>
      <span>HOLD ENTER&nbsp; 2×</span>
      <span>HOLD SPACE&nbsp; 0.2×</span>
      <span>SPACE×2&nbsp; GLOBAL VIEW</span>
    `;
    this.root.appendChild(hud);
    return hud;
  }

  _apply(value) {
    const applied = this.setTimeScale(value);
    this.update(applied ?? value);
  }

  _handleKeyDown(event) {
    if (
      !this.enabled ||
      event.repeat ||
      event.defaultPrevented ||
      isEditableShortcutTarget(event.target)
    ) {
      return;
    }
    const code =
      event.code === 'Enter' || event.key === 'Enter'
        ? 'Enter'
        : event.code === 'Space' || event.key === ' '
          ? 'Space'
          : event.code;
    if (code !== 'Enter' && code !== 'Space') return;
    event.preventDefault();
    this._apply(this.state.press(code));
    if (code === 'Space') {
      const now = Number.isFinite(event.timeStamp)
        ? event.timeStamp
        : performance.now();
      if (this.doubleSpace.press(now)) this.onDoubleSpace();
    }
  }

  _handleKeyUp(event) {
    if (!this.enabled) return;
    const code =
      event.code === 'Enter' || event.key === 'Enter'
        ? 'Enter'
        : event.code === 'Space' || event.key === ' '
          ? 'Space'
          : event.code;
    const scale = this.state.release(code);
    if (scale === null) return;
    event.preventDefault();
    this._apply(scale);
  }

  _releaseAll() {
    const scale = this.state.clear();
    this.doubleSpace.clear();
    if (scale !== null) this._apply(scale);
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.enabled) return;
    this.enabled = next;
    this.hud.hidden = !next;
    if (!next) {
      this.state.clear();
      this.doubleSpace.clear();
    }
  }

  update(value) {
    const safe = Number.isFinite(Number(value)) ? Number(value) : 1;
    if (safe === this.lastDisplayedValue) return;
    this.lastDisplayedValue = safe;
    this.hud.dataset.paused = safe <= 0 ? 'true' : 'false';
    this.valueLabel.textContent =
      safe <= 0 ? 'PAUSED' : `${safe.toFixed(safe < 1 ? 1 : 0)}×`;
  }

  dispose() {
    this._releaseAll();
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
    this.hud.remove();
  }
}
