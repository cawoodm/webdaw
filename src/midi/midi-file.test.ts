import { describe, expect, it } from 'vitest';
import type { Sequence } from '../core/model';
import { buildMidiFile, parseMidiFile } from './midi-file';

/** @tonejs/midi's toArray() returns a Uint8Array view; slice out its backing buffer for parseMidiFile. */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

describe('midi-file round-trip', () => {
  it('round-trips a single sequence with varied notes', () => {
    const seq: Sequence = {
      id: 'seq1',
      name: 'Lead',
      bars: 1,
      notes: [
        { step: 0, note: 'C4', duration: 4, velocity: 0.8 },
        { step: 4, note: 'E4', duration: 2, velocity: 0.5 },
        { step: 8, note: 'G4', duration: 8, velocity: 1 },
      ],
    };
    const bytes = buildMidiFile([seq], 120);
    const result = parseMidiFile(toArrayBuffer(bytes));

    expect(result.bpm).toBe(120);
    expect(result.sequences).toHaveLength(1);
    const imported = result.sequences[0];
    expect(imported.notes).toHaveLength(3);
    for (let i = 0; i < seq.notes.length; i++) {
      expect(imported.notes[i].step).toBe(seq.notes[i].step);
      expect(imported.notes[i].duration).toBe(seq.notes[i].duration);
      expect(imported.notes[i].note).toBe(seq.notes[i].note);
      expect(Math.abs(imported.notes[i].velocity - seq.notes[i].velocity)).toBeLessThan(1 / 127);
    }
  });

  it('round-trips multiple sequences preserving names and count', () => {
    const seqA: Sequence = {
      id: 'a',
      name: 'Bass',
      bars: 1,
      notes: [{ step: 0, note: 'C2', duration: 4, velocity: 0.9 }],
    };
    const seqB: Sequence = {
      id: 'b',
      name: 'Melody',
      bars: 1,
      notes: [{ step: 2, note: 'A4', duration: 4, velocity: 0.6 }],
    };
    const bytes = buildMidiFile([seqA, seqB], 90);
    const result = parseMidiFile(toArrayBuffer(bytes));

    expect(result.sequences).toHaveLength(2);
    expect(result.sequences.map((s) => s.name)).toEqual(['Bass', 'Melody']);
    expect(result.bpm).toBe(90);
  });
});
