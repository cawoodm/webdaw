# Arrange Tab Phase B — Timeline UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Arrange tab's one-DOM-column-per-bar MVP grid with a sequence-grid-style timeline: left-docked 150px track heads, a px-per-bar zoomable ruler+lane area with snap-level gridlines, draggable/resizable clips, a playhead, virtualized clip rendering, and a single shared FX dialog for tracks and clips.

**Architecture:** Phase A already unified the audio graph (`song-graph.ts`); this phase is UI-only plus two small model additions (persisted song length `arrangement.bars`, per-clip span override `clip.bars` for resize). Pure timeline math (snap, ruler ticks, grid gradients, visible range) lives in a new Tone-free module with unit tests; `arrange-tab.ts` is rewritten around a flex-row layout (`sticky` heads/ruler, absolutely-positioned clips on `position:relative` lanes) driven by one rAF loop (playhead + dirty-flagged ruler/clip sync).

**Tech Stack:** Vanilla TS + Web Components (light DOM), Tone.js via the `core/tone` shim, Vitest for pure modules, puppeteer-core scripts for in-browser verification.

## Global Constraints

- Strict TS: `npm run build` runs `tsc --noEmit` with `noUnusedLocals`/`noUnusedParameters` — every task must end build-clean.
- NEVER import from `'tone'` directly; only `import * as Tone from '../../core/tone'`.
- Modules importing Tone (directly or via `store`) cannot run under Vitest — pure logic goes in Tone-free files.
- Musical time stays in beats/bars in the model; seconds only at scheduling time.
- All cross-module flows go through `bus`; transient UI prefs through `uiState()`/`updateUi()`.
- Commits on `main` (user consented); no AI attribution in commit messages.
- Work happens directly in `C:\projects\Marc\webdaw` (no worktree — user convention this session).
- Dev server for manual verification: `npx vite --port 5174` (or reuse a running one); puppeteer scripts go in `scripts/_tmp-verify-*.mjs` and are deleted after use.

---

### Task 1: Model — persisted song length + clip span override

**Files:**
- Modify: `src/core/model.ts` (arrangement type ~line 259, `ArrangeClip`, `normalizeProject`, `emptyProject`)
- Test: `src/core/model.test.ts`

**Interfaces:**
- Produces: `ProjectData.arrangement.bars: number` (1..MAX_BARS, default 32); `ArrangeClip.bars?: number` (fractional bar-span override set by resizing; absent = derive from ref). Later tasks rely on both names exactly.

- [ ] **Step 1: Write the failing tests** — add to `src/core/model.test.ts` (follow the existing backfill/round-trip test style in that file):

```ts
it('backfills arrangement.bars for old projects', () => {
  const p = emptyProject('x');
  delete (p.arrangement as { bars?: number }).bars;
  const data = normalizeProject(JSON.parse(JSON.stringify(p)) as ProjectData);
  expect(data.arrangement.bars).toBe(32);
});

it('round-trips a clip with a fractional bar and span override', () => {
  const p = emptyProject('x');
  p.arrangement.bars = 64;
  p.arrangement.tracks.push({
    id: uid(),
    name: 'T',
    gain: 1,
    plugins: [],
    clips: [{ id: uid(), bar: 2.25, ref: { type: 'file', file: 'samples/a.wav' }, gain: 1, plugins: [], bars: 1.5 }],
  });
  const round = normalizeProject(JSON.parse(JSON.stringify(p)) as ProjectData);
  expect(round.arrangement.bars).toBe(64);
  expect(round.arrangement.tracks[0].clips[0].bar).toBe(2.25);
  expect(round.arrangement.tracks[0].clips[0].bars).toBe(1.5);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/model.test.ts`
Expected: FAIL — `arrangement.bars` doesn't exist (TS error) / backfill missing.

- [ ] **Step 3: Implement** — in `src/core/model.ts`:

Add to `ArrangeClip` (after `ref`):

```ts
  /** Fractional bar-span override from resizing (pad/file clips); absent = derived from the ref. */
  bars?: number;
```

Change the arrangement field on `ProjectData`:

```ts
  arrangement: {
    /** Song length in bars — the timeline's fixed width (1..MAX_BARS). */
    bars: number;
    tracks: ArrangeTrack[];
    masterPlugins: PluginInstanceState[];
  };
```

In `emptyProject()`: `arrangement: { bars: 32, tracks: [], masterPlugins: [] },`

In `normalizeProject()`, next to the existing clip backfill loop:

```ts
  data.arrangement.bars ??= 32;
  data.arrangement.bars = Math.max(1, Math.min(MAX_BARS, data.arrangement.bars));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/model.test.ts` → PASS. Then `npm run build`. Fix any other construction sites of `arrangement` the compiler flags (search for `masterPlugins: []`).

- [ ] **Step 5: Commit**

```bash
git add src/core/model.ts src/core/model.test.ts
git commit -m "Arrangement gains a persisted song length and clips a resizable span override"
```

---

### Task 2: Pure timeline math module

**Files:**
- Create: `src/modules/arrange/timeline-math.ts` (Tone-free — no imports from tone/store)
- Test: `src/modules/arrange/timeline-math.test.ts`

**Interfaces:**
- Produces (exact signatures later tasks use):
  - `PX_PER_BAR_STEPS: number[]` — `[4, 6, 8, 12, 16, 24, 32, 48, 64]`
  - `SNAP_BEATS: { beats: number; label: string }[]` — 0 = free
  - `floorSnapBar(bar: number, snapBeats: number): number`
  - `nearestSnapBar(bar: number, snapBeats: number): number`
  - `minSpanBars(snapBeats: number): number`
  - `pickBarTick(pxPerBar: number): number`
  - `gridBackgroundBars(pxPerBar: number, snapBeats: number): { image: string; size: string }`
  - `visibleBarRange(scrollLeft: number, viewWidth: number, pxPerBar: number, totalBars: number, bufferPx?: number): { from: number; to: number }`

- [ ] **Step 1: Write the failing tests** — create `src/modules/arrange/timeline-math.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  floorSnapBar,
  gridBackgroundBars,
  minSpanBars,
  nearestSnapBar,
  pickBarTick,
  visibleBarRange,
} from './timeline-math';

describe('snap', () => {
  it('floor-snaps a bar position to the snap grid (snap in beats, 4 beats per bar)', () => {
    expect(floorSnapBar(2.7, 4)).toBe(2); // whole-bar snap
    expect(floorSnapBar(2.7, 1)).toBe(2.5); // 1-beat snap = quarter bar
    expect(floorSnapBar(2.7, 0.5)).toBe(2.625); // half-beat snap = 1/8 bar
  });
  it('nearest-snaps for resize', () => {
    expect(nearestSnapBar(2.7, 1)).toBe(2.75);
    expect(nearestSnapBar(2.55, 1)).toBe(2.5);
  });
  it('snap 0 means free movement', () => {
    expect(floorSnapBar(2.712, 0)).toBe(2.712);
    expect(nearestSnapBar(2.712, 0)).toBe(2.712);
  });
  it('minimum clip span is one snap unit, or 1/32 bar when free', () => {
    expect(minSpanBars(1)).toBe(0.25);
    expect(minSpanBars(0)).toBe(1 / 32);
  });
});

describe('pickBarTick', () => {
  it('labels every bar when zoomed in, sparser when zoomed out (>=44px between labels)', () => {
    expect(pickBarTick(64)).toBe(1);
    expect(pickBarTick(16)).toBe(4);
    expect(pickBarTick(4)).toBe(16);
  });
});

describe('visibleBarRange', () => {
  it('converts scroll window to a clamped, buffered bar range', () => {
    expect(visibleBarRange(0, 320, 16, 800, 0)).toEqual({ from: 0, to: 20 });
    expect(visibleBarRange(160, 320, 16, 800, 160)).toEqual({ from: 0, to: 40 });
    expect(visibleBarRange(12640, 320, 16, 800, 0)).toEqual({ from: 790, to: 800 });
  });
});

describe('gridBackgroundBars', () => {
  it('produces one gradient layer per level from bar down to the snap unit', () => {
    const g = gridBackgroundBars(64, 1); // bar, half-bar, beat
    expect(g.image.split('linear-gradient').length - 1).toBe(3);
    expect(g.size.split(',').map((s) => s.trim())).toEqual(['64px 100%', '32px 100%', '16px 100%']);
  });
  it('drops levels finer than 5px so a zoomed-out grid never turns solid', () => {
    // pxPerBar 8, snap 1/4 beat: half-bar would be 4px — only the 8px bar level survives
    expect(gridBackgroundBars(8, 0.25).size).toBe('8px 100%');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/arrange/timeline-math.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `src/modules/arrange/timeline-math.ts`:

```ts
/**
 * Pure timeline math for the Arrange tab — Tone-free so it stays unit-testable.
 * Positions and spans are fractional BARS; snap sizes are BEATS (4 beats/bar).
 */

export const PX_PER_BAR_STEPS = [4, 6, 8, 12, 16, 24, 32, 48, 64];

export const SNAP_BEATS: { beats: number; label: string }[] = [
  { beats: 0, label: 'Snap: none' },
  { beats: 4, label: 'Snap: 4 beats' },
  { beats: 2, label: 'Snap: 2 beats' },
  { beats: 1, label: 'Snap: 1 beat' },
  { beats: 0.5, label: 'Snap: 1/2' },
  { beats: 0.25, label: 'Snap: 1/4' },
  { beats: 0.125, label: 'Snap: 1/8' },
  { beats: 0.0625, label: 'Snap: 1/16' },
  { beats: 0.03125, label: 'Snap: 1/32' },
];

export function floorSnapBar(bar: number, snapBeats: number): number {
  if (snapBeats <= 0) return bar;
  const snapBars = snapBeats / 4;
  return Math.floor(bar / snapBars + 1e-9) * snapBars;
}

export function nearestSnapBar(bar: number, snapBeats: number): number {
  if (snapBeats <= 0) return bar;
  const snapBars = snapBeats / 4;
  return Math.round(bar / snapBars) * snapBars;
}

/** Smallest span a resize may reach: one snap unit, or 1/32 bar when snapping is off. */
export function minSpanBars(snapBeats: number): number {
  return snapBeats > 0 ? snapBeats / 4 : 1 / 32;
}

const BAR_TICK_STEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

/** Bars between ruler labels so labels stay >=44px apart at the given zoom. */
export function pickBarTick(pxPerBar: number): number {
  for (const step of BAR_TICK_STEPS) {
    if (step * pxPerBar >= 44) return step;
  }
  return BAR_TICK_STEPS[BAR_TICK_STEPS.length - 1];
}

/**
 * Hierarchical vertical gridlines: bar heaviest, then halving levels down to
 * the snap unit — the bar-based twin of sequence-tab's gridBackgroundSteps,
 * but sized in px because arrange rows have a fixed px width per bar.
 * Levels narrower than 5px are dropped so a zoomed-out grid never turns solid.
 */
export function gridBackgroundBars(pxPerBar: number, snapBeats: number): { image: string; size: string } {
  const style = (level: number): { w: number; a: number } =>
    [
      { w: 2, a: 0.6 }, // bar
      { w: 1, a: 0.32 }, // 1/2 bar
      { w: 1, a: 0.2 }, // beat
      { w: 1, a: 0.12 }, // finer
    ][Math.min(level, 3)];
  const snapBars = snapBeats > 0 ? snapBeats / 4 : 1;
  const images: string[] = [];
  const sizes: string[] = [];
  for (let bars = 1, level = 0; bars >= snapBars - 1e-9; bars /= 2, level++) {
    const px = bars * pxPerBar;
    if (px < 5) break;
    const { w, a } = style(level);
    images.push(`linear-gradient(90deg, rgb(148 163 184 / ${a * 100}%) ${w}px, transparent ${w}px)`);
    sizes.push(`${px}px 100%`);
  }
  return { image: images.join(', '), size: sizes.join(', ') };
}

/** The bar range worth having clip DOM for, given the scroll window plus a buffer. */
export function visibleBarRange(
  scrollLeft: number,
  viewWidth: number,
  pxPerBar: number,
  totalBars: number,
  bufferPx = 200,
): { from: number; to: number } {
  const from = Math.max(0, Math.floor((scrollLeft - bufferPx) / pxPerBar));
  const to = Math.min(totalBars, Math.ceil((scrollLeft + viewWidth + bufferPx) / pxPerBar));
  return { from, to };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/arrange/timeline-math.test.ts` → PASS (adjust the pinned gradient-count expectations to the implementation above: `gridBackgroundBars(64, 1)` yields levels 1 bar/64px, 1/2 bar/32px, 1/4 bar(=1 beat)/16px → 3 layers).

- [ ] **Step 5: Commit**

```bash
git add src/modules/arrange/timeline-math.ts src/modules/arrange/timeline-math.test.ts
git commit -m "Add pure timeline math for the Arrange tab: snap, ruler ticks, grid gradients, visible range"
```

---

### Task 3: song-graph honors fractional bars and span overrides

**Files:**
- Modify: `src/modules/arrange/song-graph.ts`

**Interfaces:**
- Consumes: `ArrangeClip.bars?` from Task 1.
- Produces: `clipSpanBars(clip: ArrangeClip, barSeconds: number): number` — override-aware span, used by scheduling AND by the UI (Task 6). `clipBars(ref, barSeconds)` stays exported (the UI needs the ref-derived default when a resize starts).

- [ ] **Step 1: Add the override-aware span helper** — in `src/modules/arrange/song-graph.ts`, after `clipBars`:

```ts
/** A clip's effective span: the resize override when present, else derived from the ref. */
export function clipSpanBars(clip: ArrangeClip, barSeconds: number): number {
  return clip.bars ?? clipBars(clip.ref, barSeconds);
}
```

- [ ] **Step 2: Use it in `songBars` and `scheduleSong`** — in `songBars`, change the inner loop line to:

```ts
    for (const c of t.clips) end = Math.max(end, c.bar + clipSpanBars(c, barSeconds) + 4);
```

In `scheduleSong`'s buffer branch, stop trimmed pad/file clips at their override end (sequences keep their intrinsic length):

```ts
      } else {
        const buffer = resolved.buffers.get(clip.id);
        if (!buffer) continue;
        const src = new Tone.ToneBufferSource(new Tone.ToneAudioBuffer(buffer)).connect(clipBus);
        src.start(at + 0.01);
        if (clip.bars !== undefined) src.stop(at + 0.01 + clip.bars * opts.barSeconds);
        sources.push(src);
      }
```

- [ ] **Step 3: Update `exportSong`'s end-bar computation** — in `src/modules/arrange/arrange-tab.ts` (still the old file at this point), change the loop in `exportSong()` to use `clipSpanBars(c, barSeconds)` instead of `clipBars(c.ref, barSeconds)` and add it to the import from `./song-graph`. (This file is rewritten in Task 4 anyway — the point is to keep the build green now.)

- [ ] **Step 4: Verify build + tests**

Run: `npm run build` → clean. Run: `npm test` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/arrange/song-graph.ts src/modules/arrange/arrange-tab.ts
git commit -m "song-graph: clip spans honor the resize override and trim pad/file playback to it"
```

---

### Task 4: Arrange tab rewrite — layout skeleton, toolbar, track heads

This is the big one: `arrange-tab.ts` is rewritten around the new layout. After this task the tab renders the new timeline (ruler canvas, gradient lanes, sticky heads with rename/duplicate/delete/mute/solo/gain/FX) — clips render statically (virtualization + interactions land in Tasks 5–6, the FX dialog in Task 7).

**Files:**
- Modify: `src/core/ui-state.ts` (arrange slice)
- Modify: `src/modules/arrange/arrange-tab.ts` (rewrite)
- Modify: `src/style.css` (replace the `.arrange-*` block)

**Interfaces:**
- Consumes: everything from Tasks 1–3; `gridBackgroundBars`/`pickBarTick`/`SNAP_BEATS`/`PX_PER_BAR_STEPS` from `timeline-math.ts`; existing `knob()`, `transportButton()`, `PluginChainEl`, `scheduleSong`/`resolveSong` (unchanged from Phase A).
- Produces (class fields/methods later tasks extend — keep these exact names): `rows: Map<string, HTMLElement>` (trackId → `.arrange-row`), `clipEls: Map<string, HTMLElement>` (clipId → clip element), `selectedClipId: string | null`, `viewDirty: boolean`, `pxPerBar()`, `snapBeats()`, `syncView()` (rAF-called), `buildClip(track, clip, row)` (stub in this task), `openTrackFx(track)`/`openClipFx(track, clip)` (stubs).

- [ ] **Step 1: Update the UI-state arrange slice** — in `src/core/ui-state.ts`, change the interface line and defaults (`openFx` is retired; the single dialog needs no persistence):

```ts
  arrange: { palette: string; snapBeats: number; pxPerBar: number };
```

```ts
    arrange: { palette: '', snapBeats: 1, pxPerBar: 16 },
```

The `applyUiState` spread already merges old stored slices; a leftover `openFx` key in old `ui.json` files is inert.

- [ ] **Step 2: Rewrite `src/modules/arrange/arrange-tab.ts`** — replace the whole file with the version below. It keeps Phase A's playback/export/`trackBus`/`liveProvider` verbatim and replaces everything render-related. Clip DOM and interactions are Task 5–6; this version renders lanes without clips and logs nothing.

```ts
import * as Tone from '../../core/tone';
import { engine } from '../../core/audio-engine';
import { bus } from '../../core/event-bus';
import type { ArrangeClip, ArrangeTrack } from '../../core/model';
import { MAX_BARS, uid } from '../../core/model';
import { store } from '../../core/project-store';
import { uiState, updateUi } from '../../core/ui-state';
import { connectChain, PluginChainEl } from '../../plugins/chain';
import type { DawPlugin } from '../../plugins/api';
import { knob } from '../../ui/knob';
import { transportButton } from '../../ui/transport-buttons';
import {
  clipSpanBars,
  createOfflineProvider,
  resolveSong,
  scheduleSong,
  type NodeProvider,
  type SongPlaybackHandles,
} from './song-graph';
import { gridBackgroundBars, pickBarTick, PX_PER_BAR_STEPS, SNAP_BEATS } from './timeline-math';

const HEAD_W = 150;
const RULER_H = 22;
const ROW_H = 48;

const ICONS = {
  mute: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/></svg>`,
  solo: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`,
  fx: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  zoomIn: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/></svg>`,
  zoomOut: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M8 11h6"/></svg>`,
};

export class ArrangeTab extends HTMLElement {
  private palette = '';
  private activeSong: SongPlaybackHandles | null = null;
  private liveTrackNodes = new Map<string, { inGain: Tone.Gain; chain: PluginChainEl }>();
  private ephemeralClipFx: DawPlugin[] = [];
  // ---- view state (rebuilt by render, consumed by the rAF loop) ----
  private rows = new Map<string, HTMLElement>();
  private clipEls = new Map<string, HTMLElement>();
  private selectedClipId: string | null = null;
  private viewDirty = true;

  connectedCallback(): void {
    this.className = 'tab-panel arrange-tab';
    bus.on('ui:loaded', () => {
      this.palette = uiState().arrange.palette;
      this.render();
    });
    bus.on('project:loaded', () => this.render());
    // absolute-time playback survives tab switches; yield when another
    // module claims playback
    bus.on('transport:claim', ({ owner }) => {
      if (owner !== 'arrange') this.stop();
    });
    bus.on('transport:join', () => this.stop());
    bus.on('transport:play', () => {
      if (this.classList.contains('active-tab')) void this.play();
    });
    bus.on('transport:stop', () => this.stop());
    document.addEventListener('keydown', (e) => this.onKeydown(e));
    const tick = (): void => {
      this.syncView();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    this.render();
  }

  // ---- prefs ----

  private pxPerBar(): number {
    return uiState().arrange.pxPerBar;
  }

  private snapBeats(): number {
    return uiState().arrange.snapBeats;
  }

  private songBarsCount(): number {
    return store.data.arrangement.bars;
  }

  private barSeconds(): number {
    return engine.secondsPerBeat() * 4;
  }

  // ---- audio graph (unchanged from Phase A) ----

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

  private async play(): Promise<void> {
    await engine.ensureStarted();
    this.stop();
    engine.claimTransport('arrange');
    const tracks = store.data.arrangement.tracks;
    const resolved = await resolveSong(tracks);
    this.activeSong = scheduleSong(tracks, resolved, {
      songBus: engine.master,
      startSeconds: Tone.now() + 0.15,
      barSeconds: this.barSeconds(),
      secondsPerStep: engine.secondsPerStep(),
      provider: this.liveProvider(),
    });
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
    for (const t of tracks) for (const c of t.clips) endBar = Math.max(endBar, c.bar + clipSpanBars(c, barSeconds));
    const seconds = Math.min(endBar, MAX_BARS) * barSeconds + 1;
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

  // ---- interactions (Tasks 5-7) ----

  private onKeydown(_e: KeyboardEvent): void {
    /* Task 6 */
  }

  private buildClip(_track: ArrangeTrack, _clip: ArrangeClip, _row: HTMLElement): HTMLElement {
    /* Task 5 */
    return document.createElement('div');
  }

  private openTrackFx(_track: ArrangeTrack): void {
    /* Task 7 */
  }

  private openClipFx(_track: ArrangeTrack, _clip: ArrangeClip): void {
    /* Task 7 */
  }

  // ---- rAF-driven view sync (ruler, virtualized clips, playhead) ----

  private syncView(): void {
    if (!this.isConnected) return;
    if (this.viewDirty) {
      this.viewDirty = false;
      this.drawRuler();
      this.syncClips();
    }
    this.updatePlayhead();
  }

  private drawRuler(): void {
    const canvas = this.querySelector<HTMLCanvasElement>('.arrange-ruler');
    const scroll = this.querySelector<HTMLElement>('.arrange-scroll');
    if (!canvas || !scroll) return;
    const w = Math.max(1, scroll.clientWidth - HEAD_W);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== RULER_H) canvas.height = RULER_H;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, w, RULER_H);
    const px = this.pxPerBar();
    const step = pickBarTick(px);
    const bars = this.songBarsCount();
    ctx.fillStyle = 'rgb(148 163 184 / 80%)';
    ctx.strokeStyle = 'rgb(148 163 184 / 50%)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const first = Math.max(0, Math.floor(scroll.scrollLeft / (step * px)) * step);
    for (let b = first; b <= bars; b += step) {
      const x = b * px - scroll.scrollLeft;
      if (x > w) break;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_H - 6);
      ctx.lineTo(x + 0.5, RULER_H);
      ctx.stroke();
      ctx.fillText(String(b + 1), x + 3, 4);
    }
  }

  private syncClips(): void {
    /* Task 5 — virtualized clip DOM */
  }

  private updatePlayhead(): void {
    const playhead = this.querySelector<HTMLElement>('.arrange-playhead');
    const scroll = this.querySelector<HTMLElement>('.arrange-scroll');
    if (!playhead || !scroll) return;
    const active = engine.started && engine.playing && this.activeSong !== null;
    playhead.classList.toggle('hidden', !active);
    if (!active) return;
    const barsPos = engine.positionBeats / 4;
    const x = HEAD_W + barsPos * this.pxPerBar();
    playhead.style.left = `${x}px`;
    const viewWidth = scroll.clientWidth;
    const margin = viewWidth * 0.2;
    const vx = x - scroll.scrollLeft;
    if (vx < HEAD_W + margin) scroll.scrollLeft = Math.max(0, x - HEAD_W - margin);
    else if (vx > viewWidth - margin) scroll.scrollLeft = x - viewWidth + margin;
    this.viewDirty = true; // auto-scroll moves the window → ruler/clips refresh
  }

  // ---- render ----

  private render(): void {
    this.innerHTML = '';
    this.rows.clear();
    this.clipEls.clear();
    const arr = store.data.arrangement;
    const px = this.pxPerBar();
    const bars = this.songBarsCount();

    this.appendChild(this.buildToolbar());

    const scroll = document.createElement('div');
    scroll.className = 'arrange-scroll';
    scroll.addEventListener('scroll', () => (this.viewDirty = true));

    // sticky ruler row: corner (sticky left) + viewport-wide canvas (sticky left, redrawn on scroll)
    const rulerRow = document.createElement('div');
    rulerRow.className = 'arrange-ruler-row';
    rulerRow.style.width = `${HEAD_W + bars * px}px`;
    const corner = document.createElement('div');
    corner.className = 'arrange-corner';
    const ruler = document.createElement('canvas');
    ruler.className = 'arrange-ruler';
    ruler.title = 'Bars';
    rulerRow.append(corner, ruler);
    scroll.appendChild(rulerRow);

    const grid = gridBackgroundBars(px, this.snapBeats());
    const anySolo = arr.tracks.some((t) => t.solo && !t.muted);
    for (const track of arr.tracks) {
      scroll.appendChild(this.buildTrackRow(track, bars, px, grid, anySolo));
    }

    const playhead = document.createElement('div');
    playhead.className = 'arrange-playhead hidden';
    scroll.appendChild(playhead);

    this.appendChild(scroll);
    this.viewDirty = true;
  }

  private buildToolbar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'toolbar';
    const iconBtn = (title: string, svg: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.title = title;
      b.innerHTML = svg;
      b.onclick = fn;
      return b;
    };

    const palette = document.createElement('select');
    palette.title = 'Pick an item, then click a lane to place it';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— place… —';
    palette.appendChild(none);
    const group = (label: string): HTMLOptGroupElement => {
      const g = document.createElement('optgroup');
      g.label = label;
      palette.appendChild(g);
      return g;
    };
    const seqGroup = group('Sequences');
    for (const seq of store.data.sequences) {
      const opt = document.createElement('option');
      opt.value = `seq:${seq.id}`;
      opt.textContent = seq.name;
      opt.selected = this.palette === opt.value;
      seqGroup.appendChild(opt);
    }
    const padGroup = group('Pads');
    for (const [index, pad] of store.data.pads.entries()) {
      if (!pad) continue;
      const opt = document.createElement('option');
      opt.value = `pad:${index}`;
      opt.textContent = pad.name;
      opt.selected = this.palette === opt.value;
      padGroup.appendChild(opt);
    }
    const files = new Set<string>();
    for (const p of store.data.patches) if (p.wavFile) files.add(p.wavFile);
    for (const pad of store.data.pads) if (pad?.file) files.add(pad.file);
    const fileGroup = group('Files');
    for (const f of files) {
      const opt = document.createElement('option');
      opt.value = `file:${f}`;
      opt.textContent = f.split('/').pop() ?? f;
      opt.selected = this.palette === opt.value;
      fileGroup.appendChild(opt);
    }
    palette.onchange = (): void => {
      this.palette = palette.value;
      updateUi((s) => (s.arrange.palette = palette.value));
    };

    const snap = document.createElement('select');
    snap.title = 'Placing/moving/resizing snaps to this grid';
    for (const { beats, label } of SNAP_BEATS) {
      const opt = document.createElement('option');
      opt.value = String(beats);
      opt.textContent = label;
      opt.selected = this.snapBeats() === beats;
      snap.appendChild(opt);
    }
    snap.onchange = (): void => {
      updateUi((s) => (s.arrange.snapBeats = Number(snap.value)));
      this.render();
    };

    const lengthWrap = document.createElement('label');
    lengthWrap.className = 'arrange-length';
    lengthWrap.title = `Song length in bars (1–${MAX_BARS})`;
    lengthWrap.textContent = 'Bars ';
    const length = document.createElement('input');
    length.type = 'number';
    length.min = '1';
    length.max = String(MAX_BARS);
    length.value = String(this.songBarsCount());
    length.onchange = (): void => {
      const v = Math.max(1, Math.min(MAX_BARS, Math.round(Number(length.value) || 1)));
      store.update((d) => (d.arrangement.bars = v));
      this.render();
    };
    lengthWrap.appendChild(length);

    const zoom = (dir: 1 | -1): void => {
      const i = PX_PER_BAR_STEPS.indexOf(this.pxPerBar());
      const next = PX_PER_BAR_STEPS[Math.max(0, Math.min(PX_PER_BAR_STEPS.length - 1, (i < 0 ? 4 : i) + dir))];
      updateUi((s) => (s.arrange.pxPerBar = next));
      this.render();
    };

    const addTrack = document.createElement('button');
    addTrack.textContent = '+ Track';
    addTrack.title = 'Add a track';
    addTrack.onclick = (): void => {
      store.update((d) =>
        d.arrangement.tracks.push({
          id: uid(),
          name: `Track ${d.arrangement.tracks.length + 1}`,
          gain: 0.9,
          plugins: [],
          clips: [],
        }),
      );
      this.render();
    };

    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export song WAV';
    exportBtn.title = 'Render the whole song offline and write it to exports/';
    exportBtn.onclick = (): void => void this.exportSong();

    bar.append(
      transportButton('play', 'Play the song (Space)', () => void this.play()),
      transportButton('stop', 'Stop (Space)', () => {
        this.stop();
        if (engine.started) engine.stop();
      }),
      palette,
      snap,
      lengthWrap,
      iconBtn('Zoom out (fewer px per bar)', ICONS.zoomOut, () => zoom(-1)),
      iconBtn('Zoom in (more px per bar)', ICONS.zoomIn, () => zoom(1)),
      addTrack,
      exportBtn,
    );
    return bar;
  }

  private buildTrackRow(
    track: ArrangeTrack,
    bars: number,
    px: number,
    grid: { image: string; size: string },
    anySolo: boolean,
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'arrange-track';
    wrap.classList.toggle('muted', !!track.muted);
    wrap.classList.toggle('soloed', !!track.solo);
    wrap.classList.toggle('other-solo', anySolo && !track.solo && !track.muted);
    wrap.style.width = `${HEAD_W + bars * px}px`;

    const head = document.createElement('div');
    head.className = 'arrange-head';
    const name = document.createElement('span');
    name.className = 'arrange-track-name';
    name.textContent = track.name;
    name.title = 'Click to rename';
    name.onclick = (): void => {
      const next = prompt('Track name', track.name);
      if (!next) return;
      store.update(() => (track.name = next));
      this.render();
    };

    const iconBtn = (title: string, svg: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.title = title;
      b.innerHTML = svg;
      b.onclick = fn;
      return b;
    };
    const muteBtn = iconBtn('Mute track', ICONS.mute, () => {
      store.update(() => (track.muted = !track.muted));
      this.render();
    });
    muteBtn.classList.add('mute-btn');
    muteBtn.classList.toggle('active', !!track.muted);
    const soloBtn = iconBtn('Solo track — only soloed tracks play', ICONS.solo, () => {
      store.update(() => (track.solo = !track.solo));
      this.render();
    });
    soloBtn.classList.add('solo-btn');
    soloBtn.classList.toggle('active', !!track.solo);
    const fxBtn = iconBtn('Track effects', ICONS.fx, () => {
      void engine.ensureStarted().then(() => this.openTrackFx(track));
    });
    fxBtn.classList.add('fx-btn');
    fxBtn.classList.toggle('has-fx', track.plugins.length > 0);
    const dupBtn = iconBtn('Duplicate track', ICONS.copy, () => {
      store.update((d) => {
        const copy: ArrangeTrack = JSON.parse(JSON.stringify(track)) as ArrangeTrack;
        copy.id = uid();
        copy.name = `${track.name} copy`;
        for (const p of copy.plugins) p.id = uid();
        for (const c of copy.clips) {
          c.id = uid();
          for (const p of c.plugins) p.id = uid();
        }
        d.arrangement.tracks.splice(d.arrangement.tracks.indexOf(track) + 1, 0, copy);
      });
      this.render();
    });
    const delBtn = iconBtn('Remove track', '✕', () => {
      this.liveTrackNodes.get(track.id)?.chain.teardown();
      this.liveTrackNodes.delete(track.id);
      store.update((d) => {
        d.arrangement.tracks = d.arrangement.tracks.filter((t) => t.id !== track.id);
      });
      this.render();
    });

    const controls = document.createElement('div');
    controls.className = 'arrange-head-controls';
    controls.append(
      muteBtn,
      soloBtn,
      fxBtn,
      knob({ label: 'Gain', min: 0, max: 1.2, step: 0.01, value: track.gain }, (v) => {
        track.gain = v;
        const nodes = this.liveTrackNodes.get(track.id);
        if (nodes) nodes.inGain.gain.value = v;
        store.scheduleSave();
      }),
      dupBtn,
      delBtn,
    );
    head.append(name, controls);

    const row = document.createElement('div');
    row.className = 'arrange-row';
    row.style.width = `${bars * px}px`;
    row.style.backgroundImage = grid.image;
    row.style.backgroundSize = grid.size;
    row.title = 'Click: place the palette item · drag a clip: move · right edge: resize · double-click: clip FX · Delete: remove selected';
    this.rows.set(track.id, row);

    wrap.append(head, row);
    return wrap;
  }

  private flash(msg: string): void {
    const el = document.createElement('div');
    el.className = 'flash';
    el.textContent = msg;
    this.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }
}

customElements.define('arrange-tab', ArrangeTab);
```

Compiler note: the Task-5/6/7 stubs (`buildClip`, `openTrackFx`, `openClipFx`, `onKeydown`) use `_`-prefixed parameters so `noUnusedParameters` passes; `ArrangeClip`/`floorSnapBar` etc. are only imported once actually used — import exactly what this file version uses or the build fails on `noUnusedLocals`. If `clipEls`/`selectedClipId` trip `noUnusedLocals` at this stage, reference them in `syncClips()`'s body with a comment-free no-op is NOT acceptable — instead keep them out until Task 5 adds them (delete the two field declarations from this step and add them back in Task 5 along with their uses).

- [ ] **Step 3: Replace the `.arrange-*` CSS block** — in `src/style.css`, delete the existing rules `.arrange-lanes`, `.arrange-row`, `.arrange-cell`, `.arrange-cell.bar-start`, `.arrange-cell:hover`, `.arrange-clip` (+ `.seq`/`.smp`/`.pad` variants), `.arrange-track.muted` and add:

```css
:root {
  --accent-3: #b794f4;
}

.arrange-scroll {
  position: relative;
  overflow: auto;
  max-height: calc(100vh - 160px);
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-panel);
}

.arrange-ruler-row {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  height: 22px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border);
}

.arrange-corner {
  position: sticky;
  left: 0;
  z-index: 1;
  flex: none;
  width: 150px;
  background: var(--bg-card);
  border-right: 1px solid var(--border);
}

.arrange-ruler {
  position: sticky;
  left: 150px;
  display: block;
  height: 22px;
}

.arrange-track {
  display: flex;
  border-bottom: 1px solid var(--border);
}

.arrange-track.muted {
  opacity: 0.45;
}

.arrange-track.other-solo {
  opacity: 0.6;
}

.arrange-track.soloed .arrange-head {
  border-left: 3px solid var(--accent);
}

.arrange-head {
  position: sticky;
  left: 0;
  z-index: 2;
  flex: none;
  width: 150px;
  padding: 4px 6px;
  background: var(--bg-card);
  border-right: 1px solid var(--border);
  border-left: 3px solid transparent;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}

.arrange-track-name {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: text;
}

.arrange-head-controls {
  display: flex;
  align-items: center;
  gap: 2px;
}

.arrange-head-controls button {
  padding: 2px 4px;
  line-height: 0;
}

.arrange-head-controls .knob {
  transform: scale(0.7);
  transform-origin: left center;
}

.fx-btn.has-fx {
  color: var(--accent-2);
  border-color: var(--accent-2);
}

.arrange-row {
  position: relative;
  flex: none;
  height: 48px;
  background-color: var(--bg-panel);
  cursor: crosshair;
}

.arrange-clip {
  position: absolute;
  top: 4px;
  height: 40px;
  border-radius: 4px;
  font-size: 11px;
  color: #10231f;
  padding: 3px 6px;
  overflow: hidden;
  white-space: nowrap;
  cursor: grab;
  user-select: none;
  touch-action: none;
  box-shadow: 0 0 5px rgb(0 0 0 / 40%);
}

.arrange-clip.seq {
  background: var(--accent);
}

.arrange-clip.pad {
  background: var(--accent-2);
}

.arrange-clip.file {
  background: var(--accent-3);
}

.arrange-clip.selected {
  outline: 2px solid #fff;
}

.arrange-clip.has-fx::after {
  content: '';
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #10231f;
}

.arrange-clip .clip-resize {
  position: absolute;
  top: 0;
  right: 0;
  width: 7px;
  height: 100%;
  cursor: ew-resize;
  background: rgb(0 0 0 / 25%);
  border-radius: 0 4px 4px 0;
}

.arrange-playhead {
  position: absolute;
  top: 22px;
  bottom: 0;
  width: 2px;
  background: var(--accent-2);
  box-shadow: 0 0 6px var(--accent-2);
  pointer-events: none;
  z-index: 2;
}

.arrange-playhead.hidden {
  display: none;
}

.arrange-length input {
  width: 60px;
}

.fx-dialog {
  position: fixed;
  top: 15vh;
  left: 50%;
  transform: translateX(-50%);
  z-index: 60;
  min-width: 420px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  padding: 12px;
}
```

(Check how `.master-dialog` is styled in `style.css` and mirror its background/border/z-index values if they differ from the above.)

- [ ] **Step 4: Verify build + in browser**

Run: `npm run build` → clean. Run: `npm test` → pass.
In the browser (dev server + puppeteer or manually): Arrange tab shows toolbar (palette with optgroups, snap select, Bars input, two magnify buttons), ruler with bar numbers, tracks with left-docked heads (rename via click, duplicate, delete, mute/solo icon buttons, gain knob, FX button), lanes with vertical gridlines; changing snap changes gridline density; changing Bars changes timeline width; zoom buttons change bar width and ruler label density; horizontal scroll keeps heads and ruler pinned. No console errors.

- [ ] **Step 5: Commit**

```bash
git add src/core/ui-state.ts src/modules/arrange/arrange-tab.ts src/style.css
git commit -m "Arrange: new timeline layout with sticky heads, bar ruler, snap gridlines, zoom, song length"
```

---

### Task 5: Clip rendering + virtualization

**Files:**
- Modify: `src/modules/arrange/arrange-tab.ts`

**Interfaces:**
- Consumes: `visibleBarRange` from `timeline-math.ts`; `clipSpanBars`/`clipBars` from `song-graph.ts`; `rows`/`clipEls` maps from Task 4.
- Produces: working `syncClips()` + `buildClip()`; `clipLabel(ref)` helper. Interactions still minimal (click selects). Task 6 replaces `buildClip`'s pointer handling.

- [ ] **Step 1: Implement `syncClips()`** — replace the stub (add `visibleBarRange` to the timeline-math import and `clipBars` stays available from song-graph):

```ts
  private syncClips(): void {
    const scroll = this.querySelector<HTMLElement>('.arrange-scroll');
    if (!scroll) return;
    const px = this.pxPerBar();
    const barSeconds = this.barSeconds();
    const range = visibleBarRange(scroll.scrollLeft, scroll.clientWidth, px, this.songBarsCount());
    const wanted = new Set<string>();
    for (const track of store.data.arrangement.tracks) {
      const row = this.rows.get(track.id);
      if (!row) continue;
      for (const clip of track.clips) {
        const span = clipSpanBars(clip, barSeconds);
        if (clip.bar + span < range.from || clip.bar > range.to) continue;
        wanted.add(clip.id);
        let el = this.clipEls.get(clip.id);
        if (!el) {
          el = this.buildClip(track, clip, row);
          this.clipEls.set(clip.id, el);
          row.appendChild(el);
        }
        el.style.left = `${clip.bar * px}px`;
        el.style.width = `${Math.max(4, span * px)}px`;
      }
    }
    for (const [id, el] of this.clipEls) {
      if (wanted.has(id)) continue;
      el.remove();
      this.clipEls.delete(id);
    }
  }
```

- [ ] **Step 2: Implement `buildClip()` + label** — replace the stub:

```ts
  private clipLabel(ref: ArrangeClip['ref']): string {
    if (ref.type === 'sequence') return store.data.sequences.find((s) => s.id === ref.id)?.name ?? '?';
    if (ref.type === 'pad') return store.data.pads[ref.index]?.name ?? '?';
    return ref.file.split('/').pop() ?? '?';
  }

  private buildClip(track: ArrangeTrack, clip: ArrangeClip, row: HTMLElement): HTMLElement {
    const el = document.createElement('div');
    el.className = `arrange-clip ${clip.ref.type === 'sequence' ? 'seq' : clip.ref.type}`;
    el.classList.toggle('selected', this.selectedClipId === clip.id);
    el.classList.toggle('has-fx', clip.plugins.length > 0);
    el.textContent = this.clipLabel(clip.ref);
    el.title = `${this.clipLabel(clip.ref)} — drag: move · double-click: FX · Delete: remove`;
    if (clip.ref.type !== 'sequence') {
      const handle = document.createElement('div');
      handle.className = 'clip-resize';
      handle.title = 'Drag to trim';
      el.appendChild(handle);
    }
    this.attachClipPointer(track, clip, el, row); // Task 6; until then add a plain click-select:
    return el;
  }
```

For this task, instead of `attachClipPointer` (which lands in Task 6), wire selection directly:

```ts
    el.onclick = (e): void => {
      e.stopPropagation();
      this.selectClip(clip.id);
    };
```

and add:

```ts
  private selectClip(id: string | null): void {
    this.selectedClipId = id;
    for (const [cid, cel] of this.clipEls) cel.classList.toggle('selected', cid === id);
  }
```

- [ ] **Step 3: Wire click-to-place on lanes** — in `buildTrackRow`, after `this.rows.set(track.id, row);` add (import `floorSnapBar` from timeline-math):

```ts
    row.onclick = (e): void => {
      if (e.target !== row || !this.palette) return;
      const bar = floorSnapBar((e.clientX - row.getBoundingClientRect().left) / px, this.snapBeats());
      if (bar >= bars) return;
      const ref = this.palette.startsWith('seq:')
        ? { type: 'sequence' as const, id: this.palette.slice(4) }
        : this.palette.startsWith('pad:')
          ? { type: 'pad' as const, index: Number(this.palette.slice(4)) }
          : { type: 'file' as const, file: this.palette.slice(5) };
      store.update(() => track.clips.push({ id: uid(), bar, ref, gain: 1, plugins: [] }));
      this.viewDirty = true;
    };
```

Note `this.viewDirty = true` instead of `this.render()` — the rAF sync picks the new clip up without rebuilding the tab (no lost scroll position).

- [ ] **Step 4: Verify in browser**

Build clean; in the browser: place sequence/pad/file clips at snapped fractional positions (e.g. snap "1 beat", click mid-bar → clip starts on a beat line); clips show correct colors (seq teal, pad orange, file purple) and widths; scroll far right and back — clip elements are removed/re-added (check `document.querySelectorAll('.arrange-clip').length` stays bounded at high scroll on a project with many clips); clicking a clip selects it (white outline). Play — placed clips sound at the right time; playhead moves and auto-scrolls.

- [ ] **Step 5: Commit**

```bash
git add src/modules/arrange/arrange-tab.ts
git commit -m "Arrange: virtualized clip rendering, snapped click-to-place, selection"
```

---

### Task 6: Clip interactions — drag-move, cross-track, resize, delete

**Files:**
- Modify: `src/modules/arrange/arrange-tab.ts`

**Interfaces:**
- Consumes: `nearestSnapBar`, `floorSnapBar`, `minSpanBars` (timeline-math), `clipSpanBars` (song-graph).
- Produces: `attachClipPointer(track, clip, el, row)` replacing Step-2's plain `onclick`; Delete/Backspace handling in `onKeydown`.

- [ ] **Step 1: Implement `attachClipPointer`** — modeled on `buildClip`'s `onpointerdown` in `src/modules/sequence/sequence-tab.ts:677` (Manhattan threshold, pointer capture, lane rect hit-test), with a 4px threshold and bar units:

```ts
  private attachClipPointer(track: ArrangeTrack, clip: ArrangeClip, el: HTMLElement, row: HTMLElement): void {
    el.ondblclick = (): void => this.openClipFx(track, clip);
    el.onpointerdown = (e): void => {
      e.stopPropagation();
      const handle = el.querySelector('.clip-resize');
      const resizing = handle !== null && e.target === handle;
      const px = this.pxPerBar();
      const snap = this.snapBeats();
      const barSeconds = this.barSeconds();
      const startSpan = clipSpanBars(clip, barSeconds);
      const start = { x: e.clientX, y: e.clientY, bar: clip.bar, span: startSpan };
      const bars = this.songBarsCount();
      let moved = false;
      let targetTrack = track;
      el.setPointerCapture(e.pointerId);
      el.onpointermove = (m): void => {
        if (!moved && Math.abs(m.clientX - start.x) + Math.abs(m.clientY - start.y) < 4) return;
        moved = true;
        const deltaBars = (m.clientX - start.x) / px;
        if (resizing) {
          const span = Math.max(minSpanBars(snap), nearestSnapBar(start.span + deltaBars, snap));
          clip.bars = Math.min(bars - clip.bar, span);
          el.style.width = `${Math.max(4, clip.bars * px)}px`;
        } else {
          clip.bar = Math.max(0, Math.min(bars - startSpan, floorSnapBar(start.bar + deltaBars, snap)));
          el.style.left = `${clip.bar * px}px`;
          const rowRect = row.getBoundingClientRect();
          for (const [tid, otherRow] of this.rows) {
            const r = otherRow.getBoundingClientRect();
            if (m.clientY >= r.top && m.clientY <= r.bottom) {
              targetTrack = store.data.arrangement.tracks.find((t) => t.id === tid) ?? track;
              el.style.transform = `translateY(${r.top - rowRect.top}px)`;
              break;
            }
          }
        }
      };
      el.onpointerup = (): void => {
        el.onpointermove = null;
        el.onpointerup = null;
        el.style.transform = '';
        if (!moved) {
          this.selectClip(clip.id);
          return;
        }
        store.update(() => {
          if (targetTrack !== track) {
            track.clips.splice(track.clips.indexOf(clip), 1);
            targetTrack.clips.push(clip);
          }
        });
        this.render(); // re-parents the clip element into the target row + refreshes maps
        if (this.activeSong) void this.play(); // hear edits immediately, matching the sequence tab
      };
    };
  }
```

In `buildClip`, replace the temporary `el.onclick` from Task 5 with `this.attachClipPointer(track, clip, el, row);` (keep `selectClip`). Note the sequence-tab precedent deliberately avoids `preventDefault` in pointerdown so dblclick still fires.

- [ ] **Step 2: Implement `onKeydown`** — replace the stub:

```ts
  private onKeydown(e: KeyboardEvent): void {
    if (!this.classList.contains('active-tab')) return;
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;
    const id = this.selectedClipId;
    if (!id) return;
    e.preventDefault();
    store.update((d) => {
      for (const t of d.arrangement.tracks) {
        const i = t.clips.findIndex((c) => c.id === id);
        if (i >= 0) t.clips.splice(i, 1);
      }
    });
    this.selectedClipId = null;
    this.clipEls.get(id)?.remove();
    this.clipEls.delete(id);
    this.viewDirty = true;
  }
```

- [ ] **Step 3: Verify in browser**

Drag a clip: below 4px does nothing (release = select); beyond, it moves snapped to the grid; drag vertically over another lane and release — clip lands on that track; drag a pad/file clip's right edge — width snaps and playback stops early at the trimmed length (place a long file clip, trim to 1 beat, Play: it cuts off); a sequence clip has no resize handle; Delete removes the selected clip; typing in the Bars input does NOT delete clips on Backspace. Reload the page — moved/trimmed clips persist (fractional `bar`/`bars` round-trip through project.json).

- [ ] **Step 4: Commit**

```bash
git add src/modules/arrange/arrange-tab.ts
git commit -m "Arrange: clip drag-move with cross-track retargeting, trim-resize, Delete-key removal"
```

---

### Task 7: Shared FX dialog for tracks and clips

**Files:**
- Modify: `src/modules/arrange/arrange-tab.ts`

**Interfaces:**
- Consumes: `PluginChainEl.bind(input, output, plugins, onChange)` / `.teardown()` (same contract Phase A used); `knob()`.
- Produces: working `openTrackFx(track)` / `openClipFx(track, clip)`; one `<dialog class="fx-dialog">` per tab instance.

- [ ] **Step 1: Add the dialog to `render()`** — at the end of `render()`, before `this.viewDirty = true;`:

```ts
    const dialog = document.createElement('dialog');
    dialog.className = 'fx-dialog';
    dialog.innerHTML = `<div class="fx-dialog-head"><h3 class="fx-title"></h3><button class="close-fx" title="Close">✕</button></div><div class="fx-extra"></div><div class="fx-slot"></div>`;
    dialog.querySelector<HTMLButtonElement>('.close-fx')!.onclick = (): void => dialog.close();
    dialog.onclose = (): void => this.closeFxContent();
    this.appendChild(dialog);
```

Add the head CSS to the `.fx-dialog` block in `src/style.css`:

```css
.fx-dialog-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.fx-dialog-head h3 {
  margin: 0;
  font-size: 14px;
}
```

- [ ] **Step 2: Implement open/close** — replace the two stubs and add the teardown holder field:

```ts
  private clipFxTeardown: (() => void) | null = null;

  private fxDialog(): { dialog: HTMLDialogElement; title: HTMLElement; extra: HTMLElement; slot: HTMLElement } {
    const dialog = this.querySelector<HTMLDialogElement>('.fx-dialog')!;
    return {
      dialog,
      title: dialog.querySelector<HTMLElement>('.fx-title')!,
      extra: dialog.querySelector<HTMLElement>('.fx-extra')!,
      slot: dialog.querySelector<HTMLElement>('.fx-slot')!,
    };
  }

  private closeFxContent(): void {
    const { extra, slot } = this.fxDialog();
    this.clipFxTeardown?.();
    this.clipFxTeardown = null;
    extra.innerHTML = '';
    // a track's chain element stays alive (audio keeps running) — just unmount its DOM
    while (slot.firstChild) slot.firstChild.remove();
    this.render(); // refresh has-fx dots
  }

  private openTrackFx(track: ArrangeTrack): void {
    const { dialog, title, slot } = this.fxDialog();
    if (dialog.open) dialog.close(); // tears down any previous content first
    title.textContent = `${track.name} — track FX`;
    this.trackBus(track, engine.master); // ensure the live chain exists
    slot.appendChild(this.liveTrackNodes.get(track.id)!.chain);
    dialog.show();
  }

  private openClipFx(track: ArrangeTrack, clip: ArrangeClip): void {
    void engine.ensureStarted().then(() => {
      const { dialog, title, extra, slot } = this.fxDialog();
      if (dialog.open) dialog.close();
      title.textContent = `${this.clipLabel(clip.ref)} (${track.name}) — clip FX`;
      extra.appendChild(
        knob({ label: 'Clip gain', min: 0, max: 1.5, step: 0.01, value: clip.gain }, (v) => {
          clip.gain = v;
          store.scheduleSave();
        }),
      );
      // throwaway audio pair: the chain edits clip.plugins in place; audible on the clip's next play
      const inGain = new Tone.Gain(0).connect(engine.master);
      const chain = document.createElement('plugin-chain') as PluginChainEl;
      chain.bind(inGain, engine.master, clip.plugins, () => store.scheduleSave());
      this.clipFxTeardown = (): void => {
        chain.teardown();
        inGain.dispose();
      };
      slot.appendChild(chain);
      dialog.show();
    });
  }
```

Caution: `closeFxContent()` calls `this.render()`, which rebuilds the dialog element itself — that's fine (close → rebuild fresh closed dialog), but make sure `dialog.onclose` doesn't loop: `render()` creates a NEW dialog (closed, no content), the old one is discarded with the rest of `innerHTML = ''`. If `openTrackFx`'s `dialog.close()` triggering a re-render invalidates the locals, re-query after the close: call `this.fxDialog()` again after any `.close()` before using `title`/`slot`.

Simplest correct order (use this): in both open methods, first `this.querySelector<HTMLDialogElement>('.fx-dialog')!.close();` (no-op if closed) which fires `closeFxContent()` → `render()`, THEN re-query `const { dialog, title, extra, slot } = this.fxDialog();` and proceed.

- [ ] **Step 3: Verify in browser**

FX button on a track opens the dialog with its plugin chain; add a Reverb while the song plays — audible live on that track; close, dialog disappears, `has-fx` styling appears on the FX button; double-click a clip → clip FX dialog with a Clip gain knob + chain; add a plugin, close, clip shows the FX dot; Play — the clip's effect is audible; open track FX, then immediately open a clip FX (dialog swaps content cleanly, no console errors); no audio-node leak warnings after repeated open/close (spot-check `Tone.getContext().rawContext` state stays `running`).

- [ ] **Step 4: Commit**

```bash
git add src/modules/arrange/arrange-tab.ts src/style.css
git commit -m "Arrange: shared FX dialog edits track chains live and clip chains + gain in place"
```

---

### Task 8: Full regression + cleanup

**Files:**
- Possibly modify: anything the sweep flags.

- [ ] **Step 1: Automated checks**

Run: `npm test` → all pass. Run: `npm run build` → clean.

- [ ] **Step 2: Puppeteer sweep** — write `scripts/_tmp-verify-arrange-b.mjs` following the pattern used in Phase A (launch `C:\Program Files\Google\Chrome\Application\chrome.exe` headless via puppeteer-core against `http://localhost:5174`, trusted click for the audio gesture, collect `[pageerror]`). Cover, in one script: switch to Arrange tab; add 2 tracks; place a sequence clip and a pad clip via palette + `row.click()` at computed coordinates; assert `.arrange-clip.seq` and `.arrange-clip.pad` exist with px-based `style.left`; dispatch pointer events to drag a clip 2 bars right and assert `clip.bar` changed by 2 (read back via the DOM element's `style.left` / pxPerBar); set snap to "None" and assert lane `backgroundSize` changed; zoom in and assert clip width grew; toggle mute and assert `.arrange-track.muted`; play 1s and assert zero `[pageerror]` and `.arrange-playhead` is visible with increasing `style.left`; reload and assert the placed clips and song-length input value persist. Delete the script afterwards.

- [ ] **Step 3: Manual spot-check reminders for the user** (report, don't automate): audio of a trimmed clip cuts early; clip FX audible in export; ruler labels readable at min/max zoom.

- [ ] **Step 4: Commit any fixes; final status**

```bash
git status --short && git log --oneline -8
```

Report completion; ask push-to-origin vs. leave local (session convention).
