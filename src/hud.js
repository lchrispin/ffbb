import { SPHERE_R, GOAL_RING_R } from './config.js';
import { laneCost } from './ai.js';

const $ = (sel) => document.querySelector(sel);
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

export class Hud {
  constructor() {
    this.root = $('#hud');
    this.el = {
      homeName: $('#sb-home .sb-name'), homeScore: $('#sb-home .sb-score'), homeSwatch: $('#sb-home .sb-swatch'),
      awayName: $('#sb-away .sb-name'), awayScore: $('#sb-away .sb-score'), awaySwatch: $('#sb-away .sb-swatch'),
      clock: $('#sb-clock'), half: $('#sb-half'),
      callout: $('#callout'), calloutMain: $('#callout .co-main'), calloutSub: $('#callout .co-sub'),
      ticker: $('#ticker'),
      cardName: $('#card-name'), cardRole: $('#card-role'), hpFill: $('#hp-fill'), hpText: $('#hp-text'),
      stats: $('#card-stats'), odFill: $('#od-fill'), odLabel: $('#od-label'),
      hints: $('#hints'),
      radar: $('#radar'),
    };
    this.radarCtx = this.el.radar.getContext('2d');
    this.cache = {};
    this.calloutTimer = 0;
    this.cardFor = null;
  }

  show(on) { this.root.hidden = !on; }

  setTeams(defs) {
    this.el.homeName.textContent = defs[0].short;
    this.el.awayName.textContent = defs[1].short;
    this.el.homeSwatch.style.background = hex(defs[0].color);
    this.el.awaySwatch.style.background = hex(defs[1].color);
    this.teamColors = defs.map((d) => hex(d.color));
    this.el.ticker.replaceChildren();
  }

  set(key, el, value, prop = 'textContent') {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    el[prop] = value;
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

  log(text, tone = 'neutral') {
    const li = document.createElement('li');
    li.textContent = text;
    li.dataset.tone = tone;
    this.el.ticker.prepend(li);
    while (this.el.ticker.children.length > 4) this.el.ticker.lastElementChild.remove();
    setTimeout(() => li.classList.add('old'), 4500);
  }

  update(dt, m, touch) {
    if (this.calloutTimer > 0) {
      this.calloutTimer -= dt;
      if (this.calloutTimer <= 0) this.el.callout.hidden = true;
    }
    this.set('hs', this.el.homeScore, String(m.score[0]));
    this.set('as', this.el.awayScore, String(m.score[1]));
    const t = Math.max(0, Math.ceil(m.clock));
    this.set('clock', this.el.clock, `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`);
    this.set('half', this.el.half, m.half === 1 ? '1st half' : '2nd half');

    const p = m.human;
    if (p) {
      if (this.cardFor !== p) {
        this.cardFor = p;
        this.el.cardName.textContent = `${p.def.num} · ${p.name}`;
        this.el.cardRole.textContent = roleName(p.role);
        this.el.stats.replaceChildren(...['SP', 'EN', 'AT', 'PA', 'BL', 'SH', 'CA'].map((k) => {
          const d = document.createElement('div');
          d.innerHTML = `<dt>${k}</dt><dd>${Math.round(p.stat(k))}</dd>`;
          return d;
        }));
      }
      const hpPct = Math.round((p.hp / p.maxHp) * 100);
      this.set('hp', this.el.hpFill.style, `${hpPct}%`, 'width');
      this.set('hpt', this.el.hpText, `${Math.round(p.hp)} / ${p.maxHp}`);
      this.set('hpLow', this.el.hpFill.dataset, hpPct < 30 ? 'low' : 'ok', 'state');
    }
    const od = m.overdrive[m.humanTeam];
    this.set('od', this.el.odFill.style, `${Math.round(od * 100)}%`, 'width');
    this.set('odr', this.el.odLabel, od >= 1 ? (touch ? 'Jecht Shot ready' : 'Jecht Shot ready · E') : 'Jecht Shot');
    this.set('odState', this.el.odFill.dataset, od >= 1 ? 'full' : 'charging', 'state');

    this.set('hints', this.el.hints, hintText(m, touch), 'innerHTML');
    this.drawRadar(m);
  }

  drawRadar(m) {
    const c = this.el.radar;
    const x = this.radarCtx;
    const W = c.width;
    const r = W / 2 - 6;
    const s = r / SPHERE_R;
    x.clearRect(0, 0, W, W);
    x.save();
    x.translate(W / 2, W / 2);
    x.fillStyle = 'rgba(8, 60, 84, 0.55)';
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
    // Goals at the left and right edges, coloured by the team defending them.
    for (const [side, t] of [[-1, 0], [1, 1]]) {
      x.fillStyle = this.teamColors[t];
      x.fillRect(side * r - 3, -GOAL_RING_R * s, 6, GOAL_RING_R * s * 2);
    }
    // Seen from above: x across, z down the screen. Dot size shows height.
    for (const p of m.players) {
      const px = p.pos.x * s;
      const py = p.pos.z * s;
      const size = 3 + (p.pos.y / SPHERE_R + 1) * 1.6;
      x.fillStyle = this.teamColors[p.team];
      x.beginPath();
      x.arc(px, py, size, 0, Math.PI * 2);
      x.fill();
      if (p === m.human) {
        x.strokeStyle = '#7ff3ff';
        x.lineWidth = 2;
        x.beginPath();
        x.arc(px, py, size + 3, 0, Math.PI * 2);
        x.stroke();
      }
    }
    const b = m.ball.pos;
    x.fillStyle = '#ffffff';
    x.beginPath();
    x.arc(b.x * s, b.z * s, 2.8, 0, Math.PI * 2);
    x.fill();
    x.restore();
  }
}

function roleName(r) {
  return { LF: 'Left forward', RF: 'Right forward', MF: 'Midfield', LD: 'Left defence', RD: 'Right defence', GK: 'Keeper' }[r];
}

function key(k) { return `<kbd>${k}</kbd>`; }

function hintText(m, touch) {
  if (touch) return '';
  const p = m.human;
  if (!p || m.phase !== 'play') return `${key('W A S D')} swim ${key('Space')}${key('C')} up/down ${key('Mouse')} look`;
  if (m.ball.owner === p) {
    const to = m.passTarget ? m.passTarget.name : '—';
    const odds = Math.round(m.shotOdds(p, laneCost(m, p.team, p.pos, m.attackGoal(p.team)) * 0.8) * 100);
    const special = m.overdrive[p.team] >= 1 ? `<span>${key('E')} Jecht Shot</span>` : '';
    return `<span>${key('J')}/${key('Click')} pass → <b>${to}</b></span><span>${key('K')}/${key('R-click')} shoot <b>${odds}%</b></span>${special}<span>${key('Shift')} sprint</span>`;
  }
  return `<span>${key('J')}/${key('Click')} tackle</span><span>${key('Q')} switch</span><span>${key('F')} face ball</span><span>${key('Shift')} sprint</span>`;
}
