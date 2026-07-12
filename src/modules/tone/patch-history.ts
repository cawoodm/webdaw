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
