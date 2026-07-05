import * as Tone from 'tone';
import metronomeMp3 from '../assets/metronome-85688.mp3';
import { extractClick } from './click-trim';

/** Wraps Tone.js: transport, metronome, master bus. */
class AudioEngine {
  readonly master: Tone.Gain = new Tone.Gain(0.9).toDestination();
  private started = false;
  private metroGain: Tone.Gain | null = null;
  private metroLoop: Tone.Loop | null = null;
  private clickBuffer: Tone.ToneAudioBuffer | null = null;
  metronomeOn = false;

  async ensureStarted(): Promise<void> {
    if (!this.started) {
      await Tone.start();
      this.started = true;
    }
  }

  get bpm(): number {
    return Math.round(Tone.getTransport().bpm.value);
  }

  set bpm(value: number) {
    Tone.getTransport().bpm.value = value;
  }

  get playing(): boolean {
    return Tone.getTransport().state === 'started';
  }

  /** Current transport position in beats. */
  get positionBeats(): number {
    const t = Tone.getTransport();
    return t.ticks / t.PPQ;
  }

  play(): void {
    Tone.getTransport().start();
  }

  stop(): void {
    const t = Tone.getTransport();
    t.stop();
    t.position = 0;
  }

  /** Configure transport looping over `bars` (4/4). Pass 0 to disable. */
  setLoop(bars: number): void {
    const t = Tone.getTransport();
    if (bars > 0) {
      t.loop = true;
      t.loopStart = 0;
      t.loopEnd = `${bars}m`;
    } else {
      t.loop = false;
    }
  }

  /** Single metronome click, trimmed from the bundled recording on first use. */
  private async loadClick(): Promise<Tone.ToneAudioBuffer> {
    if (this.clickBuffer) return this.clickBuffer;
    const raw = await (await fetch(metronomeMp3)).arrayBuffer();
    const ctx = Tone.getContext().rawContext as AudioContext;
    const decoded = await ctx.decodeAudioData(raw);
    const click = extractClick(decoded.getChannelData(0), decoded.sampleRate);
    const buffer = ctx.createBuffer(1, click.length, decoded.sampleRate);
    buffer.getChannelData(0).set(click);
    this.clickBuffer = new Tone.ToneAudioBuffer(buffer);
    return this.clickBuffer;
  }

  async setMetronome(on: boolean): Promise<void> {
    this.metronomeOn = on;
    if (on && !this.metroLoop) {
      const click = await this.loadClick();
      if (!this.metronomeOn || this.metroLoop) return; // toggled off/on again while loading
      this.metroGain = new Tone.Gain(0.8).connect(this.master);
      this.metroLoop = new Tone.Loop((time) => {
        const t = Tone.getTransport();
        const beat = Math.round(t.getTicksAtTime(time) / t.PPQ) % 4;
        const src = new Tone.ToneBufferSource(click).connect(this.metroGain!);
        src.playbackRate.value = beat === 0 ? 1.25 : 1; // accent the downbeat
        src.onended = (): void => {
          src.dispose();
        };
        src.start(time);
      }, '4n').start(0);
    } else if (!on && this.metroLoop) {
      this.metroLoop.dispose();
      this.metroGain?.dispose();
      this.metroLoop = null;
      this.metroGain = null;
    }
  }

  /**
   * Play a short slice of the buffer once at zero volume so the audio graph
   * and output path are warm — the first audible play then starts without
   * delay. Safe to call before the context is running: the silent source is
   * queued and fires on the first user gesture.
   */
  warmUp(buffer: AudioBuffer): void {
    const mute = new Tone.Gain(0).toDestination();
    const src = new Tone.ToneBufferSource(new Tone.ToneAudioBuffer(buffer)).connect(mute);
    src.onended = (): void => {
      src.dispose();
      mute.dispose();
    };
    src.start(Tone.now(), 0, Math.min(0.05, buffer.duration));
  }

  secondsPerBeat(): number {
    return 60 / Tone.getTransport().bpm.value;
  }

  secondsPerStep(): number {
    return this.secondsPerBeat() / 4;
  }
}

export const engine = new AudioEngine();
