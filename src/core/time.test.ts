import { describe, expect, it } from 'vitest';
import { beatsToTransportTime, stepToTransportTime } from './time';

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
