# Visual Equalizer Plugin — Design

Date: 2026-07-11 (revised same day: static average spectrum, dynamic bands,
active-state visibility)

## Goal

Upgrade the existing "EQ" plugin (id `eq`) into a visual parametric
equalizer: the user **adds** filter bands (HPF, BPF bell, BSF notch, LPF)
and drags their key points (cutoff/center frequency, gain, Q, slope) on a
canvas that shows gridlines and the **average spectrum of the underlying
audio** — fully editable while nothing is playing. Fixes the current
defects: the EQ canvas is usually dead (draw-loop lifecycle bug), shows
only an instantaneous live FFT (blank in silence), has no gridlines, and
draws no filter curves.

## Root-cause fixes folded in

1. **Detach-tolerant draw loop** (`src/plugins/spectrum-view.ts`): the rAF
   loop currently returns permanently the first time it fires while
   `canvas.isConnected` is false — guaranteed for track chains (created
   detached during playback) and after any FX-dialog close/reopen
   (`<plugin-chain>` deliberately detaches without dying). New behavior:
   while off-document the loop idles (keeps scheduling, skips drawing);
   it terminates only when the plugin's analyser is disposed. Fixes the
   Spectrum plugin too.
2. **Always-visible chrome**: grid, curves, and handles draw
   unconditionally — silence never looks broken.

## Background spectrum: average, not instantaneous

Like the Tone tab's static freq view (offline render → `magnitudeSpectrum`
→ log-axis plot), not a per-frame analyser trace.

- **Clip FX** (the dialog knows its clip): a `renderSource` callback is
  provided (see Plumbing) that offline-renders exactly that clip's audio —
  sequence, Beat, pad, or file — via the existing single-clip machinery
  (`resolveSong` + `scheduleSong` with just this clip inside
  `Tone.Offline`, pre-resolving buffers in the live context per the
  no-nested-Offline rule). The EQ FFTs the rendered buffer
  (`magnitudeSpectrum` in `src/core/dsp.ts`) and draws it dimmed behind
  the curves. Rendered once per dialog open; the render shows the PRE-EQ
  source signal.
- **Track/master FX** (no single buffer exists): fallback to an
  **accumulated average**: the plugin's analyser feeds a running average
  (per-bin exponential moving average while signal is present) that
  freezes when playback stops — play once, then edit in silence against
  the frozen average.

### Plumbing

`DawPlugin.createUI()` gains an optional context parameter:

```ts
export interface PluginUiContext {
  /** Offline-render the pre-FX source audio this chain is attached to, if known. */
  renderSource?: () => Promise<AudioBuffer | null>;
}
createUI(ctx?: PluginUiContext): HTMLElement;
```

`PluginChainEl.bind(...)` accepts an optional `PluginUiContext` and passes
it to every `createUI`. `arrange-tab.ts`'s `openClipFx` supplies
`renderSource` for its clip; `openTrackFx` and other hosts pass nothing.
Existing plugins ignore the parameter (backward-compatible).

## Bands: dynamic, user-added

The EQ starts with the migrated legacy bands (or HPF+LPF for a fresh
instance) and the user adds/removes bands freely.

| Type | Tone node | Key points |
|---|---|---|
| HPF | `Tone.Filter('highpass')` | cutoff (drag x), Q (drag y / wheel), slope 12/24/48 dB/oct (badge click cycles) |
| BPF | `Tone.Filter('peaking')` — bell boost/cut, the Tone tab's "BPF" meaning | center (drag x), gain ±24 dB (drag y), Q/width (wheel) |
| BSF | `Tone.Filter('notch')` | center (drag x), Q/width (drag y / wheel) |
| LPF | `Tone.Filter('lowpass')` | cutoff (drag x), Q (drag y / wheel), slope badge |

Audio graph: `input → band₁ → … → bandₙ → analyser (output)`, rebuilt
(rewired) only when a band is added/removed or toggled; param drags write
`Tone.Param` values in place. Disabled bands are set neutral (HPF→20 Hz,
LPF→20 kHz, BPF→0 dB, BSF→20 kHz at Q≥30) — kept in the chain so toggling
never rewires mid-drag.

### State (flat `Record<string, number>` per the plugin API)

`bands` (count) + per band `i`: `b{i}Type` (0=HPF 1=BPF 2=BSF 3=LPF),
`b{i}On` (0/1), `b{i}Freq`, `b{i}Q`, `b{i}Gain` (BPF), `b{i}Slope`
(HPF/LPF: 12/24/48). Defaults for a fresh instance: HPF 40 Hz Q 0.7
slope 12, LPF 18 kHz Q 0.7 slope 12.

**Migration:** `setState` detects legacy keys (`hpFreq` without `bands`)
and maps to three bands: HPF(hpFreq), BPF(peakFreq, peakGain), LPF(lpFreq).
Same plugin id `eq`; existing projects keep their sound.

## UI

Canvas ~360×160, log-frequency 20 Hz–20 kHz, ±24 dB curve axis:

- Gridlines + Hz/dB labels in the `scope-view.ts` style (reuse constants
  and `FREQ_LINES`).
- Averaged source spectrum dimmed behind (own −100..0 dB scale).
- Per-band response curve from `Tone.Filter.getFrequencyResponse()`
  (exact, no hand-rolled math), color-coded by type: HPF blue, BPF
  yellow, LPF red (reuse `HPF_TRACE`/`BPF_TRACE`/`LPF_TRACE`), BSF green
  (new constant). Combined response in white.
- One numbered circular handle per band at (freq → x; y = gain for BPF,
  Q-mapped rail for HPF/BSF/LPF). Disabled bands draw dim with a hollow
  handle. Drag/wheel/badge per the table; double-click a handle toggles
  the band.
- **Band strip** under the canvas: one chip per band (color dot, type
  label, freq readout, on/off checkbox, ✕ remove) + an **"+ band"
  button** with a four-way type picker. The chips are the always-obvious
  "what's active" answer at band level.
- Every edit dispatches the bubbling `plugin-state-changed` event.

## Active-state visibility in the plugin chain

In `<plugin-chain>` host chrome (`chain.ts` + `style.css`): a bypassed
plugin's card gets a `.bypassed` class — dimmed body, bypass button lit,
name struck through — so it is always clear which plugins in a chain are
actually processing. (Today the bypass button gives no persistent visual
state.) Applies to all plugins, not just the EQ.

## Pure math module (`src/plugins/eq-math.ts`, Tone-free)

Unit-tested: `freqToX/xToFreq`, `gainToY/yToGain`, `qToY/yToQ` (log Q
rail), `combineDb(perBandMagnitudes[])`, `hitTest(handles, px, py, r)`,
`migrateLegacyEqState(state)`, `bandsFromState/bandsToState`
(pack/unpack the flat record), `neutralBandValues(type)`, and the
per-bin EMA accumulator for the track/master fallback.

## Files

- Create: `src/plugins/eq-math.ts` + `src/plugins/eq-math.test.ts`
- Create: `src/plugins/equalizer.ts` (EqualizerPlugin + UI)
- Modify: `src/plugins/api.ts` (`PluginUiContext`, `createUI(ctx?)`)
- Modify: `src/plugins/spectrum-view.ts` (detach-tolerant loop)
- Modify: `src/plugins/chain.ts` (pass ctx through; `.bypassed` chrome)
- Modify: `src/modules/arrange/arrange-tab.ts` (`openClipFx` renderSource)
- Modify: `src/plugins/builtins.ts` (swap `eq` factory; delete old class)
- Modify: `src/style.css` (EQ canvas/handles/band strip; bypassed cards)

## Testing

- `eq-math.test.ts`: mapping round-trips, hit-test radius, legacy
  migration, pack/unpack round-trip through JSON, combined-dB math, EMA
  accumulator convergence and freeze.
- Existing suites stay green.
- Manual browser verification: add EQ to a sequence clip's FX with
  playback stopped → grid + average spectrum + curves visible
  immediately; add/remove/drag bands in silence; wheel Q; slope badge
  cycles; toggle via handle double-click and chips; bypass the EQ in the
  chain → card dims; close/reopen the FX dialog → canvas still live;
  track EQ accumulates its average during playback and freezes on stop;
  export a WAV and hear the filtering.
