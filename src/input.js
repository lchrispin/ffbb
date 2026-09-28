// Keyboard, mouse and touch, folded into one small state object the game reads each frame.
export class Input {
  constructor(canvas, touchRoot) {
    this.keys = new Set();
    // Edge-triggered actions: 'command', 'click', 'shoot', 'special', 'switch', 'pause',
    // 'escape', 'mute', 'confirm', 'back', 'num1'..'num5', 'navUp'/'navDown'/'navLeft'/'navRight'.
    this.actions = [];
    this.look = { dx: 0, dy: 0 };   // camera nudge from mouse or finger drags
    this.stick = { x: 0, y: 0 };
    this.touchUp = false;
    this.touchDown = false;
    this.touchSprint = false;
    this.touchView = false;
    this.lastLookInput = 0;
    this.enabled = true;

    const bindings = {
      KeyJ: 'command', KeyK: 'shoot', KeyE: 'special', KeyQ: 'switch',
      KeyP: 'pause', Escape: 'escape', KeyM: 'mute',
      Enter: 'confirm', NumpadEnter: 'confirm', Space: 'confirm', Backspace: 'back',
      ArrowUp: 'navUp', ArrowDown: 'navDown', ArrowLeft: 'navLeft', ArrowRight: 'navRight',
    };
    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (['Space', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (!e.repeat) {
        if (bindings[e.code]) this.actions.push(bindings[e.code]);
        const digit = /^(Digit|Numpad)([1-5])$/.exec(e.code);
        if (digit) this.actions.push('num' + digit[2]);
      }
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.touchView = false; });

    // Mouse: left click opens the command wheel, right-drag nudges the camera (it
    // springs back on release), middle click switches swimmer.
    let dragging = false;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || !this.enabled) return;
      e.preventDefault();
      if (e.button === 0) this.actions.push('click');
      if (e.button === 2) dragging = true;
      if (e.button === 1) this.actions.push('switch');
    });
    addEventListener('pointerup', (e) => { if (e.button === 2 || e.pointerType !== 'mouse') dragging = false; });
    addEventListener('mousemove', (e) => {
      if (dragging && e.buttons & 2) {
        this.look.dx += e.movementX;
        this.look.dy += e.movementY;
        this.lastLookInput = performance.now();
      }
    });

    if (touchRoot) this.bindTouch(touchRoot, canvas);
  }

  bindTouch(root, canvas) {
    const stickEl = root.querySelector('[data-stick]');
    const knob = root.querySelector('[data-knob]');
    let stickId = null;
    let center = { x: 0, y: 0 };
    const radius = 46;
    const setKnob = (x, y) => { knob.style.transform = `translate(${x}px, ${y}px)`; };

    stickEl.addEventListener('pointerdown', (e) => {
      stickId = e.pointerId;
      stickEl.setPointerCapture(e.pointerId);
      const r = stickEl.getBoundingClientRect();
      center = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      moveStick(e);
    });
    const moveStick = (e) => {
      if (e.pointerId !== stickId) return;
      let x = e.clientX - center.x;
      let y = e.clientY - center.y;
      const d = Math.hypot(x, y);
      if (d > radius) { x *= radius / d; y *= radius / d; }
      setKnob(x, y);
      this.stick.x = x / radius;
      this.stick.y = -y / radius;
    };
    stickEl.addEventListener('pointermove', moveStick);
    const endStick = (e) => {
      if (e.pointerId !== stickId) return;
      stickId = null;
      this.stick.x = this.stick.y = 0;
      setKnob(0, 0);
    };
    stickEl.addEventListener('pointerup', endStick);
    stickEl.addEventListener('pointercancel', endStick);

    // Drag anywhere on the canvas with a finger to nudge the camera.
    const looks = new Map();
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    canvas.addEventListener('pointermove', (e) => {
      const last = looks.get(e.pointerId);
      if (!last) return;
      this.look.dx += (e.clientX - last.x) * 1.6;
      this.look.dy += (e.clientY - last.y) * 1.6;
      this.lastLookInput = performance.now();
      last.x = e.clientX;
      last.y = e.clientY;
    });
    const endLook = (e) => looks.delete(e.pointerId);
    canvas.addEventListener('pointerup', endLook);
    canvas.addEventListener('pointercancel', endLook);

    root.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.actions.push(btn.dataset.action);
      });
    });
    const hold = (sel, prop) => {
      const el = root.querySelector(sel);
      if (!el) return;
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); this[prop] = true; el.classList.add('held'); });
      const off = () => { this[prop] = false; el.classList.remove('held'); };
      el.addEventListener('pointerup', off);
      el.addEventListener('pointercancel', off);
      el.addEventListener('pointerleave', off);
    };
    hold('[data-hold="up"]', 'touchUp');
    hold('[data-hold="down"]', 'touchDown');
    hold('[data-hold="sprint"]', 'touchSprint');
    hold('[data-hold="view"]', 'touchView');
  }

  // Movement intent in camera space: x strafe, y vertical, z forward.
  move() {
    const k = this.keys;
    let x = this.stick.x;
    let z = this.stick.y;
    let y = 0;
    if (k.has('KeyW')) z += 1;
    if (k.has('KeyS')) z -= 1;
    if (k.has('KeyA')) x -= 1;
    if (k.has('KeyD')) x += 1;
    if (k.has('Space') || this.touchUp) y += 1;
    if (k.has('KeyC') || k.has('ControlLeft') || this.touchDown) y -= 1;
    return { x, y, z };
  }

  sprinting() {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.touchSprint;
  }

  // Held for the wide overview from outside the sphere.
  overview() {
    return this.keys.has('Tab') || this.touchView;
  }

  // Arrow keys nudge the camera for keyboard-only play (when the wheel isn't open).
  keyLook(dt) {
    const k = this.keys;
    let yaw = 0;
    let pitch = 0;
    if (k.has('ArrowLeft')) yaw -= 1;
    if (k.has('ArrowRight')) yaw += 1;
    if (k.has('ArrowUp')) pitch += 1;
    if (k.has('ArrowDown')) pitch -= 1;
    if (yaw || pitch) this.lastLookInput = performance.now();
    return { yaw: yaw * dt * 1.6, pitch: pitch * dt * 1.2 };
  }

  consumeLook() {
    const l = { dx: this.look.dx, dy: this.look.dy };
    this.look.dx = this.look.dy = 0;
    return l;
  }

  consumeActions() {
    const a = this.actions;
    this.actions = [];
    return a;
  }
}
