import * as THREE from './lib.js';
import { TEAMS, MATCH_LENGTHS, DIFFICULTY, FORMATIONS, ENCOUNTER, SLOW } from './config.js';
import { buildArena } from './arena.js';
import { Match } from './match.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Sound } from './audio.js';
import { Director } from './director.js';
import { Wheel } from './wheel.js';
import { Floaters } from './floaters.js';
import { Lanes } from './lanes.js';

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
const director = new Director(camera);
const floaters = new Floaters(document.getElementById('floaters'), camera);
const lanes = new Lanes(scene);
let hovered = null;   // wheel item under the cursor/selection
const wheel = new Wheel(document.getElementById('wheel'), {
  onHover(item) {
    hovered = item;
    if (match && match.encounter) match.passTarget = item && item.target ? item.target : null;
  },
});

const ui = {
  menu: document.getElementById('menu'),
  pause: document.getElementById('pause'),
  interval: document.getElementById('interval'),
  intervalTitle: document.getElementById('interval-title'),
  intervalScore: document.getElementById('interval-score'),
  intervalStats: document.getElementById('interval-stats'),
  intervalGo: document.getElementById('interval-go'),
  intervalMenu: document.getElementById('interval-menu'),
  tactics: document.getElementById('tactics'),
  formations: document.getElementById('formation-options'),
  formationBlurb: document.getElementById('formation-blurb'),
  marks: document.getElementById('marks'),
  mute: document.getElementById('mute'),
};

const settings = loadSettings();
let match = null;
let mode = 'attract';          // attract | play | paused | interval
let goalCam = 0;
let goalFocus = null;
let gameTime = 0;
let resolving = false;         // true while a wheel choice is being carried out
let ballChain = [];            // power readings before each blocker's cut, for the ball tag

// Movement is camera-relative. When the camera cuts, the old mapping is kept until
// the stick or keys are released, so a held direction doesn't suddenly change.
const moveBasis = { active: false, cuts: 0, fwd: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0) };
const up = new THREE.Vector3(0, 1, 0);

// ---------- match lifecycle ----------

function newMatch(opts) {
  if (match) match.dispose();
  wheel.close();
  floaters.clear();
  lanes.hide();
  match = new Match(scene, opts, onEvent);
  arena.goals[0].setColor(match.teamDefs[0].color);
  arena.goals[1].setColor(match.teamDefs[1].color);
  hud.setTeams(match.teamDefs);
  director.cut();
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
  hud.callout('1st half', 'Ball launches from the floor of the sphere', 'neutral', 2.2);
  document.body.classList.add('playing');
}

function setPaused(on) {
  if (on && mode === 'play') {
    mode = 'paused';
    ui.pause.hidden = false;
  } else if (!on && mode === 'paused') {
    mode = 'play';
    ui.pause.hidden = true;
  }
}

function showInterval(final) {
  mode = 'interval';
  wheel.close();
  lanes.hide();
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
  ui.tactics.hidden = final;
  if (!final) buildTactics();
  ui.interval.hidden = false;
  ui.intervalGo.focus();
}

// Half-time tactics: a formation preset and who each of your defenders marks.
function buildTactics() {
  const t = match.humanTeam;
  const cur = match.formation[t].id;
  ui.formations.innerHTML = Object.values(FORMATIONS).map((f) =>
    `<label class="seg"><input type="radio" name="formation" value="${f.id}" ${f.id === cur ? 'checked' : ''}><span>${f.label}</span></label>`).join('');
  const blurb = () => {
    const f = FORMATIONS[ui.formations.querySelector('input:checked').value];
    ui.formationBlurb.textContent = f.blurb;
  };
  ui.formations.querySelectorAll('input').forEach((el) => el.addEventListener('change', blurb));
  blurb();
  const opp = match.teams[1 - t].filter((q) => q.role !== 'GK');
  const mine = match.teams[t].filter((p) => p.role in match.marks[t]);
  ui.marks.innerHTML = mine.map((p) => `
    <label class="mark-row"><span>${p.name} <small>${p.role}</small></span>
      <select data-role="${p.role}">${opp.map((q) => `<option value="${q.role}" ${match.marks[t][p.role] === q.role ? 'selected' : ''}>${q.name} · ${q.role}</option>`).join('')}</select>
    </label>`).join('');
}

function applyTactics() {
  const t = match.humanTeam;
  const f = ui.formations.querySelector('input:checked');
  const marks = { ...match.marks[t] };
  ui.marks.querySelectorAll('select').forEach((el) => { marks[el.dataset.role] = el.value; });
  match.setTactics(t, f ? f.value : 'balanced', marks);
  // The AI answers the scoreline: chase the game when behind, sit deep when well ahead.
  const ai = 1 - t;
  const diff = match.score[ai] - match.score[t];
  const pick = diff < 0 ? 'attack' : diff >= 2 ? 'wall' : 'balanced';
  match.setTactics(ai, pick);
  hud.log(`${match.teamDefs[ai].short} go ${FORMATIONS[pick].label.toLowerCase()} for the 2nd half`);
}

ui.intervalGo.addEventListener('click', () => {
  sound.start();
  if (match.phase === 'fulltime') { startMatch(); return; }
  applyTactics();
  ui.interval.hidden = true;
  match.startSecondHalf();
  mode = 'play';
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

// Tone from the human's point of view: good when `team` is the human's side.
function tone(team) {
  return team === match.humanTeam ? 'good' : 'bad';
}

function openWheel(e) {
  const opts = match.commandOptions();
  const carrier = match.ball.owner;
  const names = e.foes.slice(0, 3).map((q) => q.name).join(', ');
  const sub = e.kind === 'attack'
    ? (e.foes.length ? `${names} closing in` : 'No one close')
    : (carrier && carrier.team !== match.humanTeam ? `${carrier.name} has the ball` : 'The ball is free');
  wheel.open(
    { title: e.manual ? 'Command' : 'Encounter', sub, kind: e.kind, options: opts },
    (choice) => {
      resolving = true;
      match.resolveCommand(choice);
      resolving = false;
    },
    () => match.defaultCommand(),
    ENCOUNTER.wheelTime,
  );
  if (!e.manual) sound.thump(0.5, 1.8);
}

function onEvent(type, d) {
  if (!match || mode === 'attract') {
    if (type === 'goal') arena.goals[d.team === 0 ? 1 : 0].flash();
    return;
  }
  const mine = (team) => team === match.humanTeam;
  switch (type) {
    case 'kickoff':
      hud.callout(d.half === 1 ? '1st half' : '2nd half', 'Ball launches from the floor of the sphere', 'neutral', 2.2);
      wheel.close();
      floaters.clear();
      director.cut();
      break;
    case 'whistle':
      sound.whistle(d.long);
      break;
    case 'encounter':
      openWheel(d);
      break;
    case 'encounterEnd':
      wheel.close();
      lanes.hide();
      break;
    case 'pass':
      sound.bubbles(3);
      ballChain = [];
      break;
    case 'shot':
      sound.thump(d.special ? 1.6 : 1, d.special ? 0.6 : 1);
      ballChain = [];
      floaters.pop(`SH ${Math.round(d.from.stat('SH'))} → <b>${Math.round(d.power)}</b>`, d.from, { tone: tone(d.from.team), size: 'lg' });
      if (mine(d.from.team)) {
        match.slow('shot', SLOW.shot);
      } else if (!resolving) {
        // AI moment: a lighter slow-down so you can see the shot coming.
        match.slow('aiShot', SLOW.aiShot, 1.2);
        if (!d.special) hud.callout(`${d.from.name} shoots`, `power ${Math.round(d.power)}`, 'bad', 1.2, 'small');
      }
      if (d.special) {
        hud.callout('Jecht Shot', `${d.from.name} · power ${Math.round(d.power)}`, tone(d.from.team), 1.6);
        match.excitement = Math.max(match.excitement, 0.7);
      }
      hud.log(`${d.from.name} shoots · power ${Math.round(d.power)}`, tone(d.from.team));
      break;
    case 'goal': {
      arena.goals[d.team === 0 ? 1 : 0].flash();
      sound.chime(mine(d.team));
      sound.thump(1.4, 0.5);
      const who = d.by ? (d.ownGoal ? `Own goal · ${d.by.name}` : d.by.name) : '';
      hud.callout('Goal!', `${match.teamDefs[d.team].name} · ${who}`, tone(d.team), 3.2);
      hud.log(`Goal for ${match.teamDefs[d.team].short} · ${who}`, tone(d.team));
      goalCam = 3.4;
      goalFocus = d.by || null;
      break;
    }
    case 'save':
      sound.thump(0.8, 1.4);
      floaters.pop(`GRIP <b>${d.grip}</b> vs ${d.power}<br><em>Save</em>`, d.keeper, { tone: tone(d.keeper.team), size: 'lg', life: 2.2 });
      hud.callout('Save', d.keeper.name, tone(d.keeper.team), 1.4, 'small');
      hud.log(`${d.keeper.name} saves (${d.grip} vs ${d.power})`, tone(d.keeper.team));
      break;
    case 'beaten':
      floaters.pop(`GRIP ${d.grip} vs <b>${d.power}</b><br><em>Beaten</em>`, d.keeper, { tone: tone(1 - d.keeper.team), size: 'lg', life: 2.2 });
      hud.log(`${d.keeper.name} beaten · ${d.power} past grip ${d.grip}`, tone(1 - d.keeper.team));
      break;
    case 'block':
    case 'intercept':
      sound.thump(0.6, 1.6);
      floaters.pop(`${d.a} vs ${d.b}<br>${d.before} → <b>0</b>`, d.by, { tone: tone(d.by.team), size: 'lg' });
      hud.callout(type === 'block' ? 'Blocked' : 'Intercepted', d.by.name, tone(d.by.team), 1.1, 'small');
      hud.log(`${d.by.name} ${type === 'block' ? 'blocks the shot' : 'intercepts'}`, tone(d.by.team));
      break;
    case 'deflect':
      ballChain.push(d.before);
      floaters.pop(`${d.a} vs ${d.b}<br><b>−${d.cut}</b>`, d.by, { tone: tone(d.by.team) });
      hud.log(`${d.by.name} gets a touch · −${d.cut}, ${d.left} left`, tone(d.by.team));
      break;
    case 'knockback':
      floaters.pop('<em>Knocked aside</em>', d.on, { tone: tone(1 - d.on.team) });
      hud.log(`${d.on.name} is knocked aside`, tone(1 - d.on.team));
      break;
    case 'fizzle':
      hud.log('The shot runs out of power');
      break;
    case 'duel':
      // "AT 9 vs EN 7" over the carrier, and who came out on top.
      floaters.pop(`${d.a} vs ${d.b}<br><em>${d.won ? 'Tackle' : 'Break'}</em>`, d.def, { tone: d.won ? tone(d.att.team) : tone(d.def.team), size: 'lg' });
      break;
    case 'venom':
      floaters.pop('<em>Venom</em>', d.on, { tone: 'venom', dy: 2.6 });
      hud.log(`${d.by.name} uses Venom Tackle on ${d.on.name}`, tone(d.by.team));
      break;
    case 'hold':
      floaters.pop('<em>Hold</em>', d.by, { tone: 'good' });
      break;
    case 'tackle':
      sound.thump(0.9, 0.8);
      hud.callout('Tackle', `${d.by.name} on ${d.on.name}`, tone(d.by.team), 1.1, 'small');
      hud.log(`${d.by.name} wins it from ${d.on.name}`, tone(d.by.team));
      if (mine(d.on.team) && !resolving) match.slow('aiTackle', SLOW.aiTackle, 0.8);
      break;
    case 'breakthrough':
      hud.log(`${d.by.name} breaks the tackle`, tone(d.by.team));
      if (mine(d.by.team) && !resolving) {
        match.slow('aiTackle', SLOW.aiTackle, 0.6);
        hud.callout('Break!', `${d.by.name} shrugs off ${d.on.name}`, 'good', 1, 'small');
      }
      break;
    case 'overdrive':
      if (mine(d.team)) hud.log(isTouch ? 'Jecht Shot ready' : 'Jecht Shot ready · E, or Tech on the wheel', 'good');
      else hud.log(`${match.teamDefs[d.team].short} have a Jecht Shot charged`, 'bad');
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
  const actions = input.consumeActions();
  if (!wheel.isOpen) {
    const kl = input.keyLook(dt);
    director.addNudge(-look.dx * 0.004 - kl.yaw, -look.dy * 0.003 + kl.pitch);
  } else if (look.dx || look.dy) director.addNudge(-look.dx * 0.004, -look.dy * 0.003);

  for (const a of actions) {
    if (a === 'pause') { setPaused(true); return; }
    if (a === 'mute') updateMute(sound.toggleMute());
  }
  if (wheel.isOpen) {
    for (const a of actions) wheel.handle(a);
  } else if (actions.includes('escape')) { setPaused(true); return; }

  const view = input.overview() && match.phase === 'play';
  if (view) match.slow('overview', SLOW.overview);
  else match.unslow('overview');

  if (!h || match.phase !== 'play') {
    if (h) h.desired.set(0, 0, 0);
    return;
  }

  const mv = input.move();
  const moving = Math.hypot(mv.x, mv.z) > 0.05;
  if (!moving) moveBasis.active = false;
  else if (!moveBasis.active || moveBasis.cuts === director.cuts) {
    // Track the camera while it only turns slowly; freeze the mapping across a cut.
    director.basis(moveBasis.fwd, moveBasis.right);
    moveBasis.cuts = director.cuts;
    moveBasis.active = true;
  }
  h.desired.set(0, 0, 0)
    .addScaledVector(moveBasis.fwd, mv.z)
    .addScaledVector(moveBasis.right, mv.x)
    .addScaledVector(up, mv.y);
  if (h.desired.lengthSq() > 1) h.desired.normalize();
  h.sprint = input.sprinting();

  if (wheel.isOpen) return;
  const hasBall = match.ball.owner === h;
  for (const a of actions) {
    switch (a) {
      case 'command':
      case 'click':
        match.openCommand();
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
    }
  }
}

// Shot slow motion lasts until the shot is over, then eases out.
function updateSlowTails() {
  const s = match.slows.get('shot');
  if (s && s.t === Infinity && match.ball.state !== 'shot') match.slow('shot', SLOW.shot, 0.5);
}

// Encounter bubbles round the defenders near the human's carrier, and Hold rings.
function updateRings() {
  for (const p of match.players) p.setRing(0, 0, 0);
  if (mode === 'attract' || !match.human || match.phase !== 'play') return;
  const h = match.human;
  const owner = match.ball.owner;
  if (owner === h) {
    for (const q of match.teams[1 - h.team]) {
      if (q.role === 'GK') continue;
      const gap = q.pos.distanceTo(h.pos) - q.encRadius;
      if (gap > 9) continue;
      const a = THREE.MathUtils.clamp(1 - gap / 9, 0, 1);
      const spent = q.encCd > 0 || q.stun > 0;
      const soft = match.encounter ? 0.5 : 1;
      q.setRing(q.encRadius, spent ? 0x9cc3cf : gap < 0 ? 0xff5a3c : 0xff9a66, (spent ? 0.12 : 0.38) * a * soft);
    }
  } else if (owner && owner.team !== h.team) {
    h.setRing(h.encRadius, 0x7ff3ff, 0.28);
  }
  for (const p of match.players) if (p.hold > 0) p.setRing(match.blockReach(p), 0x3fd0e8, 0.55);
}

// Passing lanes during an attacking encounter, coloured by the wheel's odds.
function updateLanes() {
  const e = match.encounter;
  const pass = wheel.isOpen && e && e.kind === 'attack' ? wheel.options.find((o) => o.id === 'pass') : null;
  if (!pass) { lanes.hide(); return; }
  const hot = hovered && hovered.target;
  lanes.update(pass.sub.filter((it) => it.target.role !== 'GK' || it.target === hot)
    .map((it) => ({ from: e.player, to: it.target, odds: it.odds, hot: it.target === hot })), gameTime);
}

// Power tag riding on a pass or shot (84 → 61 → 40), and Venom tags.
function updateTags() {
  const b = match.ball;
  if (mode !== 'attract' && (b.state === 'pass' || b.state === 'shot')) {
    const live = Math.max(0, Math.round(b.power));
    const html = [...ballChain.map((n) => `<s>${n}</s>`), `<b>${live}</b>`].join(' → ');
    floaters.tag('ball', b, html, { tone: b.state === 'shot' ? 'shot' : 'pass', dy: 0.7, size: b.state === 'shot' ? 'md' : 'sm' });
  } else floaters.untag('ball');
  for (const p of match.players) {
    const key = `venom${p.team}-${p.index}`;
    if (p.venom > 0 && mode !== 'attract') floaters.tag(key, p, 'Venom', { tone: 'venom', dy: 1.85, size: 'xs' });
    else floaters.untag(key);
  }
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
function frame() {
  const dt = Math.min(0.05, clock.getDelta());   // real time
  goalCam = Math.max(0, goalCam - dt);

  if (mode === 'play') controlHuman(dt);
  else {
    const acts = input.consumeActions();
    input.consumeLook();
    if (mode === 'paused' && (acts.includes('pause') || acts.includes('escape'))) setPaused(false);
  }

  if (mode !== 'paused') {
    match.update(dt);
    if (mode === 'play') {
      wheel.update(dt);
      updateSlowTails();
    }
  }
  // The world animates on game time, so slow motion slows everything in the sphere.
  const gdt = mode === 'paused' ? 0 : dt * match.timeScale;
  gameTime += gdt;
  director.update(mode === 'paused' ? 0 : dt, match, {
    mode, overview: mode === 'play' && input.overview(), goalCam: goalCam > 0,
    trackShot: mode === 'play', focusPlayer: goalFocus, time: gameTime,
  });
  arena.update(gdt, gameTime, camera, match.excitement);
  if (mode !== 'attract') sound.crowd(match.excitement);
  for (const p of match.players) p.updateVisual(gdt, gameTime, camera);
  updateRings();
  updateLanes();
  updateTags();
  document.body.classList.toggle('overview', director.shot === 'overview');
  floaters.update(mode === 'paused' ? 0 : dt);
  if (mode === 'play' || mode === 'paused') hud.update(dt, match, isTouch, wheel.isOpen);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// Handy for poking at a running match from the dev console.
window.ffbb = { get match() { return match; }, scene, camera, director, wheel, input };

buildMenu();
updateMute(false);
startAttract();
resize();
requestAnimationFrame(frame);
document.body.classList.add('ready');
