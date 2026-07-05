import * as Tone from 'tone';
import metronomeMp3 from '../assets/metronome-85688.mp3';
import { extractClick } from './click-trim';

/** Wraps Tone.js: transport, metronome, master bus. */
class AudioEngine {
  readonly master: Tone.Gain = new Tone.Gain(0.9).toDestination();
  private started = false;
  private metroGain: Tone.Gain | null = null;
  private metroLoop: Tone.Loop | null = null;
  private metroClock: Tone.Clock | null = null;
  private clockBeat = 0;
  private clickBuffer: Tone.ToneAudioBuffer | null = null;
  metronomeOn = false;

  constructor() {
    // The metronome must tick standalone AND stay beat-aligned during
    // playback, so it switches mode whenever the transport starts/stops.
    const transport = Tone.getTransport();
    transport.on('start', () => {
      if (this.metronomeOn) this.startTicker();
    });
    transport.on('stop', () => {
      if (this.metronomeOn) this.startTicker();
    });
  }

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
    if (this.metroClock) this.metroClock.frequency.value = value / 60;
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
    if (on) {
      await this.loadClick();
      if (!this.metronomeOn) return; // toggled off again while loading
      if (!this.metroGain) this.metroGain = new Tone.Gain(0.8).connect(this.master);
      this.startTicker();
    } else {
      this.stopTicker();
      this.metroGain?.dispose();
      this.metroGain = null;
    }
  }

  private playClick(time: number, accent: boolean): void {
    if (!this.clickBuffer || !this.metroGain) return;
    const src = new Tone.ToneBufferSource(this.clickBuffer).connect(this.metroGain);
    src.playbackRate.value = accent ? 1.25 : 1; // accent the downbeat
    src.onended = (): void => {
      src.dispose();
    };
    src.start(time);
  }

  /**
   * Transport running: transport-synced Loop (clicks land on beats).
   * Transport stopped: free-running Clock so the metronome is audible
   * immediately when toggled on.
   */
  private startTicker(): void {
    this.stopTicker();
    if (Tone.getTransport().state === 'started') {
      this.metroLoop = new Tone.Loop((time) => {
        const t = Tone.getTransport();
        const beat = Math.round(t.getTicksAtTime(time) / t.PPQ) % 4;
        this.playClick(time, beat === 0);
      }, '4n').start(0);
    } else {
      this.clockBeat = 0;
      this.metroClock = new Tone.Clock((time) => {
        this.playClick(time, this.clockBeat % 4 === 0);
        this.clockBeat++;
      }, Tone.getTransport().bpm.value / 60);
      this.metroClock.start();
    }
  }

  private stopTicker(): void {
    this.metroLoop?.dispose();
    this.metroLoop = null;
    this.metroClock?.dispose();
    this.metroClock = null;
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
