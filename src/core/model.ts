import { midiToNoteName } from '../midi/note-names';

export type TabId = 'tone' | 'sample' | 'sequence' | 'arrange' | 'produce';

export type OscType = 'sine' | 'sawtooth' | 'triangle' | 'square' | 'noise';

export interface ToneLayer {
  type: OscType;
  gain: number;    // 0..1
  detune: number;  // cents
  phase: number;   // degrees
  muted?: boolean;
  /** Solo: when any unmuted layer is soloed, only soloed layers sound. */
  solo?: boolean;
  /** Base frequency in Hz — what the layer plays at C4 (default C4 itself). */
  freq?: number;
  /** White-noise layers persist their PRNG seed so the signal is reproducible. */
  noiseSeed?: number;
}

export type FilterSlope = -12 | -24 | -48;

export interface PatchFilter {
  hpf: number; // high-pass cutoff Hz (20 = off)
  lpf: number; // low-pass cutoff Hz (20000 = off)
  hpfOn?: boolean; // undefined = enabled (older projects)
  lpfOn?: boolean;
  /** Band-pass center Hz; unlike hpf/lpf it is OFF unless bpfOn is true. */
  bpf?: number;
  bpfOn?: boolean;
  /** Peaking-bell gain in dB (+boost / −cut); legacy patches without it get +12. */
  bpfGain?: number;
  /** Rolloff steepness in dB/octave for all filters (default -12). */
  slope?: FilterSlope;
}

export interface LfoConfig {
  rate: number;  // Hz
  depth: number; // 0..1; 0 = inactive
  on?: boolean;  // undefined = enabled (older projects)
  phase?: number; // degrees, -180..180; undefined = 0 (older projects)
}

export interface PitchEnv {
  /** Semitones the pitch STARTS above base; 0 = off. */
  amount: number;
  /** Seconds to glide down to base. */
  time: number;
  on?: boolean; // undefined = enabled (older projects)
}

export interface FilterEnv {
  /** Cutoff starts at lpf * amount; 1 = off. */
  amount: number;
  /** Seconds to glide down to the resting cutoff. */
  time: number;
}

export type EnvShape = 'adsr' | 'fallingSine';

export interface TonePatch {
  id: string;
  name: string;
  layers: ToneLayer[];
  env: { attack: number; decay: number; sustain: number; release: number; shape?: EnvShape; on?: boolean };
  /** @deprecated single LFO with a target selector; split into lfoPitch/lfoVolume */
  lfo?: { rate: number; depth: number; target: 'off' | 'pitch' | 'volume'; on?: boolean };
  lfoPitch?: LfoConfig;  // vibrato: +/- depth semitones on every oscillator
  lfoVolume?: LfoConfig; // tremolo: mix gain between 1-depth and 1
  /** Pitch envelope: a percussive downward glide on top of the played note. */
  pitchEnv?: PitchEnv;
  /** Filter envelope: the low-pass cutoff glides down toward its resting value. */
  filterEnv?: FilterEnv;
  filter?: PatchFilter; // optional: older projects predate it
  /** Distortion amount, 0..1; 0 = off. */
  drive?: number;
  /** @deprecated superseded by per-layer freq; kept as a fallback for old projects */
  sampleFreq?: number;
  sampleSeconds?: number; // total length of the rendered sample
  /** Note the sample renders/previews at (88-key range; C4 = layer base freqs). */
  sampleNote?: string;
  wavFile?: string;
}

export function defaultFilter(): PatchFilter {
  return { hpf: 20, lpf: 20000 };
}

export function defaultLfo(): LfoConfig {
  return { rate: 4, depth: 0 };
}

export function defaultPitchEnv(): PitchEnv {
  return { amount: 0, time: 0.05 };
}

export function defaultFilterEnv(): FilterEnv {
  return { amount: 1, time: 0.1 };
}

/**
 * The patch's pitch + volume LFOs, resolving the legacy single-LFO shape
 * (its target routed it to one of the two slots) at read time.
 */
export function resolveLfos(patch: TonePatch): { pitch: LfoConfig; volume: LfoConfig } {
  const legacy = patch.lfo;
  const fromLegacy = (target: 'pitch' | 'volume'): LfoConfig | null =>
    legacy && legacy.target === target ? { rate: legacy.rate, depth: legacy.depth, on: legacy.on } : null;
  return {
    pitch: patch.lfoPitch ?? fromLegacy('pitch') ?? defaultLfo(),
    volume: patch.lfoVolume ?? fromLegacy('volume') ?? defaultLfo(),
  };
}

/** Fallbacks for patches predating sampleFreq/sampleSeconds. */
export const SAMPLE_FREQ_DEFAULT = 261.63; // C4
export const SAMPLE_SECONDS_DEFAULT = 1;

export const SAMPLE_NOTE_DEFAULT = 'C4';

/** The 88 piano keys, A0 (bottom) to C8 (top). */
export function pianoNotes(): string[] {
  const notes: string[] = [];
  for (let midi = 21; midi <= 108; midi++) {
    notes.push(midiToNoteName(midi));
  }
  return notes;
}

/**
 * Seconds of "tail" after the note is triggered: the Falling Sine decay time,
 * the ADSR release time, or a near-instant fade when the envelope is off.
 */
export function envelopeTailSeconds(env: TonePatch['env']): number {
  if (env.on === false) return 0.001;
  if (env.shape === 'fallingSine') return env.decay;
  return env.release;
}

/**
 * Held-note seconds for a patch render: sampleSeconds is the TOTAL length
 * of the sample, so the hold ends early enough for the release tail to
 * complete within it.
 */
export function sampleHold(patch: TonePatch): number {
  const total = patch.sampleSeconds ?? SAMPLE_SECONDS_DEFAULT;
  return Math.max(0.05, total - envelopeTailSeconds(patch.env) - 0.1);
}

export interface PadConfig {
  name: string;
  file?: string;
  /** Linked tone patch — the pad always plays the patch's latest render. */
  toneId?: string;
  /** User-picked pad color (CSS hex). */
  color?: string;
  gain: number;
  trimStart: number; // seconds
  trimEnd: number;   // seconds, 0 = to end
}

/** Buffer-cache key for a tone patch's current render. */
export function toneBufferKey(patchId: string): string {
  return `tone:${patchId}`;
}

export interface PadEvent {
  pad: number;
  time: number; // beats from loop start
  /** Playback length in beats (caps the sample); unset = natural length. */
  duration?: number;
}

export interface NoteEvent {
  step: number;     // 16th-note index
  note: string;     // e.g. "C4"
  duration: number; // in 16th steps
  velocity: number; // 0..1
}

export type SynthKind = 'synth' | 'fm' | 'am';

export type SeqInstrument =
  | { type: 'synth'; kind: SynthKind }
  | { type: 'patch'; patchId: string }
  | { type: 'wav'; file: string; root?: string } // root note, default 'C4'
  | { type: 'instrument'; name: string }; // loaded from the _instruments library

export interface Sequence {
  id: string;
  name: string;
  bars: number; // 1..64
  instrument?: SeqInstrument;
  notes: NoteEvent[];
  wavFile?: string;
}

/** @deprecated pre-piano-roll multi-track sequence shape; migrated by normalizeProject. */
interface LegacySeqTrack {
  id: string;
  name: string;
  kind: 'audio' | 'midi';
  gain: number;
  source?: { pad?: number; file?: string };
  steps?: number[];
  synth?: SynthKind;
  notes?: NoteEvent[];
}

export interface PluginInstanceState {
  id: string;
  pluginId: string;
  state: Record<string, number>;
  bypassed: boolean;
}

export type ArrangeClipRef =
  | { type: 'sequence'; id: string }
  | { type: 'file'; file: string }
  | { type: 'pad'; index: number }; // index into ProjectData.pads — pads have no id field

export interface ArrangeClip {
  id: string;
  bar: number;
  ref: ArrangeClipRef;
  gain: number; // clip volume trim, same convention as ArrangeTrack.gain
  plugins: PluginInstanceState[]; // per-clip FX chain, same shape as ArrangeTrack.plugins
}

export interface ArrangeTrack {
  id: string;
  name: string;
  gain: number;
  muted?: boolean; // undefined = not muted (older projects)
  /** Solo: when any unmuted track is soloed, only soloed tracks play. */
  solo?: boolean;
  plugins: PluginInstanceState[];
  clips: ArrangeClip[];
}

/** A named pad-loop ("sample"): the sampler's recorded/edited snippet. */
export interface PadLoop {
  id: string;
  name: string;
  bars: number;
  events: PadEvent[];
}

export interface ProjectData {
  version: 1;
  name: string;
  bpm: number;
  /** Master output volume 0..1 (default 0.9). */
  masterVolume?: number;
  patches: TonePatch[];
  pads: (PadConfig | null)[];
  padLoops: PadLoop[];
  sequences: Sequence[];
  arrangement: {
    tracks: ArrangeTrack[];
    masterPlugins: PluginInstanceState[];
  };
  /** Legacy single-loop fields (pre-padLoops) — folded in by normalizeProject. */
  padLoopBars?: number;
  padEvents?: PadEvent[];
  /** Epoch ms of the last save — newer copy wins when disk and mirror disagree. */
  savedAt: number;
}

export const PAD_COUNT = 16;
export const STEPS_PER_BAR = 16;
export const MAX_BARS = 800;

/**
 * True when `track` should be audible: muted tracks never play; when any
 * unmuted track is soloed, only soloed tracks play.
 */
export function isTrackAudible(track: ArrangeTrack, allTracks: ArrangeTrack[]): boolean {
  if (track.muted) return false;
  const anySolo = allTracks.some((t) => t.solo && !t.muted);
  return !anySolo || !!track.solo;
}

/** Clamp a clip placement so it never starts before 0 or spans past MAX_BARS. */
export function clampClipBar(bar: number, spanBars: number): number {
  return Math.max(0, Math.min(bar, MAX_BARS - spanBars));
}

export function uid(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Copy of `items` sorted by display name (case-insensitive, locale-aware). */
export function sortedByName<T extends { name: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function defaultPatch(): TonePatch {
  return {
    id: uid(),
    name: 'Patch 1',
    layers: [{ type: 'sine', gain: 0.8, detune: 0, phase: 0, freq: SAMPLE_FREQ_DEFAULT }],
    env: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.4 },
    lfoPitch: defaultLfo(),
    lfoVolume: defaultLfo(),
    pitchEnv: defaultPitchEnv(),
    filterEnv: defaultFilterEnv(),
    filter: defaultFilter(),
    drive: 0,
  };
}

export function defaultLoop(): PadLoop {
  return { id: uid(), name: 'Loop 1', bars: 2, events: [] };
}

export function defaultProject(): ProjectData {
  return {
    version: 1,
    name: 'Untitled',
    bpm: 120,
    patches: [defaultPatch()],
    pads: new Array(PAD_COUNT).fill(null),
    padLoops: [defaultLoop()],
    sequences: [],
    arrangement: { tracks: [], masterPlugins: [] },
    savedAt: 0,
  };
}

/** Upgrade loaded data in place: legacy single-loop fields become padLoops[0]. */
export function normalizeProject(data: ProjectData): ProjectData {
  data.savedAt ??= 0;
  for (const track of data.arrangement.tracks) {
    for (const clip of track.clips) {
      clip.gain ??= 1;
      clip.plugins ??= [];
    }
  }
  if (!Array.isArray(data.padLoops) || data.padLoops.length === 0) {
    data.padLoops = [
      {
        id: uid(),
        name: 'Loop 1',
        bars: data.padLoopBars ?? 2,
        events: data.padEvents ?? [],
      },
    ];
  }
  delete data.padLoopBars;
  delete data.padEvents;
  if (!Array.isArray(data.sequences)) data.sequences = [];
  for (const seq of data.sequences) {
    const raw = seq as unknown as { tracks?: LegacySeqTrack[] };
    if (raw.tracks && !seq.notes) {
      const midiTrack = raw.tracks.find((t) => t.kind === 'midi' && t.notes);
      if (midiTrack) {
        seq.notes = midiTrack.notes ?? [];
        seq.instrument = { type: 'synth', kind: midiTrack.synth ?? 'synth' };
      } else {
        seq.notes = [];
      }
    }
    delete raw.tracks;
    seq.notes ??= [];
  }
  return data;
}
