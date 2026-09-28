// All sound is synthesised with WebAudio, so the game ships no audio files.
export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  // Browsers only allow audio after a user gesture; call this from one.
  start() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    this.master.connect(this.ctx.destination);
    this.noise = this.makeNoise();
    this.startCrowd();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.7, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  makeNoise() {
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  startCrowd() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 700;
    band.Q.value = 0.6;
    this.crowdGain = this.ctx.createGain();
    this.crowdGain.gain.value = 0.05;
    src.connect(band).connect(this.crowdGain).connect(this.master);
    src.start();
  }

  // 0 = murmur, 1 = on their feet.
  crowd(level) {
    if (!this.ctx) return;
    this.crowdGain.gain.setTargetAtTime(0.05 + level * 0.35, this.ctx.currentTime, 0.25);
  }

  whistle(long = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dur = long ? 1.1 : 0.45;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 2900;
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 28;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 140;
    lfo.connect(lfoGain).connect(osc.frequency);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.08, t + 0.02);
    g.gain.setValueAtTime(0.08, t + dur - 0.08);
    g.gain.linearRampToValueAtTime(0, t + dur);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5000;
    osc.connect(lp).connect(g).connect(this.master);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + dur);
    lfo.stop(t + dur);
  }

  thump(strength = 1, pitch = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900 * pitch, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.25);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5 * strength, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.32);
  }

  bubbles(n = 4) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    for (let i = 0; i < n; i++) {
      const t = t0 + i * 0.05 + Math.random() * 0.03;
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      const f = 300 + Math.random() * 500;
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * 2.6, t + 0.07);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.1);
    }
  }

  chime(up = true) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const notes = up ? [523, 659, 784, 1046] : [392, 330, 262];
    notes.forEach((f, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = this.ctx.createGain();
      const s = t + i * 0.09;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.12, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.5);
      osc.connect(g).connect(this.master);
      osc.start(s);
      osc.stop(s + 0.55);
    });
  }
}
