# Tone Patch Undo/Redo/Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Undo, Redo, and Reset (jump to checkpoint) to the Tone tab, so edits to a patch since project load / creation / import can be stepped back through or discarded entirely.

**Architecture:** A new pure `PatchHistory` class (`src/modules/tone/patch-history.ts`) keeps a per-patch-id array of snapshots + a current index. `ToneTab` seeds a checkpoint at project load / patch creation / duplication / import, debounce-commits a new entry ~500ms after `save()` settles (coalescing a whole knob drag into one step), and exposes three toolbar buttons + `Ctrl+Z`/`Ctrl+Shift+Z` that apply the returned snapshot via `Object.assign` and re-render.

**Tech Stack:** TypeScript, Vitest, vanilla Web Components — no Tone.js or DOM in the history class itself.

## Global Constraints

- `npm run build` runs `tsc --noEmit` with `noUnusedLocals`/`noUnusedParameters` on — every task must build clean.
- `PatchHistory` must have no Tone.js import so it stays unit-testable under Vitest.
- Scope is Tone tab patches only — no other tab gets undo/redo in this plan.
- No confirmation dialog on Reset (matches the existing "Delete patch" button).
- Checkpoints are seeded at project load / new / duplicate / import — never re-seeded by the continuous autosave tick.

---

## File Structure

- **Create** `src/modules/tone/patch-history.ts` — pure `PatchHistory` class: seed/commit/undo/redo/reset/discard.
- **Create** `src/modules/tone/patch-history.test.ts` — unit tests for the above.
- **Modify** `src/modules/tone/tone-tab.ts` — seed/discard hookup, debounced commit in `save()`, flush-on-switch, three toolbar buttons, keyboard shortcuts.

---

## Task 1: `PatchHistory` — pure undo/redo/reset data structure

**Files:**
- Create: `src/modules/tone/patch-history.ts`
- Test: `src/modules/tone/patch-history.test.ts`

**Interfaces:**
- Produces: `class PatchHistory` with `seed(patch: TonePatch): void`, `commit(patch: TonePatch): void`, `canUndo(patchId: string): boolean`, `canRedo(patchId: string): boolean`, `undo(patchId: string): TonePatch | null`, `redo(patchId: string): TonePatch | null`, `reset(patchId: string): TonePatch | null`, `discard(patchId: string): void`. Consumed by `tone-tab.ts` in Tasks 2-3.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/tone/patch-history.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { defaultPatch } from '../../core/model';
import { PatchHistory } from './patch-history';

function makePatch(drive = 0) {
  const p = defaultPatch();
  p.drive = drive;
  return p;
}

describe('PatchHistory', () => {
  it('seed establishes a checkpoint with nothing to undo/redo', () => {
    const h = new PatchHistory();
    const p = makePatch();
    h.seed(p);
    expect(h.canUndo(p.id)).toBe(false);
    expect(h.canRedo(p.id)).toBe(false);
  });

  it('commit records an edit that can be undone back to the checkpoint', () => {
    const h = new PatchHistory();
    const p = makePatch(0);
    h.seed(p);
    p.drive = 0.5;
    h.commit(p);
    expect(h.canUndo(p.id)).toBe(true);
    const undone = h.undo(p.id);
    expect(undone?.drive).toBe(0);
    expect(h.canUndo(p.id)).toBe(false);
  });

  it('redo re-applies an undone edit', () => {
    const h = new PatchHistory();
    const p = makePatch(0);
    h.seed(p);
    p.drive = 0.5;
    h.commit(p);
    h.undo(p.id);
    expect(h.canRedo(p.id)).toBe(true);
    const redone = h.redo(p.id);
    expect(redone?.drive).toBe(0.5);
    expect(h.canRedo(p.id)).toBe(false);
  });

  it('a new commit after undoing truncates the redo branch', () => {
    const h = new PatchHistory();
    const p = makePatch(0);
    h.seed(p);
    p.drive = 0.5;
    h.commit(p);
    h.undo(p.id); // back to drive: 0
    p.drive = 0.9; // a genuinely new edit from the checkpoint
    h.commit(p);
    expect(h.canRedo(p.id)).toBe(false); // the drive:0.5 branch is gone
    const undone = h.undo(p.id);
    expect(undone?.drive).toBe(0);
  });

  it('reset jumps straight to the checkpoint without truncating redo', () => {
    const h = new PatchHistory();
    const p = makePatch(0);
    h.seed(p);
    p.drive = 0.3;
    h.commit(p);
    p.drive = 0.6;
    h.commit(p);
    const wasReset = h.reset(p.id);
    expect(wasReset?.drive).toBe(0);
    expect(h.canUndo(p.id)).toBe(false);
    expect(h.canRedo(p.id)).toBe(true);
    const redone = h.redo(p.id);
    expect(redone?.drive).toBe(0.3);
  });

  it('undo/redo/reset return null when there is nothing to do', () => {
    const h = new PatchHistory();
    const p = makePatch();
    h.seed(p);
    expect(h.undo(p.id)).toBeNull();
    expect(h.redo(p.id)).toBeNull();
    expect(h.reset(p.id)).toBeNull();
  });

  it("discard drops a patch's history entirely", () => {
    const h = new PatchHistory();
    const p = makePatch(0);
    h.seed(p);
    p.drive = 0.5;
    h.commit(p);
    h.discard(p.id);
    expect(h.canUndo(p.id)).toBe(false);
    expect(h.canRedo(p.id)).toBe(false);
  });

  it('commit seeds on the fly for a patch with no prior checkpoint', () => {
    const h = new PatchHistory();
    const p = makePatch(0);
    p.drive = 0.4;
    expect(() => h.commit(p)).not.toThrow();
    expect(h.canUndo(p.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/tone/patch-history.test.ts`
Expected: FAIL with "Cannot find module './patch-history'" (file doesn't exist yet)

- [ ] **Step 3: Write the implementation**

Create `src/modules/tone/patch-history.ts`:

```ts
import type { TonePatch } from '../../core/model';

interface HistoryEntry {
  history: TonePatch[]; // snapshots, oldest first; history[0] is the checkpoint
  index: number; // which entry is "current"
}

/**
 * Per-patch undo/redo/reset history for the Tone tab. Pure data structure —
 * no Tone.js or DOM — unit-testable under Vitest.
 */
export class PatchHistory {
  private entries = new Map<string, HistoryEntry>();

  /** Establish a fresh checkpoint: project load, new/duplicated/imported patch. */
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/tone/patch-history.test.ts`
Expected: PASS (all 8 cases)

- [ ] **Step 5: Type-check the whole project**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 6: Commit**

```bash
git add src/modules/tone/patch-history.ts src/modules/tone/patch-history.test.ts
git commit -m "Add pure PatchHistory: per-patch undo/redo/reset stack"
```

---

## Task 2: Wire `PatchHistory` into `ToneTab` — seeding, commit, flush

**Files:**
- Modify: `src/modules/tone/tone-tab.ts`

**Interfaces:**
- Consumes: `PatchHistory` (Task 1).
- Produces: `private history: PatchHistory` and `private flushHistoryCommit(): void` on `ToneTab`, consumed by Task 3's Undo/Redo/Reset button handlers and keyboard shortcuts.

- [ ] **Step 1: Import `PatchHistory` and add fields**

Add the import after the `./scope-view` type import (`src/modules/tone/tone-tab.ts:43`):

```ts
import type { EnvelopeHandle } from './scope-view';
import { PatchHistory } from './patch-history';
```

Add two fields after `private envDragParam: EnvelopeHandle['param'] | null = null;` (`src/modules/tone/tone-tab.ts:98`):

```ts
  private envDragParam: EnvelopeHandle['param'] | null = null;
  private history = new PatchHistory();
  private historyTimer: number | undefined;
```

- [ ] **Step 2: Seed every patch on project load**

Change `src/modules/tone/tone-tab.ts:102`:

```ts
    bus.on('project:loaded', () => {
      for (const p of store.data.patches) this.history.seed(p);
      this.render();
    });
```

(was `bus.on('project:loaded', () => this.render());`)

- [ ] **Step 3: Flush pending edits and seed lazily-created patches in `patch()`/`selectPatch()`**

Replace `src/modules/tone/tone-tab.ts:247-258` (`patch()` and `selectPatch()`):

```ts
  private patch(): TonePatch {
    const found = store.data.patches.find((p) => p.id === this.patchId);
    if (found) return found;
    if (store.data.patches.length === 0) {
      const p = defaultPatch();
      store.data.patches.push(p);
      this.history.seed(p);
    }
    this.selectPatch(store.data.patches[0].id);
    return store.data.patches[0];
  }

  private selectPatch(id: string): void {
    this.flushHistoryCommit();
    this.patchId = id;
    updateUi((s) => (s.tone.patchId = id));
  }

  /** Commit a pending debounced edit immediately instead of waiting for the timer. */
  private flushHistoryCommit(): void {
    if (this.historyTimer === undefined) return;
    clearTimeout(this.historyTimer);
    this.historyTimer = undefined;
    const current = store.data.patches.find((p) => p.id === this.patchId);
    if (current) this.history.commit(current);
  }
```

- [ ] **Step 4: Debounce a commit inside `save()`**

Change `save()` (`src/modules/tone/tone-tab.ts:335-342`):

```ts
  private save(): void {
    clearTimeout(this.historyTimer);
    this.historyTimer = window.setTimeout(() => {
      this.historyTimer = undefined;
      this.history.commit(this.patch());
    }, 500);
    store.scheduleSave();
    // overlays track the dial instantly from the cached render; the audio
    // re-render (and its fresh waveform/spectrum) follows once edits settle
    this.redrawStatic();
    clearTimeout(this.staticTimer);
    this.staticTimer = window.setTimeout(() => void this.updateStatic(), 400);
  }
```

- [ ] **Step 5: Seed on New patch / Duplicate patch, discard on Delete patch**

In the "New patch" button handler (`src/modules/tone/tone-tab.ts:601-608`), add a seed call:

```ts
        () => {
          const p = defaultPatch();
          p.id = uid();
          p.name = this.uniquePatchName(`Patch ${store.data.patches.length + 1}`);
          store.update((d) => d.patches.push(p));
          this.history.seed(p);
          this.selectPatch(p.id);
          this.render();
        },
```

In the "Duplicate patch" button handler (`src/modules/tone/tone-tab.ts:614-622`):

```ts
        () => {
          const copy = structuredClone(patch);
          copy.id = uid();
          copy.name = this.uniquePatchName(`${patch.name} copy`);
          delete copy.wavFile;
          store.update((d) => d.patches.push(copy));
          this.history.seed(copy);
          this.selectPatch(copy.id);
          this.render();
        },
```

In the "Delete patch" button handler (`src/modules/tone/tone-tab.ts:644-652`):

```ts
        () => {
          store.update((d) => {
            d.patches = d.patches.filter((p) => p.id !== patch.id);
            // a deleted tone disappears from the sampler pads too
            d.pads = d.pads.map((p) => (p?.toneId === patch.id ? null : p));
          });
          this.history.discard(patch.id);
          this.selectPatch('');
          this.render();
        },
```

- [ ] **Step 6: Seed on patch import (both branches)**

In `importPatchFiles()` (`src/modules/tone/tone-tab.ts:189-237`), the "overwrite an existing patch" branch (around line 215):

```ts
        if (overwrite) {
          // keep the existing id so pad links stay intact
          store.update(() => Object.assign(existing, patch, { id: existing.id, name: existing.name }));
          this.history.seed(existing);
          // linked pads always play the latest render
          store.setBuffer(toneBufferKey(existing.id), await renderPatch(existing));
          lastId = existing.id;
          imported++;
          continue;
        }
```

And the shared "push a new patch" line (around line 228), used by both the fresh-import and the rename-instead-of-overwrite paths:

```ts
      store.update((d) => d.patches.push(patch));
      this.history.seed(patch);
      lastId = patch.id;
      imported++;
```

- [ ] **Step 7: Commit the structural layer edits that bypass `save()`**

In the layer "Duplicate" button handler (`src/modules/tone/tone-tab.ts:715-718`):

```ts
        btn('Duplicate', () => {
          this.flushHistoryCommit();
          store.update(() => patch.layers.splice(i + 1, 0, { ...layer, phase: (layer.phase + 90) % 360 }));
          this.history.commit(patch);
          this.render();
        }),
```

In the layer "✕" (remove) button handler (`src/modules/tone/tone-tab.ts:719-723`):

```ts
        btn('✕', () => {
          if (patch.layers.length <= 1) return;
          this.flushHistoryCommit();
          store.update(() => patch.layers.splice(i, 1));
          this.history.commit(patch);
          this.render();
        }),
```

- [ ] **Step 8: Type-check**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 9: Manual smoke check in the browser**

Run: `npm run dev`, open the app, go to the Tone tab. Drag a knob, wait a second, switch to another tab and back — confirm no console errors and the patch still displays/plays correctly (there's no UI yet to exercise undo/redo/reset directly; Task 3 adds that).

- [ ] **Step 10: Commit**

```bash
git add src/modules/tone/tone-tab.ts
git commit -m "Wire PatchHistory into ToneTab: seed checkpoints, debounce commits, flush on switch"
```

---

## Task 3: Undo/Redo/Reset toolbar buttons + keyboard shortcuts

**Files:**
- Modify: `src/modules/tone/tone-tab.ts`

**Interfaces:**
- Consumes: `this.history`, `this.flushHistoryCommit()` (Task 2).
- Produces: `private undoPatch(): void`, `private redoPatch(): void`, `private resetPatch(): void` — no other file depends on these.

- [ ] **Step 1: Add the three handler methods**

Add these methods to the `ToneTab` class, right after `flushHistoryCommit()` (added in Task 2, Step 3):

```ts
  private undoPatch(): void {
    this.flushHistoryCommit();
    const patch = this.patch();
    const restored = this.history.undo(patch.id);
    if (!restored) return;
    Object.assign(patch, restored);
    store.scheduleSave();
    this.render();
  }

  private redoPatch(): void {
    this.flushHistoryCommit();
    const patch = this.patch();
    const restored = this.history.redo(patch.id);
    if (!restored) return;
    Object.assign(patch, restored);
    store.scheduleSave();
    this.render();
  }

  private resetPatch(): void {
    this.flushHistoryCommit();
    const patch = this.patch();
    const restored = this.history.reset(patch.id);
    if (!restored) return;
    Object.assign(patch, restored);
    store.scheduleSave();
    this.render();
  }
```

- [ ] **Step 2: Add the three toolbar buttons**

Change `src/modules/tone/tone-tab.ts:595-654` (the `bar.append(select, iconBtn('New patch', ...), ...)` call) — insert three new buttons between `select` and the "New patch" button:

```ts
    const undoBtn = iconBtn(
      'Undo (Ctrl+Z)',
      `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>`,
      () => this.undoPatch(),
    );
    undoBtn.disabled = !this.history.canUndo(patch.id);
    const redoBtn = iconBtn(
      'Redo (Ctrl+Shift+Z)',
      `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/></svg>`,
      () => this.redoPatch(),
    );
    redoBtn.disabled = !this.history.canRedo(patch.id);
    const resetBtn = iconBtn(
      'Reset to last checkpoint',
      `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
      () => this.resetPatch(),
    );
    resetBtn.disabled = !this.history.canUndo(patch.id);
    bar.append(
      select,
      undoBtn,
      redoBtn,
      resetBtn,
      iconBtn(
        'New patch',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
        () => {
          const p = defaultPatch();
          p.id = uid();
          p.name = this.uniquePatchName(`Patch ${store.data.patches.length + 1}`);
          store.update((d) => d.patches.push(p));
          this.history.seed(p);
          this.selectPatch(p.id);
          this.render();
        },
      ),
      iconBtn(
        'Duplicate patch',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
        () => {
          const copy = structuredClone(patch);
          copy.id = uid();
          copy.name = this.uniquePatchName(`${patch.name} copy`);
          delete copy.wavFile;
          store.update((d) => d.patches.push(copy));
          this.history.seed(copy);
          this.selectPatch(copy.id);
          this.render();
        },
      ),
      iconBtn(
        'Rename patch',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
          <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>`,
        () => {
          const name = prompt('Patch name', patch.name);
          if (name) {
            store.update((d) => {
              patch.name = name;
              // pads linked to this tone carry a copy of its name
              for (const pad of d.pads) if (pad?.toneId === patch.id) pad.name = name;
            });
            this.render();
          }
        },
      ),
      iconBtn(
        'Delete patch',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
        () => {
          store.update((d) => {
            d.patches = d.patches.filter((p) => p.id !== patch.id);
            // a deleted tone disappears from the sampler pads too
            d.pads = d.pads.map((p) => (p?.toneId === patch.id ? null : p));
          });
          this.history.discard(patch.id);
          this.selectPatch('');
          this.render();
        },
      ),
    );
```

(This replaces the whole `bar.append(...)` call added in Task 2 Step 5 — the New/Duplicate/Delete handler bodies are unchanged from Task 2, just now preceded by the three new buttons in the same `append` call.)

- [ ] **Step 3: Add keyboard shortcuts**

Add a new `keydown` listener in `connectedCallback()`, right after the existing hotkey "1" block (`src/modules/tone/tone-tab.ts:138-147`):

```ts
    // Ctrl+Z / Ctrl+Shift+Z: undo/redo the current patch (tone tab only)
    window.addEventListener('keydown', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (!this.classList.contains('active-tab')) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (e.key.toLowerCase() !== 'z') return;
      e.preventDefault();
      if (e.shiftKey) this.redoPatch();
      else this.undoPatch();
    });
```

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 5: Manual verification in the browser**

Run: `npm run dev`, open the app, go to the Tone tab.

1. Confirm Undo, Redo, and Reset buttons appear right after the patch selector, and Undo/Redo/Reset are all disabled (greyed out) on a freshly-loaded patch with no edits yet.
2. Drag the Drive knob, wait ~1 second (past the 500ms debounce): Undo and Reset should become enabled; Redo stays disabled.
3. Click Undo: the knob value reverts to before the drag; Undo becomes disabled again, Redo becomes enabled.
4. Click Redo: the knob value returns to the dragged value.
5. Make several different edits (e.g. drag Attack, then toggle the Envelope on/off checkbox, then change the Envelope shape select) with pauses between them; confirm each is a separate Undo step (three clicks of Undo to get back to the checkpoint), and Reset gets there in one click.
6. After Reset, click Redo repeatedly — confirm it steps forward through the same edits again.
7. Make a NEW edit after undoing partway back — confirm Redo becomes disabled (the abandoned branch is gone).
8. Add a layer, duplicate a layer, remove a layer — confirm each is undoable and restores the correct layer count/order.
9. Press `Ctrl+Z` / `Ctrl+Shift+Z` while the Tone tab is active — confirm they undo/redo. Switch to another tab and press `Ctrl+Z` — confirm it does nothing to the tone patch (browser/OS default undo, if any, is fine).
10. Switch to a different patch mid-edit (knob dragged, before the 500ms debounce fires) — switch back and confirm Undo still reverts that edit (it wasn't dropped).
11. Delete a patch that has undo history, create a new patch — confirm no console errors (history cleanup didn't leak/crash).
12. Import a `.json` patch that overwrites an existing one — confirm Undo is disabled immediately after (fresh checkpoint, nothing to undo yet).
13. Confirm no console errors throughout.

- [ ] **Step 6: Commit**

```bash
git add src/modules/tone/tone-tab.ts
git commit -m "Add Undo/Redo/Reset toolbar buttons and Ctrl+Z/Ctrl+Shift+Z shortcuts to the Tone tab"
```

---

## Task 4: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the new `patch-history.test.ts` cases from Task 1.

- [ ] **Step 2: Full type-check and build**

Run: `npm run build`
Expected: succeeds with zero errors/warnings.

- [ ] **Step 3: Report results**

No commit for this task — it's a verification pass. If any step fails, return to the relevant earlier task, fix, and re-run this task's steps from the top.

---

## Plan Self-Review Notes

- **Spec coverage:** `PatchHistory` data model (Task 1), checkpoint seeding at load/new/duplicate/import + discard on delete (Task 2), debounced commit + flush-on-switch (Task 2), toolbar buttons + disabled-state + keyboard shortcuts (Task 3) — every spec section maps to a task.
- **Placeholder scan:** no TBD/TODO; every step shows complete code.
- **Type consistency:** `PatchHistory`'s method names/signatures (`seed`, `commit`, `canUndo`, `canRedo`, `undo`, `redo`, `reset`, `discard`) are used identically in Tasks 2-3; `flushHistoryCommit()` introduced in Task 2 is reused unchanged in Task 3's three handlers.
