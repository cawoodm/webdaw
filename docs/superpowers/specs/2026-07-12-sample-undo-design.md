# Sample Tab Undo/Redo — Design

Date: 2026-07-12

## Goal

Complete the per-tab undo rollout (Tone `2026-07-08`, Arrange + Sequence
`2026-07-12`) with the Sample tab, reusing `SnapshotHistory<T>`
(`src/core/history.ts`). Session-only, no depth cap, per-tab scope.

## Shape: one whole-slice stack

The tab edits two model slices: `ProjectData.pads` (fixed 16-slot array of
`PadConfig | null` — pads have no ids) and `ProjectData.padLoops` (Beats).
Pads can't be keyed per-item, and grid edits interleave pad and loop state,
so unlike Tone/Sequence the history is a **single stack** under a fixed key
(like Arrange), snapshotting both slices together:

```ts
type SampleSnapshot = { pads: ProjectData['pads']; padLoops: ProjectData['padLoops'] };
private history = new SnapshotHistory<SampleSnapshot>();
private static readonly HISTORY_KEY = 'sample';
```

Undo/redo restore BOTH arrays wholesale:
`store.update(d => { d.pads = restored.pads; d.padLoops = restored.padLoops; })`.
Nothing holds long-lived references into these arrays across renders — the
tab and the Arrange scheduler look pads/loops up by index/id on each use —
so array replacement is safe (unlike Sequence, which must `Object.assign`
into a live object).

## Recorded / not recorded

Recorded (debounced 500ms, one step per quiet burst):

- loop grid edits: place/remove/move pad events, clear-all-events
- loop `bars` change, loop rename, **loop create and duplicate** (with a
  single-key stack these are plain undoable edits, not seed points — undo
  simply removes the new loop again)
- pad edits: load audio file, link tone (`tone:sendToPad` included — it
  mutates the pads slice, wherever the gesture started), gain/trim knobs,
  color, clear pad
- the `store.update(() => {})` persistence funnel for direct event-array
  mutations (mirrors Sequence's `commitNotes`)

Not recorded:

- **loop delete** (`removeLoop` also purges Arrange clips — cross-tab
  side effects put it outside this tab's undo, consistent with Tone and
  Sequence deletes). After a delete, **re-seed** the whole stack: history
  restarts from the post-delete state.
- selection (selected pad, active loop), count-in/overdub/quantize toggles
  — UI state.
- recording playback state; buffer cache operations.

## Mechanics

Same as the siblings: `scheduleHistoryCommit()` (500ms debounce) +
`flushHistoryCommit()` with the pending-timer no-op guard; flush before
undo/redo. Seed on `project:loaded` and after every loop delete.
`project:changed` does NOT re-render this tab (it renders imperatively), so
undo/redo call `this.render()` explicitly, like Arrange.

## UI

Undo/Redo icon buttons (same SVGs as Arrange/Sequence) appended to the
loop-management `iconBtn` cluster, `refreshHistoryButtons()` syncing
disabled state. `Ctrl+Z` / `Ctrl+Shift+Z` added to the tab's existing
`onKeyDown` handler (already registered on `window`), guarded by
active-tab + INPUT/SELECT/TEXTAREA/contentEditable target checks and
`preventDefault`, exactly like the other tabs.

## Testing

`SnapshotHistory` is already unit-tested; the wiring imports Tone so it's
manual-browser verified: place/remove Beat events and undo per burst;
undo a pad file-load and a tone-link (buffer still cached → pad plays);
undo loop create; confirm loop delete is NOT undoable and clears history;
knob drags are one step; Ctrl+Z scoping across all four tabs.
