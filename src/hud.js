import * as THREE from './lib.js';
import { SPHERE_R, GOAL_RING_R, SLOT_NAMES, ROLES } from './config.js';
import { describeOrder } from './input.js';

const $ = (sel) => document.querySelector(sel);
const hex = (n) => '#' + n.toString(16).padStart(6, '0');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tmp = new THREE.Vector3();

// Scoreboard, squad list, player card, match log, risk panel, radar and callouts.
export class Hud {
  constructor() {
    this.root = $('#hud');
    this.el = {
      homeName: $('#sb-home .sb-name'), homeScore: $('#sb-home .sb-score'), homeSwatch: $('#sb-home .sb-swatch'),
      awayName: $('#sb-away .sb-name'), awayScore: $('#sb-away .sb-score'), awaySwatch: $('#sb-away .sb-swatch'),
      clock: $('#sb-clock'), half: $('#sb-half'), phase: $('#phase-tag'),
      callout: $('#callout'), calloutMain: $('#callout .co-main'), calloutSub: $('#callout .co-sub'),
      squad: $('#squad-list'), opp: $('#opp-list'),
      cardName: $('#card-name'), cardRole: $('#card-role'), hpFill: $('#hp-fill'), hpText: $('#hp-text'),
      stats: $('#card-stats'), cardOrder: $('#card-order'), cardReach: $('#card-reach'),
      odFill: $('#od-fill'), odLabel: $('#od-label'), odPct: $('#od-pct'),
      log: $('#log'), hint: $('#hint'),
      risk: $('#risk'), riskTitle: $('#risk-title'), riskPct: $('#risk-pct'), riskLines: $('#risk-lines'),
      goalview: $('#goalview'), gvCap: $('#gv-cap'),
      radar: $('#radar'), floaters: $('#floaters'),
      tacBadge: $('#tac-badge'),
    };
    this.radarCtx = this.el.radar.getContext('2d');
    this.calloutTimer = 0;
    this.floaters = [];
    this.heightKey = false;
    this.onSelect = () => {};
  }

  show(on) { this.root.hidden = !on; }

  setTeams(defs, humanTeam) {
    this.defs = defs;
    this.humanTeam = humanTeam;
    this.el.homeName.textContent = defs[0].short;
    this.el.awayName.textContent = defs[1].short;
    this.el.homeSwatch.style.background = hex(defs[0].color);
    this.el.awaySwatch.style.background = hex(defs[1].color);
    this.teamColors = defs.map((d) => hex(d.color));
    this.el.log.replaceChildren();
    for (const f of this.floaters) f.el.remove();
    this.floaters = [];
  }

  setScore(score) {
    this.el.homeScore.textContent = score[0];
    this.el.awayScore.textContent = score[1];
  }

  setClock(minute, half) {
    this.el.clock.textContent = `${minute}'`;
    this.el.half.textContent = half === 1 ? '1st half' : '2nd half';
  }

  setPhase(kind, text) {
    this.el.phase.dataset.phase = kind;
    this.el.phase.textContent = text;
  }

  setChanges(n) {
    this.el.tacBadge.textContent = n;
    this.el.tacBadge.dataset.empty = n <= 0 ? '1' : '0';
  }

  setHint(text) {
    this.hintText = text;
    this.el.hint.innerHTML = `${esc(text)}${this.heightKey ? '<span id="height-flag">HEIGHT</span>' : ''}`;
  }

  setHeightKey(on) {
    this.heightKey = on;
    if (this.hintText != null) this.setHint(this.hintText);
  }

  tone(team) {
    if (team == null || team < 0) return 'neutral';
    return team === this.humanTeam ? 'good' : 'bad';
  }

  callout(main, sub = '', tone = 'neutral', seconds = 1.8) {
    const c = this.el.callout;
    this.el.calloutMain.textContent = main;
    this.el.calloutSub.textContent = sub;
    c.dataset.tone = tone;
    c.classList.remove('pop');
    void c.offsetWidth; // restart the animation
    c.classList.add('pop');
    c.hidden = false;
    this.calloutTimer = seconds;
  }

  // Duel readout that floats over the spot where it happened.
  floater(text, pos, tone, seconds = 2.2) {
    const el = document.createElement('div');
    el.className = 'floater';
    el.dataset.tone = tone;
    el.textContent = text;
    this.el.floaters.append(el);
    // Stack floaters that land close together.
    const lift = this.floaters.filter((f) => f.life > 0.5).length * 30;
    this.floaters.push({ el, pos: new THREE.Vector3(...pos), life: seconds, max: seconds, lift });
  }

  clearFloaters() {
    for (const f of this.floaters) f.el.remove();
    this.floaters = [];
  }

  logBeat(text) {
    const li = document.createElement('li');
    li.className = 'beat';
    li.textContent = text;
    this.el.log.append(li);
    this.trimLog();
  }

  log(text, tone = 'neutral', minute = null, big = false) {
    const li = document.createElement('li');
    li.dataset.tone = tone;
    if (big) li.dataset.big = '1';
    li.innerHTML = `${minute != null ? `<span class="min">${minute}'</span>` : ''}${esc(text)}`;
    this.el.log.append(li);
    this.trimLog();
  }

  trimLog() {
    while (this.el.log.children.length > 220) this.el.log.firstElementChild.remove();
    this.el.log.scrollTop = this.el.log.scrollHeight;
  }

  // ---------- squad and card ----------

  renderSquad(m, ui) {
    const team = ui.team;
    const row = (u, withOrder) => {
      const o = withOrder ? ui.orders[u.slotIndex] : null;
      const hp = Math.round((u.hp / u.maxHp) * 100);
      const manual = withOrder && ui.manual[u.slotIndex];
      const ball = m.ball.owner === u ? '<span class="ball" title="Has the ball">●</span>' : '';
      const role = u.isKeeper ? 'GK' : `${u.slot} · ${ROLES[u.role] ? ROLES[u.role].label : ''}`;
      return `<li class="sq" data-id="${u.id}" aria-selected="${ui.sel === u}" style="--team:${this.teamColors[u.team]}">
        <span class="num">${u.def.num}</span>
        <span class="nm">${esc(u.name)}${ball}<small>${role}</small></span>
        ${withOrder ? `<span class="tag" data-manual="${manual ? 1 : 0}">${manual ? 'set' : 'auto'}</span>` : '<span class="hpbar"><i style="width:' + hp + '%" data-low="' + (hp < 40 ? 1 : 0) + '"></i></span>'}
        ${withOrder ? `<span class="ord"><b>${esc(describeOrder(m, u, o))}</b></span><span class="hpbar"><i style="width:${hp}%" data-low="${hp < 40 ? 1 : 0}"></i></span>` : ''}
      </li>`;
    };
    this.el.squad.innerHTML = m.teams[team].map((u) => row(u, true)).join('');
    this.el.opp.innerHTML = m.teams[1 - team].map((u) => row(u, false)).join('');
    for (const li of [...this.el.squad.children, ...this.el.opp.children]) {
      li.addEventListener('click', () => this.onSelect(m.units[+li.dataset.id]));
    }
  }

  renderCard(m, u, ui) {
    if (!u) return;
    this.el.cardName.textContent = `${u.def.num} · ${u.name}`;
    this.el.cardRole.textContent = `${m.teamDefs[u.team].short} · ${SLOT_NAMES[u.slot]}${u.isKeeper ? '' : ` · ${ROLES[u.role].label}`}`;
    const tired = u.fatigue() < 1;
    this.el.stats.innerHTML = ['SP', 'EN', 'AT', 'PA', 'BL', 'SH', 'CA']
      .map((k) => `<div><dt>${k}</dt><dd data-tired="${tired ? 1 : 0}">${Math.round(u.stat(k))}</dd></div>`).join('');
    const hpPct = Math.round((u.hp / u.maxHp) * 100);
    this.el.hpFill.style.width = `${hpPct}%`;
    this.el.hpFill.dataset.state = hpPct < 40 ? 'low' : 'ok';
    this.el.hpText.textContent = `${Math.round(u.hp)} / ${u.maxHp}${tired ? ' · tired' : ''}`;
    const own = u.team === ui.team && ui.active;
    const o = own ? ui.orders[u.slotIndex] : null;
    this.el.cardOrder.innerHTML = own ? `Order: <b>${esc(describeOrder(m, u, o))}</b>` : (u.team === ui.team ? '' : 'Opponent · orders hidden until the beat resolves');
    const carry = m.ball.owner === u;
    this.el.cardReach.textContent = `Reach ${u.reach(false, carry).toFixed(1)} m · sprint ${u.reach(true, carry).toFixed(1)} m · zone ${u.zoc().toFixed(1)} m (braced ${u.zoc(true).toFixed(1)})`;
    const od = m.overdrive[ui.team];
    this.el.odFill.style.width = `${Math.round(od * 100)}%`;
    this.el.odFill.dataset.state = od >= 1 ? 'full' : 'charging';
    this.el.odLabel.textContent = od >= 1 ? 'Jecht Shot ready' : 'Jecht Shot meter';
    this.el.odPct.textContent = `${Math.round(od * 100)}%`;
  }

  // ---------- risk panel ----------

  showRisk(risk, ui) {
    const el = this.el;
    if (!risk) { el.risk.hidden = true; return; }
    el.risk.hidden = false;
    const lines = [];
    const level = (p) => (p < 0.25 ? 'low' : p < 0.55 ? 'mid' : 'high');
    let title = '';
    let p = risk.p;
    const keepLine = risk.keep < 0.999 ? `<li>Keeps the ball on the dribble <b>${Math.round(risk.keep * 100)}%</b></li>` : '';
    const threats = risk.r && risk.r.threats ? risk.r.threats : [];
    const threatLine = threats.length
      ? `<li>Zones that could reach the line: <b>${threats.map((t) => `${esc(t.q.name)} ${t.fixed ? '(in lane)' : Math.round(t.p * 100) + '%'}`).join(', ')}</b></li>`
      : '<li>No defender can reach the line this beat</li>';
    el.goalview.hidden = true;
    el.gvCap.hidden = true;
    if (risk.kind === 'pass' || risk.kind === 'through') {
      title = risk.kind === 'pass' ? `Pass → ${risk.q.name}` : 'Through ball';
      lines.push(`<li>Power <b>${Math.round(risk.r.power)}</b> → about <b>${Math.round(risk.r.arrive)}</b> on arrival · ${Math.round(risk.r.dist)} m</li>`);
      lines.push(threatLine, keepLine);
      if (risk.kind === 'through') lines.push('<li>A through ball stops at the point: whoever gets there first takes it</li>');
    } else if (risk.kind === 'shot' || risk.kind === 'tech') {
      const r = risk.r;
      title = risk.kind === 'tech' ? 'Jecht Shot' : 'Shot';
      lines.push(`<li>On target <b>${Math.round(r.onTarget * 100)}%</b> · blocked <b>${Math.round(r.blocked * 100)}%</b> · ${Math.round(r.dist)} m</li>`);
      const lo = Math.round(r.gripLo);
      const hi = Math.round(r.gripHi);
      const max = Math.max(hi, r.power) * 1.05;
      lines.push(`<li>Power at keeper ~<b>${Math.round(r.expPower)}</b> vs ${esc(r.keeper.name)}'s grip <b>${lo}–${hi}</b>${r.outOfReach ? ' (fingertips only)' : r.stretch < 0.99 ? ` (stretched ${Math.round(r.stretch * 100)}%)` : ''}
        <div class="gripbar"><span class="grip" style="left:${(lo / max) * 100}%;width:${((hi - lo) / max) * 100}%"></span><span class="pow" style="left:${(r.expPower / max) * 100}%"></span></div></li>`);
      lines.push(threatLine, keepLine);
      el.goalview.hidden = false;
      el.gvCap.hidden = false;
      if (ui && ui.goalView) {
        const u = ui.sel;
        const o = ui.orders[u.slotIndex];
        ui.goalView.draw(ui.m, u, o, { ...ui.estimateFrom(u, o), wobble: r.wobble });
      }
    } else if (risk.kind === 'dribble') {
      title = 'Keep the ball';
      p = risk.keep;
      lines.push('<li>Chance nobody who could press wins a tackle on the way</li>');
    } else if (risk.kind === 'press') {
      title = `Tackle ${risk.c.name}`;
      p = risk.t.chance;
      lines.push(`<li>AT <b>${Math.round(risk.t.at)}</b> vs EN <b>${Math.round(risk.t.en)}</b> · if they meet</li>`);
      lines.push(risk.inReach ? '<li>Can reach the carrier this beat</li>' : '<li><b>Out of reach</b> this beat: they will only close the distance</li>');
    }
    el.riskTitle.textContent = title;
    el.riskPct.textContent = `${Math.round(p * 100)}%`;
    el.riskPct.dataset.level = level(p);
    el.riskLines.innerHTML = lines.join('');
  }

  // ---------- per frame ----------

  update(dt, camera, positions, m) {
    if (this.calloutTimer > 0) {
      this.calloutTimer -= dt;
      if (this.calloutTimer <= 0) this.el.callout.hidden = true;
    }
    const w = innerWidth;
    const h = innerHeight;
    for (const f of this.floaters) {
      f.life -= dt;
      if (f.life <= 0) { f.el.remove(); continue; }
      tmp.copy(f.pos).project(camera);
      const visible = tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
      f.el.style.display = visible ? '' : 'none';
      // Keep clear of the side panels on wide screens.
      const [lo, hi] = w > 1100 ? [300 + 130, w - 330 - 130] : [110, w - 110];
      const x = THREE.MathUtils.clamp((tmp.x * 0.5 + 0.5) * w, lo, Math.max(lo, hi));
      const y = THREE.MathUtils.clamp((-tmp.y * 0.5 + 0.5) * h - 28 - f.lift - (1 - f.life / f.max) * 26, 90, h - 120);
      f.el.style.left = `${x}px`;
      f.el.style.top = `${y}px`;
      f.el.style.opacity = String(Math.min(1, f.life * 2));
    }
    this.floaters = this.floaters.filter((f) => f.life > 0);
    if (positions) this.drawRadar(positions, m);
  }

  drawRadar(positions, m) {
    const c = this.el.radar;
    const x = this.radarCtx;
    const W = c.width;
    const r = W / 2 - 6;
    const s = r / SPHERE_R;
    x.clearRect(0, 0, W, W);
    x.save();
    x.translate(W / 2, W / 2);
    x.fillStyle = 'rgba(8, 60, 84, 0.6)';
    x.strokeStyle = 'rgba(160, 235, 255, 0.55)';
    x.lineWidth = 1.5;
    x.beginPath();
    x.arc(0, 0, r, 0, Math.PI * 2);
    x.fill();
    x.stroke();
    x.strokeStyle = 'rgba(160, 235, 255, 0.18)';
    x.beginPath();
    x.moveTo(0, -r);
    x.lineTo(0, r);
    x.stroke();
    x.beginPath();
    x.arc(0, 0, r * 0.5, 0, Math.PI * 2);
    x.stroke();
    for (const [side, t] of [[-1, 0], [1, 1]]) {
      x.fillStyle = this.teamColors[t];
      x.fillRect(side * r - 3, -GOAL_RING_R * s, 6, GOAL_RING_R * s * 2);
    }
    // Seen from above: x across, z down the screen. Dot size shows height.
    positions.players.forEach((p, i) => {
      const team = i < 6 ? 0 : 1;
      const size = 3 + (p.y / SPHERE_R + 1) * 1.8;
      x.fillStyle = this.teamColors[team];
      x.beginPath();
      x.arc(p.x * s, p.z * s, size, 0, Math.PI * 2);
      x.fill();
      if (positions.sel === i) {
        x.strokeStyle = '#7ff3ff';
        x.lineWidth = 2;
        x.beginPath();
        x.arc(p.x * s, p.z * s, size + 3, 0, Math.PI * 2);
        x.stroke();
      }
    });
    const b = positions.ball;
    x.fillStyle = '#ffffff';
    x.beginPath();
    x.arc(b.x * s, b.z * s, 3, 0, Math.PI * 2);
    x.fill();
    x.restore();
  }
}

