import * as THREE from './lib.js';
import {
  TEAMS, MATCH_LENGTHS, DIFFICULTY, ASSIST, SPHERE_R, sideSign,
  defaultTactics, aiTactics, cloneTactics,
} from './config.js';
import { buildArena } from './arena.js';
import { Match, newOrder } from './match.js';
import { planTeam, fixOrder } from './ai.js';
import { MatchView } from './view.js';
import { Overlay } from './overlay.js';
import { CameraRig } from './camera.js';
import { PlanUI, GoalView, describeOrder } from './input.js';
import { Hud } from './hud.js';
import { TacticsScreen } from './tactics.js';
import { Sound } from './audio.js';
import { simulateMany, simulateMatch } from './selfplay.js';

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
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
const arena = buildArena(scene, [TEAMS.aurochs.color, TEAMS.goers.color]);
const isTouch = matchMedia('(pointer: coarse)').matches;
document.body.classList.toggle('touch', isTouch);

const view = new MatchView(scene);
const overlay = new Overlay(scene);
overlay.camera = camera;
const rig = new CameraRig(camera);
const hud = new Hud();
const sound = new Sound();
const HUMAN = 0;

const ui = {
  menu: document.getElementById('menu'),
  pause: document.getElementById('pause'),
  interval: document.getElementById('interval'),
  orderbar: document.getElementById('orderbar'),
  playbar: document.getElementById('playbar'),
  hint: document.getElementById('hint'),
  risk: document.getElementById('risk'),
  pbLabel: document.getElementById('pb-label'),
  pbSpeed: document.querySelector('#pb-speed span'),
};

const settings = loadSettings();
let match = null;
let mode = 'attract';   // attract | tactics | plan | playback | interval | paused
let pausedFrom = null;
let pb = null;          // current playback
let lastRec = null;
let speed = 1;
let excitement = 0;
const attract = { match: null, rec: null, t: 0 };

const plan = new PlanUI({
  canvas, camera, rig, overlay, view, hud,
  onResolve: () => resolveBeat(),
  onChange: () => refreshPanels(),
});
plan.goalView = new GoalView(document.getElementById('goalview'), (aim) => {
  const u = plan.sel;
  if (!plan.active || !plan.own(u) || !plan.isCarrier(u)) return;
  plan.edit((o) => {
    if (o.type !== 'shoot' && o.type !== 'tech') o.type = 'shoot';
    o.aim = aim;
  });
});
hud.onSelect = (u) => {
  if (mode !== 'plan') return;
  plan.select(u);
};

const tactics = new TacticsScreen({
  onApply: (res) => applyTactics(res),
  onCancel: () => { if (tacticsReturn) tacticsReturn(); },
});
let tacticsReturn = null;

// ---------- match lifecycle ----------

function profile(team) {
  return team === HUMAN ? ASSIST : DIFFICULTY[match.difficulty];
}

function startMatch() {
  sound.start();
  const pick = settings.team;
  const other = pick === 'aurochs' ? 'goers' : 'aurochs';
  const len = MATCH_LENGTHS.find((l) => l.id === settings.length) || MATCH_LENGTHS[1];
  const diff = settings.difficulty;
  match = new Match({
    teamIds: [pick, other],
    statScales: [1, DIFFICULTY[diff].aiStat],
    beatsPerHalf: len.beats,
    tactics: [settings.tactics ? cloneTactics(settings.tactics) : defaultTactics(), aiTactics(diff)],
  });
  match.difficulty = diff;
  lastRec = null;
  view.attach(match);
  overlay.setTeams(match.teamDefs);
  arena.goals[0].setColor(match.teamDefs[0].color);
  arena.goals[1].setColor(match.teamDefs[1].color);
  hud.setTeams(match.teamDefs, HUMAN);
  hud.setScore(match.score);
  hud.logBeat(`${match.teamDefs[0].name} v ${match.teamDefs[1].name} · ${DIFFICULTY[diff].label}`);
  ui.menu.hidden = true;
  ui.interval.hidden = true;
  ui.pause.hidden = true;
  hud.show(true);
  document.body.classList.add('playing');
  rig.mode = 'orbit';
  rig.reset(true);
  openTactics('prematch');
}

function openTactics(kind) {
  if (!match) return;
  const prev = mode;
  mode = 'tactics';
  tacticsReturn = () => {
    mode = prev === 'tactics' ? 'plan' : prev;
    if (prev === 'interval') ui.interval.hidden = false;
    tacticsReturn = null;
  };
  if (prev === 'interval') ui.interval.hidden = true;
  tactics.open(match, HUMAN, { mode: kind, changesLeft: match.changesLeft[HUMAN] });
}

function applyTactics({ tactics: t, subs, changed }) {
  const kind = tactics.mode;
  if (kind === 'inplay' && changed) match.changesLeft[HUMAN]--;
  match.setTactics(HUMAN, cloneTactics(t));
  for (const s of subs) {
    const u = match.teams[HUMAN][s.slot];
    const outName = u.name;
    if (match.substitute(HUMAN, s.slot, s.bench)) hud.log(`Substitution: ${u.name} on for ${outName}`, 'good', match.minute());
  }
  view.refresh();
  settings.tactics = cloneTactics(t);
  saveSettings();
  if (changed && kind === 'inplay') hud.log(`Tactics changed (${match.changesLeft[HUMAN]} changes left this half)`, 'neutral', match.minute());
  hud.setChanges(match.changesLeft[HUMAN]);
  tacticsReturn = null;
  if (kind === 'prematch') {
    // The kickoff shape follows the formation just chosen.
    match.setupKickoff();
    view.sync();
    beginPlanning();
  } else if (kind === 'halftime') {
    mode = 'interval';
    ui.interval.hidden = false;
  } else {
    // Re-plan everyone the player hasn't overridden.
    const auto = planTeam(match, HUMAN, match.tactics[HUMAN], ASSIST);
    const keep = plan.orders.map((o, i) => (plan.manual[i] ? o : null));
    plan.start(match, HUMAN, auto);
    keep.forEach((o, i) => { if (o) { plan.orders[i] = o; plan.manual[i] = true; } });
    mode = 'plan';
    refreshPanels();
  }
}

function beginPlanning() {
  if (match.phase === 'halftime') return showInterval(false);
  if (match.phase === 'fulltime') return showInterval(true);
  mode = 'plan';
  pb = null;
  view.sync();
  rig.mode = 'orbit';
  rig.celebrate = null;
  overlay.showGuides(true, 1);
  const auto = planTeam(match, HUMAN, match.tactics[HUMAN], ASSIST);
  plan.start(match, HUMAN, auto);
  ui.orderbar.hidden = false;
  ui.playbar.hidden = true;
  ui.hint.hidden = false;
  hud.setScore(match.score);
  hud.setClock(match.minute(), match.half);
  hud.setChanges(match.changesLeft[HUMAN]);
  hud.setPhase('plan', `Planning · beat ${match.beat + 1} of ${match.beatsPerHalf}${match.kickoffPending ? ' · kickoff' : ''}`);
  refreshPanels();
}

function refreshPanels() {
  if (!match) return;
  hud.renderSquad(match, plan);
  hud.renderCard(match, plan.sel || match.teams[HUMAN][2], plan);
}

function resolveBeat() {
  if (mode !== 'plan') return;
  sound.start();
  const ai = planTeam(match, 1 - HUMAN, match.tactics[1 - HUMAN], profile(1 - HUMAN));
  const orders = HUMAN === 0 ? [plan.orders, ai] : [ai, plan.orders];
  plan.orders.forEach((o, i) => fixOrder(match, match.teams[HUMAN][i], o));
  const rec = match.resolveBeat(orders);
  plan.stop();
  lastRec = rec;
  hud.logBeat(`${rec.minuteBefore}' · beat ${rec.beat + 1}${rec.half === 2 ? ' (2nd half)' : ''}`);
  // The opponent's orders are revealed only now.
  const opp = match.teams[1 - HUMAN].map((u) => `${u.name}: ${describeOrderFor(u, rec.orders[1 - HUMAN][u.slotIndex])}`);
  hud.log(`${match.teamDefs[1 - HUMAN].short} orders · ${opp.join(' · ')}`, 'neutral');
  startPlayback(rec, true);
}

function describeOrderFor(u, o) {
  // Describe against the state at the start of the beat (the carrier may have changed).
  const txt = describeOrder(match, u, o);
  return o.type === 'hold' ? 'hold' : txt;
}

// ---------- playback ----------

function startPlayback(rec, first) {
  mode = 'playback';
  pb = { rec, t: 0, ev: 0, first, slow: 1, slowUntil: 0, attackTeam: attackingTeam(rec, 0) };
  view.applyFrame(rec, 0);
  hud.setScore(rec.scoreBefore);
  hud.clearFloaters();
  hud.setClock(rec.minuteBefore, rec.half);
  hud.setPhase('playback', first ? `Beat ${rec.beat + 1} · playing out` : `Replay · beat ${rec.beat + 1}`);
  ui.orderbar.hidden = true;
  ui.playbar.hidden = false;
  ui.hint.hidden = true;
  ui.risk.hidden = true;
  ui.pbLabel.textContent = first ? `Beat ${rec.beat + 1} of ${match.beatsPerHalf}` : 'Replay';
  rig.mode = 'director';
  rig.celebrate = null;
  rig.wide(view.ball.pos, pb.attackTeam);
  overlay.showGuides(true, 0.45);
}

// Which side the play is going toward: whoever holds (or last touched) the ball.
function attackingTeam(rec, t) {
  const f = rec.frames[Math.min(rec.frames.length - 1, Math.floor(t / (1 / 30)))];
  const owner = f[100];
  if (owner >= 0) return owner < 6 ? 0 : 1;
  return f[96] > 0 ? 0 : 1;
}

function fire(e, live) {
  const tone = hud.tone(e.team);
  const minute = e.type === 'halftime' || e.type === 'fulltime' ? pb.rec.half * 45 : pb.rec.minuteBefore;
  if (pb.first) hud.log(e.text, tone, minute, !!e.big);
  if (!live) return;
  const shooter = e.ids && e.ids.length ? view.players[e.ids[0]] : null;
  switch (e.type) {
    case 'launch':
      hud.callout('Kickoff', 'The ball launches from the floor of the sphere', 'neutral', 1.6);
      sound.whistle();
      break;
    case 'pass':
      sound.bubbles(3);
      break;
    case 'shot':
    case 'tech':
      sound.thump(e.type === 'tech' ? 1.6 : 1, e.type === 'tech' ? 0.6 : 1);
      if (shooter) rig.shotCam(shooter.pos, shooter.team);
      pb.slow = 0.35;
      pb.slowUntil = e.t + 1.6;
      if (e.type === 'tech') hud.callout('Jecht Shot', e.text.replace('JECHT SHOT! ', ''), tone, 1.6);
      excitement = Math.max(excitement, 0.5);
      break;
    case 'goal': {
      const scorer = e.team;
      arena.goals[scorer === 0 ? 1 : 0].flash();
      sound.chime(scorer === HUMAN);
      sound.thump(1.4, 0.5);
      sound.whistle(true);
      const [a, b] = match.teamDefs;
      const sc = [...pb.rec.scoreAfter];
      hud.setScore(sc);
      hud.callout('Goal!', `${e.text.replace(/^GOAL! /, '').split(' · ')[0]} · ${a.short} ${sc[0]}–${sc[1]} ${b.short}`, tone, 3);
      rig.startCelebration(new THREE.Vector3(...e.pos));
      pb.slow = 0.6;
      pb.slowUntil = e.t + 3;
      excitement = 1;
      break;
    }
    case 'save':
    case 'beaten':
    case 'block':
    case 'deflect':
    case 'intercept':
    case 'tackle':
    case 'breakthrough':
    case 'knockback':
    case 'wide':
    case 'fizzle':
      if (e.pos) hud.floater(e.text, e.pos, tone, 2.6);
      if (e.type === 'save' || e.type === 'block' || e.type === 'intercept' || e.type === 'tackle') sound.thump(0.7, 1.3);
      if (['save', 'block', 'wide', 'fizzle', 'intercept'].includes(e.type) && pb.slowUntil > e.t) pb.slowUntil = e.t + 0.5;
      if (e.type === 'save') excitement = Math.max(excitement, 0.6);
      break;
    case 'overdrive':
      hud.callout('Jecht Shot ready', match.teamDefs[e.team].name, tone, 1.4);
      break;
    case 'halftime':
    case 'fulltime':
      sound.whistle(true);
      break;
  }
}

function updatePlayback(dt) {
  const rec = pb.rec;
  if (pb.slowUntil && pb.t > pb.slowUntil) { pb.slow = 1; pb.slowUntil = 0; }
  pb.t += dt * speed * pb.slow;
  const events = rec.events;
  while (pb.ev < events.length && events[pb.ev].t <= pb.t) fire(events[pb.ev++], true);
  const st = view.applyFrame(rec, pb.t);
  if (st.owner >= 0) pb.attackTeam = st.owner < 6 ? 0 : 1;
  rig.direct(dt, view.ball.pos, pb.attackTeam);
  // Both sides' orders, drawn faintly now that they are revealed.
  overlay.clear();
  if (pb.t < 1.2) {
    rec.orders.forEach((os, team) => os.forEach((o, i) => {
      const from = rec.start[team * 6 + i];
      if (o.target) overlay.beam(from, o.target, '#' + new THREE.Color(match.teamDefs[team].color).getHexString(), 0.04, 0.5 * (1 - pb.t / 1.2));
    }));
  }
  if (pb.t >= rec.duration + 0.35) finishPlayback();
}

function skipPlayback() {
  if (!pb) return;
  while (pb.ev < pb.rec.events.length) fire(pb.rec.events[pb.ev++], false);
  hud.setScore(pb.rec.scoreAfter);
  finishPlayback();
}

// After a first showing or a replay, go back to planning (or to the interval screen).
function finishPlayback() {
  pb = null;
  hud.clearFloaters();
  beginPlanning();
}

// ---------- interval ----------

function showInterval(final) {
  mode = 'interval';
  plan.stop();
  hud.setClock(final ? 90 : 45, match.half);
  hud.setScore(match.score);
  hud.setPhase('plan', final ? 'Full time' : 'Half time');
  ui.orderbar.hidden = true;
  ui.playbar.hidden = true;
  ui.hint.hidden = true;
  rig.mode = 'orbit';
  rig.reset();
  const [a, b] = match.teamDefs;
  const [sa, sb] = match.score;
  let title = 'Half time';
  if (final) title = sa > sb ? `${a.name} win` : sa < sb ? `${b.name} win` : 'Full time · Draw';
  document.getElementById('interval-title').textContent = title;
  document.getElementById('interval-score').innerHTML = `<span>${a.short}</span><b>${sa}</b><i>–</i><b>${sb}</b><span>${b.short}</span>`;
  const goals = match.history.filter((h) => h.type === 'goal').map((h) => `${h.minute}' ${h.text.replace(/^GOAL! /, '').split(' · ')[0]}`);
  document.getElementById('interval-scorers').textContent = goals.length ? goals.join(' · ') : 'No goals yet';
  const st = match.stats;
  const total = Math.max(1, st[0].possession + st[1].possession);
  const pctPoss = (t) => `${Math.round((st[t].possession / total) * 100)}%`;
  const rows = [
    ['Possession', pctPoss(0), pctPoss(1)],
    ['Shots', st[0].shots, st[1].shots],
    ['On target', st[0].onTarget, st[1].onTarget],
    ['Keeper saves', st[0].saves, st[1].saves],
    ['Shots blocked', st[0].blocks, st[1].blocks],
    ['Shot deflections', st[0].deflects, st[1].deflects],
    ['Interceptions', st[0].intercepts, st[1].intercepts],
    ['Tackles won', st[0].tackles, st[1].tackles],
    ['Passes completed', `${st[0].passes}/${st[0].passAtt}`, `${st[1].passes}/${st[1].passAtt}`],
  ];
  document.getElementById('interval-stats').innerHTML = rows.map(([k, x, y]) => `<tr><td>${x}</td><th>${k}</th><td>${y}</td></tr>`).join('');
  document.getElementById('interval-go').textContent = final ? 'Rematch' : 'Start 2nd half';
  document.getElementById('interval-tac').hidden = final;
  ui.interval.hidden = false;
  document.getElementById('interval-go').focus();
  sound.crowd(0.4);
}

document.getElementById('interval-go').addEventListener('click', () => {
  sound.start();
  ui.interval.hidden = true;
  if (match.phase === 'fulltime') { startMatch(); return; }
  match.startSecondHalf();
  hud.logBeat('Second half');
  view.sync();
  beginPlanning();
});
document.getElementById('interval-tac').addEventListener('click', () => openTactics('halftime'));
document.getElementById('interval-menu').addEventListener('click', () => startAttract());

// ---------- buttons ----------

document.getElementById('tac-btn').addEventListener('click', () => { if (mode === 'plan') openTactics('inplay'); });
document.getElementById('view-btn').addEventListener('click', () => rig.reset());
document.getElementById('replay-btn').addEventListener('click', () => replay());
document.getElementById('focus-btn').addEventListener('click', () => toggleFocus());
document.getElementById('log-btn').addEventListener('click', () => document.getElementById('logpanel').classList.toggle('open'));
document.getElementById('menu-btn').addEventListener('click', () => setPaused(true));
document.getElementById('resume').addEventListener('click', () => setPaused(false));
document.getElementById('quit').addEventListener('click', () => startAttract());
document.getElementById('pb-replay').addEventListener('click', () => replay());
document.getElementById('pb-speed').addEventListener('click', () => cycleSpeed());
document.getElementById('pb-skip').addEventListener('click', () => skipPlayback());
for (const id of ['mute', 'mute2']) {
  document.getElementById(id).addEventListener('click', () => { sound.start(); updateMute(sound.toggleMute()); });
}
function updateMute(m) {
  for (const id of ['mute', 'mute2']) {
    const b = document.getElementById(id);
    b.setAttribute('aria-pressed', String(m));
    b.textContent = m ? 'Sound off' : 'Sound on';
  }
}

function toggleFocus() {
  if (rig.follow) { rig.focusOn(null); rig.goal.target.set(0, -2, 0); return; }
  const u = plan.sel;
  if (u) rig.focusOn(() => view.players[u.id].pos);
}

function replay() {
  if (!lastRec || (mode !== 'plan' && mode !== 'playback')) return;
  if (mode === 'plan') plan.stop();
  startPlayback(lastRec, false);
}

function cycleSpeed() {
  speed = speed === 1 ? 2 : speed === 2 ? 0.5 : 1;
  ui.pbSpeed.textContent = `${speed}×`;
}

function setPaused(on) {
  if (on && mode !== 'paused' && mode !== 'attract') {
    pausedFrom = mode;
    mode = 'paused';
    ui.pause.hidden = false;
  } else if (!on && mode === 'paused') {
    mode = pausedFrom;
    ui.pause.hidden = true;
  }
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'KeyN' && !e.repeat) { sound.start(); updateMute(sound.toggleMute()); return; }
  if (mode === 'paused' && e.code === 'Escape') { setPaused(false); return; }
  if (mode === 'playback') {
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); skipPlayback(); }
    if (e.code === 'KeyR') replay();
    if (e.code === 'KeyX') cycleSpeed();
    if (e.code === 'Escape') setPaused(true);
    return;
  }
  if (mode !== 'plan') return;
  if (e.code === 'KeyR') replay();
  if (e.code === 'KeyO') openTactics('inplay');
  if (e.code === 'KeyC') rig.reset();
  if (e.code === 'KeyF') toggleFocus();
  if (e.code === 'Escape' && !plan.armed) setPaused(true);
});

// ---------- menu and attract mode ----------

function loadSettings() {
  const d = { team: 'aurochs', difficulty: 'normal', length: 'std', tactics: null };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem('ffbb.tactics.settings') || '{}') };
  } catch { return d; }
}
function saveSettings() {
  try { localStorage.setItem('ffbb.tactics.settings', JSON.stringify(settings)); } catch { /* storage is optional */ }
}

function bindChoice(name, key) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((el) => {
    el.checked = el.value === settings[key];
    el.addEventListener('change', () => { settings[key] = el.value; saveSettings(); });
  });
}

function buildMenu() {
  document.getElementById('team-options').innerHTML = Object.values(TEAMS).map((t) => {
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

// Behind the menu, the two clubs play each other on autopilot.
function startAttract() {
  mode = 'attract';
  plan.stop();
  pb = null;
  match = null;
  ui.menu.hidden = false;
  ui.pause.hidden = true;
  ui.interval.hidden = true;
  document.getElementById('tactics').hidden = true;
  hud.show(false);
  document.body.classList.remove('playing');
  const m = new Match({ teamIds: ['aurochs', 'goers'], beatsPerHalf: 9999, tactics: [aiTactics('normal'), aiTactics('hard')] });
  attract.match = m;
  attract.rec = null;
  view.attach(m);
  overlay.setTeams(m.teamDefs);
  overlay.showGuides(false);
  arena.goals[0].setColor(m.teamDefs[0].color);
  arena.goals[1].setColor(m.teamDefs[1].color);
  rig.mode = 'director';
  rig.celebrate = null;
  rig.wide(view.ball.pos, 0);
}

function updateAttract(dt) {
  const a = attract;
  if (!a.rec || a.t >= a.rec.duration + 0.3) {
    const m = a.match;
    a.rec = m.resolveBeat([0, 1].map((t) => planTeam(m, t, m.tactics[t], DIFFICULTY.normal)));
    a.t = 0;
    rig.celebrate = null;
  }
  const prev = a.t;
  a.t += dt;
  for (const e of a.rec.events) {
    if (e.t > prev && e.t <= a.t && e.type === 'goal') arena.goals[e.team === 0 ? 1 : 0].flash();
  }
  const st = view.applyFrame(a.rec, a.t);
  rig.direct(dt, view.ball.pos, st.owner >= 0 ? (st.owner < 6 ? 0 : 1) : null);
}

// ---------- per frame ----------

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w < h ? 72 : 55;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

const clock = new THREE.Clock();
let elapsed = 0;
const positions = { players: [], ball: null, sel: -1 };

function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  elapsed += dt;
  excitement = Math.max(0, excitement - dt * 0.2);

  if (mode === 'attract') updateAttract(dt);
  else if (mode === 'playback') updatePlayback(dt);

  if (mode === 'plan' || mode === 'tactics' || mode === 'interval' || (mode === 'paused' && pausedFrom === 'plan')) {
    rig.update(dt);
    if (mode === 'plan') {
      overlay.clear();
      plan.frame();
    }
  }
  const showDrops = mode !== 'attract';
  const m = match || attract.match;
  if (m) {
    positions.players = view.players.map((p) => p.pos);
    positions.ball = view.ball.pos;
    positions.sel = plan.sel ? plan.sel.id : -1;
    overlay.updateDrops(positions.players, m.units.map((u) => u.team), showDrops, mode === 'playback' ? 0.25 : 0.8);
  }
  arena.update(dt, elapsed, camera, excitement);
  if (mode !== 'attract') sound.crowd(excitement);
  view.update(dt, elapsed, camera);
  // Keep name labels readable from a distance.
  for (const p of view.players) {
    const k = THREE.MathUtils.clamp(camera.position.distanceTo(p.pos) * 0.05, 1, 3.4);
    p.label.scale.setScalar(k);
    p.label.position.y = 1.1 + 0.3 * k;
  }
  for (const p of view.players) p.marker.visible = mode === 'plan' && plan.sel && p === view.players[plan.sel.id];
  if (match && mode !== 'attract') hud.update(dt, camera, positions, match);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ---------- debug handle ----------

const v3 = (a) => (a ? new THREE.Vector3(...a) : null);
function unitAt(slot) { return match.teams[HUMAN][slot]; }
window.ffbb = {
  get match() { return match; },
  get mode() { return mode; },
  get plan() { return plan; },
  get lastRec() { return lastRec; },
  scene, camera, rig, view, overlay,
  startMatch(opts = {}) { Object.assign(settings, opts); startMatch(); },
  kickoff() { if (mode === 'tactics') document.getElementById('tac-apply').click(); },
  select(slot) { plan.select(unitAt(slot)); },
  carrierSlot() { const o = match.ball.owner; return o && o.team === HUMAN ? o.slotIndex : -1; },
  order(slot, o) { plan.setOrder(unitAt(slot), newOrder(o.type, { ...o, target: v3(o.target), point: v3(o.point) })); },
  move(slot, target, sprint = false) { this.order(slot, { type: 'move', target, sprint }); },
  pass(slot, toSlot, timing = 'start', target = null) { this.order(slot, { type: 'pass', passTo: unitAt(toSlot).id, timing, target }); },
  through(slot, point) { this.order(slot, { type: 'through', point }); },
  shoot(slot, aim = { y: 0, z: 0 }, timing = 'start', target = null) { this.order(slot, { type: 'shoot', aim, timing, target }); },
  command(cmd) { plan.command(cmd); },
  resolve() { resolveBeat(); },
  skip() { skipPlayback(); },
  replay() { replay(); },
  openTactics() { openTactics('inplay'); },
  simulate(n = 6, opts = {}) { return simulateMany(n, opts); },
  simulateMatch,
  sideSign,
  SPHERE_R,
};

buildMenu();
updateMute(false);
resize();
startAttract();
requestAnimationFrame(frame);
document.body.classList.add('ready');
