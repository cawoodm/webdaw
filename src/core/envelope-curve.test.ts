import { describe, expect, it } from 'vitest';
import { envelopeBreakpoints, envelopeLevel, pickTimeTick } from './envelope-curve';

describe('envelopeLevel', () => {
  const adsr = { attack: 0.1, decay: 0.2, sustain: 0.5, release: 0.3 };

  it('is 0 at and before startAt', () => {
    expect(envelopeLevel(adsr, 0, 1, 0)).toBe(0);
    expect(envelopeLevel(adsr, -1, 1, 0)).toBe(0);
  });

  it('ramps linearly to 1 over the attack for ADSR', () => {
    expect(envelopeLevel(adsr, 0.05, 1, 0)).toBeCloseTo(0.5, 5);
    expect(envelopeLevel(adsr, 0.1, 1, 0)).toBeCloseTo(1, 5);
  });

  const fallingSine = { attack: 0.05, decay: 0.2, sustain: 0, release: 0, shape: 'fallingSine' as const };

  it('ramps linearly to 1 over the attack for Falling Sine', () => {
    expect(envelopeLevel(fallingSine, 0.025, 1, 0)).toBeCloseTo(0.5, 5);
    expect(envelopeLevel(fallingSine, 0.05, 1, 0)).toBeCloseTo(1, 5);
  });

  it('follows a cosine decay from 1 to 0 over `decay` seconds after the attack', () => {
    expect(envelopeLevel(fallingSine, 0.05 + 0.1, 1, 0)).toBeCloseTo(0.5, 5); // halfway through decay
    expect(envelopeLevel(fallingSine, 0.05 + 0.2, 1, 0)).toBeCloseTo(0, 5); // end of decay
  });

  it('stays at 0 after attack + decay for Falling Sine', () => {
    expect(envelopeLevel(fallingSine, 1, 1, 0)).toBeCloseTo(0, 5);
  });

  it('offsets everything by startAt', () => {
    expect(envelopeLevel(fallingSine, 0.3, 1, 0.25)).toBeCloseTo(1, 5); // attack peak now at 0.25+0.05
  });
});

describe('envelopeBreakpoints', () => {
  it('returns attack/decaySustain/release for ADSR', () => {
    const env = { attack: 0.1, decay: 0.2, sustain: 0.4, release: 0.3 };
    expect(envelopeBreakpoints(env, 1, 0)).toEqual([
      { param: 'attack', t: 0.1, level: 1 },
      { param: 'decaySustain', t: 0.1 + 0.2, level: 0.4 }, // matches the float sum order in envelopeBreakpoints
      { param: 'release', t: 1.3, level: 0 },
    ]);
  });

  it('returns attack/decay for Falling Sine, ignoring sustain/release', () => {
    const env = { attack: 0.05, decay: 0.2, sustain: 0.9, release: 5, shape: 'fallingSine' as const };
    expect(envelopeBreakpoints(env, 1, 0)).toEqual([
      { param: 'attack', t: 0.05, level: 1 },
      { param: 'decay', t: 0.25, level: 0 },
    ]);
  });

  it('offsets everything by startAt', () => {
    const env = { attack: 0.1, decay: 0.2, sustain: 0.4, release: 0.3 };
    expect(envelopeBreakpoints(env, 1, 0.5)).toEqual([
      { param: 'attack', t: 0.6, level: 1 },
      { param: 'decaySustain', t: 0.8, level: 0.4 },
      { param: 'release', t: 1.8, level: 0 },
    ]);
  });
});

describe('pickTimeTick', () => {
  it('picks a nice ms-scale step for short buffers', () => {
    expect(pickTimeTick(0.05)).toBeCloseTo(0.01, 6); // 5 gridlines over 50ms
  });

  it('picks a nice step for a 1s buffer', () => {
    expect(pickTimeTick(1)).toBeCloseTo(0.2, 6); // 5 gridlines over 1s
  });

  it('picks a nice step for a 4s buffer', () => {
    expect(pickTimeTick(4)).toBeCloseTo(0.5, 6); // 8 gridlines over 4s
  });

  it('never divides by zero for a zero-length buffer', () => {
    expect(pickTimeTick(0)).toBeGreaterThan(0);
  });
});
