export type TabId = 'tone' | 'sample' | 'sequence' | 'arrange' | 'produce';

export type OscType = 'sine' | 'sawtooth' | 'triangle' | 'square';

export interface ToneLayer {
  type: OscType;
  gain: number;    // 0..1
  detune: number;  // cents
  phase: number;   // degrees
  muted?: boolean;
}

export interface PatchFilter {
  hpf: number; // high-pass cutoff Hz (20 = off)
  lpf: number; // low-pass cutoff Hz (20000 = off)
}

export interface TonePatch {
  id: string;
  name: string;
  layers: ToneLayer[];
  env: { attack: number; decay: number; sustain: number; release: number };
  lfo: { rate: number; depth: number; target: 'off' | 'pitch' | 'volume' };
  filter?: PatchFilter; // optional: older projects predate it
  sampleFreq?: number;    // Hz — render/preview pitch (default C4)
  sampleSeconds?: number; // held-note length of the rendered sample
  wavFile?: string;
}

export function defaultFilter(): PatchFilter {
  return { hpf: 20, lpf: 20000 };
}

/** Fallbacks for patches predating sampleFreq/sampleSeconds. */
export const SAMPLE_FREQ_DEFAULT = 261.63; // C4
export const SAMPLE_SECONDS_DEFAULT = 1;

export interface PadConfig {
  name: string;
  file?: string;
  /** Linked tone patch — the pad always plays the patch's latest render. */
  toneId?: string;
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
    layers: [{ type: 'sine', gain: 0.8, detune: 0, phase: 0 }],
    env: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.4 },
    lfo: { rate: 4, depth: 0, target: 'off' },
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
