import type { TonePatch } from './model';

/** On-disk shape of a `<name>.inst.json` file under an `_instruments` library. */
export interface InstrumentDef {
  format: string;
  version: number;
  name: string;
  type: 'audio' | 'tone';
  envelope?: { attack?: number; release?: number };
  gain?: number;
  notes: Record<string, string>;
}

/** Validate an arbitrary parsed JSON value as an InstrumentDef; null if malformed. */
export function parseInstrumentDef(json: unknown): InstrumentDef | null {
  if (!json || typeof json !== 'object') return null;
  const v = json as Record<string, unknown>;
  if (v.format !== 'webdaw-instrument') return null;
  if (v.type !== 'audio' && v.type !== 'tone') return null;
  if (typeof v.name !== 'string') return null;
  if (typeof v.notes !== 'object' || v.notes === null) return null;
  return {
    format: v.format,
    version: typeof v.version === 'number' ? v.version : 1,
    name: v.name,
    type: v.type,
    envelope: v.envelope as InstrumentDef['envelope'],
    gain: typeof v.gain === 'number' ? v.gain : undefined,
    notes: v.notes as Record<string, string>,
  };
}

/** A ref containing "." is a filename in the instrument's own folder (not a shared-sample id). */
export function isFileRef(ref: string): boolean {
  return ref.includes('.');
}

/** An instrument resolved to playable data: decoded audio buffers or tone patches, per note. */
export interface LoadedInstrument {
  name: string;
  type: 'audio' | 'tone';
  envelope: { attack: number; release: number };
  gain: number;
  audio?: Map<string, AudioBuffer>;
  tones?: Map<string, TonePatch>;
  /** Tone ids referenced by the instrument that could not be resolved. */
  missingTones?: string[];
}

/** Resolved instruments, keyed by name — repeated resolves are cheap. */
export const instrumentCache = new Map<string, LoadedInstrument>();

/** Drop every cached instrument — call on project switch (buffers belong to the old project). */
export function clearInstrumentCache(): void {
  instrumentCache.clear();
}
