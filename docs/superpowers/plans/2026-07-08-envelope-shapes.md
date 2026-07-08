# Envelope Shapes + Draggable Envelope Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Falling Sine" percussive envelope shape (for kick drums), on/off toggles for the amplitude envelope and pitch envelope, an LFO phase knob, a t=0-aligned adaptive-gridline time axis, a finer-grained Attack knob, and draggable envelope breakpoints on the Tone tab's waveform view.

**Architecture:** `TonePatch.env` gains a `shape`/`on` field (and `PitchEnv`/`LfoConfig` gain `on`/`phase`), read by `PatchVoice` (`src/core/patch-voice.ts`) at playback time and by a new pure module `src/core/envelope-curve.ts` at draw time. `scope-view.ts` draws the envelope trace and breakpoint handles from that pure module; `tone-tab.ts` wires up the new controls and a pointer-drag handler that maps canvas pixels back to envelope params via the same pure math.

**Tech Stack:** TypeScript, Vite, Tone.js (via the `src/core/tone.ts` shim — never import `'tone'` directly), Vitest, vanilla Web Components (no shadow DOM, no virtual DOM).

## Global Constraints

- Always `import * as Tone from '<relative>/core/tone'` — never from `'tone'` directly.
- `npm run build` runs `tsc --noEmit` with `noUnusedLocals`/`noUnusedParameters` on — every task must build clean.
- Any module importing Tone cannot run under Vitest — pure logic must live in Tone-free modules to stay unit-testable.
- New persisted fields on `TonePatch`/`PitchEnv`/`LfoConfig` must be optional and survive a JSON round-trip; the existing `defaultProject()` round-trip test in `src/core/model.test.ts` covers this as long as defaults leave them `undefined`.
- Custom element class fields must not shadow `HTMLElement` members.
- Prefer svg icons/native controls matching existing patterns (`<select>` like the filter-slope picker, checkbox toggles like `onToggle`, knobs like existing `knob()` calls) over introducing new UI idioms.

---

## File Structure

- **Modify** `src/core/model.ts` — `TonePatch.env` gains `shape?: 'adsr' | 'fallingSine'` and `on?: boolean`; `PitchEnv` gains `on?: boolean`; `LfoConfig` gains `phase?: number`; new `envelopeTailSeconds()` helper; `sampleHold()` uses it.
- **Create** `src/core/envelope-curve.ts` — pure, Tone-free: `envelopeLevel()`, `envelopeBreakpoints()`, `pickTimeTick()`. Unit tested.
- **Create** `src/core/envelope-curve.test.ts` — tests for the above.
- **Modify** `src/modules/tone/scope-view.ts` — `drawEnvelopeOverlay()` uses the new pure module and returns pixel-space breakpoint handles; `drawLfoOverlay()` applies LFO phase and starts at `t=0`; `drawWaveformStatic()` uses adaptive gridline ticks instead of a fixed 0.25s spacing.
- **Modify** `src/core/patch-voice.ts` — `PatchVoice` builds its `AmplitudeEnvelope` per shape/on-off, self-schedules the Falling Sine decay as a one-shot, gates the pitch envelope on `pitchEnv.on`, and `renderPatch()` triggers at `t=0` (no pre-roll).
- **Modify** `src/modules/tone/tone-tab.ts` — envelope shape `<select>`, on/off checkboxes for Envelope and Pitch Env, LFO Phase knob, finer/log Attack knob, dispose-timeout fixes, and the pointer-drag envelope editor on the static time canvas.

---

## Task 1: Model — envelope shape/on-off, pitch-env on-off, LFO phase

**Files:**
- Modify: `src/core/model.ts:37-41` (`LfoConfig`), `src/core/model.ts:43-48` (`PitchEnv`), `src/core/model.ts:57-79` (`TonePatch`), `src/core/model.ts:131-134` (`sampleHold`)
- Test: `src/core/model.test.ts`

**Interfaces:**
- Produces: `envelopeTailSeconds(env: TonePatch['env']): number` — the "tail" length used for scheduling (`env.decay` for Falling Sine, `env.release` for ADSR, `0.001` when `env.on === false`). Consumed by `patch-voice.ts` and `tone-tab.ts` in later tasks.
- Produces: `TonePatch['env']` now has optional `shape?: 'adsr' | 'fallingSine'` and `on?: boolean`. `PitchEnv` has optional `on?: boolean`. `LfoConfig` has optional `phase?: number` (degrees, `-180..180`).

- [ ] **Step 1: Write the failing test**

Add to `src/core/model.test.ts`, inside the `describe('project model', ...)` block (after the `'a piano-roll sequence survives a JSON round-trip'` test):

```ts
  it('a patch with envelope shape/on and LFO phase survives a JSON round-trip', () => {
    const p = defaultProject();
    p.patches[0].env.shape = 'fallingSine';
    p.patches[0].env.on = false;
    p.patches[0].pitchEnv = { amount: 12, time: 0.05, on: false };
    p.patches[0].lfoPitch = { rate: 5, depth: 0.5, phase: -90 };
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
```

Also add a new top-level describe block at the end of the file (after `describe('default keymap', ...)`):

```ts
describe('envelopeTailSeconds', () => {
  it('uses release for the default ADSR shape', () => {
    const env = { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.4 };
    expect(envelopeTailSeconds(env)).toBe(0.4);
  });

  it('uses decay for the falling-sine shape', () => {
    const env = { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.4, shape: 'fallingSine' as const };
    expect(envelopeTailSeconds(env)).toBe(0.2);
  });

  it('is near-instant when the envelope is off, regardless of shape', () => {
    const env = { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.4, shape: 'fallingSine' as const, on: false };
    expect(envelopeTailSeconds(env)).toBe(0.001);
  });
});
```

Update the test file's import line to include `envelopeTailSeconds`:

```ts
import { defaultLfo, defaultPatch, defaultProject, envelopeTailSeconds, normalizeProject, PAD_COUNT, pianoNotes, resolveLfos, uid } from './model';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/model.test.ts`
Expected: FAIL — `envelopeTailSeconds` is not exported from `./model`, and the round-trip test may already pass trivially (that's fine; the `envelopeTailSeconds` import failure will fail the whole file).

- [ ] **Step 3: Add the fields and helper to `model.ts`**

Change `LfoConfig` (`src/core/model.ts:37-41`):

```ts
export interface LfoConfig {
  rate: number;  // Hz
  depth: number; // 0..1; 0 = inactive
  on?: boolean;  // undefined = enabled (older projects)
  phase?: number; // degrees, -180..180; undefined = 0 (older projects)
}
```

Change `PitchEnv` (`src/core/model.ts:43-48`):

```ts
export interface PitchEnv {
  /** Semitones the pitch STARTS above base; 0 = off. */
  amount: number;
  /** Seconds to glide down to base. */
  time: number;
  on?: boolean; // undefined = enabled (older projects)
}
```

Change the `env` field on `TonePatch` (`src/core/model.ts:61`):

```ts
  env: { attack: number; decay: number; sustain: number; release: number; shape?: 'adsr' | 'fallingSine'; on?: boolean };
```

Add a shared type alias right above `TonePatch` (so it can be imported wherever the shape union is needed):

```ts
export type EnvShape = 'adsr' | 'fallingSine';
```

and use it in the `env` field instead of the inline union:

```ts
  env: { attack: number; decay: number; sustain: number; release: number; shape?: EnvShape; on?: boolean };
```

Add `envelopeTailSeconds()` right before `sampleHold()` (`src/core/model.ts:131`), and update `sampleHold()` to use it:

```ts
/**
 * Seconds of "tail" after the note is triggered: the Falling Sine decay time,
 * the ADSR release time, or a near-instant fade when the envelope is off.
 */
export function envelopeTailSeconds(env: TonePatch['env']): number {
  if (env.on === false) return 0.001;
  if (env.shape === 'fallingSine') return env.decay;
  return env.release;
}

/**
 * Held-note seconds for a patch render: sampleSeconds is the TOTAL length
 * of the sample, so the hold ends early enough for the release tail to
 * complete within it.
 */
export function sampleHold(patch: TonePatch): number {
  const total = patch.sampleSeconds ?? SAMPLE_SECONDS_DEFAULT;
  return Math.max(0.05, total - envelopeTailSeconds(patch.env) - 0.1);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/model.test.ts`
Expected: PASS (all tests in the file, including the two new ones)

- [ ] **Step 5: Type-check the whole project**

Run: `npm run build`
Expected: succeeds (no other file references the changed types yet, so this should be a clean pass)

- [ ] **Step 6: Commit**

```bash
git add src/core/model.ts src/core/model.test.ts
git commit -m "Add envelope shape/on-off, pitch-env on-off, and LFO phase to the patch model"
```

---

## Task 2: Pure envelope curve math (`src/core/envelope-curve.ts`)

**Files:**
- Create: `src/core/envelope-curve.ts`
- Test: `src/core/envelope-curve.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (fully standalone; structurally compatible with `TonePatch['env']` from Task 1 but does not import it).
- Produces:
  - `type EnvShape = 'adsr' | 'fallingSine'`
  - `interface EnvelopeShapeParams { attack: number; decay: number; sustain: number; release: number; shape?: EnvShape }`
  - `envelopeLevel(env: EnvelopeShapeParams, t: number, holdSeconds: number, startAt: number): number`
  - `interface EnvelopeBreakpoint { param: 'attack' | 'decaySustain' | 'release' | 'decay'; t: number; level: number }`
  - `envelopeBreakpoints(env: EnvelopeShapeParams, holdSeconds: number, startAt: number): EnvelopeBreakpoint[]`
  - `pickTimeTick(seconds: number): number` — consumed by `scope-view.ts` in Task 3.

- [ ] **Step 1: Write the failing test**

Create `src/core/envelope-curve.test.ts`:

```ts
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
      { param: 'decaySustain', t: 0.3, level: 0.4 },
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/envelope-curve.test.ts`
Expected: FAIL with "Cannot find module './envelope-curve'" (file doesn't exist yet)

- [ ] **Step 3: Write the implementation**

Create `src/core/envelope-curve.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/envelope-curve.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Type-check the whole project**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 6: Commit**

```bash
git add src/core/envelope-curve.ts src/core/envelope-curve.test.ts
git commit -m "Add pure envelope curve, breakpoint, and adaptive tick-spacing math"
```

---

## Task 3: Wire the pure math into `scope-view.ts`

**Files:**
- Modify: `src/modules/tone/scope-view.ts:74-96` (`drawWaveformStatic`), `src/modules/tone/scope-view.ts:234-260` (`drawLfoOverlay`), `src/modules/tone/scope-view.ts:262-297` (`drawEnvelopeOverlay`)

**Interfaces:**
- Consumes: `envelopeLevel`, `envelopeBreakpoints`, `pickTimeTick` from `../../core/envelope-curve` (Task 2). `TonePatch['env']`'s new `shape`/`on` fields and `LfoConfig`'s new `phase` field (Task 1) — structurally, via loosely-typed parameters (this file doesn't need to import those model types).
- Produces: `export interface EnvelopeHandle { param: 'attack' | 'decaySustain' | 'release' | 'decay'; x: number; y: number }`; `drawEnvelopeOverlay(...): EnvelopeHandle[]` (previously returned `void`) — consumed by `tone-tab.ts` in Tasks 5-6.

- [ ] **Step 1: Add the import**

At the top of `src/modules/tone/scope-view.ts`, after the existing imports:

```ts
import { envelopeBreakpoints, envelopeLevel, pickTimeTick } from '../../core/envelope-curve';
```

- [ ] **Step 2: Replace `drawWaveformStatic`'s fixed gridline spacing with adaptive ticks**

Replace `src/modules/tone/scope-view.ts:74-96`:

```ts
/** Static amplitude-over-time view of a rendered buffer (min/max per column). */
export function drawWaveformStatic(canvas: HTMLCanvasElement, data: Float32Array, sampleRate: number): void {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  const seconds = data.length / sampleRate;
  const step = pickTimeTick(seconds);
  const xs: number[] = [];
  for (let t = step; t < seconds; t += step) xs.push((t / seconds) * w);
  const ys = [0.25, 0.5, 0.75].map((f) => f * h);
  grid(ctx, w, h, xs, ys);
  ctx.fillStyle = LABEL;
  ctx.font = '10px sans-serif';
  for (let t = step; t < seconds; t += step) {
    const label = t < 1 ? `${Math.round(t * 1000)}ms` : `${t.toFixed(1)}s`;
    ctx.fillText(label, (t / seconds) * w + 3, h - 4);
  }
  const { min, max } = waveformPeaks(data, w);
  ctx.fillStyle = TRACE;
  for (let x = 0; x < w; x++) {
    const yTop = ((1 - max[x]) / 2) * h;
    const yBottom = ((1 - min[x]) / 2) * h;
    ctx.fillRect(x, yTop, 1, Math.max(1, yBottom - yTop));
  }
}
```

- [ ] **Step 3: Add LFO phase and remove the LFO overlay's pre-roll**

Replace `src/modules/tone/scope-view.ts:234-260`:

```ts
/**
 * LFO modulation contour over an already-drawn static waveform view: for
 * the volume LFO the actual gain sweep (1-depth..1), for the pitch LFO a
 * centered oscillation scaled by depth. Disabled/zero-depth draws nothing.
 */
export function drawLfoOverlay(
  canvas: HTMLCanvasElement,
  lfo: { rate: number; depth: number; on?: boolean; phase?: number },
  kind: 'pitch' | 'volume',
  seconds: number,
  startAt = 0,
): void {
  if (lfo.depth <= 0 || lfo.on === false) return;
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  const phaseRad = ((lfo.phase ?? 0) * Math.PI) / 180;
  const level = (t: number): number => {
    const phase = Math.sin(2 * Math.PI * lfo.rate * Math.max(0, t - startAt) + phaseRad);
    return kind === 'volume'
      ? 1 - lfo.depth + lfo.depth * (0.5 + 0.5 * phase)
      : 0.5 + 0.5 * lfo.depth * phase;
  };
  ctx.strokeStyle = kind === 'volume' ? LFO_TRACE : LFO_PITCH_TRACE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let px = 0; px < w; px++) {
    const y = ((1 - level((px / w) * seconds)) / 2) * h;
    if (px === 0) ctx.moveTo(px, y);
    else ctx.lineTo(px, y);
  }
  ctx.stroke();
}
```

- [ ] **Step 4: Rewrite `drawEnvelopeOverlay` to use the pure module, draw handles, and return them**

Replace `src/modules/tone/scope-view.ts:262-297`:

```ts
export interface EnvelopeHandle {
  param: 'attack' | 'decaySustain' | 'release' | 'decay';
  x: number;
  y: number;
}

/**
 * Orange envelope contour (ADSR or Falling Sine) over an already-drawn
 * static waveform view, on the same time axis, plus small draggable-looking
 * handles at each breakpoint. Returns the handles in canvas pixel space so
 * the caller can hit-test pointer events against them.
 */
export function drawEnvelopeOverlay(
  canvas: HTMLCanvasElement,
  env: { attack: number; decay: number; sustain: number; release: number; shape?: 'adsr' | 'fallingSine' },
  seconds: number,
  holdSeconds = 1,
  startAt = 0,
): EnvelopeHandle[] {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  const toPixel = (t: number, level: number): { x: number; y: number } => ({
    x: (t / seconds) * w,
    y: ((1 - level) / 2) * h,
  });
  ctx.strokeStyle = ENV_TRACE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let px = 0; px < w; px++) {
    const t = (px / w) * seconds;
    const { y } = toPixel(t, envelopeLevel(env, t, holdSeconds, startAt));
    if (px === 0) ctx.moveTo(px, y);
    else ctx.lineTo(px, y);
  }
  ctx.stroke();
  const handles = envelopeBreakpoints(env, holdSeconds, startAt).map((bp) => ({ param: bp.param, ...toPixel(bp.t, bp.level) }));
  ctx.fillStyle = ENV_TRACE;
  for (const handle of handles) {
    ctx.beginPath();
    ctx.arc(handle.x, handle.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  return handles;
}
```

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: succeeds. `tone-tab.ts` still calls `drawEnvelopeOverlay(timeCanvas, patch.env, seconds, sampleHold(patch))` (4 args, so `startAt` uses the new `0` default) and discards the new `EnvelopeHandle[]` return value — a discarded return value is not a type error, and `patch.env`/`lfos.pitch` already structurally satisfy the widened parameter types from Task 1. If `npm run build` reports errors here, they are unrelated to this task's intent — stop and investigate before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/modules/tone/scope-view.ts
git commit -m "Draw Falling Sine envelopes, LFO phase, and adaptive ms/s gridlines in the Tone tab overlays"
```

---

## Task 4: Playback — envelope shape, on/off, pitch-env on/off, no pre-roll

**Files:**
- Modify: `src/core/patch-voice.ts` (constructor, `triggerAttack`, `triggerRelease`, `renderPatch`)

**Interfaces:**
- Consumes: `envelopeTailSeconds` from `./model` (Task 1).
- Produces: no new exports; `PatchVoice`'s public API (`triggerAttack`, `triggerRelease`, `triggerAttackRelease`, `dispose`) is unchanged in signature, only in behavior.

- [ ] **Step 1: Update the import**

Change `src/core/patch-voice.ts:5`:

```ts
import { defaultFilter, envelopeTailSeconds, resolveLfos, SAMPLE_FREQ_DEFAULT, SAMPLE_NOTE_DEFAULT, SAMPLE_SECONDS_DEFAULT, sampleHold } from './model';
```

- [ ] **Step 2: Add fields and shape-aware envelope construction**

Add two fields after `private releaseSeconds: number;` (`src/core/patch-voice.ts:29`):

```ts
  private releaseSeconds: number;
  private oneShot: boolean;
  private attackSeconds: number;
```

`src/core/patch-voice.ts:34-36` currently reads exactly:

```ts
  constructor(patch: TonePatch, destination: Tone.ToneAudioNode) {
    const filter = patch.filter ?? defaultFilter();
    this.env = new Tone.AmplitudeEnvelope(patch.env).connect(destination);
```

Replace those exact 3 lines with the following (the very next line in the file, `// disabled filters are left out of the chain entirely`, and everything after it — the filter chain, layer setup, LFOs — stays untouched and follows directly after):

```ts
  constructor(patch: TonePatch, destination: Tone.ToneAudioNode) {
    const filter = patch.filter ?? defaultFilter();
    const shape = patch.env.shape ?? 'adsr';
    const envOn = patch.env.on !== false;
    this.oneShot = envOn && shape === 'fallingSine';
    this.attackSeconds = patch.env.attack;
    if (!envOn) {
      // flat gate: instantly full volume on note-on, instantly silent on note-off
      this.env = new Tone.AmplitudeEnvelope({ attack: 0.001, decay: 0.001, sustain: 1, release: 0.001 }).connect(destination);
    } else if (shape === 'fallingSine') {
      // fast attack, then Tone's built-in 'sine' release curve (a smooth cosine
      // fall from 1 to 0) used as the decay — self-scheduled in triggerAttack
      // so the hit always plays in full regardless of note length
      this.env = new Tone.AmplitudeEnvelope({
        attack: patch.env.attack,
        decay: 0.001,
        sustain: 1,
        release: patch.env.decay,
        releaseCurve: 'sine',
      }).connect(destination);
    } else {
      this.env = new Tone.AmplitudeEnvelope(patch.env).connect(destination);
    }
```

- [ ] **Step 3: Use `envelopeTailSeconds` for `releaseSeconds`**

Change `src/core/patch-voice.ts:60` (`this.releaseSeconds = patch.env.release;`) to:

```ts
    this.releaseSeconds = envelopeTailSeconds(patch.env);
```

- [ ] **Step 4: Gate the pitch envelope on `pitchEnv.on`, self-schedule the one-shot decay**

Replace `triggerAttack` (`src/core/patch-voice.ts:98-127`):

```ts
  triggerAttack(note: string | number, time?: number, velocity = 1): void {
    // notes transpose the whole patch relative to C4: at C4 every layer
    // plays exactly its configured base frequency
    const ratio = Tone.Frequency(note).toFrequency() / SAMPLE_FREQ_DEFAULT;
    // no explicit time = a live key press: skip the scheduling look-ahead
    const t = time ?? Tone.immediate();
    this.oscs.forEach((osc, i) => {
      // schedule at t: a live trigger starts at immediate(), BEFORE the
      // now()+lookAhead point where a plain .value write would land, so the
      // oscillator would open at its default 440 Hz until the write applied
      const target = this.baseFreqs[i] * ratio;
      if (this.pitchEnv && this.pitchEnv.amount > 0 && this.pitchEnv.on !== false) {
        // start above the transposed base freq and glide down to it
        osc.frequency.setValueAtTime(target * Math.pow(2, this.pitchEnv.amount / 12), t);
        osc.frequency.exponentialRampToValueAtTime(target, t + this.pitchEnv.time);
      } else {
        osc.frequency.setValueAtTime(target, t);
      }
      osc.start(t);
    });
    for (const noise of this.noises) noise.start(t);
    if (this.lpFilter && this.filterEnv && this.filterEnv.amount > 1) {
      const start = Math.min(this.lpfBase * this.filterEnv.amount, 20000);
      this.lpFilter.frequency.setValueAtTime(start, t);
      this.lpFilter.frequency.exponentialRampToValueAtTime(this.lpfBase, t + this.filterEnv.time);
    }
    this.lfoPitch?.start(t);
    this.lfoVolume?.start(t);
    this.env.triggerAttack(t, velocity);
    if (this.oneShot) {
      // a percussive hit always plays its full decay, regardless of note length
      const releaseAt = t + this.attackSeconds;
      this.env.triggerRelease(releaseAt);
      const stopAt = releaseAt + this.releaseSeconds + 0.05;
      for (const osc of this.oscs) osc.stop(stopAt);
      for (const noise of this.noises) noise.stop(stopAt);
      this.lfoPitch?.stop(stopAt);
      this.lfoVolume?.stop(stopAt);
    }
  }
```

Replace `triggerRelease` (`src/core/patch-voice.ts:129-137`):

```ts
  triggerRelease(time?: number): void {
    if (this.oneShot) return; // already self-scheduled in triggerAttack
    const t = time ?? Tone.immediate();
    this.env.triggerRelease(t);
    const stopAt = t + this.releaseSeconds + 0.05;
    for (const osc of this.oscs) osc.stop(stopAt);
    for (const noise of this.noises) noise.stop(stopAt);
    this.lfoPitch?.stop(stopAt);
    this.lfoVolume?.stop(stopAt);
  }
```

`triggerAttackRelease` (`src/core/patch-voice.ts:139-143`) is unchanged — it calls `triggerAttack` then `triggerRelease`, and the latter is now a no-op for one-shot voices, which is correct.

- [ ] **Step 5: Remove the render pre-roll**

Change `src/core/patch-voice.ts:167` inside `renderPatch`:

```ts
      voice.triggerAttackRelease(freq, hold, 0);
```

(was `voice.triggerAttackRelease(freq, hold, 0.01);`)

- [ ] **Step 6: Type-check**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 7: Manual verification in the browser**

Run: `npm run dev`, open the app, go to the Tone tab.

1. Select the default patch, open the Envelope card, switch the (not-yet-visible — added in Task 5) shape... skip this step's UI parts for now; instead verify with the browser console: confirm the app loads with no console errors and the existing patch still plays a sound when you hit the Play button (hotkey `1`). This confirms the constructor/triggerAttack refactor didn't break the default ADSR path.
2. No shape selector exists yet (Task 5 adds it) — full manual verification of Falling Sine playback happens at the end of Task 5.

- [ ] **Step 8: Commit**

```bash
git add src/core/patch-voice.ts
git commit -m "Play Falling Sine as a self-scheduled one-shot decay; gate envelope/pitch-env on-off; drop render pre-roll"
```

---

## Task 5: Tone tab controls — shape select, on/off toggles, LFO phase knob, finer Attack

**Files:**
- Modify: `src/modules/tone/tone-tab.ts`

**Interfaces:**
- Consumes: `envelopeTailSeconds` from `../../core/model` (Task 1); `EnvelopeHandle` type from `./scope-view` (Task 3, used starting in this task so the field can be declared, populated fully in Task 6); `DawKnob` from `../../ui/knob`.
- Produces: `private envKnobEls: Map<'attack' | 'decay' | 'sustain' | 'release', DawKnob>` and `private envHandles: EnvelopeHandle[]` fields on `ToneTab`, consumed by Task 6's drag handlers.

- [ ] **Step 1: Update imports**

Change `src/modules/tone/tone-tab.ts:23`:

```ts
import { knob, DawKnob } from '../../ui/knob';
```

Change the `../../core/model` import block (`src/modules/tone/tone-tab.ts:5-19`) to add `envelopeTailSeconds`:

```ts
import {
  defaultFilter,
  defaultFilterEnv,
  defaultPatch,
  defaultPitchEnv,
  envelopeTailSeconds,
  resolveLfos,
  pianoNotes,
  SAMPLE_FREQ_DEFAULT,
  SAMPLE_NOTE_DEFAULT,
  SAMPLE_SECONDS_DEFAULT,
  sampleHold,
  sortedByName,
  toneBufferKey,
  uid,
} from '../../core/model';
```

Add a type-only import for `EnvelopeHandle` right after the `./scope-view` import block (`src/modules/tone/tone-tab.ts:27-41`):

```ts
import type { EnvelopeHandle } from './scope-view';
```

- [ ] **Step 2: Add class fields**

After `private lastRender: { data: Float32Array; sampleRate: number } | null = null;` (`src/modules/tone/tone-tab.ts:93`):

```ts
  private lastRender: { data: Float32Array; sampleRate: number } | null = null;
  private envHandles: EnvelopeHandle[] = [];
  private envKnobEls = new Map<'attack' | 'decay' | 'sustain' | 'release', DawKnob>();
  private envDragParam: EnvelopeHandle['param'] | null = null;
```

- [ ] **Step 3: Fix the dispose-timeout calculations**

Change `noteOff` (`src/modules/tone/tone-tab.ts:280-286`):

```ts
  private noteOff(key: string): void {
    const voice = this.voices.get(key);
    if (!voice) return;
    this.voices.delete(key);
    voice.triggerRelease();
    setTimeout(() => voice.dispose(), (envelopeTailSeconds(this.patch().env) + 0.3) * 1000);
  }
```

Change the preview loop's dispose timeout inside `playPreview` (`src/modules/tone/tone-tab.ts:306-308`):

```ts
        this.previewTimers.push(
          window.setTimeout(() => voice.dispose(), (holdNow + envelopeTailSeconds(p.env) + 0.5) * 1000),
        );
```

- [ ] **Step 4: Capture the returned envelope handles in `redrawStatic`**

Change `src/modules/tone/tone-tab.ts:375-379`:

```ts
    drawWaveformStatic(timeCanvas, view, sampleRate);
    this.envHandles = drawEnvelopeOverlay(timeCanvas, patch.env, seconds, sampleHold(patch));
    const lfos = this.lfos(patch);
    drawLfoOverlay(timeCanvas, lfos.pitch, 'pitch', seconds);
    drawLfoOverlay(timeCanvas, lfos.volume, 'volume', seconds);
```

- [ ] **Step 5: Move `onToggle` above the Envelope card, add the shape select and on/off checkboxes, restyle the Attack knob**

Replace the whole block from `// --- envelope + LFO (shown ABOVE the layers) ---` through `pitchEnvCard.appendChild(pitchEnvKnobs);` (`src/modules/tone/tone-tab.ts:694-736`):

```ts
    // --- envelope + LFO (shown ABOVE the layers) ---
    const row = document.createElement('div');
    row.className = 'tone-mod-row';
    const legendDot = (color: string): string => `<span class="legend-dot" style="background:${color}"></span>`;

    // small enable/disable checkbox for a card section (Envelope, Pitch Env, LFO, HPF, LPF)
    const onToggle = (title: string, isOn: boolean, apply: (on: boolean) => void): HTMLLabelElement => {
      const l = document.createElement('label');
      l.className = 'check-toggle hint';
      l.title = title;
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = isOn;
      c.onchange = (): void => {
        apply(c.checked);
        this.save();
      };
      l.appendChild(c);
      return l;
    };

    const envCard = document.createElement('div');
    envCard.className = 'card';
    envCard.innerHTML = `<div class="card-head">${legendDot(ENV_TRACE)}<span class="card-title">Envelope</span></div>`;
    const shapeSel = document.createElement('select');
    shapeSel.title = 'Envelope shape';
    for (const [value, label] of [
      ['adsr', 'ADSR'],
      ['fallingSine', 'Falling Sine'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      opt.selected = (patch.env.shape ?? 'adsr') === value;
      shapeSel.appendChild(opt);
    }
    const envKnobs = document.createElement('div');
    envKnobs.className = 'knob-row';
    this.envKnobEls.clear();
    const envParams = [
      ['attack', 'Attack', 0.001, 2, 0.001, true],
      ['decay', 'Decay', 0.01, 2, 0.01, false],
      ['sustain', 'Sustain', 0, 1, 0.01, false],
      ['release', 'Release', 0.01, 4, 0.01, false],
    ] as const;
    for (const [key, label, min, max, step, log] of envParams) {
      const el = knob({ label, min, max, step, value: patch.env[key], log, unit: key === 'sustain' ? '' : 's' }, (v) => {
        patch.env[key] = v;
        this.save();
      });
      this.envKnobEls.set(key, el);
      envKnobs.appendChild(el);
    }
    const applyShapeVisibility = (): void => {
      const isFallingSine = shapeSel.value === 'fallingSine';
      this.envKnobEls.get('sustain')!.style.display = isFallingSine ? 'none' : '';
      this.envKnobEls.get('release')!.style.display = isFallingSine ? 'none' : '';
    };
    shapeSel.onchange = (): void => {
      patch.env.shape = shapeSel.value as 'adsr' | 'fallingSine';
      applyShapeVisibility();
      this.save();
    };
    applyShapeVisibility();
    envCard
      .querySelector('.card-head')!
      .append(onToggle('Enable/disable the envelope', patch.env.on !== false, (on) => (patch.env.on = on)), shapeSel);
    envCard.appendChild(envKnobs);

    // --- pitch envelope: a percussive downward glide on top of the played note ---
    const pitchEnvCard = document.createElement('div');
    pitchEnvCard.className = 'card';
    pitchEnvCard.innerHTML = '<div class="card-head"><span class="card-title">Pitch Env</span></div>';
    const pitchEnv = this.pitchEnv(patch);
    pitchEnvCard
      .querySelector('.card-head')!
      .appendChild(onToggle('Enable/disable the pitch envelope', pitchEnv.on !== false, (on) => (pitchEnv.on = on)));
    const pitchEnvKnobs = document.createElement('div');
    pitchEnvKnobs.className = 'knob-row';
    pitchEnvKnobs.append(
      knob({ label: 'Amount', min: 0, max: 48, step: 1, value: pitchEnv.amount, unit: 'st' }, (v) => {
        pitchEnv.amount = v;
        this.save();
      }),
      knob({ label: 'Time', min: 0.005, max: 0.5, step: 0.005, value: pitchEnv.time, log: true, unit: 's' }, (v) => {
        pitchEnv.time = v;
        this.save();
      }),
    );
    pitchEnvCard.appendChild(pitchEnvKnobs);
```

- [ ] **Step 6: Remove the now-duplicate `onToggle` definition, add the LFO Phase knob**

Replace `src/modules/tone/tone-tab.ts:738-776` (the old standalone `onToggle` definition followed by `lfoCard`):

```ts
    const lfoCard = (title: string, trace: string, lfo: LfoConfig): HTMLDivElement => {
      const card = document.createElement('div');
      card.className = 'card';
      const head = document.createElement('div');
      head.className = 'card-head';
      head.innerHTML = `${legendDot(trace)}<span class="card-title">${title}</span>`;
      head.appendChild(onToggle(`Enable/disable the ${title.toLowerCase()}`, lfo.on !== false, (on) => (lfo.on = on)));
      card.appendChild(head);
      const knobs = document.createElement('div');
      knobs.className = 'knob-row';
      knobs.append(
        knob({ label: 'Rate', min: 0.1, max: 20, step: 0.1, value: lfo.rate, log: true, unit: 'Hz' }, (v) => {
          lfo.rate = v;
          this.save();
        }),
        knob({ label: 'Depth', min: 0, max: 1, step: 0.01, value: lfo.depth }, (v) => {
          lfo.depth = v;
          this.save();
        }),
        knob({ label: 'Phase', min: -180, max: 180, step: 1, value: lfo.phase ?? 0, unit: '°' }, (v) => {
          lfo.phase = v;
          this.save();
        }),
      );
      card.appendChild(knobs);
      return card;
    };
```

(Note: this deletes the block that used to declare `onToggle` here — it's now declared earlier, in Step 5 — and inserts a third "Phase" knob into `lfoCard`'s `knobs.append(...)` call.)

- [ ] **Step 7: Type-check**

Run: `npm run build`
Expected: succeeds. If TypeScript complains about `applyShapeVisibility`/`envKnobEls` usage before `sustain`/`release` entries exist, double check `this.envKnobEls.set(key, el)` runs for all four `envParams` rows before `applyShapeVisibility()` is called — the `for` loop must complete first (it does, per the code above).

- [ ] **Step 8: Manual verification in the browser**

Run: `npm run dev`, open the app, go to the Tone tab.

1. Confirm the Envelope card now shows a checkbox and a shape `<select>` (ADSR / Falling Sine) next to its title, and the Pitch Env card shows a checkbox next to its title.
2. Switch the Envelope shape to "Falling Sine": the Sustain and Release knobs should disappear; Attack and Decay remain. Play the patch (hotkey `1`) — you should hear a fast-attack percussive hit that decays smoothly to silence on its own, even if the sound is very short.
3. Switch back to "ADSR": Sustain/Release reappear with their previous values intact (not reset).
4. Uncheck the Envelope's on/off checkbox: play the patch — it should snap to full volume immediately and cut off immediately in a very short, click-free burst.
5. Uncheck the Pitch Env checkbox (with a nonzero Pitch Env Amount dialed in): confirm the percussive pitch glide no longer happens.
6. Drag the Attack knob: confirm it now takes much finer, more controllable movement near its low end (near 1ms) compared to before.
7. Open a Pitch LFO or Vol LFO card: confirm a "Phase" knob appears alongside Rate/Depth, ranges -180..180.
8. Confirm no console errors during any of the above.

- [ ] **Step 9: Commit**

```bash
git add src/modules/tone/tone-tab.ts
git commit -m "Add envelope shape select, envelope/pitch-env on-off toggles, LFO phase knob, finer Attack knob"
```

---

## Task 6: Draggable envelope breakpoints on the waveform canvas

**Files:**
- Modify: `src/modules/tone/tone-tab.ts`

**Interfaces:**
- Consumes: `this.envHandles` and `this.envKnobEls` (Task 5); `EnvelopeHandle` type (Task 3); `sampleHold` (already imported).
- Produces: `private attachEnvelopeDrag(canvas: HTMLCanvasElement): void`, `private dragEnvelopeHandle(param, x, y, width, height): void` — no other file depends on these.

- [ ] **Step 1: Pass a drag-attach callback for the static time canvas**

Change `src/modules/tone/tone-tab.ts:496-501`:

```ts
    } else {
      scopes.append(
        scope('Amplitude / time', 'scope-static-time', (c) => this.attachEnvelopeDrag(c)),
        scope('Energy / frequency', 'scope-static-freq'),
      );
    }
```

- [ ] **Step 2: Add the drag-handling methods**

Add these two private methods to the `ToneTab` class, right after `redrawStatic` (after `src/modules/tone/tone-tab.ts:382`, i.e. right before `private filter(patch: TonePatch): PatchFilter {`):

```ts
  /** Wire pointer-drag editing of the envelope breakpoints drawn on the static time canvas. */
  private attachEnvelopeDrag(canvas: HTMLCanvasElement): void {
    const hitRadius = 8;
    const toCanvasPoint = (e: PointerEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / rect.width) * canvas.width,
        y: ((e.clientY - rect.top) / rect.height) * canvas.height,
      };
    };
    const findHandle = (x: number, y: number): EnvelopeHandle | null => {
      for (const h of this.envHandles) {
        if (Math.hypot(h.x - x, h.y - y) <= hitRadius) return h;
      }
      return null;
    };
    canvas.addEventListener('pointerdown', (e) => {
      const { x, y } = toCanvasPoint(e);
      const handle = findHandle(x, y);
      if (!handle) return;
      this.envDragParam = handle.param;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      const { x, y } = toCanvasPoint(e);
      if (!this.envDragParam) {
        canvas.style.cursor = findHandle(x, y) ? 'grab' : 'default';
        return;
      }
      this.dragEnvelopeHandle(this.envDragParam, x, y, canvas.width, canvas.height);
    });
    const endDrag = (): void => {
      this.envDragParam = null;
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointerleave', endDrag);
  }

  /** Apply a drag at canvas pixel (x, y) to the envelope param it controls. */
  private dragEnvelopeHandle(param: EnvelopeHandle['param'], x: number, y: number, width: number, height: number): void {
    const patch = this.patch();
    const seconds = patch.sampleSeconds ?? SAMPLE_SECONDS_DEFAULT;
    const t = Math.max(0, (x / width) * seconds);
    const level = Math.min(1, Math.max(0, 1 - (2 * y) / height));
    const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
    const setKnob = (key: 'attack' | 'decay' | 'sustain' | 'release', value: number): void => {
      patch.env[key] = value;
      const el = this.envKnobEls.get(key);
      if (el) el.value = value;
    };
    if (param === 'attack') {
      setKnob('attack', clamp(t, 0.001, 2));
    } else if (param === 'decay') {
      setKnob('decay', clamp(t - patch.env.attack, 0.01, 2));
    } else if (param === 'decaySustain') {
      setKnob('decay', clamp(t - patch.env.attack, 0.01, 2));
      setKnob('sustain', clamp(level, 0, 1));
    } else if (param === 'release') {
      setKnob('release', clamp(t - sampleHold(patch), 0.01, 4));
    }
    this.save();
  }
```

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 4: Manual verification in the browser**

Run: `npm run dev`, open the app, go to the Tone tab, with the shape set to "ADSR".

1. Hover the mouse over the amplitude/time canvas near the peak of the envelope trace (the attack breakpoint): the cursor should change to a grab hand only when near one of the three small filled circles (attack, decay/sustain corner, release end).
2. Drag the attack-peak handle left/right: the Attack knob's value updates live and the trace redraws as you drag.
3. Drag the decay/sustain corner handle: dragging horizontally changes Decay, dragging vertically changes Sustain — both knobs update live.
4. Drag the release-end handle horizontally: the Release knob updates live.
5. Switch the shape to "Falling Sine": confirm only two handles are drawn (attack peak, decay end) and dragging each updates Attack/Decay respectively.
6. Confirm dragging never produces NaN/negative values in the knobs (try dragging far outside the canvas bounds via a fast mouse movement) — clamping should hold.
7. Confirm no console errors throughout.

- [ ] **Step 5: Commit**

```bash
git add src/modules/tone/tone-tab.ts
git commit -m "Add pointer-drag editing of envelope breakpoints on the Tone tab waveform view"
```

---

## Task 7: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the new `model.test.ts` and `envelope-curve.test.ts` cases from Tasks 1-2.

- [ ] **Step 2: Full type-check and build**

Run: `npm run build`
Expected: succeeds with zero errors/warnings.

- [ ] **Step 3: End-to-end manual pass in the browser**

Run: `npm run dev` (or reuse a running instance), open the app, Tone tab:

1. Create a new patch, set its Envelope shape to Falling Sine, Attack ~0.001s, Decay ~0.15s, add a sine layer at ~60Hz — confirm it sounds like a plausible kick drum thump (fast punch, no ringing tail, no exponential "ring-out").
2. Export the patch (Export button) and re-import the downloaded `.json` — confirm the shape/on-off/phase fields survive (re-select the imported patch and check the shape selector and checkboxes match what was exported).
3. Switch to the Live scope view and back to Static — confirm no crashes and the static view still renders the current patch correctly with the new gridlines.
4. Reload the whole page (full reload, not HMR) and confirm the previously edited patch reloads with its Falling Sine shape and on/off states intact (persistence round-trip through the real IndexedDB/project-store path, not just JSON.stringify in a test).

- [ ] **Step 4: Report results**

No commit for this task — it's a verification pass. If any step fails, return to the relevant earlier task, fix, and re-run this task's steps from the top.

---

## Plan Self-Review Notes

- **Spec coverage:** shape selector + Falling Sine (Tasks 1-6), draggable breakpoints (Tasks 3, 6), envelope/pitch-env on-off (Tasks 1, 4, 5), LFO phase (Tasks 1, 3, 5), t=0 alignment + adaptive ms gridlines (Tasks 3-4), finer Attack knob (Task 5) — every spec section maps to at least one task.
- **Placeholder scan:** no TBD/TODO markers; every step shows complete code, not a description of code.
- **Type consistency:** `EnvelopeHandle['param']` (`'attack' | 'decaySustain' | 'release' | 'decay'`), `envKnobEls` key type (`'attack' | 'decay' | 'sustain' | 'release'`), and `envelopeTailSeconds(env: TonePatch['env'])` are used identically across Tasks 3-6.
