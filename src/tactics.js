import {
  SPHERE_R, GOAL_X, GOAL_RING_R, FORMATIONS, ROLES, PRESS, SHOOTING, SLOT_NAMES,
  defaultTactics, cloneTactics, copyBase,
} from './config.js';

// The Tactics screen: formation presets and a draggable top/side schematic, team
// instructions, roles, marking assignments and substitutions. It edits a draft and
// hands it back on Apply; the caller decides what that costs.

const $ = (sel) => document.querySelector(sel);
const hex = (n) => '#' + n.toString(16).padStart(6, '0');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Schematic layout in canvas pixels (the canvas is drawn at 2x).
const W = 800;
const SC = 6.4;
const TOP = { cx: 400, cy: 222 };
const SIDE = { cx: 400, cy: 662 };

export class TacticsScreen {
  constructor({ onApply, onCancel }) {
    this.onApply = onApply;
    this.onCancel = onCancel;
    this.root = $('#tactics');
    this.canvas = $('#schematic');
    this.ctx = this.canvas.getContext('2d');
    this.drag = null;
    this.bind();
  }

  open(m, team, { mode, changesLeft }) {
    this.m = m;
    this.team = team;
    this.mode = mode;
    this.changesLeft = changesLeft;
    this.original = cloneTactics(m.tactics[team]);
    this.draft = cloneTactics(m.tactics[team]);
    this.subs = [];
    this.render();
    this.root.hidden = false;
    $('#tac-apply').focus();
  }

  close() { this.root.hidden = true; }

  changed() {
    return this.subs.length > 0 || JSON.stringify(this.draft) !== JSON.stringify(this.original);
  }

  // ---------- rendering ----------

  render() {
    const d = this.draft;
    const m = this.m;
    $('#tac-presets').innerHTML = Object.entries(FORMATIONS).map(([id, f]) =>
      `<label class="seg"><input type="radio" name="tac-formation" value="${id}" ${d.formation === id ? 'checked' : ''}><span>${esc(f.label)}</span></label>`).join('')
      + `<label class="seg"><input type="radio" name="tac-formation" value="custom" ${d.formation === 'custom' ? 'checked' : ''} disabled><span>Custom</span></label>`;
    document.querySelectorAll('input[name="tac-formation"]').forEach((el) => el.addEventListener('change', () => {
      d.formation = el.value;
      d.base = copyBase(FORMATIONS[el.value].base);
      this.render();
    }));
    const setRange = (id, v, text) => { $(`#${id}`).value = v; $(`#${id}-o`).textContent = text; };
    setRange('tac-press', d.press, PRESS[d.press].label);
    setRange('tac-depth', d.depth, `${Math.round(d.depth * 100)}`);
    setRange('tac-width', d.width, `${Math.round(d.width * 100)}`);
    setRange('tac-tempo', d.tempo, `${Math.round(d.tempo * 100)}`);
    $('#tac-shoot').innerHTML = Object.entries(SHOOTING).map(([id, s]) =>
      `<label class="seg"><input type="radio" name="tac-shoot" value="${id}" ${d.shooting === id ? 'checked' : ''}><span>${esc(s.label)}</span></label>`).join('');
    document.querySelectorAll('input[name="tac-shoot"]').forEach((el) => el.addEventListener('change', () => { d.shooting = el.value; }));

    // Players: role, marking and substitution.
    const opp = m.teams[1 - this.team];
    const bench = m.bench[this.team];
    const subsLeft = m.subsLeft[this.team] - this.subs.length;
    $('#tac-players').innerHTML = m.teams[this.team].map((u) => {
      const pending = this.subs.find((s) => s.slot === u.slotIndex);
      const def = pending ? bench[pending.bench].def : u.def;
      const hp = pending ? 100 : Math.round((u.hp / u.maxHp) * 100);
      const roleSel = u.isKeeper
        ? '<select disabled><option>Keeper</option></select>'
        : `<select data-role="${u.slot}">${Object.entries(ROLES).filter(([k]) => k !== 'keeper')
          .map(([k, r]) => `<option value="${k}" ${d.roles[u.slot] === k ? 'selected' : ''}>${r.label}</option>`).join('')}</select>`;
      const markSel = u.isKeeper
        ? '<select disabled><option>—</option></select>'
        : `<select data-mark="${u.slot}"><option value="none">Zonal</option>${opp.filter((q) => !q.isKeeper)
          .map((q) => `<option value="${q.slot}" ${d.marks[u.slot] === q.slot ? 'selected' : ''}>${esc(q.name)} (${q.slot})</option>`).join('')}</select>`;
      const subOpts = bench.map((b, i) => {
        const taken = b.used || this.subs.some((s) => s.bench === i && s.slot !== u.slotIndex);
        const st = b.def;
        return `<option value="${i}" ${pending && pending.bench === i ? 'selected' : ''} ${taken ? 'disabled' : ''}>${esc(st.name)} · SP${st.SP} AT${st.AT} BL${st.BL} SH${st.SH}${b.used ? ' (used)' : ''}</option>`;
      }).join('');
      const subSel = u.isKeeper || (subsLeft <= 0 && !pending)
        ? `<select disabled><option>${u.isKeeper ? '—' : 'No subs left'}</option></select>`
        : `<select data-sub="${u.slotIndex}"><option value="-1">—</option>${subOpts}</select>`;
      return `<tr>
        <td title="${SLOT_NAMES[u.slot]}">${u.slot}</td>
        <td><b>${def.num} ${esc(def.name)}</b> <span class="mini-hp" title="HP ${hp}%"><i style="width:${hp}%"></i></span></td>
        <td>${roleSel}</td><td>${markSel}</td><td>${subSel}</td></tr>`;
    }).join('');
    document.querySelectorAll('[data-role]').forEach((el) => el.addEventListener('change', () => {
      d.roles[el.dataset.role] = el.value;
      this.helpFor(el.value);
    }));
    document.querySelectorAll('[data-role]').forEach((el) => el.addEventListener('focus', () => this.helpFor(el.value)));
    document.querySelectorAll('[data-mark]').forEach((el) => el.addEventListener('change', () => { d.marks[el.dataset.mark] = el.value; }));
    document.querySelectorAll('[data-sub]').forEach((el) => el.addEventListener('change', () => {
      const slot = +el.dataset.sub;
      this.subs = this.subs.filter((s) => s.slot !== slot);
      if (+el.value >= 0) this.subs.push({ slot, bench: +el.value });
      this.render();
    }));

    // Cost and buttons.
    const cost = $('#tac-cost');
    const apply = $('#tac-apply');
    if (this.mode === 'prematch') {
      cost.innerHTML = 'Free before kickoff. During play you get <b>3 changes per half</b>.';
      apply.textContent = 'Kick off';
    } else if (this.mode === 'halftime') {
      cost.innerHTML = `Free at half time · subs left <b>${subsLeft}</b>`;
      apply.textContent = 'Apply';
    } else {
      cost.innerHTML = `Changes left this half: <b>${this.changesLeft}</b> of 3 · applying any change uses one · subs left <b>${subsLeft}</b>`;
      apply.textContent = this.changesLeft > 0 ? 'Apply (uses a change)' : 'No changes left';
    }
    apply.disabled = this.mode === 'inplay' && this.changesLeft <= 0;
    $('#tac-cancel').hidden = this.mode === 'prematch';
    this.helpFor(null);
    this.draw();
  }

  helpFor(role) {
    const el = $('#role-help');
    if (!role) {
      el.textContent = 'Roles: Target holds up the ball, Runner makes forward runs, Anchor braces in the lane in front of goal, Sweeper covers deep. Marks: who each swimmer picks up when we defend.';
      return;
    }
    el.textContent = `${ROLES[role].label}: ${ROLES[role].desc}.`;
  }

  // Top view above, side view below; you attack to the right.
  draw() {
    const c = this.ctx;
    const d = this.draft;
    const td = this.m.teamDefs[this.team];
    c.clearRect(0, 0, W, 880);
    for (const [panel, label] of [[TOP, 'TOP VIEW'], [SIDE, 'SIDE VIEW']]) {
      c.save();
      c.translate(panel.cx, panel.cy);
      c.fillStyle = 'rgba(8, 60, 84, 0.45)';
      c.strokeStyle = 'rgba(160, 235, 255, 0.55)';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(0, 0, SPHERE_R * SC, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      // Halves tinted by team, halfway line.
      c.globalAlpha = 0.1;
      c.fillStyle = hex(td.color);
      c.beginPath();
      c.arc(0, 0, SPHERE_R * SC, Math.PI / 2, Math.PI * 1.5);
      c.fill();
      c.globalAlpha = 1;
      c.strokeStyle = 'rgba(255,255,255,0.35)';
      c.beginPath();
      c.moveTo(0, -SPHERE_R * SC);
      c.lineTo(0, SPHERE_R * SC);
      c.stroke();
      c.strokeStyle = 'rgba(160, 235, 255, 0.15)';
      c.beginPath();
      c.arc(0, 0, 15 * SC, 0, Math.PI * 2);
      c.stroke();
      // Goals: ours on the left, theirs on the right.
      c.fillStyle = hex(td.color);
      c.fillRect(-GOAL_X * SC - 5, -GOAL_RING_R * SC, 8, GOAL_RING_R * SC * 2);
      c.fillStyle = hex(this.m.teamDefs[1 - this.team].color);
      c.fillRect(GOAL_X * SC - 3, -GOAL_RING_R * SC, 8, GOAL_RING_R * SC * 2);
      c.fillStyle = 'rgba(156, 195, 207, 0.9)';
      c.font = '600 22px "Barlow Semi Condensed", sans-serif';
      c.fillText(label, -SPHERE_R * SC, -SPHERE_R * SC + 18);
      c.textAlign = 'right';
      c.fillText('attack →', SPHERE_R * SC, -SPHERE_R * SC + 18);
      c.textAlign = 'left';
      c.restore();
    }
    for (const [i, u] of this.m.teams[this.team].entries()) {
      const [x, y, z] = d.base[u.slot];
      for (const [panel, v] of [[TOP, z], [SIDE, -y]]) {
        const px = panel.cx + x * SC;
        const py = panel.cy + v * SC;
        c.fillStyle = hex(td.color);
        c.strokeStyle = u.isKeeper ? '#ffffff' : hex(td.trim);
        c.lineWidth = 3;
        c.beginPath();
        c.arc(px, py, 17, 0, Math.PI * 2);
        c.fill();
        c.stroke();
        c.fillStyle = '#031019';
        c.font = '700 18px "Barlow Semi Condensed", sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(u.slot, px, py + 1);
        // Alternate names above and below so players in a line stay readable.
        c.fillStyle = '#e6f6f9';
        c.font = '600 16px "Barlow Semi Condensed", sans-serif';
        c.fillText(u.name, px, i % 2 ? py - 28 : py + 30);
        c.textAlign = 'left';
        c.textBaseline = 'alphabetic';
      }
    }
  }

  // ---------- input ----------

  bind() {
    const cv = this.canvas;
    const toCanvas = (e) => {
      const r = cv.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * 880 };
    };
    cv.addEventListener('pointerdown', (e) => {
      const p = toCanvas(e);
      let best = null;
      let bd = 30;
      for (const u of this.m.teams[this.team]) {
        if (u.isKeeper) continue;
        const [x, y, z] = this.draft.base[u.slot];
        for (const [panel, v, kind] of [[TOP, z, 'top'], [SIDE, -y, 'side']]) {
          const dd = Math.hypot(panel.cx + x * SC - p.x, panel.cy + v * SC - p.y);
          if (dd < bd) { bd = dd; best = { slot: u.slot, kind }; }
        }
      }
      if (best) {
        this.drag = best;
        cv.setPointerCapture(e.pointerId);
        cv.style.cursor = 'grabbing';
      }
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const p = toCanvas(e);
      const b = this.draft.base[this.drag.slot];
      const panel = this.drag.kind === 'top' ? TOP : SIDE;
      b[0] = Math.max(-GOAL_X + 5, Math.min(GOAL_X - 4, (p.x - panel.cx) / SC));
      if (this.drag.kind === 'top') b[2] = (p.y - panel.cy) / SC;
      else b[1] = -(p.y - panel.cy) / SC;
      const len = Math.hypot(...b);
      if (len > SPHERE_R - 3) for (let i = 0; i < 3; i++) b[i] *= (SPHERE_R - 3) / len;
      if (this.draft.formation !== 'custom') {
        this.draft.formation = 'custom';
        const custom = document.querySelector('input[name="tac-formation"][value="custom"]');
        if (custom) custom.checked = true;
      }
      this.draw();
    });
    const end = () => { this.drag = null; cv.style.cursor = ''; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);

    const range = (id, key, fmt) => $(`#${id}`).addEventListener('input', (e) => {
      this.draft[key] = +e.target.value;
      $(`#${id}-o`).textContent = fmt(this.draft[key]);
    });
    range('tac-press', 'press', (v) => PRESS[v].label);
    range('tac-depth', 'depth', (v) => Math.round(v * 100));
    range('tac-width', 'width', (v) => Math.round(v * 100));
    range('tac-tempo', 'tempo', (v) => Math.round(v * 100));

    $('#tac-apply').addEventListener('click', () => {
      const changed = this.changed();
      this.close();
      this.onApply({ tactics: this.draft, subs: this.subs, changed });
    });
    $('#tac-cancel').addEventListener('click', () => { this.close(); this.onCancel(); });
    $('#tac-reset').addEventListener('click', () => {
      this.draft = defaultTactics('balanced');
      this.subs = [];
      this.render();
    });
    addEventListener('keydown', (e) => {
      if (this.root.hidden || e.code !== 'Escape' || this.mode === 'prematch') return;
      this.close();
      this.onCancel();
    });
  }
}
