export type TabId = 'tone' | 'sample' | 'sequence' | 'arrange' | 'produce';

export type OscType = 'sine' | 'sawtooth' | 'triangle' | 'square' | 'noise';

export interface ToneLayer {
  type: OscType;
  gain: number;    // 0..1
  detune: number;  // cents
  phase: number;   // degrees
  muted?: boolean;
  /** Base frequency in Hz — what the layer plays at C4 (default C4 itself). */
  freq?: number;
  /** White-noise layers persist their PRNG seed so the signal is reproducible. */
  noiseSeed?: number;
}

export interface PatchFilter {
  hpf: number; // high-pass cutoff Hz (20 = off)
  lpf: number; // low-pass cutoff Hz (20000 = off)
  hpfOn?: boolean; // undefined = enabled (older projects)
  lpfOn?: boolean;
}

export interface LfoConfig {
  rate: number;  // Hz
  depth: number; // 0..1; 0 = inactive
  on?: boolean;  // undefined = enabled (older projects)
}

export interface TonePatch {
  id: string;
  name: string;
  layers: ToneLayer[];
  env: { attack: number; decay: number; sustain: number; release: number };
  /** @deprecated single LFO with a target selector; split into lfoPitch/lfoVolume */
  lfo?: { rate: number; depth: number; target: 'off' | 'pitch' | 'volume'; on?: boolean };
  lfoPitch?: LfoConfig;  // vibrato: +/- depth semitones on every oscillator
  lfoVolume?: LfoConfig; // tremolo: mix gain between 1-depth and 1
  filter?: PatchFilter; // optional: older projects predate it
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
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const notes: string[] = [];
  for (let midi = 21; midi <= 108; midi++) {
    notes.push(`${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`);
  }
  return notes;
}

/**
 * Held-note seconds for a patch render: sampleSeconds is the TOTAL length
 * of the sample, so the hold ends early enough for the release tail to
 * complete within it.
 */
export function sampleHold(patch: TonePatch): number {
  const total = patch.sampleSeconds ?? SAMPLE_SECONDS_DEFAULT;
  return Math.max(0.05, total - patch.env.release - 0.1);
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
}

export interface NoteEvent {
  step: number;     // 16th-note index
  note: string;     // e.g. "C4"
  duration: number; // in 16th steps
  velocity: number; // 0..1
}

export type SynthKind = 'synth' | 'fm' | 'am';

export interface SeqTrack {
  id: string;
  name: string;
  kind: 'audio' | 'midi';
  gain: number;
  // audio
  source?: { pad?: number; file?: string };
  steps?: number[];
  // midi
  synth?: SynthKind;
  notes?: NoteEvent[];
}

export interface Sequence {
  id: string;
  name: string;
  bars: number;
  tracks: SeqTrack[];
  wavFile?: string;
}

export interface PluginInstanceState {
  id: string;
  pluginId: string;
  state: Record<string, number>;
  bypassed: boolean;
}

export interface ArrangeClip {
  id: string;
  bar: number;
  ref: { type: 'sequence'; id: string } | { type: 'file'; file: string };
}

export interface ArrangeTrack {
  id: string;
  name: string;
  gain: number;
  plugins: PluginInstanceState[];
  clips: ArrangeClip[];
}

export interface ProjectData {
  version: 1;
  name: string;
  bpm: number;
  patches: TonePatch[];
  pads: (PadConfig | null)[];
  padLoopBars: number;
  padEvents: PadEvent[];
  sequences: Sequence[];
  arrangement: {
    tracks: ArrangeTrack[];
    masterPlugins: PluginInstanceState[];
  };
}

export const PAD_COUNT = 16;
export const STEPS_PER_BAR = 16;

export function uid(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function defaultPatch(): TonePatch {
  return {
    id: uid(),
    name: 'Patch 1',
    layers: [{ type: 'sine', gain: 0.8, detune: 0, phase: 0, freq: SAMPLE_FREQ_DEFAULT }],
    env: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.4 },
    lfoPitch: defaultLfo(),
    lfoVolume: defaultLfo(),
    filter: defaultFilter(),
  };
}

export function defaultProject(): ProjectData {
  return {
    version: 1,
    name: 'Untitled',
    bpm: 120,
    patches: [defaultPatch()],
    pads: new Array(PAD_COUNT).fill(null),
    padLoopBars: 2,
    padEvents: [],
    sequences: [],
    arrangement: { tracks: [], masterPlugins: [] },
  };
}
