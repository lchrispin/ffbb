import * as THREE from './lib.js';
import { GOAL_X, GOAL_RING_R, BEAT, LEG_CAP, sideSign } from './config.js';
import { newOrder, cloneOrder, ACTIONS, tackleChance } from './match.js';
import { fixOrder, orderReach, passOdds, shotOdds, keepOdds, bestAim, clampInside } from './ai.js';

// Planning input and planning overlays: selecting swimmers, picking 3D points
// Homeworld-style (drag on the horizontal plane, Shift or the Height toggle to raise
// or lower), the order menu, and the risk readouts for passes and shots.

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

const COL = { path: 0x9ff3ff, sel: 0x7ff3ff, pass: 0xaef4ff, shot: 0xffd46a, tech: 0xff7a3a, mark: 0xffb347, press: 0xff6b5e, threat: 0xff4d4d, ok: 0x67e6a4, reach: 0x7fdcff, opp: 0xff9c8a };

export const ORDER_KEYS = {
  move: 'M', sprint: 'S', mark: 'K', hold: 'H', press: 'P',
  dribble: 'D', pass: 'A', through: 'T', shoot: 'G', tech: 'J',
};

const pct = (p) => `${Math.round(p * 100)}%`;
const aimName = (aim) => {
  if (!aim) return 'centre';
  const r = Math.hypot(aim.y, aim.z);
  if (r < 0.8) return 'centre';
  const v = aim.y > 0.7 ? 'top' : aim.y < -0.7 ? 'bottom' : '';
  const h = aim.z > 0.7 ? 'left' : aim.z < -0.7 ? 'right' : '';
  return [v, h].filter(Boolean).join('-') || 'centre';
};

// One-line description of an order, for the squad list, card and log.
export function describeOrder(m, u, o) {
  if (!o) return '—';
  const who = (id) => (m.units[id] ? m.units[id].name : '?');
  const sp = o.sprint ? ' · sprint' : '';
  switch (o.type) {
    case 'move': return `Move${sp}`;
    case 'dribble': return `Dribble${sp}`;
    case 'hold': return m.ball.owner === u ? 'Shield the ball' : 'Hold / brace';
    case 'press': return `Press${sp}`;
    case 'mark': return `Mark ${who(o.markId)}${sp}`;
    case 'pass': return `${o.timing === 'end' && o.target ? 'Dribble, then pass' : 'Pass'} → ${who(o.passTo)}`;
    case 'through': return `${o.timing === 'end' && o.target ? 'Dribble, then through ball' : 'Through ball'}`;
    case 'shoot': return `${o.timing === 'end' && o.target ? 'Dribble, then shoot' : 'Shoot'} · ${aimName(o.aim)}`;
    case 'tech': return `JECHT SHOT${o.timing === 'end' && o.target ? ' after dribble' : ''} · ${aimName(o.aim)}`;
    default: return o.type;
  }
}

export class PlanUI {
  constructor({ canvas, camera, rig, overlay, view, hud, onResolve, onChange }) {
    this.canvas = canvas;
    this.camera = camera;
    this.rig = rig;
    this.overlay = overlay;
    this.view = view;
    this.hud = hud;
    this.onResolve = onResolve;
    this.onChange = onChange || (() => {});
    this.active = false;
    this.m = null;
    this.team = 0;
    this.orders = [];
    this.auto = [];
    this.manual = [];
    this.sel = null;          // selected unit (own or inspected opponent)
    this.armed = null;        // order waiting for a click in the scene
    this.hover = null;
    this.heightMode = false;
    this.shift = false;
    this.drag = null;
    this.pointers = new Map();
    this.risk = null;
    this.dirty = true;
    this.bindPointer();
    this.bindKeys();
    this.bindButtons();
  }

  // ---------- lifecycle ----------

  start(m, team, auto) {
    this.m = m;
    this.team = team;
    this.auto = auto.map(cloneOrder);
    this.orders = auto.map(cloneOrder);
    this.manual = auto.map(() => false);
    this.armed = null;
    this.drag = null;
    this.active = true;
    const carrier = m.ball.owner && m.ball.owner.team === team ? m.ball.owner : null;
    if (!this.sel || this.sel.team !== team || !m.units.includes(this.sel)) this.sel = carrier || m.teams[team][2];
    if (carrier) this.sel = carrier;
    this.dirty = true;
    this.refreshBar();
    this.onChange();
  }

  stop() {
    this.active = false;
    this.armed = null;
    this.drag = null;
    this.hud.showRisk(null);
  }

  own(u) { return u && u.team === this.team; }
  isCarrier(u) { return this.m && this.m.ball.owner === u; }
  orderOf(u) { return this.orders[u.slotIndex]; }

  select(u) {
    if (!u) return;
    this.sel = u;
    this.armed = null;
    this.dirty = true;
    if (this.rig.follow) this.rig.focusOn(() => this.view.players[u.id].pos);
    this.refreshBar();
    this.onChange();
  }

  cycle(dir = 1) {
    const list = this.m.teams[this.team];
    const i = this.own(this.sel) ? this.sel.slotIndex : -1;
    this.select(list[(i + dir + list.length) % list.length]);
  }

  // Change the selected (or given) player's order.
  edit(fn, u = this.sel) {
    if (!this.own(u)) return;
    const o = cloneOrder(this.orders[u.slotIndex]);
    fn(o);
    fixOrder(this.m, u, o);
    o.auto = false;
    this.orders[u.slotIndex] = o;
    this.manual[u.slotIndex] = true;
    this.dirty = true;
    this.refreshBar();
    this.onChange();
  }

  setOrder(u, order) {
    this.edit((o) => { Object.keys(o).forEach((k) => delete o[k]); Object.assign(o, cloneOrder(order)); }, u);
  }

  resetAuto(which) {
    const list = which === 'all' ? this.m.teams[this.team] : [which || this.sel].filter((u) => this.own(u));
    for (const u of list) {
      this.orders[u.slotIndex] = cloneOrder(this.auto[u.slotIndex]);
      this.manual[u.slotIndex] = false;
    }
    this.armed = null;
    this.dirty = true;
    this.refreshBar();
    this.onChange();
  }

  // Apply one of the order buttons to the selected player.
  command(cmd) {
    const u = this.sel;
    if (!this.active || !this.own(u)) return;
    const carrier = this.isCarrier(u);
    const o = this.orderOf(u);
    const movePoint = () => (o.target ? o.target.clone() : u.pos.clone().add(tmp.subVectors(this.m.attackGoal(this.team), u.pos).setLength(4)));
    switch (cmd) {
      case 'move':
        if (carrier) return this.command('dribble');
        this.edit((x) => { x.type = 'move'; x.target = movePoint(); });
        this.armed = 'target';
        break;
      case 'sprint':
        this.edit((x) => {
          if (!['move', 'dribble', 'mark', 'press', 'pass', 'through', 'shoot', 'tech'].includes(x.type)) { x.type = carrier ? 'dribble' : 'move'; x.target = movePoint(); }
          x.sprint = !x.sprint;
        });
        break;
      case 'mark':
        if (carrier) return;
        this.armed = 'mark';
        break;
      case 'hold':
        this.edit((x) => { Object.assign(x, newOrder('hold')); });
        break;
      case 'press':
        if (carrier) return;
        this.edit((x) => { Object.assign(x, newOrder('press', { sprint: x.sprint })); });
        break;
      case 'dribble':
        if (!carrier) return this.command('move');
        this.edit((x) => { x.type = 'dribble'; x.target = movePoint(); x.passTo = -1; x.point = null; x.aim = null; });
        this.armed = 'target';
        break;
      case 'pass':
        if (!carrier) return;
        this.armed = 'pass';
        break;
      case 'through':
        if (!carrier) return;
        this.armed = 'through';
        break;
      case 'shoot':
      case 'tech': {
        if (!carrier) return;
        if (cmd === 'tech' && this.m.overdrive[this.team] < 1) return;
        const keep = o.type === 'shoot' || o.type === 'tech' ? o.aim : null;
        const aim = keep || bestAim(this.m, u, this.estimateFrom(u, o)).aim;
        this.edit((x) => { x.type = cmd; x.aim = { ...aim }; x.passTo = -1; x.point = null; });
        break;
      }
      case 'timing':
        if (!carrier || !ACTIONS.has(o.type)) return;
        this.edit((x) => {
          x.timing = x.timing === 'end' ? 'start' : 'end';
          if (x.timing === 'end' && !x.target) x.target = movePoint();
        });
        break;
      case 'height':
        this.heightMode = !this.heightMode;
        break;
      case 'auto':
        this.resetAuto(u);
        return;
      case 'autoall':
        this.resetAuto('all');
        return;
    }
    this.refreshBar();
  }

  // ---------- estimates ----------

  // Where and when a carrier's release happens under this order.
  estimateFrom(u, o) {
    if (o.timing === 'end' && o.target) {
      const d = u.pos.distanceTo(o.target);
      return { from: o.target, t0: Math.min(LEG_CAP * BEAT, d / u.speed(o.sprint, true)), awareness: 1 };
    }
    return { from: u.pos, t0: 0, awareness: 1 };
  }

  receivePoint(q) {
    const o = this.orders[q.slotIndex];
    const dest = o && o.target && (o.type === 'move') ? o.target : q.pos;
    const flight = q.pos.distanceTo(this.sel.pos) / 21;
    return q.pos.clone().lerp(dest, Math.min(1, flight / BEAT));
  }

  computeRisk() {
    const u = this.sel;
    this.risk = null;
    if (!this.own(u)) return;
    const o = this.orderOf(u);
    const m = this.m;
    if (this.isCarrier(u)) {
      const est = this.estimateFrom(u, o);
      const keep = o.timing === 'end' && o.target ? keepOdds(m, u, u.pos, o.target) : 1;
      if (o.type === 'pass' && m.units[o.passTo]) {
        const q = m.units[o.passTo];
        const to = this.receivePoint(q);
        const r = passOdds(m, u, to, { ...est, samples: 400 });
        this.risk = { kind: 'pass', from: est.from, to, r, keep, p: r.p * keep, q };
      } else if (o.type === 'through' && o.point) {
        const r = passOdds(m, u, o.point, { ...est, samples: 400 });
        this.risk = { kind: 'through', from: est.from, to: o.point, r, keep, p: r.p * keep };
      } else if ((o.type === 'shoot' || o.type === 'tech') && o.aim) {
        const special = o.type === 'tech';
        const r = shotOdds(m, u, o.aim, { ...est, special, samples: 600 });
        const to = new THREE.Vector3(sideSign(this.team) * GOAL_X, o.aim.y, o.aim.z);
        this.risk = { kind: special ? 'tech' : 'shot', from: est.from, to, r, keep, p: r.p * keep };
      } else if (o.type === 'dribble' && o.target) {
        this.risk = { kind: 'dribble', keep: keepOdds(m, u, u.pos, o.target), p: keepOdds(m, u, u.pos, o.target) };
      } else if (o.type === 'hold') {
        this.risk = { kind: 'dribble', keep: keepOdds(m, u, u.pos, u.pos), p: keepOdds(m, u, u.pos, u.pos) };
      }
    } else if (o.type === 'press' && m.ball.owner && m.ball.owner.team !== this.team) {
      const c = m.ball.owner;
      const t = tackleChance(u, c);
      const reach = u.reach(o.sprint) + 2;
      this.risk = { kind: 'press', t, c, inReach: u.pos.distanceTo(c.pos) <= reach };
    }
  }

  // ---------- drawing ----------

  frame() {
    if (!this.active) return;
    const m = this.m;
    const ov = this.overlay;
    if (this.dirty) {
      this.computeRisk();
      this.hud.showRisk(this.risk, this);
      this.dirty = false;
    }
    const teamCol = '#' + new THREE.Color(m.teamDefs[this.team].color).getHexString();
    const colors = this.view.colorsOf(this.team);

    // Every own player's plan: path arrow and a faint ghost at the destination.
    for (const u of m.teams[this.team]) {
      const o = this.orderOf(u);
      const isSel = u === this.sel;
      const from = u.pos;
      const faint = isSel ? 1 : 0.55;
      if (o.target && o.type !== 'mark' && o.type !== 'press') {
        const legColor = this.isCarrier(u) ? COL.shot : o.sprint ? COL.tech : COL.path;
        ov.arrow(from, o.target, legColor, isSel ? 0.08 : 0.05, 0.9 * faint);
        const face = tmp.subVectors(o.target, from);
        if (face.lengthSq() < 0.01) face.copy(u.facing);
        ov.ghost(u, colors, o.target, face.normalize(), isSel ? 0.42 : 0.2);
        ov.beam(o.target, tmp2.set(o.target.x, 0, o.target.z), teamCol, 0.025, 0.5 * faint);
        ov.ring(tmp2, 0.45, teamCol, 0.7 * faint, 0.1);
      }
      if (o.type === 'mark' && m.units[o.markId]) {
        const q = m.units[o.markId];
        ov.dashes(from, q.pos, COL.mark, 0.05, 0.8 * faint);
        ov.ring(q.pos, 1.3, COL.mark, 0.8 * faint, 0.1);
      }
      if (o.type === 'press') {
        const c = m.ball.owner && m.ball.owner.team !== this.team ? m.ball.owner : null;
        const at = c ? c.pos : m.ball.pos;
        ov.arrow(from, at, COL.press, 0.07, 0.85 * faint);
      }
      if (o.type === 'hold') ov.ring(u.pos, u.zoc(true), COL.ok, 0.55 * faint, 0.08);
      if (o.type === 'pass' && m.units[o.passTo]) {
        const q = m.units[o.passTo];
        const start = o.timing === 'end' && o.target ? o.target : u.pos;
        ov.dashes(start, this.receivePoint(q), COL.pass, 0.07, 0.95);
        ov.ring(q.pos, 1.1, COL.pass, 0.9, 0.12);
      }
      if (o.type === 'through' && o.point) {
        const start = o.timing === 'end' && o.target ? o.target : u.pos;
        ov.dashes(start, o.point, COL.pass, 0.07, 0.95);
        ov.dot(o.point, 0.35, COL.pass, 0.95);
        ov.beam(o.point, tmp2.set(o.point.x, 0, o.point.z), COL.pass, 0.025, 0.5);
      }
      if ((o.type === 'shoot' || o.type === 'tech') && o.aim) {
        const start = o.timing === 'end' && o.target ? o.target : u.pos;
        const aim = tmp2.set(sideSign(this.team) * GOAL_X, o.aim.y, o.aim.z);
        ov.dashes(start, aim, o.type === 'tech' ? COL.tech : COL.shot, 0.08, 1);
        ov.ring(aim, 0.45, o.type === 'tech' ? COL.tech : COL.shot, 1, 0.12);
      }
    }

    // Selected player: reach sphere, movement disc at the target height, drop-lines.
    const u = this.sel;
    if (u) {
      const own = this.own(u);
      ov.ring(u.pos, 1.25, own ? COL.sel : COL.opp, 1, 0.12);
      if (own) {
        const o = this.orderOf(u);
        const r = orderReach(m, u, o);
        ov.sphere(u.pos, r, COL.reach, 0.32);
        const h = o.target ? o.target.y : u.pos.y;
        const discR = Math.sqrt(Math.max(0, r * r - (h - u.pos.y) ** 2));
        ov.disc(tmp.set(u.pos.x, h, u.pos.z), discR, COL.reach, this.drag ? 0.14 : 0.07);
        ov.ring(u.pos, u.zoc(o.type === 'hold'), teamCol, 0.5, 0.06);
      } else {
        ov.sphere(u.pos, u.reach(true), COL.opp, 0.3);
        ov.ring(u.pos, u.zoc(), COL.opp, 0.7, 0.07);
      }
    }
    // Hovered opponent: faint reach sphere and zone.
    if (this.hover && !this.own(this.hover) && this.hover !== u) {
      ov.sphere(this.hover.pos, this.hover.reach(true), COL.opp, 0.3);
      ov.ring(this.hover.pos, this.hover.zoc(), COL.opp, 0.6, 0.07);
    }
    // Threats to a planned pass or shot.
    if (this.risk && this.risk.r && this.risk.r.threats) {
      for (const th of this.risk.r.threats) {
        const q = th.q;
        const a = 0.35 + th.p * 0.6;
        ov.ring(q.pos, 1.5, COL.threat, a, 0.14);
        ov.ring(q.pos, q.zoc(), COL.threat, a * 0.8, 0.07);
        ov.dashes(q.pos, th.point, COL.threat, 0.035, a * 0.8, 0.4);
        ov.dot(th.point, 0.22, COL.threat, a);
      }
    }
    if (this.armed === 'mark' || this.armed === 'pass') {
      const list = this.armed === 'mark' ? m.teams[1 - this.team] : m.teams[this.team].filter((q) => q !== u);
      for (const q of list) ov.ring(q.pos, 1.6, this.armed === 'mark' ? COL.mark : COL.pass, 0.5 + Math.sin(performance.now() / 150) * 0.3, 0.1);
    }
  }

  // ---------- the order bar ----------

  bindButtons() {
    document.querySelectorAll('[data-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => this.command(btn.dataset.cmd));
    });
    document.getElementById('resolve').addEventListener('click', () => this.active && this.onResolve());
  }

  refreshBar() {
    const u = this.sel;
    const m = this.m;
    if (!m) return;
    const own = this.own(u);
    const carrier = own && this.isCarrier(u);
    const o = own ? this.orderOf(u) : null;
    const set = (cmd, enabled, on = false) => {
      const b = document.querySelector(`[data-cmd="${cmd}"]`);
      if (!b) return;
      b.disabled = !enabled;
      b.classList.toggle('on', on);
      b.hidden = false;
    };
    const t = o ? o.type : '';
    set('move', own && !carrier, t === 'move');
    set('sprint', own && t !== 'hold', !!(o && o.sprint));
    set('mark', own && !carrier, t === 'mark' || this.armed === 'mark');
    set('hold', own, t === 'hold');
    set('press', own && !carrier, t === 'press');
    set('dribble', carrier, t === 'dribble');
    set('pass', carrier, t === 'pass' || this.armed === 'pass');
    set('through', carrier, t === 'through' || this.armed === 'through');
    set('shoot', carrier, t === 'shoot');
    set('tech', carrier && m.overdrive[this.team] >= 1, t === 'tech');
    set('timing', carrier && ACTIONS.has(t), o && o.timing === 'end');
    set('height', own, this.heightMode);
    set('auto', own && this.manual[u.slotIndex]);
    set('autoall', this.manual.some(Boolean));
    const timing = document.querySelector('[data-cmd="timing"] .lbl');
    if (timing) timing.textContent = o && o.timing === 'end' ? 'After dribble' : 'At start';
    document.getElementById('orderbar').dataset.carrier = carrier ? '1' : '0';
    let hint = '';
    if (!own) hint = u ? `${u.name} is an opponent · their orders stay hidden until the beat resolves` : 'Select a player';
    else if (this.armed === 'mark') hint = 'Click an opponent to mark';
    else if (this.armed === 'pass') hint = 'Click a teammate to pass to, or a point in space for a through ball';
    else if (this.armed === 'through') hint = 'Click or drag to a point in space for the through ball (Shift or Height to raise/lower)';
    else if (this.armed === 'target') hint = 'Click or drag to set the destination · Shift or Height to raise/lower';
    else hint = `${describeOrder(m, u, o)} · drag from ${u.name} to move${carrier ? ' (dribble)' : ''}, Shift-drag for height`;
    this.hud.setHint(hint);
  }

  // ---------- picking ----------

  toNdc(e) {
    const r = this.canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    return ndc;
  }

  // Swimmer nearest the pointer on screen, within a finger's width.
  pickUnit(e, filter) {
    if (!this.m) return null;
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    let best = null;
    let bd = e.pointerType === 'touch' ? 34 : 24;
    for (const u of this.m.units) {
      if (filter && !filter(u)) continue;
      const p = this.view.players[u.id].pos;
      tmp.copy(p).project(this.camera);
      if (tmp.z > 1) continue;
      const sx = (tmp.x * 0.5 + 0.5) * r.width;
      const sy = (-tmp.y * 0.5 + 0.5) * r.height;
      const d = Math.hypot(sx - px, sy - py);
      if (d < bd) { bd = d; best = u; }
    }
    return best;
  }

  // Point on the horizontal plane at height y under the pointer.
  planePoint(e, y) {
    ray.setFromCamera(this.toNdc(e), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
    const out = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, out)) {
      // Looking along the plane: fall back to a point in front of the camera.
      out.copy(ray.ray.origin).addScaledVector(ray.ray.direction, 20);
      out.y = y;
    }
    return out;
  }

  // ---------- pointer ----------

  bindPointer() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('pointercancel', (e) => this.up(e));
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.rig.zoom(Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
  }

  down(e) {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* optional */ }
    if (this.pointers.size === 2) {
      // Second finger: pinch to zoom, cancel whatever the first started.
      this.drag = { kind: 'pinch', d: this.pinchDist() };
      return;
    }
    const orbitOnly = !this.active || e.button === 2 || e.button === 1;
    if (orbitOnly) { this.drag = { kind: 'orbit', x: e.clientX, y: e.clientY }; return; }
    const m = this.m;
    const u = this.sel;
    const picked = this.pickUnit(e);
    const start = { x: e.clientX, y: e.clientY, t: performance.now() };

    if (this.armed === 'mark') {
      if (picked && !this.own(picked)) {
        this.edit((o) => { Object.assign(o, newOrder('mark', { markId: picked.id, sprint: o.sprint })); });
        this.armed = null;
        this.refreshBar();
        return;
      }
    }
    if (this.armed === 'pass' && picked && this.own(picked) && picked !== u) {
      this.edit((o) => { o.type = 'pass'; o.passTo = picked.id; o.point = null; o.aim = null; });
      this.armed = null;
      this.refreshBar();
      return;
    }
    if ((this.armed === 'pass' || this.armed === 'through') && this.own(u) && (!picked || picked === u)) {
      const o = this.orderOf(u);
      const base = o.timing === 'end' && o.target ? o.target : u.pos;
      this.drag = { kind: 'point', ...start, y0: base.y, baseY: base.y, last: null };
      this.updatePoint(e);
      return;
    }
    if (this.own(u) && (picked === u || (this.armed === 'target' && !picked))) {
      // The movement disc starts at the player's own height; Shift moves it up or down.
      this.drag = { kind: 'target', ...start, baseY: u.pos.y, moved: false };
      if (this.armed === 'target') this.updateTarget(e);
      return;
    }
    if (picked) {
      this.drag = { kind: 'select', unit: picked, ...start };
      return;
    }
    this.drag = { kind: 'orbit', x: e.clientX, y: e.clientY, click: true, t: start.t };
  }

  move(e) {
    const prev = this.pointers.get(e.pointerId);
    if (prev) { prev.px = prev.x; prev.py = prev.y; prev.x = e.clientX; prev.y = e.clientY; }
    const d = this.drag;
    if (!d) {
      if (e.pointerType === 'mouse' && this.active) {
        const h = this.pickUnit(e);
        if (h !== this.hover) { this.hover = h; this.canvas.style.cursor = h ? 'pointer' : ''; }
      }
      return;
    }
    if (d.kind === 'pinch') {
      const nd = this.pinchDist();
      if (nd > 0 && d.d > 0) this.rig.zoom(d.d / nd);
      d.d = nd;
      return;
    }
    if (d.kind === 'orbit') {
      this.rig.rotate(e.clientX - d.x, e.clientY - d.y);
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 2) d.click = false;
      d.x = e.clientX;
      d.y = e.clientY;
      return;
    }
    if (d.kind === 'select') {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 && d.unit === this.sel && this.own(d.unit)) {
        this.drag = { kind: 'target', x: d.x, y: d.y, moved: true, baseY: d.unit.pos.y };
      }
      return;
    }
    if (d.kind === 'target') this.updateTarget(e);
    if (d.kind === 'point') this.updatePoint(e);
  }

  up(e) {
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (this.pointers.size > 0 && d && d.kind === 'pinch') { this.drag = null; return; }
    this.drag = null;
    if (!d) return;
    if (d.kind === 'select') { this.select(d.unit); return; }
    if (d.kind === 'target') {
      if (this.armed === 'target') this.armed = null;
      this.refreshBar();
      return;
    }
    if (d.kind === 'point') {
      if (d.last) {
        const pt = d.last.clone();
        this.edit((o) => { o.type = 'through'; o.point = pt; o.passTo = -1; o.aim = null; });
      }
      this.armed = null;
      this.refreshBar();
      return;
    }
    if (d.kind === 'orbit' && d.click && this.armed) {
      this.armed = null;
      this.refreshBar();
    }
  }

  pinchDist() {
    const ps = [...this.pointers.values()];
    return ps.length < 2 ? 0 : Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
  }

  heightActive() { return this.shift || this.heightMode; }

  // Homeworld-style: the pointer moves the point on its horizontal plane; with height
  // active, vertical pointer motion raises or lowers it instead.
  dragPoint(e, d, current) {
    let p;
    if (this.heightActive() && current) {
      const scale = this.camera.position.distanceTo(current) * 0.0028;
      if (d.hy == null) { d.hy = e.clientY; d.hy0 = current.y; }
      p = current.clone();
      p.y = d.hy0 + (d.hy - e.clientY) * scale;
      d.baseY = p.y;
    } else {
      d.hy = null;
      p = this.planePoint(e, d.baseY);
    }
    return p;
  }

  updateTarget(e) {
    const u = this.sel;
    const d = this.drag;
    // A plain click on the selected player shouldn't move their target.
    if (!this.armed && !d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    d.moved = true;
    const o = this.orderOf(u);
    const cur = o.target ? o.target.clone() : new THREE.Vector3(u.pos.x, d.baseY, u.pos.z);
    const p = this.dragPoint(e, d, cur);
    const carrier = this.isCarrier(u);
    this.edit((x) => {
      if (!['move', 'dribble', 'pass', 'through', 'shoot', 'tech'].includes(x.type)) {
        x.type = carrier ? 'dribble' : 'move';
        x.markId = -1;
      }
      x.target = p;
    });
  }

  updatePoint(e) {
    const d = this.drag;
    const cur = d.last || null;
    const p = this.dragPoint(e, d, this.heightActive() ? cur : null);
    clampInside(p, 1.5);
    if (p.distanceTo(this.sel.pos) > 45) p.sub(this.sel.pos).setLength(45).add(this.sel.pos);
    d.last = p;
    // Preview the through ball while dragging.
    this.edit((o) => { o.type = 'through'; o.point = p.clone(); o.passTo = -1; o.aim = null; });
  }

  // ---------- keyboard ----------

  bindKeys() {
    const map = {
      KeyM: 'move', KeyS: 'sprint', KeyK: 'mark', KeyH: 'hold', KeyP: 'press',
      KeyD: 'dribble', KeyA: 'pass', KeyT: 'through', KeyG: 'shoot', KeyJ: 'tech',
      KeyL: 'timing', KeyV: 'height',
    };
    addEventListener('keydown', (e) => {
      if (e.key === 'Shift') { this.shift = true; this.hud.setHeightKey(true); }
      if (!this.active || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (document.querySelector('.overlay:not([hidden])')) return;
      // Keys handled here must not also reach the game's own shortcuts (Space would
      // resolve the beat and then skip its playback).
      const done = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      if (e.code === 'Tab') { done(); this.cycle(e.shiftKey ? -1 : 1); return; }
      if (e.code === 'Space' || e.code === 'Enter') { done(); this.onResolve(); return; }
      if (e.code === 'Escape' && this.armed) { done(); this.armed = null; this.refreshBar(); return; }
      if (e.code === 'KeyU') { done(); this.resetAuto(e.shiftKey ? 'all' : this.sel); return; }
      if (/^Digit[1-6]$/.test(e.code)) { done(); this.select(this.m.teams[this.team][+e.code.slice(5) - 1]); return; }
      if (map[e.code] && !e.ctrlKey && !e.metaKey) { done(); this.command(map[e.code]); }
    });
    addEventListener('keyup', (e) => { if (e.key === 'Shift') { this.shift = false; this.hud.setHeightKey(false); } });
    addEventListener('blur', () => { this.shift = false; });
  }
}

// Goal-view inset: the ring face as the shooter sees it, a success heat map, the
// keeper, and the aim point. Clicking sets the aim.
export class GoalView {
  constructor(canvas, onAim) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onAim = onAim;
    this.heat = null;
    this.key = '';
    const pick = (e) => {
      if (!this.state) return;
      const r = canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 2 - 1;
      const y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      const R = GOAL_RING_R * 1.15;
      let az = x * R;
      const ay = y * R;
      az *= this.state.s; // screen right is +z when attacking +x
      this.onAim({ y: ay, z: az });
    };
    let down = false;
    canvas.addEventListener('pointerdown', (e) => { down = true; canvas.setPointerCapture(e.pointerId); pick(e); });
    canvas.addEventListener('pointermove', (e) => { if (down) pick(e); });
    canvas.addEventListener('pointerup', () => { down = false; });
  }

  // Heat map of goal chance over the ring face, recomputed when the situation changes.
  draw(m, u, o, est) {
    const s = sideSign(u.team);
    this.state = { s };
    const special = o.type === 'tech';
    const key = `${u.id}|${est.from.x.toFixed(2)},${est.from.y.toFixed(2)},${est.from.z.toFixed(2)}|${est.t0.toFixed(2)}|${special}|${m.beat}|${m.half}`;
    const N = 11;
    const R = GOAL_RING_R * 1.15;
    if (key !== this.key) {
      this.key = key;
      this.heat = [];
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const z = ((i + 0.5) / N * 2 - 1) * R * s;
          const y = -((j + 0.5) / N * 2 - 1) * R;
          if (Math.hypot(y, z) > GOAL_RING_R) { this.heat.push(-1); continue; }
          this.heat.push(shotOdds(m, u, { y, z }, { ...est, special, samples: 36 }).p);
        }
      }
    }
    const c = this.ctx;
    const W = this.canvas.width;
    const sc = W / 2 / R;
    c.clearRect(0, 0, W, W);
    c.save();
    c.fillStyle = 'rgba(3,16,25,0.85)';
    c.fillRect(0, 0, W, W);
    const cell = W / N;
    const top = Math.max(0.05, ...this.heat);
    this.heat.forEach((p, k) => {
      if (p < 0) return;
      const i = k % N;
      const j = Math.floor(k / N);
      const t = Math.min(1, p / top);
      c.fillStyle = `rgba(${Math.round(255 - 150 * t)},${Math.round(80 + 150 * t)},${Math.round(90 + 40 * t)},${0.25 + 0.5 * t})`;
      c.fillRect(i * cell, j * cell, cell + 0.5, cell + 0.5);
    });
    c.translate(W / 2, W / 2);
    c.strokeStyle = '#e8b64a';
    c.lineWidth = 5;
    c.beginPath();
    c.arc(0, 0, GOAL_RING_R * sc, 0, Math.PI * 2);
    c.stroke();
    // Keeper, seen from the shooter's side.
    const k = m.keepers[1 - u.team];
    const kx = k.pos.z * s * sc;
    const ky = -k.pos.y * sc;
    c.fillStyle = '#' + new THREE.Color(m.teamDefs[k.team].color).getHexString();
    c.globalAlpha = 0.9;
    c.beginPath();
    c.arc(kx, ky, k.catchR() * sc, 0, Math.PI * 2);
    c.globalAlpha = 0.25;
    c.fill();
    c.globalAlpha = 1;
    c.lineWidth = 2;
    c.strokeStyle = c.fillStyle;
    c.stroke();
    c.beginPath();
    c.arc(kx, ky, 7, 0, Math.PI * 2);
    c.fill();
    if (o.aim) {
      const ax = o.aim.z * s * sc;
      const ay = -o.aim.y * sc;
      c.strokeStyle = special ? '#ff7a3a' : '#ffffff';
      c.lineWidth = 3;
      c.beginPath();
      c.arc(ax, ay, est.wobble * sc, 0, Math.PI * 2);
      c.setLineDash([6, 5]);
      c.stroke();
      c.setLineDash([]);
      c.beginPath();
      c.moveTo(ax - 10, ay); c.lineTo(ax + 10, ay);
      c.moveTo(ax, ay - 10); c.lineTo(ax, ay + 10);
      c.stroke();
    }
    c.restore();
  }
}

