import * as Tone from '../../core/tone';
import { engine } from '../../core/audio-engine';
import type { NoteEvent, Sequence, SeqInstrument, SynthKind, TonePatch } from '../../core/model';
import { STEPS_PER_BAR } from '../../core/model';
import { PatchVoice } from '../../core/patch-voice';
import { stepToTransportTime } from '../../core/time';
import { store } from '../../core/project-store';

export function makeSynth(kind: SynthKind | undefined): Tone.PolySynth {
  if (kind === 'fm') return new Tone.PolySynth(Tone.FMSynth);
  if (kind === 'am') return new Tone.PolySynth(Tone.AMSynth);
  return new Tone.PolySynth(Tone.Synth);
}

/** A sequence's instrument, with its patch/buffer looked up from the store. */
export interface ResolvedInstrument {
  instrument: SeqInstrument;
  patch?: TonePatch;
  buffer?: AudioBuffer;
}

/**
 * Resolve a sequence's instrument to a playable patch/buffer. MUST be called
 * before Tone.Offline — the store's data and buffer cache belong to the live
 * context, not the offline one.
 */
export async function resolveInstrument(seq: Sequence): Promise<ResolvedInstrument | null> {
  const instrument = seq.instrument;
  if (!instrument) return null;
  if (instrument.type === 'synth') return { instrument };
  if (instrument.type === 'patch') {
    const patch = store.data.patches.find((p) => p.id === instrument.patchId);
    if (!patch) return null;
    return { instrument, patch };
  }
  const buffer = store.getBuffer(instrument.file) ?? (await store.loadBuffer(instrument.file));
  if (!buffer) return null;
  return { instrument, buffer };
}

/**
 * Trigger one note through the resolved instrument, in the ACTIVE Tone
 * context — works live or inside Tone.Offline. `synth` is a shared PolySynth
 * for the whole playback session (only used when instrument.type === 'synth').
 * `disposeLive` schedules a delayed dispose of per-note nodes (patch voices,
 * wav sources) — skip it for offline rendering, where the context is torn
 * down right after the render completes anyway.
 */
function triggerNote(
  resolved: ResolvedInstrument,
  dest: Tone.ToneAudioNode,
  synth: Tone.PolySynth | null,
  n: NoteEvent,
  time: number,
  stepSeconds: number,
  disposeLive: boolean,
): void {
  const duration = Math.max(0.02, n.duration * stepSeconds);
  switch (resolved.instrument.type) {
    case 'synth': {
      synth!.triggerAttackRelease(n.note, duration, time, n.velocity);
      break;
    }
    case 'patch': {
      const voice = new PatchVoice(resolved.patch!, dest);
      voice.triggerAttackRelease(n.note, duration, time, n.velocity);
      if (disposeLive) {
        const release = resolved.patch!.env.release;
        window.setTimeout(() => voice.dispose(), (duration + release + 0.3) * 1000);
      }
      break;
    }
    case 'wav': {
      const root = resolved.instrument.root ?? 'C4';
      const rate = Tone.Frequency(n.note).toFrequency() / Tone.Frequency(root).toFrequency();
      const gain = new Tone.Gain(n.velocity).connect(dest);
      const src = new Tone.ToneBufferSource(new Tone.ToneAudioBuffer(resolved.buffer!));
      src.playbackRate.value = rate;
      src.connect(gain);
      src.onended = (): void => {
        src.dispose();
        gain.dispose();
      };
      src.start(time);
      break;
    }
  }
}

/**
 * Schedule a whole sequence at absolute times in the ACTIVE Tone context.
 * Call inside Tone.Offline (resolve the instrument beforehand, in the live
 * context, and pass it in — the store is context-agnostic data).
 */
export function scheduleSequenceAt(
  seq: Sequence,
  dest: Tone.ToneAudioNode,
  secondsPerStep: number,
  resolved: ResolvedInstrument,
  startSeconds = 0,
): void {
  const synth = resolved.instrument.type === 'synth' ? makeSynth(resolved.instrument.kind).connect(dest) : null;
  for (const n of seq.notes) {
    const time = startSeconds + n.step * secondsPerStep + 0.01;
    triggerNote(resolved, dest, synth, n, time, secondsPerStep, false);
  }
}

/** Render a sequence to an AudioBuffer at the current BPM. */
export async function renderSequence(seq: Sequence): Promise<AudioBuffer> {
  const sps = engine.secondsPerStep();
  const seconds = seq.bars * STEPS_PER_BAR * sps + 0.5;
  const resolved = await resolveInstrument(seq);
  const rendered = await Tone.Offline(() => {
    if (resolved) scheduleSequenceAt(seq, Tone.getDestination(), sps, resolved);
  }, seconds);
  return rendered.get() as AudioBuffer;
}

export interface LivePlayback {
  dispose(): void;
}

/**
 * Play a sequence on the live transport (looped). Notes are scheduled in
 * musical time — the transport (= metronome) is the clock, so BPM changes
 * keep notes and clicks aligned.
 */
export function playSequenceLive(seq: Sequence, dest: Tone.ToneAudioNode, resolved: ResolvedInstrument): LivePlayback {
  const nodes: Tone.ToneAudioNode[] = [];
  const synth = resolved.instrument.type === 'synth' ? makeSynth(resolved.instrument.kind).connect(dest) : null;
  if (synth) nodes.push(synth);

  const part = new Tone.Part(
    (time, n: NoteEvent) => {
      // step-seconds from the CURRENT bpm so held notes track tempo changes
      const sps = 60 / Tone.getTransport().bpm.value / 4;
      triggerNote(resolved, dest, synth, n, time, sps, true);
    },
    seq.notes.map((n) => [stepToTransportTime(n.step), n] as [string, NoteEvent]),
  );
  part.loop = true;
  part.loopEnd = `${seq.bars}m`;
  part.start(0);

  return {
    dispose(): void {
      part.dispose();
      for (const n of nodes) n.dispose();
    },
  };
}

/** Live audition: a held key/note plays through the sequence's instrument. */
export interface Monitor {
  attack(note: string, velocity: number): void;
  release(note: string): void;
  dispose(): void;
}

export function makeMonitor(resolved: ResolvedInstrument, dest: Tone.ToneAudioNode): Monitor {
  if (resolved.instrument.type === 'synth') {
    const synth = makeSynth(resolved.instrument.kind).connect(dest);
    return {
      attack(note, velocity): void {
        synth.triggerAttack(note, Tone.immediate(), velocity);
      },
      release(note): void {
        synth.triggerRelease(note, Tone.immediate());
      },
      dispose(): void {
        synth.dispose();
      },
    };
  }
  if (resolved.instrument.type === 'patch') {
    const patch = resolved.patch!;
    const voices = new Map<string, PatchVoice>();
    return {
      attack(note, velocity): void {
        voices.get(note)?.dispose();
        const voice = new PatchVoice(patch, dest);
        voices.set(note, voice);
        voice.triggerAttack(note, undefined, velocity);
      },
      release(note): void {
        const voice = voices.get(note);
        if (!voice) return;
        voices.delete(note);
        voice.triggerRelease();
        window.setTimeout(() => voice.dispose(), (patch.env.release + 0.3) * 1000);
      },
      dispose(): void {
        for (const v of voices.values()) v.dispose();
        voices.clear();
      },
    };
  }
  // wav: one-shot pitched buffer source per attack; release is a no-op
  const buffer = resolved.buffer!;
  const root = resolved.instrument.root ?? 'C4';
  return {
    attack(note, velocity): void {
      const rate = Tone.Frequency(note).toFrequency() / Tone.Frequency(root).toFrequency();
      const gain = new Tone.Gain(velocity).connect(dest);
      const src = new Tone.ToneBufferSource(new Tone.ToneAudioBuffer(buffer));
      src.playbackRate.value = rate;
      src.connect(gain);
      src.onended = (): void => {
        src.dispose();
        gain.dispose();
      };
      src.start(Tone.immediate());
    },
    release(): void {
      /* one-shot: nothing to release */
    },
    dispose(): void {
      /* no persistent nodes */
    },
  };
}
