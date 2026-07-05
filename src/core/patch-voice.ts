import * as Tone from './tone';
import { engine } from './audio-engine';
import type { TonePatch } from './model';
import { defaultFilter, SAMPLE_FREQ_DEFAULT, SAMPLE_SECONDS_DEFAULT, sampleHold } from './model';

/**
 * One playable voice of a Tone-tab patch: oscillator layers -> layer gains
 * -> mix -> HPF -> LPF -> amplitude envelope, with optional LFO on pitch
 * or volume. Built against the active Tone context, so it also works
 * inside Tone.Offline.
 */
export class PatchVoice {
  private env: Tone.AmplitudeEnvelope;
  private mix: Tone.Gain;
  private hpFilter: Tone.Filter;
  private lpFilter: Tone.Filter;
  private oscs: Tone.Oscillator[] = [];
  private gains: Tone.Gain[] = [];
  private lfo: Tone.LFO | null = null;
  private releaseSeconds: number;

  constructor(patch: TonePatch, destination: Tone.ToneAudioNode) {
    const filter = patch.filter ?? defaultFilter();
    this.env = new Tone.AmplitudeEnvelope(patch.env).connect(destination);
    this.lpFilter = new Tone.Filter(filter.lpf, 'lowpass').connect(this.env);
    this.hpFilter = new Tone.Filter(filter.hpf, 'highpass').connect(this.lpFilter);
    this.mix = new Tone.Gain(1).connect(this.hpFilter);
    this.releaseSeconds = patch.env.release;
    for (const layer of patch.layers) {
      if (layer.muted) continue;
      const g = new Tone.Gain(layer.gain).connect(this.mix);
      const osc = new Tone.Oscillator({
        type: layer.type,
        detune: layer.detune,
        phase: layer.phase,
      }).connect(g);
      this.oscs.push(osc);
      this.gains.push(g);
    }
    const { target, rate, depth } = patch.lfo;
    if (target !== 'off' && depth > 0) {
      if (target === 'pitch') {
        // sums with each oscillator's detune param (+/- depth semitones)
        this.lfo = new Tone.LFO(rate, -depth * 100, depth * 100);
        for (const osc of this.oscs) this.lfo.connect(osc.detune);
      } else {
        this.mix.gain.value = 0;
        this.lfo = new Tone.LFO(rate, 1 - depth, 1);
        this.lfo.connect(this.mix.gain);
      }
    }
  }

  triggerAttack(note: string | number, time?: number, velocity = 1): void {
    const freq = Tone.Frequency(note).toFrequency();
    const t = time ?? Tone.now();
    for (const osc of this.oscs) {
      osc.frequency.value = freq;
      osc.start(t);
    }
    this.lfo?.start(t);
    this.env.triggerAttack(t, velocity);
  }

  triggerRelease(time?: number): void {
    const t = time ?? Tone.now();
    this.env.triggerRelease(t);
    const stopAt = t + this.releaseSeconds + 0.05;
    for (const osc of this.oscs) osc.stop(stopAt);
    this.lfo?.stop(stopAt);
  }

  triggerAttackRelease(note: string | number, duration: number, time?: number, velocity = 1): void {
    const t = time ?? Tone.now();
    this.triggerAttack(note, t, velocity);
    this.triggerRelease(t + duration);
  }

  dispose(): void {
    for (const n of [...this.oscs, ...this.gains, this.mix, this.hpFilter, this.lpFilter, this.env]) n.dispose();
    this.lfo?.dispose();
  }
}

/**
 * Render a patch to an AudioBuffer at its sample freq. sampleSeconds is the
 * total buffer length; the note is released so its tail completes within it.
 */
export async function renderPatch(patch: TonePatch, note?: string | number): Promise<AudioBuffer> {
  const freq = note ?? patch.sampleFreq ?? SAMPLE_FREQ_DEFAULT;
  const duration = patch.sampleSeconds ?? SAMPLE_SECONDS_DEFAULT;
  const hold = sampleHold(patch);
  return engine.runExclusive(async () => {
    const result = await Tone.Offline(() => {
      const voice = new PatchVoice(patch, Tone.getDestination());
      voice.triggerAttackRelease(freq, hold, 0.01);
    }, duration);
    return result.get() as AudioBuffer;
  });
}
