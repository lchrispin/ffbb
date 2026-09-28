import * as THREE from './lib.js';

// Passing lanes drawn during an encounter: a thin beam from the carrier to each
// teammate, green for safe through amber to red for likely intercepted.

const up = new THREE.Vector3(0, 1, 0);
const d = new THREE.Vector3();
const q = new THREE.Quaternion();
const safe = new THREE.Color(0x67e6a4);
const risky = new THREE.Color(0xe8b64a);
const lost = new THREE.Color(0xff6b5e);

export class Lanes {
  constructor(scene, count = 5) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    geo.translate(0, 0.5, 0);
    this.beams = [];
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false, fog: false }));
      m.renderOrder = 6;
      m.visible = false;
      scene.add(m);
      this.beams.push(m);
    }
  }

  hide() {
    for (const b of this.beams) b.visible = false;
  }

  // lanes: [{ from: Player, to: Player, odds, hot }]
  update(lanes, time) {
    this.beams.forEach((b, i) => {
      const l = lanes[i];
      b.visible = !!l;
      if (!l) return;
      d.subVectors(l.to.pos, l.from.pos);
      const len = d.length();
      b.position.copy(l.from.pos);
      b.quaternion.copy(q.setFromUnitVectors(up, d.divideScalar(len)));
      const r = l.hot ? 0.09 : 0.045;
      b.scale.set(r, len, r);
      const c = b.material.color;
      if (l.odds >= 0.5) c.copy(risky).lerp(safe, (l.odds - 0.5) * 2);
      else c.copy(lost).lerp(risky, l.odds * 2);
      b.material.opacity = (l.hot ? 0.85 : 0.5) + Math.sin(time * 6 + i) * 0.08;
    });
  }
}
