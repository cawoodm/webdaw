# Tone Tab Audio Visualization — Design

Date: 2026-07-05

## Goal

Visualization at the top of the Tone tab: a time-domain amplitude view and an
FFT frequency view, side by side. Black background, gray gridlines, green
trace.

Two modes, switched by a "Live" checkbox (default unchecked):

- **Static (default):** fixed images of the current patch, recomputed from an
  offline render (`renderPatch`) whenever patch parameters change (debounced
  400 ms). Amplitude as a function of time like an audio editor (min/max per
  pixel column, `waveformPeaks`), and energy as a function of frequency (Hann
  FFT via `magnitudeSpectrum` in `src/core/dsp.ts`, log-frequency axis
  20 Hz–20 kHz). Pure DSP lives in `src/core/dsp.ts` with unit tests.
- **Live:** the animated analyser views described below.

## Audio tap

`ToneTab` owns a persistent `Tone.Gain` node (`tap`) connected onward to
`engine.master`. Voices created by the tab connect to `tap` instead of
directly to `engine.master`, so the tap carries the true live sum of all
layers and voices, including envelope and LFO — without picking up audio from
other tabs.

Two analysers attach to the tap:

- `Tone.Analyser('waveform', 1024)` — time-domain amplitude
- `Tone.Analyser('fft', 1024)` — frequency spectrum (dB values)

## Rendering

New module `src/modules/tone/scope-view.ts`, following the existing
`drawSpectrum` pattern (`src/plugins/spectrum-view.ts`): a
`requestAnimationFrame` loop per canvas that self-stops when the canvas
leaves the document, returning a stop function.

- `drawScope(canvas, analyser, isActive)` — time-domain trace. Horizontal
  gridlines at amplitude divisions (−1, −0.5, 0, +0.5, +1), vertical time
  division lines.
- `drawFft(canvas, analyser, isActive)` — FFT trace with log-scaled frequency
  axis (as in `drawSpectrum`). Horizontal dB gridlines, vertical log-spaced
  frequency lines with Hz labels.

Shared styling: black background (`#000`), gray gridlines (`#444`-ish),
green trace (`#33ff66`). Both loops skip drawing (but keep scheduling) while
`isActive()` returns false, so hidden tabs cost no canvas work.

## UI

In `ToneTab.render()`, a panel is inserted above the patch toolbar containing
two labeled canvases (*Time*, *Freq*) side by side, each flexing to half
width. Styling in global `src/style.css`. Since `render()` rebuilds the DOM,
old canvases disconnect and their draw loops self-terminate; new loops start
each render.

## Testing

Tone.js-importing code cannot run under Vitest — no unit tests. Verify
manually in the browser: play notes via keyboard/MIDI, confirm both views
animate, gridlines/colors match, and the FFT responds to layer detune/type
changes.
