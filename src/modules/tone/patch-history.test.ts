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
