# Arrange Undo/Redo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Undo/Redo for the Arrange tab via a shared `SnapshotHistory<T>` extracted from the Tone tab's `PatchHistory`.

**Architecture:** A generic, pure snapshot-history class moves to `src/core/history.ts`; `patch-history.ts` becomes a thin `TonePatch` wrapper so tone-tab call sites don't change; `arrange-tab.ts` keeps one `SnapshotHistory<ProjectData['arrangement']>` under a fixed key, commits (debounced 500ms) after every arrangement mutation it originates, and applies undo/redo by replacing `d.arrangement` inside `store.update`.

**Tech Stack:** Vanilla TypeScript (strict, `noUnusedLocals`/`noUnusedParameters`), Vitest, no frameworks. Spec: `docs/superpowers/specs/2026-07-12-arrange-undo-design.md`.

## Global Constraints

- `src/core/history.ts` must import nothing from Tone.js or the DOM (Vitest-testable; anything importing Tone won't run under Vitest).
- History is session-only: never persisted, no depth cap.
- Per-tab scope: Arrange's undo must not touch patches; Tone's must not touch the arrangement.
- `arrange-tab.ts` is being edited concurrently by another session — locate call sites by searching, never by line number, and re-read the file immediately before editing.
- Follow repo UI convention: SVG icon buttons, `title` = action + hotkey.
- Never add AI attribution to commits.

---

### Task 1: `SnapshotHistory<T>` in core

**Files:**
- Create: `src/core/history.ts`
- Test: `src/core/history.test.ts`

**Interfaces:**
- Produces: `class SnapshotHistory<T>` with `seed(key: string, value: T): void`, `commit(key: string, value: T): void`, `canUndo(key: string): boolean`, `canRedo(key: string): boolean`, `undo(key: string): T | null`, `redo(key: string): T | null`, `reset(key: string): T | null`, `discard(key: string): void`. Tasks 2 and 3 rely on these exact names.

- [ ] **Step 1: Write the failing test**

Create `src/core/history.test.ts` (a generic-typed port of `src/modules/tone/patch-history.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { SnapshotHistory } from './history';

interface Doc {
  value: number;
}

describe('SnapshotHistory', () => {
  it('seed establishes a checkpoint with nothing to undo/redo', () => {
    const h = new SnapshotHistory<Doc>();
    h.seed('a', { value: 0 });
    expect(h.canUndo('a')).toBe(false);
    expect(h.canRedo('a')).toBe(false);
  });

  it('commit records an edit that can be undone back to the checkpoint', () => {
    const h = new SnapshotHistory<Doc>();
    h.seed('a', { value: 0 });
    h.commit('a', { value: 0.5 });
    expect(h.canUndo('a')).toBe(true);
    const undone = h.undo('a');
    expect(undone?.value).toBe(0);
    expect(h.canUndo('a')).toBe(false);
  });

  it('redo re-applies an undone edit', () => {
    const h = new SnapshotHistory<Doc>();
    h.seed('a', { value: 0 });
    h.commit('a', { value: 0.5 });
    h.undo('a');
    expect(h.canRedo('a')).toBe(true);
    const redone = h.redo('a');
    expect(redone?.value).toBe(0.5);
    expect(h.canRedo('a')).toBe(false);
  });

  it('a new commit after undoing truncates the redo branch', () => {
    const h = new SnapshotHistory<Doc>();
    h.seed('a', { value: 0 });
    h.commit('a', { value: 0.5 });
    h.undo('a');
    h.commit('a', { value: 0.9 });
    expect(h.canRedo('a')).toBe(false);
    const undone = h.undo('a');
    expect(undone?.value).toBe(0);
  });

  it('reset jumps straight to the checkpoint without truncating redo', () => {
    const h = new SnapshotHistory<Doc>();
    h.seed('a', { value: 0 });
    h.commit('a', { value: 0.3 });
    h.commit('a', { value: 0.6 });
    const wasReset = h.reset('a');
    expect(wasReset?.value).toBe(0);
    expect(h.canUndo('a')).toBe(false);
    expect(h.canRedo('a')).toBe(true);
    const redone = h.redo('a');
    expect(redone?.value).toBe(0.3);
  });

  it('undo/redo/reset return null when there is nothing to do', () => {
    const h = new SnapshotHistory<Doc>();
    h.seed('a', { value: 0 });
    expect(h.undo('a')).toBeNull();
    expect(h.redo('a')).toBeNull();
    expect(h.reset('a')).toBeNull();
  });

  it("discard drops a key's history entirely", () => {
    const h = new SnapshotHistory<Doc>();
    h.seed('a', { value: 0 });
    h.commit('a', { value: 0.5 });
    h.discard('a');
    expect(h.canUndo('a')).toBe(false);
    expect(h.canRedo('a')).toBe(false);
  });

  it('commit seeds on the fly for a key with no prior checkpoint', () => {
    const h = new SnapshotHistory<Doc>();
    expect(() => h.commit('a', { value: 0.4 })).not.toThrow();
    expect(h.canUndo('a')).toBe(true);
  });

  it('snapshots are isolated from later mutation of the passed object', () => {
    const h = new SnapshotHistory<Doc>();
    const doc = { value: 0 };
    h.seed('a', doc);
    doc.value = 1;
    h.commit('a', doc);
    doc.value = 2;
    expect(h.undo('a')?.value).toBe(0);
    expect(h.redo('a')?.value).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/history.test.ts`
Expected: FAIL — cannot resolve `./history`.

- [ ] **Step 3: Write the implementation**

Create `src/core/history.ts` (verbatim port of `src/modules/tone/patch-history.ts` logic, keyed generically):

```ts
interface HistoryEntry<T> {
  history: T[]; // snapshots, oldest first; history[0] is the checkpoint
  index: number; // which entry is "current"
}

/**
 * Generic per-key undo/redo/reset snapshot history. Pure data structure —
 * no Tone.js or DOM — unit-testable under Vitest. Each tab owns its own
 * instance; histories are session-only and never persisted.
 */
export class SnapshotHistory<T> {
  private entries = new Map<string, HistoryEntry<T>>();

  /** Establish a fresh checkpoint (project load, item creation/import). */
  seed(key: string, value: T): void {
    this.entries.set(key, { history: [structuredClone(value)], index: 0 });
  }

  /** Record a completed edit: append as the new current entry, dropping any redo branch. */
  commit(key: string, value: T): void {
    const entry = this.entries.get(key) ?? this.seedAndGet(key, value);
    entry.history = entry.history.slice(0, entry.index + 1);
    entry.history.push(structuredClone(value));
    entry.index = entry.history.length - 1;
  }

  canUndo(key: string): boolean {
    const e = this.entries.get(key);
    return !!e && e.index > 0;
  }

  canRedo(key: string): boolean {
    const e = this.entries.get(key);
    return !!e && e.index < e.history.length - 1;
  }

  /** Step back one entry; returns the snapshot to apply, or null if already at the checkpoint. */
  undo(key: string): T | null {
    const e = this.entries.get(key);
    if (!e || e.index === 0) return null;
    e.index--;
    return structuredClone(e.history[e.index]);
  }

  /** Step forward one entry; returns the snapshot to apply, or null if already at the newest entry. */
  redo(key: string): T | null {
    const e = this.entries.get(key);
    if (!e || e.index >= e.history.length - 1) return null;
    e.index++;
    return structuredClone(e.history[e.index]);
  }

  /** Jump straight back to the checkpoint (does NOT truncate — redo can still step forward). */
  reset(key: string): T | null {
    const e = this.entries.get(key);
    if (!e || e.index === 0) return null;
    e.index = 0;
    return structuredClone(e.history[0]);
  }

  /** Drop a key's history entirely (item deleted). */
  discard(key: string): void {
    this.entries.delete(key);
  }

  private seedAndGet(key: string, value: T): HistoryEntry<T> {
    this.seed(key, value);
    return this.entries.get(key)!;
  }
}
```

Note: `commit` on an unseeded key seeds a checkpoint from the passed value
and then appends it (history length 2, index 1), so `canUndo` is
immediately true. This mirrors `PatchHistory.commit` exactly; the ported
"commit seeds on the fly" test depends on it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/history.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/history.ts src/core/history.test.ts
git commit -m "Extract the Tone tab's snapshot history into a generic core SnapshotHistory"
```

---

### Task 2: `PatchHistory` becomes a thin wrapper

**Files:**
- Modify: `src/modules/tone/patch-history.ts` (replace body)
- Delete: `src/modules/tone/patch-history.test.ts`

**Interfaces:**
- Consumes: `SnapshotHistory<T>` from Task 1 (`import { SnapshotHistory } from '../../core/history';`).
- Produces: `PatchHistory` with the SAME public API tone-tab already uses: `seed(patch: TonePatch)`, `commit(patch: TonePatch)`, `canUndo(patchId: string)`, `canRedo(patchId: string)`, `undo(patchId: string): TonePatch | null`, `redo(patchId: string): TonePatch | null`, `reset(patchId: string): TonePatch | null`, `discard(patchId: string)`. `tone-tab.ts` is NOT modified.

- [ ] **Step 1: Replace the implementation**

Overwrite `src/modules/tone/patch-history.ts` with:

```ts
import { SnapshotHistory } from '../../core/history';
import type { TonePatch } from '../../core/model';

/** Per-patch undo/redo/reset history for the Tone tab — a patch-keyed view over the shared SnapshotHistory. */
export class PatchHistory {
  private h = new SnapshotHistory<TonePatch>();

  /** Establish a fresh checkpoint: project load, new/duplicated/imported patch. */
  seed(patch: TonePatch): void {
    this.h.seed(patch.id, patch);
  }

  /** Record a completed edit: append as the new current entry, dropping any redo branch. */
  commit(patch: TonePatch): void {
    this.h.commit(patch.id, patch);
  }

  canUndo(patchId: string): boolean {
    return this.h.canUndo(patchId);
  }

  canRedo(patchId: string): boolean {
    return this.h.canRedo(patchId);
  }

  /** Step back one entry; returns the snapshot to apply, or null if already at the checkpoint. */
  undo(patchId: string): TonePatch | null {
    return this.h.undo(patchId);
  }

  /** Step forward one entry; returns the snapshot to apply, or null if already at the newest entry. */
  redo(patchId: string): TonePatch | null {
    return this.h.redo(patchId);
  }

  /** Jump straight back to the checkpoint (does NOT truncate — redo can still step forward). */
  reset(patchId: string): TonePatch | null {
    return this.h.reset(patchId);
  }

  /** Drop a patch's history entirely (patch deleted). */
  discard(patchId: string): void {
    this.h.discard(patchId);
  }
}
```

- [ ] **Step 2: Delete the superseded test file**

```bash
git rm src/modules/tone/patch-history.test.ts
```

(Its cases now live, generically typed, in `src/core/history.test.ts`.)

- [ ] **Step 3: Verify full suite + typecheck pass**

Run: `npm test` — Expected: PASS, no `PatchHistory` failures.
Run: `npm run build` — Expected: clean (`tsc --noEmit` strict).

- [ ] **Step 4: Commit**

```bash
git add src/modules/tone/patch-history.ts
git commit -m "Tone: PatchHistory delegates to the shared SnapshotHistory"
```

---

### Task 3: Arrange tab undo/redo

**Files:**
- Modify: `src/modules/arrange/arrange-tab.ts`

**Interfaces:**
- Consumes: `SnapshotHistory<T>` from Task 1.
- Produces: user-facing only (buttons + hotkeys); no exports.

**IMPORTANT:** this file is concurrently edited by another session. `git pull`/re-read is not enough — Read the current file top to bottom for mutation sites right before editing; do not trust the excerpts below to be complete.

- [ ] **Step 1: Add history state + methods**

Imports: add `SnapshotHistory` from `'../../core/history'` and `type ProjectData` to the existing model type import.

Class fields (next to the existing `palette`/`sampleFiles` fields):

```ts
private history = new SnapshotHistory<ProjectData['arrangement']>();
private historyTimer: number | undefined;
private undoBtn: HTMLButtonElement | null = null;
private redoBtn: HTMLButtonElement | null = null;
private static readonly HISTORY_KEY = 'arrangement';
```

Methods:

```ts
/** Debounced history commit: 500ms of no further arrange edits = one undo step. */
private scheduleHistoryCommit(): void {
  clearTimeout(this.historyTimer);
  this.historyTimer = window.setTimeout(() => this.flushHistoryCommit(), 500);
}

/** Commit any pending edit immediately (before undo/redo read the stack). */
private flushHistoryCommit(): void {
  if (this.historyTimer === undefined) return;
  clearTimeout(this.historyTimer);
  this.historyTimer = undefined;
  this.history.commit(ArrangeTab.HISTORY_KEY, store.data.arrangement);
  this.refreshHistoryButtons();
}

/** Sync Undo/Redo disabled state without a full re-render. */
private refreshHistoryButtons(): void {
  if (this.undoBtn) this.undoBtn.disabled = !this.history.canUndo(ArrangeTab.HISTORY_KEY);
  if (this.redoBtn) this.redoBtn.disabled = !this.history.canRedo(ArrangeTab.HISTORY_KEY);
}

private undoArrange(): void {
  this.flushHistoryCommit();
  const restored = this.history.undo(ArrangeTab.HISTORY_KEY);
  if (!restored) return;
  store.update((d) => {
    d.arrangement = restored;
  });
  this.render();
}

private redoArrange(): void {
  this.flushHistoryCommit();
  const restored = this.history.redo(ArrangeTab.HISTORY_KEY);
  if (!restored) return;
  store.update((d) => {
    d.arrangement = restored;
  });
  this.render();
}
```

Gotcha: `flushHistoryCommit` early-returns when no timer is pending —
otherwise every undo would first commit the current state and immediately
truncate/undo it, making the first Ctrl+Z a visible no-op.

Note: `store.update` inside `undoArrange` schedules the debounced *save*;
it must NOT trigger a history commit (only explicit edit sites do), or
undo would re-commit what it just restored.

- [ ] **Step 2: Seed on project load**

In the existing `bus.on('project:loaded', …)` handler (the one that resets `samplesScanned`), add as the first line:

```ts
this.history.seed(ArrangeTab.HISTORY_KEY, store.data.arrangement);
```

- [ ] **Step 3: Sweep every arrangement mutation site**

Search `arrange-tab.ts` for `store.update(` and `store.scheduleSave(`.
For EVERY site that mutates the arrangement (clips, tracks, `d.arrangement.*` — in this file that is all of them), add `this.scheduleHistoryCommit();` immediately after the mutation call. As of writing this includes at least: clip placement (lane click), clip drag-move/resize/remove, clip purge on stale refs, clip gain (`store.scheduleSave()` in a knob callback), plugin-chain bind callbacks (`() => store.scheduleSave()` becomes `() => { store.scheduleSave(); this.scheduleHistoryCommit(); }` — both the track-FX and clip-FX `chain.bind` sites), track rename/mute/solo/duplicate/remove, and the `bars` count input. Do NOT add it to playback/zoom/scroll/UI-state code (`updateUi`, cursor moves) — those don't touch `store.data.arrangement`.

- [ ] **Step 4: Toolbar buttons**

In `buildToolbar()`, right after the snap `<select>` is appended (before the transport cluster), using the local `iconBtn` helper already in that method:

```ts
const undoBtn = iconBtn(
  'Undo (Ctrl+Z)',
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  () => this.undoArrange(),
);
const redoBtn = iconBtn(
  'Redo (Ctrl+Shift+Z)',
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>',
  () => this.redoArrange(),
);
this.undoBtn = undoBtn;
this.redoBtn = redoBtn;
this.refreshHistoryButtons();
```

Append `undoBtn, redoBtn` to the same container the palette/snap selects go into (match however `iconBtn` results are appended there — read the current code first; `iconBtn` may need to match the local helper's exact signature in that method).

- [ ] **Step 5: Keyboard shortcuts**

The tab already routes `document`-level keydown through `this.onKeydown(e)`. Extend `onKeydown` (which already guards on active-tab and INPUT/SELECT/TEXTAREA targets — verify, and keep its existing Delete-key behavior):

```ts
if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
  e.preventDefault();
  if (e.shiftKey) this.redoArrange();
  else this.undoArrange();
  return;
}
```

If `onKeydown`'s existing guards run AFTER key dispatch or don't cover ctrl-combos, mirror tone-tab's dedicated listener pattern instead (`tone-tab.ts`, "Ctrl+Z / Ctrl+Shift+Z" comment) — active-tab check + text-input target check, then preventDefault.

- [ ] **Step 6: Verify**

Run: `npm run build` — Expected: clean.
Run: `npm test` — Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/modules/arrange/arrange-tab.ts
git commit -m "Arrange: undo/redo for arrangement edits with toolbar buttons and Ctrl+Z"
```

---

## Manual verification (browser, per repo convention)

- Place, move, resize, remove clips — each undoes as one step; a long drag is ONE step.
- Redo after undo; new edit after undo kills the redo branch.
- Clip gain knob drag = one step; clip FX and track FX edits are undoable.
- Track mute/solo/rename/duplicate/remove are undoable.
- Ctrl+Z on the Tone tab still only affects patches; on Arrange only the arrangement.
- Switch projects / Reload from disk → history resets, buttons disabled.
