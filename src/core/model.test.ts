import { describe, expect, it } from 'vitest';
import type { ProjectData, Sequence } from './model';
import {
  clampClipBar,
  defaultLfo,
  defaultPatch,
  defaultProject,
  envelopeTailSeconds,
  isTrackAudible,
  MAX_BARS,
  normalizeProject,
  PAD_COUNT,
  pianoNotes,
  removeSequence,
  resolveLfos,
  uid,
} from './model';
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

  it('defaults savedAt to 0 for old project.json files missing the field', () => {
    const stale = JSON.parse(JSON.stringify({ ...defaultProject(), savedAt: undefined }));
    expect(normalizeProject(stale).savedAt).toBe(0);
  });

  it('backfills gain/plugins on arrangement clips predating those fields', () => {
    const stale = JSON.parse(
      JSON.stringify({
        ...defaultProject(),
        arrangement: {
          tracks: [
            {
              id: 't1',
              name: 'Track 1',
              gain: 0.9,
              plugins: [],
              clips: [{ id: 'c1', bar: 0, ref: { type: 'file', file: 'samples/x.wav' } }],
            },
          ],
          masterPlugins: [],
        },
      }),
    );
    const normalized = normalizeProject(stale);
    expect(normalized.arrangement.tracks[0].clips[0].gain).toBe(1);
    expect(normalized.arrangement.tracks[0].clips[0].plugins).toEqual([]);
  });

  it('a track/clip with mute, solo, pad ref, and clip effects survives a JSON round-trip', () => {
    const p = defaultProject();
    p.arrangement.tracks.push({
      id: uid(),
      name: 'Drums',
      gain: 0.9,
      muted: true,
      solo: false,
      plugins: [{ id: uid(), pluginId: 'reverb', state: { decay: 2, wet: 0.3 }, bypassed: false }],
      clips: [
        {
          id: uid(),
          bar: 4,
          ref: { type: 'pad', index: 2 },
          gain: 0.8,
          plugins: [{ id: uid(), pluginId: 'delay', state: { delayTime: 0.25, feedback: 0.4, wet: 0.3 }, bypassed: false }],
        },
      ],
    });
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  it('backfills arrangement.bars for old projects', () => {
    const p = defaultProject();
    delete (p.arrangement as { bars?: number }).bars;
    const data = normalizeProject(JSON.parse(JSON.stringify(p)) as ProjectData);
    expect(data.arrangement.bars).toBe(32);
  });

  it('round-trips a clip with a fractional bar and span override', () => {
    const p = defaultProject();
    p.arrangement.bars = 64;
    p.arrangement.tracks.push({
      id: uid(),
      name: 'T',
      gain: 1,
      plugins: [],
      clips: [{ id: uid(), bar: 2.25, ref: { type: 'file', file: 'samples/a.wav' }, gain: 1, plugins: [], bars: 1.5 }],
    });
    const round = normalizeProject(JSON.parse(JSON.stringify(p)) as ProjectData);
    expect(round.arrangement.bars).toBe(64);
    expect(round.arrangement.tracks[0].clips[0].bar).toBe(2.25);
    expect(round.arrangement.tracks[0].clips[0].bars).toBe(1.5);
  });

  it('a patch with envelope shape/on and LFO phase survives a JSON round-trip', () => {
    const p = defaultProject();
    p.patches[0].env.shape = 'fallingSine';
    p.patches[0].env.on = false;
    p.patches[0].pitchEnv = { amount: 12, time: 0.05, on: false };
    p.patches[0].lfoPitch = { rate: 5, depth: 0.5, phase: -90 };
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  it('a piano-roll sequence survives a JSON round-trip', () => {
    const p = defaultProject();
    const seq: Sequence = {
      id: uid(),
      name: 'Lead',
      bars: 4,
      instrument: { type: 'patch', patchId: p.patches[0].id },
      notes: [{ step: 0, note: 'C4', duration: 4, velocity: 0.8 }],
      wavFile: 'sequences/Lead.wav',
    };
    p.sequences.push(seq);
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  it('a sequence with a library instrument survives a JSON round-trip', () => {
    const p = defaultProject();
    const seq: Sequence = {
      id: uid(),
      name: 'Piano',
      bars: 4,
      instrument: { type: 'instrument', name: 'salamander' },
      notes: [{ step: 0, note: 'C4', duration: 4, velocity: 0.8 }],
    };
    p.sequences.push(seq);
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  it('migrates a legacy multi-track sequence to notes + instrument', () => {
    const legacy = {
      ...defaultProject(),
      sequences: [
        {
          id: 'seq1',
          name: 'Old',
          bars: 2,
          tracks: [
            { id: 't1', name: 'Audio', kind: 'audio', gain: 1, source: { pad: 0 }, steps: [0, 4] },
            {
              id: 't2',
              name: 'MIDI',
              kind: 'midi',
              gain: 1,
              synth: 'fm',
              notes: [{ step: 0, note: 'C4', duration: 4, velocity: 0.8 }],
            },
          ],
        },
      ],
    };
    const stale = JSON.parse(JSON.stringify(legacy));
    const normalized = normalizeProject(stale);
    const seq = normalized.sequences[0];
    expect((seq as unknown as { tracks?: unknown }).tracks).toBeUndefined();
    expect(seq.notes).toEqual([{ step: 0, note: 'C4', duration: 4, velocity: 0.8 }]);
    expect(seq.instrument).toEqual({ type: 'synth', kind: 'fm' });
  });

  it('migrates a legacy sequence with no midi track to empty notes', () => {
    const legacy = {
      ...defaultProject(),
      sequences: [
        {
          id: 'seq1',
          name: 'Old',
          bars: 2,
          tracks: [{ id: 't1', name: 'Audio', kind: 'audio', gain: 1, source: { pad: 0 }, steps: [0, 4] }],
        },
      ],
    };
    const stale = JSON.parse(JSON.stringify(legacy));
    const normalized = normalizeProject(stale);
    expect(normalized.sequences[0].notes).toEqual([]);
    expect(normalized.sequences[0].instrument).toBeUndefined();
  });
});

describe('removeSequence', () => {
  it('drops the sequence and any clips referencing it, keeping other clips', () => {
    const p = defaultProject();
    const seq: Sequence = { id: uid(), name: 'Lead', bars: 4, notes: [] };
    const otherSeq: Sequence = { id: uid(), name: 'Bass', bars: 4, notes: [] };
    p.sequences.push(seq, otherSeq);
    p.arrangement.tracks.push({
      id: uid(),
      name: 'Track 1',
      gain: 1,
      plugins: [],
      clips: [
        { id: uid(), bar: 0, ref: { type: 'sequence', id: seq.id }, gain: 1, plugins: [] },
        { id: uid(), bar: 4, ref: { type: 'sequence', id: otherSeq.id }, gain: 1, plugins: [] },
        { id: uid(), bar: 8, ref: { type: 'pad', index: 0 }, gain: 1, plugins: [] },
        { id: uid(), bar: 12, ref: { type: 'file', file: 'samples/x.wav' }, gain: 1, plugins: [] },
      ],
    });

    removeSequence(p, seq.id);

    expect(p.sequences).toEqual([otherSeq]);
    const clips = p.arrangement.tracks[0].clips;
    expect(clips).toHaveLength(3);
    expect(clips.some((c) => c.ref.type === 'sequence' && c.ref.id === seq.id)).toBe(false);
    expect(clips.some((c) => c.ref.type === 'sequence' && c.ref.id === otherSeq.id)).toBe(true);
    expect(clips.some((c) => c.ref.type === 'pad')).toBe(true);
    expect(clips.some((c) => c.ref.type === 'file')).toBe(true);
  });
});

describe('resolveLfos', () => {
  it('uses the dedicated pitch/volume fields when present', () => {
    const p = defaultPatch();
    p.lfoPitch = { rate: 5, depth: 0.5 };
    p.lfoVolume = { rate: 3, depth: 0.8, on: false };
    expect(resolveLfos(p)).toEqual({ pitch: { rate: 5, depth: 0.5 }, volume: { rate: 3, depth: 0.8, on: false } });
  });

  it('routes a legacy single LFO to the slot its target names', () => {
    const base = { ...defaultPatch(), lfoPitch: undefined, lfoVolume: undefined };
    const pitch = { ...base, lfo: { rate: 6, depth: 0.4, target: 'pitch' as const } };
    expect(resolveLfos(pitch).pitch).toMatchObject({ rate: 6, depth: 0.4 });
    expect(resolveLfos(pitch).volume).toEqual(defaultLfo());
    const volume = { ...base, lfo: { rate: 45, depth: 0.6, target: 'volume' as const, on: false } };
    expect(resolveLfos(volume).volume).toMatchObject({ rate: 45, depth: 0.6, on: false });
    expect(resolveLfos(volume).pitch).toEqual(defaultLfo());
    const off = { ...base, lfo: { rate: 4, depth: 0.9, target: 'off' as const } };
    expect(resolveLfos(off)).toEqual({ pitch: defaultLfo(), volume: defaultLfo() });
  });

  it('falls back to inactive defaults when a patch has no LFO fields at all', () => {
    const p = { ...defaultPatch(), lfo: undefined, lfoPitch: undefined, lfoVolume: undefined };
    expect(resolveLfos(p)).toEqual({ pitch: defaultLfo(), volume: defaultLfo() });
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

describe('isTrackAudible', () => {
  const track = (overrides: Partial<{ muted: boolean; solo: boolean }> = {}) => ({
    id: uid(),
    name: 'T',
    gain: 1,
    plugins: [],
    clips: [],
    ...overrides,
  });

  it('is audible with no mute/solo on any track', () => {
    const a = track();
    expect(isTrackAudible(a, [a])).toBe(true);
  });

  it('a muted track is never audible', () => {
    const a = track({ muted: true });
    expect(isTrackAudible(a, [a])).toBe(false);
  });

  it('when any track is soloed, only soloed tracks are audible', () => {
    const a = track({ solo: true });
    const b = track();
    expect(isTrackAudible(a, [a, b])).toBe(true);
    expect(isTrackAudible(b, [a, b])).toBe(false);
  });

  it('a muted-and-soloed track is still silent', () => {
    const a = track({ solo: true, muted: true });
    const b = track();
    expect(isTrackAudible(a, [a, b])).toBe(false);
    expect(isTrackAudible(b, [a, b])).toBe(true); // no OTHER unmuted solo, so b plays
  });
});

describe('clampClipBar', () => {
  it('leaves an in-range placement unchanged', () => {
    expect(clampClipBar(10, 4)).toBe(10);
  });

  it('clamps so bar + span never exceeds MAX_BARS', () => {
    expect(clampClipBar(799, 4)).toBe(MAX_BARS - 4);
  });

  it('never goes negative', () => {
    expect(clampClipBar(-5, 4)).toBe(0);
  });
});

describe('envelopeTailSeconds', () => {
  it('uses release for the default ADSR shape', () => {
    const env = { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.4 };
    expect(envelopeTailSeconds(env)).toBe(0.4);
  });

  it('uses decay for the falling-sine shape', () => {
    const env = { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.4, shape: 'fallingSine' as const };
    expect(envelopeTailSeconds(env)).toBe(0.2);
  });

  it('is near-instant when the envelope is off, regardless of shape', () => {
    const env = { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.4, shape: 'fallingSine' as const, on: false };
    expect(envelopeTailSeconds(env)).toBe(0.001);
  });
});
