import * as THREE from './lib.js';
import { SPHERE_R, GOAL_X, GOAL_RING_R, TACKLE_RANGE, AI_TEMPO, HOLD, sideSign } from './config.js';

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();

// Steers `p` toward `target`, arriving gently. Returns the distance left.
function seek(p, target, arriveRadius = 2) {
  v1.subVectors(target, p.pos);
  const d = v1.length();
  if (d < 0.05) { p.desired.set(0, 0, 0); return d; }
  p.desired.copy(v1).multiplyScalar(Math.min(1, d / arriveRadius) / d);
  return d;
}

function nearestOpponent(m, p, from = p.pos) {
  let best = null;
  let bestD = Infinity;
  for (const q of m.teams[1 - p.team]) {
    const d = q.pos.distanceTo(from);
    if (d < bestD) { bestD = d; best = q; }
  }
  return { player: best, dist: bestD };
}

// Distance from point c to segment ab.
function segDist(a, b, c) {
  v3.subVectors(b, a);
  const len2 = v3.lengthSq();
  let t = len2 > 0 ? v2.subVectors(c, a).dot(v3) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return v2.copy(a).addScaledVector(v3, t).distanceTo(c);
}

// How much a pass or shot along a→b would lose to the opponents standing near its line.
// A defender on Hold covers a wider lane.
export function laneCost(m, team, a, b) {
  let cost = 0;
  for (const q of m.teams[1 - team]) {
    if (q.role === 'GK') continue;
    const r = 3.5 + (q.hold > 0 ? HOLD.reach : 0);
    const d = segDist(a, b, q.pos);
    if (d < r) cost += q.stat('BL') * (r - d) * 1.6;
  }
  return cost;
}

export function think(m, p, dt) {
  const ball = m.ball;
  p.decisionCd -= dt;
  p.sprint = false;
  if (p.stun > 0) { p.desired.set(0, 0, 0); return; }

  if (ball.owner === p) return carrier(m, p);
  if (p.role === 'GK') return keeper(m, p);

  const flying = ball.state === 'pass' || ball.state === 'shot';
  const ours = ball.owner ? ball.owner.team === p.team : flying && ball.lastTouch && ball.lastTouch.team === p.team;

  if (flying) {
    if (ball.target === p) {
      // Meet the pass instead of waiting for it.
      v1.copy(ball.pos).addScaledVector(ball.vel, 0.3);
      seek(p, v1, 0.5);
      p.sprint = true;
      return;
    }
    if (!ours) {
      // Throw yourself into the lane if you can get there.
      v2.copy(ball.vel).normalize();
      v1.subVectors(p.pos, ball.pos);
      const along = v1.dot(v2);
      if (along > 0) {
        v3.copy(ball.pos).addScaledVector(v2, along);
        const gap = v3.distanceTo(p.pos);
        const timeToArrive = along / ball.vel.length();
        if (gap < p.maxSpeed * timeToArrive * 1.4 + 1.5 && gap < 9) {
          seek(p, v3, 0.3);
          p.sprint = true;
          return;
        }
      }
    }
    return support(m, p, ours ? 'attack' : 'defend');
  }

  if (ball.state === 'loose') {
    if (m.chasers[p.team].includes(p)) {
      v1.copy(ball.pos).addScaledVector(ball.vel, 0.7);
      const d = seek(p, v1, 0.4);
      p.sprint = d > 4 && p.hp > p.maxHp * 0.3;
      return;
    }
    return support(m, p, 'neutral');
  }

  if (ours) return support(m, p, 'attack');

  // Opponent has the ball.
  const carrierP = ball.owner;
  if (m.pressers[p.team].includes(p)) {
    // Come at the carrier from the goal side.
    v1.copy(m.ownGoal(p.team)).sub(carrierP.pos).setLength(0.8).add(carrierP.pos);
    const d = seek(p, v1, 0.5);
    p.sprint = d > 5 && p.hp > p.maxHp * 0.4;
    // While the human's carrier is in an encounter, the duel is settled by the wheel.
    const waiting = m.encounter && m.encounter.player === carrierP;
    if (!waiting && carrierP.pos.distanceTo(p.pos) < TACKLE_RANGE * 0.95 && p.tackleCd <= 0 && p.decisionCd <= 0) {
      p.decisionCd = m.diff.react * AI_TEMPO;
      if (Math.random() < m.diff.aggression) m.tackle(p);
    }
    return;
  }
  return mark(m, p);
}

function support(m, p, mode) {
  const spot = m.formationSpot(p, mode, v1);
  if (mode === 'attack') {
    // Drift away from whoever is marking us so there's a passing lane.
    const { player: opp, dist } = nearestOpponent(m, p);
    if (opp && dist < 4.5) {
      v2.subVectors(p.pos, opp.pos).setLength((4.5 - dist) * 1.2);
      spot.add(v2);
    }
    // Forwards push up hard when a teammate is near the goal.
    if ((p.role === 'LF' || p.role === 'RF') && m.ball.owner) {
      const s = sideSign(p.team);
      spot.x = s * Math.max(s * spot.x, Math.min(GOAL_X - 7, s * m.ball.pos.x + 4));
    }
  }
  clampInside(spot, 2.5);
  seek(p, spot, 3);
}

function mark(m, p) {
  // Defenders drop into the shooting lane once the carrier gets close to goal.
  const carrierP = m.ball.owner;
  if (carrierP && (p.role === 'LD' || p.role === 'RD')) {
    const own = m.ownGoal(p.team);
    const d = carrierP.pos.distanceTo(own);
    if (d < 17) {
      const t = p.role === 'LD' ? 0.4 : 0.6;
      v1.lerpVectors(own, carrierP.pos, t);
      v1.addScaledVector(v2.set(0, p.role === 'LD' ? 0.6 : -0.6, 0), 1);
      seek(p, v1, 0.8);
      p.sprint = true;
      return;
    }
  }
  const targetRole = m.marks[p.team][p.role];
  const opp = targetRole && m.teams[1 - p.team].find((q) => q.role === targetRole);
  if (!opp) return support(m, p, 'defend');
  v1.copy(m.ownGoal(p.team)).sub(opp.pos).setLength(2.2).add(opp.pos);
  const d = seek(p, v1, 1.5);
  p.sprint = d > 8;
}

function clampInside(v, margin) {
  const lim = SPHERE_R - margin;
  if (v.length() > lim) v.setLength(lim);
}

function carrier(m, p) {
  const s = sideSign(p.team);
  const goal = m.attackGoal(p.team);
  const dist = p.pos.distanceTo(goal);

  // Head for a point just in front of the goal mouth, bending around defenders.
  v1.set(s * (GOAL_X - 6), goal.y, goal.z);
  v1.sub(p.pos).normalize();
  for (const q of m.teams[1 - p.team]) {
    v2.subVectors(p.pos, q.pos);
    const d = v2.length();
    if (d < 6 && d > 0.01) v1.addScaledVector(v2, (6 - d) / (d * 6) * 1.4);
  }
  p.desired.copy(v1).normalize();
  const { dist: pressure } = nearestOpponent(m, p);
  p.sprint = pressure < 5 && p.hp > p.maxHp * 0.45;

  // Frozen mid-decision while the human's defender is choosing how to take us on.
  if (p.decisionCd > 0 || m.phase !== 'play' || (m.encounter && m.encounter.foes.includes(p))) return;
  p.decisionCd = (0.35 + m.diff.react + Math.random() * 0.4) * AI_TEMPO;

  const lane = laneCost(m, p.team, p.pos, goal) * 0.8;
  const odds = m.shotOdds(p, lane);
  const range = 8 + p.stat('SH') * 0.55;

  if (m.overdrive[p.team] >= 1 && dist < range + 4 && m.shotOdds(p, lane, true) > 0.6) {
    m.shoot(p, true);
    return;
  }
  // Speculative efforts keep keepers busy even when the odds are poor.
  const hopeful = dist < range * 0.8 && Math.random() < 0.2;
  if (dist < range && (odds > 0.15 || (odds > 0.05 && pressure < 2.4) || hopeful)) {
    m.shoot(p, false);
    return;
  }

  const tired = p.hp < p.maxHp * 0.25;
  const stuck = dist < range + 2 && Math.random() < 0.3;
  if (pressure < 3.4 || tired || stuck || (dist > range && Math.random() < 0.18)) {
    let best = null;
    let bestScore = -Infinity;
    const myProgress = s * p.pos.x;
    for (const q of m.teams[p.team]) {
      if (q === p || q.stun > 0) continue;
      const d = q.pos.distanceTo(p.pos);
      if (d < 4 || d > 32) continue;
      const openness = Math.min(6, nearestOpponent(m, q).dist);
      const progress = s * q.pos.x - myProgress;
      let score = openness * 1.4 + progress * 0.25 - laneCost(m, p.team, p.pos, q.pos) * 0.12;
      if (q.role === 'GK') score -= 6;
      if (score > bestScore) { bestScore = score; best = q; }
    }
    if (best && (bestScore > 2 || pressure < 2.2 || tired)) m.pass(p, best);
  }
}

function keeper(m, p) {
  const ball = m.ball;
  const own = m.ownGoal(p.team);
  const s = sideSign(p.team);

  if (ball.owner === p) {
    seek(p, v1.copy(own).setX(-s * (GOAL_X - 2.5)), 1);
    if (p.decisionCd <= 0) {
      let best = null;
      let bestD = -Infinity;
      for (const q of m.teams[p.team]) {
        if (q === p) continue;
        const open = nearestOpponent(m, q).dist;
        if (open > bestD) { bestD = open; best = q; }
      }
      m.pass(p, best);
    }
    return;
  }

  // Incoming shot: dive for where it will cross the goal plane.
  if (ball.state === 'shot' && ball.lastTouch && ball.lastTouch.team !== p.team && Math.sign(ball.vel.x) === -s) {
    const planeX = -s * (GOAL_X - 1.4);
    const t = (planeX - ball.pos.x) / ball.vel.x;
    if (t > 0) {
      v1.copy(ball.pos).addScaledVector(ball.vel, t);
      limitToMouth(v1, planeX);
      seek(p, v1, 0.3);
      p.sprint = true;
      return;
    }
  }

  if (ball.state === 'loose' && ball.pos.distanceTo(own) < 8) {
    seek(p, ball.pos, 0.4);
    p.sprint = true;
    return;
  }

  // Shadow the ball across the mouth of the goal.
  const planeX = -s * (GOAL_X - 1.6);
  v1.set(planeX, ball.pos.y * 0.35, ball.pos.z * 0.35);
  limitToMouth(v1, planeX);
  seek(p, v1, 1.2);
}

function limitToMouth(v, planeX) {
  v.x = planeX;
  const r = Math.hypot(v.y, v.z);
  const max = GOAL_RING_R * 0.85;
  if (r > max) { v.y *= max / r; v.z *= max / r; }
}
