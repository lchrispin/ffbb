import * as THREE from './lib.js';
import {
  SPHERE_R, PLAYER_MARGIN, GOAL_X, GOAL_RING_R, TEAMS, SLOTS, sideSign,
  BEAT, TICK, KICKOFF_LAUNCH, LEG_CAP,
  SPEED_BASE, SPEED_SP, SPRINT_MULT, CARRY_MULT, MARKED_MULT, TIRED_AT,
  HP_SPRINT, HP_CARRY, HP_REST, HP_HOLD,
  PASS_SPEED, SHOT_SPEED, CATCH_DIST, PICKUP_DIST, REFLEX_DIST, TACKLE_RANGE, TACKLE_BASE,
  ZOC_BASE, ZOC_BL, BRACE_MULT, BRACE_CUT, LUNGE_REACH, LUNGE_REACT,
  PASS_MULT, PASS_BASE, PASS_DECAY, PASS_CUT, CUT_SPREAD,
  SHOT_MULT, SHOT_BASE, SHOT_DECAY, SHOT_CUT, SPECIAL_MULT, GRIP_MULT, GRIP_SPREAD,
  KEEPER_CATCH, KEEPER_DIVE, KEEPER_REACT, STRETCH, FINGERTIP, WOBBLE, OVERDRIVE,
  CHANGES_PER_HALF, SUBS_PER_MATCH,
} from './config.js';

// The rules engine. It knows nothing about rendering: a beat is resolved in one go
// into a list of frames and events, which the view then plays back.

const V = THREE.Vector3;
const v1 = new V();
const v2 = new V();
const clamp = THREE.MathUtils.clamp;

// Small seeded generator so a match can be replayed from its seed.
export function rng32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ACTIONS = new Set(['pass', 'through', 'shoot', 'tech']);
export const BALL_STATES = ['loose', 'held', 'pass', 'shot'];

// One order per player per beat. target is the move/dribble destination; for a carrier
// action it is the optional dribble leg (timing 'end') or the run after release ('start').
export function newOrder(type = 'hold', o = {}) {
  return { type, target: null, sprint: false, markId: -1, passTo: -1, point: null, aim: null, timing: 'start', ...o };
}

export function cloneOrder(o) {
  if (!o) return newOrder();
  return {
    ...o,
    target: o.target ? o.target.clone() : null,
    point: o.point ? o.point.clone() : null,
    aim: o.aim ? { ...o.aim } : null,
  };
}

// Aim wobble radius on the goal plane.
export function wobbleR(sh, dist, special) {
  return Math.max(0.25, WOBBLE[0] - sh * WOBBLE[1]) * (WOBBLE[2] + dist / WOBBLE[3]) * (special ? 0.4 : 1);
}

export function tackleChance(q, c) {
  const at = q.stat('AT');
  const en = c.stat('EN') + (c.role === 'target' ? 2 : 0);
  return { at, en, chance: clamp(TACKLE_BASE + (at - en) * 0.05 + (1 - c.fit) * 0.3, 0.1, 0.9) };
}

export class Unit {
  constructor(team, slotIndex, def, statScale) {
    this.team = team;
    this.slotIndex = slotIndex;
    this.id = team * 6 + slotIndex;
    this.slot = SLOTS[slotIndex];
    this.statScale = statScale;
    this.role = 'support';
    this.pos = new V();
    this.vel = new V();
    this.facing = new V(sideSign(team), 0, 0);
    this.stun = 0;
    this.lunge = 0;
    this.grabCd = 0;
    this.order = newOrder();
    this.setDef(def, def.HP);
  }

  setDef(def, hp) {
    this.def = def;
    this.name = def.name;
    this.maxHp = def.HP;
    this.hp = hp;
  }

  get isKeeper() { return this.slot === 'GK'; }
  get fit() { return this.hp / this.maxHp; }

  // Tired swimmers lose reach and duel strength below TIRED_AT of their HP.
  fatigue() {
    const f = this.fit;
    return f >= TIRED_AT ? 1 : 0.7 + (f / TIRED_AT) * 0.3;
  }

  base(k) { return this.def[k] * this.statScale; }
  stat(k) { return this.base(k) * this.fatigue(); }

  speed(sprint = false, carrying = false) {
    let s = (SPEED_BASE + this.base('SP') * SPEED_SP) * this.fatigue();
    if (carrying) s *= CARRY_MULT;
    if (sprint && this.hp > 5) s *= SPRINT_MULT;
    return s;
  }

  reach(sprint = false, carrying = false) { return this.speed(sprint, carrying) * BEAT; }
  zoc(braced = false) { return (ZOC_BASE + this.base('BL') * ZOC_BL) * this.fatigue() * (braced ? BRACE_MULT : 1); }
  catchR() { return KEEPER_CATCH[0] + this.base('CA') * KEEPER_CATCH[1]; }
}

// Formation spot in world space for the kickoff (everyone in their own half).
export function kickoffSpot(tac, slot, team, out = new V()) {
  const s = sideSign(team);
  let [x, y, z] = tac.base[slot];
  if (slot !== 'GK') x = Math.min(x * 0.6, -4);
  out.set(x * s, y, z * s);
  const lim = SPHERE_R - 3;
  if (out.length() > lim) out.setLength(lim);
  return out;
}

export class Match {
  constructor({ teamIds, statScales = [1, 1], beatsPerHalf = 18, tactics, seed = (Math.random() * 2 ** 31) | 0, record = true }) {
    this.teamDefs = teamIds.map((id) => TEAMS[id]);
    this.seed = seed;
    this.rng = rng32(seed);
    this.record = record;
    this.tactics = tactics;
    this.beatsPerHalf = beatsPerHalf;
    this.units = [];
    this.teams = [[], []];
    this.teamDefs.forEach((td, t) => {
      td.players.forEach((def, i) => {
        const u = new Unit(t, i, def, statScales[t]);
        this.teams[t].push(u);
        this.units.push(u);
      });
    });
    this.keepers = this.teams.map((ps) => ps.find((p) => p.isKeeper));
    this.bench = this.teamDefs.map((td) => td.bench.map((def) => ({ def, hp: def.HP, used: false })));
    this.ball = {
      pos: new V(), vel: new V(), state: 'loose', owner: null, target: null, point: null,
      power: 0, special: false, knockouts: 0, tried: new Set(), travelled: 0, launching: false,
      lastTouch: null, shotT: 0, shotTeam: -1,
    };
    this.score = [0, 0];
    this.half = 1;
    this.beat = 0;
    this.phase = 'play';
    this.overdrive = [0, 0];
    this.stats = [0, 1].map(() => ({
      shots: 0, onTarget: 0, goals: 0, saves: 0, blocks: 0, deflects: 0, intercepts: 0, wide: 0,
      tackles: 0, passes: 0, passAtt: 0, possession: 0,
    }));
    this.changesLeft = [CHANGES_PER_HALF, CHANGES_PER_HALF];
    this.subsLeft = [SUBS_PER_MATCH, SUBS_PER_MATCH];
    this.history = [];
    this.applyRoles();
    this.setupKickoff();
  }

  rand(a = 0, b = 1) { return a + this.rng() * (b - a); }

  ownGoal(team) { return new V(-sideSign(team) * GOAL_X, 0, 0); }
  attackGoal(team) { return this.ownGoal(1 - team); }

  // Football-style clock: 45 minutes a half, spread over the half's beats.
  minute(beat = this.beat) {
    return Math.round((this.half - 1) * 45 + Math.min(1, beat / this.beatsPerHalf) * 45);
  }

  setTactics(team, tac) {
    this.tactics[team] = tac;
    this.applyRoles();
  }

  applyRoles() {
    for (const u of this.units) u.role = u.isKeeper ? 'keeper' : (this.tactics[u.team].roles[u.slot] || 'support');
  }

  substitute(team, slotIndex, benchIndex) {
    const b = this.bench[team][benchIndex];
    const u = this.teams[team][slotIndex];
    if (!b || b.used || this.subsLeft[team] <= 0 || u.isKeeper) return false;
    const out = { def: u.def, hp: u.hp, used: true };
    u.setDef(b.def, b.hp);
    this.bench[team][benchIndex] = out;
    this.subsLeft[team]--;
    this.history.push({ type: 'sub', team, text: `${this.teamDefs[team].short} sub: ${u.name} on for ${out.def.name}`, minute: this.minute() });
    return true;
  }

  setupKickoff() {
    const b = this.ball;
    for (const u of this.units) {
      kickoffSpot(this.tactics[u.team], u.slot, u.team, u.pos);
      u.vel.set(0, 0, 0);
      u.facing.set(sideSign(u.team), 0, 0);
      u.stun = 0;
      u.grabCd = 0;
    }
    b.owner = null;
    b.state = 'loose';
    b.target = null;
    b.point = null;
    b.special = false;
    b.launching = false;
    b.lastTouch = null;
    b.vel.set(0, 0, 0);
    b.pos.set(0, -SPHERE_R + 1.2, 0);
    this.kickoffPending = true;
  }

  startSecondHalf() {
    this.half = 2;
    this.beat = 0;
    this.phase = 'play';
    this.changesLeft = [CHANGES_PER_HALF, CHANGES_PER_HALF];
    for (const u of this.units) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * 0.3);
    this.setupKickoff();
  }

  // ---------- beat resolution ----------

  resolveBeat(orders) {
    const b = this.ball;
    const rec = {
      frames: [], events: [], half: this.half, beat: this.beat,
      scoreBefore: [...this.score], minuteBefore: this.minute(), goal: null,
      orders: orders.map((os) => os.map(cloneOrder)),
      start: this.units.map((u) => u.pos.clone()),
    };
    this.rec = rec;
    this.t = 0;
    this.dead = false;
    this.goalAt = -1;
    this.applyRoles();
    const carrier0 = b.owner;
    for (const u of this.units) {
      u.order = cloneOrder(orders[u.team] && orders[u.team][u.slotIndex]);
      u.order.done = false;
      u.order.actor = u === carrier0;
      u.triedTackle = false;
    }
    this.recordFrame();
    const n = Math.round(BEAT / TICK);
    for (let i = 1; ; i++) {
      this.t = i * TICK;
      this.step();
      this.recordFrame();
      if (this.goalAt >= 0 ? this.t - this.goalAt >= 1.5 : i >= n) break;
    }
    rec.duration = this.t;
    this.beat++;
    if (this.goalAt >= 0) this.setupKickoff();
    if (this.beat >= this.beatsPerHalf) {
      this.phase = this.half === 1 ? 'halftime' : 'fulltime';
      this.event(this.phase, this.half === 1 ? 'Half time' : 'Full time', -1, null, rec.duration);
    }
    rec.scoreAfter = [...this.score];
    for (const e of rec.events) this.history.push({ ...e, minute: rec.minuteBefore });
    return rec;
  }

  event(type, text, team, pos, t = this.t, extra = {}) {
    const e = { t, type, text, team, pos: pos ? [pos.x, pos.y, pos.z] : null, ...extra };
    this.rec.events.push(e);
    return e;
  }

  recordFrame() {
    if (!this.record) return;
    const f = new Float32Array(12 * 8 + 6);
    for (const u of this.units) {
      const k = u.id * 8;
      f[k] = u.pos.x; f[k + 1] = u.pos.y; f[k + 2] = u.pos.z;
      f[k + 3] = u.facing.x; f[k + 4] = u.facing.y; f[k + 5] = u.facing.z;
      f[k + 6] = u.stun; f[k + 7] = u.lunge;
    }
    const b = this.ball;
    const k = 96;
    f[k] = b.pos.x; f[k + 1] = b.pos.y; f[k + 2] = b.pos.z;
    f[k + 3] = BALL_STATES.indexOf(b.state);
    f[k + 4] = b.owner ? b.owner.id : -1;
    f[k + 5] = b.special ? 1 : 0;
    this.rec.frames.push(f);
  }

  step() {
    const b = this.ball;
    if (this.kickoffPending && this.t >= KICKOFF_LAUNCH) {
      this.kickoffPending = false;
      b.vel.set(this.rand(-1.2, 1.2), 17, this.rand(-1.2, 1.2));
      b.launching = true;
      this.event('launch', 'Kickoff: the ball launches from the floor of the sphere', -1, b.pos);
    }
    if (!this.dead) this.carrierAction();
    // Everyone decides from the same snapshot, then everyone moves, so neither side
    // gets to react to the other's move within a tick.
    for (const u of this.units) this.steer(u);
    for (const u of this.units) {
      u.vel.copy(u.nextVel);
      u.pos.addScaledVector(u.vel, TICK);
      this.clampUnit(u);
    }
    this.separate();
    if (!this.dead) this.tackles();
    this.stepBall();
    if (b.owner) this.stats[b.owner.team].possession += TICK;
  }

  carrierAction() {
    const c = this.ball.owner;
    if (!c) return;
    const o = c.order;
    if (!o.actor || o.done || !ACTIONS.has(o.type)) return;
    if (o.timing === 'end' && o.target) {
      const arrived = c.pos.distanceTo(o.target) < 0.3;
      if (!arrived && this.t < LEG_CAP * BEAT) return;
    }
    o.done = true;
    if (o.type === 'pass') {
      const to = this.units[o.passTo];
      if (to && to.team === c.team && to !== c) this.pass(c, to, null);
    } else if (o.type === 'through') {
      if (o.point) this.pass(c, null, o.point);
    } else {
      this.shoot(c, o.aim || { y: 0, z: 0 }, o.type === 'tech');
    }
  }

  release(state, from, vel, power) {
    const b = this.ball;
    b.owner = null;
    b.state = state;
    b.lastTouch = from;
    b.vel.copy(vel);
    b.power = power;
    b.travelled = 0;
    b.tried.clear();
    b.releasedAt = this.t;
    from.grabCd = 0.45;
  }

  give(u) {
    const b = this.ball;
    b.owner = u;
    b.state = 'held';
    b.target = null;
    b.point = null;
    b.special = false;
    b.launching = false;
    b.lastTouch = u;
    b.vel.set(0, 0, 0);
  }

  loose(vel) {
    const b = this.ball;
    b.owner = null;
    b.state = 'loose';
    b.target = null;
    b.point = null;
    b.special = false;
    b.vel.copy(vel);
  }

  addOverdrive(team, amount) {
    const before = this.overdrive[team];
    this.overdrive[team] = Math.min(1, before + amount);
    if (before < 1 && this.overdrive[team] >= 1) {
      this.event('overdrive', `${this.teamDefs[team].short} Jecht Shot meter full`, team, null);
    }
  }

  pass(c, to, point) {
    const b = this.ball;
    const aimAt = v1;
    if (to) {
      const d = to.pos.distanceTo(b.pos);
      aimAt.copy(to.pos).addScaledVector(to.vel, (d / PASS_SPEED) * 0.8);
    } else aimAt.copy(point);
    const vel = v2.subVectors(aimAt, b.pos).normalize().multiplyScalar(PASS_SPEED);
    const pa = c.stat('PA');
    const power = pa * PASS_MULT + PASS_BASE;
    this.release('pass', c, vel, power);
    b.target = to;
    b.point = point ? point.clone() : null;
    this.stats[c.team].passAtt++;
    const txt = to
      ? `${c.name} passes to ${to.name} · PA ${fmt(pa)} → power ${fmt(power)}`
      : `${c.name} plays a through ball · PA ${fmt(pa)} → power ${fmt(power)}`;
    this.event('pass', txt, c.team, c.pos, this.t, { ids: [c.id, to ? to.id : -1] });
  }

  shoot(c, aim, special) {
    const b = this.ball;
    if (special && this.overdrive[c.team] < 1) special = false;
    if (special) this.overdrive[c.team] = 0;
    const s = sideSign(c.team);
    let ay = aim.y;
    let az = aim.z;
    const ar = Math.hypot(ay, az);
    if (ar > GOAL_RING_R * 0.95) { ay *= (GOAL_RING_R * 0.95) / ar; az *= (GOAL_RING_R * 0.95) / ar; }
    const aimPt = v1.set(s * GOAL_X, ay, az);
    const dist = aimPt.distanceTo(b.pos);
    const sh = c.stat('SH');
    const w = wobbleR(sh, dist, special);
    const r = w * Math.sqrt(this.rng());
    const a = this.rng() * Math.PI * 2;
    aimPt.y += r * Math.cos(a);
    aimPt.z += r * Math.sin(a);
    const speed = SHOT_SPEED * (special ? 1.25 : 1);
    const vel = v2.subVectors(aimPt, b.pos).normalize().multiplyScalar(speed);
    const power = (sh * SHOT_MULT + SHOT_BASE) * (special ? SPECIAL_MULT : 1);
    this.release('shot', c, vel, power);
    b.special = special;
    b.knockouts = special ? 2 : 0;
    b.shotT = this.t;
    b.shotTeam = c.team;
    b.onTargetCounted = false;
    const k = this.keepers[1 - c.team];
    k.diveFrom = k.pos.clone();
    this.stats[c.team].shots++;
    const txt = special
      ? `JECHT SHOT! ${c.name} · SH ${fmt(sh)} × 1.5 → power ${fmt(power)}`
      : `${c.name} shoots · SH ${fmt(sh)} → power ${fmt(power)}`;
    this.event(special ? 'tech' : 'shot', txt, c.team, c.pos, this.t, { ids: [c.id], big: special });
  }

  // Where a press order heads this tick.
  pressTarget(u, out) {
    const b = this.ball;
    const own = this.ownGoal(u.team);
    if (b.owner && b.owner.team !== u.team) {
      return out.subVectors(own, b.owner.pos).setLength(0.6).add(b.owner.pos);
    }
    if (b.state === 'pass' && b.lastTouch && b.lastTouch.team !== u.team) {
      return out.copy(b.target ? b.target.pos : b.point || b.pos);
    }
    if (b.state === 'loose') return out.copy(b.pos);
    return null;
  }

  // Closest point on the ball's line ahead, if it is within lunging distance.
  lungePoint(u, out) {
    const b = this.ball;
    if (b.tried.has(u) || this.t - (b.releasedAt || 0) < LUNGE_REACT) return null;
    const speed = b.vel.length();
    if (speed < 1) return null;
    v2.copy(b.vel).divideScalar(speed);
    const along = out.subVectors(u.pos, b.pos).dot(v2);
    if (along < 0) return null;
    out.copy(b.pos).addScaledVector(v2, along);
    const gap = out.distanceTo(u.pos) - u.zoc(u.order.type === 'hold');
    if (gap <= 0 || gap > LUNGE_REACH) return null;
    return out;
  }

  reflex(u) {
    if (u.grabCd > 0) return false;
    const b = this.ball;
    const d = u.pos.distanceTo(b.pos);
    if (u.isKeeper) return d < 9 && b.pos.distanceTo(this.ownGoal(u.team)) < 11;
    if (u.order.type === 'press') return true;
    return d < REFLEX_DIST;
  }

  isMarked(c) {
    return this.teams[1 - c.team].some((q) => q.stun <= 0 && q.pos.distanceTo(c.pos) < 2.3);
  }

  // Works out u.nextVel for this tick, plus facing and stamina.
  steer(u) {
    u.stun = Math.max(0, u.stun - TICK);
    u.grabCd = Math.max(0, u.grabCd - TICK);
    u.lunge = Math.max(0, u.lunge - TICK * 3);
    const b = this.ball;
    const nv = u.nextVel || (u.nextVel = new V());
    if (this.dead) { nv.copy(u.vel).multiplyScalar(0.85); return; }
    if (u.stun > 0) { nv.set(0, 0, 0); return; }

    const carrying = b.owner === u;
    const o = u.order;
    let target = null;
    let sprint = o.sprint;
    let diving = false;
    let resting = false;
    const tgt = v1;

    // Keeper reflex: dive for where an incoming shot crosses the goal mouth.
    if (u.isKeeper && b.state === 'shot' && b.shotTeam !== u.team && this.t - b.shotT >= KEEPER_REACT) {
      const s = sideSign(u.team);
      const plane = -s * (GOAL_X - 1.4);
      if (Math.sign(b.vel.x) === -s) {
        const tt = (plane - b.pos.x) / b.vel.x;
        if (tt > 0) {
          target = tgt.copy(b.pos).addScaledVector(b.vel, tt);
          const r = Math.hypot(target.y, target.z);
          const max = GOAL_RING_R * 0.9;
          if (r > max) { target.y *= max / r; target.z *= max / r; }
          diving = true;
          sprint = true;
        }
      }
    }
    // Defenders near the line of a pass or shot in flight lunge across it.
    if (!target && (b.state === 'pass' || b.state === 'shot') && b.lastTouch && b.lastTouch.team !== u.team && !u.isKeeper) {
      const lp = this.lungePoint(u, tgt);
      if (lp) { target = lp; sprint = true; }
    }
    // The receiver of a pass swims to meet it.
    if (!target && b.state === 'pass' && b.target === u) {
      target = tgt.copy(b.pos).addScaledVector(b.vel, 0.12);
    }
    // Anyone close to a loose ball goes for it.
    if (!target && b.state === 'loose' && !carrying && this.reflex(u)) {
      target = tgt.copy(b.pos).addScaledVector(b.vel, 0.2);
      sprint = sprint || u.pos.distanceTo(b.pos) > 3;
    }
    if (!target) {
      switch (o.type) {
        case 'move': case 'dribble': case 'pass': case 'through': case 'shoot': case 'tech':
          target = o.target;
          break;
        case 'mark': {
          const q = this.units[o.markId];
          if (q && q.team !== u.team) {
            // Markers react a beat late: they track where their man was a moment ago.
            const lag = v2.copy(q.pos).addScaledVector(q.vel, -0.4);
            const own = this.ownGoal(u.team);
            target = tgt.subVectors(own, lag).setLength(2.5).add(lag);
          }
          break;
        }
        case 'press':
          target = this.pressTarget(u, tgt);
          break;
        default:
          resting = true;
      }
    }

    let speed = u.speed(sprint, carrying);
    if (carrying && this.isMarked(u)) speed *= MARKED_MULT;
    if (diving) speed *= KEEPER_DIVE;
    let moved = 0;
    if (target) {
      v2.subVectors(target, u.pos);
      const d = v2.length();
      moved = Math.min(d, speed * TICK);
      if (d > 1e-4) nv.copy(v2).multiplyScalar(moved / d / TICK);
      else nv.set(0, 0, 0);
    } else nv.set(0, 0, 0);

    if (moved > 0.02) {
      v2.copy(nv).normalize();
      u.facing.lerp(v2, 0.25).normalize();
    } else if (carrying) {
      v2.subVectors(this.attackGoal(u.team), u.pos).normalize();
      u.facing.lerp(v2, 0.1).normalize();
    }

    // Stamina.
    let drain = 0;
    if (sprint && moved > 0.01 && !diving) drain += HP_SPRINT;
    if (carrying) drain += nv.length() * HP_CARRY;
    if (drain > 0) u.hp = Math.max(0, u.hp - drain * TICK);
    else {
      const rest = resting ? HP_HOLD[0] + u.base('EN') * HP_HOLD[1] : HP_REST;
      u.hp = Math.min(u.maxHp, u.hp + rest * TICK);
    }
  }

  clampUnit(u) {
    const lim = SPHERE_R - PLAYER_MARGIN;
    const len = u.pos.length();
    if (len > lim) u.pos.multiplyScalar(lim / len);
    // Nobody swims into the goal ring itself.
    const edge = GOAL_X - 1.0;
    if (Math.abs(u.pos.x) > edge && Math.hypot(u.pos.y, u.pos.z) < GOAL_RING_R + 1) u.pos.x = Math.sign(u.pos.x) * edge;
  }

  separate() {
    const ps = this.units;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        v1.subVectors(ps[i].pos, ps[j].pos);
        const d = v1.length();
        if (d < 1.2 && d > 1e-4) {
          v1.multiplyScalar(((1.2 - d) / d) * 0.5);
          ps[i].pos.add(v1);
          ps[j].pos.sub(v1);
        }
      }
    }
  }

  // Pressing players tackle on contact; bracing players challenge a carrier who swims into their zone.
  tackles() {
    const c = this.ball.owner;
    if (!c || c.stun > 0) return;
    for (const q of this.teams[1 - c.team]) {
      if (q.stun > 0 || q.triedTackle) continue;
      const d = q.pos.distanceTo(c.pos);
      const pressing = q.order.type === 'press' && d < TACKLE_RANGE;
      const bracing = q.order.type === 'hold' && d < q.zoc(true) * 0.75;
      if (!pressing && !bracing) continue;
      q.triedTackle = true;
      const { at, en, chance } = tackleChance(q, c);
      c.hp = Math.max(0, c.hp - at * 2);
      q.lunge = 1;
      const pct = Math.round(chance * 100);
      if (this.rng() < chance) {
        c.stun = 0.8;
        c.grabCd = 0.8;
        this.give(q);
        this.stats[q.team].tackles++;
        this.addOverdrive(q.team, OVERDRIVE.tackle);
        this.event('tackle', `${q.name} AT ${fmt(at)} vs ${c.name} EN ${fmt(en)}: ${bracing ? 'challenge' : 'tackle'} won (${pct}%)`, q.team, q.pos, this.t, { ids: [q.id, c.id], duel: true });
        return;
      }
      q.stun = 0.7;
      this.event('breakthrough', `${c.name} EN ${fmt(en)} holds off ${q.name} AT ${fmt(at)} (tackle ${pct}%)`, c.team, c.pos, this.t, { ids: [c.id, q.id], duel: true });
    }
  }

  stepBall() {
    const b = this.ball;
    const prevX = b.pos.x;
    if (b.state === 'held' && b.owner) {
      b.pos.copy(b.owner.pos).addScaledVector(b.owner.facing, 0.75);
      b.vel.copy(b.owner.vel);
    } else {
      b.pos.addScaledVector(b.vel, TICK);
      b.travelled += b.vel.length() * TICK;
      if (b.launching && b.pos.y >= 0) b.launching = false;
      if (b.state === 'loose' && !b.launching) b.vel.multiplyScalar(Math.exp(-TICK * 1.1));
      if (this.dead) b.vel.multiplyScalar(0.94);
      const lim = SPHERE_R - 0.5;
      const len = b.pos.length();
      if (len > lim) {
        const n = v1.copy(b.pos).normalize();
        b.pos.copy(n).multiplyScalar(lim);
        const vn = b.vel.dot(n);
        if (vn > 0) b.vel.addScaledVector(n, -1.6 * vn);
        if (b.state === 'shot' && !this.dead) {
          this.stats[b.shotTeam].wide++;
          this.event('wide', `${b.lastTouch.name}'s shot flies off the wall`, 1 - b.shotTeam, b.pos);
        }
        if (b.state !== 'loose') this.loose(b.vel.multiplyScalar(0.5));
      }
    }
    if (this.dead) return;
    if (b.state === 'pass') this.updatePass();
    else if (b.state === 'shot') this.updateShot();
    else if (b.state === 'loose') this.pickup();
    if (b.state !== 'held') this.checkGoal(prevX);
  }

  pickup() {
    const b = this.ball;
    let best = null;
    let bestScore = Infinity;
    for (const u of this.units) {
      if (u.grabCd > 0 || u.stun > 0) continue;
      const reach = u.isKeeper ? PICKUP_DIST + 0.5 : PICKUP_DIST;
      const d = u.pos.distanceTo(b.pos);
      if (d > reach) continue;
      const score = d / reach + this.rng() * 0.15;
      if (score < bestScore) { bestScore = score; best = u; }
    }
    if (best) {
      this.give(best);
      this.event('pickup', `${best.name} gathers the loose ball`, best.team, best.pos, this.t, { ids: [best.id] });
    }
  }

  updatePass() {
    const b = this.ball;
    const passer = b.lastTouch;
    const target = b.target;
    // Passes curl gently toward the receiver so a moving teammate can still take them.
    if (target && !b.point) {
      v1.subVectors(target.pos, b.pos);
      if (v1.dot(b.vel) > 0) {
        v1.setLength(PASS_SPEED);
        b.vel.lerp(v1, Math.min(1, TICK * 4)).setLength(PASS_SPEED);
      }
    }
    b.power -= b.vel.length() * TICK * PASS_DECAY;
    for (const q of this.teams[passer.team]) {
      if (q.stun > 0 || q.grabCd > 0) continue;
      if (q.pos.distanceTo(b.pos) < CATCH_DIST) {
        const left = b.power;
        this.give(q);
        this.stats[q.team].passes++;
        this.addOverdrive(q.team, OVERDRIVE.pass);
        this.event('catch', `${q.name} takes the pass · ${fmt(left)} power left`, q.team, q.pos, this.t, { ids: [q.id] });
        return;
      }
    }
    for (const q of this.teams[1 - passer.team]) {
      if (b.tried.has(q) || q.stun > 0) continue;
      const braced = q.order.type === 'hold';
      if (q.pos.distanceTo(b.pos) > q.zoc(braced)) continue;
      b.tried.add(q);
      q.lunge = 1;
      const bl = q.stat('BL');
      const cut = bl * PASS_CUT * this.rand(CUT_SPREAD[0], CUT_SPREAD[1]) * (braced ? BRACE_CUT : 1);
      const before = b.power;
      b.power -= cut;
      if (b.power <= 0) {
        this.give(q);
        this.stats[q.team].intercepts++;
        this.addOverdrive(q.team, OVERDRIVE.block);
        this.event('intercept', `${q.name} BL ${fmt(bl)} intercepts: pass power ${fmt(before)} → 0`, q.team, q.pos, this.t, { ids: [q.id], duel: true });
        return;
      }
      this.event('deflect', `${q.name} BL ${fmt(bl)} gets a touch: pass power ${fmt(before)} → ${fmt(b.power)}`, q.team, q.pos, this.t, { ids: [q.id], duel: true });
    }
    if (b.point) {
      v1.subVectors(b.point, b.pos);
      if (v1.length() < 0.8 || v1.dot(b.vel) < 0) { this.loose(b.vel.multiplyScalar(0.2)); return; }
    }
    if (b.power <= 0 || b.travelled > 55) {
      this.loose(b.vel.multiplyScalar(0.35));
      this.event('fizzle', 'The pass dies in the water', -1, b.pos);
    }
  }

  updateShot() {
    const b = this.ball;
    const shooter = b.lastTouch;
    b.power -= b.vel.length() * TICK * SHOT_DECAY;
    for (const q of this.teams[1 - shooter.team]) {
      if (b.tried.has(q) || q.stun > 0) continue;
      if (q.isKeeper) {
        if (q.pos.distanceTo(b.pos) > q.catchR()) continue;
        b.tried.add(q);
        q.lunge = 1;
        this.keeperDuel(q);
        if (b.state !== 'shot') return;
        continue;
      }
      const braced = q.order.type === 'hold';
      if (q.pos.distanceTo(b.pos) > q.zoc(braced)) continue;
      b.tried.add(q);
      q.lunge = 1;
      if (b.knockouts > 0) {
        b.knockouts--;
        q.stun = 1.4;
        this.event('knockback', `The Jecht Shot knocks ${q.name} aside`, shooter.team, q.pos, this.t, { ids: [q.id], duel: true });
        continue;
      }
      const bl = q.stat('BL');
      const cut = bl * SHOT_CUT * this.rand(CUT_SPREAD[0], CUT_SPREAD[1]) * (braced ? BRACE_CUT : 1);
      const before = b.power;
      b.power -= cut;
      if (b.power <= 0) {
        this.give(q);
        this.stats[q.team].blocks++;
        this.addOverdrive(q.team, OVERDRIVE.block);
        this.event('block', `${q.name} BL ${fmt(bl)}${braced ? ' (braced)' : ''} blocks: shot power ${fmt(before)} → 0`, q.team, q.pos, this.t, { ids: [q.id], duel: true });
        return;
      }
      this.stats[q.team].deflects++;
      this.event('deflect', `${q.name} BL ${fmt(bl)}${braced ? ' (braced)' : ''} blocks: shot power ${fmt(before)} → ${fmt(b.power)}`, q.team, q.pos, this.t, { ids: [q.id], duel: true });
    }
    if (b.power <= 0) {
      this.loose(b.vel.multiplyScalar(0.25));
      this.event('fizzle', 'The shot runs out of power', -1, b.pos);
    }
  }

  keeperDuel(k, fingertip = false) {
    const b = this.ball;
    const from = k.diveFrom || k.pos;
    const need = Math.max(0, from.distanceTo(b.pos) - k.catchR());
    const stretch = fingertip ? FINGERTIP : 1 - STRETCH[0] * Math.min(1, need / STRETCH[1]);
    const ca = k.stat('CA');
    const grip = ca * GRIP_MULT * this.rand(GRIP_SPREAD[0], GRIP_SPREAD[1]) * stretch;
    const st = fingertip ? ', fingertips only' : stretch < 0.99 ? `, stretched to ${Math.round(stretch * 100)}%` : '';
    if (!b.onTargetCounted) { b.onTargetCounted = true; this.stats[b.shotTeam].onTarget++; }
    if (b.power > grip) {
      k.stun = 0.6;
      this.event('beaten', `${k.name} CA ${fmt(ca)} beaten: power ${fmt(b.power)} vs grip ${fmt(grip)}${st}`, b.shotTeam, k.pos, this.t, { ids: [k.id], duel: true });
      return;
    }
    const power = b.power;
    this.give(k);
    this.stats[k.team].saves++;
    this.addOverdrive(k.team, OVERDRIVE.save);
    this.event('save', `${k.name} CA ${fmt(ca)} saves: grip ${fmt(grip)} vs power ${fmt(power)}${st}`, k.team, k.pos, this.t, { ids: [k.id], duel: true, big: true });
  }

  checkGoal(prevX) {
    const b = this.ball;
    const p = b.pos;
    if (Math.abs(p.x) < GOAL_X || Math.abs(prevX) >= GOAL_X) return;
    if (Math.hypot(p.y, p.z) > GOAL_RING_R) {
      if (b.state === 'shot') {
        this.stats[b.shotTeam].wide++;
        this.event('wide', `${b.lastTouch.name}'s shot misses the ring`, 1 - b.shotTeam, p);
        this.loose(b.vel.multiplyScalar(0.4));
      }
      return;
    }
    // A keeper who couldn't get there in time still gets a fingertip to it.
    if (b.state === 'shot') {
      const k = this.keepers[1 - b.shotTeam];
      if (!b.tried.has(k) && k.stun <= 0) {
        b.tried.add(k);
        k.lunge = 1;
        this.keeperDuel(k, true);
        if (b.state !== 'shot') { b.pos.x = Math.sign(p.x) * (GOAL_X - 0.4); return; }
      }
    }
    const scorer = p.x > 0 ? 0 : 1;
    const by = b.lastTouch;
    this.score[scorer]++;
    this.stats[scorer].goals++;
    if (b.state === 'shot' && !b.onTargetCounted) this.stats[b.shotTeam].onTarget++;
    this.dead = true;
    this.goalAt = this.t;
    b.owner = null;
    b.state = 'loose';
    b.vel.multiplyScalar(0.3);
    const [a, c] = this.teamDefs;
    const own = by && by.team !== scorer;
    this.rec.goal = { team: scorer, by: by ? by.id : -1, t: this.t };
    this.event('goal', `GOAL! ${own ? `Own goal by ${by.name}` : by ? by.name : ''} · ${a.short} ${this.score[0]}–${this.score[1]} ${c.short}`,
      scorer, p, this.t, { ids: by ? [by.id] : [], big: true });
  }
}

export function fmt(n) {
  return String(Math.round(n));
}
