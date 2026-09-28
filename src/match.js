import * as THREE from './lib.js';
import {
  SPHERE_R, GOAL_X, GOAL_RING_R, TEAMS, FORMATION, DIFFICULTY, sideSign,
  PASS_SPEED, SHOT_SPEED, CATCH_DIST, PICKUP_DIST, TACKLE_RANGE, TACKLE_COOLDOWN,
  SHOT_MULT, SHOT_BASE, SHOT_DECAY, SPECIAL_MULT, GRIP_MULT, GRIP_SPREAD,
} from './config.js';
import { Player } from './player.js';
import { Ball } from './ball.js';
import { think } from './ai.js';

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const rand = (a, b) => a + Math.random() * (b - a);

// Owns the rules: who has the ball, what a pass/shot/tackle does, the score and clock.
export class Match {
  constructor(scene, { teamIds, humanTeam, difficulty, halfLength, spectate = false }, emit) {
    this.scene = scene;
    this.spectate = spectate;   // attract mode: both sides run on AI
    this.emit = emit;
    this.humanTeam = humanTeam;
    this.diff = DIFFICULTY[difficulty];
    this.halfLength = halfLength;
    this.teamDefs = teamIds.map((id) => TEAMS[id]);

    this.teams = [[], []];
    this.players = [];
    this.teamDefs.forEach((td, t) => {
      td.players.forEach((def, i) => {
        const p = new Player({
          team: t, index: i, def,
          colors: { color: td.color, trim: td.trim, skin: td.skin },
          statScale: t === humanTeam ? 1 : this.diff.aiStat,
        });
        scene.add(p.group);
        this.teams[t].push(p);
        this.players.push(p);
      });
    });
    this.keepers = this.teams.map((ps) => ps.find((p) => p.role === 'GK'));

    this.ball = new Ball(scene);
    this.score = [0, 0];
    this.half = 1;
    this.clock = halfLength;
    this.phase = 'kickoff';
    this.phaseTimer = 0;
    this.overdrive = [0, 0];
    this.stats = [0, 1].map(() => ({ shots: 0, passes: 0, tackles: 0, blocks: 0, saves: 0, possession: 0 }));
    this.human = null;
    this.passTarget = null;
    this.excitement = 0;
    this.chasers = [[], []];
    this.pressers = [[], []];

    this.startKickoff();
  }

  dispose() {
    for (const p of this.players) this.scene.remove(p.group);
    const b = this.ball;
    this.scene.remove(b.mesh, b.halo, ...b.trail);
  }

  ownGoal(team) {
    return new THREE.Vector3(-sideSign(team) * GOAL_X, 0, 0);
  }

  attackGoal(team) {
    return this.ownGoal(1 - team);
  }

  // Formation spot in world space, shifted by possession and by where the ball is.
  formationSpot(p, mode, out = new THREE.Vector3()) {
    const f = FORMATION[p.role];
    const s = sideSign(p.team);
    let [x, y, z] = f;
    if (p.role !== 'GK') {
      if (mode === 'attack') x += 8;
      else if (mode === 'defend') x -= 5;
      else if (mode === 'kickoff') x = Math.min(x * 0.6, -4);
      if (mode !== 'kickoff') {
        const b = this.ball.pos;
        x += b.x * s * 0.35;
        y += b.y * 0.3;
        z += b.z * s * 0.25;
      }
    }
    out.set(x * s, y, z * s);
    const lim = SPHERE_R - 3;
    if (out.length() > lim) out.setLength(lim);
    return out;
  }

  startKickoff() {
    this.phase = 'kickoff';
    this.phaseTimer = 2.4;
    for (const p of this.players) {
      this.formationSpot(p, 'kickoff', p.pos);
      p.vel.set(0, 0, 0);
      p.facing.set(sideSign(p.team), 0, 0);
      p.stun = 0;
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.3);
    }
    this.ball.loose(v1.set(0, 0, 0));
    this.ball.pos.set(0, -SPHERE_R + 1.2, 0);
    this.ball.launching = false;
    this.setHuman(this.teams[this.humanTeam].find((p) => p.role === 'MF'));
    this.emit('kickoff', { half: this.half });
  }

  startSecondHalf() {
    this.half = 2;
    this.clock = this.halfLength;
    this.startKickoff();
  }

  setHuman(p) {
    if (this.spectate) p = null;
    if (this.human) this.human.marker.visible = false;
    this.human = p;
    if (p) p.marker.visible = true;
    this.emit('control', { player: p });
  }

  switchHuman() {
    const team = this.teams[this.humanTeam];
    const b = this.ball.pos;
    let best = null;
    let bestD = Infinity;
    for (const p of team) {
      if (p === this.human || p.role === 'GK') continue;
      const d = p.pos.distanceToSquared(b);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) this.setHuman(best);
  }

  giveBall(p, why) {
    const prev = this.ball.lastTouch;
    this.ball.give(p);
    if (p.team === this.humanTeam && p.role !== 'GK') this.setHuman(p);
    else if (p.team !== this.humanTeam && (!prev || prev.team === this.humanTeam)) this.switchHumanNearest();
    this.emit('possession', { player: p, why });
  }

  switchHumanNearest() {
    const cur = this.human;
    this.human = null;
    this.switchHuman();
    if (!this.human) this.setHuman(cur);
    else if (cur && cur !== this.human) cur.marker.visible = false;
  }

  // Picks the teammate a pass would go to, favouring whoever lies along `hint`.
  pickPassTarget(p, hint) {
    let best = null;
    let bestScore = -Infinity;
    for (const q of this.teams[p.team]) {
      if (q === p) continue;
      v1.subVectors(q.pos, p.pos);
      const d = v1.length();
      if (d < 2) continue;
      v1.divideScalar(d);
      let score = v1.dot(hint) * 2 - d * 0.02;
      if (q.role === 'GK') score -= 1.2;
      if (score > bestScore) { bestScore = score; best = q; }
    }
    return best;
  }

  pass(p, target) {
    const ball = this.ball;
    if (ball.owner !== p || !target || this.phase !== 'play') return false;
    const dist = target.pos.distanceTo(p.pos);
    v1.copy(target.vel).multiplyScalar((dist / PASS_SPEED) * 0.8).add(target.pos);
    v1.sub(ball.pos).normalize().multiplyScalar(PASS_SPEED);
    ball.target = target;
    ball.release('pass', p, v1, p.stat('PA') * 6 + 10);
    this.emit('pass', { from: p, to: target });
    return true;
  }

  shoot(p, special = false) {
    const ball = this.ball;
    if (ball.owner !== p || this.phase !== 'play') return false;
    if (special && this.overdrive[p.team] < 1) special = false;
    if (special) this.overdrive[p.team] = 0;

    const goal = this.attackGoal(p.team);
    const keeper = this.keepers[1 - p.team];
    // Aim at the side of the ring the keeper is not covering.
    v2.set(0, keeper.pos.y, keeper.pos.z);
    if (v2.lengthSq() < 0.25) v2.set(0, rand(-1, 1), rand(-1, 1));
    v2.normalize().multiplyScalar(-GOAL_RING_R * 0.6);
    const wobble = (1.6 - p.stat('SH') * 0.07) * (special ? 0.3 : 1);
    v2.y += rand(-wobble, wobble);
    v2.z += rand(-wobble, wobble);
    const aim = v1.set(goal.x, v2.y, v2.z);
    const dir = aim.sub(ball.pos).normalize();
    const power = (p.stat('SH') * SHOT_MULT + SHOT_BASE) * (special ? SPECIAL_MULT : 1);
    ball.release('shot', p, dir.multiplyScalar(SHOT_SPEED * (special ? 1.25 : 1)), power);
    ball.special = special;
    ball.knockouts = special ? 2 : 0;
    this.stats[p.team].shots++;
    this.emit('shot', { from: p, special, power });
    return true;
  }

  // Chance a shot from p's current spot would beat the keeper, before any blocks.
  // `lane` is the power the shot is expected to lose to defenders in the way.
  shotOdds(p, lane = 0, special = false) {
    const dist = p.pos.distanceTo(this.attackGoal(p.team));
    const keeper = this.keepers[1 - p.team];
    let est = (p.stat('SH') * SHOT_MULT + SHOT_BASE) * (special ? SPECIAL_MULT : 1);
    est -= dist * SHOT_DECAY + lane;
    const lo = keeper.stat('CA') * GRIP_MULT * GRIP_SPREAD[0];
    const hi = keeper.stat('CA') * GRIP_MULT * GRIP_SPREAD[1];
    return THREE.MathUtils.clamp((est - lo) / (hi - lo), 0, 1);
  }

  tackle(p) {
    if (p.tackleCd > 0 || p.stun > 0 || this.phase !== 'play') return false;
    const carrier = this.ball.owner;
    p.lunge = 1;
    if (!carrier || carrier.team === p.team || carrier.pos.distanceTo(p.pos) > TACKLE_RANGE) {
      p.tackleCd = 0.6;
      return false;
    }
    p.tackleCd = TACKLE_COOLDOWN;
    const at = p.stat('AT');
    const en = carrier.stat('EN');
    const tired = 1 - carrier.hp / carrier.maxHp;
    const chance = THREE.MathUtils.clamp(0.5 + (at - en) * 0.05 + tired * 0.4, 0.15, 0.92);
    carrier.hp = Math.max(0, carrier.hp - at * 3);
    if (Math.random() < chance) {
      carrier.stun = 0.9;
      carrier.grabCd = 0.9;
      this.giveBall(p, 'tackle');
      this.stats[p.team].tackles++;
      this.addOverdrive(p.team, 0.05);
      this.emit('tackle', { by: p, on: carrier });
    } else {
      p.stun = 0.7;
      this.emit('breakthrough', { by: carrier, on: p });
    }
    return true;
  }

  addOverdrive(team, amount) {
    const before = this.overdrive[team];
    this.overdrive[team] = Math.min(1, before + amount);
    if (before < 1 && this.overdrive[team] >= 1) this.emit('overdrive', { team });
  }

  update(dt) {
    this.excitement = Math.max(0, this.excitement - dt * 0.25);
    if (this.phase === 'halftime' || this.phase === 'fulltime') {
      this.stepBodies(dt);
      return;
    }

    if (this.phase === 'kickoff') {
      this.phaseTimer -= dt;
      for (const p of this.players) p.desired.set(0, 0, 0);
      if (this.phaseTimer <= 0) {
        this.ball.loose(v1.set(rand(-1.2, 1.2), 17, rand(-1.2, 1.2)));
        this.ball.launching = true;
        this.phase = 'play';
        this.emit('whistle', {});
      }
    } else if (this.phase === 'goal') {
      this.phaseTimer -= dt;
      for (const p of this.players) p.desired.multiplyScalar(0.9);
      if (this.phaseTimer <= 0) {
        if (this.clock <= 0) this.endHalf();
        else this.startKickoff();
      }
    } else if (this.phase === 'play') {
      this.clock -= dt;
      if (this.ball.owner) this.stats[this.ball.owner.team].possession += dt;
      this.assignRoles();
      for (const p of this.players) {
        if (p !== this.human) think(this, p, dt);
      }
      if (this.clock <= 0) {
        this.clock = 0;
        this.endHalf();
        return;
      }
    }

    this.stepBodies(dt);
    if (this.phase === 'play') this.updateBall(dt);
    else this.ball.update(dt, performance.now() / 1000);

    if (this.human && this.ball.owner === this.human) {
      this.passTarget = this.pickPassTarget(this.human, this.human.aimHint || this.human.facing);
    } else this.passTarget = null;
    for (const p of this.players) p.targetRing.visible = p === this.passTarget;
  }

  endHalf() {
    this.emit('whistle', { long: true });
    if (this.half === 1) {
      this.phase = 'halftime';
      this.emit('halftime', {});
    } else {
      this.phase = 'fulltime';
      this.emit('fulltime', {});
    }
    this.ball.loose(v1.set(0, 0, 0));
  }

  // Decides, once per frame, who chases a loose ball and who presses the carrier.
  assignRoles() {
    const b = this.ball;
    for (let t = 0; t < 2; t++) {
      const field = this.teams[t].filter((p) => p.role !== 'GK' && p.stun <= 0);
      field.sort((a, c) => a.pos.distanceToSquared(b.pos) - c.pos.distanceToSquared(b.pos));
      this.chasers[t] = field.slice(0, 2);
      const presserCount = this.diff.aggression >= 0.7 ? 2 : 1;
      this.pressers[t] = field.slice(0, presserCount);
    }
  }

  stepBodies(dt) {
    const ball = this.ball;
    const carrier = ball.owner;
    if (carrier) {
      // A carrier with a defender on them is held up, like an encounter in the original.
      carrier.marked = this.teams[1 - carrier.team].some((q) => q.stun <= 0 && q.pos.distanceTo(carrier.pos) < 2.3);
    }
    for (const p of this.players) p.step(dt, ball.owner === p);
    // Keep swimmers from overlapping.
    const ps = this.players;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        v1.subVectors(ps[i].pos, ps[j].pos);
        const d = v1.length();
        if (d < 1.3 && d > 1e-4) {
          v1.multiplyScalar((1.3 - d) / d * 0.5);
          ps[i].pos.add(v1);
          ps[j].pos.sub(v1);
        }
      }
    }
  }

  updateBall(dt) {
    const ball = this.ball;
    const prevX = ball.pos.x;
    ball.update(dt, performance.now() / 1000);

    if (ball.state === 'loose') {
      // Whoever is closest (relative to their reach) takes it; ties go to a coin flip.
      let best = null;
      let bestScore = Infinity;
      for (const p of this.players) {
        if (p.grabCd > 0 || p.stun > 0) continue;
        const reach = p.role === 'GK' ? PICKUP_DIST + 0.4 : PICKUP_DIST;
        const d = p.pos.distanceTo(ball.pos);
        if (d > reach) continue;
        const score = d / reach + Math.random() * 0.15;
        if (score < bestScore) { bestScore = score; best = p; }
      }
      if (best) this.giveBall(best, 'pickup');
    } else if (ball.state === 'pass') {
      this.updatePass(dt);
    } else if (ball.state === 'shot') {
      this.updateShot(dt);
    }

    if (ball.state !== 'held') this.checkGoal(prevX);
  }

  updatePass(dt) {
    const ball = this.ball;
    const target = ball.target;
    const passer = ball.lastTouch;
    // Passes curl gently toward the receiver so a moving teammate can still take them.
    if (target) {
      v1.subVectors(target.pos, ball.pos);
      if (v1.dot(ball.vel) > 0) {
        v1.setLength(PASS_SPEED);
        ball.vel.lerp(v1, Math.min(1, dt * 2.2));
      }
      if (target.pos.distanceTo(ball.pos) < CATCH_DIST && target.stun <= 0) {
        this.giveBall(target, 'pass');
        this.stats[target.team].passes++;
        this.addOverdrive(target.team, 0.01);
        return;
      }
    }
    ball.power -= PASS_SPEED * dt * 0.6;
    for (const q of this.teams[1 - passer.team]) {
      if (ball.tried.has(q) || q.stun > 0) continue;
      const reach = 1.4 + q.stat('BL') * 0.05;
      if (q.pos.distanceTo(ball.pos) > reach) continue;
      ball.tried.add(q);
      q.lunge = 1;
      const cut = q.stat('BL') * 4 * rand(0.6, 1.3);
      ball.power -= cut;
      if (ball.power <= 0) {
        this.giveBall(q, 'intercept');
        this.stats[q.team].blocks++;
        this.addOverdrive(q.team, 0.06);
        this.emit('intercept', { by: q });
        return;
      }
      this.emit('deflect', { by: q, cut: Math.round(cut), left: Math.round(ball.power) });
    }
    if (ball.power <= 0 || ball.travelled > 55) ball.loose(ball.vel.multiplyScalar(0.35));
  }

  updateShot(dt) {
    const ball = this.ball;
    const shooter = ball.lastTouch;
    const defenders = this.teams[1 - shooter.team];
    ball.power -= ball.vel.length() * dt * SHOT_DECAY;
    for (const q of defenders) {
      if (ball.tried.has(q) || q.stun > 0) continue;
      const isKeeper = q.role === 'GK';
      const reach = isKeeper ? 2.2 + q.stat('CA') * 0.07 : 1.4 + q.stat('BL') * 0.05;
      if (q.pos.distanceTo(ball.pos) > reach) continue;
      ball.tried.add(q);
      q.lunge = 1;
      if (ball.knockouts > 0 && !isKeeper) {
        ball.knockouts--;
        q.stun = 1.4;
        q.vel.copy(ball.vel).setLength(9);
        this.emit('knockback', { by: shooter, on: q });
        continue;
      }
      if (isKeeper) {
        const grip = q.stat('CA') * GRIP_MULT * rand(GRIP_SPREAD[0], GRIP_SPREAD[1]);
        if (ball.power > grip) {
          q.stun = 0.6;
          this.emit('beaten', { keeper: q, power: Math.round(ball.power), grip: Math.round(grip) });
        } else {
          this.giveBall(q, 'save');
          q.decisionCd = 1.0;
          this.stats[q.team].saves++;
          this.addOverdrive(q.team, 0.05);
          this.emit('save', { keeper: q, power: Math.round(ball.power), grip: Math.round(grip) });
          return;
        }
      } else {
        const cut = q.stat('BL') * 5 * rand(0.6, 1.3);
        ball.power -= cut;
        if (ball.power <= 0) {
          this.giveBall(q, 'block');
          this.stats[q.team].blocks++;
          this.addOverdrive(q.team, 0.06);
          this.emit('block', { by: q });
          return;
        }
        this.emit('deflect', { by: q, cut: Math.round(cut), left: Math.round(ball.power) });
      }
    }
    if (ball.power <= 0) {
      ball.loose(ball.vel.multiplyScalar(0.25));
      this.emit('fizzle', {});
    }
  }

  checkGoal(prevX) {
    const b = this.ball.pos;
    if (Math.abs(b.x) < GOAL_X || Math.abs(prevX) >= GOAL_X) return;
    if (Math.hypot(b.y, b.z) > GOAL_RING_R) return;
    // Ball entered the +x goal: team 1 defends it, so team 0 scores.
    const scorer = b.x > 0 ? 0 : 1;
    this.score[scorer]++;
    this.excitement = 1;
    this.phase = 'goal';
    this.phaseTimer = 3.6;
    const by = this.ball.lastTouch;
    this.ball.loose(this.ball.vel.multiplyScalar(0.1));
    this.ball.pos.x = Math.sign(b.x) * (GOAL_X + 0.6);
    this.emit('goal', { team: scorer, by, ownGoal: by && by.team !== scorer });
  }
}
