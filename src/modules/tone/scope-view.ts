import * as Tone from '../../core/tone';
import { magnitudeSpectrum, waveformPeaks } from '../../core/dsp';

/**
 * Oscilloscope-style canvas renderers for the Tone tab: black background,
 * gray gridlines, green trace. The live views (drawScope/drawFft) animate
 * from analysers; the static views draw a rendered buffer once, like an
 * audio editor. Live draw loops self-stop when their canvas leaves the
 * document and skip drawing while `isActive()` is false.
 */

const BG = '#000';
const GRID = '#3d3d3d';
const TRACE = '#33ff66';
const LABEL = '#8a8f98';

const MIN_DB = -100;
const MAX_DB = 0;
const FREQ_LINES = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const FREQ_LABELS: Record<number, string> = { 100: '100', 1000: '1k', 10000: '10k' };

function startLoop(canvas: HTMLCanvasElement, isActive: () => boolean, draw: () => void): () => void {
  let raf = 0;
  const frame = (): void => {
    if (!canvas.isConnected) return;
    if (isActive()) draw();
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

function grid(ctx: CanvasRenderingContext2D, w: number, h: number, xs: number[], ys: number[]): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const x of xs) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
  }
  for (const y of ys) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();
}

/** Time-domain amplitude trace of a waveform analyser. */
export function drawScope(canvas: HTMLCanvasElement, analyser: Tone.Analyser, isActive: () => boolean): () => void {
  const ctx = canvas.getContext('2d')!;
  return startLoop(canvas, isActive, () => {
    const values = analyser.getValue() as Float32Array;
    const w = canvas.width;
    const h = canvas.height;
    const xs = Array.from({ length: 7 }, (_, i) => ((i + 1) * w) / 8);
    const ys = [0.25, 0.5, 0.75].map((f) => f * h);
    grid(ctx, w, h, xs, ys);
    ctx.strokeStyle = TRACE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
      const x = (i / (values.length - 1)) * w;
      const y = ((1 - values[i]) / 2) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
}

/** Static amplitude-over-time view of a rendered buffer (min/max per column). */
export function drawWaveformStatic(canvas: HTMLCanvasElement, data: Float32Array, sampleRate: number): void {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  const seconds = data.length / sampleRate;
  const tickEvery = 0.25;
  const xs: number[] = [];
  for (let t = tickEvery; t < seconds; t += tickEvery) xs.push((t / seconds) * w);
  const ys = [0.25, 0.5, 0.75].map((f) => f * h);
  grid(ctx, w, h, xs, ys);
  ctx.fillStyle = LABEL;
  ctx.font = '10px sans-serif';
  for (let t = 0.5; t < seconds; t += 0.5) {
    ctx.fillText(`${t.toFixed(1)}s`, (t / seconds) * w + 3, h - 4);
  }
  const { min, max } = waveformPeaks(data, w);
  ctx.fillStyle = TRACE;
  for (let x = 0; x < w; x++) {
    const yTop = ((1 - max[x]) / 2) * h;
    const yBottom = ((1 - min[x]) / 2) * h;
    ctx.fillRect(x, yTop, 1, Math.max(1, yBottom - yTop));
  }
}

const FMIN = 20;
const FMAX = 20000;

/** Static energy-over-frequency view: FFT of a rendered buffer, log axis. */
export function drawSpectrumStatic(canvas: HTMLCanvasElement, data: Float32Array, sampleRate: number): void {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  const freqX = (f: number): number => (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * w;
  const xs = FREQ_LINES.map(freqX);
  const ys = [-20, -40, -60, -80].map((db) => ((MAX_DB - db) / (MAX_DB - MIN_DB)) * h);
  grid(ctx, w, h, xs, ys);
  ctx.fillStyle = LABEL;
  ctx.font = '10px sans-serif';
  for (const f of FREQ_LINES) {
    const label = FREQ_LABELS[f];
    if (label) ctx.fillText(label, freqX(f) + 3, h - 4);
  }
  const { mags, size } = magnitudeSpectrum(data);
  ctx.strokeStyle = TRACE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  for (let k = 1; k < mags.length; k++) {
    const f = (k * sampleRate) / size;
    if (f < FMIN || f > FMAX) continue;
    const db = 20 * Math.log10(mags[k] + 1e-12);
    const norm = (db - MIN_DB) / (MAX_DB - MIN_DB);
    const y = h - Math.max(0, Math.min(1, norm)) * h;
    const x = freqX(f);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
}

/** Log-frequency FFT trace of an fft analyser, with Hz-labelled gridlines. */
export function drawFft(canvas: HTMLCanvasElement, analyser: Tone.Analyser, isActive: () => boolean): () => void {
  const ctx = canvas.getContext('2d')!;
  return startLoop(canvas, isActive, () => {
    const values = analyser.getValue() as Float32Array;
    const w = canvas.width;
    const h = canvas.height;
    const nyquist = Tone.getContext().sampleRate / 2;
    const binX = (i: number): number => (Math.log(i + 1) / Math.log(values.length)) * w;
    const freqX = (f: number): number => binX((f / nyquist) * values.length);
    const xs = FREQ_LINES.map(freqX);
    const ys = [-20, -40, -60, -80].map((db) => ((MAX_DB - db) / (MAX_DB - MIN_DB)) * h);
    grid(ctx, w, h, xs, ys);
    ctx.fillStyle = LABEL;
    ctx.font = '10px sans-serif';
    for (const f of FREQ_LINES) {
      const label = FREQ_LABELS[f];
      if (label) ctx.fillText(label, freqX(f) + 3, h - 4);
    }
    ctx.strokeStyle = TRACE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
      const norm = (values[i] - MIN_DB) / (MAX_DB - MIN_DB);
      const y = h - Math.max(0, Math.min(1, norm)) * h;
      if (i === 0) ctx.moveTo(binX(i), y);
      else ctx.lineTo(binX(i), y);
    }
    ctx.stroke();
  });
}

export const HPF_TRACE = '#4da6ff';
export const LPF_TRACE = '#ff5c5c';

/**
 * HPF (blue) and LPF (red) response curves over an already-drawn static
 * spectrum view, on the same log-frequency / dB axes. Slopes match the
 * patch voice's Tone.Filter default rolloff (-12 dB/octave).
 */
export function drawFilterOverlay(
  canvas: HTMLCanvasElement,
  filter: { hpf: number; lpf: number; hpfOn?: boolean; lpfOn?: boolean },
): void {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  const freqAt = (px: number): number => FMIN * Math.pow(FMAX / FMIN, px / w);
  const yAt = (db: number): number => {
    const norm = (db - MIN_DB) / (MAX_DB - MIN_DB);
    return h - Math.max(0, Math.min(1, norm)) * h;
  };
  const curve = (color: string, dbAt: (f: number) => number): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let px = 0; px < w; px++) {
      const y = yAt(dbAt(freqAt(px)));
      if (px === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.stroke();
  };
  if (filter.hpfOn !== false) curve(HPF_TRACE, (f) => (f < filter.hpf ? -12 * Math.log2(filter.hpf / f) : 0));
  if (filter.lpfOn !== false) curve(LPF_TRACE, (f) => (f > filter.lpf ? -12 * Math.log2(f / filter.lpf) : 0));
}

export const ENV_TRACE = '#f6ad55';
export const LFO_TRACE = '#ff4fd8';

/**
 * Magenta LFO modulation contour over an already-drawn static waveform
 * view: for a volume target the actual gain sweep (1-depth..1), for pitch
 * a centered oscillation scaled by depth. Off/zero-depth draws nothing.
 */
export function drawLfoOverlay(
  canvas: HTMLCanvasElement,
  lfo: { rate: number; depth: number; target: 'off' | 'pitch' | 'volume'; on?: boolean },
  seconds: number,
  startAt = 0.01,
): void {
  if (lfo.target === 'off' || lfo.depth <= 0 || lfo.on === false) return;
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  const level = (t: number): number => {
    const phase = Math.sin(2 * Math.PI * lfo.rate * Math.max(0, t - startAt));
    return lfo.target === 'volume'
      ? 1 - lfo.depth + lfo.depth * (0.5 + 0.5 * phase)
      : 0.5 + 0.5 * lfo.depth * phase;
  };
  ctx.strokeStyle = LFO_TRACE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let px = 0; px < w; px++) {
    const y = ((1 - level((px / w) * seconds)) / 2) * h;
    if (px === 0) ctx.moveTo(px, y);
    else ctx.lineTo(px, y);
  }
  ctx.stroke();
}

/**
 * Orange ADSR contour over an already-drawn static waveform view, on the
 * same time axis. `holdSeconds`/`startAt` mirror renderPatch's schedule
 * (attack at 0.01s, release triggered after a 1s hold).
 */
export function drawEnvelopeOverlay(
  canvas: HTMLCanvasElement,
  env: { attack: number; decay: number; sustain: number; release: number },
  seconds: number,
  holdSeconds = 1,
  startAt = 0.01,
): void {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  // envelope level before release, then exponential release from that level
  const preRelease = (t: number): number =>
    t < env.attack
      ? t / env.attack
      : env.sustain + (1 - env.sustain) * Math.exp(-5 * ((t - env.attack) / env.decay));
  const level = (t: number): number => {
    const ta = t - startAt;
    if (ta <= 0) return 0;
    if (ta < holdSeconds) return preRelease(ta);
    return preRelease(holdSeconds) * Math.exp(-5 * ((ta - holdSeconds) / env.release));
  };
  ctx.strokeStyle = ENV_TRACE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let px = 0; px < w; px++) {
    const y = ((1 - level((px / w) * seconds)) / 2) * h;
    if (px === 0) ctx.moveTo(px, y);
    else ctx.lineTo(px, y);
  }
  ctx.stroke();
}
