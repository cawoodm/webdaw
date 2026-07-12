import { describe, expect, it } from 'vitest';
import {
  bandsFromState, bandsToState, combineDb, defaultEqBands, EQ_DB, freqToX, gainToY,
  hitTest, isLegacyEqState, migrateLegacyEqState, neutralBandValues, qToY,
  responseFreq, SpectrumAverager, xToFreq, yToGain, yToQ,
} from './eq-math';

describe('eq-math mappings', () => {
  it('freq/x round-trips on a log axis', () => {
    for (const f of [20, 100, 1000, 12345, 20000]) {
      expect(xToFreq(freqToX(f, 360), 360)).toBeCloseTo(f, 6);
    }
    expect(freqToX(20, 360)).toBeCloseTo(0);
    expect(freqToX(20000, 360)).toBeCloseTo(360);
  });
  it('gain/y round-trips and pins the axis ends', () => {
    expect(gainToY(EQ_DB, 160)).toBeCloseTo(0);
    expect(gainToY(-EQ_DB, 160)).toBeCloseTo(160);
    expect(yToGain(gainToY(-7.5, 160), 160)).toBeCloseTo(-7.5, 6);
  });
  it('q/y round-trips on its log rail', () => {
    for (const q of [0.1, 0.7, 4, 30]) expect(yToQ(qToY(q, 160), 160)).toBeCloseTo(q, 6);
  });
  it('responseFreq matches Tone quadratic spacing', () => {
    expect(responseFreq(0, 256)).toBeCloseTo(20);
    expect(responseFreq(128, 256)).toBeCloseTo(0.25 * 19980 + 20);
  });
});

describe('eq-math state', () => {
  it('bands pack/unpack round-trips through JSON', () => {
    const bands = defaultEqBands();
    bands.push({ type: 1, on: false, freq: 900, q: 2, gain: -6, slope: 12 });
    const state = JSON.parse(JSON.stringify(bandsToState(bands)));
    expect(bandsFromState(state)).toEqual(bands);
  });
  it('migrates legacy EQ state to three bands', () => {
    const legacy = { hpFreq: 80, peakFreq: 1200, peakGain: -6, lpFreq: 9000 };
    expect(isLegacyEqState(legacy)).toBe(true);
    expect(isLegacyEqState(bandsToState(defaultEqBands()))).toBe(false);
    const bands = migrateLegacyEqState(legacy);
    expect(bands).toHaveLength(3);
    expect(bands[0]).toMatchObject({ type: 0, freq: 80, on: true });
    expect(bands[1]).toMatchObject({ type: 1, freq: 1200, gain: -6, on: true });
    expect(bands[2]).toMatchObject({ type: 3, freq: 9000, on: true });
  });
  it('neutral values silence each band type', () => {
    expect(neutralBandValues(0).freq).toBe(20);
    expect(neutralBandValues(3).freq).toBe(20000);
    expect(neutralBandValues(1).gain).toBe(0);
    expect(neutralBandValues(2)).toMatchObject({ freq: 20000 });
    expect(neutralBandValues(2).q).toBeGreaterThanOrEqual(30);
  });
});

describe('eq-math drawing helpers', () => {
  it('combines linear magnitudes into summed dB', () => {
    const flat = new Float32Array([1, 1]);
    const half = new Float32Array([0.5, 1]);
    const db = combineDb([flat, half]);
    expect(db[0]).toBeCloseTo(20 * Math.log10(0.5));
    expect(db[1]).toBeCloseTo(0);
  });
  it('hit-tests handles then badges within radius', () => {
    const handles = [
      { band: 0, x: 50, y: 80, badge: { x: 44, y: 92, w: 22, h: 12 } },
      { band: 1, x: 200, y: 40 },
    ];
    expect(hitTest(handles, 53, 77)).toEqual({ band: 0, part: 'handle' });
    expect(hitTest(handles, 55, 98)).toEqual({ band: 0, part: 'badge' });
    expect(hitTest(handles, 200, 60)).toBeNull();
    expect(hitTest(handles, 198, 43)).toEqual({ band: 1, part: 'handle' });
  });
  it('averager converges toward the input and ignores silent frames', () => {
    const avg = new SpectrumAverager();
    expect(avg.current()).toBeNull();
    for (let i = 0; i < 200; i++) avg.update(new Float32Array([-30, -60]));
    expect(avg.current()![0]).toBeCloseTo(-30, 1);
    avg.update(new Float32Array([-1000, -1000])); // silence — must not wash out
    expect(avg.current()![0]).toBeCloseTo(-30, 1);
  });
});
