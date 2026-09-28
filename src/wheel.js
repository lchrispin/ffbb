// The radial command wheel. Four slots (up, right, down, left = keys 1-4); Pass opens
// a list of teammates. Runs on real time: if nothing is chosen before the timer runs
// out, the fallback choice is taken.

const SLOTS = ['up', 'right', 'down', 'left'];
const NAV = { navUp: 0, navRight: 1, navDown: 2, navLeft: 3 };

function pct(odds) {
  return odds == null ? '' : `${Math.round(odds * 100)}%`;
}
function tone(odds) {
  if (odds == null) return 'none';
  return odds >= 0.65 ? 'good' : odds >= 0.35 ? 'fair' : 'bad';
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export class Wheel {
  constructor(root, { onHover } = {}) {
    this.root = root;
    this.onHover = onHover || (() => {});
    this.isOpen = false;
    this.options = [];
    this.list = null;       // the open sub-list (pass targets), or null
    this.sel = -1;
    this.time = 0;
    this.total = 1;
    root.addEventListener('pointerdown', (e) => {
      const el = e.target.closest('[data-i]');
      if (!el || !this.isOpen) return;
      e.preventDefault();
      e.stopPropagation();
      if (el.dataset.i === 'back') { this.back(); return; }
      this.sel = Number(el.dataset.i);
      this.confirm();
    });
    root.addEventListener('pointerover', (e) => {
      const el = e.target.closest('[data-i]');
      if (!el || !this.isOpen || el.dataset.i === 'back') return;
      this.highlight(Number(el.dataset.i));
    });
  }

  // model: { title, sub, kind, options }, fallback() returns the timeout choice.
  open(model, onChoose, fallback, seconds) {
    this.model = model;
    this.options = model.options;
    this.onChoose = onChoose;
    this.fallback = fallback;
    this.list = null;
    this.sel = -1;
    this.time = this.total = seconds;
    this.isOpen = true;
    this.root.hidden = false;
    this.root.dataset.kind = model.kind;
    document.body.classList.add('wheel-open');
    this.render();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    this.root.replaceChildren();
    document.body.classList.remove('wheel-open');
    this.onHover(null);
  }

  update(dt) {
    if (!this.isOpen) return;
    this.time -= dt;
    if (this.hub) {
      this.hub.style.setProperty('--t', Math.max(0, this.time / this.total).toFixed(3));
      this.clock.textContent = Math.max(0, this.time).toFixed(1);
    }
    if (this.time <= 0) this.choose(this.fallback());
  }

  // Keyboard and pad actions. Returns true when the wheel used the action.
  handle(a) {
    if (!this.isOpen) return false;
    // Any deliberate input buys a little more time to think.
    this.time = Math.max(this.time, 1.2);
    const items = this.items();
    if (a.startsWith('num')) {
      const i = Number(a.slice(3)) - 1;
      if (i < items.length) { this.sel = i; this.confirm(); }
      return true;
    }
    if (a in NAV) {
      if (!this.list) {
        const i = NAV[a];
        if (this.sel === i) this.confirm();
        else this.highlight(i);
      } else if (a === 'navUp' || a === 'navDown') {
        const n = items.length;
        this.highlight(((this.sel < 0 ? 0 : this.sel + (a === 'navUp' ? -1 : 1)) + n) % n);
      } else if (a === 'navLeft') this.back();
      else this.confirm();
      return true;
    }
    if (a === 'confirm' || a === 'command') {
      if (this.sel < 0) this.highlight(this.list ? 0 : this.fallbackIndex());
      else this.confirm();
      return true;
    }
    if (a === 'back' || a === 'escape') { this.back(); return true; }
    return false;
  }

  items() {
    return this.list || this.options;
  }

  fallbackIndex() {
    const f = this.fallback();
    return Math.max(0, this.options.findIndex((o) => o.id === f.id));
  }

  highlight(i) {
    this.sel = i;
    this.root.querySelectorAll('[data-i]').forEach((el) => el.classList.toggle('sel', Number(el.dataset.i) === i));
    const it = this.items()[i];
    this.onHover(it || null);
  }

  confirm() {
    const it = this.items()[this.sel];
    if (!it || it.disabled) return;
    if (it.sub) {
      this.list = it.sub;
      this.sel = -1;
      this.time = Math.max(this.time, 2);
      this.render();
      this.highlight(0);
      return;
    }
    this.choose(it);
  }

  back() {
    if (!this.list) return;
    this.list = null;
    this.sel = -1;
    this.render();
    this.onHover(null);
  }

  choose(choice) {
    const cb = this.onChoose;
    this.close();
    cb(choice);
  }

  render() {
    const m = this.model;
    const r = this.root;
    const head = `<div class="wh-head"><b>${esc(m.title)}</b><span>${esc(m.sub || '')}</span></div>`;
    if (this.list) {
      const rows = this.list.map((it, i) => `
        <button type="button" class="wh-row" data-i="${i}" data-tone="${tone(it.odds)}" ${it.disabled ? 'disabled' : ''}>
          <kbd>${i + 1}</kbd><span class="wh-name">${esc(it.label)} <small>${esc(it.role || '')}</small></span>
          <span class="wh-bar"><i style="width:${Math.round((it.odds || 0) * 100)}%"></i></span>
          <b>${pct(it.odds)}</b><small class="wh-detail">${esc(it.detail || '')}</small>
        </button>`).join('');
      r.innerHTML = `<div class="wh-panel">${head}<div class="wh-title">Pass to</div>${rows}
        <button type="button" class="wh-row wh-back" data-i="back"><kbd>⌫</kbd><span class="wh-name">Back</span></button>
        <div class="wh-timer"><i></i></div></div>`;
      this.hub = r.querySelector('.wh-timer');
      this.clock = document.createElement('span');
      this.hub.append(this.clock);
      return;
    }
    const petals = this.options.map((o, i) => `
      <button type="button" class="wh-petal" data-slot="${SLOTS[i]}" data-i="${i}" data-tone="${tone(o.odds)}" ${o.disabled ? 'aria-disabled="true"' : ''}>
        <span class="wh-top"><kbd>${i + 1}</kbd><span class="wh-label">${esc(o.label)}${o.sub ? ' ›' : ''}</span><b>${pct(o.odds)}</b></span>
        <small class="wh-detail">${esc(o.detail || '')}</small>
      </button>`).join('');
    const def = this.options[this.fallbackIndex()];
    r.innerHTML = `<div class="wh-dial">${head}${petals}
      <div class="wh-hub"><span class="wh-clock"></span><small>auto: ${esc(def ? def.label : '')}</small></div></div>`;
    this.hub = r.querySelector('.wh-hub');
    this.clock = r.querySelector('.wh-clock');
  }
}
