# Beats in the Arrangement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Place the Sample tab's named pad loops ("Beats") as resizable, repeat-tiling clips in the Arrangement, playing via direct event scheduling in both live playback and WAV export.

**Architecture:** A new `{ type: 'loop'; id }` variant of `ArrangeClipRef`; a pure `tileLoopEvents` helper tiles a Beat's `PadEvent`s across the clip span; `song-graph.ts` schedules each tiled event with the context-agnostic `playPadInto()` so live play and `Tone.Offline` export share one path. Events past the span edge are dropped whole (never truncated) — no clicks at repeat crossovers or the clip end.

**Tech Stack:** Vanilla TypeScript + Web Components, Tone.js, Vitest. Spec: `docs/superpowers/specs/2026-07-10-beats-in-arrangement-design.md`.

## Global Constraints

- Never import from `'tone'` directly — always `import * as Tone from '<path>/core/tone'` (only relevant if a new Tone-using file were added; none is).
- `src/core/model.ts` and `src/modules/arrange/timeline-math.ts` must stay free of Tone imports (they are unit-tested under Vitest).
- Strict TS: `noUnusedLocals`/`noUnusedParameters` are on; `npm run build` runs `tsc --noEmit`.
- No nested `Tone.Offline`: pad buffers for tone-linked pads must be ensured in the LIVE context (`resolveSong`), never inside `scheduleSong`.
- UI wording: the named pad loops are called **Beat/Beats** in all user-facing strings; type/field names (`PadLoop`, `padLoops`) are unchanged.
- Commit after each task; do NOT add AI attribution of any kind to commits.
- Unrelated uncommitted changes exist in the repo (Dockerfile, TODO.md, package.json, scripts/, ci/, projects/) — never `git add` them; always stage explicit paths.

---

### Task 1: Model — `'loop'` clip ref + `removeLoop`

**Files:**
- Modify: `src/core/model.ts` (ArrangeClipRef ~line 217, next to `removeSequence` ~line 336)
- Test: `src/core/model.test.ts`
- Modify: `src/modules/sample/sample-tab.ts` (Delete button handler ~line 889)

**Interfaces:**
- Produces: `ArrangeClipRef` variant `{ type: 'loop'; id: string }`; `removeLoop(data: ProjectData, id: string): void`. Later tasks rely on both.

- [ ] **Step 1: Write the failing test**

In `src/core/model.test.ts`, add `PadLoop` to the type import and `removeLoop` to the value import from `./model`, then add after the existing `removeSequence` describe block:

```ts
describe('removeLoop', () => {
  it('drops the Beat and any clips referencing it, keeping other clips', () => {
    const p = defaultProject();
    const beat: PadLoop = { id: uid(), name: 'Beat A', bars: 2, events: [{ pad: 0, time: 0 }] };
    const otherBeat: PadLoop = { id: uid(), name: 'Beat B', bars: 2, events: [] };
    p.padLoops.push(beat, otherBeat);
    p.arrangement.tracks.push({
      id: uid(),
      name: 'Track 1',
      gain: 1,
      plugins: [],
      clips: [
        { id: uid(), bar: 0, ref: { type: 'loop', id: beat.id }, gain: 1, plugins: [] },
        { id: uid(), bar: 4, ref: { type: 'loop', id: otherBeat.id }, gain: 1, plugins: [] },
        { id: uid(), bar: 8, ref: { type: 'pad', index: 0 }, gain: 1, plugins: [] },
      ],
    });
    // the new ref variant is part of the persistence format
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);

    removeLoop(p, beat.id);

    expect(p.padLoops.some((l) => l.id === beat.id)).toBe(false);
    expect(p.padLoops.some((l) => l.id === otherBeat.id)).toBe(true);
    const clips = p.arrangement.tracks[0].clips;
    expect(clips).toHaveLength(2);
    expect(clips.some((c) => c.ref.type === 'loop' && c.ref.id === beat.id)).toBe(false);
    expect(clips.some((c) => c.ref.type === 'loop' && c.ref.id === otherBeat.id)).toBe(true);
    expect(clips.some((c) => c.ref.type === 'pad')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/model.test.ts`
Expected: FAIL — `removeLoop` is not exported / `'loop'` is not assignable to `ArrangeClipRef`.

- [ ] **Step 3: Implement**

In `src/core/model.ts`, extend the union (keep the existing comment on the pad line):

```ts
export type ArrangeClipRef =
  | { type: 'sequence'; id: string }
  | { type: 'file'; file: string }
  | { type: 'pad'; index: number } // index into ProjectData.pads — pads have no id field
  | { type: 'loop'; id: string }; // PadLoop id — a named Beat from the Sample tab
```

Below `removeSequence`, add:

```ts
/** Remove a pad loop ("Beat") and every arrangement clip that references it. */
export function removeLoop(data: ProjectData, id: string): void {
  data.padLoops = data.padLoops.filter((l) => l.id !== id);
  for (const track of data.arrangement.tracks) {
    track.clips = track.clips.filter((clip) => !(clip.ref.type === 'loop' && clip.ref.id === id));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/model.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Wire the Sample tab's Delete button**

In `src/modules/sample/sample-tab.ts`, add `removeLoop` to the value import from `'../../core/model'` (the import currently reads `import { defaultLoop, defaultPatch, PAD_COUNT, sortedByName, toneBufferKey, uid } from '../../core/model';`). In the `'Delete sample'` icon-button handler (~line 889), replace

```ts
store.update((d) => (d.padLoops = d.padLoops.filter((l) => l.id !== loop.id)));
```

with

```ts
store.update((d) => removeLoop(d, loop.id));
```

Note this file uses `{ spaced }` import braces and arrow bodies like the surrounding code — match it.

- [ ] **Step 6: Verify types + full tests**

Run: `npm test` — expected: all pass.
Run: `npm run build` — expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/core/model.ts src/core/model.test.ts src/modules/sample/sample-tab.ts
git commit -m "Model: 'loop' arrange-clip ref and removeLoop purging a deleted Beat's clips"
```

---

### Task 2: Pure tiling math — `tileLoopEvents`

**Files:**
- Modify: `src/modules/arrange/timeline-math.ts`
- Test: `src/modules/arrange/timeline-math.test.ts`

**Interfaces:**
- Consumes: `PadEvent` from `src/core/model.ts` (`{ pad: number; time: number; duration?: number }`, `time` in beats from loop start).
- Produces: `interface TiledLoopEvent { pad: number; offsetBeats: number; duration?: number }` and `tileLoopEvents(events: PadEvent[], loopBeats: number, spanBeats: number): TiledLoopEvent[]`. Task 3 calls it.

- [ ] **Step 1: Write the failing tests**

In `src/modules/arrange/timeline-math.test.ts`, add to the imports from `./timeline-math`: `tileLoopEvents`. Add:

```ts
describe('tileLoopEvents', () => {
  const events = [
    { pad: 0, time: 0 },
    { pad: 1, time: 7.5, duration: 0.5 },
  ];

  it('repeats events across an exact multiple of the loop', () => {
    expect(tileLoopEvents(events, 8, 16)).toEqual([
      { pad: 0, offsetBeats: 0, duration: undefined },
      { pad: 1, offsetBeats: 7.5, duration: 0.5 },
      { pad: 0, offsetBeats: 8, duration: undefined },
      { pad: 1, offsetBeats: 15.5, duration: 0.5 },
    ]);
  });

  it('drops events past a fractional span edge instead of truncating', () => {
    // 2-bar loop stretched to 3 bars: second iteration's 7.5-beat hit (offset 15.5) is outside 12 beats
    expect(tileLoopEvents(events, 8, 12).map((t) => t.offsetBeats)).toEqual([0, 7.5, 8]);
  });

  it('keeps only events inside a span shorter than one loop', () => {
    expect(tileLoopEvents(events, 8, 4).map((t) => t.offsetBeats)).toEqual([0]);
  });

  it('returns nothing for empty events or a degenerate loop/span', () => {
    expect(tileLoopEvents([], 8, 16)).toEqual([]);
    expect(tileLoopEvents(events, 0, 16)).toEqual([]);
    expect(tileLoopEvents(events, 8, 0)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/arrange/timeline-math.test.ts`
Expected: FAIL — `tileLoopEvents` is not exported.

- [ ] **Step 3: Implement**

In `src/modules/arrange/timeline-math.ts` (Tone-free — a type-only import from model is fine), add:

```ts
import type { PadEvent } from '../../core/model';

export interface TiledLoopEvent {
  pad: number;
  offsetBeats: number;
  duration?: number;
}

/**
 * Tile a Beat's pad events across a clip span: iteration k shifts every
 * event by k*loopBeats. Events starting at/past the span edge are dropped
 * whole — never truncated — so hits keep their natural tails and repeat
 * crossovers stay click-free.
 */
export function tileLoopEvents(events: PadEvent[], loopBeats: number, spanBeats: number): TiledLoopEvent[] {
  if (loopBeats <= 0 || spanBeats <= 0) return [];
  const out: TiledLoopEvent[] = [];
  for (let k = 0; k * loopBeats < spanBeats - 1e-9; k++) {
    for (const ev of events) {
      const offsetBeats = k * loopBeats + ev.time;
      if (offsetBeats < spanBeats - 1e-9) out.push({ pad: ev.pad, offsetBeats, duration: ev.duration });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/arrange/timeline-math.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/arrange/timeline-math.ts src/modules/arrange/timeline-math.test.ts
git commit -m "Arrange: tileLoopEvents tiles a Beat's events across a clip span, dropping edge hits whole"
```

---

### Task 3: Scheduling — song-graph plays loop clips

**Files:**
- Modify: `src/modules/arrange/song-graph.ts`

**Interfaces:**
- Consumes: `tileLoopEvents` (Task 2), `removeLoop`-compatible ref variant (Task 1), existing `playPadInto(pad, dest, time?, durationBeats?)` and `ensurePadBuffers(pads)` from `src/core/pad-voice.ts`.
- Produces: `clipBars` returns a loop's `bars` for `'loop'` refs (the Arrange tab draws clip widths from this via `clipSpanBars`); `scheduleSong` plays loop clips.

- [ ] **Step 1: `clipBars` loop case**

In `src/modules/arrange/song-graph.ts`, `clipBars()` (~line 10), add after the `'sequence'` branch:

```ts
  if (ref.type === 'loop') {
    return store.data.padLoops.find((l) => l.id === ref.id)?.bars ?? 1;
  }
```

- [ ] **Step 2: `resolveSong` ensures pad buffers for loop clips**

Extend the pad-voice import (line 4) to `import { ensurePadBuffers, padBuffer, padSeconds, playPadInto } from '../../core/pad-voice';` and add as the FIRST statement of `resolveSong()` (~line 45):

```ts
  // tone-linked pads render in the LIVE context here — never inside Tone.Offline
  if (tracks.some((t) => t.clips.some((c) => c.ref.type === 'loop'))) {
    await ensurePadBuffers(store.data.pads);
  }
```

(`'loop'` refs need no entry in `ResolvedSong` — `playPadInto` reads the store's buffer cache synchronously at schedule time.)

- [ ] **Step 3: `scheduleSong` loop branch**

Add `tileLoopEvents` to the existing `./timeline-math` import if one exists, otherwise add `import { tileLoopEvents } from './timeline-math';`. In the clip loop (~line 112), insert a branch between the `'sequence'` case and the buffer `else`:

```ts
      } else if (clip.ref.type === 'loop') {
        const loop = store.data.padLoops.find((l) => l.id === (clip.ref as { id: string }).id);
        if (!loop) continue;
        const secondsPerBeat = opts.barSeconds / 4;
        const spanBeats = (clip.bars ?? loop.bars) * 4;
        for (const ev of tileLoopEvents(loop.events, loop.bars * 4, spanBeats)) {
          const pad = store.data.pads[ev.pad];
          if (!pad) continue;
          const src = playPadInto(pad, clipBus, at + 0.01 + ev.offsetBeats * secondsPerBeat, ev.duration);
          if (src) sources.push(src);
        }
      } else {
```

`playPadInto`'s signature is `(pad, dest, time?, durationBeats?)`; the `+ 0.01` matches the offset the buffer-clip branch already uses. The returned sources join the existing `sources` array, so the handle's `dispose()` stops them on user stop; `playPadInto`'s own `onended` cleanup plus the existing try/catch make the double-dispose safe.

- [ ] **Step 4: Verify types + tests**

Run: `npm run build` — expected: clean.
Run: `npm test` — expected: all pass (song-graph has no unit tests; this catches type/regression fallout).

- [ ] **Step 5: Commit**

```bash
git add src/modules/arrange/song-graph.ts
git commit -m "Arrange: schedule Beat clips by tiling pad events through playPadInto, live and offline"
```

---

### Task 4: Arrange UI — Beats palette group, label, color

**Files:**
- Modify: `src/modules/arrange/arrange-tab.ts` (clipLabel ~line 198, palette build ~line 545, placement handler ~line 755)
- Modify: `src/style.css` (`:root` arrange block ~line 828, clip colors ~line 962)

**Interfaces:**
- Consumes: `'loop'` ref variant (Task 1); `clipBars` loop case (Task 3) already sizes the clip via `clipSpanBars`.

- [ ] **Step 1: Clip label**

In `clipLabel()`, add after the `'sequence'` line:

```ts
    if (ref.type === 'loop') return store.data.padLoops.find((l) => l.id === ref.id)?.name ?? '?';
```

- [ ] **Step 2: Palette group**

In `render()` where the palette optgroups are built, add directly after the Sequences `for` loop (after `seqGroup.appendChild(opt);`'s closing brace):

```ts
    const beatGroup = group('Beats');
    for (const l of store.data.padLoops) {
      const opt = document.createElement('option');
      opt.value = `loop:${l.id}`;
      opt.textContent = l.name;
      opt.selected = this.palette === opt.value;
      beatGroup.appendChild(opt);
    }
```

- [ ] **Step 3: Placement mapping**

In the row `onclick` handler, replace the ref ternary with:

```ts
      const ref = this.palette.startsWith('seq:')
        ? { type: 'sequence' as const, id: this.palette.slice(4) }
        : this.palette.startsWith('loop:')
          ? { type: 'loop' as const, id: this.palette.slice(5) }
          : this.palette.startsWith('pad:')
            ? { type: 'pad' as const, index: Number(this.palette.slice(4)) }
            : { type: 'file' as const, file: this.palette.slice(5) };
```

No other arrange-tab changes: `buildClip` already derives the CSS class from `ref.type` (yielding `loop`), and the resize handle condition `ref.type !== 'sequence'` already grants loop clips the handle, whose drag writes the `clip.bars` override Task 3 interprets as repeats.

- [ ] **Step 4: Clip color**

In `src/style.css`: in the `/* ---- arrange ---- */` `:root` block (~line 828), add `--accent-4: #ed64a6;` under `--accent-3`. After the `.arrange-clip.file` rule (~line 962), add:

```css
.arrange-clip.loop {
  background: var(--accent-4);
}
```

- [ ] **Step 5: Verify**

Run: `npm run build` — expected: clean.
Run: `npm test` — expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/modules/arrange/arrange-tab.ts src/style.css
git commit -m "Arrange: Beats palette group places resizable loop clips with their own color"
```

---

### Task 5: Sample tab wording — "Beat"

**Files:**
- Modify: `src/modules/sample/sample-tab.ts`

**Interfaces:** none (string-only changes; `PadLoop`/`padLoops` identifiers unchanged).

- [ ] **Step 1: Rename user-facing strings**

All in `src/modules/sample/sample-tab.ts` (line numbers approximate):

| Line | Old | New |
|---|---|---|
| 652 | `` `${file.name}: not a sample` `` | `` `${file.name}: not a Beat` `` |
| 655 | fallback `\|\| 'Sample'` | `\|\| 'Beat'` |
| 659 | `` `A sample named "${name}" already exists.\n…` `` | `` `A Beat named "${name}" already exists.\n…` `` (rest unchanged) |
| 663 | `prompt('New sample name', suggestion)` | `prompt('New Beat name', suggestion)` |
| 781 | `loopSel.title = 'Switch sample'` | `loopSel.title = 'Switch Beat'` |
| 848 | `'Download this sample as .wav + .json (drop the .json back in to import)'` | `'Download this Beat as .wav + .json (drop the .json back in to import)'` |
| 857 | `'New sample'` | `'New Beat'` |
| 863 | `` uniqueName(`Loop ${store.data.padLoops.length + 1}`, …) `` | `` uniqueName(`Beat ${store.data.padLoops.length + 1}`, …) `` |
| 873 | `'Rename sample'` | `'Rename Beat'` |
| 877 | `prompt('Sample name', loop.name)` | `prompt('Beat name', loop.name)` |
| 886 | `'Delete sample'` | `'Delete Beat'` |

Do NOT change: `'Play the loop (Space)'` / `'Stop the loop (Space)'` (transport wording, per spec), the `SampleFile`/`format: 'webdaw-sample'` identifiers (file format, not UI copy), `defaultLoop()`'s `'Loop 1'` in `model.ts` (shared default, out of scope), or any `sample.` UI-state keys.

- [ ] **Step 2: Verify**

Run: `npm run build` — expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/modules/sample/sample-tab.ts
git commit -m "Sample tab: name the pad loops \"Beats\" in all user-facing copy"
```

---

### Task 6: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full suite + build**

Run: `npm test` and `npm run build` — expected: all pass, clean build.

- [ ] **Step 2: Manual browser check**

Start `npm run dev`, open in Chrome:
1. Sample tab: confirm "Beat" wording (New/Rename/Delete/Switch tooltips); create a Beat with a few pad hits across 2 bars, including one on the last 16th.
2. Arrange tab: palette shows a **Beats** group; pick the Beat, click a lane — clip appears with the Beat's name, pink (`--accent-4`), spanning the loop's bars.
3. Play: the Beat sounds identical to the Sample tab's loop playback.
4. Resize the clip to 2× width: plays twice; listen at the crossover for the last-16th hit's tail ringing into the repeat (no click, no chopped decay).
5. Resize to 1.5×: the second repeat cuts off cleanly after its last in-span hit (later hits dropped whole).
6. Delete the Beat in the Sample tab: its arrangement clips disappear (removeLoop).
7. Export WAV (arrange export button) and listen: same result offline.

- [ ] **Step 3: Audio smoke script (optional but cheap)**

With the dev server on port 5199: `node scripts/audio-smoke.mjs` — expected: passes (no pre-gesture AudioContext; audio flows after gesture).
