import { describe, expect, it } from 'vitest';
import { extractClick, findClickWindow } from './click-trim';

const SR = 44100;

function recordingWithClickAt(sampleIndex: number, totalSamples = SR): Float32Array {
  const data = new Float32Array(totalSamples);
  for (let i = 0; i < 400; i++) {
    data[sampleIndex + i] = 0.9 * Math.exp(-i / 80) * Math.sin(i * 0.9);
  }
  // low background noise before/after
  for (let i = 0; i < totalSamples; i++) {
    if (data[i] === 0) data[i] = 0.005 * Math.sin(i);
  }
  return data;
}

describe('findClickWindow', () => {
  it('starts just before the first transient', () => {
    const clickAt = 8000;
    const { start, length } = findClickWindow(recordingWithClickAt(clickAt), SR);
    expect(start).toBeGreaterThan(clickAt - SR * 0.005);
    expect(start).toBeLessThanOrEqual(clickAt);
    expect(length).toBe(Math.round(0.15 * SR));
  });

  it('clamps the window to the end of the recording', () => {
    const total = 10000;
    const { start, length } = findClickWindow(recordingWithClickAt(9000, total), SR);
    expect(start + length).toBeLessThanOrEqual(total);
  });
});

describe('extractClick', () => {
  it('contains the transient and fades to silence', () => {
    const click = extractClick(recordingWithClickAt(8000), SR);
    let peak = 0;
    for (const s of click) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeGreaterThan(0.5);
    expect(Math.abs(click[click.length - 1])).toBeLessThan(1e-4);
  });
});
