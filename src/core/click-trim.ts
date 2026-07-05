/**
 * Isolate a single metronome click from a longer recording:
 * find the first transient, cut a short window from just before it,
 * and fade the tail so the slice ends without a pop.
 */

export interface ClickWindow {
  start: number;
  length: number;
}

/** Locate the first click: first sample above 10% of the recording's peak. */
export function findClickWindow(data: Float32Array, sampleRate: number, maxMs = 150): ClickWindow {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  const threshold = peak * 0.1;
  let onset = 0;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) >= threshold) {
      onset = i;
      break;
    }
  }
  const preRoll = Math.round(sampleRate * 0.002);
  const start = Math.max(0, onset - preRoll);
  const length = Math.min(Math.round((maxMs / 1000) * sampleRate), data.length - start);
  return { start, length };
}

/** Copy the click window and apply a linear fade over the last `fadeMs`. */
export function extractClick(data: Float32Array, sampleRate: number, maxMs = 150, fadeMs = 10): Float32Array {
  const { start, length } = findClickWindow(data, sampleRate, maxMs);
  const out = new Float32Array(length);
  out.set(data.subarray(start, start + length));
  const fadeSamples = Math.min(length, Math.round((fadeMs / 1000) * sampleRate));
  for (let i = 0; i < fadeSamples; i++) {
    out[length - 1 - i] *= i / fadeSamples;
  }
  return out;
}
