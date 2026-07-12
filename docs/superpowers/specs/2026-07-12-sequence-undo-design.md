# Sequence Undo/Redo — Design

Date: 2026-07-12

## Goal

Extend the per-tab undo pattern (Tone: `2026-07-08-tone-undo-redo-reset-design.md`,
Arrange: `2026-07-12-arrange-undo-design.md`) to the Sequence tab, reusing
`SnapshotHistory<T>` from `src/core/history.ts`. Like Tone — and unlike
Arrange — the tab edits many items, so history is **per sequence id**:
switching sequences preserves each one's stack, and undo affects only the
selected sequence. Session-only, no depth cap, per-tab scope (Ctrl+Z here
never touches patches or the arrangement).

## What is (and isn't) recorded

Snapshots are whole `Sequence` objects (`id/name/bars/instrument/notes`).
Recorded edits — every mutation of the selected sequence that originates in
the tab:

- grid note edits: place, move, resize, delete, velocity — all funnel
  through `commitNotes()` (the documented "after direct mutations of
  seq.notes" hook), plus `clearNotes()` which already calls it
- live-recorded notes (`noteOffInternal`'s `store.update(… notes.push …)`)
- instrument selection changes (the instrument `<select>` handler's five
  branches and the WAV-pick + `.inst.json` import assignment)
- `bars` count input, rename

Deliberately NOT recorded:

- **project BPM** (`store.update(d => (d.bpm = bpm))` in the MIDI-import
  confirm) — global transport state, not sequence data
- sequence selection / quantize dropdown — UI state (`updateUi`)
- create / duplicate / import-as-new — these **seed** the new id instead
  (its birth state is the checkpoint); import-overwrite **re-seeds** the
  existing id (fresh checkpoint, prior history discarded)
- delete sequence — `discard(id)`; not undoable, matching Tone's delete
  (and deletion also purges Arrange clips, which is outside this tab's
  scope)

A recorded take pauses longer than the 500ms debounce → it lands as more
than one undo step. Accepted: undo then removes the last phrase, not the
whole take.

## Mechanics (mirrors tone-tab)

`SequenceTab` owns `private history = new SnapshotHistory<Sequence>()`:

- `seed`: on `project:loaded` for every sequence; on create/duplicate/
  import for the new/overwritten sequence.
- `scheduleHistoryCommit()` / `flushHistoryCommit()`: 500ms debounce, keyed
  by the sequence the edit touched (capture `seq.id` at schedule time —
  the selection can change before the timer fires). Flush pending commits
  in `selectSeq()` before switching, so the outgoing sequence's last edit
  is captured — and in `undoSeq()`/`redoSeq()` before reading the stack.
  Flush is a no-op when no commit is pending (a pending-timer guard), so
  undo doesn't push a duplicate snapshot that eats the first Ctrl+Z.
- Apply: `store.update(() => Object.assign(seq, restored))` — keeps object
  identity (playback/liveParts hold references); `project:changed` already
  re-renders this tab, and `rebuildLivePartIfPlaying()` makes the change
  audible mid-playback, same as `commitNotes()`.

## UI

Undo/Redo icon buttons (same SVGs as Arrange) in the sequence toolbar,
appended to the existing sequence-management `iconBtn` cluster (after
delete), disabled-state synced by a `refreshHistoryButtons()` that reads
`canUndo/canRedo` for the current `seq().id`. `Ctrl+Z` / `Ctrl+Shift+Z` via
a window keydown listener registered in `connectedCallback()`, guarded
exactly like tone-tab's: active-tab check + INPUT/SELECT/TEXTAREA/
contentEditable target check + `preventDefault`.

## Testing

`SnapshotHistory` is already covered by `src/core/history.test.ts`; no new
unit tests (the tab wiring imports Tone and can't run under Vitest).
Manual browser checks: paint notes and undo one step per pause-separated
burst; undo/redo an instrument change, a rename, a bars change, a clear-
all; switch sequences and confirm independent stacks plus the pending-edit
flush; record a take and undo it phrase by phrase; delete a sequence and
confirm undo doesn't resurrect it; Ctrl+Z on Tone/Arrange still scoped to
their own tabs.
