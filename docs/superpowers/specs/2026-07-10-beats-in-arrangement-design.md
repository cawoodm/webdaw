# Beats in the Arrangement — Design

Date: 2026-07-10

## Goal

The Sample tab's named pad loops (`PadLoop` — called **Beats** in the UI from
now on) can be placed as clips in the Arrangement, alongside sequences, pads,
and files. A Beat clip plays its pad events exactly as the Sample tab does
live, can be resized to repeat, and works in both live playback and WAV
export.

## Model (`src/core/model.ts`)

`ArrangeClipRef` gains a fourth variant:

```ts
| { type: 'loop'; id: string } // PadLoop id
```

New helper `removeLoop(data: ProjectData, id: string): void`, mirroring
`removeSequence`: drops the loop from `data.padLoops` and removes every
arrangement clip whose ref is `{ type: 'loop', id }`. The Sample tab's
Delete button calls it instead of its current inline filter, so deleting a
Beat can't leave dangling clips.

## Scheduling (`src/modules/arrange/song-graph.ts`)

**Approach: direct event scheduling** (not pre-rendering the loop to a
buffer). Each `PadEvent` in the Beat is scheduled individually via the
existing context-agnostic `playPadInto()`, so live playback and
`Tone.Offline` export share the code path. Chosen over a pre-rendered
looping buffer specifically for the repeat crossover: independent sources
let a hit's tail ring naturally across the loop boundary into the next
repeat (identical to the Sample tab's live behavior), whereas a looped
buffer hard-truncates the tail at the buffer edge — a click plus lost decay
on every wrap.

- `clipBars`: for `'loop'` refs, the loop's `bars` (`?? 1` when the id
  doesn't resolve).
- `resolveSong`: when any clip has a `'loop'` ref, call
  `ensurePadBuffers(store.data.pads)` once — tone-linked pads render in the
  LIVE context here, respecting the no-nested-`Tone.Offline` rule. No
  per-clip entry in `ResolvedSong` is needed; `playPadInto` reads the
  store's buffer cache synchronously at schedule time.
- `scheduleSong`, `'loop'` branch: span = `clip.bars ?? loop.bars`. Tile
  the loop's events across the span: for iteration `k = 0..ceil(span /
  loop.bars) - 1`, each event whose offset `k * loopBeats + event.time`
  falls inside `span * 4` beats is scheduled at
  `at + offset * secondsPerBeat` (where `secondsPerBeat = barSeconds / 4`)
  into the clip bus, honoring `event.duration`. Events are dropped —
  not truncated — at the span edge; a sounding tail may ring past it.
  Sources returned by `playPadInto` are collected into the handle's
  `dispose()`. Unresolvable loop ids or empty/missing pads schedule
  nothing, consistent with the other ref types.

The tiling math (`tileLoopEvents(events, loopBeats, spanBeats)` returning
`{ pad, offsetBeats, duration? }[]`) lives in the existing Tone-free
`src/modules/arrange/timeline-math.ts` so it is unit-testable.

### Clip-end behavior

A hit whose *sample tail* extends past the clip's final span edge is left
to ring (matching live behavior). Because events past the edge are dropped
whole and sounding tails are never truncated, there is no hard cut anywhere
in a Beat clip — hence no click and no fade-out machinery. A resized Beat
clip's audio may extend slightly past its visual right edge — accepted,
it's how the Sample tab already sounds. (The existing hard `stop()` click
on resized pad/file clips is a pre-existing issue, out of scope here.)

## Arrange tab UI (`src/modules/arrange/arrange-tab.ts`)

- Palette: new **Beats** optgroup between Sequences and Pads, options
  `loop:<id>` labeled with the loop's name. The row-click placement handler
  maps the `loop:` prefix to `{ type: 'loop', id }`. The stale-palette
  guard added previously covers stale Beat ids automatically.
- `clipLabel`: `'loop'` refs resolve the name from `store.data.padLoops`,
  `'?'` fallback.
- `buildClip`: loop clips get the `clip-resize` handle (same as pad/file
  clips) — dragging sets the `clip.bars` override, which the scheduler
  interprets as repeats. New CSS class `loop` on the clip element with its
  own color in `src/style.css`.

## Sample tab naming (`src/modules/sample/sample-tab.ts`)

User-facing strings adopt **Beat**: "Delete sample" → "Delete Beat",
"Sample name" → "Beat name", default names `Loop N` → `Beat N`, import
prompts ("A sample named …") likewise. Type and field names (`PadLoop`,
`padLoops`) are unchanged — this is UI wording only. The tab's own
play/record wording ("Play the loop") stays, since there it means the
looping transport, not the named object.

## Testing

- `removeLoop`: unit test in `model.test.ts` (drops the loop, purges only
  its clips — same shape as the `removeSequence` test).
- `tileLoopEvents`: unit tests — exact multiple (2 bars stretched to 4 =
  every event twice), fractional span (events past the edge dropped, not
  truncated), span shorter than one loop, empty events.
- JSON round-trip of a project containing a `'loop'` clip ref (existing
  round-trip test covers `ProjectData` — extend its fixture).
- Playback and export verified manually in the browser (place a Beat,
  resize to 2×, listen at the crossover; export WAV and inspect).
