function writeString(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

export interface PcmData {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

/** Encode float PCM as a 16-bit WAV file. */
export function encodeWav(buffer: PcmData): ArrayBuffer {
  const numCh = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const len = buffer.length;
  const blockAlign = numCh * 2;
  const dataSize = len * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const v = new DataView(ab);

  writeString(v, 0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeString(v, 8, 'WAVE');
  writeString(v, 12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, numCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, 16, true);
  writeString(v, 36, 'data');
  v.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(off, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
      off += 2;
    }
  }
  return ab;
}
