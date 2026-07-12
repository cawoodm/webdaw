/** Pure math for the visual Equalizer — Tone-free so it stays unit-testable. */

export type EqBandType = 0 | 1 | 2 | 3; // 0=HPF 1=BPF(bell) 2=BSF(notch) 3=LPF

export interface EqBand {
  type: EqBandType;
  on: boolean;
  freq: number;
  q: number;
  gain: number; // dB, BPF only (0 otherwise)
  slope: number; // 12|24|48 dB/oct, HPF/LPF only (12 otherwise)
}

export const EQ_FMIN = 20;
export const EQ_FMAX = 20000;
export const EQ_DB = 24;
const Q_MIN = 0.1;
const Q_MAX = 30;

export const BAND_LABELS: Record<EqBandType, string> = { 0: 'HPF', 1: 'BPF', 2: 'BSF', 3: 'LPF' };

export function defaultEqBands(): EqBand[] {
  return [
    { type: 0, on: true, freq: 40, q: 0.7, gain: 0, slope: 12 },
    { type: 3, on: true, freq: 18000, q: 0.7, gain: 0, slope: 12 },
  ];
}

export function bandsToState(bands: EqBand[]): Record<string, number> {
  const state: Record<string, number> = { bands: bands.length };
  bands.forEach((b, i) => {
    state[`b${i}Type`] = b.type;
    state[`b${i}On`] = b.on ? 1 : 0;
    state[`b${i}Freq`] = b.freq;
    state[`b${i}Q`] = b.q;
    state[`b${i}Gain`] = b.gain;
    state[`b${i}Slope`] = b.slope;
  });
  return state;
}

export function bandsFromState(state: Record<string, number>): EqBand[] {
  const count = Math.max(0, Math.floor(state.bands ?? 0));
  const bands: EqBand[] = [];
  for (let i = 0; i < count; i++) {
    bands.push({
      type: (state[`b${i}Type`] ?? 0) as EqBandType,
      on: (state[`b${i}On`] ?? 1) !== 0,
      freq: state[`b${i}Freq`] ?? 1000,
      q: state[`b${i}Q`] ?? 0.7,
      gain: state[`b${i}Gain`] ?? 0,
      slope: state[`b${i}Slope`] ?? 12,
    });
  }
  return bands;
}

export function isLegacyEqState(state: Record<string, number>): boolean {
  return state.hpFreq !== undefined && state.bands === undefined;
}

/** Old 3-knob EQ (hpFreq/peakFreq/peakGain/lpFreq) → HPF + BPF + LPF bands. */
export function migrateLegacyEqState(state: Record<string, number>): EqBand[] {
  return [
    { type: 0, on: true, freq: state.hpFreq ?? 40, q: 0.7, gain: 0, slope: 12 },
    { type: 1, on: true, freq: state.peakFreq ?? 1000, q: 1, gain: state.peakGain ?? 0, slope: 12 },
    { type: 3, on: true, freq: state.lpFreq ?? 18000, q: 0.7, gain: 0, slope: 12 },
  ];
}

/** Values a disabled band applies so it stays wired but inaudible. */
export function neutralBandValues(type: EqBandType): { freq: number; q: number; gain: number } {
  if (type === 0) return { freq: 20, q: 0.7, gain: 0 };
  if (type === 3) return { freq: 20000, q: 0.7, gain: 0 };
  if (type === 1) return { freq: 1000, q: 1, gain: 0 };
  // notch: vanishingly narrow at the edge of hearing
  return { freq: 20000, q: 30, gain: 0 };
}

export function freqToX(f: number, w: number): number {
  return (Math.log(f / EQ_FMIN) / Math.log(EQ_FMAX / EQ_FMIN)) * w;
}

export function xToFreq(x: number, w: number): number {
  return EQ_FMIN * Math.pow(EQ_FMAX / EQ_FMIN, Math.min(1, Math.max(0, x / w)));
}

export function gainToY(db: number, h: number): number {
  return ((EQ_DB - db) / (2 * EQ_DB)) * h;
}

export function yToGain(y: number, h: number): number {
  const db = EQ_DB - (y / h) * 2 * EQ_DB;
  return Math.min(EQ_DB, Math.max(-EQ_DB, db));
}

/** Q on a log rail: top of canvas = Q_MAX, bottom = Q_MIN. */
export function qToY(q: number, h: number): number {
  const norm = Math.log(q / Q_MIN) / Math.log(Q_MAX / Q_MIN);
  return (1 - norm) * h;
}

export function yToQ(y: number, h: number): number {
  const norm = 1 - Math.min(1, Math.max(0, y / h));
  return Q_MIN * Math.pow(Q_MAX / Q_MIN, norm);
}

/** Frequency of Tone.Filter.getFrequencyResponse(len) sample i: quadratic 20..20k. */
export function responseFreq(i: number, len: number): number {
  const norm = Math.pow(i / len, 2);
  return norm * (EQ_FMAX - EQ_FMIN) + EQ_FMIN;
}

/** Combined response of several bands: per-sample sum of each band's dB. */
export function combineDb(perBand: Float32Array[]): number[] {
  if (perBand.length === 0) return [];
  const out = new Array<number>(perBand[0].length).fill(0);
  for (const mags of perBand) {
    for (let i = 0; i < out.length; i++) out[i] += 20 * Math.log10(Math.max(1e-6, mags[i]));
  }
  return out;
}

export interface EqHandle {
  band: number;
  x: number;
  y: number;
  badge?: { x: number; y: number; w: number; h: number };
}

/** Nearest handle within r px wins; badges checked after handles. */
export function hitTest(handles: EqHandle[], x: number, y: number, r = 8): { band: number; part: 'handle' | 'badge' } | null {
  let best: { band: number; part: 'handle' | 'badge' } | null = null;
  let bestDist = r;
  for (const hnd of handles) {
    const d = Math.hypot(hnd.x - x, hnd.y - y);
    if (d <= bestDist) {
      bestDist = d;
      best = { band: hnd.band, part: 'handle' };
    }
  }
  if (best) return best;
  for (const hnd of handles) {
    const b = hnd.badge;
    if (b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
      return { band: hnd.band, part: 'badge' };
    }
  }
  return null;
}

const SILENCE_DB = -95;
const EMA_ALPHA = 0.92;

/** Per-bin EMA of analyser dB frames; silent frames don't wash the average out. */
export class SpectrumAverager {
  private avg: Float32Array | null = null;

  update(dbValues: Float32Array): void {
    let loudest = -Infinity;
    for (let i = 0; i < dbValues.length; i++) if (dbValues[i] > loudest) loudest = dbValues[i];
    if (loudest <= SILENCE_DB) return; // freeze on silence
    if (!this.avg) {
      this.avg = new Float32Array(dbValues);
      return;
    }
    for (let i = 0; i < this.avg.length; i++) {
      this.avg[i] = EMA_ALPHA * this.avg[i] + (1 - EMA_ALPHA) * dbValues[i];
    }
  }

  current(): Float32Array | null {
    return this.avg;
  }
}
