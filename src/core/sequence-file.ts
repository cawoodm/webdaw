import type { NoteEvent, SeqInstrument, Sequence } from './model';

/** On-disk shape of a `.seq.json` file: a portable sequence (pattern + instrument ref). */
export interface SeqFileData {
  name: string;
  bars: number;
  instrument?: SeqInstrument;
  notes: NoteEvent[];
}

/** Serialize a Sequence to a pretty-printed `.seq.json` string (excludes id/wavFile). */
export function buildSeqFile(seq: Sequence): string {
  const data: Record<string, unknown> = {
    format: 'webdaw-sequence',
    version: 1,
    name: seq.name,
    bars: seq.bars,
  };
  if (seq.instrument !== undefined) data.instrument = seq.instrument;
  data.notes = seq.notes;
  return JSON.stringify(data, null, 2);
}

/** Validate an arbitrary parsed JSON value as a SeqFileData; null if malformed. */
export function parseSeqFile(json: unknown): SeqFileData | null {
  if (!json || typeof json !== 'object') return null;
  const v = json as Record<string, unknown>;
  if (v.format !== 'webdaw-sequence') return null;
  if (typeof v.name !== 'string') return null;
  if (typeof v.bars !== 'number' || !Number.isFinite(v.bars)) return null;
  if (!Array.isArray(v.notes)) return null;
  const notes: NoteEvent[] = [];
  for (const raw of v.notes) {
    if (!raw || typeof raw !== 'object') continue;
    const n = raw as Record<string, unknown>;
    if (n.step === undefined || n.note === undefined || n.duration === undefined || n.velocity === undefined) continue;
    notes.push({
      step: Number(n.step),
      note: String(n.note),
      duration: Number(n.duration),
      velocity: Number(n.velocity),
    });
  }
  return {
    name: v.name,
    bars: v.bars,
    instrument: v.instrument as SeqInstrument | undefined,
    notes,
  };
}
