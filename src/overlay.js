import * as THREE from './lib.js';
import { SPHERE_R, GOAL_X, GOAL_RING_R } from './config.js';
import { Player } from './player.js';

// Planning overlays drawn in the 3D scene. Static guides (team halves, halfway ring,
// equator grid) plus an immediate-mode layer: each frame the caller clears it and
// draws beams, spheres, discs, rings and ghosts from small pools.

const UP = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();

function basic(color, opacity, extra = {}) {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, fog: false, ...extra,
  });
}

// A see-through sphere that is brightest at its rim, so its boundary reads from any angle.
function fresnelMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 0.5 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uOpacity;
      varying vec3 vN; varying vec3 vV;
      void main() {
        float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float a = uOpacity * (0.06 + pow(f, 3.0) * 0.9);
        gl_FragColor = vec4(uColor, a);
      }`,
  });
}

export class Overlay {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.renderOrder = 8;
    scene.add(this.root);
    this.guides = new THREE.Group();
    this.root.add(this.guides);
    this.dyn = new THREE.Group();
    this.root.add(this.dyn);
    this.teamColors = [new THREE.Color(0xf3c42f), new THREE.Color(0xd8413a)];
    this.buildGuides();
    this.buildDrops();
    this.pools = { beam: [], sphere: [], disc: [], ring: [], dot: [], cone: [] };
    this.used = {};
    this.ghosts = new Map();
    this.camera = null;
  }

  setTeams(defs) {
    this.teamColors = defs.map((d) => new THREE.Color(d.color));
    this.halves.material.uniforms.uC0.value.copy(this.teamColors[0]);
    this.halves.material.uniforms.uC1.value.copy(this.teamColors[1]);
    for (const g of this.ghosts.values()) this.scene.remove(g.group);
    this.ghosts.clear();
  }

  // ---------- static guides ----------

  buildGuides() {
    // Sphere tinted by which team defends each half.
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
      uniforms: { uC0: { value: new THREE.Color(0xf3c42f) }, uC1: { value: new THREE.Color(0xd8413a) }, uOpacity: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec3 vP; varying vec3 vN; varying vec3 vV;
        void main() {
          vP = position;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uC0; uniform vec3 uC1; uniform float uOpacity;
        varying vec3 vP; varying vec3 vN; varying vec3 vV;
        void main() {
          vec3 c = vP.x < 0.0 ? uC0 : uC1;
          float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
          float edge = 1.0 - smoothstep(0.0, 0.35, abs(vP.x));
          float a = (0.07 + pow(f, 2.2) * 0.3) * uOpacity;
          gl_FragColor = vec4(mix(c, vec3(1.0), edge * 0.5), a);
        }`,
    });
    this.halves = new THREE.Mesh(new THREE.SphereGeometry(SPHERE_R - 0.15, 64, 32), mat);
    this.halves.renderOrder = 4;
    this.guides.add(this.halves);

    const loop = (r, n, fn) => {
      const pts = [];
      for (let i = 0; i <= n; i++) pts.push(fn((i / n) * Math.PI * 2, r));
      return new THREE.BufferGeometry().setFromPoints(pts);
    };
    const lineMat = (c, o) => new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, fog: false });
    // Halfway ring: where the x = 0 plane meets the sphere.
    this.halfway = new THREE.Line(loop(SPHERE_R - 0.2, 128, (a, r) => new THREE.Vector3(0, Math.sin(a) * r, Math.cos(a) * r)), lineMat(0xffffff, 0.55));
    this.guides.add(this.halfway);
    // Equatorial plane: rim, two inner rings and the goal axis, so drop-lines have a floor to land on.
    const eq = new THREE.Group();
    eq.add(new THREE.Line(loop(SPHERE_R - 0.2, 128, (a, r) => new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)), lineMat(0x9fe9ff, 0.45)));
    for (const r of [10, 20]) eq.add(new THREE.Line(loop(r, 96, (a, rr) => new THREE.Vector3(Math.cos(a) * rr, 0, Math.sin(a) * rr)), lineMat(0x9fe9ff, 0.14)));
    const axis = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-GOAL_X, 0, 0), new THREE.Vector3(GOAL_X, 0, 0),
      new THREE.Vector3(0, 0, -SPHERE_R + 0.2), new THREE.Vector3(0, 0, SPHERE_R - 0.2),
    ]);
    eq.add(new THREE.LineSegments(axis, lineMat(0x9fe9ff, 0.18)));
    const disc = new THREE.Mesh(new THREE.CircleGeometry(SPHERE_R - 0.2, 96), basic(0x0b3a52, 0.1, { side: THREE.DoubleSide }));
    disc.rotation.x = -Math.PI / 2;
    eq.add(disc);
    this.guides.add(eq);
    // Goal mouth discs marked with the defending team's colour.
    this.mouths = [-1, 1].map((side) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(GOAL_RING_R - 0.15, GOAL_RING_R + 0.15, 48), basic(0xffffff, 0.5, { side: THREE.DoubleSide }));
      m.position.set(side * GOAL_X, 0, 0);
      m.rotation.y = Math.PI / 2;
      this.guides.add(m);
      return m;
    });
  }

  showGuides(on, strength = 1) {
    this.guides.visible = on;
    this.halves.material.uniforms.uOpacity.value = strength;
  }

  // Vertical line from every player to the equatorial plane, with a disc where it lands.
  buildDrops() {
    const n = 12;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
    this.drops = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false, fog: false }));
    this.drops.frustumCulled = false;
    this.root.add(this.drops);
    this.feet = [];
    const ringGeo = new THREE.RingGeometry(0.45, 0.7, 24);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(ringGeo, basic(0xffffff, 0.8, { side: THREE.DoubleSide }));
      m.renderOrder = 9;
      this.root.add(m);
      this.feet.push(m);
    }
  }

  updateDrops(positions, teams, on = true, feet = 0.8) {
    this.drops.visible = on;
    const pos = this.drops.geometry.attributes.position.array;
    const col = this.drops.geometry.attributes.color.array;
    for (let i = 0; i < 12; i++) {
      const p = positions[i];
      const c = this.teamColors[teams[i]];
      pos.set([p.x, p.y, p.z, p.x, 0, p.z], i * 6);
      col.set([c.r, c.g, c.b, c.r * 0.6, c.g * 0.6, c.b * 0.6], i * 6);
      const f = this.feet[i];
      f.visible = on && feet > 0;
      f.position.set(p.x, 0.02, p.z);
      f.material.color.copy(c);
      f.material.opacity = feet;
    }
    this.drops.geometry.attributes.position.needsUpdate = true;
    this.drops.geometry.attributes.color.needsUpdate = true;
  }

  // ---------- immediate-mode layer ----------

  clear() {
    for (const k in this.pools) for (const o of this.pools[k]) o.visible = false;
    this.used = {};
    for (const g of this.ghosts.values()) g.group.visible = false;
  }

  take(kind, make) {
    const i = this.used[kind] || 0;
    this.used[kind] = i + 1;
    const pool = this.pools[kind];
    if (!pool[i]) {
      const o = make();
      this.dyn.add(o);
      pool.push(o);
    }
    pool[i].visible = true;
    return pool[i];
  }

  // A thin cylinder from a to b.
  beam(a, b, color, radius = 0.06, opacity = 0.85) {
    const m = this.take('beam', () => {
      const g = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
      g.translate(0, 0.5, 0);
      const mesh = new THREE.Mesh(g, basic(0xffffff, 1));
      mesh.renderOrder = 10;
      return mesh;
    });
    tmp.subVectors(b, a);
    const len = tmp.length();
    m.visible = len > 0.01;
    m.position.copy(a);
    m.quaternion.setFromUnitVectors(UP, tmp.normalize());
    m.scale.set(radius, len, radius);
    m.material.color.set(color);
    m.material.opacity = opacity;
    return m;
  }

  // Dashed version: short beams along the line.
  dashes(a, b, color, radius = 0.05, opacity = 0.8, dash = 0.7) {
    const len = a.distanceTo(b);
    const n = Math.min(40, Math.floor(len / (dash * 2)));
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      p.lerpVectors(a, b, (i * 2 * dash) / len);
      q.lerpVectors(a, b, Math.min(1, (i * 2 * dash + dash) / len));
      this.beam(p, q, color, radius, opacity);
    }
  }

  arrow(a, b, color, radius = 0.07, opacity = 0.9) {
    const len = a.distanceTo(b);
    if (len < 0.3) return;
    const head = Math.min(0.9, len * 0.4);
    const end = tmp.copy(b).sub(a).setLength(len - head).add(a).clone();
    this.beam(a, end, color, radius, opacity);
    const c = this.take('cone', () => {
      const g = new THREE.ConeGeometry(1, 1, 12);
      g.translate(0, -0.5, 0);
      const mesh = new THREE.Mesh(g, basic(0xffffff, 1));
      mesh.renderOrder = 10;
      return mesh;
    });
    c.position.copy(b);
    c.quaternion.setFromUnitVectors(UP, tmp.subVectors(b, a).normalize());
    c.scale.set(radius * 3.2, head, radius * 3.2);
    c.material.color.set(color);
    c.material.opacity = opacity;
  }

  sphere(center, r, color, opacity = 0.5) {
    const m = this.take('sphere', () => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), fresnelMaterial());
      mesh.renderOrder = 7;
      return mesh;
    });
    m.position.copy(center);
    m.scale.setScalar(Math.max(0.01, r));
    m.material.uniforms.uColor.value.set(color);
    m.material.uniforms.uOpacity.value = opacity;
    return m;
  }

  // Horizontal disc (filled, with an edge ring) at a given height.
  disc(center, r, color, opacity = 0.18) {
    const m = this.take('disc', () => {
      const g = new THREE.Group();
      const fill = new THREE.Mesh(new THREE.CircleGeometry(1, 64), basic(0xffffff, 1, { side: THREE.DoubleSide }));
      const edge = new THREE.Mesh(new THREE.RingGeometry(0.975, 1, 96), basic(0xffffff, 1, { side: THREE.DoubleSide }));
      fill.rotation.x = edge.rotation.x = -Math.PI / 2;
      fill.renderOrder = 6;
      edge.renderOrder = 7;
      g.add(fill, edge);
      return g;
    });
    m.position.copy(center);
    m.scale.setScalar(Math.max(0.01, r));
    m.children[0].material.color.set(color);
    m.children[0].material.opacity = opacity;
    m.children[1].material.color.set(color);
    m.children[1].material.opacity = Math.min(1, opacity * 4);
    return m;
  }

  // Screen-facing ring, for zones of control and highlights.
  ring(center, r, color, opacity = 0.8, width = 0.08) {
    const m = this.take('ring', () => {
      const mesh = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48), basic(0xffffff, 1, { side: THREE.DoubleSide, depthTest: false }));
      mesh.renderOrder = 12;
      return mesh;
    });
    m.position.copy(center);
    m.scale.setScalar(r);
    const inner = 1 - width / Math.max(0.2, r);
    if (m.userData.inner !== inner) {
      m.geometry.dispose();
      m.geometry = new THREE.RingGeometry(Math.max(0.5, inner), 1, 48);
      m.userData.inner = inner;
    }
    if (this.camera) m.quaternion.copy(this.camera.quaternion);
    m.material.color.set(color);
    m.material.opacity = opacity;
    return m;
  }

  dot(center, r, color, opacity = 0.9) {
    const m = this.take('dot', () => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), basic(0xffffff, 1));
      mesh.renderOrder = 11;
      return mesh;
    });
    m.position.copy(center);
    m.scale.setScalar(r);
    m.material.color.set(color);
    m.material.opacity = opacity;
    return m;
  }

  // Translucent copy of a swimmer at a planned destination.
  ghost(unit, colors, pos, facing, opacity = 0.35) {
    let g = this.ghosts.get(unit.id);
    if (!g || g.def !== unit.def) {
      if (g) this.scene.remove(g.group);
      g = new Player({ team: unit.team, index: unit.slotIndex, def: unit.def, colors });
      g.def = unit.def;
      g.label.visible = false;
      g.marker.visible = false;
      g.group.traverse((o) => {
        if (o.isMesh) {
          o.material = o.material.clone();
          o.material.transparent = true;
          o.material.depthWrite = false;
          o.renderOrder = 9;
        }
      });
      this.scene.add(g.group);
      this.ghosts.set(unit.id, g);
    }
    g.group.visible = true;
    g.pos.copy(pos);
    g.facing.copy(facing);
    g.vel.set(0, 0, 0);
    g.group.traverse((o) => { if (o.isMesh) o.material.opacity = opacity; });
    g.label.visible = false;
    g.updateVisual(0.016, performance.now() / 1000, this.camera);
    return g;
  }
}
