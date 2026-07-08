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
3. Add a checkbox to disable the envelope, Pitch Env.
4. Add phase shift to LFOs -180 to +180
5. Ensure the amp/time vizualisation starts at t=0, x=0 no margin on the left, show time vertical gridlines with ms
6. Make attack knob more fine-grained

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

`env` also gains `on?: boolean` (default on, matching the existing
`hpfOn`/`lpfOn`/LFO `on` convention). `PitchEnv` gains the same `on?:
boolean` field. `LfoConfig` gains `phase?: number` — the LFO's starting
phase in degrees, `-180..180`, default `0`.

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

**Envelope off (`env.on === false`):** the voice should act like a flat
gate — instantly full volume on note-on, instantly silent on note-off/note-
end, no attack/decay/sustain/release shaping at all. Rather than bypassing
the `AmplitudeEnvelope` node (which would mean restructuring the audio
graph per-toggle), `PatchVoice` builds it with forced instant times
(`{ attack: 0.001, decay: 0.001, sustain: 1, release: 0.001 }`) when off,
regardless of shape or the stored attack/decay/sustain/release values —
those stay untouched in the model for when the envelope is switched back
on. `releaseSeconds` (used to time oscillator/noise stop) follows the same
0.001s when off.

**Pitch Env off (`pitchEnv.on === false`):** `triggerAttack`'s existing
`if (this.pitchEnv && this.pitchEnv.amount > 0)` gate gains `&&
this.pitchEnv.on !== false`, matching the `on !== false` convention already
used for the LFOs.

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

## LFO phase (`src/core/patch-voice.ts`, `model.ts`)

`LfoConfig.phase` (degrees, `-180..180`, default `0`) is applied to
`Tone.LFO.phase`, which itself expects `0..360`; `PatchVoice` normalizes
with `((phase % 360) + 360) % 360` when constructing `lfoPitch`/`lfoVolume`.
`drawLfoOverlay` (`scope-view.ts`) takes the same phase into account so the
preview trace matches actual playback:
`Math.sin(2*PI*rate*(t-startAt) + phase*PI/180)`.

## Time-axis alignment + adaptive gridlines (`src/modules/tone/scope-view.ts`, `src/core/patch-voice.ts`)

`renderPatch` currently triggers the note at `t = 0.01` inside the offline
render (a small pre-roll), which both `drawEnvelopeOverlay` and
`drawLfoOverlay` mirror via a `startAt = 0.01` default. This is removed:
`renderPatch` triggers at `t = 0`, and `startAt` defaults to `0` in both
overlay functions, so the rendered audio, the waveform trace, and the
envelope/LFO overlays all start exactly at `x = 0`.

`drawWaveformStatic`'s fixed `tickEvery = 0.25` (seconds) gridline spacing
is replaced with an adaptive tick picked from a "nice" set
(`1, 2, 5, 10, 20, 50, 100, 200, 500ms`, then whole seconds beyond that)
sized to put roughly 4-8 gridlines across the view for the current
`sampleSeconds` — short kick renders (e.g. 200ms) get ms-scale ticks, long
pad renders still get sane second-scale ticks. Labels read `"Nms"` below 1s
and `"N.Ns"` at/above 1s. This tick-picking is pure (no Tone import) and
lives in `src/core/envelope-curve.ts` alongside the other new pure math so
it stays unit-testable.

## Attack knob resolution (`src/modules/tone/tone-tab.ts`)

The Attack knob switches to `log: true` (same scaling already used for the
Pitch Env / Filter Env "Time" knobs) and its step tightens from `0.01` to
`0.001`, giving fine drag resolution near 1ms where kick-drum attacks live
instead of spending most of the drag range above 0.2s.

## UI

- A `<select>` next to the envelope card title (`ADSR` / `Falling Sine`),
  mirroring the existing filter-slope `<select>` pattern. Changing it sets
  `patch.env.shape`, toggles the Sustain/Release knobs' visibility (hidden
  for `'fallingSine'`), and calls `this.save()`.
- An on/off checkbox (the existing `onToggle` helper used by LFO/HPF/LPF)
  is added to the Envelope card head (`env.on`) and the Pitch Env card head
  (`pitchEnv.on`). As with the existing toggles, the knobs stay visible and
  interactive when off — only playback behavior changes.
- Both LFO cards (Pitch LFO, Vol LFO) get a new "Phase" knob
  (`min: -180, max: 180, step: 1, unit: '°'`), alongside the existing
  Rate/Depth knobs.

## Testing

`src/core/envelope-curve.ts` (level function, breakpoint math, and adaptive
gridline tick picking) is pure and unit-tested directly. Playback behavior
(self-scheduled release, one-shot timing, envelope/pitch-env on-off, LFO
phase) and the drag interaction can't be unit-tested (import Tone / need a
live DOM+pointer); verify manually in the browser per project convention.
