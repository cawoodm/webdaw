import * as Tone from './tone';
import { engine } from './audio-engine';
import { seededNoise } from './dsp';
import type { FilterEnv, PitchEnv, TonePatch } from './model';
import { defaultFilter, envelopeTailSeconds, resolveLfos, SAMPLE_FREQ_DEFAULT, SAMPLE_NOTE_DEFAULT, SAMPLE_SECONDS_DEFAULT, sampleHold } from './model';

const NOISE_LOOP_SECONDS = 2;

/**
 * One playable voice of a Tone-tab patch: oscillator layers -> layer gains
 * -> mix -> HPF -> LPF -> amplitude envelope, with independent pitch and
 * volume LFOs. Built against the active Tone context, so it also works
 * inside Tone.Offline.
 */
export class PatchVoice {
  private env: Tone.AmplitudeEnvelope;
  private mix: Tone.Gain;
  private hpFilter: Tone.Filter | null = null;
  private bpFilter: Tone.Filter | null = null;
  private lpFilter: Tone.Filter | null = null;
  private oscs: Tone.Oscillator[] = [];
  /** Per-oscillator base frequency (the layer's pitch at C4). */
  private baseFreqs: number[] = [];
  private noises: Tone.ToneBufferSource[] = [];
  private gains: Tone.Gain[] = [];
  private lfoPitch: Tone.LFO | null = null;
  private lfoVolume: Tone.LFO | null = null;
  private distortion: Tone.Distortion | null = null;
  private releaseSeconds: number;
  private oneShot: boolean;
  private attackSeconds: number;
  private pitchEnv?: PitchEnv;
  private filterEnv?: FilterEnv;
  private lpfBase: number;

  constructor(patch: TonePatch, destination: Tone.ToneAudioNode) {
    const filter = patch.filter ?? defaultFilter();
    const shape = patch.env.shape ?? 'adsr';
    const envOn = patch.env.on !== false;
    this.oneShot = envOn && shape === 'fallingSine';
    this.attackSeconds = patch.env.attack;
    if (!envOn) {
      // flat gate: instantly full volume on note-on, instantly silent on note-off
      this.env = new Tone.AmplitudeEnvelope({ attack: 0.001, decay: 0.001, sustain: 1, release: 0.001 }).connect(destination);
    } else if (shape === 'fallingSine') {
      // fast attack, then Tone's built-in 'sine' release curve (a smooth cosine
      // fall from 1 to 0) used as the decay — self-scheduled in triggerAttack
      // so the hit always plays in full regardless of note length
      this.env = new Tone.AmplitudeEnvelope({
        attack: patch.env.attack,
        decay: 0.001,
        sustain: 1,
        release: patch.env.decay,
        releaseCurve: 'sine',
      }).connect(destination);
    } else {
      this.env = new Tone.AmplitudeEnvelope(patch.env).connect(destination);
    }
    // disabled filters are left out of the chain entirely
    const slope = filter.slope ?? -12;
    this.lpfBase = filter.lpf;
    let next: Tone.ToneAudioNode = this.env;
    if (filter.lpfOn !== false) {
      this.lpFilter = new Tone.Filter(filter.lpf, 'lowpass', slope).connect(next);
      next = this.lpFilter;
    }
    if (filter.bpfOn === true) {
      // opt-in bell: boosts or cuts around the center instead of a hard band-pass.
      // no rolloff/slope here — cascaded peaking stages would multiply the dB gain
      this.bpFilter = new Tone.Filter({ frequency: filter.bpf ?? 1000, type: 'peaking', gain: filter.bpfGain ?? 12 }).connect(next);
      next = this.bpFilter;
    }
    if (filter.hpfOn !== false) {
      this.hpFilter = new Tone.Filter(filter.hpf, 'highpass', slope).connect(next);
      next = this.hpFilter;
    }
    if (patch.drive && patch.drive > 0) {
      this.distortion = new Tone.Distortion(patch.drive).connect(next);
      next = this.distortion;
    }
    this.mix = new Tone.Gain(1).connect(next);
    this.releaseSeconds = envelopeTailSeconds(patch.env);
    this.pitchEnv = patch.pitchEnv;
    this.filterEnv = patch.filterEnv;
    // solo: when any unmuted layer is soloed, only soloed layers sound
    const anySolo = patch.layers.some((l) => l.solo && !l.muted);
    for (const layer of patch.layers) {
      if (layer.muted || (anySolo && !layer.solo)) continue;
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
    const { pitch, volume } = resolveLfos(patch);
    if (pitch.on !== false && pitch.depth > 0) {
      // sums with each oscillator's detune param (+/- depth semitones)
      this.lfoPitch = new Tone.LFO(pitch.rate, -pitch.depth * 100, pitch.depth * 100);
      for (const osc of this.oscs) this.lfoPitch.connect(osc.detune);
    }
    if (volume.on !== false && volume.depth > 0) {
      this.mix.gain.value = 0;
      this.lfoVolume = new Tone.LFO(volume.rate, 1 - volume.depth, 1);
      this.lfoVolume.connect(this.mix.gain);
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
      const target = this.baseFreqs[i] * ratio;
      if (this.pitchEnv && this.pitchEnv.amount > 0 && this.pitchEnv.on !== false) {
        // start above the transposed base freq and glide down to it
        osc.frequency.setValueAtTime(target * Math.pow(2, this.pitchEnv.amount / 12), t);
        osc.frequency.exponentialRampToValueAtTime(target, t + this.pitchEnv.time);
      } else {
        osc.frequency.setValueAtTime(target, t);
      }
      osc.start(t);
    });
    for (const noise of this.noises) noise.start(t);
    if (this.lpFilter && this.filterEnv && this.filterEnv.amount > 1) {
      const start = Math.min(this.lpfBase * this.filterEnv.amount, 20000);
      this.lpFilter.frequency.setValueAtTime(start, t);
      this.lpFilter.frequency.exponentialRampToValueAtTime(this.lpfBase, t + this.filterEnv.time);
    }
    this.lfoPitch?.start(t);
    this.lfoVolume?.start(t);
    this.env.triggerAttack(t, velocity);
    if (this.oneShot) {
      // a percussive hit always plays its full decay, regardless of note length
      const releaseAt = t + this.attackSeconds;
      this.env.triggerRelease(releaseAt);
      const stopAt = releaseAt + this.releaseSeconds + 0.05;
      for (const osc of this.oscs) osc.stop(stopAt);
      for (const noise of this.noises) noise.stop(stopAt);
      this.lfoPitch?.stop(stopAt);
      this.lfoVolume?.stop(stopAt);
    }
  }

  triggerRelease(time?: number): void {
    if (this.oneShot) return; // already self-scheduled in triggerAttack
    const t = time ?? Tone.immediate();
    this.env.triggerRelease(t);
    const stopAt = t + this.releaseSeconds + 0.05;
    for (const osc of this.oscs) osc.stop(stopAt);
    for (const noise of this.noises) noise.stop(stopAt);
    this.lfoPitch?.stop(stopAt);
    this.lfoVolume?.stop(stopAt);
  }

  triggerAttackRelease(note: string | number, duration: number, time?: number, velocity = 1): void {
    const t = time ?? Tone.immediate();
    this.triggerAttack(note, t, velocity);
    this.triggerRelease(t + duration);
  }

  dispose(): void {
    for (const n of [...this.oscs, ...this.noises, ...this.gains, this.mix, this.env]) n.dispose();
    this.hpFilter?.dispose();
    this.bpFilter?.dispose();
    this.lpFilter?.dispose();
    this.lfoPitch?.dispose();
    this.lfoVolume?.dispose();
    this.distortion?.dispose();
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
      voice.triggerAttackRelease(freq, hold, 0);
    }, duration);
    return result.get() as AudioBuffer;
  });
}
