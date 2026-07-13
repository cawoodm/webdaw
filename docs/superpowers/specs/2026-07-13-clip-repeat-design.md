# Clip Repeat on Stretch — Design

**Date:** 2026-07-13
**Status:** Approved

## Problem

Resizing an Arrange clip longer than its natural length currently leaves silence after the source ends (sample/file, pad, and sequence clips play once; `song-graph.ts` only trims). Beat (loop) clips already tile via `tileLoopEvents`. Stretched clips should repeat their content until the clip span ends, for all clip types.

## Model

New optional persisted field on `ArrangeClip` (`src/core/model.ts`):

```ts
loopMode?: 'gapless' | 'bar' | 'resample';
```

- Absent = `'gapless'` (the default). No `normalizeProject()` backfill needed.
- Must survive a JSON round-trip (extend the existing model test).

`loopMode` only affects playback when the clip's span override (`clip.bars`) exceeds the natural length derived from its ref. Spans at or below natural length keep today's trim behavior exactly.

## Playback semantics

All scheduling changes live in `src/modules/arrange/song-graph.ts` (`scheduleSong`), which is shared by live playback and WAV export — both stay consistent automatically.

### Sequence clips

Tile the sequence's events every `sequence.bars` bars across the clip span, with the same edge rule as Beats: an event starting at/past the span edge is dropped whole, never truncated. Repeats are always bar-exact, so `loopMode` does not apply to sequence clips (nor to Beat clips, which keep their existing tiling).

### Audio clips (file and pad refs), span > natural length

Let `duration` be the buffer's seconds and `barSeconds` the current bar length.

- **`gapless`** (default): one `ToneBufferSource` with `loop = true`, `loopEnd = duration`, stopped at span end. A tape loop — seamless, but repeats drift off the bar grid.
- **`bar`**: one source per repetition, started at `k × naturalBars × barSeconds` within the clip (`naturalBars = max(1, ceil(duration / barSeconds))`, same rounding as `clipBars`). The final repetition is cut at the span end. Silent gap between the buffer end and the next bar-aligned repeat.
- **`resample`**: `playbackRate = duration / (targetBars × barSeconds)` with `targetBars = max(1, round(duration / barSeconds))`, then `loop = true` with the stretched period, stopped at span end. Bar-aligned *and* gapless; pitch shifts as a consequence.

### Play-cursor start inside a stretched clip (`skipBeats > 0`)

- `gapless` / `resample`: start the looping source now with buffer `offset = skipSeconds % loopPeriodSeconds` (where `loopPeriodSeconds` is `duration`, divided by `playbackRate` for resample).
- `bar`: skip whole past repetitions; offset into the current one; schedule the remaining repetitions normally.

## UI

Clip FX dialog (`arrange-tab.ts`): a "Repeat" `<select>` (Back-to-back / Bar-aligned / Re-sample) beside the clip gain knob, shown only for file/pad clips. Writes `clip.loopMode` via `store.update`. No prompt when stretching; no repeat-boundary visuals on clips (possible later).

## Pure math + testing

New pure helpers in `src/modules/arrange/timeline-math.ts`, unit-tested with Vitest:

- repeat start times for `bar` mode given duration, barSeconds, span;
- resample `playbackRate` / `targetBars`;
- cursor offset per mode given `skipBeats`;
- sequence tiling reuses/generalizes `tileLoopEvents`.

`song-graph.ts` stays thin and untestable-in-Node as before. Model round-trip test extended for `loopMode`. Audible behavior (looping, resample pitch, export parity) verified manually in the browser.

## Out of scope

- Repeat-boundary tick marks on clip visuals.
- Time-stretch without pitch change (resample is plain playback-rate).
- Per-stretch prompts or global default settings.
