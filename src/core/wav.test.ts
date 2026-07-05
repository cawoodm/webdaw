import { describe, expect, it } from 'vitest';
import { encodeWav, type PcmData } from './wav';

function makePcm(channels: Float32Array[], sampleRate = 44100): PcmData {
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length: channels[0].length,
    getChannelData: (c: number) => channels[c],
  };
}

describe('encodeWav', () => {
  it('writes a valid RIFF/WAVE header', () => {
    const pcm = makePcm([new Float32Array([0, 0.5, -0.5, 1])]);
    const buf = encodeWav(pcm);
    const v = new DataView(buf);
    const tag = (off: number): string =>
      String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(tag(36)).toBe('data');
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint16(34, true)).toBe(16); // bit depth
    expect(v.getUint32(40, true)).toBe(4 * 2); // data size
    expect(buf.byteLength).toBe(44 + 8);
  });

  it('encodes samples as clamped 16-bit PCM', () => {
    const pcm = makePcm([new Float32Array([0, 0.5, -1, 2])]);
    const v = new DataView(encodeWav(pcm));
    expect(v.getInt16(44, true)).toBe(0);
    expect(v.getInt16(46, true)).toBe(Math.round(0.5 * 0x7fff));
    expect(v.getInt16(48, true)).toBe(-0x8000);
    expect(v.getInt16(50, true)).toBe(0x7fff); // clamped
  });

  it('interleaves stereo channels', () => {
    const pcm = makePcm([new Float32Array([0.25, 0.25]), new Float32Array([-0.25, -0.25])]);
    const v = new DataView(encodeWav(pcm));
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getInt16(44, true)).toBeGreaterThan(0); // L
    expect(v.getInt16(46, true)).toBeLessThan(0); // R
  });
});
