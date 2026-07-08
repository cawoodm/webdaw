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
