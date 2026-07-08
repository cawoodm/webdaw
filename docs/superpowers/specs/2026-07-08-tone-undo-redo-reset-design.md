# Tone Patch Undo/Redo/Reset — Design

Date: 2026-07-08

## Goal

The Tone tab autosaves every edit ~800ms after you stop touching a control,
so "reset to what's on disk" is nearly meaningless on its own — disk state
tracks current state within a second. Instead: keep a per-patch history of
edits from a checkpoint (project load / patch creation / patch import), and
give the Tone tab proper Undo, Redo, and Reset (jump back to the checkpoint)
controls. Scoped to Tone tab patches only — no other tab gets undo/redo.

## Data model — `src/modules/tone/patch-history.ts` (new)

A pure, Tone-free class, unit-testable under Vitest:

```ts
import type { TonePatch } from '../../core/model';

interface HistoryEntry {
  history: TonePatch[]; // snapshots, oldest first; history[0] is the checkpoint
  index: number; // which entry is "current"
}

export class PatchHistory {
  private entries = new Map<string, HistoryEntry>();

  /** Establish a fresh checkpoint (project load, new/duplicated/imported patch). */
  seed(patch: TonePatch): void {
    this.entries.set(patch.id, { history: [structuredClone(patch)], index: 0 });
  }

  /** Record a completed edit: append as the new current entry, dropping any redo branch. */
  commit(patch: TonePatch): void {
    const entry = this.entries.get(patch.id) ?? this.seedAndGet(patch);
    entry.history = entry.history.slice(0, entry.index + 1);
    entry.history.push(structuredClone(patch));
    entry.index = entry.history.length - 1;
  }

  canUndo(patchId: string): boolean {
    const e = this.entries.get(patchId);
    return !!e && e.index > 0;
  }

  canRedo(patchId: string): boolean {
    const e = this.entries.get(patchId);
    return !!e && e.index < e.history.length - 1;
  }

  /** Step back one entry; returns the snapshot to apply, or null if already at the checkpoint. */
  undo(patchId: string): TonePatch | null {
    const e = this.entries.get(patchId);
    if (!e || e.index === 0) return null;
    e.index--;
    return structuredClone(e.history[e.index]);
  }

  /** Step forward one entry; returns the snapshot to apply, or null if already at the newest entry. */
  redo(patchId: string): TonePatch | null {
    const e = this.entries.get(patchId);
    if (!e || e.index >= e.history.length - 1) return null;
    e.index++;
    return structuredClone(e.history[e.index]);
  }

  /** Jump straight back to the checkpoint (does NOT truncate — redo can still step forward). */
  reset(patchId: string): TonePatch | null {
    const e = this.entries.get(patchId);
    if (!e || e.index === 0) return null;
    e.index = 0;
    return structuredClone(e.history[0]);
  }

  /** Drop a patch's history entirely (patch deleted). */
  discard(patchId: string): void {
    this.entries.delete(patchId);
  }

  private seedAndGet(patch: TonePatch): HistoryEntry {
    this.seed(patch);
    return this.entries.get(patch.id)!;
  }
}
```

`commit()` seeding a missing entry on the fly is a safety net (e.g. patches
predating this feature that were never explicitly seeded) — normal flow
always seeds explicitly first (see below).

### Checkpoint seeding points

`ToneTab` owns one `private history = new PatchHistory();` instance. `seed()`
is called:

- On `project:loaded` — for every patch in `store.data.patches` (fresh
  checkpoints on project open/switch).
- In the "New patch" button handler — the patch's just-created defaults are
  its checkpoint.
- In the "Duplicate patch" button handler — for the new copy's id.
- In `importPatchFiles()` — both branches: a freshly-imported new patch, and
  the "overwrite existing" branch (re-seeds the existing patch's id to the
  freshly imported data, discarding its prior history).

`discard()` is called in the "Delete patch" button handler.

## Recording edits

`ToneTab.save()` is already the single function every knob/select/checkbox
mutation calls after writing a patch field (~30 call sites, unchanged). Add
a debounced commit there instead of touching each call site:

```ts
private save(): void {
  clearTimeout(this.historyTimer);
  this.historyTimer = window.setTimeout(() => this.history.commit(this.patch()), 500);
  store.scheduleSave();
  this.redrawStatic();
  clearTimeout(this.staticTimer);
  this.staticTimer = window.setTimeout(() => void this.updateStatic(), 400);
}
```

500ms of no further `save()` calls on the same patch = the action is
complete → exactly one history entry. A multi-second knob drag fires
`save()` continuously but commits once, after the drag ends.

Two structural edits bypass `save()` today, mutating via `store.update()` +
`this.render()` directly: **Duplicate layer** and **✕ Remove layer** (in the
per-layer card buttons). Both get the same debounced-commit call added so
layer add/remove is undoable too.

**Flush on patch switch:** `selectPatch(id)` clears `historyTimer` and, if
one was pending, calls `this.history.commit()` on the outgoing patch
synchronously before switching — so the last edit to the tone you're
leaving isn't silently dropped.

## UI

Three new icon buttons in the patch toolbar (`bar`), positioned right after
the patch `<select>` and before New/Duplicate/Rename/Delete, using the
existing `iconBtn()` helper (SVG icon, title = action + hotkey):

- **Undo** (curved left arrow), disabled when `!history.canUndo(patch.id)`
- **Redo** (curved right arrow), disabled when `!history.canRedo(patch.id)`
- **Reset** (circular restore arrow), disabled when `!history.canUndo(patch.id)`
  (same condition as Undo — both are "no-op at the checkpoint")

Each button's click handler calls the corresponding `PatchHistory` method;
if it returns a non-null snapshot, `Object.assign(patch, snapshot)` (keeps
the live object identity that the rest of the tab holds references to),
then `this.render()` (full rebuild — undo/redo can restore structural
changes like layer count, not just knob values) and `store.scheduleSave()`.
No confirmation dialog, matching the existing "Delete patch" button.

**Keyboard shortcuts:** `Ctrl+Z` (undo) and `Ctrl+Shift+Z` (redo), added
alongside the existing hotkey `keydown` listener in `connectedCallback()`,
guarded the same way as the "1" preview hotkey: only when
`this.classList.contains('active-tab')` and the event target isn't a text
input.

## Testing

`patch-history.ts` has no Tone or DOM imports, so `patch-history.test.ts`
covers it directly under Vitest: seed, commit, undo, redo, reset (including
that reset doesn't truncate and redo still works after it), truncation of
the redo branch on a new edit after undoing, and discard.

The debounced `save()` wiring, the toolbar buttons, and the keyboard
shortcuts can't be unit-tested (DOM timing + Tone-importing module) —
verified manually in the browser per project convention: drag a knob and
undo, add/remove a layer and undo, redo after undo, reset after several
edits, redo after reset, switch patches mid-edit and confirm the pending
edit was captured, delete a patch and confirm no memory-leak-shaped
lingering history reference.
