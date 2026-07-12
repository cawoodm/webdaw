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
