# Envelope Shapes + Draggable Envelope Editor — Design

Date: 2026-07-08

## Goal

The current amplitude envelope is a fixed exponential ADSR, which can't
produce a good kick drum (needs a fast attack then a smooth sinusoidal
decay straight to silence, not an exponential tail gated by note length).

Two additions to the Tone tab's envelope:

1. A **shape** selector on the envelope: `ADSR` (current behavior, default)
   or `Falling Sine` (fast attack, then a sinusoidal decay to silence,
   one-shot — ignores note length, like a real drum hit).
2. **Draggable breakpoints** on the envelope overlay drawn over the static
   waveform view, so the shape can be sculpted by dragging instead of only
   via knobs.

## Data model

`TonePatch.env` gains an optional `shape` field:

```ts
env: { attack: number; decay: number; sustain: number; release: number; shape?: 'adsr' | 'fallingSine' };
```

`shape` omitted/undefined means `'adsr'` — existing projects load unchanged.

For `'fallingSine'`, only `attack` and `decay` are used (`decay` is the
sinusoidal fall-to-silence time). `sustain`/`release` are not read by
playback or the overlay for this shape, but their stored values are left
untouched so switching back to `'adsr'` doesn't lose them.

## Playback (`src/core/patch-voice.ts`)

Tone.js's `Envelope`/`AmplitudeEnvelope` already ships a `'sine'` curve type
for its release stage: a smooth S-shaped cosine fall
(`0.5 * (1 + cos(PI * k))`) from the current level to zero. We reuse that
instead of hand-rolling curve math.

For `shape === 'fallingSine'`, `PatchVoice` builds its `AmplitudeEnvelope`
with `{ attack, decay: 0.001, sustain: 1, release: decay, releaseCurve: 'sine' }`
(the knob-facing "Decay" becomes the envelope's internal `release` time).
`triggerAttack` additionally self-schedules `env.triggerRelease(t + attack)`
right after the attack fires, so the sinusoidal decay always plays in full
regardless of how long the note is held. The class's own `triggerRelease`
(called on note-off / scheduled note end) becomes a no-op for this shape —
timing is already fixed by the self-scheduled release. Oscillator/noise
stop scheduling is computed from the self-scheduled release time instead of
the external `triggerRelease` call.

`sampleHold` (`model.ts`) currently sizes the pre-release hold from
`patch.env.release`; for `'fallingSine'` it isn't used to gate anything, but
sample-render hold length switches to being based on `attack + decay` so a
one-shot render doesn't reserve time for an unused release tail.

## Envelope curve math (`src/core/envelope-curve.ts`, new)

`scope-view.ts` already imports `Tone` (for analyser types), so it can't be
unit tested per this repo's convention (Tone-importing modules don't run
under Vitest). The shape-aware level function and breakpoint math move to a
new Tone-free module so they stay testable:

- `envelopeLevel(env, t)` — shape-aware amplitude at time `t`:
  - `'adsr'` — unchanged existing curve (linear attack, exponential decay to
    sustain, held, exponential release).
  - `'fallingSine'` — linear attack to 1, then
    `0.5 * (1 + cos(PI * min(1, (t - attack) / decay)))` down to 0, flat at
    0 after `attack + decay`.
- `envelopeBreakpoints(env, seconds, holdSeconds, startAt)` — the
  draggable control points as `{ param, t, level }[]` in envelope
  coordinates (seconds / 0-1 level, not pixels):
  - `'adsr'`: `attack` (peak, time only), `decaySustain` (time = decay,
    level = sustain), `release` (end, time only, level fixed at 0)
  - `'fallingSine'`: `attack` (peak, time only), `decay` (end, time only,
    level fixed at 0)

## Envelope overlay (`src/modules/tone/scope-view.ts`)

`drawEnvelopeOverlay` calls `envelopeLevel` to draw the trace, and
`envelopeBreakpoints` to place the handles, converting each point's
time/level to canvas pixels with the same `x = (t/seconds)*w`,
`y = ((1-level)/2)*h` mapping already used for the trace. It returns the
pixel-space breakpoints (`{ param, x, y }[]`) so `tone-tab.ts` can hit-test
pointer events against them without duplicating the coordinate math.

## Dragging (`src/modules/tone/tone-tab.ts`)

`ToneTab` keeps the last-drawn breakpoints (recomputed every `redrawStatic`)
and attaches pointer handlers to the static time canvas once:

- `pointerdown` within ~8px of a breakpoint starts a drag, capturing the
  pointer and which param(s) it controls.
- `pointermove` inverts the canvas coordinate back to a time/level value
  (same math as the draw functions, inverted), clamps to the same min/max
  used by that parameter's knob, writes it to `patch.env`, updates the
  matching `<daw-knob>`'s `value` so the readout stays in sync, and calls
  `this.save()` (redraws immediately; audio re-renders debounced as usual).
  Horizontal movement changes the time parameter; vertical movement changes
  level, only meaningful for the ADSR decay/sustain corner.
- `pointerup` ends the drag.

Cursor changes to a grab affordance when hovering a breakpoint (cheap hit
test on `pointermove` while not dragging).

## UI

A `<select>` next to the envelope card title (`ADSR` / `Falling Sine`),
mirroring the existing filter-slope `<select>` pattern. Changing it sets
`patch.env.shape`, toggles the Sustain/Release knobs' visibility (hidden for
`'fallingSine'`), and calls `this.save()`.

## Testing

`src/core/envelope-curve.ts` (level function + breakpoint math for both
shapes) is pure and unit-tested directly. Playback behavior (self-scheduled
release, one-shot timing) and the drag interaction can't be unit-tested
(import Tone / need a live DOM+pointer); verify manually in the browser per
project convention.
