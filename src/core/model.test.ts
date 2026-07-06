import { describe, expect, it } from 'vitest';
import { defaultProject, PAD_COUNT, pianoNotes, uid } from './model';
import { DEFAULT_KEYMAP } from '../midi/keymap';

describe('project model', () => {
  it('creates a well-formed default project', () => {
    const p = defaultProject();
    expect(p.version).toBe(1);
    expect(p.pads).toHaveLength(PAD_COUNT);
    expect(p.patches).toHaveLength(1);
    expect(p.patches[0].layers.length).toBeGreaterThan(0);
    expect(p.bpm).toBe(120);
    // survives a JSON round-trip (persistence format)
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => uid()));
    expect(ids.size).toBe(100);
  });
});

describe('pianoNotes', () => {
  it('spans the 88 keys from A0 to C8', () => {
    const notes = pianoNotes();
    expect(notes.length).toBe(88);
    expect(notes[0]).toBe('A0');
    expect(notes[notes.length - 1]).toBe('C8');
    expect(notes).toContain('C4');
  });
});

describe('default keymap', () => {
  it('maps each key to a unique note', () => {
    const notes = Object.values(DEFAULT_KEYMAP);
    expect(new Set(notes).size).toBe(notes.length);
    for (const note of notes) expect(note).toMatch(/^[A-G]#?\d$/);
  });
});
