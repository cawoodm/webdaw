import { describe, expect, it } from 'vitest';
import { beatsToTransportTime, stepToTransportTime, TapTempo } from './time';

describe('beatsToTransportTime', () => {
  it('converts whole beats', () => {
    expect(beatsToTransportTime(0)).toBe('0:0:0');
    expect(beatsToTransportTime(1)).toBe('0:1:0');
    expect(beatsToTransportTime(4)).toBe('1:0:0');
    expect(beatsToTransportTime(7)).toBe('1:3:0');
  });

  it('converts fractional beats to fractional sixteenths', () => {
    expect(beatsToTransportTime(0.25)).toBe('0:0:1');
    expect(beatsToTransportTime(5.5)).toBe('1:1:2');
    expect(beatsToTransportTime(2.125)).toBe('0:2:0.5');
  });

  it('suppresses float noise', () => {
    expect(beatsToTransportTime(0.1 + 0.2)).toBe('0:0:1.2');
  });
});

describe('stepToTransportTime', () => {
  it('maps 16th steps onto bars:quarters:sixteenths', () => {
    expect(stepToTransportTime(0)).toBe('0:0:0');
    expect(stepToTransportTime(3)).toBe('0:0:3');
    expect(stepToTransportTime(4)).toBe('0:1:0');
    expect(stepToTransportTime(16)).toBe('1:0:0');
    expect(stepToTransportTime(21)).toBe('1:1:1');
  });
});

describe('TapTempo', () => {
  it('returns no BPM before the third tap', () => {
    const t = new TapTempo();
    expect(t.tap(0)).toBeNull();
    expect(t.tap(500)).toBeNull();
  });

  it('third tap yields the average of the two intervals', () => {
    const t = new TapTempo();
    t.tap(0);
    t.tap(400);
    expect(t.tap(1000)).toBe(120); // intervals 400+600 -> avg 500ms -> 120 BPM
  });

  it('keeps following a rolling 2-interval average on further taps', () => {
    const t = new TapTempo();
    t.tap(0);
    t.tap(500);
    expect(t.tap(1000)).toBe(120);
    expect(t.tap(2000)).toBe(80); // last two intervals 500+1000 -> 750ms
    expect(t.tap(3000)).toBe(60); // 1000+1000
  });

  it('a pause longer than resetMs starts a new sequence', () => {
    const t = new TapTempo(2000);
    t.tap(0);
    t.tap(500);
    expect(t.tap(1000)).toBe(120);
    expect(t.tap(5000)).toBeNull(); // gap 4s -> reset, counts as first tap
    expect(t.tap(5500)).toBeNull();
    expect(t.tap(6000)).toBe(120);
  });
});
