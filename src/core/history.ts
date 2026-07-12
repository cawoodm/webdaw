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
