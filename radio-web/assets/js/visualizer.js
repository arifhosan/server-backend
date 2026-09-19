const FFT_SIZE = 2048;
const MIN_HZ = 40;
const MAX_HZ = 16000;

/* Loud music pins the default -100..-30 window at full scale. A wider, higher
   window keeps the bars dancing instead of sitting at the ceiling. */
const MIN_DB = -88;
const MAX_DB = -10;

/* Seconds to close most of the gap. Time based, so a 120Hz screen does not
   animate at double speed. */
const ATTACK_TAU = 0.06;
const RELEASE_TAU = 0.38;
const PEAK_FALL_PER_SEC = 0.32;
const PEAK_HANG = 0.42;

const BASELINE = 0.74;

export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.audio = null;
    this.context = null;
    this.analyser = null;
    this.bins = null;
    this.source = null;

    this.bars = 56;
    this.values = new Float32Array(this.bars);
    this.peaks = new Float32Array(this.bars);
    this.phases = new Float32Array(this.bars);
    this.hangs = new Float32Array(this.bars);
    this.zeros = new Float32Array(this.bars);
    this.lastTime = 0;
    this.cssWidth = 0;
    this.cssHeight = 0;
    this.simulated = false;
    this.running = false;
    this.frame = 0;
    this.energyHandler = null;

    for (let i = 0; i < this.bars; i++) this.phases[i] = Math.random() * Math.PI * 2;

    this.resize = this.resize.bind(this);
    this.tick = this.tick.bind(this);

    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(canvas);
    this.resize();
  }

  onEnergy(handler) {
    this.energyHandler = handler;
  }

  /** Routes the element through an analyser. Only possible once per element,
      and only when the stream is CORS-readable. */
  connect(audio, { sample }) {
    this.audio = audio;

    if (!sample || this.source) {
      this.simulated = !sample;
      return !this.simulated;
    }

    const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextCtor) {
      this.simulated = true;
      return false;
    }

    try {
      this.context = new AudioContextCtor();
      this.source = this.context.createMediaElementSource(audio);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0.82;
      this.analyser.minDecibels = MIN_DB;
      this.analyser.maxDecibels = MAX_DB;

      this.source.connect(this.analyser);
      this.analyser.connect(this.context.destination);

      this.bins = new Uint8Array(this.analyser.frequencyBinCount);
      this.simulated = false;
      return true;
    } catch {
      this.simulated = true;
      return false;
    }
  }

  resume() {
    if (this.context?.state === 'suspended') void this.context.resume();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = 0;
    this.resume();
    this.frame = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width || !height) return;

    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    // Drawing happens in CSS pixels because of the transform above.
    this.cssWidth = width;
    this.cssHeight = height;

    const target = width < 420 ? 30 : width < 640 ? 42 : 56;
    if (target !== this.bars) {
      this.bars = target;
      this.values = new Float32Array(target);
      this.peaks = new Float32Array(target);
      this.phases = new Float32Array(target);
      this.hangs = new Float32Array(target);
      this.zeros = new Float32Array(target);
      for (let i = 0; i < target; i++) this.phases[i] = Math.random() * Math.PI * 2;
    }
  }

  /** Log-spaced bands, so bass does not occupy most of the display. */
  sampleSpectrum() {
    this.analyser.getByteFrequencyData(this.bins);

    const nyquist = this.context.sampleRate / 2;
    const binCount = this.bins.length;
    const ratio = MAX_HZ / MIN_HZ;
    const out = new Float32Array(this.bars);

    for (let i = 0; i < this.bars; i++) {
      const lowHz = MIN_HZ * ratio ** (i / this.bars);
      const highHz = MIN_HZ * ratio ** ((i + 1) / this.bars);

      const from = Math.min(binCount - 1, Math.floor((lowHz / nyquist) * binCount));
      const to = Math.min(binCount - 1, Math.max(from + 1, Math.ceil((highHz / nyquist) * binCount)));

      let sum = 0;
      let peak = 0;
      for (let bin = from; bin < to; bin++) {
        sum += this.bins[bin];
        if (this.bins[bin] > peak) peak = this.bins[bin];
      }

      // Averaging with a little peak mixed in is steadier than peak alone.
      const level = (sum / (to - from)) * 0.65 + peak * 0.35;

      // Music rolls off with frequency, but a strong tilt just saturates.
      const tilt = 1 + (i / this.bars) * 0.3;
      out[i] = Math.min(1, Math.max(0, (level / 255) * tilt - 0.04));
    }

    return out;
  }

  /** Stand-in when the audio cannot be sampled: layered sines read as musical. */
  simulate(time) {
    const out = new Float32Array(this.bars);

    for (let i = 0; i < this.bars; i++) {
      const position = i / this.bars;
      const slow = Math.sin(time * 0.0007 + this.phases[i]);
      const fast = Math.sin(time * 0.0031 + this.phases[i] * 2.3);
      const beat = Math.max(0, Math.sin(time * 0.0026)) ** 3;

      const shape = (1 - position) ** 0.65;
      const wobble = 0.5 + 0.28 * slow + 0.2 * fast;

      out[i] = Math.max(0, Math.min(1, shape * wobble + beat * 0.34 * (1 - position)));
    }

    return out;
  }

  tick(time) {
    if (!this.running) return;

    // Clamped so a backgrounded tab does not resume with one giant jump.
    const dt = Math.min(0.05, this.lastTime ? (time - this.lastTime) / 1000 : 0.016);
    this.lastTime = time;

    const playing = this.audio && !this.audio.paused;
    const targets = !playing
      ? this.zeros
      : this.simulated || !this.analyser
        ? this.simulate(time)
        : this.sampleSpectrum();

    const attack = 1 - Math.exp(-dt / ATTACK_TAU);
    const release = 1 - Math.exp(-dt / RELEASE_TAU);
    const fall = PEAK_FALL_PER_SEC * dt;

    let bass = 0;
    const bassBars = Math.max(1, Math.round(this.bars * 0.18));

    for (let i = 0; i < this.bars; i++) {
      const target = targets[i];
      const rate = target > this.values[i] ? attack : release;
      this.values[i] += (target - this.values[i]) * rate;

      if (this.values[i] >= this.peaks[i]) {
        this.peaks[i] = this.values[i];
        this.hangs[i] = PEAK_HANG;
      } else if (this.hangs[i] > 0) {
        this.hangs[i] -= dt;
      } else {
        this.peaks[i] = Math.max(this.values[i], this.peaks[i] - fall);
      }

      if (i < bassBars) bass += this.values[i];
    }

    this.draw();
    this.energyHandler?.(Math.min(1, bass / bassBars));

    this.frame = requestAnimationFrame(this.tick);
  }

  draw() {
    const { ctx } = this;
    const width = this.cssWidth;
    const height = this.cssHeight;
    if (!width || !height) return;

    ctx.clearRect(0, 0, width, height);

    const styles = getComputedStyle(document.documentElement);
    const hot = styles.getPropertyValue('--accent-hot').trim() || '#ffb063';
    const mid = styles.getPropertyValue('--accent').trim() || '#ff9233';
    const deep = styles.getPropertyValue('--accent-deep').trim() || '#d8491f';

    const floor = height * BASELINE;
    const span = floor;
    const slot = width / this.bars;
    const barWidth = Math.max(2, slot * 0.62);
    const radius = Math.min(barWidth / 2, 4);

    const gradient = ctx.createLinearGradient(0, floor - span, 0, floor);
    gradient.addColorStop(0, hot);
    gradient.addColorStop(0.45, mid);
    gradient.addColorStop(1, deep);

    for (let i = 0; i < this.bars; i++) {
      const value = this.values[i];
      const barHeight = Math.max(2, value * span);
      const x = i * slot + (slot - barWidth) / 2;

      ctx.globalAlpha = 1;
      ctx.fillStyle = gradient;
      ctx.shadowColor = mid;
      ctx.shadowBlur = 7 * value;

      roundedTop(ctx, x, floor - barHeight, barWidth, barHeight, radius);
      ctx.fill();

      ctx.shadowBlur = 0;

      // Reflection below the floor line.
      ctx.globalAlpha = 0.16;
      roundedTop(ctx, x, floor, barWidth, barHeight * 0.34, radius);
      ctx.fill();

      // Peak-hold cap.
      const peakY = floor - Math.max(3, this.peaks[i] * span);
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = hot;
      ctx.fillRect(x, peakY - 2, barWidth, 2);
    }

    ctx.globalAlpha = 1;
  }

  destroy() {
    this.stop();
    this.observer.disconnect();
  }
}

function roundedTop(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, height / 2);
  ctx.beginPath();
  ctx.moveTo(x, y + height);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height);
  ctx.closePath();
}
