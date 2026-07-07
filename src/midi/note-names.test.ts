import { describe, expect, it } from 'vitest';
import { midiToNoteName, noteNameToMidi } from './note-names';

describe('note-names', () => {
  it('round-trips MIDI 21..108', () => {
    for (let m = 21; m <= 108; m++) {
      expect(noteNameToMidi(midiToNoteName(m))).toBe(m);
    }
  });

  it('middle C is 60 / "C4"', () => {
    expect(noteNameToMidi('C4')).toBe(60);
    expect(midiToNoteName(60)).toBe('C4');
  });

  it('parses sharps', () => {
    expect(midiToNoteName(61)).toBe('C#4');
    expect(noteNameToMidi('C#4')).toBe(61);
  });
});
