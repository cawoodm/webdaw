# Visual Equalizer Plugin — Design

Date: 2026-07-11

## Goal

Upgrade the existing "EQ" plugin (id `eq`) into a visual parametric
equalizer: four toggleable bands (HPF, BPF, BSF, LPF) edited by dragging
handles on a canvas that shows the live FFT spectrum behind the bands'
exact response curves. Fixes the "nothing is shown" defect: today the EQ
canvas is usually dead (draw-loop lifecycle bug) and, even when live,
draws no grid or curves, so a silent bus looks blank.

## Root-cause fixes folded in

1. **Detach-tolerant draw loop** (`src/plugins/spectrum-view.ts`):
   `drawSpectrum`'s rAF loop currently returns permanently the first time
   it fires while `canvas.isConnected` is false — guaranteed for track
   chains (created detached during playback) and after any FX-dialog
   close/reopen (`<plugin-chain>` deliberately detaches without dying; its
   DOM returns, its draw loops don't). New behavior: while the canvas is
   off-document the loop idles (keeps scheduling, skips drawing); it
   terminates only when `analyser.disposed` is true (set by the plugin's
   `dispose()`). The returned stop function remains for explicit teardown.
   This fixes the Spectrum plugin too.
2. **Always-visible chrome**: the Equalizer canvas draws its grid, band
   curves, and handles unconditionally — silence no longer looks broken.

## Bands and audio graph

Four `Tone.Filter`s in series (constructed in the active context, so
offline export works unchanged): `highpass → peaking → notch → lowpass`,
followed by the FFT `Tone.Analyser` (1024) as output — same topology
as the current EqPlugin, plus the notch.

| Band | Tone type | Draggable | Wheel |
|---|---|---|---|
| HPF | `highpass` | x = freq | Q (resonance) |
| BPF | `peaking` (bell boost/cut — matches the Tone tab's "BPF" meaning) | x = freq, y = gain ±24 dB | Q (width) |
| BSF | `notch` | x = freq | Q (width) |
| LPF | `lowpass` | x = freq | Q (resonance) |

Disabled bands stay wired but are set neutral — no rewiring mid-audio:
HPF→20 Hz (Q 0.7), LPF→20 kHz (Q 0.7), BPF→gain 0 dB. A notch has no
neutral gain, so disabled BSF is parked at 20 kHz with a very HIGH Q
(≥30): a vanishingly narrow notch at the edge of hearing, inaudible.

## State (flat numbers per the plugin API)

`hpfOn, hpfFreq, hpfQ, bpfOn, bpfFreq, bpfGain, bpfQ, bsfOn, bsfFreq,
bsfQ, lpfOn, lpfFreq, lpfQ` — `*On` is 0/1. Defaults: HPF 40 Hz/Q 0.7 on,
BPF 1 kHz/0 dB/Q 1 on, BSF 4 kHz/Q 4 off, LPF 18 kHz/Q 0.7 on.

**Migration:** `setState` detects legacy EQ state (has `hpFreq` and no
`hpfFreq`) and maps: `hpFreq→hpfFreq`, `peakFreq→bpfFreq`,
`peakGain→bpfGain`, `lpFreq→lpfFreq`; everything else defaults. Existing
projects keep their sound under the same plugin id.

## UI

One canvas (~360×160, log-frequency 20 Hz–20 kHz, dB axis −24..+24 for
curves; FFT drawn on its own −100..0 dB scale behind, dimmed):

- Gridlines + Hz labels in the `scope-view.ts` style (reuse constants).
- Live FFT trace behind (via the fixed `drawSpectrum` internals).
- Per-band response curve, color-coded — reuse `HPF_TRACE` (blue),
  `BPF_TRACE` (yellow), `LPF_TRACE` (red) from scope-view; new green for
  BSF. Exact curves from `Tone.Filter.getFrequencyResponse()` — no
  hand-rolled response math.
- Combined response in white (product of magnitudes, summed in dB).
- One circular handle per enabled band at (freq → x; y = gain for BPF,
  the 0 dB line for HPF/BSF/LPF). Pointer drag: x→freq (log), y→gain (BPF
  only). Wheel over a handle: Q. Double-click a handle: toggle the band.
- A row of four small on/off checkboxes (color-dotted, band-labeled)
  under the canvas for discoverability; they mirror handle double-click.
- Every edit dispatches the bubbling `plugin-state-changed` event.

The band curves + handles redraw inside the same rAF loop as the FFT (one
loop per plugin UI instance, detach-tolerant as above).

## Pure math module (`src/plugins/eq-math.ts`, Tone-free)

Unit-tested: `freqToX/xToFreq` (log mapping), `gainToY/yToGain`,
`combineDb(magnitudesPerBand[])`, `hitTest(handles, px, py, radius)`,
`migrateLegacyEqState(state)`, `neutralizeBand(state, band)` (the values a
disabled band applies). The plugin class (`src/plugins/equalizer.ts`)
imports these; Tone-importing code is verified manually in the browser.

## Files

- Create: `src/plugins/eq-math.ts` + `src/plugins/eq-math.test.ts`
- Create: `src/plugins/equalizer.ts` (EqualizerPlugin class + UI)
- Modify: `src/plugins/spectrum-view.ts` (detach-tolerant loop)
- Modify: `src/plugins/builtins.ts` (registry entry `eq` → new factory;
  delete old EqPlugin class)
- Modify: `src/style.css` (equalizer canvas/handle/legend styles)

## Testing

- `eq-math.test.ts`: mapping round-trips, hit-testing radius, legacy state
  migration (old keys → new, defaults for the rest), combined-dB math.
- Existing suites must stay green (`connectChain` round-trips the new
  state shape automatically — plain `Record<string, number>`).
- Manual browser verification: add EQ to a track chain while stopped
  (grid + curves visible immediately), play audio (FFT appears), drag
  each band, wheel Q, toggle via double-click and checkboxes, close and
  reopen the FX dialog (canvas still live — the lifecycle fix), export a
  WAV with an EQ'd clip and hear the filtering.
