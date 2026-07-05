import * as Tone from 'tone';
import { engine } from '../../core/audio-engine';
import type { SeqTrack, Sequence, SynthKind } from '../../core/model';
import { STEPS_PER_BAR, toneBufferKey } from '../../core/model';
import { store } from '../../core/project-store';

export function makeSynth(kind: SynthKind | undefined): Tone.PolySynth {
  if (kind === 'fm') return new Tone.PolySynth(Tone.FMSynth);
  if (kind === 'am') return new Tone.PolySynth(Tone.AMSynth);
  return new Tone.PolySynth(Tone.Synth);
}

export interface ResolvedAudio {
  buffer: AudioBuffer | null;
  offset: number;
  duration: number | undefined;
  gainMul: number;
}

/** Resolve an audio track's source (pad or file) to a playable buffer + trim. */
export function resolveAudio(track: SeqTrack): ResolvedAudio {
  if (track.source?.pad !== undefined) {
    const pad = store.data.pads[track.source.pad];
    const buffer = pad?.toneId
      ? store.getBuffer(toneBufferKey(pad.toneId))
      : pad?.file
        ? store.getBuffer(pad.file)
        : null;
    return {
      buffer,
      offset: pad?.trimStart ?? 0,
      duration: pad && pad.trimEnd > 0 ? Math.max(0.01, pad.trimEnd - pad.trimStart) : undefined,
      gainMul: pad?.gain ?? 1,
    };
  }
  const buffer = track.source?.file ? store.getBuffer(track.source.file) : null;
  return { buffer, offset: 0, duration: undefined, gainMul: 1 };
}

/**
 * Schedule a whole sequence at absolute times in the ACTIVE Tone context.
 * Call inside Tone.Offline (resolve audio buffers beforehand, in the live
 * context, and pass them in — the store is context-agnostic data).
 */
export function scheduleSequenceAt(
  seq: Sequence,
  dest: Tone.ToneAudioNode,
  secondsPerStep: number,
  resolved: Map<string, ResolvedAudio>,
  startSeconds = 0,
): void {
  for (const track of seq.tracks) {
    const gain = new Tone.Gain(track.gain).connect(dest);
    if (track.kind === 'midi') {
      const synth = makeSynth(track.synth).connect(gain);
      for (const n of track.notes ?? []) {
        synth.triggerAttackRelease(
          n.note,
          n.duration * secondsPerStep,
          startSeconds + n.step * secondsPerStep + 0.01,
          n.velocity,
        );
      }
    } else {
      const audio = resolved.get(track.id);
      if (!audio?.buffer) continue;
      const toneBuffer = new Tone.ToneAudioBuffer(audio.buffer);
      const g = new Tone.Gain(audio.gainMul).connect(gain);
      for (const step of track.steps ?? []) {
        const src = new Tone.ToneBufferSource(toneBuffer).connect(g);
        src.start(startSeconds + step * secondsPerStep + 0.01, audio.offset, audio.duration);
      }
    }
  }
}

export function resolveSequenceAudio(seq: Sequence): Map<string, ResolvedAudio> {
  const map = new Map<string, ResolvedAudio>();
  for (const track of seq.tracks) {
    if (track.kind === 'audio') map.set(track.id, resolveAudio(track));
  }
  return map;
}

/** Render a sequence to an AudioBuffer at the current BPM. */
export async function renderSequence(seq: Sequence): Promise<AudioBuffer> {
  const sps = engine.secondsPerStep();
  const seconds = seq.bars * STEPS_PER_BAR * sps + 0.5;
  const resolved = resolveSequenceAudio(seq);
  const rendered = await Tone.Offline(() => {
    scheduleSequenceAt(seq, Tone.getDestination(), sps, resolved);
  }, seconds);
  return rendered.get() as AudioBuffer;
}

export interface LivePlayback {
  dispose(): void;
}

/** Play a sequence on the live transport (looped). */
export function playSequenceLive(seq: Sequence, dest: Tone.ToneAudioNode): LivePlayback {
  const sps = engine.secondsPerStep();
  const parts: Tone.Part[] = [];
  const nodes: Tone.ToneAudioNode[] = [];
  const loopEnd = seq.bars * STEPS_PER_BAR * sps;

  for (const track of seq.tracks) {
    const gain = new Tone.Gain(track.gain).connect(dest);
    nodes.push(gain);
    let part: Tone.Part;
    if (track.kind === 'midi') {
      const synth = makeSynth(track.synth).connect(gain);
      nodes.push(synth);
      part = new Tone.Part(
        (time, n: { note: string; duration: number; velocity: number }) => {
          synth.triggerAttackRelease(n.note, Math.max(0.02, n.duration * sps - 0.01), time, n.velocity);
        },
        (track.notes ?? []).map((n) => [n.step * sps, n] as [number, typeof n]),
      );
    } else {
      const audio = resolveAudio(track);
      part = new Tone.Part(
        (time) => {
          if (!audio.buffer) return;
          const src = new Tone.ToneBufferSource(new Tone.ToneAudioBuffer(audio.buffer)).connect(gain);
          src.onended = (): void => {
            src.dispose();
          };
          src.start(time, audio.offset, audio.duration);
        },
        (track.steps ?? []).map((s) => [s * sps, s] as [number, number]),
      );
    }
    part.loop = true;
    part.loopEnd = loopEnd;
    part.start(0);
    parts.push(part);
  }

  return {
    dispose(): void {
      for (const p of parts) p.dispose();
      for (const n of nodes) n.dispose();
    },
  };
}
