# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

WebDAW — a browser DAW (Chromium-target: File System Access API + Web MIDI) built with vanilla TypeScript + Web Components + Vite. Audio via Tone.js. No UI framework. Design spec: `docs/superpowers/specs/2026-07-05-webdaw-design.md`.

## Commands

- `npm run dev` — Vite dev server
- `npm run build` — `tsc --noEmit` + Vite production build (strict TS; `noUnusedLocals`/`noUnusedParameters` are on)
- `npm test` — all Vitest tests
- `npx vitest run src/core/wav.test.ts` — single test file; `npx vitest run -t "name"` for a single test

Audio behavior can't be unit-tested in Node — verify audio changes manually in the browser (Chrome DevTools MCP works well). Anything importing `tone` won't run under Vitest; keep testable logic (encoding, model, mapping math) in modules that don't import it.

## Architecture

Three singletons under `src/core/`; five tab modules that talk **only** to the singletons, never to each other directly:

- **`engine`** (`audio-engine.ts`) — wraps Tone.js: global transport (BPM, loop, metronome), `engine.master` output bus. `await engine.ensureStarted()` is required before any sound (AudioContext needs a user gesture).
- **`store`** (`project-store.ts`) — the single `ProjectData` model (`model.ts`) plus persistence: debounced autosave of `project.json` to a user-picked folder (File System Access API), directory handle restored from IndexedDB on reload (`persistence.ts`). Every save also mirrors the project JSON to IndexedDB so edits survive reloads without a folder; the folder copy is authoritative once accessible. Also owns the path→`AudioBuffer` cache; WAVs live in `tones/`, `samples/`, `sequences/`, `exports/` inside the project folder. Two mutation styles: `store.update(fn)` notifies listeners via `project:changed` + saves; bare mutation + `store.scheduleSave()` saves without re-render (used by knobs to avoid destroying the widget mid-drag).
- **`bus`** (`event-bus.ts`) — typed pub/sub. All cross-module flows go through it: `tone:sendToPad`, `sample:editInSequencer`, `tab:activate`, `midi:noteon/noteoff`, `project:loaded/changed`. Add new cross-module interactions here, not as direct imports between modules.

**Modules** (`src/modules/<name>/<name>-tab.ts`) are light-DOM custom elements (`<tone-tab>` etc.) registered in `main.ts` and mounted permanently by `app-shell.ts` — hidden tabs keep playing audio. The shell toggles `active-tab`/`hidden` classes; modules that consume note input check they're active before reacting.

**Rendering convention:** no virtual DOM — modules rebuild their own DOM imperatively via `render()` on `project:loaded` and after their own structural edits. Styling is global (`src/style.css`), no shadow DOM.

**Offline rendering pattern (important):** every WAV export uses `Tone.Offline(callback, seconds)`. Nodes constructed inside the callback bind to the offline context, so the same code (e.g. `PatchVoice`, `scheduleSequenceAt`, `connectChain`) runs live and offline. Resolve `AudioBuffer`s from the store _before_ entering the callback (the store/cache belongs to the live context); schedule with absolute seconds computed from BPM. Never call `Tone.Offline` inside another `Tone.Offline`— pre-render dependencies first (see `arrange-tab.ts` `resolveClips`).

**Plugins** (`src/plugins/`): implement `DawPlugin` (`api.ts`) — `input`/`output` Tone nodes, `createUI()`, `getState()/setState()` (plain `Record<string, number>`, persisted in `project.json`). Register in `PLUGIN_REGISTRY` (`builtins.ts`). `<plugin-chain>` (`chain.ts`) provides host chrome (bypass/remove) and rewiring; `connectChain()` is the context-agnostic variant used in offline exports. Plugin UIs report edits by dispatching a bubbling `plugin-state-changed` event.

**UI state** (`src/core/ui-state.ts`): all transient UI state (active tab, selections, toggles) persists to IndexedDB via `updateUi(fn)` and is restored at boot — `main.ts` emits `ui:loaded` after loading it, and each module re-applies its slice in a `bus.on('ui:loaded', …)` handler. When adding new UI state (a selection, a toggle), route it through `UiState`, don't keep it only in a class field.

**Note input** (`src/midi/`): Web MIDI devices and the computer keyboard both funnel into the same `midi:noteon/noteoff` bus events. Key→note mapping is user-editable (Keys dialog) and stored in IndexedDB, not in the project file.

**Timing model:** musical time is stored in beats (pad events) or 16th steps (`STEPS_PER_BAR = 16`); convert to seconds only at scheduling time via `engine.secondsPerBeat()/secondsPerStep()`.

## Conventions

- TypeScript type declarations for File System Access APIs missing from lib.dom live in `src/types/fs-access.d.ts`.
- IDs come from `uid()` in `model.ts`; new persisted fields belong on `ProjectData` and must survive a JSON round-trip (there is a test for this).
- Custom element class fields must not shadow `HTMLElement` members (e.g. `part` is taken).

## UI

- Prefer svg icons over text where possible (title/tooltip should explain what the button does and show the hotkey)
