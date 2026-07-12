# Arrange Undo/Redo — Design

Date: 2026-07-12

## Goal

Give the Arrange tab Undo/Redo. The Tone tab already has a proven per-patch
history (`src/modules/tone/patch-history.ts`, spec
`2026-07-08-tone-undo-redo-reset-design.md`). Generalize that mechanism into
a shared core helper so every tab can own its own history, then wire the
Arrange tab to it. Histories stay **scoped per tab**: each tab's undo
buttons/hotkeys affect only that tab's slice of the project. Session-only
(not persisted), no depth cap — matching Tone today.

## Data model — `src/core/history.ts` (new)

`SnapshotHistory<T>`: the existing `PatchHistory` logic with `TonePatch`
replaced by a generic `T` and explicit string keys. Pure — no Tone.js or
DOM — unit-testable under Vitest.

```ts
interface HistoryEntry<T> {
  history: T[]; // snapshots, oldest first; history[0] is the checkpoint
  index: number; // which entry is "current"
}

export class SnapshotHistory<T> {
  private entries = new Map<string, HistoryEntry<T>>();

  seed(key: string, value: T): void;              // fresh checkpoint
  commit(key: string, value: T): void;            // append, drop redo branch (seeds if unknown key)
  canUndo(key: string): boolean;
  canRedo(key: string): boolean;
  undo(key: string): T | null;                    // step back, null at checkpoint
  redo(key: string): T | null;                    // step forward, null at newest
  reset(key: string): T | null;                   // jump to checkpoint, keeps redo branch
  discard(key: string): void;
}
```

Bodies are verbatim ports from `PatchHistory` (structuredClone snapshots,
redo-branch truncation on commit).

### Tone refactor

`patch-history.ts` becomes a thin patch-flavored wrapper so `tone-tab.ts`
call sites don't change:

```ts
export class PatchHistory {
  private h = new SnapshotHistory<TonePatch>();
  seed(patch: TonePatch): void { this.h.seed(patch.id, patch); }
  commit(patch: TonePatch): void { this.h.commit(patch.id, patch); }
  canUndo(id: string): boolean { return this.h.canUndo(id); }
  // … undo/redo/reset/discard delegate likewise
}
```

The unit tests move to `src/core/history.test.ts` (same cases, generic
types); `patch-history.test.ts` is deleted — the wrapper has no logic of
its own.

## Arrange integration — `arrange-tab.ts`

One instance + a fixed key (there is exactly one arrangement per project):

```ts
private history = new SnapshotHistory<ProjectData['arrangement']>();
private static readonly HISTORY_KEY = 'arrangement';
```

### Seeding

`bus.on('project:loaded', …)` (existing handler) calls
`history.seed(HISTORY_KEY, store.data.arrangement)`. Project switches and
Reload-from-disk re-emit `project:loaded`, so the checkpoint always matches
the freshly loaded state. No `discard()` needed.

### Recording edits

A debounced commit, same shape as Tone's:

```ts
private historyTimer: number | undefined;
private scheduleHistoryCommit(): void {
  clearTimeout(this.historyTimer);
  this.historyTimer = window.setTimeout(() => this.flushHistoryCommit(), 500);
}
private flushHistoryCommit(): void {
  clearTimeout(this.historyTimer);
  this.historyTimer = undefined;
  this.history.commit(ArrangeTab.HISTORY_KEY, store.data.arrangement);
  this.refreshHistoryButtons();
}
```

`scheduleHistoryCommit()` is called after **every mutation of
`store.data.arrangement` that originates in the Arrange tab**: clip
place/move/resize/remove (drag-drop and Delete key), clip gain, clip FX and
track FX plugin edits (the bubbling `plugin-state-changed` handler and
add/remove/bypass of chain plugins), track add/remove/rename/gain — every
`store.update`/`scheduleSave` call site in `arrange-tab.ts` that touches
the arrangement. Mutations from OTHER modules (e.g. the sequence-deletion
purge) are deliberately not recorded — per-tab scope.

### Applying undo/redo

```ts
private undoArrange(): void {
  this.flushHistoryCommit();
  const restored = this.history.undo(ArrangeTab.HISTORY_KEY);
  if (!restored) return;
  store.update((d) => { d.arrangement = restored; });
  this.render();
}
```

`redoArrange()` is symmetric. `store.update` gives autosave + the dirty
indicator for free. A restored snapshot may reference a sequence deleted
in another tab after the snapshot was taken; the existing purge-on-delete
flow already handles dangling refs, and this is accepted as an edge case
of per-tab scope.

## UI

Two icon buttons in the Arrange toolbar (built by `buildToolbar()`), after
the palette/snap selects, using the existing `iconBtn()` helper:

- **Undo** (curved left arrow), title `Undo (Ctrl+Z)`, disabled when
  `!canUndo`
- **Redo** (curved right arrow), title `Redo (Ctrl+Shift+Z)`, disabled when
  `!canRedo`

Button refs are kept on the class; `refreshHistoryButtons()` syncs disabled
state without a full re-render. No Reset button: resetting a whole
arrangement to project-load state is a foot-gun, unlike Tone's per-patch
reset.

**Keyboard shortcuts:** `Ctrl+Z` / `Ctrl+Shift+Z` in a `keydown` listener
registered in `connectedCallback()`, exactly like tone-tab's: only when
`this.classList.contains('active-tab')`, skipping events targeting
INPUT/SELECT/TEXTAREA/contentEditable. The Arrange tab already has a
Delete-key listener with these guards to model from.

## Testing

- `src/core/history.test.ts`: the ported patch-history cases against
  `SnapshotHistory<T>` — seed, commit, undo, redo, reset (non-truncating),
  redo-branch truncation after undo+commit, discard, null returns.
- Tone still passes its existing manual checks (wrapper is 1:1).
- Arrange wiring (debounce, buttons, hotkeys) is DOM+timing — verified
  manually in the browser per project convention: place/move/resize/remove
  a clip and undo each; undo a whole drag as one step; redo; edit clip FX
  and undo; confirm Ctrl+Z on the Tone tab still undoes patches only and on
  the Arrange tab clips only; switch projects and confirm history resets.
