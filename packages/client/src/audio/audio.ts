import { vlen, type CarState, type GameEvent } from '@rl/shared';

// All sounds are synthesized with WebAudio (no copyrighted samples).

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineOsc!: OscillatorNode;
  private engineOsc2!: OscillatorNode;
  private engineGain!: GainNode;
  private boostGain!: GainNode;
  private boostFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  volume = 0.6;

  /** Must be called from a user gesture. */
  unlock() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

    // Noise buffer
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // Engine: two detuned saws through a lowpass
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc2 = ctx.createOscillator();
    this.engineOsc2.type = 'square';
    this.engineOsc.connect(lp);
    this.engineOsc2.connect(lp);
    lp.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.engineOsc.start();
    this.engineOsc2.start();

    // Boost: looping filtered noise
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.boostFilter = ctx.createBiquadFilter();
    this.boostFilter.type = 'bandpass';
    this.boostFilter.frequency.value = 1400;
    this.boostFilter.Q.value = 0.7;
    this.boostGain = ctx.createGain();
    this.boostGain.gain.value = 0;
    src.connect(this.boostFilter);
    this.boostFilter.connect(this.boostGain);
    this.boostGain.connect(this.master);
    src.start();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.value = v;
  }

  /** Continuous sounds for the local car. */
  updateCar(car: CarState | null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (!car || car.demolished) {
      this.engineGain.gain.setTargetAtTime(0, t, 0.05);
      this.boostGain.gain.setTargetAtTime(0, t, 0.05);
      return;
    }
    const speed = vlen(car.vel);
    const throttle = Math.abs(car.lastInput.throttle);
    const base = 45 + (speed / 2300) * 110 + throttle * 12;
    this.engineOsc.frequency.setTargetAtTime(base, t, 0.05);
    this.engineOsc2.frequency.setTargetAtTime(base * 0.502, t, 0.05);
    this.engineGain.gain.setTargetAtTime(0.035 + throttle * 0.03 + (speed / 2300) * 0.03, t, 0.08);
    const boosting = car.boostingTime > 0;
    this.boostGain.gain.setTargetAtTime(boosting ? 0.22 : 0, t, boosting ? 0.02 : 0.08);
    this.boostFilter.frequency.setTargetAtTime(1100 + (speed / 2300) * 1400, t, 0.1);
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain: number, slideTo?: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noiseHit(dur: number, freq: number, gain: number, q = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.2), t + dur);
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  handleEvents(events: GameEvent[], localCarId: number | null) {
    if (!this.ctx) return;
    for (const e of events) {
      switch (e.type) {
        case 'ballHit': {
          const k = Math.min(1, e.strength / 2500);
          this.tone(140 + k * 60, 0.18, 'sine', 0.25 + k * 0.4, 60);
          this.noiseHit(0.12, 2500 + k * 3000, 0.15 + k * 0.35);
          break;
        }
        case 'ballBounce':
          this.tone(110, 0.15, 'sine', Math.min(0.25, e.speed / 4000), 55);
          break;
        case 'goal':
          this.noiseHit(1.6, 6000, 0.9);
          this.tone(80, 1.2, 'sine', 0.8, 30);
          setTimeout(() => {
            this.tone(523, 0.25, 'triangle', 0.2);
            setTimeout(() => this.tone(659, 0.25, 'triangle', 0.2), 120);
            setTimeout(() => this.tone(784, 0.5, 'triangle', 0.22), 240);
          }, 250);
          break;
        case 'demo':
          this.noiseHit(0.8, 4000, 0.7);
          this.tone(90, 0.6, 'sawtooth', 0.3, 30);
          break;
        case 'bump':
          this.noiseHit(0.15, 1500, 0.3);
          break;
        case 'jump':
        case 'doubleJump':
          if (e.carId === localCarId) this.noiseHit(0.1, 1200, 0.12);
          break;
        case 'flip':
          if (e.carId === localCarId) this.noiseHit(0.2, 2000, 0.1);
          break;
        case 'boostPickup':
          if (e.carId === localCarId) this.tone(e.big ? 660 : 880, e.big ? 0.25 : 0.08, 'square', 0.06, e.big ? 1320 : 1100);
          break;
        case 'countdown':
          if (e.value > 0) this.tone(440, 0.18, 'square', 0.12);
          else this.tone(880, 0.45, 'square', 0.15);
          break;
        case 'land':
          if (e.carId === localCarId) this.noiseHit(0.08, 600, 0.1);
          break;
        case 'carWallHit':
          if (e.carId === localCarId) this.noiseHit(0.15, 900, Math.min(0.3, e.strength / 3000));
          break;
        case 'matchEnd':
          this.tone(392, 0.4, 'triangle', 0.25);
          setTimeout(() => this.tone(330, 0.8, 'triangle', 0.25), 380);
          break;
        case 'save':
        case 'shot':
          break;
      }
    }
  }
}
