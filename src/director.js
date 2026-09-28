import * as THREE from './lib.js';
import { SPHERE_R, GOAL_X, sideSign } from './config.js';

// A camera that directs itself, like a match broadcast.
//   play:      frames the ball (or carrier) and the goal it threatens, from whichever
//              side of that axis hides the fewest players. It turns slowly and never
//              crosses the axis smoothly (the 180° rule); big changes are hard cuts.
//   encounter: over the shoulder of the human's swimmer, facing the challenge.
//   shot:      rides behind the ball in slow motion as it runs the gauntlet.
//   overview:  pulled right out of the sphere for a wide look.
// Every cut bumps `cuts`, so movement can hold its old mapping until the stick is released.

const UP = new THREE.Vector3(0, 1, 0);
const INSIDE = SPHERE_R - 1.6;           // keep inside the water, clear of the shell
const TURN_RATE = 0.4;                   // rad/s: the most the play camera turns smoothly
const CUT_ANGLE = 0.9;                   // rad: past this the play camera cuts instead
const RATES = { play: 8, encounter: 6, shot: 9, overview: 3.5, goal: 4, orbit: 7, kickoff: 3 };

const t1 = new THREE.Vector3();
const t2 = new THREE.Vector3();
const t3 = new THREE.Vector3();
const axis = new THREE.Vector3();
const perp = new THREE.Vector3();
const quat = new THREE.Quaternion();

// Largest t with |f + d t| <= r (d unit length).
function room(f, d, r) {
  const b = f.dot(d);
  const c = f.lengthSq() - r * r;
  const disc = b * b - c;
  return disc < 0 ? 0 : -b + Math.sqrt(disc);
}

export class Director {
  constructor(camera) {
    this.camera = camera;
    this.pos = new THREE.Vector3(0, 10, 50);
    this.look = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.targetLook = new THREE.Vector3();
    this.focus = new THREE.Vector3();
    this.dir = new THREE.Vector3(0, 0.3, 1).normalize();   // play: unit offset from focus to camera
    this.dist = 13;
    this.elev = 0.3;
    this.goalSide = 1;
    this.goalHold = 0;
    this.shot = 'orbit';
    this.cuts = 0;
    this.cutCd = 0;
    this.snap = true;
    this.betterFor = 0;
    this.evalT = 0;
    this.scores = { side: 1, cur: 0, other: 0 };
    this.nudge = { yaw: 0, pitch: 0, idle: 1 };
    this.orbit = 0;
    this.tail = 0;
    this.shotDir = new THREE.Vector3(1, 0, 0);
    this.shotSide = 1;
  }

  // A hard cut: the next frame jumps straight to the new framing.
  cut() {
    this.cuts++;
    this.snap = true;
    this.cutCd = 0.8;
  }

  // Mouse/touch/arrow nudges; they spring back once input stops.
  addNudge(yaw, pitch) {
    const n = this.nudge;
    n.yaw = THREE.MathUtils.clamp(n.yaw + yaw, -1.1, 1.1);
    n.pitch = THREE.MathUtils.clamp(n.pitch + pitch, -0.6, 0.6);
    n.idle = 0;
  }

  // Camera-relative movement basis: flattened forward and right.
  basis(fwd, right) {
    this.camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    right.crossVectors(fwd, UP).normalize();
  }

  // ctx: { mode, overview, goalCam, trackShot, focusPlayer, time }
  update(dt, m, ctx) {
    this.cutCd = Math.max(0, this.cutCd - dt);
    const n = this.nudge;
    n.idle += dt;
    if (n.idle > 0.2) {
      const k = Math.exp(-dt * 4);
      n.yaw *= k;
      n.pitch *= k;
    }

    const shot = this.pickShot(m, ctx);
    if (shot !== this.shot) {
      const smooth = shot === 'overview' || this.shot === 'overview';
      if (shot === 'shot') this.enterShot(m);
      if (!smooth) this.cut();
      if (shot === 'play') this.resetPlay(m);
      this.shot = shot;
    }

    switch (shot) {
      case 'orbit': this.frameOrbit(dt); break;
      case 'goal': this.frameGoal(m, ctx); break;
      case 'overview': this.frameOverview(); break;
      case 'kickoff': this.frameKickoff(); break;
      case 'encounter': this.frameEncounter(m); break;
      case 'shot': this.frameShot(m, dt); break;
      default: this.framePlay(m, dt, false);
    }

    this.applyNudge(shot);
    if (shot !== 'orbit' && shot !== 'overview') this.clearView(m, { play: 1.6, shot: 3, encounter: 2.4 }[shot] || 2);

    if (this.snap) {
      this.snap = false;
      this.pos.copy(this.target);
      this.look.copy(this.targetLook);
    } else {
      const e = 1 - Math.exp(-dt * RATES[shot]);
      this.pos.lerp(this.target, e);
      this.look.lerp(this.targetLook, e);
    }
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }

  pickShot(m, ctx) {
    if (ctx.mode === 'attract' || ctx.mode === 'interval' || !m.human) return 'orbit';
    if (m.phase === 'goal' && ctx.goalCam) return 'goal';
    if (ctx.overview) return 'overview';
    if (m.phase === 'kickoff') return 'kickoff';
    if (m.encounter) return 'encounter';
    if (m.ball.state === 'shot' && ctx.trackShot) { this.tail = 0.7; return 'shot'; }
    if (this.shot === 'shot' && this.tail > 0 && m.phase === 'play') return 'shot';
    return 'play';
  }

  // ---------- play ----------

  // The subject (carrier or ball) and the goal it threatens, with a little hysteresis
  // so a scramble doesn't flip the framing back and forth.
  subject(m, dt) {
    const ball = m.ball;
    let gs;
    if (ball.owner) gs = sideSign(ball.owner.team);
    else if (ball.lastTouch && (ball.state === 'pass' || ball.state === 'shot')) gs = sideSign(ball.lastTouch.team);
    else gs = ball.pos.x >= 0 ? 1 : -1;
    if (gs !== this.goalSide) {
      this.goalHold += dt;
      if (this.goalHold > 0.7 || dt === 0) { this.goalSide = gs; this.goalHold = 0; }
    } else this.goalHold = 0;
    const s = ball.owner ? ball.owner.pos : ball.pos;
    axis.set(this.goalSide * GOAL_X, 0, 0).sub(s);
    const len = axis.length();
    if (len < 0.5) axis.set(this.goalSide, 0, 0);
    else axis.divideScalar(len);
    perp.crossVectors(axis, UP);
    if (perp.lengthSq() < 1e-3) perp.set(0, 0, 1);
    perp.normalize();
    return { s, len };
  }

  // Unit offset from the focus to the camera on side `side` of the goal axis.
  sideDir(out, side, elev) {
    return out.copy(perp).multiplyScalar(side * Math.cos(elev)).addScaledVector(UP, Math.sin(elev)).addScaledVector(axis, -0.75).normalize();
  }

  // How many players would be hidden behind others from camera position c.
  occlusion(m, c, subjectPos) {
    const ps = m.players;
    let n = 0;
    for (let i = 0; i < ps.length; i++) {
      t1.subVectors(ps[i].pos, c);
      const li = t1.length();
      if (li < 2.5) n += 2;
      for (let j = i + 1; j < ps.length; j++) {
        t2.subVectors(ps[j].pos, c);
        const lj = t2.length();
        const cos = t1.dot(t2) / (li * lj);
        const size = 0.75 / Math.min(li, lj);
        if (cos > Math.cos(size)) n += (ps[i].pos === subjectPos || ps[j].pos === subjectPos) ? 2 : 1;
      }
    }
    return n;
  }

  candidate(m, s, focus, side, out) {
    let best = Infinity;
    let bestElev = 0.3;
    for (const elev of [0.2, 0.5]) {
      this.sideDir(t3, side, elev);
      const r = Math.min(this.idealDist, room(focus, t3, INSIDE));
      const c = t2.copy(focus).addScaledVector(t3, r);
      const score = this.occlusion(m, c.clone(), s) + (r < 7 ? (7 - r) * 0.8 : 0);
      if (score < best) { best = score; bestElev = elev; }
    }
    out.elev = bestElev;
    return best;
  }

  resetPlay(m) {
    this.framePlay(m, 0, true);
  }

  framePlay(m, dt, reset) {
    const { s, len } = this.subject(m, reset ? 0 : dt);
    this.subjectPos = m.ball.owner ? m.ball.owner.pos : m.ball.pos;
    this.idealDist = THREE.MathUtils.clamp(7 + len * 0.3, 9, 16);
    const focus = t1.copy(s).addScaledVector(axis, Math.min(len * 0.35, 6));
    const f = focus.clone();

    // The side we're on is whichever the camera is already nearest to.
    let side = Math.sign(this.dir.dot(perp)) || 1;
    this.evalT -= dt;
    if (reset || this.evalT <= 0) {
      this.evalT = 0.25;
      const cur = {};
      const oth = {};
      const a = this.candidate(m, s, f, side, cur);
      const b = this.candidate(m, s, f, -side, oth);
      this.scores = { side, cur: a, other: b, elev: [cur.elev, oth.elev] };
      // Switching sides is only ever a cut, and only when it's clearly worth it.
      if (!reset && b + 2 <= a) this.betterFor += 0.25;
      else this.betterFor = 0;
      if (reset && b + 1 <= a) side = -side;
      if (this.betterFor >= 1.5 && this.cutCd <= 0) {
        side = -side;
        this.betterFor = 0;
        this.cut();
        reset = true;
      }
    }
    const sc = this.scores;
    const elev = sc.side === side ? sc.elev[0] : sc.elev[1];
    this.elev += (elev - this.elev) * (reset ? 1 : Math.min(1, dt * 0.8));
    const want = this.sideDir(t2, side, this.elev);

    const angle = this.dir.angleTo(want);
    if (reset || this.snap) {
      this.dir.copy(want);
      this.focus.copy(f);
    } else if (angle > CUT_ANGLE && this.cutCd <= 0) {
      this.dir.copy(want);
      this.focus.copy(f);
      this.cut();
    } else if (angle > 1e-4) {
      // Turn toward the new framing no faster than TURN_RATE.
      const step = Math.min(angle, TURN_RATE * dt) / angle;
      t3.crossVectors(this.dir, want).normalize();
      if (t3.lengthSq() > 0.5) this.dir.applyQuaternion(quat.setFromAxisAngle(t3, angle * step)).normalize();
      this.focus.lerp(f, 1 - Math.exp(-dt * 2.5));
    } else this.focus.lerp(f, 1 - Math.exp(-dt * 2.5));

    const r = Math.min(this.idealDist, room(this.focus, this.dir, INSIDE));
    this.dist += (Math.max(3, r) - this.dist) * (reset ? 1 : Math.min(1, dt * 1.5));
    this.dist = Math.min(this.dist, r);
    this.target.copy(this.focus).addScaledVector(this.dir, this.dist);
    this.targetLook.copy(this.focus);
  }

  // ---------- special shots ----------

  frameEncounter(m) {
    const e = m.encounter;
    const h = e.player;
    const threat = t1.set(0, 0, 0);
    if (e.foes.length) {
      for (const q of e.foes.slice(0, 3)) threat.add(q.pos);
      threat.divideScalar(Math.min(3, e.foes.length));
    } else threat.copy(m.attackGoal(h.team));
    const toward = t2.subVectors(threat, h.pos);
    const span = toward.length();
    if (span < 0.3) toward.copy(h.facing);
    toward.normalize();
    const shoulder = t3.crossVectors(toward, UP);
    if (shoulder.lengthSq() < 1e-3) shoulder.set(0, 0, 1);
    shoulder.normalize();
    // Stay on the shoulder nearest the camera so the cut in reads naturally.
    if (shoulder.dot(axis.subVectors(this.pos, h.pos)) < 0) shoulder.negate();
    this.target.copy(h.pos).addScaledVector(toward, -5.6).addScaledVector(shoulder, 2).addScaledVector(UP, 2.2);
    if (this.target.length() > INSIDE) this.target.setLength(INSIDE);
    this.targetLook.copy(h.pos).addScaledVector(toward, Math.min(span, 8) * 0.45).addScaledVector(UP, 0.4);
    this.subjectPos = h.pos;
  }

  enterShot(m) {
    const b = m.ball;
    if (b.vel.lengthSq() > 0.01) this.shotDir.copy(b.vel).normalize();
    t1.crossVectors(this.shotDir, UP);
    this.shotSide = t1.dot(t2.subVectors(this.pos, b.pos)) >= 0 ? 1 : -1;
  }

  frameShot(m, dt) {
    const b = m.ball;
    if (b.state === 'shot' && b.vel.lengthSq() > 0.01) this.shotDir.copy(b.vel).normalize();
    else this.tail -= dt;
    const side = t1.crossVectors(this.shotDir, UP);
    if (side.lengthSq() < 1e-3) side.set(0, 0, 1);
    side.normalize().multiplyScalar(this.shotSide);
    if (b.state === 'shot') {
      this.target.copy(b.pos).addScaledVector(this.shotDir, -5.5).addScaledVector(side, 2.3).addScaledVector(UP, 1.8);
      this.targetLook.copy(b.pos).addScaledVector(this.shotDir, 7);
    } else this.targetLook.copy(b.pos);
    this.subjectPos = b.pos;
    if (this.target.length() > INSIDE) this.target.setLength(INSIDE);
  }

  frameOverview() {
    const flat = t1.copy(this.dir);
    flat.y = 0;
    if (flat.lengthSq() < 1e-3) flat.set(0, 0, 1);
    flat.normalize();
    this.target.copy(flat).multiplyScalar(60).addScaledVector(UP, 28);
    this.targetLook.set(0, -3, 0);
  }

  // Kickoff: a wide side-on shot with the teams lined up and the ball on the floor.
  frameKickoff() {
    const side = Math.sign(this.pos.z) || 1;
    this.target.set(0, -2, 27.5 * side);
    this.targetLook.set(0, this.camera.aspect < 1 ? -7 : -10, 0);
  }

  frameGoal(m, ctx) {
    const focus = ctx.focusPlayer ? ctx.focusPlayer.pos : m.ball.pos;
    const a = ctx.time * 0.5;
    this.target.set(Math.cos(a) * 7, 2.5, Math.sin(a) * 7).add(focus);
    if (this.target.length() > INSIDE) this.target.setLength(INSIDE);
    this.targetLook.copy(focus);
  }

  frameOrbit(dt) {
    this.orbit += dt * 0.08;
    const o = this.orbit;
    this.target.set(Math.cos(o) * 58, 14 + Math.sin(o * 0.7) * 8, Math.sin(o) * 58);
    this.targetLook.set(0, -2, 0);
  }

  // Nudges swing the camera round its look point.
  applyNudge(shot) {
    const n = this.nudge;
    if (shot === 'orbit' || (Math.abs(n.yaw) < 1e-3 && Math.abs(n.pitch) < 1e-3)) return;
    t1.subVectors(this.target, this.targetLook);
    t1.applyAxisAngle(UP, n.yaw);
    t2.crossVectors(t1, UP);
    if (t2.lengthSq() > 1e-4) t1.applyAxisAngle(t2.normalize(), n.pitch);
    this.target.copy(this.targetLook).add(t1);
    if (shot !== 'overview' && this.target.length() > INSIDE) this.target.setLength(INSIDE);
  }

  // Never park the camera inside a swimmer, and lift it over anyone who'd block the
  // view of the subject from close range.
  clearView(m, radius) {
    const subject = this.subjectPos;
    t3.subVectors(this.targetLook, this.target).normalize();
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const p of m.players) {
        if (p.pos === subject) continue;
        t1.subVectors(this.target, p.pos);
        const d = t1.length();
        if (d < radius) {
          this.target.addScaledVector(d > 1e-3 ? t1.divideScalar(d) : UP, radius - d);
          moved = true;
        } else if (subject && d < radius * 2 && -t1.dot(t3) > d * 0.75) {
          // Close and dead ahead: this swimmer would fill the frame. Rise over them.
          this.target.addScaledVector(UP, 0.9);
          moved = true;
        } else if (subject) {
          t2.subVectors(subject, this.target);
          const len = t2.length();
          const along = -t1.dot(t2) / len;
          if (along > 0 && along < len - 1 && t1.addScaledVector(t2, along / len).length() < 0.9) {
            this.target.addScaledVector(UP, 1.1);
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
    if (this.target.length() > INSIDE) this.target.setLength(INSIDE);
    this.subjectPos = null;
  }
}
