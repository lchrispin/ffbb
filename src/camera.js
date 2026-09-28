import * as THREE from './lib.js';
import { SPHERE_R, GOAL_X, sideSign } from './config.js';

// Two camera behaviours:
//  orbit    - planning: drag to orbit the sphere centre or a player, wheel to zoom.
//  director - playback: framed broadcast shots that cut rather than whip, with a
//             reverse angle on shots and an orbit round the scorer on goals.

const tmp = new THREE.Vector3();
const ndc = new THREE.Vector3();

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'orbit';
    this.orbit = { target: new THREE.Vector3(0, -2, 0), yaw: 0, pitch: 0.42, dist: 66 };
    this.goal = { target: new THREE.Vector3(), yaw: 0, pitch: 0.42, dist: 66 };
    this.follow = null;          // () => Vector3, the thing the orbit centres on
    this.shot = { pos: new THREE.Vector3(), look: new THREE.Vector3(), lookGoal: new THREE.Vector3() };
    this.celebrate = null;
    this.reset(true);
  }

  // Broadcast view: from the +z side, high, the whole sphere in frame.
  reset(snap = false) {
    this.follow = null;
    Object.assign(this.goal, { yaw: 0, pitch: 0.36, dist: this.camera.aspect < 0.8 ? 86 : 54 });
    this.goal.target.set(0, -1, 0);
    if (snap) {
      this.orbit.target.copy(this.goal.target);
      Object.assign(this.orbit, { yaw: this.goal.yaw, pitch: this.goal.pitch, dist: this.goal.dist });
    }
  }

  focusOn(fn) {
    this.follow = fn;
    if (fn) this.goal.dist = Math.min(this.goal.dist, 30);
  }

  rotate(dx, dy) {
    this.goal.yaw -= dx * 0.006;
    this.goal.pitch = THREE.MathUtils.clamp(this.goal.pitch + dy * 0.005, -1.35, 1.45);
  }

  zoom(f) {
    this.goal.dist = THREE.MathUtils.clamp(this.goal.dist * f, 6, 130);
  }

  orbitPos(o, out) {
    return out.set(
      Math.sin(o.yaw) * Math.cos(o.pitch),
      Math.sin(o.pitch),
      Math.cos(o.yaw) * Math.cos(o.pitch),
    ).multiplyScalar(o.dist).add(o.target);
  }

  // ---------- director ----------

  // Wide shot framing the ball and the goal it is heading for, from the broadcast side.
  wide(ball, team) {
    const s = team == null ? Math.sign(ball.x || 1) : sideSign(team);
    const goalX = s * GOAL_X;
    const goal = new THREE.Vector3(goalX, 0, 0);
    const focus = tmp.lerpVectors(ball, goal, 0.35);
    const side = ball.z > 8 ? -1 : 1;
    // Far enough back to hold ball and goal in one frame, but inside the sphere.
    const dist = THREE.MathUtils.clamp(ball.distanceTo(goal) * 0.75 + 8, 14, 34);
    const dir = new THREE.Vector3(-s * 0.35, 0.4, side).normalize();
    this.shot.pos.copy(focus).addScaledVector(dir, dist);
    if (this.shot.pos.length() > SPHERE_R - 2) this.shot.pos.setLength(SPHERE_R - 2);
    this.shot.look.copy(focus);
    this.shot.lookGoal.copy(focus);
    this.cutNow = true;
  }

  // Reverse angle from beside the goal, looking back up the line of the shot.
  shotCam(from, team) {
    const s = sideSign(team);
    const goal = tmp.set(s * GOAL_X, 0, 0);
    const back = new THREE.Vector3().subVectors(from, goal).normalize();
    const side = new THREE.Vector3(0, 1, 0).cross(back).normalize();
    if (side.lengthSq() < 0.1) side.set(0, 0, 1);
    this.shot.pos.copy(goal).addScaledVector(back, 7).addScaledVector(side, 8).add(new THREE.Vector3(0, 3.5, 0));
    this.shot.pos.x = THREE.MathUtils.clamp(this.shot.pos.x, -GOAL_X + 1, GOAL_X - 1);
    this.shot.look.lerpVectors(from, goal, 0.55);
    this.shot.lookGoal.copy(this.shot.look);
    this.cutNow = true;
  }

  startCelebration(center) {
    this.celebrate = { center: center.clone(), angle: Math.atan2(this.camera.position.z - center.z, this.camera.position.x - center.x) };
  }

  // Keeps the ball framed; returns true if it had to cut.
  direct(dt, ball, team) {
    if (this.celebrate) {
      const c = this.celebrate;
      c.angle += dt * 0.7;
      this.camera.position.set(c.center.x + Math.cos(c.angle) * 10, c.center.y + 3, c.center.z + Math.sin(c.angle) * 10);
      this.camera.position.clampLength(0, SPHERE_R - 1);
      this.camera.lookAt(c.center);
      return false;
    }
    // Track the ball gently; cut to a fresh wide shot when it drifts out of frame.
    ndc.copy(ball).project(this.camera);
    const off = Math.abs(ndc.x) > 0.8 || Math.abs(ndc.y) > 0.78 || ndc.z > 1;
    if (off && !this.cutNow) this.wide(ball, team);
    this.shot.lookGoal.lerp(tmp.copy(ball), Math.min(1, dt * 0.9));
    if (this.cutNow) {
      this.cutNow = false;
      this.camera.position.copy(this.shot.pos);
      this.shot.look.copy(this.shot.lookGoal);
      this.camera.lookAt(this.shot.look);
      return true;
    }
    this.shot.look.lerp(this.shot.lookGoal, Math.min(1, dt * 2.2));
    this.camera.position.copy(this.shot.pos);
    this.camera.lookAt(this.shot.look);
    return false;
  }

  update(dt) {
    if (this.mode !== 'orbit') return;
    if (this.follow) this.goal.target.copy(this.follow());
    const e = 1 - Math.exp(-dt * 8);
    const o = this.orbit;
    const g = this.goal;
    o.target.lerp(g.target, e);
    o.yaw += (g.yaw - o.yaw) * e;
    o.pitch += (g.pitch - o.pitch) * e;
    o.dist += (g.dist - o.dist) * e;
    this.orbitPos(o, this.camera.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(o.target);
  }
}
