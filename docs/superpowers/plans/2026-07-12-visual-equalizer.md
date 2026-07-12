# Visual Equalizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "EQ" plugin (id `eq`) with a visual parametric equalizer: dynamic draggable HPF/BPF/BSF/LPF bands over an averaged source spectrum, editable in silence, with fixed canvas lifecycle and clear active-state chrome.

**Architecture:** Pure math in `src/plugins/eq-math.ts` (unit-tested); the plugin (`src/plugins/equalizer.ts`) builds a dynamic `Tone.Filter` chain and draws curves from scratch `Tone.Filter.getFrequencyResponse()` clones; `spectrum-view.ts` gains a detach-tolerant shared rAF helper; `api.ts`/`chain.ts` gain an optional `PluginUiContext` so the Arrange clip-FX dialog can supply an offline `renderSource`.

**Tech Stack:** Vanilla TS + Web Components, Tone.js (`core/tone` shim only), Vitest. Spec: `docs/superpowers/specs/2026-07-11-visual-equalizer-design.md`.

## Global Constraints

- Never import from `'tone'` — only `'../core/tone'` (the shim).
- `src/plugins/eq-math.ts` must import no Tone (unit-tested under Vitest).
- Strict TS; `npm run build` = `tsc --noEmit` + vite. `noUnusedLocals`/`noUnusedParameters` on.
- No nested `Tone.Offline`: `renderSource` pre-resolves buffers via `resolveSong` in the live context, renders via `engine.runExclusive` + one `Tone.Offline`.
- Plugin state is a flat `Record<string, number>`; must survive JSON round-trip. Same plugin id `eq`; legacy state (`hpFreq`, `peakFreq`, `peakGain`, `lpFreq`) must migrate.
- Tone `Filter.getFrequencyResponse(len)` sample `i` is at frequency `(i/len)² · (20000−20) + 20` (verified in node_modules — BiquadFilter.js:82-87); map samples to x with this formula, never assume linear/log spacing.
- Band colors: HPF `#4da6ff`, BPF `#ffd24d`, LPF `#ff5c5c` (reuse `HPF_TRACE`/`BPF_TRACE`/`LPF_TRACE` from `src/modules/tone/scope-view.ts`), BSF `#6ee7a0` (new).
- The working tree carries ANOTHER SESSION's uncommitted changes (arrange-tab palette scanning, project-manager, app-shell, etc.). Never revert or restructure code you didn't write; when committing, stage ONLY the files your task names (for `arrange-tab.ts` in Task 5, stage that file only after confirming your hunks are the only NEW ones vs. the pre-task diff — the controller handles surgical staging if needed).
- No AI attribution in commit messages.

---

### Task 1: Pure EQ math — `src/plugins/eq-math.ts`

**Files:**
- Create: `src/plugins/eq-math.ts`
- Create: `src/plugins/eq-math.test.ts`

**Interfaces:**
- Produces (consumed by Task 4):

```ts
export type EqBandType = 0 | 1 | 2 | 3; // 0=HPF 1=BPF(bell) 2=BSF(notch) 3=LPF
export interface EqBand { type: EqBandType; on: boolean; freq: number; q: number; gain: number; slope: number }
export const EQ_FMIN = 20, EQ_FMAX = 20000, EQ_DB = 24; // curve axis ±24 dB
export const BAND_LABELS: Record<EqBandType, string>;   // 'HPF'|'BPF'|'BSF'|'LPF'
export function defaultEqBands(): EqBand[];             // [HPF 40Hz q0.7 slope12 on, LPF 18kHz q0.7 slope12 on]
export function bandsToState(bands: EqBand[]): Record<string, number>;
export function bandsFromState(state: Record<string, number>): EqBand[];
export function isLegacyEqState(state: Record<string, number>): boolean;
export function migrateLegacyEqState(state: Record<string, number>): EqBand[];
export function neutralBandValues(type: EqBandType): { freq: number; q: number; gain: number };
export function freqToX(f: number, w: number): number;
export function xToFreq(x: number, w: number): number;
export function gainToY(db: number, h: number): number;  // ±EQ_DB → canvas y
export function yToGain(y: number, h: number): number;
export function qToY(q: number, h: number): number;      // log rail, Q 0.1..30
export function yToQ(y: number, h: number): number;
export function responseFreq(i: number, len: number): number; // Tone's quadratic spacing
export function combineDb(perBand: Float32Array[]): number[]; // Σ 20·log10(mag) per sample
export interface EqHandle { band: number; x: number; y: number; badge?: { x: number; y: number; w: number; h: number } }
export function hitTest(handles: EqHandle[], x: number, y: number, r?: number): { band: number; part: 'handle' | 'badge' } | null;
export class SpectrumAverager { update(dbValues: Float32Array): void; current(): Float32Array | null }
```

- [ ] **Step 1: Write the failing tests**

Create `src/plugins/eq-math.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  bandsFromState, bandsToState, combineDb, defaultEqBands, EQ_DB, freqToX, gainToY,
  hitTest, isLegacyEqState, migrateLegacyEqState, neutralBandValues, qToY,
  responseFreq, SpectrumAverager, xToFreq, yToGain, yToQ,
} from './eq-math';

describe('eq-math mappings', () => {
  it('freq/x round-trips on a log axis', () => {
    for (const f of [20, 100, 1000, 12345, 20000]) {
      expect(xToFreq(freqToX(f, 360), 360)).toBeCloseTo(f, 6);
    }
    expect(freqToX(20, 360)).toBeCloseTo(0);
    expect(freqToX(20000, 360)).toBeCloseTo(360);
  });
  it('gain/y round-trips and pins the axis ends', () => {
    expect(gainToY(EQ_DB, 160)).toBeCloseTo(0);
    expect(gainToY(-EQ_DB, 160)).toBeCloseTo(160);
    expect(yToGain(gainToY(-7.5, 160), 160)).toBeCloseTo(-7.5, 6);
  });
  it('q/y round-trips on its log rail', () => {
    for (const q of [0.1, 0.7, 4, 30]) expect(yToQ(qToY(q, 160), 160)).toBeCloseTo(q, 6);
  });
  it('responseFreq matches Tone quadratic spacing', () => {
    expect(responseFreq(0, 256)).toBeCloseTo(20);
    expect(responseFreq(128, 256)).toBeCloseTo(0.25 * 19980 + 20);
  });
});

describe('eq-math state', () => {
  it('bands pack/unpack round-trips through JSON', () => {
    const bands = defaultEqBands();
    bands.push({ type: 1, on: false, freq: 900, q: 2, gain: -6, slope: 12 });
    const state = JSON.parse(JSON.stringify(bandsToState(bands)));
    expect(bandsFromState(state)).toEqual(bands);
  });
  it('migrates legacy EQ state to three bands', () => {
    const legacy = { hpFreq: 80, peakFreq: 1200, peakGain: -6, lpFreq: 9000 };
    expect(isLegacyEqState(legacy)).toBe(true);
    expect(isLegacyEqState(bandsToState(defaultEqBands()))).toBe(false);
    const bands = migrateLegacyEqState(legacy);
    expect(bands).toHaveLength(3);
    expect(bands[0]).toMatchObject({ type: 0, freq: 80, on: true });
    expect(bands[1]).toMatchObject({ type: 1, freq: 1200, gain: -6, on: true });
    expect(bands[2]).toMatchObject({ type: 3, freq: 9000, on: true });
  });
  it('neutral values silence each band type', () => {
    expect(neutralBandValues(0).freq).toBe(20);
    expect(neutralBandValues(3).freq).toBe(20000);
    expect(neutralBandValues(1).gain).toBe(0);
    expect(neutralBandValues(2)).toMatchObject({ freq: 20000 });
    expect(neutralBandValues(2).q).toBeGreaterThanOrEqual(30);
  });
});

describe('eq-math drawing helpers', () => {
  it('combines linear magnitudes into summed dB', () => {
    const flat = new Float32Array([1, 1]);
    const half = new Float32Array([0.5, 1]);
    const db = combineDb([flat, half]);
    expect(db[0]).toBeCloseTo(20 * Math.log10(0.5));
    expect(db[1]).toBeCloseTo(0);
  });
  it('hit-tests handles then badges within radius', () => {
    const handles = [
      { band: 0, x: 50, y: 80, badge: { x: 44, y: 92, w: 22, h: 12 } },
      { band: 1, x: 200, y: 40 },
    ];
    expect(hitTest(handles, 53, 77)).toEqual({ band: 0, part: 'handle' });
    expect(hitTest(handles, 55, 98)).toEqual({ band: 0, part: 'badge' });
    expect(hitTest(handles, 200, 60)).toBeNull();
    expect(hitTest(handles, 198, 43)).toEqual({ band: 1, part: 'handle' });
  });
  it('averager converges toward the input and ignores silent frames', () => {
    const avg = new SpectrumAverager();
    expect(avg.current()).toBeNull();
    for (let i = 0; i < 200; i++) avg.update(new Float32Array([-30, -60]));
    expect(avg.current()![0]).toBeCloseTo(-30, 1);
    avg.update(new Float32Array([-1000, -1000])); // silence — must not wash out
    expect(avg.current()![0]).toBeCloseTo(-30, 1);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run src/plugins/eq-math.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/plugins/eq-math.ts`**

```ts
/** Pure math for the visual Equalizer — Tone-free so it stays unit-testable. */

export type EqBandType = 0 | 1 | 2 | 3; // 0=HPF 1=BPF(bell) 2=BSF(notch) 3=LPF

export interface EqBand {
  type: EqBandType;
  on: boolean;
  freq: number;
  q: number;
  gain: number; // dB, BPF only (0 otherwise)
  slope: number; // 12|24|48 dB/oct, HPF/LPF only (12 otherwise)
}

export const EQ_FMIN = 20;
export const EQ_FMAX = 20000;
export const EQ_DB = 24;
const Q_MIN = 0.1;
const Q_MAX = 30;

export const BAND_LABELS: Record<EqBandType, string> = { 0: 'HPF', 1: 'BPF', 2: 'BSF', 3: 'LPF' };

export function defaultEqBands(): EqBand[] {
  return [
    { type: 0, on: true, freq: 40, q: 0.7, gain: 0, slope: 12 },
    { type: 3, on: true, freq: 18000, q: 0.7, gain: 0, slope: 12 },
  ];
}

export function bandsToState(bands: EqBand[]): Record<string, number> {
  const state: Record<string, number> = { bands: bands.length };
  bands.forEach((b, i) => {
    state[`b${i}Type`] = b.type;
    state[`b${i}On`] = b.on ? 1 : 0;
    state[`b${i}Freq`] = b.freq;
    state[`b${i}Q`] = b.q;
    state[`b${i}Gain`] = b.gain;
    state[`b${i}Slope`] = b.slope;
  });
  return state;
}

export function bandsFromState(state: Record<string, number>): EqBand[] {
  const count = Math.max(0, Math.floor(state.bands ?? 0));
  const bands: EqBand[] = [];
  for (let i = 0; i < count; i++) {
    bands.push({
      type: (state[`b${i}Type`] ?? 0) as EqBandType,
      on: (state[`b${i}On`] ?? 1) !== 0,
      freq: state[`b${i}Freq`] ?? 1000,
      q: state[`b${i}Q`] ?? 0.7,
      gain: state[`b${i}Gain`] ?? 0,
      slope: state[`b${i}Slope`] ?? 12,
    });
  }
  return bands;
}

export function isLegacyEqState(state: Record<string, number>): boolean {
  return state.hpFreq !== undefined && state.bands === undefined;
}

/** Old 3-knob EQ (hpFreq/peakFreq/peakGain/lpFreq) → HPF + BPF + LPF bands. */
export function migrateLegacyEqState(state: Record<string, number>): EqBand[] {
  return [
    { type: 0, on: true, freq: state.hpFreq ?? 40, q: 0.7, gain: 0, slope: 12 },
    { type: 1, on: true, freq: state.peakFreq ?? 1000, q: 1, gain: state.peakGain ?? 0, slope: 12 },
    { type: 3, on: true, freq: state.lpFreq ?? 18000, q: 0.7, gain: 0, slope: 12 },
  ];
}

/** Values a disabled band applies so it stays wired but inaudible. */
export function neutralBandValues(type: EqBandType): { freq: number; q: number; gain: number } {
  if (type === 0) return { freq: 20, q: 0.7, gain: 0 };
  if (type === 3) return { freq: 20000, q: 0.7, gain: 0 };
  if (type === 1) return { freq: 1000, q: 1, gain: 0 };
  // notch: vanishingly narrow at the edge of hearing
  return { freq: 20000, q: 30, gain: 0 };
}

export function freqToX(f: number, w: number): number {
  return (Math.log(f / EQ_FMIN) / Math.log(EQ_FMAX / EQ_FMIN)) * w;
}

export function xToFreq(x: number, w: number): number {
  return EQ_FMIN * Math.pow(EQ_FMAX / EQ_FMIN, Math.min(1, Math.max(0, x / w)));
}

export function gainToY(db: number, h: number): number {
  return ((EQ_DB - db) / (2 * EQ_DB)) * h;
}

export function yToGain(y: number, h: number): number {
  const db = EQ_DB - (y / h) * 2 * EQ_DB;
  return Math.min(EQ_DB, Math.max(-EQ_DB, db));
}

/** Q on a log rail: top of canvas = Q_MAX, bottom = Q_MIN. */
export function qToY(q: number, h: number): number {
  const norm = Math.log(q / Q_MIN) / Math.log(Q_MAX / Q_MIN);
  return (1 - norm) * h;
}

export function yToQ(y: number, h: number): number {
  const norm = 1 - Math.min(1, Math.max(0, y / h));
  return Q_MIN * Math.pow(Q_MAX / Q_MIN, norm);
}

/** Frequency of Tone.Filter.getFrequencyResponse(len) sample i: quadratic 20..20k. */
export function responseFreq(i: number, len: number): number {
  const norm = Math.pow(i / len, 2);
  return norm * (EQ_FMAX - EQ_FMIN) + EQ_FMIN;
}

/** Combined response of several bands: per-sample sum of each band's dB. */
export function combineDb(perBand: Float32Array[]): number[] {
  if (perBand.length === 0) return [];
  const out = new Array<number>(perBand[0].length).fill(0);
  for (const mags of perBand) {
    for (let i = 0; i < out.length; i++) out[i] += 20 * Math.log10(Math.max(1e-6, mags[i]));
  }
  return out;
}

export interface EqHandle {
  band: number;
  x: number;
  y: number;
  badge?: { x: number; y: number; w: number; h: number };
}

/** Nearest handle within r px wins; badges checked after handles. */
export function hitTest(handles: EqHandle[], x: number, y: number, r = 8): { band: number; part: 'handle' | 'badge' } | null {
  let best: { band: number; part: 'handle' | 'badge' } | null = null;
  let bestDist = r;
  for (const hnd of handles) {
    const d = Math.hypot(hnd.x - x, hnd.y - y);
    if (d <= bestDist) {
      bestDist = d;
      best = { band: hnd.band, part: 'handle' };
    }
  }
  if (best) return best;
  for (const hnd of handles) {
    const b = hnd.badge;
    if (b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
      return { band: hnd.band, part: 'badge' };
    }
  }
  return null;
}

const SILENCE_DB = -95;
const EMA_ALPHA = 0.92;

/** Per-bin EMA of analyser dB frames; silent frames don't wash the average out. */
export class SpectrumAverager {
  private avg: Float32Array | null = null;

  update(dbValues: Float32Array): void {
    let loudest = -Infinity;
    for (let i = 0; i < dbValues.length; i++) if (dbValues[i] > loudest) loudest = dbValues[i];
    if (loudest <= SILENCE_DB) return; // freeze on silence
    if (!this.avg) {
      this.avg = new Float32Array(dbValues);
      return;
    }
    for (let i = 0; i < this.avg.length; i++) {
      this.avg[i] = EMA_ALPHA * this.avg[i] + (1 - EMA_ALPHA) * dbValues[i];
    }
  }

  current(): Float32Array | null {
    return this.avg;
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npx vitest run src/plugins/eq-math.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/eq-math.ts src/plugins/eq-math.test.ts
git commit -m "EQ: pure band-state, axis-mapping, response and averaging math"
```

---

### Task 2: Detach-tolerant canvas loop — `src/plugins/spectrum-view.ts`

**Files:**
- Modify: `src/plugins/spectrum-view.ts` (whole file below)

**Interfaces:**
- Produces: `startPluginCanvasLoop(canvas, isAlive, draw): () => void` (Task 4 uses it); `drawSpectrum(canvas, analyser)` keeps its signature (SpectrumPlugin in builtins.ts is untouched).

- [ ] **Step 1: Replace the file contents**

```ts
import * as Tone from '../core/tone';

/**
 * rAF loop for plugin canvases. Plugin UIs live inside <plugin-chain>,
 * which detaches from the DOM without dying (FX dialog close/reopen,
 * chains created during playback before any dialog shows them) — so the
 * loop must IDLE while the canvas is off-document, not terminate. It
 * terminates only when isAlive() is false (plugin disposed) or the
 * returned stop function is called.
 */
export function startPluginCanvasLoop(canvas: HTMLCanvasElement, isAlive: () => boolean, draw: () => void): () => void {
  let raf = 0;
  const frame = (): void => {
    if (!isAlive()) return;
    if (canvas.isConnected) draw();
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

/** Draw a live FFT spectrum onto a canvas until its analyser is disposed. */
export function drawSpectrum(canvas: HTMLCanvasElement, analyser: Tone.Analyser): () => void {
  const ctx = canvas.getContext('2d')!;
  const minDb = -100;
  const maxDb = 0;
  return startPluginCanvasLoop(
    canvas,
    () => !analyser.disposed,
    () => {
      const values = analyser.getValue() as Float32Array;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      for (let i = 0; i < values.length; i++) {
        // log-scale frequency axis
        const x = (Math.log(i + 1) / Math.log(values.length)) * w;
        const norm = (values[i] - minDb) / (maxDb - minDb);
        const y = h - Math.max(0, Math.min(1, norm)) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = '#4fd1c5';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    },
  );
}
```

(`Tone.Analyser` extends ToneAudioNode; `.disposed` is a public boolean on all Tone nodes.)

- [ ] **Step 2: Verify**

Run: `npm run build` — Expected: clean. Run: `npm test` — Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/plugins/spectrum-view.ts
git commit -m "Plugins: canvas draw loops idle while detached and die only on dispose"
```

---

### Task 3: Plugin UI context + bypass chrome — `api.ts`, `chain.ts`, `style.css`

**Files:**
- Modify: `src/plugins/api.ts`
- Modify: `src/plugins/chain.ts`
- Modify: `src/style.css`

**Interfaces:**
- Produces: `PluginUiContext { renderSource?: () => Promise<AudioBuffer | null> }`; `DawPlugin.createUI(ctx?: PluginUiContext)`; `PluginChainEl.bind(inNode, outNode, states, onChange, ctx?)`. Tasks 4-5 consume.

- [ ] **Step 1: api.ts**

Add above `DawPlugin` and change the `createUI` line:

```ts
/** Optional host context handed to plugin UIs (chain host decides what it knows). */
export interface PluginUiContext {
  /** Offline-render the pre-FX source audio this chain is attached to, if known. */
  renderSource?: () => Promise<AudioBuffer | null>;
}
```

```ts
  createUI(ctx?: PluginUiContext): HTMLElement;
```

(Existing plugin classes' `createUI(): HTMLElement` implementations remain assignable — a method taking fewer params satisfies the interface.)

- [ ] **Step 2: chain.ts**

Add a field + bind param and pass ctx to createUI (import the type from './api'):

```ts
  private ctx: PluginUiContext | undefined;
```

`bind(...)` gains a 5th optional param `ctx?: PluginUiContext` and sets `this.ctx = ctx;` before `this.rewire()`. In `render()`, `const ui = plugin.createUI();` → `const ui = plugin.createUI(this.ctx);`. Also make the bypass state visible: after `bypassBtn.textContent = ...` add `bypassBtn.classList.toggle('active', st.bypassed);` (the host already gets a `bypassed` class at chain.ts:108).

- [ ] **Step 3: style.css bypass chrome**

Add near the existing `.plugin-host` rules (grep for `plugin-host`):

```css
.plugin-host.bypassed > :not(.plugin-host-header) {
  opacity: 0.35;
  pointer-events: none;
}

.plugin-host.bypassed .plugin-name {
  text-decoration: line-through;
  color: var(--text-dim);
}

.plugin-host-header button.active {
  color: var(--accent-2);
  border-color: var(--accent-2);
}
```

- [ ] **Step 4: Verify + commit**

Run: `npm run build` && `npm test` — Expected: clean / all pass.

```bash
git add src/plugins/api.ts src/plugins/chain.ts src/style.css
git commit -m "Plugins: optional UI context for chains and visible bypass state"
```

---

### Task 4: The Equalizer plugin — `equalizer.ts` + registry swap

**Files:**
- Create: `src/plugins/equalizer.ts`
- Modify: `src/plugins/builtins.ts` (swap `eq` registry entry, delete old `EqPlugin` class)
- Modify: `src/style.css` (EQ styles at the end of the plugin section)

**Interfaces:**
- Consumes: everything from Task 1's eq-math export list, `startPluginCanvasLoop` (Task 2), `PluginUiContext` (Task 3), `magnitudeSpectrum` from `../core/dsp` (`(signal: Float32Array, maxSize?) => { mags: Float32Array; size: number }`).
- Produces: `export function equalizerFactory(): PluginFactory`-shaped object `EQ_FACTORY: PluginFactory` used by builtins.

- [ ] **Step 1: Create `src/plugins/equalizer.ts`**

```ts
import * as Tone from '../core/tone';
import { magnitudeSpectrum } from '../core/dsp';
import type { DawPlugin, PluginFactory, PluginMeta, PluginUiContext } from './api';
import { startPluginCanvasLoop } from './spectrum-view';
import {
  BAND_LABELS, bandsFromState, bandsToState, combineDb, defaultEqBands, EQ_FMAX, EQ_FMIN,
  freqToX, gainToY, hitTest, isLegacyEqState, migrateLegacyEqState, neutralBandValues, qToY,
  responseFreq, SpectrumAverager, xToFreq, yToGain, yToQ,
  type EqBand, type EqBandType, type EqHandle,
} from './eq-math';

const W = 360;
const H = 160;
const RESPONSE_LEN = 256;
const SLOPES = [12, 24, 48];
const BAND_COLORS: Record<EqBandType, string> = { 0: '#4da6ff', 1: '#ffd24d', 2: '#6ee7a0', 3: '#ff5c5c' };
const TONE_TYPES: Record<EqBandType, BiquadFilterType> = { 0: 'highpass', 1: 'peaking', 2: 'notch', 3: 'lowpass' };
const GRID = '#3d3d3d';
const LABEL = '#8a8f98';
const FREQ_LINES = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const FREQ_LABELS: Record<number, string> = { 100: '100', 1000: '1k', 10000: '10k' };

/** Visual parametric EQ: dynamic HPF/BPF/BSF/LPF bands, curves + averaged spectrum. */
class EqualizerPlugin implements DawPlugin {
  readonly meta: PluginMeta = { id: 'eq', name: 'EQ' };
  private inGain = new Tone.Gain(1);
  private analyser = new Tone.Analyser('fft', 1024);
  readonly input: Tone.ToneAudioNode = this.inGain;
  readonly output: Tone.ToneAudioNode = this.analyser;
  private bands: EqBand[] = defaultEqBands();
  private filters: Tone.Filter[] = [];
  /** Cached per-band response magnitudes (RESPONSE_LEN samples), recomputed on edits. */
  private curves: Float32Array[] = [];
  private averager = new SpectrumAverager();
  private staticSpectrum: { mags: Float32Array; size: number; sampleRate: number } | null = null;
  private redrawUi: (() => void) | null = null;

  constructor() {
    this.rebuild();
  }

  /** Tear down and rebuild the filter chain to match this.bands. */
  private rebuild(): void {
    this.inGain.disconnect();
    for (const f of this.filters) f.dispose();
    this.filters = this.bands.map((b) => new Tone.Filter({ frequency: b.freq, type: TONE_TYPES[b.type], Q: b.q }));
    let prev: Tone.ToneAudioNode = this.inGain;
    for (const f of this.filters) {
      prev.connect(f);
      prev = f;
    }
    prev.connect(this.analyser);
    this.bands.forEach((_, i) => this.applyBand(i));
    this.recomputeCurves();
  }

  /** Push one band's (possibly neutralized) values into its live filter. */
  private applyBand(i: number): void {
    const b = this.bands[i];
    const f = this.filters[i];
    if (!f) return;
    const v = b.on ? b : { ...b, ...neutralBandValues(b.type) };
    f.frequency.value = v.freq;
    f.Q.value = v.q;
    if (b.type === 1) (f as unknown as { gain: Tone.Param<'decibels'> }).gain.value = v.gain;
    if (b.type === 0 || b.type === 3) f.rolloff = -b.slope as Tone.FilterRollOff;
  }

  /** Exact response per band from a scratch filter built from the band MODEL (so off bands still preview). */
  private recomputeCurves(): void {
    this.curves = this.bands.map((b) => {
      const scratch = new Tone.Filter({ frequency: b.freq, type: TONE_TYPES[b.type], Q: b.q });
      if (b.type === 1) (scratch as unknown as { gain: Tone.Param<'decibels'> }).gain.value = b.gain;
      if (b.type === 0 || b.type === 3) scratch.rolloff = -b.slope as Tone.FilterRollOff;
      const mags = scratch.getFrequencyResponse(RESPONSE_LEN);
      scratch.dispose();
      return mags;
    });
    this.redrawUi?.();
  }

  private edited(target: HTMLElement): void {
    this.recomputeCurves();
    target.dispatchEvent(new CustomEvent('plugin-state-changed', { bubbles: true }));
  }

  getState(): Record<string, number> {
    return bandsToState(this.bands);
  }

  setState(state: Record<string, number>): void {
    this.bands = isLegacyEqState(state) ? migrateLegacyEqState(state) : bandsFromState(state);
    if (this.bands.length === 0) this.bands = defaultEqBands();
    this.rebuild();
  }

  dispose(): void {
    for (const f of this.filters) f.dispose();
    this.inGain.dispose();
    this.analyser.dispose();
  }

  createUI(ctx?: PluginUiContext): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'eq2-wrap';
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.className = 'eq2-canvas';
    wrap.appendChild(canvas);
    const strip = document.createElement('div');
    strip.className = 'eq2-strip';
    wrap.appendChild(strip);

    // pre-FX source spectrum, when the host knows what audio this chain carries
    if (ctx?.renderSource) {
      void ctx.renderSource().then((buffer) => {
        if (!buffer || this.analyser.disposed) return;
        this.staticSpectrum = { ...magnitudeSpectrum(buffer.getChannelData(0)), sampleRate: buffer.sampleRate };
      });
    }

    const cx = canvas.getContext('2d')!;
    let handles: EqHandle[] = [];

    const dbY = (db: number): number => ((0 - db) / 100) * H; // FFT −100..0 scale
    const drawSpectrumBg = (): void => {
      cx.strokeStyle = 'rgb(79 209 197 / 45%)';
      cx.lineWidth = 1;
      cx.beginPath();
      if (this.staticSpectrum) {
        const { mags, size, sampleRate } = this.staticSpectrum;
        let started = false;
        for (let k = 1; k < mags.length; k++) {
          const f = (k * sampleRate) / size;
          if (f < EQ_FMIN || f > EQ_FMAX) continue;
          const db = 20 * Math.log10(mags[k] + 1e-12);
          const y = Math.min(H, Math.max(0, dbY(db)));
          if (!started) { cx.moveTo(freqToX(f, W), y); started = true; }
          else cx.lineTo(freqToX(f, W), y);
        }
      } else {
        const avg = this.averager.current();
        if (!avg) return;
        const nyquist = Tone.getContext().sampleRate / 2;
        let started = false;
        for (let i = 1; i < avg.length; i++) {
          const f = (i / avg.length) * nyquist;
          if (f < EQ_FMIN || f > EQ_FMAX) continue;
          const y = Math.min(H, Math.max(0, dbY(avg[i])));
          if (!started) { cx.moveTo(freqToX(f, W), y); started = true; }
          else cx.lineTo(freqToX(f, W), y);
        }
      }
      cx.stroke();
    };

    const drawCurve = (mags: Float32Array, color: string, dim: boolean, width = 1.5): void => {
      cx.strokeStyle = color;
      cx.globalAlpha = dim ? 0.35 : 1;
      cx.lineWidth = width;
      cx.beginPath();
      for (let i = 1; i < mags.length; i++) {
        const x = freqToX(responseFreq(i, mags.length), W);
        const y = gainToY(20 * Math.log10(Math.max(1e-6, mags[i])), H);
        if (i === 1) cx.moveTo(x, Math.min(H, Math.max(0, y)));
        else cx.lineTo(x, Math.min(H, Math.max(0, y)));
      }
      cx.stroke();
      cx.globalAlpha = 1;
    };

    const draw = (): void => {
      cx.fillStyle = '#000';
      cx.fillRect(0, 0, W, H);
      // grid: freq lines + 0/±12 dB lines
      cx.strokeStyle = GRID;
      cx.lineWidth = 1;
      cx.beginPath();
      for (const f of FREQ_LINES) {
        const x = Math.round(freqToX(f, W)) + 0.5;
        cx.moveTo(x, 0);
        cx.lineTo(x, H);
      }
      for (const db of [-12, 0, 12]) {
        const y = Math.round(gainToY(db, H)) + 0.5;
        cx.moveTo(0, y);
        cx.lineTo(W, y);
      }
      cx.stroke();
      cx.fillStyle = LABEL;
      cx.font = '10px sans-serif';
      for (const f of FREQ_LINES) {
        const label = FREQ_LABELS[f];
        if (label) cx.fillText(label, freqToX(f, W) + 3, H - 4);
      }
      cx.fillText('+12', 2, gainToY(12, H) - 2);
      cx.fillText('-12', 2, gainToY(-12, H) - 2);
      if (!this.staticSpectrum) this.averager.update(this.analyser.getValue() as Float32Array);
      drawSpectrumBg();
      handles = [];
      this.bands.forEach((b, i) => {
        drawCurve(this.curves[i], BAND_COLORS[b.type], !b.on);
        const hx = freqToX(b.freq, W);
        const hy = b.type === 1 ? gainToY(b.gain, H) : qToY(b.q, H);
        const handle: EqHandle = { band: i, x: hx, y: hy };
        cx.beginPath();
        cx.arc(hx, hy, 5, 0, Math.PI * 2);
        cx.strokeStyle = BAND_COLORS[b.type];
        cx.lineWidth = 1.5;
        if (b.on) {
          cx.fillStyle = BAND_COLORS[b.type];
          cx.fill();
        }
        cx.stroke();
        cx.fillStyle = LABEL;
        cx.fillText(String(i + 1), hx + 7, hy - 6);
        if (b.type === 0 || b.type === 3) {
          const badge = { x: hx - 11, y: hy + 8, w: 22, h: 12 };
          cx.strokeStyle = GRID;
          cx.strokeRect(badge.x + 0.5, badge.y + 0.5, badge.w, badge.h);
          cx.fillText(String(b.slope), badge.x + 4, badge.y + 10);
          handle.badge = badge;
        }
        handles.push(handle);
      });
      const onCurves = this.bands.map((b, i) => (b.on ? this.curves[i] : null)).filter((c): c is Float32Array => c !== null);
      if (onCurves.length > 0) {
        const combined = combineDb(onCurves);
        cx.strokeStyle = '#fff';
        cx.lineWidth = 2;
        cx.beginPath();
        for (let i = 1; i < combined.length; i++) {
          const x = freqToX(responseFreq(i, combined.length), W);
          const y = Math.min(H, Math.max(0, gainToY(combined[i], H)));
          if (i === 1) cx.moveTo(x, y);
          else cx.lineTo(x, y);
        }
        cx.stroke();
      }
    };
    startPluginCanvasLoop(canvas, () => !this.analyser.disposed, draw);
    this.redrawUi = (): void => this.renderStrip(strip, wrap);

    // ---- interactions ----
    const canvasPos = (e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
    };
    let dragging = -1;
    canvas.onpointerdown = (e): void => {
      const { x, y } = canvasPos(e);
      const hit = hitTest(handles, x, y);
      if (!hit) return;
      const b = this.bands[hit.band];
      if (hit.part === 'badge') {
        b.slope = SLOPES[(SLOPES.indexOf(b.slope) + 1) % SLOPES.length];
        this.applyBand(hit.band);
        this.edited(wrap);
        return;
      }
      dragging = hit.band;
      canvas.setPointerCapture(e.pointerId);
    };
    canvas.onpointermove = (e): void => {
      if (dragging < 0) return;
      const { x, y } = canvasPos(e);
      const b = this.bands[dragging];
      b.freq = Math.round(xToFreq(x, W));
      if (b.type === 1) b.gain = Math.round(yToGain(y, H) * 2) / 2;
      else b.q = yToQ(y, H);
      this.applyBand(dragging);
      this.edited(wrap);
    };
    canvas.onpointerup = (): void => {
      dragging = -1;
    };
    canvas.ondblclick = (e): void => {
      const { x, y } = canvasPos(e);
      const hit = hitTest(handles, x, y);
      if (!hit) return;
      const b = this.bands[hit.band];
      b.on = !b.on;
      this.applyBand(hit.band);
      this.edited(wrap);
    };
    canvas.onwheel = (e): void => {
      const { x, y } = canvasPos(e);
      const hit = hitTest(handles, x, y, 16);
      if (!hit) return;
      e.preventDefault();
      const b = this.bands[hit.band];
      b.q = Math.min(30, Math.max(0.1, b.q * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      this.applyBand(hit.band);
      this.edited(wrap);
    };

    this.renderStrip(strip, wrap);
    return wrap;
  }

  /** Band chips (color dot, label, freq, on/off, remove) + add-band buttons. */
  private renderStrip(strip: HTMLElement, wrap: HTMLElement): void {
    strip.innerHTML = '';
    this.bands.forEach((b, i) => {
      const chip = document.createElement('span');
      chip.className = 'eq2-chip' + (b.on ? '' : ' off');
      const dot = document.createElement('span');
      dot.className = 'eq2-dot';
      dot.style.background = BAND_COLORS[b.type];
      const label = document.createElement('span');
      label.textContent = `${i + 1} ${BAND_LABELS[b.type]} ${b.freq >= 1000 ? `${(b.freq / 1000).toFixed(1)}k` : Math.round(b.freq)}`;
      const on = document.createElement('input');
      on.type = 'checkbox';
      on.checked = b.on;
      on.title = 'Band on/off';
      on.onchange = (): void => {
        b.on = on.checked;
        this.applyBand(i);
        this.edited(wrap);
      };
      const rm = document.createElement('button');
      rm.textContent = '✕';
      rm.title = 'Remove band';
      rm.onclick = (): void => {
        this.bands.splice(i, 1);
        this.rebuild();
        this.edited(wrap);
      };
      chip.append(dot, label, on, rm);
      strip.appendChild(chip);
    });
    for (const t of [0, 1, 2, 3] as EqBandType[]) {
      const add = document.createElement('button');
      add.className = 'eq2-add';
      add.textContent = `+${BAND_LABELS[t]}`;
      add.title = `Add a ${BAND_LABELS[t]} band`;
      add.onclick = (): void => {
        const fresh: EqBand = { type: t, on: true, freq: t === 0 ? 80 : t === 3 ? 8000 : 1000, q: t === 2 ? 4 : 1, gain: 0, slope: 12 };
        this.bands.push(fresh);
        this.rebuild();
        this.edited(wrap);
      };
      strip.appendChild(add);
    }
  }
}

export const EQ_FACTORY: PluginFactory = { meta: { id: 'eq', name: 'EQ' }, create: () => new EqualizerPlugin() };
```

Note for the implementer: `Tone.Filter.rolloff` setter rebuilds internal cascades — set it BEFORE reading `getFrequencyResponse`, as the code above does. If `BiquadFilterType` is not ambient, use `Tone.Filter`'s own type param string union instead (check how `patch-voice.ts` constructs typed filters).

- [ ] **Step 2: builtins.ts swap**

Delete the whole `EqPlugin` class and its registry line; add `import { EQ_FACTORY } from './equalizer';` and put `EQ_FACTORY,` in `PLUGIN_REGISTRY` where the old entry was (keep position #2 so the picker order is stable). Remove now-unused imports if any (`noUnusedLocals`).

- [ ] **Step 3: style.css**

Add after the `.spectrum-canvas` rules:

```css
.eq2-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.eq2-canvas {
  background: #000;
  border-radius: 4px;
  touch-action: none;
}

.eq2-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}

.eq2-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1px 6px;
}

.eq2-chip.off {
  opacity: 0.5;
}

.eq2-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.eq2-add {
  font-size: 11px;
  padding: 1px 6px;
}
```

- [ ] **Step 4: Verify + commit**

Run: `npm run build` — Expected: clean (this is the type gate; equalizer.ts imports Tone so has no unit tests). Run: `npm test` — Expected: all pass.

```bash
git add src/plugins/equalizer.ts src/plugins/builtins.ts src/style.css
git commit -m "EQ: visual parametric equalizer with draggable HPF/BPF/BSF/LPF bands"
```

---

### Task 5: Clip render source — `arrange-tab.ts`

**Files:**
- Modify: `src/modules/arrange/arrange-tab.ts` (`openClipFx` only)

**Interfaces:**
- Consumes: `PluginUiContext` (Task 3), existing `resolveSong`/`scheduleSong`/`createOfflineProvider`/`clipSpanBars` from `./song-graph`, `engine.runExclusive` (see `renderPatch` in `src/core/patch-voice.ts` for the pattern).

- [ ] **Step 1: Pass a renderSource into the clip chain**

In `openClipFx`, before `chain.bind(...)`, build:

```ts
      // pre-FX source render for plugin UIs (e.g. the EQ's average spectrum):
      // the clip alone, at bar 0, without its gain/FX — resolved in the LIVE
      // context first, then one Tone.Offline (never nested)
      const renderSource = async (): Promise<AudioBuffer | null> => {
        const barSeconds = this.barSeconds();
        const srcTrack: ArrangeTrack = {
          id: 'fx-src',
          name: 'fx-src',
          gain: 1,
          plugins: [],
          clips: [{ ...clip, bar: 0, gain: 1, plugins: [] }],
        };
        const resolved = await resolveSong([srcTrack]);
        const seconds = Math.min(30, clipSpanBars(clip, barSeconds) * barSeconds + 0.5);
        return engine.runExclusive(async () => {
          const rendered = await Tone.Offline(() => {
            scheduleSong([srcTrack], resolved, {
              songBus: Tone.getDestination(),
              startSeconds: 0,
              barSeconds,
              secondsPerStep: engine.secondsPerStep(),
              provider: createOfflineProvider(),
            });
          }, seconds);
          return rendered.get() as AudioBuffer;
        });
      };
```

then `chain.bind(inGain, engine.master, clip.plugins, () => store.scheduleSave(), { renderSource });`

Check imports: `clipSpanBars` and `createOfflineProvider` may already be imported from `./song-graph` — add whichever are missing. `engine.runExclusive` exists on the engine singleton (pattern: `src/core/patch-voice.ts` `renderPatch`).

CAUTION: this file carries another session's uncommitted changes AND an unaccepted play-cursor feature. Make ONLY this localized change inside `openClipFx`. Note `scheduleSong` may have an optional `fromBar` option in the working tree — omit it; the default preserves behavior.

- [ ] **Step 2: Verify + commit**

Run: `npm run build` && `npm test` — Expected: clean / all pass.

Do NOT `git add` the whole file blindly: first run `git diff src/modules/arrange/arrange-tab.ts` and confirm which hunks are yours; report to the controller if other-session hunks exist (the controller stages surgically).

---

### Task 6: End-to-end verification

**Files:** none.

- [ ] **Step 1:** `npm test` all pass; `npm run build` clean.
- [ ] **Step 2:** Audio smoke: dev server on 5199 (may already be running), `node scripts/audio-smoke.mjs` exits 0.
- [ ] **Step 3:** Manual browser checklist (controller/user):
  1. Add EQ to a sequence clip's FX with playback stopped → grid + averaged source spectrum + curves + handles visible immediately.
  2. Drag handles (freq/gain), wheel Q, slope badge cycles 12/24/48, double-click toggles; band chips add/remove/toggle; combined white curve updates.
  3. Bypass the EQ in the chain → card dims, name struck through, button lit.
  4. Close and reopen the FX dialog → canvas still animating (lifecycle fix).
  5. Track EQ (no renderSource): play → average accumulates; stop → freezes; edit in silence.
  6. Load a project whose old EQ state was saved by the 3-knob version → sounds the same, three bands appear.
  7. Export a WAV with an EQ'd clip → filtering audible offline.
