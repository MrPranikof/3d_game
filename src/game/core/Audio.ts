import * as THREE from 'three/webgpu';

/**
 * Fully synthesised WebAudio SFX (no sample files): gunshots, cannon, explosions, impacts,
 * engine / drone loops, UI blips. Positional cues via distance attenuation, stereo panning and
 * a distance low-pass so far fights sound muffled.
 */
export class Audio {
  ctx?: AudioContext;
  private master?: GainNode;
  private noiseBuf?: AudioBuffer;
  private listener = new THREE.Vector3();
  private listenerRight = new THREE.Vector3(1, 0, 0);
  volume = 0.8;

  unlock(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setListener(cam: THREE.Camera): void {
    cam.getWorldPosition(this.listener);
    this.listenerRight.set(1, 0, 0).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
  }

  /** Output chain for a world-space source; null if inaudible. */
  private spatial(pos: THREE.Vector3 | null, range: number): { node: AudioNode; gain: number; dist: number } | null {
    const ctx = this.ctx!;
    if (!pos) return { node: this.master!, gain: 1, dist: 0 };
    const to = pos.clone().sub(this.listener);
    const dist = to.length();
    if (dist > range) return null;
    const gain = 1 / (1 + (dist / 12) ** 1.4);
    const pan = ctx.createStereoPanner();
    pan.pan.value = dist > 0.5 ? THREE.MathUtils.clamp(to.normalize().dot(this.listenerRight), -1, 1) * 0.8 : 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = THREE.MathUtils.clamp(18000 / (1 + dist / 40), 400, 18000);
    lp.connect(pan).connect(this.master!);
    return { node: lp, gain, dist };
  }

  private noise(dest: AudioNode, t: number, dur: number, gain: number, f0: number, f1: number, q = 0.8, type: BiquadFilterType = 'bandpass'): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf!;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  private tone(dest: AudioNode, t: number, dur: number, gain: number, f0: number, f1: number, type: OscillatorType = 'sine'): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  shot(pos: THREE.Vector3 | null, heavy = false): void {
    if (!this.ctx) return;
    const s = this.spatial(pos, 900);
    if (!s) return;
    const t = this.ctx.currentTime;
    const g = s.gain * (heavy ? 1.2 : 0.9);
    this.noise(s.node, t, 0.09, g, 3500, 600, 0.6);
    this.noise(s.node, t, 0.35, g * 0.5, 900, 120, 0.7, 'lowpass');
    this.tone(s.node, t, 0.12, g * 0.6, 160, 50, 'triangle');
    if (s.dist > 80) this.noise(s.node, t + 0.05, 0.6, g * 0.3, 400, 80, 0.5, 'lowpass'); // echo tail
  }

  cannon(pos: THREE.Vector3 | null): void {
    if (!this.ctx) return;
    const s = this.spatial(pos, 2500);
    if (!s) return;
    const t = this.ctx.currentTime;
    this.noise(s.node, t, 0.25, s.gain * 2.2, 2400, 300, 0.5);
    this.noise(s.node, t, 1.6, s.gain * 1.6, 500, 40, 0.6, 'lowpass');
    this.tone(s.node, t, 0.6, s.gain * 1.6, 90, 28, 'sine');
  }

  explosion(pos: THREE.Vector3 | null, size = 1): void {
    if (!this.ctx) return;
    const s = this.spatial(pos, 2500);
    if (!s) return;
    const t = this.ctx.currentTime + (pos ? Math.min(2, s.dist / 343) : 0);
    this.noise(s.node, t, 0.3, s.gain * 2 * size, 3000, 200, 0.4);
    this.noise(s.node, t, 2.2 * size, s.gain * 1.8 * size, 700, 30, 0.5, 'lowpass');
    this.tone(s.node, t, 0.9, s.gain * 1.8 * size, 70, 22, 'sine');
  }

  impact(pos: THREE.Vector3, metal = false): void {
    if (!this.ctx) return;
    const s = this.spatial(pos, 120);
    if (!s) return;
    const t = this.ctx.currentTime;
    if (metal) this.tone(s.node, t, 0.15, s.gain * 0.4, 2200 + Math.random() * 800, 1200, 'triangle');
    this.noise(s.node, t, 0.08, s.gain * 0.5, 2000, 500, 1.2);
  }

  whizz(): void {
    if (!this.ctx) return;
    this.noise(this.master!, this.ctx.currentTime, 0.18, 0.35, 5000, 1500, 4, 'bandpass');
  }

  ui(kind: 'hit' | 'kill' | 'click' | 'capture' | 'warn' | 'reload' | 'empty'): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const m = this.master!;
    switch (kind) {
      case 'hit': this.tone(m, t, 0.06, 0.25, 1800, 1400, 'square'); break;
      case 'kill': this.tone(m, t, 0.08, 0.25, 1300, 1300, 'square'); this.tone(m, t + 0.09, 0.12, 0.25, 1900, 1900, 'square'); break;
      case 'click': this.tone(m, t, 0.03, 0.2, 900, 700, 'square'); break;
      case 'empty': this.tone(m, t, 0.04, 0.25, 500, 400, 'square'); break;
      case 'reload': this.noise(m, t, 0.06, 0.4, 3000, 2000, 2); this.noise(m, t + 0.35, 0.08, 0.5, 2500, 1500, 2); break;
      case 'capture': [660, 880, 1100].forEach((f, i) => this.tone(m, t + i * 0.12, 0.18, 0.18, f, f, 'triangle')); break;
      case 'warn': this.tone(m, t, 0.25, 0.15, 880, 880, 'sawtooth'); this.tone(m, t + 0.3, 0.25, 0.15, 880, 880, 'sawtooth'); break;
    }
  }

  /** Continuous loop (engine / drone / EW hum) with per-frame parameter control. */
  loop(kind: 'engine' | 'drone' | 'jammer'): Loop | null {
    if (!this.ctx) return null;
    return new Loop(this.ctx, this.master!, kind);
  }
}

export class Loop {
  private osc: OscillatorNode;
  private osc2: OscillatorNode;
  private gain: GainNode;
  private filter: BiquadFilterNode;
  private pan: StereoPannerNode;

  constructor(private ctx: AudioContext, dest: AudioNode, private kind: 'engine' | 'drone' | 'jammer') {
    this.osc = ctx.createOscillator();
    this.osc2 = ctx.createOscillator();
    this.osc.type = kind === 'jammer' ? 'square' : 'sawtooth';
    this.osc2.type = kind === 'engine' ? 'square' : 'sawtooth';
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = kind === 'engine' ? 380 : 2400;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    this.osc.connect(this.filter);
    this.osc2.connect(this.filter);
    this.filter.connect(this.gain).connect(this.pan).connect(dest);
    this.osc.start();
    this.osc2.start();
  }

  /** level 0..1 (throttle / rpm), volume 0..1, pan -1..1 */
  set(level: number, volume: number, pan = 0): void {
    const t = this.ctx.currentTime;
    const f = this.kind === 'engine' ? 32 + level * 38 : this.kind === 'drone' ? 140 + level * 260 : 420;
    this.osc.frequency.setTargetAtTime(f, t, 0.08);
    this.osc2.frequency.setTargetAtTime(f * (this.kind === 'engine' ? 0.5 : 1.01), t, 0.08);
    this.gain.gain.setTargetAtTime(volume * (this.kind === 'engine' ? 0.22 : 0.07), t, 0.1);
    this.pan.pan.setTargetAtTime(pan, t, 0.1);
  }

  stop(): void {
    this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    setTimeout(() => { this.osc.stop(); this.osc2.stop(); }, 300);
  }
}
