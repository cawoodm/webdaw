# Sequence Undo/Redo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-sequence Undo/Redo on the Sequence tab, reusing `SnapshotHistory<T>`.

**Architecture:** `sequence-tab.ts` owns a `SnapshotHistory<Sequence>` keyed by sequence id (Tone-style: many items per tab). Seed on project load and on sequence creation/duplication/import; debounced 500ms commits after every sequence mutation; undo/redo restore via `Object.assign` into the live object so references held by playback stay valid. The tab already re-renders on `project:changed`, so applying a snapshot through `store.update` refreshes the grid for free.

**Tech Stack:** Vanilla TypeScript (strict), existing `SnapshotHistory` (`src/core/history.ts`). Spec: `docs/superpowers/specs/2026-07-12-sequence-undo-design.md`.

## Global Constraints

- Per-tab scope: Ctrl+Z on the Sequence tab must not touch patches or the arrangement.
- Do NOT record: project BPM changes (MIDI import confirm), selection/quantize (UI state), sequence create/duplicate/import (those seed), sequence delete (discards).
- Only `src/modules/sequence/sequence-tab.ts` changes; commit only that file (the working tree has unrelated concurrent changes — never `git add -A`, never amend/rebase).
- Re-read the current file before editing; locate call sites by searching, not by the line numbers quoted here.
- Never add AI attribution to commits.

---

### Task 1: Sequence tab undo/redo

**Files:**
- Modify: `src/modules/sequence/sequence-tab.ts`

**Interfaces:**
- Consumes: `SnapshotHistory<T>` from `src/core/history.ts` — `seed(key, value)`, `commit(key, value)`, `canUndo(key)`, `canRedo(key)`, `undo(key): T | null`, `redo(key): T | null`, `discard(key)`.
- Produces: user-facing only; no exports.

- [ ] **Step 1: Add history state + methods**

Import: `import { SnapshotHistory } from '../../core/history';` (and ensure `Sequence` is imported as a type — it already is).

Class fields (near `private seqId = ''`):

```ts
private history = new SnapshotHistory<Sequence>();
private historyTimer: number | undefined;
private historySeqId = '';
private undoBtn: HTMLButtonElement | null = null;
private redoBtn: HTMLButtonElement | null = null;
```

Methods:

```ts
/** Debounced history commit for the sequence being edited: 500ms of quiet = one undo step. */
private scheduleHistoryCommit(): void {
  const seq = this.seq();
  if (!seq) return;
  // an edit to a different sequence than the pending one: capture the old edit first
  if (this.historyTimer !== undefined && this.historySeqId !== seq.id) this.flushHistoryCommit();
  this.historySeqId = seq.id;
  clearTimeout(this.historyTimer);
  this.historyTimer = window.setTimeout(() => this.flushHistoryCommit(), 500);
}

/** Commit any pending edit immediately (no-op when nothing is pending). */
private flushHistoryCommit(): void {
  if (this.historyTimer === undefined) return;
  clearTimeout(this.historyTimer);
  this.historyTimer = undefined;
  const seq = store.data.sequences.find(s => s.id === this.historySeqId);
  if (seq) this.history.commit(seq.id, seq);
  this.refreshHistoryButtons();
}

/** Sync Undo/Redo disabled state without a full re-render. */
private refreshHistoryButtons(): void {
  const seq = this.seq();
  if (this.undoBtn) this.undoBtn.disabled = !seq || !this.history.canUndo(seq.id);
  if (this.redoBtn) this.redoBtn.disabled = !seq || !this.history.canRedo(seq.id);
}

private undoSeq(): void {
  this.flushHistoryCommit();
  const seq = this.seq();
  if (!seq) return;
  const restored = this.history.undo(seq.id);
  if (!restored) return;
  store.update(() => Object.assign(seq, restored));
  this.rebuildLivePartIfPlaying();
}

private redoSeq(): void {
  this.flushHistoryCommit();
  const seq = this.seq();
  if (!seq) return;
  const restored = this.history.redo(seq.id);
  if (!restored) return;
  store.update(() => Object.assign(seq, restored));
  this.rebuildLivePartIfPlaying();
}
```

Gotchas the code above already encodes — keep them:
- `flushHistoryCommit` early-returns when no timer is pending, so undo
  doesn't first commit a duplicate of the current state (which would make
  the first Ctrl+Z a visible no-op).
- `store.update(() => Object.assign(seq, restored))` keeps the live
  object's identity — playback and the arrangement hold references to it.
  `project:changed` (already subscribed in this tab) triggers the
  re-render; do NOT add an extra `this.render()`.

- [ ] **Step 2: Seed / discard at lifecycle points**

- In the `bus.on('project:loaded', …)` handler add, before `this.render()`:
  ```ts
  for (const s of store.data.sequences) this.history.seed(s.id, s);
  ```
- New-sequence button (the `iconBtn` whose handler does `store.update(d => d.sequences.push(s))`): after the update, `this.history.seed(s.id, s);`
- Duplicate button (`store.update(d => d.sequences.push(copy))`): `this.history.seed(copy.id, copy);`
- `importMidiFiles()`: after the `store.update` that pushes `created` sequences, `for (const s of created) this.history.seed(s.id, s);`
- `importSeqFiles()`: overwrite branch → after the update, `this.history.seed(existing.id, existing);` (fresh checkpoint, prior history gone — the import replaced the content wholesale); both as-new branches → `this.history.seed(seq.id, seq);`
- Delete button (`store.update(d => removeSequence(d, seq.id))`): `this.history.discard(seq.id);`

- [ ] **Step 3: Flush on selection switch**

In `selectSeq(id)`, first line: `this.flushHistoryCommit();` — captures the outgoing sequence's pending edit (the pending commit is keyed by `historySeqId`, so it lands on the right stack even mid-switch).

- [ ] **Step 4: Instrument every sequence mutation**

Search the current file for `store.update(` and `store.scheduleSave(` and add `this.scheduleHistoryCommit();` after each call that mutates a `Sequence` object. As of writing:

- `commitNotes()` — the funnel for all grid note edits and `clearNotes()`; instrument HERE once rather than at each grid handler
- `noteOffInternal()` — the live-recording `store.update(() => seq.notes.push(…))`
- the instrument `<select>` `onchange` (five branches assigning `seq.instrument`) — once, after the branch chain
- the WAV file pick that assigns `seq.instrument = {type: 'wav', file: path}`
- `importInstrumentFile()`'s `store.update(() => (seq.instrument = {type: 'instrument', name: res.name}))`
- rename button (`store.update(() => { seq.name = … })` or equivalent prompt handler)
- the `bars` input `onchange` (`store.update(() => (seq.bars = v))`)
- any `store.scheduleSave()` site that mutated the seq (e.g. a knob writing a seq field) — check each; skip ones that only touch non-sequence state

Do NOT instrument: `store.update(d => (d.bpm = bpm))` (MIDI import tempo confirm), the create/duplicate/import pushes (they seed instead — a commit right after seeding would create an undo step from nothing), `updateUi` calls, playback code.

- [ ] **Step 5: Toolbar buttons**

In the toolbar cluster of sequence-management `this.iconBtn(…)` calls (new/duplicate/rename/delete), append after the delete button:

```ts
this.undoBtn = this.iconBtn(
  'Undo (Ctrl+Z)',
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  () => this.undoSeq(),
);
this.redoBtn = this.iconBtn(
  'Redo (Ctrl+Shift+Z)',
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>',
  () => this.redoSeq(),
);
```

Append both to the same container as those buttons and call `this.refreshHistoryButtons();` right after (the toolbar is rebuilt by `render()`, which keeps the disabled state current after every project:changed).

Match `this.iconBtn`'s actual signature in this file (it's a class method here, unlike Arrange's local helper).

- [ ] **Step 6: Keyboard shortcuts**

In `connectedCallback()`, alongside the existing listeners, mirroring tone-tab's Ctrl+Z listener:

```ts
// Ctrl+Z / Ctrl+Shift+Z: undo/redo the current sequence (sequence tab only)
window.addEventListener('keydown', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  if (!this.isActive()) return;
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
  if (e.key.toLowerCase() !== 'z') return;
  e.preventDefault();
  if (e.shiftKey) this.redoSeq();
  else this.undoSeq();
});
```

- [ ] **Step 7: Verify**

Run: `npm run build` — Expected: clean except the KNOWN pre-existing `src/plugins/eq-math.test.ts` TS2307 (untracked WIP from another session; ignore it, nothing else may fail).
Run: `npm test` — Expected: 332+ tests pass; only the pre-existing `eq-math.test.ts` suite may fail.

- [ ] **Step 8: Commit**

```bash
git add src/modules/sequence/sequence-tab.ts
git commit -m "Sequence: per-sequence undo/redo with toolbar buttons and Ctrl+Z"
```

---

## Manual verification (browser, per repo convention)

- Paint several notes with <500ms gaps → one undo step; with a pause → separate steps.
- Undo/redo: instrument change, rename, bars change, clear-all-notes.
- Switch sequences mid-edit → pending edit captured on the right stack; each sequence has an independent history.
- Record a take, undo it phrase by phrase; deleting a sequence is not undoable.
- Ctrl+Z on Tone and Arrange still only affects their own tabs.
