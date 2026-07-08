import { describe, expect, it } from 'vitest';
import { magnitudeSpectrum, seededNoise, waveformPeaks } from './dsp';

const SR = 44100;

function sine(freq: number, seconds: number, amplitude = 1): Float32Array {
  const data = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < data.length; i++) {
    data[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
  }
  return data;
}

describe('magnitudeSpectrum', () => {
  it('peaks at the sine frequency with ~unit magnitude', () => {
    const { mags, size } = magnitudeSpectrum(sine(1000, 1));
    let peakBin = 0;
    for (let i = 1; i < mags.length; i++) if (mags[i] > mags[peakBin]) peakBin = i;
    const peakFreq = (peakBin * SR) / size;
    expect(Math.abs(peakFreq - 1000)).toBeLessThan(SR / size + 1);
    expect(mags[peakBin]).toBeGreaterThan(0.7);
    expect(mags[peakBin]).toBeLessThanOrEqual(1.05);
  });

  it('scales magnitude with amplitude', () => {
    const loud = magnitudeSpectrum(sine(500, 1, 0.8));
    const quiet = magnitudeSpectrum(sine(500, 1, 0.2));
    const peak = (s: Float32Array): number => Math.max(...Array.from(s));
    expect(peak(loud.mags) / peak(quiet.mags)).toBeCloseTo(4, 1);
  });

  it('handles signals shorter than the max window', () => {
    const { mags, size } = magnitudeSpectrum(sine(2000, 0.05));
    expect(size).toBeLessThanOrEqual(Math.round(0.05 * SR));
    expect(mags.length).toBe(size / 2);
  });

  it('shows energy for a short percussive hit followed by a mostly silent buffer', () => {
    // e.g. a Falling Sine snare: attack+decay done in ~40ms of a 1s render
    const hit = sine(2000, 0.04);
    const buffer = new Float32Array(SR); // 1 second, mostly zero
    buffer.set(hit, 0);
    const { mags, size } = magnitudeSpectrum(buffer);
    let peakBin = 0;
    for (let i = 1; i < mags.length; i++) if (mags[i] > mags[peakBin]) peakBin = i;
    const peakFreq = (peakBin * SR) / size;
    expect(Math.abs(peakFreq - 2000)).toBeLessThan((SR / size) * 4 + 1);
    expect(mags[peakBin]).toBeGreaterThan(0.05);
  });
});

describe('seededNoise', () => {
  it('is deterministic for the same seed', () => {
    expect(seededNoise(1234, 512)).toEqual(seededNoise(1234, 512));
  });

  it('differs across seeds and stays within [-1, 1]', () => {
    const a = seededNoise(1, 512);
    const b = seededNoise(2, 512);
    expect(a).not.toEqual(b);
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('waveformPeaks', () => {
  it('captures min/max per column', () => {
    const data = new Float32Array(1000);
    data[10] = 0.9;
    data[510] = -0.7;
    const { min, max } = waveformPeaks(data, 2);
    expect(max[0]).toBeCloseTo(0.9);
    expect(min[1]).toBeCloseTo(-0.7);
  });

  it('produces the requested number of columns', () => {
    const { min, max } = waveformPeaks(sine(100, 0.1), 480);
    expect(min.length).toBe(480);
    expect(max.length).toBe(480);
  });
});
