import * as THREE from './lib.js';
import {
  SPHERE_R, PLAYER_MARGIN, GOAL_X, GOAL_RING_R, BALL_R, sideSign, BEAT, LEG_CAP, TICK,
  PASS_SPEED, SHOT_SPEED, TACKLE_RANGE, PASS_MULT, PASS_BASE, PASS_DECAY, PASS_CUT, CUT_SPREAD,
  SHOT_MULT, SHOT_BASE, SHOT_DECAY, SHOT_CUT, SPECIAL_MULT, GRIP_MULT, GRIP_SPREAD,
  KEEPER_DIVE, KEEPER_REACT, STRETCH, FINGERTIP, PRESS, SHOOTING, LUNGE_REACH, LUNGE_REACT,
} from './config.js';
import { newOrder, wobbleR, tackleChance, rng32, ACTIONS } from './match.js';

// The auto-planner (used for the human side's defaults and for the opponent) and the
// risk estimates the planning overlays show. Everything reads the frozen match state.

const V = THREE.Vector3;
const clamp = THREE.MathUtils.clamp;
const tmp = new V();

// ---------- geometry ----------

export function clampInside(v, margin = PLAYER_MARGIN + 0.3) {
  const lim = SPHERE_R - margin;
  if (v.length() > lim) v.setLength(lim);
  return v;
}

function segClosest(a, b, p, out) {
  tmp.subVectors(b, a);
  const len2 = tmp.lengthSq();
  const s = len2 > 0 ? clamp(out.subVectors(p, a).dot(tmp) / len2, 0, 1) : 0;
  out.copy(a).addScaledVector(tmp, s);
  return s;
}

// How far an order may take a player this beat.
export function orderReach(m, u, o) {
  const carrying = m.ball.owner === u;
  if (carrying && o.type === 'dribble') return u.reach(o.sprint, true);
  if (carrying && ACTIONS.has(o.type)) return o.timing === 'end' ? u.reach(o.sprint, true) * LEG_CAP : u.reach(o.sprint, false);
  if (carrying && o.type === 'move') return u.reach(o.sprint, true);
  return u.reach(o.sprint, false);
}

// Keeps an order legal: targets inside reach and the sphere, aim inside the ring.
export function fixOrder(m, u, o) {
  if (o.target) {
    const r = orderReach(m, u, o);
    tmp.subVectors(o.target, u.pos);
    if (tmp.length() > r) o.target.copy(u.pos).add(tmp.setLength(r));
    clampInside(o.target);
  }
  if (o.point) clampInside(o.point, 1.2);
  if (o.aim) {
    const r = Math.hypot(o.aim.y, o.aim.z);
    const max = GOAL_RING_R * 0.95;
    if (r > max) { o.aim.y *= max / r; o.aim.z *= max / r; }
  }
  return o;
}

// ---------- risk estimates ----------

// Opponents who could get their zone of control onto a ball travelling a→b,
// released t0 seconds into the beat. p is how likely each one is to get a touch.
export function pathThreats(m, team, a, b, t0, speed, { awareness = 1, keeper = false } = {}) {
  const out = [];
  const len = a.distanceTo(b);
  const c = new V();
  for (const q of m.teams[1 - team]) {
    if (q.isKeeper && !keeper) continue;
    if (q.stun > 0.8) continue;
    const s = segClosest(a, b, q.pos, c);
    const d = q.pos.distanceTo(c);
    // Less aware planners misjudge how big a zone is.
    const zoc = q.zoc(false) * (0.4 + 0.6 * awareness);
    const need = d - zoc;
    const tArr = Math.min(BEAT, t0 + (s * len) / speed);
    const budget = q.speed(true, false) * tArr;
    // A defender just outside the line lunges across it once the ball is on its way.
    const lunge = Math.min(LUNGE_REACH, q.speed(true, false) * Math.max(0, (s * len) / speed - LUNGE_REACT)) * awareness;
    let p;
    if (need <= 0) p = 1;
    else if (need < lunge) p = 0.85 * (1 - need / lunge) + 0.15;
    else if (need < budget) p = MOVE_THREAT * (1 - need / budget) * awareness;
    else continue;
    if (p < 0.02) continue;
    out.push({ q, p, point: c.clone(), need, fixed: need <= 0 });
  }
  return out;
}

const seeded = (seed) => rng32(seed);
// How likely a defender who could reach a lane actually gets there (orders are hidden).
const MOVE_THREAT = 0.22;

export function passOdds(m, u, to, { from = u.pos, t0 = 0, awareness = 1, samples = 120 } = {}) {
  const dist = from.distanceTo(to);
  const power = u.stat('PA') * PASS_MULT + PASS_BASE;
  const arrive = power - dist * PASS_DECAY;
  const threats = pathThreats(m, u.team, from, to, t0, PASS_SPEED, { awareness, keeper: true });
  const r = seeded(7);
  let ok = 0;
  let left = 0;
  for (let i = 0; i < samples; i++) {
    let pw = arrive;
    for (const th of threats) {
      if (r() >= th.p) continue;
      pw -= th.q.stat('BL') * PASS_CUT * (CUT_SPREAD[0] + r() * (CUT_SPREAD[1] - CUT_SPREAD[0]));
      if (pw <= 0) break;
    }
    if (pw > 0) { ok++; left += pw; }
  }
  return { p: ok / samples, power, arrive: ok ? left / ok : 0, threats, dist };
}

export function shotOdds(m, u, aim, { from = u.pos, t0 = 0, special = false, awareness = 1, samples = 120 } = {}) {
  const team = u.team;
  const s = sideSign(team);
  const aimPt = new V(s * GOAL_X, aim.y, aim.z);
  const dist = from.distanceTo(aimPt);
  const speed = SHOT_SPEED * (special ? 1.25 : 1);
  const sh = u.stat('SH');
  const power = (sh * SHOT_MULT + SHOT_BASE) * (special ? SPECIAL_MULT : 1);
  const w = wobbleR(sh, dist, special);
  const threats = pathThreats(m, team, from, aimPt, t0, speed, { awareness });
  const k = m.keepers[1 - team];
  const kc = k.catchR();
  const plane = s * (GOAL_X - 1.4);
  const flight = (Math.abs(plane - from.x) / Math.max(0.5, Math.abs(aimPt.x - from.x))) * (dist / speed);
  const dive = k.speed(true, false) * KEEPER_DIVE * Math.max(0, flight - KEEPER_REACT);
  const ca = k.stat('CA');
  const r = seeded(11);
  const cross = new V();
  let goals = 0;
  let on = 0;
  let blocked = 0;
  let powSum = 0;
  let powN = 0;
  const atGoal = power - dist * SHOT_DECAY;
  for (let i = 0; i < samples; i++) {
    const rr = w * Math.sqrt(r());
    const a = r() * Math.PI * 2;
    const y = aim.y + rr * Math.cos(a);
    const z = aim.z + rr * Math.sin(a);
    let pw = atGoal;
    let ko = special ? 2 : 0;
    let blk = false;
    for (const th of threats) {
      if (r() >= th.p) continue;
      if (ko > 0) { ko--; continue; }
      pw -= th.q.stat('BL') * SHOT_CUT * (CUT_SPREAD[0] + r() * (CUT_SPREAD[1] - CUT_SPREAD[0]));
      if (pw <= 0) { blk = true; break; }
    }
    if (blk) { blocked++; continue; }
    if (Math.hypot(y, z) > GOAL_RING_R - BALL_R * 0.5) continue;
    on++;
    cross.set(plane, y, z);
    const need = k.pos.distanceTo(cross) - kc;
    const stretch = need > dive ? FINGERTIP : 1 - STRETCH[0] * Math.min(1, Math.max(0, need) / STRETCH[1]);
    powSum += pw;
    powN++;
    const grip = ca * GRIP_MULT * (GRIP_SPREAD[0] + r() * (GRIP_SPREAD[1] - GRIP_SPREAD[0])) * stretch;
    if (pw > grip) goals++;
  }
  cross.set(plane, aim.y, aim.z);
  const need = k.pos.distanceTo(cross) - kc;
  const stretch = need > dive ? FINGERTIP : 1 - STRETCH[0] * Math.min(1, Math.max(0, need) / STRETCH[1]);
  return {
    p: goals / samples, onTarget: on / samples, blocked: blocked / samples, power,
    expPower: powN ? powSum / powN : atGoal,
    gripLo: ca * GRIP_MULT * GRIP_SPREAD[0] * stretch, gripHi: ca * GRIP_MULT * GRIP_SPREAD[1] * stretch,
    stretch, outOfReach: need > dive, threats, dist, wobble: w, keeper: k,
  };
}

// Chance a carrier keeps the ball dribbling from a to b this beat.
export function keepOdds(m, u, a, b, awareness = 1) {
  let keep = 1;
  const c = new V();
  for (const q of m.teams[1 - u.team]) {
    if (q.stun > 0.8) continue;
    segClosest(a, b, q.pos, c);
    const need = q.pos.distanceTo(c) - TACKLE_RANGE;
    const budget = q.reach(true, false);
    let p;
    if (need <= 0) p = 0.95;
    else if (need < budget) p = 0.9 * (1 - need / budget) * (0.4 + 0.6 * awareness);
    else continue;
    keep *= 1 - p * tackleChance(q, u).chance;
  }
  return keep;
}

// Loose-ball position after t seconds, ignoring bounces.
export function predictBall(m, t) {
  const b = m.ball;
  const p = b.pos.clone();
  const vel = b.vel.clone();
  let launching = b.launching || m.kickoffPending;
  let wait = m.kickoffPending ? 0.3 : 0;
  if (m.kickoffPending) vel.set(0, 17, 0);
  for (let s = 0; s < t; s += TICK) {
    if (wait > 0) { wait -= TICK; continue; }
    p.addScaledVector(vel, TICK);
    if (launching && p.y >= 0) launching = false;
    if (!launching) vel.multiplyScalar(Math.exp(-TICK * 1.1));
  }
  return clampInside(p, 1.5);
}

// ---------- planner ----------

export function planTeam(m, team, tac, prof) {
  const ctx = context(m, team, tac, prof);
  const orders = new Array(6);
  const carrier = m.ball.owner && m.ball.owner.team === team ? m.ball.owner : null;
  for (const u of m.teams[team]) if (u !== carrier) orders[u.slotIndex] = offBall(ctx, u);
  if (carrier) orders[carrier.slotIndex] = planCarrier(ctx, carrier, orders);
  for (const u of m.teams[team]) {
    fixOrder(m, u, orders[u.slotIndex]);
    orders[u.slotIndex].auto = true;
  }
  return orders;
}

function context(m, team, tac, prof) {
  const b = m.ball;
  const s = sideSign(team);
  const ctx = {
    m, team, tac, prof, s,
    own: m.ownGoal(team), goal: m.attackGoal(team),
    opp: m.teams[1 - team], mine: m.teams[team],
    rand: rng32((m.seed ^ (m.half * 977 + m.beat * 131 + team * 7)) | 0),
  };
  ctx.oppBySlot = Object.fromEntries(ctx.opp.map((q) => [q.slot, q]));
  // Phase: who has (or is about to have) the ball.
  if (b.owner) ctx.phase = b.owner.team === team ? 'attack' : 'defend';
  else if (b.state === 'pass') ctx.phase = b.lastTouch.team === team ? 'attack' : 'defend';
  else ctx.phase = 'loose';
  // Where the play is.
  if (b.owner) ctx.ball = b.owner.pos.clone();
  else if (b.state === 'pass') ctx.ball = (b.target ? b.target.pos : b.point || b.pos).clone();
  else if (b.state === 'shot') ctx.ball = b.pos.clone().addScaledVector(b.vel, 0.4);
  else ctx.ball = predictBall(m, 1.2);
  ctx.threat = ctx.phase === 'defend' ? (b.owner || b.target || null) : null;

  // Pressers.
  ctx.pressers = new Set();
  if (ctx.phase === 'defend') {
    const P = PRESS[tac.press] || PRESS[1];
    const at = ctx.ball;
    const cand = ctx.mine.filter((u) => !u.isKeeper && u.stun < 0.6 && u.fit > 0.2)
      .map((u) => ({ u, d: u.pos.distanceTo(at) }))
      .sort((a, c) => a.d - c.d);
    for (const { u, d } of cand) {
      if (ctx.pressers.size >= P.count) break;
      if (d > P.range) continue;
      if (prof.smartPress) {
        // Only press if we can get there this beat, and not with a spent player.
        if (d - TACKLE_RANGE > u.reach(true) * 1.05 || u.fit < 0.3) continue;
        if (ctx.threat && tackleChance(u, ctx.threat).chance < 0.3 && ctx.pressers.size > 0) continue;
      }
      ctx.pressers.add(u);
    }
  }
  // Loose-ball chasers.
  ctx.chasers = new Set();
  if (ctx.phase === 'loose') {
    const cand = ctx.mine.filter((u) => !u.isKeeper && u.stun < 0.6)
      .sort((a, c) => a.pos.distanceTo(ctx.ball) - c.pos.distanceTo(ctx.ball));
    if (cand[0]) ctx.chasers.add(cand[0]);
    // A second player covers the drop zone a few metres goal-side of the ball.
    ctx.cover = tac.press >= 1 || m.kickoffPending ? cand[1] || null : null;
  }
  return ctx;
}

// Formation spot for a mode, shifted by the team instructions and by the ball.
export function formationSpot(ctx, u, mode, out = new V()) {
  const { tac, s } = ctx;
  let [x, y, z] = tac.base[u.slot];
  if (!u.isKeeper) {
    const w = 0.55 + tac.width * 0.9;
    y *= w;
    z *= w;
    if (mode === 'attack') x += 6 + tac.depth * 4;
    else if (mode === 'defend') x += -6 + tac.depth * 8;
    else x += -2 + tac.depth * 3;
    x += ctx.ball.x * s * 0.35;
    y += ctx.ball.y * 0.3;
    z += ctx.ball.z * s * 0.25;
    x = clamp(x, -GOAL_X + 4, GOAL_X - 4);
  }
  out.set(x * s, y, z * s);
  return clampInside(out, 3);
}

function nearest(list, p, skip) {
  let best = null;
  let bd = Infinity;
  for (const q of list) {
    if (q === skip || q.isKeeper) continue;
    const d = q.pos.distanceTo(p);
    if (d < bd) { bd = d; best = q; }
  }
  return { q: best, d: bd };
}

function moveTo(ctx, u, target, urgent = false) {
  const d = u.pos.distanceTo(target);
  if (d < 1.2) return newOrder('hold');
  const sprint = urgent && d > u.reach(false) * 0.95 && u.fit > 0.55;
  return newOrder('move', { target: target.clone(), sprint });
}

function offBall(ctx, u) {
  if (u.isKeeper) return keeperOrder(ctx, u);
  if (ctx.phase === 'attack') return attackRun(ctx, u);
  if (ctx.phase === 'defend') return defend(ctx, u);
  if (ctx.chasers.has(u)) {
    const far = u.pos.distanceTo(ctx.ball) > u.reach(false);
    return newOrder('move', { target: ctx.ball.clone(), sprint: far && u.fit > 0.4 });
  }
  if (ctx.cover === u) {
    const t = new V().subVectors(ctx.own, ctx.ball).setLength(5).add(ctx.ball);
    return moveTo(ctx, u, clampInside(t, 2.5), true);
  }
  return moveTo(ctx, u, formationSpot(ctx, u, 'neutral'));
}

function attackRun(ctx, u) {
  const { s, tac, m } = ctx;
  const role = u.role;
  const t = formationSpot(ctx, u, 'attack');
  const ballX = ctx.ball.x * s;
  let urgent = false;
  if (role === 'runner') {
    // Beyond the last outfield defender, toward goal.
    let last = -Infinity;
    for (const q of ctx.opp) if (!q.isKeeper) last = Math.max(last, q.pos.x * s);
    const runX = Math.min(GOAL_X - 6, Math.max(t.x * s, ballX + 8, last + 3));
    t.x = runX * s;
    t.y *= 0.8;
    t.z *= 0.8;
    urgent = true;
  } else if (role === 'target') {
    const [, by, bz] = tac.base[u.slot];
    t.set((GOAL_X - 9) * s, by * 0.3, bz * 0.3 * s);
  } else if (role === 'anchor') {
    t.lerpVectors(ctx.own, ctx.ball, 0.35);
  } else if (role === 'sweeper') {
    t.lerpVectors(ctx.own, ctx.ball, 0.22);
  }
  // Find space: step away from the nearest opponent.
  const { q, d } = nearest(ctx.opp, t);
  if (q && d < 4.5) t.add(tmp.subVectors(t, q.pos).setLength(4.5 - d));
  clampInside(t, 2.5);
  // Not behind the goal plane.
  if (Math.abs(t.x) > GOAL_X - 3) t.x = Math.sign(t.x) * (GOAL_X - 3);
  // The ball's receiver should not wander away from a pass already in flight.
  if (m.ball.state === 'pass' && m.ball.target === u) return newOrder('hold');
  return moveTo(ctx, u, t, urgent);
}

function defend(ctx, u) {
  const { m, tac, prof } = ctx;
  const threat = ctx.threat;
  if (ctx.pressers.has(u)) {
    const d = u.pos.distanceTo(ctx.ball);
    return newOrder('press', { sprint: d > u.reach(false) * 0.8 && u.fit > 0.45 });
  }
  const threatPos = ctx.ball;
  const role = u.role;
  const toGoal = threatPos.distanceTo(ctx.own);
  if (role === 'anchor' || (role !== 'sweeper' && toGoal < 15 && laneFree(ctx, u))) {
    const lane = new V().lerpVectors(ctx.own, threatPos, role === 'anchor' ? 0.35 : 0.5);
    if (u.pos.distanceTo(lane) < 1.6) return newOrder('hold');
    return moveTo(ctx, u, lane, true);
  }
  if (role === 'sweeper') {
    const deep = new V().lerpVectors(ctx.own, threatPos, 0.2);
    return moveTo(ctx, u, deep, toGoal < 18);
  }
  const mk = tac.marks[u.slot];
  if (mk && mk !== 'none') {
    const opp = ctx.oppBySlot[mk];
    if (opp && opp !== threat) {
      const far = u.pos.distanceTo(opp.pos) > u.reach(false);
      return newOrder('mark', { markId: opp.id, sprint: far && u.fit > 0.5 });
    }
  }
  const spot = formationSpot(ctx, u, 'defend');
  // Aware planners pick up a free attacker near their zone, or cut the passing lane to them.
  if (prof.awareness >= 0.5 && threat) {
    const { q, d } = nearest(ctx.opp, spot, threat);
    if (q && d < 9 && !markedBy(ctx, q, u)) {
      if (prof.awareness >= 0.9 || ctx.rand() < 0.5) {
        const lane = new V().lerpVectors(threat.pos, q.pos, 0.55);
        return moveTo(ctx, u, lane, toGoal < 20);
      }
      return newOrder('mark', { markId: q.id });
    }
  }
  return moveTo(ctx, u, spot, toGoal < 16);
}

// Is the lane in front of goal already covered by a teammate closer to it?
function laneFree(ctx, u) {
  const lane = new V().lerpVectors(ctx.own, ctx.ball, 0.5);
  const mine = u.pos.distanceTo(lane);
  return !ctx.mine.some((q) => q !== u && !q.isKeeper && !ctx.pressers.has(q) && q.pos.distanceTo(lane) < mine);
}

function markedBy(ctx, q, self) {
  const tac = ctx.tac;
  return ctx.mine.some((u) => u !== self && tac.marks[u.slot] === q.slot);
}

function keeperOrder(ctx, u) {
  const { m, s } = ctx;
  const b = m.ball;
  if (b.state === 'loose' && ctx.ball.distanceTo(ctx.own) < 9) {
    return newOrder('move', { target: ctx.ball.clone(), sprint: true });
  }
  const plane = -s * (GOAL_X - 1.6);
  const t = new V(plane, ctx.ball.y * 0.12, ctx.ball.z * 0.12);
  const r = Math.hypot(t.y, t.z);
  if (r > GOAL_RING_R * 0.6) { t.y *= (GOAL_RING_R * 0.6) / r; t.z *= (GOAL_RING_R * 0.6) / r; }
  if (u.pos.distanceTo(t) < 0.5) return newOrder('hold');
  return newOrder('move', { target: t });
}

// ---------- the carrier ----------

// Rough value of having the ball at p: how likely a goal is to follow.
export function spotValue(ctx, p) {
  const d = p.distanceTo(ctx.goal);
  const facing = clamp((ctx.goal.x - p.x) * ctx.s / Math.max(1, d), 0, 1);
  const progress = clamp((p.x * ctx.s + GOAL_X) / (2 * GOAL_X), 0, 1);
  let v = 0.36 * Math.exp(-Math.max(0, d - 6) / 8) * (0.3 + 0.7 * facing) + 0.12 * progress * progress;
  const { d: open } = nearest(ctx.opp, p);
  return v * clamp((open - 1) / 5, 0.35, 1);
}

function lossCost(ctx, p) {
  return 0.05 + 0.18 * clamp(1 - p.distanceTo(ctx.own) / 40, 0, 1);
}

const AIMS = (() => {
  const out = [{ y: 0, z: 0 }];
  for (const r of [1.6, 2.6]) for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    out.push({ y: Math.sin(a) * r, z: Math.cos(a) * r });
  }
  return out;
})();

export function bestAim(m, u, opts) {
  let best = null;
  for (const aim of AIMS) {
    const o = shotOdds(m, u, aim, { ...opts, samples: 50 });
    if (!best || o.p > best.p) best = { aim, p: o.p };
  }
  const fine = shotOdds(m, u, best.aim, { ...opts, samples: 160 });
  return { aim: { ...best.aim }, odds: fine };
}

// Candidate dribble destinations: toward goal and fanned out around it.
function dribbleTargets(ctx, u, scale) {
  const out = [];
  const r = u.reach(false, true) * scale;
  const fwd = new V().subVectors(ctx.goal, u.pos).normalize();
  const side = new V(0, 1, 0).cross(fwd).normalize();
  if (side.lengthSq() < 0.1) side.set(0, 0, 1);
  const up = new V().crossVectors(fwd, side).normalize();
  const dirs = [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6], [1.2, 0], [-1.2, 0]];
  for (const [a, e] of dirs) {
    const d = fwd.clone().multiplyScalar(Math.cos(a) * Math.cos(e))
      .addScaledVector(side, Math.sin(a) * Math.cos(e)).addScaledVector(up, Math.sin(e)).normalize();
    const t = u.pos.clone().addScaledVector(d, r);
    clampInside(t, 2.5);
    if (Math.abs(t.x) > GOAL_X - 2.5) t.x = Math.sign(t.x) * (GOAL_X - 2.5);
    out.push(t);
  }
  return out;
}

function planCarrier(ctx, u, orders) {
  const { m, tac, prof } = ctx;
  const aw = prof.awareness;
  const pol = SHOOTING[tac.shooting] || SHOOTING.balanced;
  const tempo = tac.tempo;
  const opts = [];
  const noise = () => (ctx.rand() - 0.5) * 2 * prof.noise;
  const special = m.overdrive[u.team] >= 1;
  const distGoal = u.pos.distanceTo(ctx.goal);

  // Keepers just find the safest outlet.
  if (u.isKeeper) {
    let best = null;
    for (const q of ctx.mine) {
      if (q === u) continue;
      const po = passOdds(m, u, q.pos, { awareness: aw, samples: 60 });
      const sc = po.p * (0.5 + spotValue(ctx, q.pos)) + noise();
      if (!best || sc > best.sc) best = { sc, q };
    }
    return newOrder('pass', { passTo: best.q.id, timing: 'start' });
  }

  // Shots, from here and after a short dribble.
  if (distGoal < 24) {
    const here = bestAim(m, u, { awareness: aw, special });
    if (here.odds.p >= pol.min) {
      opts.push({ U: here.odds.p * pol.weight + noise(), order: newOrder(special ? 'tech' : 'shoot', { aim: here.aim, timing: 'start' }) });
    }
  }
  const legs = dribbleTargets(ctx, u, LEG_CAP);
  const legT = LEG_CAP * BEAT;
  for (const leg of legs.slice(0, 3)) {
    if (leg.distanceTo(ctx.goal) > 22) continue;
    const keep = keepOdds(m, u, u.pos, leg, aw);
    const after = bestAim(m, u, { from: leg, t0: legT, awareness: aw, special });
    const p = after.odds.p * keep;
    if (after.odds.p >= pol.min) {
      opts.push({ U: p * pol.weight + noise(), order: newOrder(special ? 'tech' : 'shoot', { aim: after.aim, timing: 'end', target: leg }) });
    }
  }

  // Passes to teammates, from here or after a short dribble.
  // Passing and dribbling only set up a later chance, so their value is discounted.
  const GAMMA = 0.5;
  const passMul = (0.8 + 0.4 * tempo) * GAMMA;
  for (const q of ctx.mine) {
    if (q === u || q.pos.distanceTo(u.pos) < 5) continue;
    const o = orders[q.slotIndex];
    const dest = o && o.target ? o.target : q.pos;
    const flight = q.pos.distanceTo(u.pos) / PASS_SPEED;
    const recv = q.pos.clone().lerp(dest, Math.min(1, flight / BEAT));
    const po = passOdds(m, u, recv, { awareness: aw, samples: 80 });
    const val = spotValue(ctx, dest) * (q.isKeeper ? 0.2 : 1);
    const U = (po.p * val - (1 - po.p) * lossCost(ctx, u.pos)) * passMul;
    opts.push({ U: U + noise(), order: newOrder('pass', { passTo: q.id, timing: 'start' }) });
  }
  // Through balls into the path of runners.
  for (const q of ctx.mine) {
    if (q === u || q.isKeeper) continue;
    const o = orders[q.slotIndex];
    if (!o || o.type !== 'move' || !o.target) continue;
    const point = o.target.clone();
    if ((point.x - u.pos.x) * ctx.s < 4) continue;
    const po = passOdds(m, u, point, { awareness: aw, samples: 80 });
    // Can an opponent beat the runner to the spot?
    const mineT = q.pos.distanceTo(point) / q.speed(o.sprint);
    let contest = 1;
    for (const r of ctx.opp) {
      const theirT = r.pos.distanceTo(point) / r.speed(true);
      if (theirT < mineT - 0.2) contest *= 0.35;
      else if (theirT < mineT + 0.3) contest *= 0.7;
    }
    const p = po.p * contest;
    const U = (p * spotValue(ctx, point) - (1 - p) * lossCost(ctx, u.pos)) * passMul;
    opts.push({ U: U + noise(), order: newOrder('through', { point, target: null, timing: 'start' }) });
  }

  // Dribbles.
  const dribMul = (1.2 - 0.4 * tempo) * GAMMA;
  const drib = dribbleTargets(ctx, u, 1);
  for (const t of drib) {
    const keep = keepOdds(m, u, u.pos, t, aw);
    const U = (keep * spotValue(ctx, t) - (1 - keep) * lossCost(ctx, t)) * dribMul;
    opts.push({ U: U + noise(), order: newOrder('dribble', { target: t, sprint: u.fit > 0.6 && keep > 0.5 }) });
  }
  // Dribble then pass: carry it into space first.
  for (const leg of legs.slice(0, 3)) {
    const keep = keepOdds(m, u, u.pos, leg, aw);
    for (const q of ctx.mine) {
      if (q === u || q.isKeeper) continue;
      const o = orders[q.slotIndex];
      const dest = o && o.target ? o.target : q.pos;
      if (dest.distanceTo(leg) < 5) continue;
      const po = passOdds(m, u, dest, { from: leg, t0: legT, awareness: aw, samples: 60 });
      const p = po.p * keep;
      const U = (p * spotValue(ctx, dest) - (1 - p) * lossCost(ctx, leg)) * passMul;
      opts.push({ U: U + noise(), order: newOrder('pass', { passTo: q.id, timing: 'end', target: leg }) });
    }
  }
  // Shield it where we are (a Target is good at this).
  const keepHere = keepOdds(m, u, u.pos, u.pos, aw);
  opts.push({ U: keepHere * spotValue(ctx, u.pos) * (u.role === 'target' ? 1.1 : 0.85) * GAMMA + noise(), order: newOrder('hold') });

  opts.sort((a, b) => b.U - a.U);
  return opts[0].order;
}
