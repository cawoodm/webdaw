/** Pure DSP helpers (no Tone.js import — unit-testable under Node). */

/** In-place iterative radix-2 Cooley–Tukey FFT. Lengths must be a power of 2. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = i + k + len / 2;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

export interface Spectrum {
  /** Normalized magnitudes: a full-scale sine peaks at ~1.0. */
  mags: Float32Array;
  /** FFT size used; bin k corresponds to k * sampleRate / size Hz. */
  size: number;
}

/**
 * Hann-windowed magnitude spectrum of a signal. Analyses a power-of-2
 * window (≤ maxSize) taken from 25% into the signal — past the attack,
 * inside the sustain — clamped to the available samples.
 */
export function magnitudeSpectrum(signal: Float32Array, maxSize = 32768): Spectrum {
  let size = 32;
  while (size * 2 <= Math.min(signal.length, maxSize)) size *= 2;
  size = Math.min(size, signal.length) >= 32 ? size : 32;
  const start = Math.min(Math.floor(signal.length * 0.25), Math.max(0, signal.length - size));
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  let windowSum = 0;
  for (let i = 0; i < size; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    windowSum += w;
    re[i] = (signal[start + i] ?? 0) * w;
  }
  fft(re, im);
  const mags = new Float32Array(size / 2);
  for (let k = 0; k < size / 2; k++) {
    mags[k] = (2 * Math.hypot(re[k], im[k])) / windowSum;
  }
  return { mags, size };
}

/** Min/max amplitude per column — audio-editor style waveform overview. */
export function waveformPeaks(data: Float32Array, columns: number): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  const perCol = data.length / columns;
  for (let c = 0; c < columns; c++) {
    let lo = Infinity;
    let hi = -Infinity;
    const from = Math.floor(c * perCol);
    const to = Math.min(data.length, Math.max(from + 1, Math.floor((c + 1) * perCol)));
    for (let i = from; i < to; i++) {
      if (data[i] < lo) lo = data[i];
      if (data[i] > hi) hi = data[i];
    }
    min[c] = lo === Infinity ? 0 : lo;
    max[c] = hi === -Infinity ? 0 : hi;
  }
  return { min, max };
}
