import * as THREE from './lib.js';
import { SPHERE_R, PLAYER_MARGIN } from './config.js';

const tmp = new THREE.Vector3();

export class Player {
  constructor({ team, index, def, colors, statScale = 1 }) {
    this.team = team;
    this.index = index;
    this.def = def;
    this.role = def.role;
    this.name = def.name;
    this.statScale = statScale;
    this.maxHp = def.HP;
    this.hp = def.HP;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.facing = new THREE.Vector3(team === 0 ? 1 : -1, 0, 0);
    this.desired = new THREE.Vector3();  // velocity the brain (AI or human) asks for
    this.sprint = false;

    this.stun = 0;          // seconds unable to act after losing a tackle
    this.tackleCd = 0;
    this.grabCd = 0;        // blocks re-grabbing a ball this player just released
    this.lunge = 0;         // visual burst when tackling/blocking
    this.decisionCd = Math.random() * 0.4;
    this.swimPhase = Math.random() * 10;
    this.upright = 1;
    this.marked = false;

    this.group = new THREE.Group();
    this.group.rotation.order = 'YXZ';
    this.body = new THREE.Group();
    this.group.add(this.body);
    this.buildMesh(colors);
    this.label = makeLabel(def, colors.color);
    this.label.position.set(0, 1.35, 0);
    this.group.add(this.label);
  }

  stat(key) {
    return this.def[key] * this.statScale;
  }

  get maxSpeed() {
    return 4.6 + this.stat('SP') * 0.36;
  }

  buildMesh({ color, trim, skin }) {
    const jersey = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.1 });
    const trimMat = new THREE.MeshStandardMaterial({ color: trim, roughness: 0.5 });
    const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.7 });
    const hairMat = new THREE.MeshStandardMaterial({ color: this.role === 'GK' ? 0x2a2a2a : trim, roughness: 0.8 });

    const torsoGeo = new THREE.CapsuleGeometry(0.3, 0.75, 6, 12);
    torsoGeo.rotateX(Math.PI / 2);
    const torso = new THREE.Mesh(torsoGeo, jersey);
    this.body.add(torso);

    const shorts = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.29, 0.3, 12), trimMat);
    shorts.rotation.x = Math.PI / 2;
    shorts.position.z = -0.42;
    this.body.add(shorts);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 16, 12), skinMat);
    head.position.z = 0.8;
    this.body.add(head);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.245, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat);
    hair.position.z = 0.83;
    hair.rotation.x = Math.PI / 2 + 0.3;
    this.body.add(hair);

    const limbGeo = (len, r) => {
      const g = new THREE.CapsuleGeometry(r, len, 4, 8);
      g.rotateX(Math.PI / 2);
      g.translate(0, 0, -len / 2 - r);
      return g;
    };
    this.arms = [];
    for (const s of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.38, 0, 0.42);
      const arm = new THREE.Mesh(limbGeo(0.55, 0.09), skinMat);
      pivot.add(arm);
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.12, 8), jersey);
      cuff.rotation.x = Math.PI / 2;
      cuff.position.z = -0.08;
      pivot.add(cuff);
      this.body.add(pivot);
      this.arms.push(pivot);
    }
    this.legs = [];
    for (const s of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.15, 0, -0.55);
      const leg = new THREE.Mesh(limbGeo(0.7, 0.11), skinMat);
      pivot.add(leg);
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.04, 0.32), trimMat);
      fin.position.z = -1.0;
      pivot.add(fin);
      this.body.add(pivot);
      this.legs.push(pivot);
    }

    // Marker shown over whichever swimmer the human currently controls.
    const cone = new THREE.ConeGeometry(0.22, 0.4, 3);
    cone.rotateX(Math.PI);
    this.marker = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({ color: 0x7ff3ff, transparent: true, opacity: 0.95, depthTest: false }));
    this.marker.renderOrder = 20;
    this.marker.visible = false;
    this.group.add(this.marker);

    // Ring drawn around the teammate a pass would go to.
    this.targetRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.85, 0.05, 6, 32),
      new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9, depthTest: false })
    );
    this.targetRing.renderOrder = 19;
    this.targetRing.visible = false;
    this.group.add(this.targetRing);
  }

  handPos(out) {
    return out.copy(this.facing).multiplyScalar(0.75).add(this.pos);
  }

  // Integrates movement toward this.desired and keeps the swimmer inside the sphere.
  step(dt, hasBall) {
    this.stun = Math.max(0, this.stun - dt);
    this.tackleCd = Math.max(0, this.tackleCd - dt);
    this.grabCd = Math.max(0, this.grabCd - dt);
    this.lunge = Math.max(0, this.lunge - dt * 3);

    let top = this.maxSpeed;
    if (hasBall) top *= this.marked ? 0.72 : 0.9;
    const tired = this.hp / this.maxHp;
    if (tired < 0.35) top *= 0.72 + tired * 0.8;
    const sprinting = this.sprint && this.hp > 5 && this.desired.lengthSq() > 0.01;
    if (sprinting) top *= 1.38;
    if (this.stun > 0) top *= 0.2;

    tmp.copy(this.desired);
    const d = tmp.length();
    if (d > 1) tmp.multiplyScalar(1 / d);
    tmp.multiplyScalar(top);
    const accel = this.stun > 0 ? 1.5 : 3.2;
    this.vel.lerp(tmp, Math.min(1, dt * accel));
    if (this.lunge > 0) this.vel.addScaledVector(this.facing, this.lunge * dt * 20);

    this.pos.addScaledVector(this.vel, dt);

    // Stamina: carrying drains it, sprinting drains it hard, resting refills it.
    const speed = this.vel.length();
    let drain = 0;
    if (hasBall) drain += speed * 0.5;
    if (sprinting) drain += 9;
    if (drain > 0) this.hp = Math.max(0, this.hp - drain * dt);
    else this.hp = Math.min(this.maxHp, this.hp + (3 + this.stat('EN') * 0.35) * dt);

    const limit = SPHERE_R - PLAYER_MARGIN;
    const len = this.pos.length();
    if (len > limit) {
      this.pos.multiplyScalar(limit / len);
      tmp.copy(this.pos).normalize();
      const out = this.vel.dot(tmp);
      if (out > 0) this.vel.addScaledVector(tmp, -out);
    }

    if (speed > 0.6) {
      tmp.copy(this.vel).normalize();
      this.facing.lerp(tmp, Math.min(1, dt * 6)).normalize();
    }
  }

  updateVisual(dt, time, camera) {
    const speed = this.vel.length();
    this.group.position.copy(this.pos);
    const f = this.facing;
    const pitch = Math.asin(THREE.MathUtils.clamp(f.y, -0.95, 0.95));
    this.group.rotation.set(-pitch * (1 - this.upright * 0.8), Math.atan2(f.x, f.z), 0);

    const targetUpright = speed > 2.2 ? 0 : 1 - speed / 2.2;
    this.upright += (targetUpright - this.upright) * Math.min(1, dt * 3);
    this.body.rotation.x = -Math.PI / 2 * this.upright * 0.85;

    const rate = 3 + speed * 1.1;
    this.swimPhase += dt * rate;
    const p = this.swimPhase;
    const kick = 0.25 + Math.min(1, speed / 6) * 0.3;
    this.legs[0].rotation.x = Math.sin(p * 2) * kick;
    this.legs[1].rotation.x = -Math.sin(p * 2) * kick;
    if (this.upright > 0.6) {
      // treading water: arms scull out to the sides
      this.arms[0].rotation.set(Math.PI * 0.5 + Math.sin(p) * 0.25, 0, -0.9);
      this.arms[1].rotation.set(Math.PI * 0.5 - Math.sin(p) * 0.25, 0, 0.9);
    } else {
      // freestyle: windmill arms, half a stroke apart
      this.arms[0].rotation.set(p, 0, 0);
      this.arms[1].rotation.set(p + Math.PI, 0, 0);
    }
    if (this.lunge > 0.2) {
      this.arms[0].rotation.set(Math.PI, 0, -0.3);
      this.arms[1].rotation.set(Math.PI, 0, 0.3);
    }
    this.body.rotation.z = this.stun > 0 ? Math.sin(time * 18) * 0.4 : 0;

    // Keep the label and markers upright in screen space regardless of body pitch.
    this.label.quaternion.copy(this.group.quaternion).invert().multiply(camera.quaternion);
    this.marker.position.set(0, 1.95 + Math.sin(time * 4) * 0.1, 0);
    this.marker.quaternion.copy(this.label.quaternion);
    this.marker.rotateY(time * 3);
    this.targetRing.quaternion.copy(this.label.quaternion);
    this.targetRing.scale.setScalar(1 + Math.sin(time * 6) * 0.08);
  }
}

function makeLabel(def, color) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const x = c.getContext('2d');
  x.font = '600 30px "Barlow Semi Condensed", "Arial Narrow", sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  const text = `${def.num} ${def.name.toUpperCase()}`;
  x.lineWidth = 6;
  x.strokeStyle = 'rgba(2,14,24,0.85)';
  x.strokeText(text, 128, 34);
  x.fillStyle = '#' + new THREE.Color(color).getHexString();
  x.fillText(text, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.9, 0.475),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false })
  );
  mesh.renderOrder = 18;
  return mesh;
}
