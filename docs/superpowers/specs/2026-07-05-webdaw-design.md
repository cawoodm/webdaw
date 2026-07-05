# WebDAW — Browser-Based Audio Studio (Design Spec)

Approved 2026-07-05.

## Goal

A browser DAW with 5 tabs — **Tone** (procedural sound design), **Sample** (Koala-style pad matrix), **Sequence** (audio + MIDI sequencer), **Arrange** (song assembly + effect plugins), **Produce** (stub) — with a plugin system (Spectrum/FFT viewer, EQ, Delay, Reverb, Chorus, Phaser), project persistence to a real folder on disk, and Web MIDI support.

## Decisions

- **Stack:** Vanilla TypeScript + Web Components + Vite. No UI framework.
- **Audio:** Tone.js (transport, synths, effects, offline rendering).
- **Persistence:** File System Access API — the project lives in a user-picked folder; the directory handle plus UI prefs persist in IndexedDB so the project reloads automatically (permission re-grant may be needed). Chromium-target browser.
- **Phasing:** full skeleton first (all tabs at basic fidelity, connected end-to-end), then deepen.
- **MIDI instruments:** stock Tone.js synths first; Tone-tab patches and pad-samplers later.
- **Produce tab:** stub.

## Architecture: shared core + event bus

Three singletons; five Web Component tab modules that talk only to the singletons.

- **`AudioEngine`** (`src/core/audio-engine.ts`) — global transport (BPM, metronome), master bus, offline rendering for WAV exports. AudioContext resumes on first user gesture.
- **`ProjectStore`** (`src/core/project-store.ts`) — in-memory project model, debounced autosave. Folder layout: `project.json` + `tones/`, `samples/`, `sequences/`, `exports/` WAV subfolders. WAV encoding in `src/core/wav.ts`, IndexedDB helpers in `src/core/persistence.ts`.
- **`EventBus`** (`src/core/event-bus.ts`) — typed pub/sub: `tone:sendToPad`, `sample:editInSequencer`, `tab:activate`, `midi:noteon/noteoff`, `project:loaded/changed`.

Shell (`src/shell/app-shell.ts`): tab bar, transport (BPM, metronome, stop), Master FX dialog, keyboard-mapping dialog, project folder controls. Tab modules stay mounted when hidden so audio survives tab switches.

## Modules

- **Tone** (`src/modules/tone/`) — oscillator layers (sine/saw/triangle/square) with gain/detune/phase knobs, ADSR, LFO (pitch/volume). Duplicate-layer for phase stacking. Preview via keyboard/MIDI. Export renders WAV to `tones/` and keeps patch params in `project.json` for later use as a MIDI instrument. Send-to-pad.
- **Sample** (`src/modules/sample/`) — 4×4 pads with gain/trim; load from disk or Tone tab. Loop-length + metronome + overdub recording of pad hits. Export loop WAV; "edit in sequencer" converts recorded events to a new sequence.
- **Sequence** (`src/modules/sequence/`) — sequences of tracks; track type chosen at creation: audio (pad/file source + step grid) or MIDI (piano roll, stock Tone.js synth). Records MIDI from Web MIDI devices or the mapped computer keyboard. Bounce to `sequences/*.wav`.
- **Arrange** (`src/modules/arrange/`) — song timeline; clips are sequences or samples placed at bars; per-track insert plugin chains; song export to `exports/`.
- **Produce** — stub.

## Plugin system (`src/plugins/`)

`DawPlugin`: `input`/`output` Tone nodes + `createUI()` + `getState()/setState()` + `dispose()`. Plugins instantiate against the active Tone context so the same code runs live and inside `Tone.Offline` for export. `<plugin-chain>` provides host chrome (title, bypass, remove) and rewires routing. Built-ins: Spectrum (FFT canvas, works on any bus incl. master), EQ (HP/peak/LP over live spectrum), Delay, Reverb, Chorus, Phaser.

## Error handling

- Lost folder permission → "Reconnect project" button (permission re-request needs a user gesture).
- Missing referenced WAV → marked in UI, app keeps working.
- No MIDI devices → computer-keyboard mapping fallback (user-definable, stored in IndexedDB).

## Testing

- Vitest: WAV encoder, event bus, project model, keymap defaults.
- Manual browser flow: tone → pad → record loop → sequencer → arrange + FX → export song; reload restores project from folder handle.
