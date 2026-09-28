import * as THREE from './lib.js';
import {
  SPHERE_R, GOAL_X, GOAL_RING_R, TEAMS, FORMATIONS, DEFAULT_MARKS, DIFFICULTY, sideSign,
  PASS_SPEED, SHOT_SPEED, PASS_DECAY, LAUNCH_SPEED, CATCH_DIST, PICKUP_DIST, TACKLE_RANGE, TACKLE_COOLDOWN,
  SHOT_MULT, SHOT_BASE, SHOT_DECAY, SPECIAL_MULT, GRIP_MULT, GRIP_SPREAD,
  ENCOUNTER, SLOW, VENOM, HOLD,
} from './config.js';
import { Player } from './player.js';
import { Ball } from './ball.js';
import { think, laneCost } from './ai.js';

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = THREE.MathUtils.clamp;

// Where c sits relative to segment ab: distance from the line and distance along it.
function segInfo(a, b, c) {
  v3.subVectors(b, a);
  const len = v3.length();
  let t = len > 0 ? v2.subVectors(c, a).dot(v3) / (len * len) : 0;
  t = clamp(t, 0, 1);
  return { gap: v2.copy(a).addScaledVector(v3, t).distanceTo(c), along: t * len };
}

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

    // Per-team tactics: a formation preset and who marks whom.
    this.formation = [FORMATIONS.balanced, FORMATIONS.balanced];
    this.marks = [{ ...DEFAULT_MARKS }, { ...DEFAULT_MARKS }];

    // Game time runs at timeScale × real time. Anything can ask for slow motion by
    // key; the slowest active request wins and the scale eases toward it.
    this.timeScale = 1;
    this.slows = new Map();

    // The open encounter (command wheel), if any, and the cooldown before another.
    this.encounter = null;
    this.encounterCd = 0;

    this.startKickoff();
  }

  // Asks for slow motion at `scale` for `seconds` of real time (Infinity: until cleared).
  slow(key, scale, seconds = Infinity) {
    this.slows.set(key, { scale, t: seconds });
  }

  unslow(key) {
    this.slows.delete(key);
  }

  tickTime(realDt) {
    let target = 1;
    for (const [key, s] of this.slows) {
      s.t -= realDt;
      if (s.t <= 0) this.slows.delete(key);
      else target = Math.min(target, s.scale);
    }
    this.timeScale += (target - this.timeScale) * (1 - Math.exp(-realDt * 12));
    if (Math.abs(target - this.timeScale) < 0.004) this.timeScale = target;
  }

  setTactics(team, formationId, marks) {
    this.formation[team] = FORMATIONS[formationId] || FORMATIONS.balanced;
    if (marks) this.marks[team] = { ...marks };
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
    const form = this.formation[p.team];
    const s = sideSign(p.team);
    let [x, y, z] = form.spots[p.role];
    if (p.role !== 'GK') {
      if (mode === 'attack') x += form.push;
      else if (mode === 'defend') x -= form.drop;
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
      p.venom = 0;
      p.hold = 0;
      p.burst = 0;
      p.touching = false;
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.3);
    }
    this.closeEncounter(false);
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
    const best = this.switchCandidate();
    if (best) this.setHuman(best);
  }

  giveBall(p, why) {
    const prev = this.ball.lastTouch;
    this.ball.give(p);
    for (const q of this.players) q.touching = false;
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

  passPower(p) {
    return p.stat('PA') * 6 + 10;
  }

  pass(p, target) {
    const ball = this.ball;
    if (ball.owner !== p || !target || this.phase !== 'play') return false;
    const dist = target.pos.distanceTo(p.pos);
    v1.copy(target.vel).multiplyScalar((dist / PASS_SPEED) * 0.8).add(target.pos);
    v1.sub(ball.pos).normalize().multiplyScalar(PASS_SPEED);
    ball.target = target;
    const power = this.passPower(p);
    ball.release('pass', p, v1, power);
    this.emit('pass', { from: p, to: target, power });
    return true;
  }

  // Chance a pass from p to q gets through, from the same block model updatePass
  // uses: each opponent who can reach the lane in time takes BL × 4 × roll off it.
  passOdds(p, q, samples = 240) {
    const from = p.pos;
    const to = q.pos;
    const dist = from.distanceTo(to);
    const base = this.passPower(p) - dist * PASS_DECAY;
    if (base <= 0 || q.stun > 0) return 0;
    const risks = [];
    for (const o of this.teams[1 - p.team]) {
      if (o.stun > 0) continue;
      const reach = this.blockReach(o);
      const { gap, along } = segInfo(from, to, o.pos);
      const range = reach + o.maxSpeed * (along / PASS_SPEED) * 0.6;
      if (gap > range) continue;
      risks.push({ touch: gap <= reach ? 1 : 1 - (gap - reach) / (range - reach), bl: o.stat('BL') });
    }
    if (!risks.length) return 1;
    let ok = 0;
    for (let i = 0; i < samples; i++) {
      let pw = base;
      for (const r of risks) {
        if (Math.random() < r.touch) pw -= r.bl * 4 * rand(0.6, 1.3);
        if (pw <= 0) break;
      }
      if (pw > 0) ok++;
    }
    return ok / samples;
  }

  // How far from a pass or shot a defender can still get a touch on it.
  blockReach(q) {
    return 1.4 + q.stat('BL') * 0.05 + (q.hold > 0 ? HOLD.reach : 0);
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

  // AT against EN; a tired carrier is easier to rob.
  tackleChance(p, carrier) {
    const tired = 1 - carrier.hp / carrier.maxHp;
    return clamp(0.5 + (p.stat('AT') - carrier.stat('EN')) * 0.05 + tired * 0.4, 0.15, 0.92);
  }

  tackle(p, { reach = TACKLE_RANGE, venom = false } = {}) {
    if (p.tackleCd > 0 || p.stun > 0 || this.phase !== 'play') return false;
    const carrier = this.ball.owner;
    p.lunge = 1;
    if (!carrier || carrier.team === p.team || carrier.pos.distanceTo(p.pos) > reach) {
      p.tackleCd = 1.0;
      return false;
    }
    p.tackleCd = TACKLE_COOLDOWN;
    const at = p.stat('AT');
    const en = carrier.stat('EN');
    const chance = this.tackleChance(p, carrier);
    carrier.hp = Math.max(0, carrier.hp - at * 3);
    if (venom) {
      carrier.venom = VENOM.time;
      p.hp = Math.max(0, p.hp - VENOM.cost);
      this.emit('venom', { by: p, on: carrier });
    }
    const won = Math.random() < chance;
    this.emit('duel', { kind: 'tackle', att: p, def: carrier, a: `AT ${Math.round(at)}`, b: `EN ${Math.round(en)}`, won, chance });
    if (won) {
      carrier.stun = 1.6;
      carrier.grabCd = 1.6;
      this.giveBall(p, 'tackle');
      this.stats[p.team].tackles++;
      this.addOverdrive(p.team, 0.05);
      this.emit('tackle', { by: p, on: carrier, venom });
    } else {
      p.stun = 1.2;
      this.emit('breakthrough', { by: carrier, on: p });
    }
    return true;
  }

  // Dribble through an encounter: every defender in range gets one tackle roll, in
  // order of distance. Beat them all and they're left flailing while you surge on.
  dribble(p, foes) {
    const inRange = foes.filter((q) => q.stun <= 0 && q.pos.distanceTo(p.pos) < q.encRadius + 0.6)
      .sort((a, b) => a.pos.distanceTo(p.pos) - b.pos.distanceTo(p.pos));
    for (const q of inRange) {
      q.tackleCd = 0;
      q.lunge = 1;
      this.tackle(q, { reach: q.encRadius + 0.6 });
      if (this.ball.owner !== p) return false;
    }
    p.burst = 1.4;
    if (inRange.length) this.addOverdrive(p.team, 0.03);
    return true;
  }

  // ---------- encounters and the command wheel ----------

  // Opponents close enough to matter in an encounter with p, nearest first.
  foesNear(p, extra = 2.5) {
    return this.teams[1 - p.team]
      .filter((q) => q.role !== 'GK' && q.stun <= 0 && q.pos.distanceTo(p.pos) < q.encRadius + extra)
      .sort((a, b) => a.pos.distanceTo(p.pos) - b.pos.distanceTo(p.pos));
  }

  // Watches for a new defender touching the human's carrier (or the human's defender
  // reaching the opposing carrier) and opens an encounter when one does.
  checkEncounters(dt) {
    this.encounterCd = Math.max(0, this.encounterCd - dt);
    for (const p of this.players) p.encCd = Math.max(0, p.encCd - dt);
    const h = this.human;
    const carrier = this.ball.owner;
    if (!h || this.spectate) return;
    if (carrier === h) {
      const fresh = [];
      for (const q of this.teams[1 - h.team]) {
        const touching = q.role !== 'GK' && q.stun <= 0 && q.pos.distanceTo(h.pos) < q.encRadius;
        if (touching && !q.touching && q.encCd <= 0) fresh.push(q);
        q.touching = touching;
      }
      if (fresh.length && !this.encounter && this.encounterCd <= 0) this.openEncounter('attack', fresh);
    } else if (carrier && carrier.team !== h.team && carrier.role !== 'GK') {
      const touching = h.stun <= 0 && carrier.pos.distanceTo(h.pos) < h.encRadius;
      if (touching && !carrier.touching && carrier.encCd <= 0 && !this.encounter && this.encounterCd <= 0) {
        this.openEncounter('defend', [carrier]);
      }
      carrier.touching = touching;
    }
  }

  // The human pressed the command button: open the wheel whether or not anyone is close.
  openCommand() {
    const h = this.human;
    if (!h || this.encounter || this.phase !== 'play' || this.encounterCd > ENCOUNTER.globalCd - ENCOUNTER.commandCd) return false;
    const owner = this.ball.owner;
    if (owner === h) return this.openEncounter('attack', [], true);
    if (owner && owner.team === h.team) return false;
    return this.openEncounter('defend', owner ? [owner] : [], true);
  }

  openEncounter(kind, trigger, manual = false) {
    const h = this.human;
    const foes = kind === 'attack' ? this.foesNear(h) : trigger;
    for (const q of trigger) if (!foes.includes(q)) foes.unshift(q);
    this.encounter = { kind, player: h, foes, trigger, manual };
    this.slow('encounter', SLOW.wheel);
    this.emit('encounter', this.encounter);
    return true;
  }

  // Everything the wheel shows: four slots (up, right, down, left) with odds and duels.
  commandOptions() {
    const e = this.encounter;
    if (!e) return null;
    const h = e.player;
    if (e.kind === 'attack') {
      const goal = this.attackGoal(h.team);
      const lane = laneCost(this, h.team, h.pos, goal) * 0.8;
      const keeper = this.keepers[1 - h.team];
      const est = Math.max(0, Math.round(h.stat('SH') * SHOT_MULT + SHOT_BASE - h.pos.distanceTo(goal) * SHOT_DECAY - lane));
      const grip = [GRIP_SPREAD[0], GRIP_SPREAD[1]].map((g) => Math.round(keeper.stat('CA') * GRIP_MULT * g));
      const mates = this.teams[h.team].filter((q) => q !== h).map((q) => ({
        id: 'pass', target: q, label: q.name, role: q.role,
        odds: this.passOdds(h, q), detail: `${Math.round(q.pos.distanceTo(h.pos))} m · PA ${Math.round(h.stat('PA'))}`,
      })).sort((a, b) => b.odds - a.odds);
      const near = e.foes.filter((q) => q.pos.distanceTo(h.pos) < q.encRadius + 0.6);
      let breakOdds = 1;
      for (const q of near) breakOdds *= 1 - this.tackleChance(q, h);
      const full = this.overdrive[h.team] >= 1;
      return [
        { id: 'pass', label: 'Pass', odds: mates[0] ? mates[0].odds : 0, detail: mates[0] ? `best: ${mates[0].label}` : '', sub: mates },
        { id: 'shoot', label: 'Shoot', odds: this.shotOdds(h, lane), detail: `SH ${Math.round(h.stat('SH'))} · ${est} vs grip ${grip[0]}–${grip[1]}` },
        near.length
          ? { id: 'dribble', label: 'Break', odds: breakOdds, detail: `EN ${Math.round(h.stat('EN'))} vs AT ${near.map((q) => Math.round(q.stat('AT'))).join(' + ')}` }
          : { id: 'dribble', label: 'Dribble', odds: null, detail: 'No one in range' },
        { id: 'jecht', label: 'Jecht Shot', odds: full ? this.shotOdds(h, lane, true) : null, disabled: !full,
          detail: full ? `Tech · SH ×${SPECIAL_MULT}, bursts 2 blockers` : `Tech · meter ${Math.round(this.overdrive[h.team] * 100)}%` },
      ];
    }
    const carrier = this.ball.owner && this.ball.owner.team !== h.team ? this.ball.owner : null;
    const dist = carrier ? carrier.pos.distanceTo(h.pos) : Infinity;
    const reach = h.encRadius + 0.6;
    const can = carrier && dist <= reach && h.tackleCd <= 0 && h.stun <= 0;
    const duel = carrier ? `AT ${Math.round(h.stat('AT'))} vs EN ${Math.round(carrier.stat('EN'))}` : 'No carrier';
    const why = !carrier ? 'No carrier' : dist > reach ? `${Math.round(dist)} m away` : h.tackleCd > 0 ? 'Recovering' : '';
    const odds = carrier ? this.tackleChance(h, carrier) : null;
    const mate = this.switchCandidate();
    return [
      { id: 'tackle', label: 'Tackle', odds: can ? odds : null, disabled: !can, detail: can ? duel : why },
      { id: 'venom', label: 'Venom Tackle', odds: can ? odds : null, disabled: !can || h.hp < VENOM.cost,
        detail: can ? `Tech · ${duel} · −${VENOM.cost} HP, poisons` : why },
      { id: 'hold', label: 'Hold', odds: null, detail: `Block the lane · reach +${HOLD.reach} m` },
      { id: 'switch', label: 'Switch', odds: null, disabled: !mate, detail: mate ? `to ${mate.name}` : '' },
    ];
  }

  defaultCommand() {
    if (!this.encounter) return null;
    if (this.encounter.kind === 'attack') return { id: 'dribble' };
    const opts = this.commandOptions();
    return opts[0].disabled ? { id: 'hold' } : { id: 'tackle' };
  }

  // Carries out a wheel choice and closes the encounter.
  resolveCommand(choice) {
    const e = this.encounter;
    if (!e) return;
    const h = e.player;
    const c = choice || this.defaultCommand();
    this.closeEncounter(true);
    if (this.phase !== 'play') return;
    const reach = h.encRadius + 0.6;
    switch (c.id) {
      case 'pass': this.pass(h, c.target); break;
      case 'shoot': this.shoot(h, false); break;
      case 'jecht': this.shoot(h, true); break;
      case 'dribble': if (this.ball.owner === h) this.dribble(h, e.foes); break;
      case 'tackle': this.tackle(h, { reach }); break;
      case 'venom': if (h.hp >= VENOM.cost) this.tackle(h, { reach, venom: true }); break;
      case 'hold': h.hold = HOLD.time; this.emit('hold', { by: h }); break;
      case 'switch': this.switchHuman(); break;
    }
  }

  closeEncounter(resolved) {
    const e = this.encounter;
    if (!e) return;
    this.encounter = null;
    this.unslow('encounter');
    for (const q of e.foes) q.encCd = ENCOUNTER.repeatCd;
    this.encounterCd = e.manual ? ENCOUNTER.globalCd * 0.5 : ENCOUNTER.globalCd;
    this.emit('encounterEnd', { resolved });
  }

  // An encounter ends early if the situation it was about has gone.
  validateEncounter() {
    const e = this.encounter;
    if (!e) return;
    const owner = this.ball.owner;
    const gone = this.phase !== 'play' || this.human !== e.player
      || (e.kind === 'attack' && owner !== e.player)
      || (e.kind === 'defend' && owner && owner.team === e.player.team);
    if (gone) this.closeEncounter(false);
  }

  switchCandidate() {
    const b = this.ball.pos;
    let best = null;
    let bestD = Infinity;
    for (const p of this.teams[this.humanTeam]) {
      if (p === this.human || p.role === 'GK') continue;
      const d = p.pos.distanceToSquared(b);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  addOverdrive(team, amount) {
    const before = this.overdrive[team];
    this.overdrive[team] = Math.min(1, before + amount);
    if (before < 1 && this.overdrive[team] >= 1) this.emit('overdrive', { team });
  }

  // realDt is wall-clock time; the rules run on game time (realDt × timeScale).
  update(realDt) {
    this.tickTime(realDt);
    const dt = realDt * this.timeScale;
    this.excitement = Math.max(0, this.excitement - dt * 0.25);
    if (this.phase === 'halftime' || this.phase === 'fulltime') {
      this.stepBodies(dt);
      return;
    }

    if (this.phase === 'kickoff') {
      this.phaseTimer -= dt;
      for (const p of this.players) p.desired.set(0, 0, 0);
      if (this.phaseTimer <= 0) {
        this.ball.loose(v1.set(rand(-0.6, 0.6), LAUNCH_SPEED, rand(-0.6, 0.6)));
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
      this.validateEncounter();
      this.checkEncounters(dt);
      // Alternate which team thinks first so neither side always acts first.
      this.flip = !this.flip;
      for (const t of this.flip ? [1, 0] : [0, 1]) {
        for (const p of this.teams[t]) if (p !== this.human) think(this, p, dt);
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

    this.validateEncounter();
    // The wheel sets passTarget while a teammate is highlighted in the pass list.
    if (!this.encounter) this.passTarget = null;
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
      const presserCount = this.formation[t].pressers ?? (this.diff.aggression >= 0.7 ? 2 : 1);
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
        ball.vel.lerp(v1, Math.min(1, dt * 1.1));
      }
      if (target.pos.distanceTo(ball.pos) < CATCH_DIST && target.stun <= 0) {
        this.giveBall(target, 'pass');
        this.stats[target.team].passes++;
        this.addOverdrive(target.team, 0.01);
        return;
      }
    }
    ball.power -= ball.vel.length() * dt * PASS_DECAY;
    for (const q of this.teams[1 - passer.team]) {
      if (ball.tried.has(q) || q.stun > 0) continue;
      if (q.pos.distanceTo(ball.pos) > this.blockReach(q)) continue;
      ball.tried.add(q);
      q.lunge = 1;
      const cut = q.stat('BL') * 4 * rand(0.6, 1.3);
      const before = ball.power;
      ball.power -= cut;
      if (ball.power <= 0) {
        this.giveBall(q, 'intercept');
        this.stats[q.team].blocks++;
        this.addOverdrive(q.team, 0.06);
        this.emit('intercept', { by: q, before: Math.round(before), a: `PA ${Math.round(passer.stat('PA'))}`, b: `BL ${Math.round(q.stat('BL'))}` });
        return;
      }
      this.emit('deflect', { by: q, cut: Math.round(cut), before: Math.round(before), left: Math.round(ball.power), kind: 'pass', a: `PA ${Math.round(passer.stat('PA'))}`, b: `BL ${Math.round(q.stat('BL'))}` });
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
      const reach = isKeeper ? 2.2 + q.stat('CA') * 0.07 : this.blockReach(q);
      if (q.pos.distanceTo(ball.pos) > reach) continue;
      ball.tried.add(q);
      q.lunge = 1;
      if (ball.knockouts > 0 && !isKeeper) {
        ball.knockouts--;
        q.stun = 2.5;
        q.vel.copy(ball.vel).setLength(4.5);
        this.emit('knockback', { by: shooter, on: q });
        continue;
      }
      if (isKeeper) {
        const grip = q.stat('CA') * GRIP_MULT * rand(GRIP_SPREAD[0], GRIP_SPREAD[1]);
        if (ball.power > grip) {
          q.stun = 1.1;
          this.emit('beaten', { keeper: q, power: Math.round(ball.power), grip: Math.round(grip) });
        } else {
          this.giveBall(q, 'save');
          q.decisionCd = 1.8;
          this.stats[q.team].saves++;
          this.addOverdrive(q.team, 0.05);
          this.emit('save', { keeper: q, power: Math.round(ball.power), grip: Math.round(grip) });
          return;
        }
      } else {
        const cut = q.stat('BL') * 5 * rand(0.6, 1.3);
        const before = ball.power;
        ball.power -= cut;
        const a = `SH ${Math.round(shooter.stat('SH'))}`;
        const b = `BL ${Math.round(q.stat('BL'))}`;
        if (ball.power <= 0) {
          this.giveBall(q, 'block');
          this.stats[q.team].blocks++;
          this.addOverdrive(q.team, 0.06);
          this.emit('block', { by: q, before: Math.round(before), a, b });
          return;
        }
        this.emit('deflect', { by: q, cut: Math.round(cut), before: Math.round(before), left: Math.round(ball.power), kind: 'shot', a, b });
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
