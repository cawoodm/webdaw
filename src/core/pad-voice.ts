import * as Tone from './tone';
import { engine } from './audio-engine';
import { renderPatch } from './patch-voice';
import { store } from './project-store';
import type { PadConfig } from './model';
import { toneBufferKey } from './model';

/** Resolve a pad's current playable buffer: linked tone patch render, or its own file. */
export function padBuffer(pad: PadConfig): AudioBuffer | null {
  if (pad.toneId) return store.getBuffer(toneBufferKey(pad.toneId));
  return pad.file ? store.getBuffer(pad.file) : null;
}

/** A pad's trimmed sample length in seconds, when its buffer is known. */
export function padSeconds(pad: PadConfig): number | undefined {
  const buffer = padBuffer(pad);
  if (!buffer) return undefined;
  const end = pad.trimEnd > 0 ? Math.min(pad.trimEnd, buffer.duration) : buffer.duration;
  return Math.max(0.01, end - pad.trimStart);
}

/**
 * Play a pad's buffer (trim applied) into `dest`, in the ACTIVE Tone context —
 * works live or inside Tone.Offline. `durationBeats` caps playback length.
 */
export function playPadInto(
  pad: PadConfig,
  dest: Tone.ToneAudioNode,
  time?: number,
  durationBeats?: number,
): Tone.ToneBufferSource | null {
  const buffer = padBuffer(pad);
  if (!buffer) return null;
  const gainNode = new Tone.Gain(pad.gain).connect(dest);
  const src = new Tone.ToneBufferSource(new Tone.ToneAudioBuffer(buffer)).connect(gainNode);
  let duration = pad.trimEnd > 0 ? Math.max(0.01, pad.trimEnd - pad.trimStart) : undefined;
  if (durationBeats !== undefined) {
    const cap = durationBeats * engine.secondsPerBeat();
    duration = duration === undefined ? cap : Math.min(duration, cap);
  }
  // self-dispose only live: in Tone.Offline, onended fires during the scheduling
  // sweep (before rendering) and would disconnect the nodes into silence
  if (!src.context.isOffline) {
    src.onended = (): void => {
      src.dispose();
      gainNode.dispose();
    };
  }
  src.start(time ?? Tone.immediate(), pad.trimStart, duration);
  return src;
}

/** Render buffers for tone-linked pads that don't have one yet (project load). */
export async function ensurePadBuffers(pads: (PadConfig | null)[]): Promise<boolean> {
  let rendered = false;
  for (const pad of pads) {
    if (!pad?.toneId) continue;
    // re-render buffers made pre-gesture against the 44.1 kHz stub context
    const cached = store.getBuffer(toneBufferKey(pad.toneId));
    if (cached && cached.sampleRate === Tone.getContext().sampleRate) continue;
    const patch = store.data.patches.find((p) => p.id === pad.toneId);
    if (!patch) continue;
    store.setBuffer(toneBufferKey(pad.toneId), await renderPatch(patch));
    rendered = true;
  }
  return rendered;
}
