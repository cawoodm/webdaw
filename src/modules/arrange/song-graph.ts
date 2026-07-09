import * as Tone from '../../core/tone';
import type { ArrangeClip, ArrangeClipRef, ArrangeTrack } from '../../core/model';
import { isTrackAudible, MAX_BARS } from '../../core/model';
import { padBuffer, padSeconds } from '../../core/pad-voice';
import { connectChain } from '../../plugins/chain';
import { resolveInstrument, scheduleSequenceAt, type ResolvedInstrument, type ScheduledSequence } from '../sequence/sequence-playback';
import { store } from '../../core/project-store';

/** A clip's bar-span, derived from its ref (no stored length). */
export function clipBars(ref: ArrangeClipRef, barSeconds: number): number {
  if (ref.type === 'sequence') {
    return store.data.sequences.find((s) => s.id === ref.id)?.bars ?? 1;
  }
  if (ref.type === 'pad') {
    const pad = store.data.pads[ref.index];
    const seconds = pad ? padSeconds(pad) : undefined;
    return seconds ? Math.max(1, Math.ceil(seconds / barSeconds)) : 1;
  }
  const buffer = store.getBuffer(ref.file);
  return buffer ? Math.max(1, Math.ceil(buffer.duration / barSeconds)) : 1;
}

/** A clip's effective span: the resize override when present, else derived from the ref. */
export function clipSpanBars(clip: ArrangeClip, barSeconds: number): number {
  return clip.bars ?? clipBars(clip.ref, barSeconds);
}

/** Total bars the arrangement currently spans, clamped to [minBars, MAX_BARS]. */
export function songBars(tracks: ArrangeTrack[], minBars: number, barSeconds: number): number {
  let end = minBars;
  for (const t of tracks) {
    for (const c of t.clips) end = Math.max(end, c.bar + clipSpanBars(c, barSeconds) + 4);
  }
  return Math.min(MAX_BARS, end);
}

export interface ResolvedSong {
  /** clip.id -> buffer, for 'file'/'pad' refs. */
  buffers: Map<string, AudioBuffer>;
  /** sequence.id -> resolved instrument, for 'sequence' refs (deduped across clips). */
  sequences: Map<string, ResolvedInstrument>;
}

/** Pre-resolve every clip's audio in the LIVE context (buffers + resolveInstrument), before Tone.Offline. */
export async function resolveSong(tracks: ArrangeTrack[]): Promise<ResolvedSong> {
  const buffers = new Map<string, AudioBuffer>();
  const sequences = new Map<string, ResolvedInstrument>();
  for (const track of tracks) {
    for (const clip of track.clips) {
      const ref = clip.ref;
      if (ref.type === 'sequence') {
        if (sequences.has(ref.id)) continue;
        const seq = store.data.sequences.find((s) => s.id === ref.id);
        if (!seq) continue;
        const resolved = await resolveInstrument(seq);
        if (resolved) sequences.set(ref.id, resolved);
      } else if (ref.type === 'pad') {
        const pad = store.data.pads[ref.index];
        const buffer = pad ? padBuffer(pad) : null;
        if (buffer) buffers.set(clip.id, buffer);
      } else {
        const buffer = store.getBuffer(ref.file) ?? (await store.loadBuffer(ref.file));
        if (buffer) buffers.set(clip.id, buffer);
      }
    }
  }
  return { buffers, sequences };
}

export interface NodeProvider {
  trackBus(track: ArrangeTrack, songBus: Tone.ToneAudioNode): Tone.Gain;
  clipBus(clip: ArrangeClip, trackBus: Tone.Gain): Tone.Gain;
}

/** Stateless provider for one-shot renders — matches the pre-existing exportSong() pattern. */
export function createOfflineProvider(): NodeProvider {
  return {
    trackBus(track, songBus): Tone.Gain {
      const g = new Tone.Gain(track.gain);
      connectChain(track.plugins, g, songBus);
      return g;
    },
    clipBus(clip, trackBus): Tone.Gain {
      const g = new Tone.Gain(clip.gain);
      connectChain(clip.plugins, g, trackBus);
      return g;
    },
  };
}

export interface SongScheduleOptions {
  songBus: Tone.ToneAudioNode;
  startSeconds: number;
  barSeconds: number;
  secondsPerStep: number;
  provider: NodeProvider;
}

export interface SongPlaybackHandles {
  dispose(): void;
}

/** Build the audio graph for the whole song and start it. Used by BOTH play() and exportSong(). */
export function scheduleSong(tracks: ArrangeTrack[], resolved: ResolvedSong, opts: SongScheduleOptions): SongPlaybackHandles {
  const sources: Tone.ToneBufferSource[] = [];
  const scheduledSequences: ScheduledSequence[] = [];
  for (const track of tracks.filter((t) => isTrackAudible(t, tracks))) {
    const trackBus = opts.provider.trackBus(track, opts.songBus);
    for (const clip of track.clips) {
      const clipBus = opts.provider.clipBus(clip, trackBus);
      const at = opts.startSeconds + clip.bar * opts.barSeconds;
      if (clip.ref.type === 'sequence') {
        const seq = store.data.sequences.find((s) => s.id === (clip.ref as { id: string }).id);
        const resolvedSeq = seq && resolved.sequences.get(seq.id);
        if (seq && resolvedSeq) scheduledSequences.push(scheduleSequenceAt(seq, clipBus, opts.secondsPerStep, resolvedSeq, at));
      } else {
        const buffer = resolved.buffers.get(clip.id);
        if (!buffer) continue;
        const src = new Tone.ToneBufferSource(new Tone.ToneAudioBuffer(buffer)).connect(clipBus);
        src.start(at + 0.01);
        if (clip.bars !== undefined) src.stop(at + 0.01 + clip.bars * opts.barSeconds);
        sources.push(src);
      }
    }
  }
  return {
    dispose(): void {
      for (const s of sources) {
        try {
          s.stop();
          s.dispose();
        } catch {
          /* already stopped */
        }
      }
      for (const s of scheduledSequences) s.dispose();
    },
  };
}
