import * as Tone from './tone';
import { engine } from './audio-engine';
import { seededNoise } from './dsp';
import type { TonePatch } from './model';
import { defaultFilter, SAMPLE_FREQ_DEFAULT, SAMPLE_NOTE_DEFAULT, SAMPLE_SECONDS_DEFAULT, sampleHold } from './model';

const NOISE_LOOP_SECONDS = 2;

/**
 * One playable voice of a Tone-tab patch: oscillator layers -> layer gains
 * -> mix -> HPF -> LPF -> amplitude envelope, with optional LFO on pitch
 * or volume. Built against the active Tone context, so it also works
 * inside Tone.Offline.
 */
export class PatchVoice {
  private env: Tone.AmplitudeEnvelope;
  private mix: Tone.Gain;
  private hpFilter: Tone.Filter | null = null;
  private lpFilter: Tone.Filter | null = null;
  private oscs: Tone.Oscillator[] = [];
  /** Per-oscillator base frequency (the layer's pitch at C4). */
  private baseFreqs: number[] = [];
  private noises: Tone.ToneBufferSource[] = [];
  private gains: Tone.Gain[] = [];
  private lfo: Tone.LFO | null = null;
  private releaseSeconds: number;

  constructor(patch: TonePatch, destination: Tone.ToneAudioNode) {
    const filter = patch.filter ?? defaultFilter();
    this.env = new Tone.AmplitudeEnvelope(patch.env).connect(destination);
    // disabled filters are left out of the chain entirely
    let next: Tone.ToneAudioNode = this.env;
    if (filter.lpfOn !== false) {
      this.lpFilter = new Tone.Filter(filter.lpf, 'lowpass').connect(next);
      next = this.lpFilter;
    }
    if (filter.hpfOn !== false) {
      this.hpFilter = new Tone.Filter(filter.hpf, 'highpass').connect(next);
      next = this.hpFilter;
    }
    this.mix = new Tone.Gain(1).connect(next);
    this.releaseSeconds = patch.env.release;
    for (const layer of patch.layers) {
      if (layer.muted) continue;
      const g = new Tone.Gain(layer.gain).connect(this.mix);
      this.gains.push(g);
      if (layer.type === 'noise') {
        // deterministic looped white noise, reproducible from the seed
        const samples = seededNoise(layer.noiseSeed ?? 1, NOISE_LOOP_SECONDS * Tone.getContext().sampleRate);
        const src = new Tone.ToneBufferSource(Tone.ToneAudioBuffer.fromArray(samples)).connect(g);
        src.loop = true;
        this.noises.push(src);
      } else {
        const osc = new Tone.Oscillator({
          type: layer.type,
          detune: layer.detune,
          phase: layer.phase,
        }).connect(g);
        this.oscs.push(osc);
        this.baseFreqs.push(layer.freq ?? patch.sampleFreq ?? SAMPLE_FREQ_DEFAULT);
      }
    }
    const { target, rate, depth } = patch.lfo;
    if (target !== 'off' && depth > 0 && patch.lfo.on !== false) {
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
    // notes transpose the whole patch relative to C4: at C4 every layer
    // plays exactly its configured base frequency
    const ratio = Tone.Frequency(note).toFrequency() / SAMPLE_FREQ_DEFAULT;
    // no explicit time = a live key press: skip the scheduling look-ahead
    const t = time ?? Tone.immediate();
    this.oscs.forEach((osc, i) => {
      // schedule at t: a live trigger starts at immediate(), BEFORE the
      // now()+lookAhead point where a plain .value write would land, so the
      // oscillator would open at its default 440 Hz until the write applied
      osc.frequency.setValueAtTime(this.baseFreqs[i] * ratio, t);
      osc.start(t);
    });
    for (const noise of this.noises) noise.start(t);
    this.lfo?.start(t);
    this.env.triggerAttack(t, velocity);
  }

  triggerRelease(time?: number): void {
    const t = time ?? Tone.immediate();
    this.env.triggerRelease(t);
    const stopAt = t + this.releaseSeconds + 0.05;
    for (const osc of this.oscs) osc.stop(stopAt);
    for (const noise of this.noises) noise.stop(stopAt);
    this.lfo?.stop(stopAt);
  }

  triggerAttackRelease(note: string | number, duration: number, time?: number, velocity = 1): void {
    const t = time ?? Tone.immediate();
    this.triggerAttack(note, t, velocity);
    this.triggerRelease(t + duration);
  }

  dispose(): void {
    for (const n of [...this.oscs, ...this.noises, ...this.gains, this.mix, this.env]) n.dispose();
    this.hpFilter?.dispose();
    this.lpFilter?.dispose();
    this.lfo?.dispose();
  }
}

/**
 * Render a patch to an AudioBuffer at its sample freq. sampleSeconds is the
 * total buffer length; the note is released so its tail completes within it.
 */
export async function renderPatch(patch: TonePatch, note?: string | number): Promise<AudioBuffer> {
  const freq = note ?? patch.sampleNote ?? SAMPLE_NOTE_DEFAULT; // C4 = every layer at its base freq
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
