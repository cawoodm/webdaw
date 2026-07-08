# Arrange Tab Phase A: Data Model + Unified Audio Graph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Arrange tab correct, unified audio behavior — pad segments, per-clip volume/effects, track mute/solo, and a live-playback Master FX chain that actually matches what WAV export produces — without touching the timeline UI (the existing click-to-place/click-to-delete grid keeps working; the full timeline rewrite is a separate follow-on plan, "Phase B").

**Architecture:** `ArrangeClip` gains a `'pad'` ref variant plus `gain`/`plugins`; `ArrangeTrack` gains `muted`/`solo`. Pad playback logic is extracted out of `sample-tab.ts`'s private methods into a shared `src/core/pad-voice.ts` (mirroring how Tone-patch playback already lives in `core/patch-voice.ts`, separate from `tone-tab.ts`). A new `src/modules/arrange/song-graph.ts` module builds the whole song's audio graph in **one shared function** consumed by both live `play()` and offline `exportSong()`, so mute/solo/clip-volume/clip-FX can never drift between the two paths the way Master FX already has today. Master FX itself gets fixed to bind eagerly instead of only-on-first-dialog-open.

**Tech Stack:** TypeScript, Vite, Tone.js (via `src/core/tone.ts` shim — never `'tone'` directly), Vitest.

## Global Constraints

- `npm run build` runs `tsc --noEmit` with `noUnusedLocals`/`noUnusedParameters` on — every task must build clean.
- Any module importing Tone (directly or transitively — `store` from `project-store.ts` imports Tone) can't run under Vitest. `song-graph.ts` and `pad-voice.ts` both need `store`, so neither has unit tests — this matches the existing precedent of `patch-voice.ts` and `arrange-tab.ts` today, both untested, verified manually in the browser. Only pure, store-free additions (`isTrackAudible`, `clampClipBar` in `model.ts`) get unit tests.
- New persisted fields (`ArrangeClip.gain`/`.plugins`, `ArrangeTrack.muted`/`.solo`) must be optional-or-backfilled and survive a JSON round-trip; `normalizeProject()` backfills old clips so every downstream consumer can assume `gain`/`plugins` always exist — no defensive `?? 1` scattered through audio code.
- This phase does **not** touch the FX-chain UI (`openFx`, the inline `<plugin-chain>` toggle panel) — that becomes a single shared dialog in Phase B. For now, every clip's effects are applied via the stateless `connectChain()` (no persistent per-clip UI/audio node), since there's no UI yet to "open" a clip's FX editor.
- Follow existing patterns exactly: `ToneLayer.muted?`/`.solo?` + "when any unmuted layer is soloed, only soloed layers sound" (`src/core/patch-voice.ts`) for mute/solo semantics/wording; the `liveChains`-style memoized `{inGain, chain}` pattern for persistent per-track audio nodes.

---

## File Structure

- **Modify** `src/core/model.ts` — `ArrangeClipRef` (+ `'pad'`), `ArrangeClip.gain`/`.plugins`, `ArrangeTrack.muted`/`.solo`, `MAX_BARS`, `isTrackAudible()`, `clampClipBar()`, `normalizeProject()` backfill.
- **Create** `src/core/pad-voice.ts` — `padBuffer()`, `padSeconds()`, `playPadInto()`, `ensurePadBuffers()`, extracted from `sample-tab.ts`.
- **Modify** `src/modules/sample/sample-tab.ts` — delegates to `pad-voice.ts`; pad drag/swap remaps `'pad'`-ref arrangement clips.
- **Modify** `src/modules/sequence/sequence-playback.ts` — `scheduleSequenceAt()` returns a disposable handle instead of `void`.
- **Create** `src/modules/arrange/song-graph.ts` — `clipBars()`, `songBars()`, `resolveSong()`, `NodeProvider`, `createOfflineProvider()`, `scheduleSong()`.
- **Modify** `src/shell/app-shell.ts` — Master FX chain binds eagerly (fixes the live/export inconsistency).
- **Modify** `src/modules/arrange/arrange-tab.ts` — `play()`/`exportSong()` become thin `song-graph.ts` callers; adds mute/solo buttons and pad entries in the palette (minimal UI needed to exercise the new audio capabilities; the full timeline redesign is Phase B).

---

## Task 1: Model — pad clip ref, clip volume/effects, track mute/solo, MAX_BARS

**Files:**
- Modify: `src/core/model.ts:217-229` (`ArrangeClip`/`ArrangeTrack`), `src/core/model.ts:260-261` (constants), `src/core/model.ts:306-336` (`normalizeProject`)
- Test: `src/core/model.test.ts`

**Interfaces:**
- Produces: `ArrangeClipRef` (exported union type), `MAX_BARS = 800`, `isTrackAudible(track: ArrangeTrack, allTracks: ArrangeTrack[]): boolean`, `clampClipBar(bar: number, spanBars: number): number`. Consumed by `song-graph.ts` and `arrange-tab.ts` in later tasks.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/model.test.ts`, inside `describe('project model', ...)` (after the `'defaults savedAt to 0...'` test):

```ts
  it('backfills gain/plugins on arrangement clips predating those fields', () => {
    const stale = JSON.parse(
      JSON.stringify({
        ...defaultProject(),
        arrangement: {
          tracks: [
            {
              id: 't1',
              name: 'Track 1',
              gain: 0.9,
              plugins: [],
              clips: [{ id: 'c1', bar: 0, ref: { type: 'file', file: 'samples/x.wav' } }],
            },
          ],
          masterPlugins: [],
        },
      }),
    );
    const normalized = normalizeProject(stale);
    expect(normalized.arrangement.tracks[0].clips[0].gain).toBe(1);
    expect(normalized.arrangement.tracks[0].clips[0].plugins).toEqual([]);
  });

  it('a track/clip with mute, solo, pad ref, and clip effects survives a JSON round-trip', () => {
    const p = defaultProject();
    p.arrangement.tracks.push({
      id: uid(),
      name: 'Drums',
      gain: 0.9,
      muted: true,
      solo: false,
      plugins: [{ id: uid(), pluginId: 'reverb', state: { decay: 2, wet: 0.3 }, bypassed: false }],
      clips: [
        {
          id: uid(),
          bar: 4,
          ref: { type: 'pad', index: 2 },
          gain: 0.8,
          plugins: [{ id: uid(), pluginId: 'delay', state: { delayTime: 0.25, feedback: 0.4, wet: 0.3 }, bypassed: false }],
        },
      ],
    });
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
```

Add a new top-level `describe` block at the end of the file:

```ts
describe('isTrackAudible', () => {
  const track = (overrides: Partial<{ muted: boolean; solo: boolean }> = {}) => ({
    id: uid(),
    name: 'T',
    gain: 1,
    plugins: [],
    clips: [],
    ...overrides,
  });

  it('is audible with no mute/solo on any track', () => {
    const a = track();
    expect(isTrackAudible(a, [a])).toBe(true);
  });

  it('a muted track is never audible', () => {
    const a = track({ muted: true });
    expect(isTrackAudible(a, [a])).toBe(false);
  });

  it('when any track is soloed, only soloed tracks are audible', () => {
    const a = track({ solo: true });
    const b = track();
    expect(isTrackAudible(a, [a, b])).toBe(true);
    expect(isTrackAudible(b, [a, b])).toBe(false);
  });

  it('a muted-and-soloed track is still silent', () => {
    const a = track({ solo: true, muted: true });
    const b = track();
    expect(isTrackAudible(a, [a, b])).toBe(false);
    expect(isTrackAudible(b, [a, b])).toBe(true); // no OTHER unmuted solo, so b plays
  });
});

describe('clampClipBar', () => {
  it('leaves an in-range placement unchanged', () => {
    expect(clampClipBar(10, 4)).toBe(10);
  });

  it('clamps so bar + span never exceeds MAX_BARS', () => {
    expect(clampClipBar(799, 4)).toBe(MAX_BARS - 4);
  });

  it('never goes negative', () => {
    expect(clampClipBar(-5, 4)).toBe(0);
  });
});
```

Update the test file's import line:

```ts
import {
  clampClipBar,
  defaultLfo,
  defaultPatch,
  defaultProject,
  envelopeTailSeconds,
  isTrackAudible,
  MAX_BARS,
  normalizeProject,
  PAD_COUNT,
  pianoNotes,
  resolveLfos,
  uid,
} from './model';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/model.test.ts`
Expected: FAIL — `isTrackAudible`/`clampClipBar`/`MAX_BARS` not exported; the pad/mute/solo/clip-gain round-trip test fails type-check-adjacent (the object literal won't match the current narrower types) or fails at the backfill assertion (`gain`/`plugins` are `undefined`, not `1`/`[]`).

- [ ] **Step 3: Update the types and add the constant + helpers**

Change `src/core/model.ts:217-229`:

```ts
export type ArrangeClipRef =
  | { type: 'sequence'; id: string }
  | { type: 'file'; file: string }
  | { type: 'pad'; index: number }; // index into ProjectData.pads — pads have no id field

export interface ArrangeClip {
  id: string;
  bar: number;
  ref: ArrangeClipRef;
  gain: number; // clip volume trim, same convention as ArrangeTrack.gain
  plugins: PluginInstanceState[]; // per-clip FX chain, same shape as ArrangeTrack.plugins
}

export interface ArrangeTrack {
  id: string;
  name: string;
  gain: number;
  muted?: boolean; // undefined = not muted (older projects)
  /** Solo: when any unmuted track is soloed, only soloed tracks play. */
  solo?: boolean;
  plugins: PluginInstanceState[];
  clips: ArrangeClip[];
}
```

Change `src/core/model.ts:260-261`:

```ts
export const PAD_COUNT = 16;
export const STEPS_PER_BAR = 16;
export const MAX_BARS = 800;
```

Add, right after `MAX_BARS` (or anywhere below the `ArrangeTrack`/`ArrangeClip` definitions — placement doesn't matter, just keep it near the types it operates on):

```ts
/**
 * True when `track` should be audible: muted tracks never play; when any
 * unmuted track is soloed, only soloed tracks play.
 */
export function isTrackAudible(track: ArrangeTrack, allTracks: ArrangeTrack[]): boolean {
  if (track.muted) return false;
  const anySolo = allTracks.some((t) => t.solo && !t.muted);
  return !anySolo || !!track.solo;
}

/** Clamp a clip placement so it never starts before 0 or spans past MAX_BARS. */
export function clampClipBar(bar: number, spanBars: number): number {
  return Math.max(0, Math.min(bar, MAX_BARS - spanBars));
}
```

- [ ] **Step 4: Backfill old clips in `normalizeProject`**

Change `src/core/model.ts:306-307` (the start of `normalizeProject`):

```ts
export function normalizeProject(data: ProjectData): ProjectData {
  data.savedAt ??= 0;
  for (const track of data.arrangement.tracks) {
    for (const clip of track.clips) {
      clip.gain ??= 1;
      clip.plugins ??= [];
    }
  }
```

(leave the rest of the function body unchanged)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/core/model.test.ts`
Expected: PASS (all cases, including the new ones)

- [ ] **Step 6: Type-check the whole project**

Run: `npm run build`
Expected: FAILS — `src/modules/arrange/arrange-tab.ts` still constructs `ArrangeClip` object literals without `gain`/`plugins` (in its `+ Track`... actually the "cell.onclick" placement handler) and narrows `ref` with the old inline union type in `clipBars`/`resolveClips`. This is expected and fixed in Task 6 — confirm the errors are exactly there (in `arrange-tab.ts`, not elsewhere) before moving on.

- [ ] **Step 7: Commit**

```bash
git add src/core/model.ts src/core/model.test.ts
git commit -m "Add pad clip refs, clip volume/effects, and track mute/solo to the arrangement model"
```

---

## Task 2: Extract pad playback into `core/pad-voice.ts`

**Files:**
- Create: `src/core/pad-voice.ts`
- Modify: `src/modules/sample/sample-tab.ts:178-235` (delegates), `src/modules/sample/sample-tab.ts:993-1002` (pad-swap remap)

**Interfaces:**
- Produces: `padBuffer(pad: PadConfig): AudioBuffer | null`, `padSeconds(pad: PadConfig): number | undefined`, `playPadInto(pad: PadConfig, dest: Tone.ToneAudioNode, time?: number, durationBeats?: number): Tone.ToneBufferSource | null`, `ensurePadBuffers(pads: (PadConfig | null)[]): Promise<boolean>`. Consumed by `song-graph.ts` in Task 4.
- No unit tests — imports Tone via `./tone` and `store` from `project-store.ts` (which itself imports Tone), matching the untested-and-manually-verified precedent already set by `core/patch-voice.ts`.

- [ ] **Step 1: Create `pad-voice.ts`**

Create `src/core/pad-voice.ts`:

```ts
import * as Tone from './tone';
import { engine } from './audio-engine';
import { renderPatch } from './patch-voice';
import { store } from './project-store';
import type { PadConfig } from './model';
import { toneBufferKey } from './model';

/** Resolve a pad's current playable buffer: linked tone patch render, or its own file. */
export function padBuffer(pad: PadConfig): AudioBuffer | null {
  if (pad.toneId) return store.getBuffer(toneBufferKey(pad.toneId));
  return pad.file ? store.getBuffer(pad.file) : null;
}

/** A pad's trimmed sample length in seconds, when its buffer is known. */
export function padSeconds(pad: PadConfig): number | undefined {
  const buffer = padBuffer(pad);
  if (!buffer) return undefined;
  const end = pad.trimEnd > 0 ? Math.min(pad.trimEnd, buffer.duration) : buffer.duration;
  return Math.max(0.01, end - pad.trimStart);
}

/**
 * Play a pad's buffer (trim applied) into `dest`, in the ACTIVE Tone context —
 * works live or inside Tone.Offline. `durationBeats` caps playback length.
 */
export function playPadInto(
  pad: PadConfig,
  dest: Tone.ToneAudioNode,
  time?: number,
  durationBeats?: number,
): Tone.ToneBufferSource | null {
  const buffer = padBuffer(pad);
  if (!buffer) return null;
  const gainNode = new Tone.Gain(pad.gain).connect(dest);
  const src = new Tone.ToneBufferSource(new Tone.ToneAudioBuffer(buffer)).connect(gainNode);
  let duration = pad.trimEnd > 0 ? Math.max(0.01, pad.trimEnd - pad.trimStart) : undefined;
  if (durationBeats !== undefined) {
    const cap = durationBeats * engine.secondsPerBeat();
    duration = duration === undefined ? cap : Math.min(duration, cap);
  }
  src.onended = (): void => {
    src.dispose();
    gainNode.dispose();
  };
  src.start(time ?? Tone.immediate(), pad.trimStart, duration);
  return src;
}

/** Render buffers for tone-linked pads that don't have one yet (project load). */
export async function ensurePadBuffers(pads: (PadConfig | null)[]): Promise<boolean> {
  let rendered = false;
  for (const pad of pads) {
    if (!pad?.toneId) continue;
    // re-render buffers made pre-gesture against the 44.1 kHz stub context
    const cached = store.getBuffer(toneBufferKey(pad.toneId));
    if (cached && cached.sampleRate === Tone.getContext().sampleRate) continue;
    const patch = store.data.patches.find((p) => p.id === pad.toneId);
    if (!patch) continue;
    store.setBuffer(toneBufferKey(pad.toneId), await renderPatch(patch));
    rendered = true;
  }
  return rendered;
}
```

- [ ] **Step 2: Delegate from `sample-tab.ts`**

Replace `src/modules/sample/sample-tab.ts:177-235` (the `ensureToneBuffers`/`padBuffer`/`padSeconds`/`playPad` block):

```ts
  /** Render buffers for tone-linked pads that don't have one yet (project load). */
  private async ensureToneBuffers(): Promise<void> {
    // renderPatch (Tone.Offline) would create the audio context — wait for
    // the first gesture instead of triggering Chrome's autoplay warning
    if (!engine.started) {
      engine.whenReady(() => void this.ensureToneBuffers());
      return;
    }
    if (await ensurePadBuffers(store.data.pads)) this.render();
  }

  /**
   * Play a pad now (or at a scheduled time on the transport).
   * `durationBeats` (grid clips) caps the playback length.
   */
  private playPad(index: number, time?: number, durationBeats?: number): void {
    const pad = store.data.pads[index];
    if (!pad) return;
    const src = playPadInto(pad, engine.master, time, durationBeats);
    if (src && time !== undefined) this.flashPad(index, time); // scheduled loop hits
  }
```

Add the import near the top of `sample-tab.ts` (alongside the other `core/` imports):

```ts
import { ensurePadBuffers, padBuffer, padSeconds, playPadInto } from '../../core/pad-voice';
```

Every remaining call to `this.padBuffer(pad)` / `this.padSeconds(pad)` elsewhere in `sample-tab.ts` (lines 552, 625, 1088 per the current file) becomes a call to the imported `padBuffer(pad)` / `padSeconds(pad)` (drop `this.`). Search the file for `this.padBuffer(` and `this.padSeconds(` and update each call site.

- [ ] **Step 3: Remap `'pad'`-ref arrangement clips on pad swap**

Change `src/modules/sample/sample-tab.ts:998-1002` (inside the pad drag/drop `ondrop` handler):

```ts
        store.update((d) => {
          [d.pads[from], d.pads[i]] = [d.pads[i], d.pads[from]];
          for (const loop of d.padLoops)
            for (const ev of loop.events) ev.pad = ev.pad === from ? i : ev.pad === i ? from : ev.pad;
          for (const t of d.arrangement.tracks)
            for (const c of t.clips)
              if (c.ref.type === 'pad') c.ref.index = c.ref.index === from ? i : c.ref.index === i ? from : c.ref.index;
        });
```

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: succeeds (the `ArrangeClip`/`ArrangeTrack` type errors from Task 1 Step 6 remain in `arrange-tab.ts` only — not touched by this task; that's expected until Task 6)

- [ ] **Step 5: Manual verification in the browser**

Run: `npm run dev`, open the app, go to the Sample tab.

1. Confirm pads still play on click, in a loop, and via drag-recorded events, exactly as before (no regression from the extraction).
2. Drag one pad onto another to swap them; confirm both pads' audio/settings swap correctly (this exercises the existing `padLoops` remap, unchanged).
3. Confirm no console errors.

- [ ] **Step 6: Commit**

```bash
git add src/core/pad-voice.ts src/modules/sample/sample-tab.ts
git commit -m "Extract pad playback into core/pad-voice.ts; remap arrangement pad refs on pad swap"
```

---

## Task 3: `scheduleSequenceAt` returns a disposable handle

**Files:**
- Modify: `src/modules/sequence/sequence-playback.ts:152-165`

**Interfaces:**
- Produces: `interface ScheduledSequence { dispose(): void }`; `scheduleSequenceAt(...): ScheduledSequence` (was `void`). Consumed by `song-graph.ts` in Task 4.
- No unit tests (imports Tone) — this is a narrow, mechanical change verified by the existing behavior continuing to work (Step 3).

- [ ] **Step 1: Widen the return type**

Replace `src/modules/sequence/sequence-playback.ts:147-165`:

```ts
export interface ScheduledSequence {
  dispose(): void;
}

/**
 * Schedule a whole sequence at absolute times in the ACTIVE Tone context.
 * Call inside Tone.Offline (resolve the instrument beforehand, in the live
 * context, and pass it in — the store is context-agnostic data). Returns a
 * handle to dispose the synth/sampler this call created — callers scheduling
 * this live (as opposed to a one-shot Tone.Offline render that's discarded
 * wholesale right after) must dispose it once the sequence's playback ends.
 */
export function scheduleSequenceAt(
  seq: Sequence,
  dest: Tone.ToneAudioNode,
  secondsPerStep: number,
  resolved: ResolvedInstrument,
  startSeconds = 0,
): ScheduledSequence {
  const synth = resolved.instrument.type === 'synth' ? makeSynth(resolved.instrument.kind).connect(dest) : null;
  const sampler = resolved.instrument.type === 'instrument' ? makeInstrumentPlayer(resolved.loaded!, dest) : null;
  for (const n of seq.notes) {
    const time = startSeconds + n.step * secondsPerStep + 0.01;
    triggerNote(resolved, dest, synth, sampler, n, time, secondsPerStep, false);
  }
  return {
    dispose(): void {
      synth?.dispose();
      sampler?.dispose();
    },
  };
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: succeeds — `renderSequence()`'s existing call site (`src/modules/sequence/sequence-playback.ts:172-174`, `if (resolved) scheduleSequenceAt(seq, Tone.getDestination(), sps, resolved);`) ignores the return value, which is fine (non-breaking widening).

- [ ] **Step 3: Manual verification in the browser**

Run: `npm run dev`, go to the Sequence tab, play a sequence with a `synth`/`fm`/`am` instrument and one with an `instrument`-library sample. Confirm both still sound correct and no console errors — `renderSequence` (used for baking a sequence's `wavFile`) is the only current caller and its behavior is unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/modules/sequence/sequence-playback.ts
git commit -m "scheduleSequenceAt returns a disposable handle instead of leaking its synth/sampler"
```

---

## Task 4: `song-graph.ts` — one shared audio-graph builder for live + export

**Files:**
- Create: `src/modules/arrange/song-graph.ts`

**Interfaces:**
- Consumes: `isTrackAudible`, `MAX_BARS`, `ArrangeClipRef`, `ArrangeClip`, `ArrangeTrack`, `PluginInstanceState` (Task 1); `padBuffer`, `padSeconds` (Task 2); `scheduleSequenceAt`, `resolveInstrument`, `ResolvedInstrument`, `ScheduledSequence` (Task 3); `connectChain` (existing, `src/plugins/chain.ts`).
- Produces: `clipBars()`, `songBars()`, `resolveSong()`, `NodeProvider`, `createOfflineProvider()`, `scheduleSong()`. Consumed by `arrange-tab.ts` in Task 6.
- No unit tests — transitively imports Tone via `store`, matching `arrange-tab.ts`'s existing untested precedent.

- [ ] **Step 1: Create `song-graph.ts`**

Create `src/modules/arrange/song-graph.ts`:

```ts
import * as Tone from '../../core/tone';
import type { ArrangeClip, ArrangeClipRef, ArrangeTrack, PluginInstanceState } from '../../core/model';
import { isTrackAudible, MAX_BARS } from '../../core/model';
import { padBuffer, padSeconds } from '../../core/pad-voice';
import { connectChain } from '../../plugins/chain';
import { resolveInstrument, scheduleSequenceAt, type ResolvedInstrument, type ScheduledSequence } from '../sequence/sequence-playback';
import { store } from '../../core/project-store';

/** A clip's bar-span, derived from its ref (no stored length). */
export function clipBars(ref: ArrangeClipRef, barSeconds: number): number {
  if (ref.type === 'sequence') {
    return store.data.sequences.find((s) => s.id === ref.id)?.bars ?? 1;
  }
  if (ref.type === 'pad') {
    const pad = store.data.pads[ref.index];
    const seconds = pad ? padSeconds(pad) : undefined;
    return seconds ? Math.max(1, Math.ceil(seconds / barSeconds)) : 1;
  }
  const buffer = store.getBuffer(ref.file);
  return buffer ? Math.max(1, Math.ceil(buffer.duration / barSeconds)) : 1;
}

/** Total bars the arrangement currently spans, clamped to [minBars, MAX_BARS]. */
export function songBars(tracks: ArrangeTrack[], minBars: number, barSeconds: number): number {
  let end = minBars;
  for (const t of tracks) {
    for (const c of t.clips) end = Math.max(end, c.bar + clipBars(c.ref, barSeconds) + 4);
  }
  return Math.min(MAX_BARS, end);
}

export interface ResolvedSong {
  /** clip.id -> buffer, for 'file'/'pad' refs. */
  buffers: Map<string, AudioBuffer>;
  /** sequence.id -> resolved instrument, for 'sequence' refs (deduped across clips). */
  sequences: Map<string, ResolvedInstrument>;
}

/** Pre-resolve every clip's audio in the LIVE context (buffers + resolveInstrument), before Tone.Offline. */
export async function resolveSong(tracks: ArrangeTrack[]): Promise<ResolvedSong> {
  const buffers = new Map<string, AudioBuffer>();
  const sequences = new Map<string, ResolvedInstrument>();
  for (const track of tracks) {
    for (const clip of track.clips) {
      const ref = clip.ref;
      if (ref.type === 'sequence') {
        if (sequences.has(ref.id)) continue;
        const seq = store.data.sequences.find((s) => s.id === ref.id);
        if (!seq) continue;
        const resolved = await resolveInstrument(seq);
        if (resolved) sequences.set(ref.id, resolved);
      } else if (ref.type === 'pad') {
        const pad = store.data.pads[ref.index];
        const buffer = pad ? padBuffer(pad) : null;
        if (buffer) buffers.set(clip.id, buffer);
      } else {
        const buffer = store.getBuffer(ref.file) ?? (await store.loadBuffer(ref.file));
        if (buffer) buffers.set(clip.id, buffer);
      }
    }
  }
  return { buffers, sequences };
}

export interface NodeProvider {
  trackBus(track: ArrangeTrack, songBus: Tone.ToneAudioNode): Tone.Gain;
  clipBus(clip: ArrangeClip, trackBus: Tone.Gain): Tone.Gain;
}

/** Stateless provider for one-shot renders — matches the pre-existing exportSong() pattern. */
export function createOfflineProvider(): NodeProvider {
  return {
    trackBus(track, songBus): Tone.Gain {
      const g = new Tone.Gain(track.gain);
      connectChain(track.plugins, g, songBus);
      return g;
    },
    clipBus(clip, trackBus): Tone.Gain {
      const g = new Tone.Gain(clip.gain);
      connectChain(clip.plugins, g, trackBus);
      return g;
    },
  };
}

export interface SongScheduleOptions {
  songBus: Tone.ToneAudioNode;
  startSeconds: number;
  barSeconds: number;
  secondsPerStep: number;
  provider: NodeProvider;
}

export interface SongPlaybackHandles {
  dispose(): void;
}

/** Build the audio graph for the whole song and start it. Used by BOTH play() and exportSong(). */
export function scheduleSong(tracks: ArrangeTrack[], resolved: ResolvedSong, opts: SongScheduleOptions): SongPlaybackHandles {
  const sources: Tone.ToneBufferSource[] = [];
  const scheduledSequences: ScheduledSequence[] = [];
  for (const track of tracks.filter((t) => isTrackAudible(t, tracks))) {
    const trackBus = opts.provider.trackBus(track, opts.songBus);
    for (const clip of track.clips) {
      const clipBus = opts.provider.clipBus(clip, trackBus);
      const at = opts.startSeconds + clip.bar * opts.barSeconds;
      if (clip.ref.type === 'sequence') {
        const seq = store.data.sequences.find((s) => s.id === (clip.ref as { id: string }).id);
        const resolvedSeq = seq && resolved.sequences.get(seq.id);
        if (seq && resolvedSeq) scheduledSequences.push(scheduleSequenceAt(seq, clipBus, opts.secondsPerStep, resolvedSeq, at));
      } else {
        const buffer = resolved.buffers.get(clip.id);
        if (!buffer) continue;
        const src = new Tone.ToneBufferSource(new Tone.ToneAudioBuffer(buffer)).connect(clipBus);
        src.start(at + 0.01);
        sources.push(src);
      }
    }
  }
  return {
    dispose(): void {
      for (const s of sources) {
        try {
          s.stop();
          s.dispose();
        } catch {
          /* already stopped */
        }
      }
      for (const s of scheduledSequences) s.dispose();
    },
  };
}
```

Note: `trackBus`/`clipBus` gain values come from the `Tone.Gain` constructor call itself (`new Tone.Gain(track.gain)`/`new Tone.Gain(clip.gain)`) — no separate `.gain.value = ...` write needed here since these are freshly constructed each call (matches today's `exportSong()` pattern). The live provider (Task 6) will additionally need to refresh an already-memoized track's gain on every `play()`, since it reuses one `inGain` across plays — handled there.

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: succeeds (this is a new, self-contained file with no existing callers yet)

- [ ] **Step 3: Commit**

```bash
git add src/modules/arrange/song-graph.ts
git commit -m "Add song-graph.ts: one shared audio-graph builder for Arrange live playback and export"
```

---

## Task 5: Fix the Master FX live-playback bug

**Files:**
- Modify: `src/shell/app-shell.ts:257-263` (Master FX button handler), `connectedCallback()` (add eager binding)

**Interfaces:** none — purely a wiring-order fix, no new exports.

- [ ] **Step 1: Bind the master chain eagerly**

Find where `engine.whenReady(...)` is already used in `app-shell.ts`'s `connectedCallback()` (e.g. the `if (uiState().metronomeOn) { ...; engine.whenReady(() => void engine.setMetronome(true)); }` block, `src/shell/app-shell.ts:273-277`). Add, right after the `masterDialog`/`.master-fx` button wiring (`src/shell/app-shell.ts:257-263`):

```ts
    const masterDialog = this.querySelector<HTMLDialogElement>('.master-dialog')!;
    this.querySelector<HTMLButtonElement>('.master-fx')!.onclick = async (): Promise<void> => {
      await engine.ensureStarted();
      this.ensureMasterChain();
      masterDialog.show();
    };
    this.querySelector<HTMLButtonElement>('.close-master')!.onclick = (): void => masterDialog.close();
    // bind Master FX into the live graph as soon as audio exists — previously
    // this only happened the first time the user opened the Master FX dialog,
    // so masterPlugins silently did nothing live (it was still applied
    // correctly during WAV export, which built its own separate graph)
    engine.whenReady(() => this.ensureMasterChain());
```

`ensureMasterChain()`'s existing body (`src/shell/app-shell.ts:317-...`) needs no changes — it already correctly no-ops if `this.masterChain` exists and isn't told to rebind, and otherwise creates+binds it.

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 3: Manual verification in the browser**

Run: `npm run dev`, open the app **without ever clicking "Master FX"**.

1. Go to the Tone tab, play a sound — confirm it's audible (baseline, no regression).
2. Open Master FX (this will now show the chain already bound), add a Reverb, close the dialog.
3. Play a sound again from any tab — confirm the reverb is now audible live (previously, per the bug, adding an effect via the dialog for the FIRST time already worked since `ensureMasterChain` was invoked by that same click; the real regression test is below).
4. Reload the page (so `masterChain` starts `null` again, matching a fresh session), confirm a project with a previously-saved Master FX reverb is audible on Play **without opening the Master FX dialog at all** — this is the scenario the bug broke, and the fix is `engine.whenReady` binding it before any dialog interaction.
5. Confirm no console errors.

- [ ] **Step 4: Commit**

```bash
git add src/shell/app-shell.ts
git commit -m "Bind Master FX into the live audio graph eagerly, not only when the dialog is first opened"
```

---

## Task 6: Wire `song-graph.ts` into `arrange-tab.ts`; add mute/solo + pad palette entries

**Files:**
- Modify: `src/modules/arrange/arrange-tab.ts` (most of the file)

**Interfaces:**
- Consumes: everything from Tasks 1, 2, 4.
- Produces: no new exports — `ArrangeTab`'s public custom-element behavior is unchanged (still `<arrange-tab>`), only its internals and rendered DOM change.

- [ ] **Step 1: Replace the imports**

Replace `src/modules/arrange/arrange-tab.ts:1-13`:

```ts
import * as Tone from '../../core/tone';
import { engine } from '../../core/audio-engine';
import { bus } from '../../core/event-bus';
import type { ArrangeTrack } from '../../core/model';
import { isTrackAudible, uid } from '../../core/model';
import { store } from '../../core/project-store';
import { uiState, updateUi } from '../../core/ui-state';
import { connectChain, PluginChainEl } from '../../plugins/chain';
import type { DawPlugin } from '../../plugins/api';
import { knob } from '../../ui/knob';
import { transportButton } from '../../ui/transport-buttons';
import {
  clipBars,
  createOfflineProvider,
  resolveSong,
  scheduleSong,
  songBars,
  type NodeProvider,
  type SongPlaybackHandles,
} from './song-graph';

const MIN_BARS = 32;
```

`Sequence`/`renderSequence` are no longer needed — sequence rendering goes through `scheduleSequenceAt` inside `song-graph.ts` now, not a pre-bounced buffer.

- [ ] **Step 2: Replace the instance fields**

Replace `src/modules/arrange/arrange-tab.ts:15-21`:

```ts
export class ArrangeTab extends HTMLElement {
  private palette = '';
  private openFx = new Set<string>();
  private fxRenderQueued = false;
  private activeSong: SongPlaybackHandles | null = null;
  private liveTrackNodes = new Map<string, { inGain: Tone.Gain; chain: PluginChainEl }>();
  private ephemeralClipFx: DawPlugin[] = [];
```

(`seqRenderCache`/`playing`/`liveChains` are removed — replaced by `activeSong`/`liveTrackNodes`/`ephemeralClipFx`)

- [ ] **Step 3: Simplify `project:changed`/`project:loaded` handlers**

Change `src/modules/arrange/arrange-tab.ts:30-34`:

```ts
    bus.on('project:loaded', () => this.render());
```

(the `seqRenderCache.clear()` calls in both `project:loaded` and `project:changed` are removed — there's no longer a sequence-render cache to invalidate; delete the `bus.on('project:changed', ...)` line entirely since it did nothing else)

- [ ] **Step 4: Replace `songBars`/`clipBars`/`sequenceBuffer`/`resolveClips`/`trackNodes` with `song-graph.ts`-backed versions**

Replace `src/modules/arrange/arrange-tab.ts:51-110` (from `private songBars()` through the end of `private trackNodes(...)`) with:

```ts
  private barSeconds(): number {
    return engine.secondsPerBeat() * 4;
  }

  private trackBus(track: ArrangeTrack, songBus: Tone.ToneAudioNode): Tone.Gain {
    let nodes = this.liveTrackNodes.get(track.id);
    if (!nodes) {
      const inGain = new Tone.Gain(track.gain);
      const chain = document.createElement('plugin-chain') as PluginChainEl;
      chain.bind(inGain, songBus, track.plugins, () => store.scheduleSave());
      nodes = { inGain, chain };
      this.liveTrackNodes.set(track.id, nodes);
    }
    nodes.inGain.gain.value = track.gain; // refresh in case the knob changed it since last play
    return nodes.inGain;
  }

  private liveProvider(): NodeProvider {
    return {
      trackBus: (track, songBus) => this.trackBus(track, songBus),
      clipBus: (clip, trackBus) => {
        const g = new Tone.Gain(clip.gain);
        this.ephemeralClipFx.push(...connectChain(clip.plugins, g, trackBus));
        return g;
      },
    };
  }
```

- [ ] **Step 5: Rewrite `play()`/`stop()`/`exportSong()`**

Replace `src/modules/arrange/arrange-tab.ts:112-174` (`play()` through the end of `exportSong()`) with:

```ts
  private async play(): Promise<void> {
    await engine.ensureStarted();
    this.stop();
    engine.claimTransport('arrange');
    const tracks = store.data.arrangement.tracks;
    const resolved = await resolveSong(tracks);
    const barSeconds = this.barSeconds();
    this.activeSong = scheduleSong(tracks, resolved, {
      songBus: engine.master, // carries Master FX eagerly now (see app-shell.ts fix)
      startSeconds: Tone.now() + 0.15,
      barSeconds,
      secondsPerStep: engine.secondsPerStep(),
      provider: this.liveProvider(),
    });
    // clips run on absolute time, but starting the transport keeps the
    // metronome ticking and lets the global play/stop button see the state
    engine.play();
  }

  private stop(): void {
    this.activeSong?.dispose();
    this.activeSong = null;
    for (const p of this.ephemeralClipFx) {
      p.output.disconnect();
      p.dispose();
    }
    this.ephemeralClipFx = [];
  }

  private async exportSong(): Promise<void> {
    const tracks = store.data.arrangement.tracks;
    const resolved = await resolveSong(tracks);
    const barSeconds = this.barSeconds();
    let endBar = 1;
    for (const t of tracks) for (const c of t.clips) endBar = Math.max(endBar, c.bar + clipBars(c.ref, barSeconds));
    const seconds = Math.min(endBar, 800) * barSeconds + 1;
    const masterPlugins = store.data.arrangement.masterPlugins;

    const rendered = await Tone.Offline(() => {
      const dest = Tone.getDestination();
      const masterBus = new Tone.Gain(0.9);
      connectChain(masterPlugins, masterBus, dest);
      scheduleSong(tracks, resolved, {
        songBus: masterBus,
        startSeconds: 0,
        barSeconds,
        secondsPerStep: engine.secondsPerStep(),
        provider: createOfflineProvider(),
      });
    }, seconds);
    const path = `exports/${store.data.name.replace(/[^\w-]+/g, '_')}-song.wav`;
    const written = await store.saveWav(path, rendered.get() as AudioBuffer);
    this.flash(written ? `Exported ${path}` : `Rendered ${path} in memory — connect a project folder to write files`);
  }
```

- [ ] **Step 6: Update `render()`'s use of `songBars`/`clipBars` and clean up track removal**

Change `src/modules/arrange/arrange-tab.ts`'s `render()` method:

- Where it currently computes `const bars = this.songBars();` (was line 243), change to `const bars = songBars(arr.tracks, MIN_BARS, this.barSeconds());`.
- Every remaining `this.clipBars(clip.ref)` call becomes `clipBars(clip.ref, this.barSeconds())`.
- The track-removal `✕` button handler currently does `this.liveChains.get(track.id)?.chain.teardown(); this.liveChains.delete(track.id);` — rename to `this.liveTrackNodes`.

- [ ] **Step 7: Add pad entries to the palette**

In `render()`, where the palette `<select>` is built (currently lines 189-210: sequences, then a deduped `files` set), add a third group for pads, addressed by index since pads have no id:

```ts
    for (const [index, pad] of store.data.pads.entries()) {
      if (!pad) continue;
      const opt = document.createElement('option');
      opt.value = `pad:${index}`;
      opt.textContent = `Pad: ${pad.name}`;
      opt.selected = this.palette === opt.value;
      palette.appendChild(opt);
    }
```

Update the placement handler (currently the `cell.onclick` in the grid loop, ~lines 309-316) to parse the new `pad:` prefix:

```ts
          cell.onclick = (): void => {
            if (!this.palette) return;
            const ref = this.palette.startsWith('seq:')
              ? { type: 'sequence' as const, id: this.palette.slice(4) }
              : this.palette.startsWith('pad:')
                ? { type: 'pad' as const, index: Number(this.palette.slice(4)) }
                : { type: 'file' as const, file: this.palette.slice(5) };
            store.update(() => track.clips.push({ id: uid(), bar: b, ref, gain: 1, plugins: [] }));
            this.render();
          };
```

Update the clip's display label/class (currently `el.className = 'arrange-clip' + (clip.ref.type === 'sequence' ? ' seq' : ' smp');` and the `el.textContent` ternary) to handle the third ref type:

```ts
          el.className =
            'arrange-clip' + (clip.ref.type === 'sequence' ? ' seq' : clip.ref.type === 'pad' ? ' pad' : ' smp');
          el.textContent =
            clip.ref.type === 'sequence'
              ? store.data.sequences.find((s) => s.id === (clip.ref as { id: string }).id)?.name ?? '?'
              : clip.ref.type === 'pad'
                ? store.data.pads[(clip.ref as { index: number }).index]?.name ?? '?'
                : (clip.ref as { file: string }).file.split('/').pop() ?? '?';
```

Add a minimal `.arrange-clip.pad` CSS rule to `src/style.css` near the existing `.arrange-clip.seq`/`.smp` rules:

```css
.arrange-clip.pad { background: var(--accent-2); }
```

(this reuses the existing `--accent-2` custom property — Phase B's fuller redesign is where a dedicated third color/`--accent-3` gets introduced for `file`-type clips specifically, per the earlier design; this task just needs pads to be visually distinguishable from sequences, which `--accent-2` already achieves since only `.seq` currently uses `--accent`)

- [ ] **Step 8: Add mute/solo buttons to the track head**

In `render()`'s per-track loop, where `head.append(title, knob(...), btn(FX...), btn('✕', ...))` is built, add mute/solo buttons using the existing `iconBtn`-less `btn()` helper already defined in this file (a plain `<button>` with `textContent`) as a minimal placeholder — reusing the exact icon-button treatment from the Tone tab is Phase B's job, but functional mute/solo now:

```ts
      head.append(
        title,
        btn(track.muted ? 'Muted' : 'Mute', () => {
          store.update(() => (track.muted = !track.muted));
          this.render();
        }),
        btn(track.solo ? 'Soloed' : 'Solo', () => {
          store.update(() => (track.solo = !track.solo));
          this.render();
        }),
        knob({ label: 'Gain', min: 0, max: 1.2, step: 0.01, value: track.gain }, (v) => {
          track.gain = v;
          const nodes = this.liveTrackNodes.get(track.id);
          if (nodes) nodes.inGain.gain.value = v;
          store.scheduleSave();
        }),
        btn(this.openFx.has(track.id) ? 'Hide FX' : 'FX', () => {
          if (this.openFx.has(track.id)) this.openFx.delete(track.id);
          else this.openFx.add(track.id);
          updateUi((s) => (s.arrange.openFx = [...this.openFx]));
          this.render();
        }),
        btn('✕', () => {
          this.liveTrackNodes.get(track.id)?.chain.teardown();
          this.liveTrackNodes.delete(track.id);
          store.update((d) => {
            d.arrangement.tracks = d.arrangement.tracks.filter((t) => t.id !== track.id);
          });
          this.render();
        }),
      );
```

Add a `lane.classList.toggle('muted', !!track.muted);` right after `lane.className = 'arrange-track card';`, and a corresponding CSS rule in `src/style.css`:

```css
.arrange-track.muted { opacity: 0.45; }
```

This is intentionally minimal (text-label buttons, not icon buttons) — Phase B redesigns the whole track head with icon buttons matching the Tone tab's `.mute-btn`/`.solo-btn` visual language; this task only needs mute/solo to be **functional** so Task 1/4's `isTrackAudible` wiring can be exercised end-to-end.

- [ ] **Step 9: Update the `+ Track` handler and `New patch`-style clip construction for the widened types**

The `+ Track` button handler already constructs a full `ArrangeTrack` object literal (`{ id, name, gain, plugins, clips }`) — no change needed there (`muted`/`solo` are optional). Confirm the clip-placement handler from Step 7 is the *only* place a new `ArrangeClip` is constructed in this file, and that it includes `gain: 1, plugins: []` (already shown above).

- [ ] **Step 10: Type-check**

Run: `npm run build`
Expected: succeeds — this should resolve the errors left over from Task 1 Step 6.

- [ ] **Step 11: Manual verification in the browser**

Run: `npm run dev`, open the app, go to the Arrange tab.

1. Create two tracks, place a sequence clip on one and a file clip on the other; confirm Play still works exactly as before (no regression).
2. Place a pad clip (pick "Pad: ..." from the palette) — confirm it appears on the timeline and plays correctly.
3. Mute one track, Play — confirm that track is silent, others unaffected.
4. Solo the other track — confirm ONLY the soloed track plays.
5. Export the song WAV with one track muted and one soloed — confirm the exported file matches what was heard live (open it, or at minimum confirm no console errors and a file is written/flashed).
6. Directly via the browser devtools console (or a temporary script), set `store.data.arrangement.tracks[0].clips[0].gain = 0.2` and `.plugins = [{id: crypto.randomUUID(), pluginId: 'reverb', state: {decay: 3, wet: 0.6}, bypassed: false}]`, then Play and Export — confirm the volume drop and reverb are both audible in **both** Play and the exported WAV (this exercises clip-level gain/effects end-to-end even though there's no dedicated UI for it yet — Phase B adds that).
7. Remove a track that has an open FX panel — confirm no console errors (chain teardown still works).
8. Confirm no console errors throughout.

- [ ] **Step 12: Commit**

```bash
git add src/modules/arrange/arrange-tab.ts src/style.css
git commit -m "Wire song-graph.ts into the Arrange tab; add pad segments and functional track mute/solo"
```

---

## Task 7: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the new `model.test.ts` cases from Task 1.

- [ ] **Step 2: Full type-check and build**

Run: `npm run build`
Expected: succeeds with zero errors/warnings.

- [ ] **Step 3: End-to-end manual pass**

Repeat Task 6 Step 11's checklist once more against a freshly reloaded page (not just hot-reloaded during development), plus: reload the page entirely and confirm a saved arrangement (tracks, mute/solo, clip gain/effects) round-trips correctly through the real persistence path (not just `JSON.stringify` in a test).

- [ ] **Step 4: Report results**

No commit for this task — verification only. If anything fails, return to the relevant task, fix, and re-run from the top.

---

## Plan Self-Review Notes

- **Spec coverage:** pad segments (Tasks 1, 2, 6), clip volume/effects (Tasks 1, 4, 6), track mute/solo (Tasks 1, 6), unified live/export audio graph (Task 4, 6), Master FX live bug (Task 5) — every Phase A goal from the design maps to a task. Phase B (timeline UI: virtualization, zoom, drag/resize, FX dialog) is explicitly out of scope for this plan, per the phased approach.
- **Placeholder scan:** no TBD/TODO; every step shows complete code.
- **Type consistency:** `ArrangeClipRef`/`NodeProvider`/`SongPlaybackHandles`/`ResolvedSong` names and shapes are used identically across Tasks 1, 4, and 6.
