import * as THREE from './lib.js';
import { SPHERE_R, GOAL_X, GOAL_RING_R } from './config.js';

// Builds the stadium: the floating sphere pool, the goals, the stands and the sky.
// Returns an object with an update(dt, time, camera) for the animated parts.
export function buildArena(scene, teamColors) {
  const root = new THREE.Group();
  scene.add(root);

  const sky = makeSky();
  root.add(sky);
  const water = makeWaterShell();
  root.add(water.mesh);

  const goals = [makeGoal(-1, teamColors[0]), makeGoal(1, teamColors[1])];
  goals.forEach((g) => root.add(g.group));

  root.add(makeStadium());
  const crowd = makeCrowd();
  root.add(crowd.mesh);

  const bubbles = makeBubbles();
  root.add(bubbles.points);

  const rays = makeLightRays();
  root.add(rays.group);

  const jets = makeJets();
  root.add(jets.points);

  // Lighting: a warm key from above, cool fill from the water, and a hemisphere wash.
  const hemi = new THREE.HemisphereLight(0xe4f6ff, 0x1d4a60, 1.5);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff4e0, 2.4);
  key.position.set(20, 60, 15);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x7fdcff, 0.6);
  rim.position.set(-30, -20, -25);
  scene.add(rim);

  const underwaterFog = new THREE.FogExp2(0x0d5575, 0.017);
  const airFog = new THREE.FogExp2(0x1a1030, 0.0022);

  return {
    goals,
    crowd,
    update(dt, time, camera, excitement) {
      water.material.uniforms.uTime.value = time;
      bubbles.update(dt);
      rays.update(time);
      jets.update(dt);
      crowd.update(time, excitement);
      goals.forEach((g) => g.update(time));
      const inside = camera.position.length() < SPHERE_R - 0.2;
      scene.fog = inside ? underwaterFog : airFog;
      sky.material.uniforms.uInside.value = inside ? 1 : 0;
      key.intensity = 2.3 + Math.sin(time * 1.7) * 0.12 + Math.sin(time * 3.1) * 0.08;
    },
  };
}

function makeSky() {
  const geo = new THREE.SphereGeometry(900, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uInside: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      void main() {
        vPos = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uInside;
      varying vec3 vPos;
      void main() {
        float h = vPos.y;
        if (uInside > 0.5) {
          // Seen from inside the sphere: light from the surface fading to the deep.
          vec3 deep = vec3(0.012, 0.07, 0.11);
          vec3 mid = vec3(0.05, 0.33, 0.46);
          vec3 lit = vec3(0.42, 0.82, 0.9);
          vec3 w = h < 0.0 ? mix(mid, deep, smoothstep(0.0, 0.8, -h)) : mix(mid, lit, smoothstep(0.1, 1.0, h));
          gl_FragColor = vec4(w, 1.0);
          return;
        }
        vec3 top = vec3(0.04, 0.05, 0.16);
        vec3 mid = vec3(0.28, 0.16, 0.36);
        vec3 horizon = vec3(0.98, 0.56, 0.32);
        vec3 below = vec3(0.03, 0.06, 0.1);
        vec3 c = h > 0.0 ? mix(mix(horizon, mid, smoothstep(0.0, 0.18, h)), top, smoothstep(0.18, 0.7, h))
                         : mix(horizon * 0.5, below, smoothstep(0.0, 0.12, -h));
        // a few fixed stars
        vec3 p = floor(vPos * 180.0);
        float s = fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        c += step(0.9975, s) * smoothstep(0.25, 0.6, h) * 0.9;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -10;
  return mesh;
}

function makeWaterShell() {
  const geo = new THREE.SphereGeometry(SPHERE_R, 96, 64);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      void main() {
        vec3 p = position;
        float w = sin(p.x * 0.35 + uTime * 1.4) * sin(p.z * 0.3 + uTime * 1.1) * 0.25
                + sin(p.y * 0.5 + uTime * 2.0) * 0.12;
        p += normal * w;
        vec4 world = modelMatrix * vec4(p, 1.0);
        vWorldPos = world.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        float f = 1.0 - abs(dot(normalize(vNormal), viewDir));
        float fres = pow(f, 2.2);
        float ripple = sin(vWorldPos.x * 1.3 + uTime * 2.3) * sin(vWorldPos.y * 1.1 - uTime * 1.7)
                     * sin(vWorldPos.z * 1.2 + uTime * 1.9);
        vec3 deep = vec3(0.02, 0.32, 0.46);
        vec3 rim = vec3(0.55, 0.95, 1.0);
        vec3 c = mix(deep, rim, fres) + ripple * 0.05;
        // bright caustic band near the top where light enters
        c += smoothstep(0.55, 1.0, vWorldPos.y / ${SPHERE_R.toFixed(1)}) * 0.25;
        float a = 0.08 + fres * 0.55 + abs(ripple) * 0.04;
        gl_FragColor = vec4(c, a);
      }`,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.renderOrder = 5;
  return { mesh, material };
}

function makeGoal(side, color) {
  const group = new THREE.Group();
  group.position.set(side * GOAL_X, 0, 0);
  group.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;

  const gold = new THREE.MeshStandardMaterial({ color: 0xe8b64a, metalness: 0.8, roughness: 0.3, emissive: 0x3a2400 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(GOAL_RING_R, 0.22, 16, 64), gold);
  group.add(ring);

  const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
  const glow = new THREE.Mesh(new THREE.TorusGeometry(GOAL_RING_R + 0.35, 0.08, 8, 64), glowMat);
  group.add(glow);

  // Net: a shallow cone behind the ring, drawn as a wire lattice.
  const netGeo = new THREE.ConeGeometry(GOAL_RING_R, 2.4, 24, 5, true);
  netGeo.rotateX(-Math.PI / 2);
  netGeo.translate(0, 0, -1.2);
  const net = new THREE.Mesh(netGeo, new THREE.MeshBasicMaterial({ color: 0xdff6ff, wireframe: true, transparent: true, opacity: 0.35 }));
  group.add(net);

  // Faint disc marking the mouth so the target reads from across the pool.
  const mouth = new THREE.Mesh(
    new THREE.CircleGeometry(GOAL_RING_R, 48),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false })
  );
  group.add(mouth);

  let flash = 0;
  return {
    group,
    flash() { flash = 1; },
    setColor(hex) {
      glowMat.color.setHex(hex);
      mouth.material.color.setHex(hex);
    },
    update(time) {
      flash = Math.max(0, flash - 0.012);
      glowMat.opacity = 0.35 + Math.sin(time * 2.5) * 0.1 + flash * 0.6;
      mouth.material.opacity = 0.08 + flash * 0.4;
      glow.scale.setScalar(1 + flash * 0.25);
    },
  };
}

function makeStadium() {
  const g = new THREE.Group();
  const floorY = -SPHERE_R - 14;

  // Arena floor: dark reflective water.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(140, 64),
    new THREE.MeshStandardMaterial({ color: 0x06202e, metalness: 0.6, roughness: 0.25 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = floorY;
  g.add(floor);

  // Emitter ring under the sphere that "holds" it up.
  const emitter = new THREE.Mesh(
    new THREE.TorusGeometry(8, 1.2, 16, 48),
    new THREE.MeshStandardMaterial({ color: 0x3a4652, metalness: 0.9, roughness: 0.35, emissive: 0x0a3a4a })
  );
  emitter.rotation.x = Math.PI / 2;
  emitter.position.y = floorY + 1.2;
  g.add(emitter);

  // Tiered stands as a lathe profile.
  const pts = [];
  const inner = 62;
  for (let i = 0; i <= 8; i++) {
    const r = inner + i * 6;
    const y = floorY + 2 + i * 5.5;
    pts.push(new THREE.Vector2(r, y));
    pts.push(new THREE.Vector2(r + 6, y));
  }
  pts.push(new THREE.Vector2(inner + 54, floorY + 60));
  pts.push(new THREE.Vector2(inner + 56, floorY - 2));
  const stands = new THREE.Mesh(
    new THREE.LatheGeometry(pts, 96),
    new THREE.MeshStandardMaterial({ color: 0x2b2f45, roughness: 0.85, side: THREE.DoubleSide })
  );
  g.add(stands);

  // Rim lights along the top of the stands.
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xffe2a8 });
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const tower = new THREE.Mesh(new THREE.BoxGeometry(2, 30, 2), new THREE.MeshStandardMaterial({ color: 0x1b1e2c }));
    const r = inner + 56;
    tower.position.set(Math.cos(a) * r, floorY + 72, Math.sin(a) * r);
    g.add(tower);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(7, 3, 1), lampMat);
    lamp.position.set(Math.cos(a) * (r - 1.5), floorY + 88, Math.sin(a) * (r - 1.5));
    lamp.lookAt(0, 0, 0);
    g.add(lamp);
  }
  return g;
}

function makeCrowd() {
  const count = 5200;
  const geo = new THREE.BoxGeometry(0.9, 1.4, 0.9);
  const mat = new THREE.MeshLambertMaterial();
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const floorY = -SPHERE_R - 14;
  const dummy = new THREE.Object3D();
  const base = [];
  const palette = [0xf3c42f, 0x1c5fc7, 0xd8413a, 0xf2efe6, 0x6fd3e0, 0xe38a3a, 0x8c6bd6, 0x41b36b];
  const col = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const tier = i % 8;
    const a = Math.random() * Math.PI * 2;
    const r = 62 + tier * 6 + 1.5 + Math.random() * 3;
    const y = floorY + 2 + tier * 5.5 + 1.2;
    base.push({ a, r, y, phase: Math.random() * Math.PI * 2 });
    dummy.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    col.setHex(palette[(Math.random() * palette.length) | 0]).multiplyScalar(0.55 + Math.random() * 0.45);
    mesh.setColorAt(i, col);
  }
  let lastExcite = -1;
  return {
    mesh,
    update(time, excitement) {
      // Only re-upload matrices when the crowd is on its feet, or while settling.
      if (excitement < 0.02 && lastExcite < 0.02) return;
      lastExcite = excitement;
      for (let i = 0; i < count; i++) {
        const b = base[i];
        const hop = Math.max(0, Math.sin(time * 9 + b.phase)) * excitement * 1.2;
        dummy.position.set(Math.cos(b.a) * b.r, b.y + hop, Math.sin(b.a) * b.r);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

function roundSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const grd = x.createRadialGradient(32, 32, 2, 32, 32, 30);
  grd.addColorStop(0, 'rgba(255,255,255,0.95)');
  grd.addColorStop(0.55, 'rgba(200,245,255,0.35)');
  grd.addColorStop(0.8, 'rgba(255,255,255,0.7)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = grd;
  x.beginPath();
  x.arc(32, 32, 30, 0, Math.PI * 2);
  x.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function randomInSphere(r) {
  const v = new THREE.Vector3();
  do v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
  while (v.lengthSq() > 1);
  return v.multiplyScalar(r);
}

function makeBubbles() {
  const n = 700;
  const pos = new Float32Array(n * 3);
  const speed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = randomInSphere(SPHERE_R - 1);
    pos.set([p.x, p.y, p.z], i * 3);
    speed[i] = 0.6 + Math.random() * 1.6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.2, map: roundSprite(), transparent: true, depthWrite: false, opacity: 0.55, sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.renderOrder = 6;
  const R2 = (SPHERE_R - 0.8) ** 2;
  return {
    points,
    update(dt) {
      for (let i = 0; i < n; i++) {
        const k = i * 3;
        pos[k + 1] += speed[i] * dt;
        pos[k] += Math.sin(pos[k + 1] * 0.8 + i) * dt * 0.3;
        if (pos[k] * pos[k] + pos[k + 1] * pos[k + 1] + pos[k + 2] * pos[k + 2] > R2) {
          const p = randomInSphere(SPHERE_R * 0.9);
          pos[k] = p.x;
          pos[k + 1] = -Math.sqrt(Math.max(0, R2 - p.x * p.x - p.z * p.z)) + 0.5;
          pos[k + 2] = p.z;
        }
      }
      geo.attributes.position.needsUpdate = true;
    },
  };
}

function makeLightRays() {
  const group = new THREE.Group();
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        float fade = smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.8, vUv.y);
        float edge = sin(vUv.x * 3.14159);
        float flicker = 0.75 + 0.25 * sin(uTime * 1.3 + vUv.x * 9.0);
        gl_FragColor = vec4(vec3(0.6, 0.95, 1.0) * fade * edge * edge * flicker * 0.035, 1.0);
      }`,
  });
  const rays = [];
  for (let i = 0; i < 9; i++) {
    const geo = new THREE.CylinderGeometry(1 + Math.random() * 1.4, 0.3, SPHERE_R * 1.7, 12, 1, true);
    const m = new THREE.Mesh(geo, mat);
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * SPHERE_R * 0.55;
    m.position.set(Math.cos(a) * r, 2, Math.sin(a) * r);
    m.rotation.z = (Math.random() - 0.5) * 0.35;
    m.rotation.x = (Math.random() - 0.5) * 0.35;
    m.userData.base = { rx: m.rotation.x, rz: m.rotation.z, phase: Math.random() * 10 };
    group.add(m);
    rays.push(m);
  }
  return {
    group,
    update(time) {
      mat.uniforms.uTime.value = time;
      for (const m of rays) {
        const b = m.userData.base;
        m.rotation.z = b.rz + Math.sin(time * 0.3 + b.phase) * 0.06;
        m.rotation.x = b.rx + Math.cos(time * 0.25 + b.phase) * 0.06;
      }
    },
  };
}

// Water columns rising from the emitter ring into the base of the sphere.
function makeJets() {
  const n = 500;
  const pos = new Float32Array(n * 3);
  const t = new Float32Array(n);
  const angle = new Float32Array(n);
  const bottom = -SPHERE_R - 12.5;
  const top = -SPHERE_R + 0.5;
  for (let i = 0; i < n; i++) {
    t[i] = Math.random();
    angle[i] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.5, map: roundSprite(), color: 0x9fe9ff, transparent: true, opacity: 0.6, depthWrite: false,
  }));
  return {
    points,
    update(dt) {
      for (let i = 0; i < n; i++) {
        t[i] += dt * 0.35;
        if (t[i] > 1) { t[i] = 0; angle[i] = Math.random() * Math.PI * 2; }
        const r = 8 * (1 - t[i]) + 2.5 * t[i];
        pos[i * 3] = Math.cos(angle[i]) * r;
        pos[i * 3 + 1] = bottom + (top - bottom) * t[i];
        pos[i * 3 + 2] = Math.sin(angle[i]) * r;
      }
      geo.attributes.position.needsUpdate = true;
    },
  };
}
