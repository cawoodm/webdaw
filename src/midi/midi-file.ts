import { Midi } from '@tonejs/midi';
import type { NoteEvent, Sequence } from '../core/model';
import { STEPS_PER_BAR } from '../core/model';
import { noteNameToMidi } from './note-names';

export interface ImportedSequence {
  name: string;
  notes: NoteEvent[];
  bars: number;
  channel: number;
  percussion: boolean;
  program: number;
}

export interface MidiImportResult {
  sequences: ImportedSequence[];
  bpm: number | null;
}

/** Snap a fractional 16th-step count to the nearest half-step. */
function snap(x: number): number {
  return Math.round(x * 2) / 2;
}

/** Parse a Standard MIDI File into one ImportedSequence per non-empty track. */
export function parseMidiFile(bytes: ArrayBuffer): MidiImportResult {
  const midi = new Midi(bytes);
  const ppq = midi.header.ppq;
  const rawBpm = midi.header.tempos[0]?.bpm;
  const bpm = rawBpm !== undefined ? Math.round(rawBpm * 100) / 100 : null;

  const sequences: ImportedSequence[] = [];
  midi.tracks.forEach((track, i) => {
    if (track.notes.length === 0) return;
    const notes: NoteEvent[] = [];
    let maxEnd = 0;
    for (const note of track.notes) {
      const step = snap((note.ticks / ppq) * 4);
      const duration = Math.max(0.5, snap((note.durationTicks / ppq) * 4));
      notes.push({ step, note: note.name, duration, velocity: note.velocity });
      maxEnd = Math.max(maxEnd, step + duration);
    }
    const bars = Math.min(64, Math.max(1, Math.ceil(maxEnd / STEPS_PER_BAR)));
    sequences.push({
      name: track.name || track.instrument?.name || `Track ${i + 1}`,
      notes,
      bars,
      channel: track.channel,
      percussion: !!track.instrument?.percussion,
      program: track.instrument?.number ?? 0,
    });
  });

  return { sequences, bpm };
}

/** Encode Sequences as a Standard MIDI File (one MIDI track per Sequence). */
export function buildMidiFile(sequences: Sequence[], bpm: number): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(bpm);
  const ppq = midi.header.ppq;
  for (const seq of sequences) {
    const track = midi.addTrack();
    track.name = seq.name;
    for (const n of seq.notes) {
      track.addNote({
        midi: noteNameToMidi(n.note),
        ticks: Math.round((n.step / 4) * ppq),
        durationTicks: Math.max(1, Math.round((n.duration / 4) * ppq)),
        velocity: n.velocity,
      });
    }
  }
  return midi.toArray();
}
