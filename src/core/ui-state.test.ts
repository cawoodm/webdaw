import { describe, expect, it } from 'vitest';
import { applyUiState, serializeUiState, uiState } from './ui-state';

describe('applyUiState', () => {
  it('returns full defaults when nothing is stored', () => {
    const s = applyUiState();
    expect(s.activeTab).toBe('tone');
    expect(s.sample.selectedPad).toBe(0);
    expect(s.arrange.pxPerBar).toBe(16);
  });

  it('deep-merges partial stored state over defaults', () => {
    const s = applyUiState({ activeTab: 'sample', tone: { patchId: 'abc' } as never });
    expect(s.activeTab).toBe('sample');
    expect(s.tone.patchId).toBe('abc');
    expect(s.tone.live).toBe(false); // default preserved
    expect(s.sequence.seqId).toBe('');
  });

  it('serializes a detached snapshot that survives a JSON round-trip', () => {
    applyUiState({ arrange: { palette: 'seq:1', snapBeats: 0.5 } } as never);
    const snapshot = serializeUiState();
    expect(snapshot).toEqual(uiState());
    expect(snapshot).not.toBe(uiState());
    snapshot.arrange.snapBeats = 2;
    expect(uiState().arrange.snapBeats).toBe(0.5);
  });
});
