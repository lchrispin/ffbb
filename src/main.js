import * as THREE from './lib.js';
import { SPHERE_R, TEAMS, MATCH_LENGTHS, DIFFICULTY } from './config.js';
import { buildArena } from './arena.js';
import { Match } from './match.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Sound } from './audio.js';

const canvas = document.getElementById('game');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (err) {
  document.getElementById('gl-error').hidden = false;
  document.getElementById('start').disabled = true;
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 2000);
const arena = buildArena(scene, [TEAMS.aurochs.color, TEAMS.goers.color]);

const isTouch = matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('touch', isTouch);
const input = new Input(canvas, document.getElementById('touch'));
const hud = new Hud();
const sound = new Sound();

const ui = {
  menu: document.getElementById('menu'),
  pause: document.getElementById('pause'),
  interval: document.getElementById('interval'),
  intervalTitle: document.getElementById('interval-title'),
  intervalScore: document.getElementById('interval-score'),
  intervalStats: document.getElementById('interval-stats'),
  intervalGo: document.getElementById('interval-go'),
  intervalMenu: document.getElementById('interval-menu'),
  mute: document.getElementById('mute'),
};

const settings = loadSettings();
let match = null;
let mode = 'attract';          // attract | play | paused | interval
let lastEventGoalCam = 0;

// Camera rig: yaw/pitch describe where the controlled swimmer is looking.
const rig = {
  yaw: Math.PI / 2, pitch: 0, snap: null,
  pos: new THREE.Vector3(0, 0, 40), look: new THREE.Vector3(), orbit: 0,
};
const aim = new THREE.Vector3();
const right = new THREE.Vector3();
const tmp = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);

function aimDir(out, yaw, pitch) {
  return out.set(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw));
}

function yawPitchTo(from, to) {
  tmp.subVectors(to, from).normalize();
  return { yaw: Math.atan2(tmp.x, tmp.z), pitch: Math.asin(THREE.MathUtils.clamp(tmp.y, -1, 1)) * 0.6 };
}

function wrap(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// ---------- match lifecycle ----------

function newMatch(opts) {
  if (match) match.dispose();
  match = new Match(scene, opts, onEvent);
  arena.goals[0].setColor(match.teamDefs[0].color);
  arena.goals[1].setColor(match.teamDefs[1].color);
  hud.setTeams(match.teamDefs);
  rig.yaw = Math.PI / 2;
  rig.pitch = 0;
}

function startAttract() {
  mode = 'attract';
  newMatch({ teamIds: ['aurochs', 'goers'], humanTeam: 0, difficulty: 'normal', halfLength: 9999, spectate: true });
  hud.show(false);
  ui.menu.hidden = false;
  ui.pause.hidden = true;
  ui.interval.hidden = true;
  document.body.classList.remove('playing');
}

function startMatch() {
  sound.start();
  const pick = settings.team;
  const other = pick === 'aurochs' ? 'goers' : 'aurochs';
  const len = MATCH_LENGTHS.find((l) => l.id === settings.length) || MATCH_LENGTHS[1];
  newMatch({ teamIds: [pick, other], humanTeam: 0, difficulty: settings.difficulty, halfLength: len.half });
  mode = 'play';
  ui.menu.hidden = true;
  ui.interval.hidden = true;
  ui.pause.hidden = true;
  hud.show(true);
  document.body.classList.add('playing');
  if (!isTouch) requestLock();
}

function requestLock() {
  try {
    const r = canvas.requestPointerLock?.();
    if (r && r.catch) r.catch(() => {});
  } catch { /* optional */ }
}

function setPaused(on) {
  if (on && mode === 'play') {
    mode = 'paused';
    ui.pause.hidden = false;
    if (document.pointerLockElement) document.exitPointerLock();
  } else if (!on && mode === 'paused') {
    mode = 'play';
    ui.pause.hidden = true;
    if (!isTouch) requestLock();
  }
}

document.addEventListener('pointerlockchange', () => {
  // Losing the pointer mid-match (Esc) pauses, like most desktop games.
  if (!document.pointerLockElement && mode === 'play' && match && match.phase !== 'halftime' && match.phase !== 'fulltime') setPaused(true);
});

function showInterval(final) {
  mode = 'interval';
  if (document.pointerLockElement) document.exitPointerLock();
  const [a, b] = match.teamDefs;
  const [sa, sb] = match.score;
  let title = 'Half time';
  if (final) title = sa > sb ? `${a.name} win` : sa < sb ? `${b.name} win` : 'Full time · Draw';
  ui.intervalTitle.textContent = title;
  ui.intervalScore.innerHTML = `<span>${a.short}</span><b>${sa}</b><i>–</i><b>${sb}</b><span>${b.short}</span>`;
  const st = match.stats;
  const total = Math.max(1, st[0].possession + st[1].possession);
  const rows = [
    ['Possession', `${Math.round((st[0].possession / total) * 100)}%`, `${Math.round((st[1].possession / total) * 100)}%`],
    ['Shots', st[0].shots, st[1].shots],
    ['Passes completed', st[0].passes, st[1].passes],
    ['Tackles won', st[0].tackles, st[1].tackles],
    ['Blocks & interceptions', st[0].blocks, st[1].blocks],
    ['Keeper saves', st[0].saves, st[1].saves],
  ];
  ui.intervalStats.innerHTML = rows.map(([k, x, y]) => `<tr><td>${x}</td><th>${k}</th><td>${y}</td></tr>`).join('');
  ui.intervalGo.textContent = final ? 'Rematch' : 'Start 2nd half';
  ui.interval.hidden = false;
  ui.intervalGo.focus();
}

ui.intervalGo.addEventListener('click', () => {
  sound.start();
  if (match.phase === 'fulltime') { startMatch(); return; }
  ui.interval.hidden = true;
  match.startSecondHalf();
  mode = 'play';
  if (!isTouch) requestLock();
});
ui.intervalMenu.addEventListener('click', startAttract);
document.getElementById('resume').addEventListener('click', () => setPaused(false));
document.getElementById('quit').addEventListener('click', startAttract);
document.getElementById('pause-btn').addEventListener('click', () => setPaused(true));
ui.mute.addEventListener('click', () => { sound.start(); updateMute(sound.toggleMute()); });
function updateMute(m) {
  ui.mute.setAttribute('aria-pressed', String(m));
  ui.mute.textContent = m ? 'Sound off' : 'Sound on';
}

// ---------- menu ----------

function loadSettings() {
  const d = { team: 'aurochs', difficulty: 'normal', length: 'std' };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem('ffbb.settings') || '{}') };
  } catch { return d; }
}
function saveSettings() {
  try { localStorage.setItem('ffbb.settings', JSON.stringify(settings)); } catch { /* storage is optional */ }
}

function bindChoice(name, key) {
  const inputs = document.querySelectorAll(`input[name="${name}"]`);
  inputs.forEach((el) => {
    el.checked = el.value === settings[key];
    el.addEventListener('change', () => { settings[key] = el.value; saveSettings(); });
  });
}
function buildMenu() {
  const teamWrap = document.getElementById('team-options');
  teamWrap.innerHTML = Object.values(TEAMS).map((t) => {
    const avg = (k) => Math.round(t.players.filter((p) => p.role !== 'GK').reduce((s, p) => s + p[k], 0) / 5);
    const bar = (k, label) => `<div class="tbar"><span>${label}</span><i style="--v:${avg(k) / 15}"></i></div>`;
    const star = t.players.find((p) => p.role === 'MF');
    return `<label class="team-card" style="--team:#${t.color.toString(16).padStart(6, '0')};--trim:#${t.trim.toString(16).padStart(6, '0')}">
      <input type="radio" name="team" value="${t.id}" id="team-${t.id}">
      <span class="tc-crest" aria-hidden="true"></span>
      <span class="tc-name">${t.name}</span>
      <span class="tc-star">Captain ${star.name} · #${star.num}</span>
      ${bar('SP', 'Speed')}${bar('SH', 'Shot')}${bar('BL', 'Block')}
    </label>`;
  }).join('');
  document.getElementById('diff-options').innerHTML = Object.entries(DIFFICULTY).map(([id, d]) =>
    `<label class="seg"><input type="radio" name="difficulty" value="${id}" id="diff-${id}"><span>${d.label}</span></label>`).join('');
  document.getElementById('len-options').innerHTML = MATCH_LENGTHS.map((l) =>
    `<label class="seg"><input type="radio" name="length" value="${l.id}" id="len-${l.id}"><span>${l.label}</span></label>`).join('');
  bindChoice('team', 'team');
  bindChoice('difficulty', 'difficulty');
  bindChoice('length', 'length');
  document.getElementById('start').addEventListener('click', startMatch);
}

// ---------- events from the match ----------

function onEvent(type, d) {
  if (!match || mode === 'attract') {
    if (type === 'goal') arena.goals[d.team === 0 ? 1 : 0].flash();
    return;
  }
  const mine = (team) => team === match.humanTeam;
  switch (type) {
    case 'kickoff':
      hud.callout(d.half === 1 ? '1st half' : '2nd half', 'Ball launches from the floor of the sphere', 'neutral', 2.2);
      rig.snap = null;
      rig.yaw = Math.PI / 2;
      rig.pitch = 0;
      rig.cut = true;
      break;
    case 'whistle':
      sound.whistle(d.long);
      break;
    case 'pass':
      sound.bubbles(3);
      break;
    case 'shot':
      sound.thump(d.special ? 1.6 : 1, d.special ? 0.6 : 1);
      if (d.special) {
        hud.callout('Jecht Shot', `${d.from.name} · power ${Math.round(d.power)}`, mine(d.from.team) ? 'good' : 'bad', 1.6);
        match.excitement = Math.max(match.excitement, 0.7);
      }
      hud.log(`${d.from.name} shoots · power ${Math.round(d.power)}`, mine(d.from.team) ? 'good' : 'bad');
      break;
    case 'goal': {
      arena.goals[d.team === 0 ? 1 : 0].flash();
      sound.chime(mine(d.team));
      sound.thump(1.4, 0.5);
      const who = d.by ? (d.ownGoal ? `Own goal · ${d.by.name}` : d.by.name) : '';
      hud.callout('Goal!', `${match.teamDefs[d.team].name} · ${who}`, mine(d.team) ? 'good' : 'bad', 3.2);
      hud.log(`Goal for ${match.teamDefs[d.team].short} · ${who}`, mine(d.team) ? 'good' : 'bad');
      lastEventGoalCam = 3.4;
      rig.goalFocus = d.by || null;
      break;
    }
    case 'save':
      sound.thump(0.8, 1.4);
      hud.callout('Save', `${d.keeper.name} · grip ${d.grip} beats power ${d.power}`, mine(d.keeper.team) ? 'good' : 'bad', 1.4);
      hud.log(`${d.keeper.name} saves (${d.grip} vs ${d.power})`, mine(d.keeper.team) ? 'good' : 'bad');
      break;
    case 'beaten':
      hud.log(`${d.keeper.name} beaten · ${d.power} past grip ${d.grip}`, mine(d.keeper.team) ? 'bad' : 'good');
      break;
    case 'block':
    case 'intercept':
      sound.thump(0.6, 1.6);
      hud.callout(type === 'block' ? 'Blocked' : 'Intercepted', d.by.name, mine(d.by.team) ? 'good' : 'bad', 1.1);
      hud.log(`${d.by.name} ${type === 'block' ? 'blocks the shot' : 'intercepts'}`, mine(d.by.team) ? 'good' : 'bad');
      break;
    case 'deflect':
      hud.log(`${d.by.name} gets a touch · −${d.cut}, ${d.left} left`, mine(d.by.team) ? 'good' : 'bad');
      break;
    case 'knockback':
      hud.log(`${d.on.name} is knocked aside`, mine(d.on.team) ? 'bad' : 'good');
      break;
    case 'fizzle':
      hud.log('The shot runs out of power');
      break;
    case 'tackle':
      sound.thump(0.9, 0.8);
      hud.callout('Tackle', `${d.by.name} on ${d.on.name}`, mine(d.by.team) ? 'good' : 'bad', 1.1);
      hud.log(`${d.by.name} wins it from ${d.on.name}`, mine(d.by.team) ? 'good' : 'bad');
      break;
    case 'breakthrough':
      hud.log(`${d.by.name} breaks the tackle`, mine(d.by.team) ? 'good' : 'bad');
      break;
    case 'overdrive':
      if (mine(d.team)) hud.log(isTouch ? 'Jecht Shot ready' : 'Jecht Shot ready · press E with the ball', 'good');
      else hud.log(`${match.teamDefs[d.team].short} have a Jecht Shot charged`, 'bad');
      break;
    case 'possession':
      if (d.player.team === match.humanTeam && d.player === match.human) {
        rig.snap = yawPitchTo(d.player.pos, match.attackGoal(match.humanTeam));
      }
      break;
    case 'halftime':
      setTimeout(() => showInterval(false), 1200);
      break;
    case 'fulltime':
      setTimeout(() => showInterval(true), 1200);
      break;
  }
}

// ---------- per-frame ----------

function controlHuman(dt) {
  const h = match.human;
  const look = input.consumeLook();
  const kl = input.keyLook(dt);
  const sens = 0.0028;
  rig.yaw -= look.dx * sens + kl.yaw;
  rig.pitch -= look.dy * sens - kl.pitch;
  if (look.dx || look.dy || kl.yaw || kl.pitch) rig.snap = null;
  if (rig.snap) {
    rig.yaw += wrap(rig.snap.yaw - rig.yaw) * Math.min(1, dt * 6);
    rig.pitch += (rig.snap.pitch - rig.pitch) * Math.min(1, dt * 6);
    if (Math.abs(wrap(rig.snap.yaw - rig.yaw)) < 0.01) rig.snap = null;
  }
  rig.pitch = THREE.MathUtils.clamp(rig.pitch, -1.3, 1.3);

  const actions = input.consumeActions();
  for (const a of actions) {
    if (a === 'pause') { setPaused(true); return; }
    if (a === 'mute') updateMute(sound.toggleMute());
  }
  if (!h || match.phase !== 'play') {
    if (h) h.desired.set(0, 0, 0);
    return;
  }

  aimDir(aim, rig.yaw, rig.pitch);
  right.set(-Math.cos(rig.yaw), 0, Math.sin(rig.yaw));
  const mv = input.move();
  h.desired.set(0, 0, 0)
    .addScaledVector(aim, mv.z)
    .addScaledVector(right, mv.x)
    .addScaledVector(up, mv.y);
  if (h.desired.lengthSq() > 1) h.desired.normalize();
  h.sprint = input.sprinting();
  h.aimHint = aim;

  // Strafing with no manual look input slowly swings the camera round, so A/D
  // (or the touch stick) work as steering for keyboard-only and phone players.
  const idleLook = performance.now() - input.lastLookInput > 700;
  const horiz = Math.hypot(h.vel.x, h.vel.z);
  if (idleLook && Math.abs(mv.x) > 0.1 && horiz > 1.5) {
    const target = Math.atan2(h.vel.x, h.vel.z);
    rig.yaw += wrap(target - rig.yaw) * Math.min(1, dt * 1.4 * Math.abs(mv.x));
  }
  if (match.ball.owner === h && h.desired.lengthSq() < 0.01) h.facing.lerp(aim, Math.min(1, dt * 5)).normalize();

  const hasBall = match.ball.owner === h;
  for (const a of actions) {
    switch (a) {
      case 'pass':
        if (hasBall) match.pass(h, match.passTarget);
        else match.tackle(h);
        break;
      case 'shoot':
        if (hasBall) match.shoot(h, false);
        else match.switchHuman();
        break;
      case 'special':
        if (hasBall && match.overdrive[h.team] >= 1) match.shoot(h, true);
        break;
      case 'switch':
        match.switchHuman();
        break;
      case 'face':
        rig.snap = hasBall ? yawPitchTo(h.pos, match.attackGoal(h.team)) : yawPitchTo(h.pos, match.ball.pos);
        break;
    }
  }
}

function updateCamera(dt, time) {
  let target;
  let desired;
  const ease = 1 - Math.exp(-dt * 7);
  if (mode === 'attract' || mode === 'interval' || !match.human) {
    // Slow orbit outside the sphere to show off the pool.
    rig.orbit += dt * 0.08;
    desired = tmp.set(Math.cos(rig.orbit) * 58, 14 + Math.sin(rig.orbit * 0.7) * 8, Math.sin(rig.orbit) * 58);
    target = new THREE.Vector3(0, -2, 0);
  } else if (lastEventGoalCam > 0 && match.phase === 'goal') {
    // Goal replay-ish angle: circle the scorer.
    const focus = rig.goalFocus ? rig.goalFocus.pos : match.ball.pos;
    const a = time * 0.9;
    desired = tmp.set(Math.cos(a) * 7, 2.5, Math.sin(a) * 7).add(focus);
    target = focus.clone();
  } else {
    const h = match.human;
    aimDir(aim, rig.yaw, rig.pitch);
    desired = tmp.copy(h.pos).addScaledVector(aim, -6.2).addScaledVector(up, 1.5);
    target = h.pos.clone().addScaledVector(aim, 6);
  }
  const lim = SPHERE_R - 0.7;
  const outside = mode === 'attract' || mode === 'interval' || !match.human;
  if (!outside && desired.length() > lim) desired.setLength(lim);
  if (rig.cut) {
    rig.cut = false;
    rig.pos.copy(desired);
    rig.look.copy(target);
  }
  rig.pos.lerp(desired, ease);
  rig.look.lerp(target, ease);
  camera.position.copy(rig.pos);
  camera.lookAt(rig.look);
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w < h ? 78 : 62;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

const clock = new THREE.Clock();
let elapsed = 0;
function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  elapsed += dt;
  lastEventGoalCam = Math.max(0, lastEventGoalCam - dt);

  if (mode === 'play') controlHuman(dt);
  else {
    const acts = input.consumeActions();
    input.consumeLook();
    if (mode === 'paused' && acts.includes('pause')) setPaused(false);
  }

  if (mode !== 'paused') match.update(dt);
  arena.update(dt, elapsed, camera, match.excitement);
  if (mode !== 'attract') sound.crowd(match.excitement);
  for (const p of match.players) p.updateVisual(dt, elapsed, camera);
  updateCamera(dt, elapsed);
  if (mode === 'play' || mode === 'paused') hud.update(dt, match, isTouch);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// Handy for poking at a running match from the dev console.
window.ffbb = { get match() { return match; }, scene, camera };

buildMenu();
updateMute(false);
startAttract();
resize();
requestAnimationFrame(frame);
document.body.classList.add('ready');
