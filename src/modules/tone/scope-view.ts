import * as Tone from 'tone';

/**
 * Oscilloscope-style canvas renderers for the Tone tab: black background,
 * gray gridlines, green trace. Each draw loop self-stops when its canvas
 * leaves the document and skips drawing while `isActive()` is false.
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
