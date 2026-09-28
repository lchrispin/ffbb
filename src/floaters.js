import * as THREE from './lib.js';

// FFX-style numbers that float over the action: duels ("AT 9 vs EN 7"), blocker cuts,
// the power tag that rides on a pass or shot, and status tags like Venom. They're DOM
// elements positioned from projected 3D points each frame, and age in real time.

const v = new THREE.Vector3();

export class Floaters {
  constructor(root, camera) {
    this.root = root;
    this.camera = camera;
    this.pops = [];
    this.tags = new Map();   // key -> { el, anchor, dy }
  }

  // anchor: anything with a .pos (player, ball) or a Vector3 (copied).
  pop(html, anchor, { tone = 'neutral', life = 1.8, dy = 2.1, size = 'md' } = {}) {
    const el = document.createElement('div');
    el.className = `fl fl-${size}`;
    el.dataset.tone = tone;
    el.innerHTML = html;
    this.root.append(el);
    const pos = anchor.pos ? anchor.pos : anchor.clone();
    this.pops.push({ el, pos, dy, life, age: 0 });
  }

  // A tag that stays put until cleared (ball power, Venom). Returns its element.
  tag(key, anchor, html, { tone = 'neutral', dy = 2.1, size = 'sm' } = {}) {
    let t = this.tags.get(key);
    if (!t) {
      const el = document.createElement('div');
      this.root.append(el);
      t = { el, html: null };
      this.tags.set(key, t);
    }
    t.el.className = `fl fl-tag fl-${size}`;
    t.el.dataset.tone = tone;
    t.anchor = anchor;
    t.dy = dy;
    if (t.html !== html) { t.html = html; t.el.innerHTML = html; }
    return t.el;
  }

  untag(key) {
    const t = this.tags.get(key);
    if (!t) return;
    t.el.remove();
    this.tags.delete(key);
  }

  clear() {
    for (const p of this.pops) p.el.remove();
    this.pops = [];
    for (const key of [...this.tags.keys()]) this.untag(key);
  }

  // Projects pos to the screen; returns { x, y } (bottom centre) or null when off screen.
  project(pos, dy, lift) {
    v.copy(pos);
    v.y += dy;
    v.project(this.camera);
    if (v.z > 1 || Math.abs(v.x) > 1.15 || Math.abs(v.y) > 1.15) return null;
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight - lift };
  }

  show(el, at) {
    el.style.visibility = at ? '' : 'hidden';
    if (at) el.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px) translate(-50%, -100%)`;
  }

  update(dt) {
    // Tags first: they're small and pinned, and the numbers make room around them.
    const placed = [];
    for (const t of this.tags.values()) {
      const at = this.project(t.anchor.pos || t.anchor, t.dy, 0);
      this.show(t.el, at);
      if (at) placed.push(this.box(t.el, at));
    }
    for (let i = 0; i < this.pops.length; i++) {
      const p = this.pops[i];
      p.age += dt;
      if (p.age >= p.life) {
        p.el.remove();
        this.pops.splice(i--, 1);
        continue;
      }
      const k = p.age / p.life;
      const at = this.project(p.pos, p.dy, Math.min(1, p.age * 3) * 18 + k * 12);
      if (at) {
        // Nudge up past anything already on screen so numbers never sit on top of each other.
        let b = this.box(p.el, at);
        for (let n = 0; n < 6; n++) {
          const hit = placed.find((o) => b.l < o.r && b.r > o.l && b.t < o.b && b.b > o.t);
          if (!hit) break;
          at.y -= b.b - hit.t + 2;
          b = this.box(p.el, at);
        }
        placed.push(b);
      }
      this.show(p.el, at);
      p.el.style.opacity = k > 0.75 ? String((1 - k) / 0.25) : '1';
    }
  }

  box(el, at) {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    return { l: at.x - w / 2, r: at.x + w / 2, t: at.y - h, b: at.y };
  }
}
