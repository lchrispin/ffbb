import * as THREE from './lib.js';
import { BALL_R, SPHERE_R } from './config.js';

// Ball states:
//   held  - owner is carrying it
//   pass  - flying to a teammate (target)
//   shot  - flying at a goal
//   loose - drifting, anyone can grab it
export class Ball {
  constructor(scene) {
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.state = 'loose';
    this.owner = null;
    this.lastTouch = null;   // player who last carried, passed or shot
    this.target = null;      // intended receiver of a pass
    this.power = 0;          // remaining strength of a pass or shot
    this.special = false;    // a charged special shot
    this.travelled = 0;
    this.tried = new Set();  // defenders who already had a go at this pass/shot

    const tex = makeBallTexture();
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 24, 16),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, metalness: 0.05, emissive: 0x2a2000, emissiveIntensity: 0.4 })
    );
    scene.add(this.mesh);

    const glow = document.createElement('canvas');
    glow.width = glow.height = 64;
    const g = glow.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,240,170,0.9)');
    grd.addColorStop(1, 'rgba(255,200,80,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const glowTex = new THREE.CanvasTexture(glow);
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55 }));
    this.halo.scale.setScalar(1.6);
    scene.add(this.halo);

    // Short comet trail for passes and shots.
    this.trailN = 18;
    this.trail = [];
    const trailMat = new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    for (let i = 0; i < this.trailN; i++) {
      const s = new THREE.Sprite(trailMat.clone());
      s.visible = false;
      scene.add(s);
      this.trail.push(s);
    }
    this.trailHead = 0;
    this.trailTimer = 0;
  }

  give(player) {
    this.owner = player;
    this.state = 'held';
    this.launching = false;
    this.target = null;
    this.special = false;
    this.lastTouch = player;
    this.vel.set(0, 0, 0);
  }

  release(state, from, vel, power) {
    this.owner = null;
    this.state = state;
    this.lastTouch = from;
    this.vel.copy(vel);
    this.power = power;
    this.travelled = 0;
    this.tried.clear();
    if (from) from.grabCd = 0.45;
  }

  loose(vel) {
    this.owner = null;
    this.state = 'loose';
    this.target = null;
    this.special = false;
    this.vel.copy(vel);
  }

  update(dt, time) {
    if (this.state === 'held' && this.owner) {
      this.owner.handPos(this.pos);
      this.vel.copy(this.owner.vel);
    } else {
      this.pos.addScaledVector(this.vel, dt);
      this.travelled += this.vel.length() * dt;
      // A kickoff launch rises undamped from the floor of the sphere until it reaches the centre.
      if (this.launching && this.pos.y >= 0) this.launching = false;
      if (this.state === 'loose' && !this.launching) this.vel.multiplyScalar(Math.exp(-dt * 1.1));
      const lim = SPHERE_R - 0.5;
      const len = this.pos.length();
      if (len > lim) {
        // bounce softly off the water's surface tension
        const n = this.pos.clone().normalize();
        this.pos.copy(n).multiplyScalar(lim);
        const vn = this.vel.dot(n);
        if (vn > 0) this.vel.addScaledVector(n, -1.6 * vn);
        if (this.state !== 'loose') this.loose(this.vel.multiplyScalar(0.5));
      }
    }
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.x += this.vel.z * dt * 2;
    this.mesh.rotation.z -= this.vel.x * dt * 2;
    this.halo.position.copy(this.pos);
    const flying = this.state === 'pass' || this.state === 'shot';
    this.halo.material.opacity = flying ? 0.9 : 0.45 + Math.sin(time * 5) * 0.1;
    this.halo.scale.setScalar(this.special ? 3.2 : flying ? 2 : 1.4);

    this.trailTimer -= dt;
    if (flying && this.trailTimer <= 0) {
      this.trailTimer = 0.016;
      const s = this.trail[this.trailHead];
      s.position.copy(this.pos);
      s.visible = true;
      s.userData.life = 1;
      s.material.color.setHex(this.special ? 0xff7a3a : this.state === 'shot' ? 0xffd46a : 0xaef4ff);
      this.trailHead = (this.trailHead + 1) % this.trailN;
    }
    for (const s of this.trail) {
      if (!s.visible) continue;
      s.userData.life -= dt * 3;
      if (s.userData.life <= 0) { s.visible = false; continue; }
      s.material.opacity = s.userData.life * 0.7;
      s.scale.setScalar((this.special ? 1.8 : 0.9) * s.userData.life);
    }
  }
}

function makeBallTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#f7e7b0';
  x.fillRect(0, 0, 256, 128);
  // Seam bands in the Blitzball colours.
  x.fillStyle = '#e6a52a';
  for (let i = 0; i < 4; i++) x.fillRect(i * 64 + 8, 0, 20, 128);
  x.fillStyle = '#2a64c9';
  x.fillRect(0, 56, 256, 16);
  x.fillStyle = '#ffffff';
  x.fillRect(0, 60, 256, 3);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
