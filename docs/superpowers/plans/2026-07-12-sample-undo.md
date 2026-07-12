# Sample Tab Undo/Redo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Undo/Redo on the Sample tab: one whole-slice history over `{pads, padLoops}` using the shared `SnapshotHistory`.

**Architecture:** Single fixed-key stack (Arrange-style) because pads have no ids and pad/loop edits interleave. Undo/redo replace both arrays wholesale inside `store.update` and re-render explicitly (this tab does not re-render on `project:changed`). Loop deletes re-seed instead of committing (cross-tab clip purge makes them non-undoable, per convention).

**Tech Stack:** Vanilla TypeScript (strict), `SnapshotHistory` (`src/core/history.ts`). Spec: `docs/superpowers/specs/2026-07-12-sample-undo-design.md`.

## Global Constraints

- Per-tab scope: Ctrl+Z here never touches patches/arrangement/sequences.
- Loop delete is NOT undoable — re-seed after it. Loop create/duplicate ARE undoable commits (single-key stack has no per-item seeding).
- Only `src/modules/sample/sample-tab.ts` changes; commit only that file with an explicit pathspec (`git commit -m "<msg>" -- <file>`) — the tree may carry concurrent-session changes. Never `git add -A`, never amend/rebase, no AI attribution.
- Re-read the file before editing; find call sites by searching, not the line numbers quoted here.

---

### Task 1: Sample tab undo/redo

**Files:**
- Modify: `src/modules/sample/sample-tab.ts`

**Interfaces:**
- Consumes: `SnapshotHistory<T>` from `src/core/history.ts` — `seed(key, value)`, `commit(key, value)`, `canUndo(key)`, `canRedo(key)`, `undo(key): T | null`, `redo(key): T | null`.
- Produces: user-facing only; no exports.

- [ ] **Step 1: Add history state + methods**

Imports: `import { SnapshotHistory } from '../../core/history';` and add `ProjectData` to the existing `import type` from `'../../core/model'`.

Class fields:

```ts
private history = new SnapshotHistory<{ pads: ProjectData['pads']; padLoops: ProjectData['padLoops'] }>();
private historyTimer: number | undefined;
private undoBtn: HTMLButtonElement | null = null;
private redoBtn: HTMLButtonElement | null = null;
private static readonly HISTORY_KEY = 'sample';
```

Methods (the snapshot object is built fresh at seed/commit time — `SnapshotHistory` structuredClones it):

```ts
private sampleSnapshot(): { pads: ProjectData['pads']; padLoops: ProjectData['padLoops'] } {
  return { pads: store.data.pads, padLoops: store.data.padLoops };
}

/** Debounced history commit: 500ms of no further sample edits = one undo step. */
private scheduleHistoryCommit(): void {
  clearTimeout(this.historyTimer);
  this.historyTimer = window.setTimeout(() => this.flushHistoryCommit(), 500);
}

/** Commit any pending edit immediately (no-op when nothing is pending). */
private flushHistoryCommit(): void {
  if (this.historyTimer === undefined) return;
  clearTimeout(this.historyTimer);
  this.historyTimer = undefined;
  this.history.commit(SampleTab.HISTORY_KEY, this.sampleSnapshot());
  this.refreshHistoryButtons();
}

/** Sync Undo/Redo disabled state without a full re-render. */
private refreshHistoryButtons(): void {
  if (this.undoBtn) this.undoBtn.disabled = !this.history.canUndo(SampleTab.HISTORY_KEY);
  if (this.redoBtn) this.redoBtn.disabled = !this.history.canRedo(SampleTab.HISTORY_KEY);
}

private undoSample(): void {
  this.flushHistoryCommit();
  const restored = this.history.undo(SampleTab.HISTORY_KEY);
  if (!restored) return;
  store.update((d) => {
    d.pads = restored.pads;
    d.padLoops = restored.padLoops;
  });
  void ensurePadBuffers();
  this.render();
}

private redoSample(): void {
  this.flushHistoryCommit();
  const restored = this.history.redo(SampleTab.HISTORY_KEY);
  if (!restored) return;
  store.update((d) => {
    d.pads = restored.pads;
    d.padLoops = restored.padLoops;
  });
  void ensurePadBuffers();
  this.render();
}
```

Check `ensurePadBuffers`'s actual signature in `src/core/pad-voice.ts` (it's already imported by this file) and call it the same way the `project:loaded` handler does — a restored tone-linked pad may need its buffer re-rendered. If the existing handler calls it with arguments or awaits it, mirror that exactly. Match the class's actual name if it isn't `SampleTab` (check the `export class` line).

Gotchas encoded above — keep them:
- `flushHistoryCommit` no-ops when nothing is pending (else the first Ctrl+Z is a visible no-op).
- Explicit `this.render()` after undo/redo — this tab does NOT re-render on `project:changed`.
- Restoring by array replacement is intentional here (nothing keeps references across renders); do NOT `Object.assign` element-wise.

- [ ] **Step 2: Seed points**

- `bus.on('project:loaded', …)` handler: add `this.history.seed(SampleTab.HISTORY_KEY, this.sampleSnapshot());` before its render.
- Loop delete handler (the `iconBtn` calling `store.update((d) => removeLoop(d, loop.id))`): after the update, `this.history.seed(SampleTab.HISTORY_KEY, this.sampleSnapshot());` — delete is not undoable; history restarts from the post-delete state. Do NOT also `scheduleHistoryCommit()` there.

- [ ] **Step 3: Instrument every pads/padLoops mutation**

Search the current file for `store.update(` and `store.scheduleSave(` and add `this.scheduleHistoryCommit();` after each call that mutates `d.pads` or `d.padLoops` (or a pad/loop object). As of writing:

- the `tone:sendToPad` bus handler (`store.update((d) => { … d.pads[index] = … })`)
- pad-event placement in the grid (`store.update(() => this.loop().events.push({ pad: index, time }))`)
- the bare persistence funnel `store.update(() => {})` (direct event-array mutations — instrument here once, like Sequence's `commitNotes`)
- loop `bars` select `onchange`
- loop create (`d.padLoops.push(l)`) and duplicate (`d.padLoops.push(copy)` or equivalent) — these COMMIT (undoable), not seed
- loop rename (`store.update(() => { loop.name = … })` or equivalent)
- clear-all-events (`store.update(() => (this.loop().events = []))`)
- sequence-to-loop / other `store.update((d) => { … })` sites that write pads or padLoops — check each one found
- pad editor: load audio file, load tone select, clear pad (`d.pads[index] = null`)
- pad knobs (`gain`/`trimStart`/`trimEnd` + any others) — the `store.scheduleSave()` calls in knob callbacks
- pad color picker (`store.scheduleSave()` or `store.update` — whichever it uses)

Do NOT instrument: `updateUi` calls (selection, quantize, count-in, overdub), playback/recording control flow, `store.setBuffer`/buffer-cache calls, and the loop-delete site (Step 2).

- [ ] **Step 4: Toolbar buttons**

Append to the loop-management `iconBtn` cluster (new/duplicate/delete loop area), after the last of those buttons, matching the local `iconBtn` helper's signature in this file:

```ts
const undoBtn = iconBtn(
  'Undo (Ctrl+Z)',
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  () => this.undoSample(),
);
const redoBtn = iconBtn(
  'Redo (Ctrl+Shift+Z)',
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>',
  () => this.redoSample(),
);
this.undoBtn = undoBtn;
this.redoBtn = redoBtn;
this.refreshHistoryButtons();
```

If `iconBtn` here is a standalone function vs class method, or takes different parameters, adapt the calls — keep titles and SVGs exactly.

- [ ] **Step 5: Keyboard shortcuts**

The tab already registers `window.addEventListener('keydown', this.onKeyDown)`. Extend `onKeyDown` — BEFORE its existing key handling, with the same active-tab guard it already uses (verify; add one if missing):

```ts
if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
  e.preventDefault();
  if (e.shiftKey) this.redoSample();
  else this.undoSample();
  return;
}
```

If `onKeyDown` lacks an active-tab check entirely (e.g. it checks per-key), add `if (!this.classList.contains('active-tab')) return;` semantics for this branch specifically.

- [ ] **Step 6: Verify**

Run: `npm run build` — Expected: clean.
Run: `npm test` — Expected: all pass (342+).

- [ ] **Step 7: Commit**

```bash
git commit -m "Sample: whole-slice undo/redo over pads and Beats with toolbar buttons and Ctrl+Z" -- src/modules/sample/sample-tab.ts
```

(Stage the file first with `git add src/modules/sample/sample-tab.ts`; the pathspec commit guards against concurrently staged files.)

---

## Manual verification (browser, per repo convention)

- Place/remove Beat events → one step per quiet burst; clear-all undoes.
- Load a WAV onto a pad, undo → previous pad state, still plays (buffer cached).
- Link a tone to a pad (from Tone tab's send too), undo on the SAMPLE tab restores.
- Loop create/duplicate/rename/bars all undoable; loop DELETE is not and empties the history.
- Knob drag (gain/trim) = one step; pad clear undoable.
- Ctrl+Z scoping holds across all four tabs.
