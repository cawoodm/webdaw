import { describe, expect, it } from 'vitest';
import { buildSeqFile, parseSeqFile } from './sequence-file';
import type { Sequence } from './model';

describe('sequence-file', () => {
  it('round-trips a sequence through build -> parse', () => {
    const seq: Sequence = {
      id: 'abc123',
      name: 'Demo 4',
      bars: 4,
      instrument: { type: 'instrument', name: 'x' },
      notes: [
        { step: 0, note: 'C4', duration: 16, velocity: 0.7 },
        { step: 16, note: 'E4', duration: 8, velocity: 0.9 },
      ],
      wavFile: 'sequences/demo.wav',
    };

    const json = buildSeqFile(seq);
    const parsed = parseSeqFile(JSON.parse(json));

    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe('Demo 4');
    expect(parsed?.bars).toBe(4);
    expect(parsed?.instrument).toEqual({ type: 'instrument', name: 'x' });
    expect(parsed?.notes).toEqual(seq.notes);
  });

  it('rejects data with the wrong format tag', () => {
    expect(parseSeqFile({ format: 'nope' })).toBeNull();
  });
});
