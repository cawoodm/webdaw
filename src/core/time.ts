/**
 * Musical-time helpers (Tone-free). Playback is scheduled on the transport
 * in bars:quarters:sixteenths notation instead of seconds, so the transport
 * — which the metronome follows — is the single clock: BPM changes move
 * sample events and metronome clicks together.
 */

/** Beats (quarter notes, 4/4) -> transport time notation "bars:quarters:sixteenths". */
export function beatsToTransportTime(beats: number): string {
  const bars = Math.floor(beats / 4);
  const rest = beats - bars * 4;
  const quarters = Math.floor(rest);
  const sixteenths = (rest - quarters) * 4;
  // toFixed avoids float noise like 1.9999999998 in the notation
  return `${bars}:${quarters}:${Number(sixteenths.toFixed(4))}`;
}

/** 16th-note step index -> transport time notation. */
export function stepToTransportTime(step: number): string {
  return beatsToTransportTime(step / 4);
}
