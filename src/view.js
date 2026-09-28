import * as THREE from './lib.js';
import { TICK } from './config.js';
import { Player } from './player.js';
import { Ball } from './ball.js';
import { BALL_STATES } from './match.js';

// Visual mirror of a Match: one swimmer model per unit plus the ball. In planning it
// shows the frozen state; in playback it interpolates the beat's recorded frames.

const a = new THREE.Vector3();
const b = new THREE.Vector3();

export class MatchView {
  constructor(scene) {
    this.scene = scene;
    this.players = [];
    this.ball = new Ball(scene);
    this.match = null;
  }

  attach(match) {
    this.dispose();
    this.match = match;
    this.players = match.units.map((u) => this.makePlayer(u));
    this.sync();
  }

  makePlayer(u) {
    const td = this.match.teamDefs[u.team];
    const p = new Player({ team: u.team, index: u.slotIndex, def: u.def, colors: { color: td.color, trim: td.trim, skin: td.skin } });
    p.def = u.def;
    this.scene.add(p.group);
    return p;
  }

  // Rebuild a model after a substitution.
  refresh() {
    if (!this.match) return;
    this.match.units.forEach((u, i) => {
      if (this.players[i].def !== u.def) {
        this.scene.remove(this.players[i].group);
        this.players[i] = this.makePlayer(u);
      }
    });
  }

  dispose() {
    for (const p of this.players) this.scene.remove(p.group);
    this.players = [];
  }

  colorsOf(team) {
    const td = this.match.teamDefs[team];
    return { color: td.color, trim: td.trim, skin: td.skin };
  }

  // Snap every model to the match state (planning).
  sync() {
    const m = this.match;
    m.units.forEach((u, i) => {
      const p = this.players[i];
      p.pos.copy(u.pos);
      p.vel.set(0, 0, 0);
      p.facing.copy(u.facing);
      p.stun = 0;
      p.lunge = 0;
    });
    const bl = this.ball;
    const mb = m.ball;
    bl.pos.copy(mb.pos);
    bl.vel.copy(mb.vel);
    bl.state = mb.state === 'held' ? 'held' : mb.state;
    bl.special = mb.special;
  }

  // Pose everything at time t (seconds) into a recorded beat.
  applyFrame(rec, t) {
    const n = rec.frames.length;
    const ft = Math.max(0, Math.min(n - 1, t / TICK));
    const i = Math.min(n - 2, Math.floor(ft));
    const k = ft - i;
    const f0 = rec.frames[Math.max(0, i)];
    const f1 = rec.frames[Math.min(n - 1, i + 1)];
    for (let id = 0; id < 12; id++) {
      const p = this.players[id];
      const o = id * 8;
      a.set(f0[o], f0[o + 1], f0[o + 2]);
      b.set(f1[o], f1[o + 1], f1[o + 2]);
      p.vel.subVectors(b, a).divideScalar(TICK);
      p.pos.lerpVectors(a, b, k);
      a.set(f0[o + 3], f0[o + 4], f0[o + 5]);
      b.set(f1[o + 3], f1[o + 4], f1[o + 5]);
      p.facing.lerpVectors(a, b, k).normalize();
      p.stun = f0[o + 6];
      p.lunge = f0[o + 7];
    }
    const o = 96;
    a.set(f0[o], f0[o + 1], f0[o + 2]);
    b.set(f1[o], f1[o + 1], f1[o + 2]);
    const bl = this.ball;
    bl.vel.subVectors(b, a).divideScalar(TICK);
    bl.pos.lerpVectors(a, b, k);
    bl.state = BALL_STATES[f0[o + 3]] || 'loose';
    bl.special = f0[o + 5] > 0;
    return { owner: f0[o + 4], state: bl.state };
  }

  update(dt, time, camera) {
    for (const p of this.players) p.updateVisual(dt, time, camera);
    this.ball.updateVisual(dt, time);
  }
}
