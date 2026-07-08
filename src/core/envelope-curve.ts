/**
 * Pure envelope math shared by the Tone tab's overlay drawing and drag
 * editing. No Tone.js import, so — unlike scope-view.ts, which imports Tone
 * for analyser types — this module is unit-testable under Vitest.
 */

export type EnvShape = 'adsr' | 'fallingSine';

export interface EnvelopeShapeParams {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  shape?: EnvShape;
}

/** Amplitude (0..1) at time `t` seconds, where the note starts at `startAt`. */
export function envelopeLevel(env: EnvelopeShapeParams, t: number, holdSeconds: number, startAt: number): number {
  const ta = t - startAt;
  if (ta <= 0) return 0;
  if (env.shape === 'fallingSine') {
    if (ta < env.attack) return ta / env.attack;
    const k = Math.min(1, (ta - env.attack) / env.decay);
    return 0.5 * (1 + Math.cos(Math.PI * k));
  }
  const preRelease = (x: number): number =>
    x < env.attack ? x / env.attack : env.sustain + (1 - env.sustain) * Math.exp(-5 * ((x - env.attack) / env.decay));
  if (ta < holdSeconds) return preRelease(ta);
  return preRelease(holdSeconds) * Math.exp(-5 * ((ta - holdSeconds) / env.release));
}

export interface EnvelopeBreakpoint {
  param: 'attack' | 'decaySustain' | 'release' | 'decay';
  t: number;
  level: number;
}

/** Draggable control points, in envelope-relative seconds/level (not pixels). */
export function envelopeBreakpoints(env: EnvelopeShapeParams, holdSeconds: number, startAt: number): EnvelopeBreakpoint[] {
  if (env.shape === 'fallingSine') {
    return [
      { param: 'attack', t: startAt + env.attack, level: 1 },
      { param: 'decay', t: startAt + env.attack + env.decay, level: 0 },
    ];
  }
  return [
    { param: 'attack', t: startAt + env.attack, level: 1 },
    { param: 'decaySustain', t: startAt + env.attack + env.decay, level: env.sustain },
    { param: 'release', t: startAt + holdSeconds + env.release, level: 0 },
  ];
}

const NICE_STEPS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];

/** Smallest "nice" tick spacing (seconds) keeping roughly 4-8 gridlines across `seconds`. */
export function pickTimeTick(seconds: number): number {
  if (seconds <= 0) return 1;
  for (const ms of NICE_STEPS_MS) {
    const step = ms / 1000;
    if (seconds / step <= 8) return step;
  }
  return NICE_STEPS_MS[NICE_STEPS_MS.length - 1] / 1000;
}
