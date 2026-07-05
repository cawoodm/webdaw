import * as Tone from 'tone';

/** Wraps Tone.js: transport, metronome, master bus. */
class AudioEngine {
  readonly master: Tone.Gain = new Tone.Gain(0.9).toDestination();
  private started = false;
  private metroSynth: Tone.Synth | null = null;
  private metroLoop: Tone.Loop | null = null;
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

  setMetronome(on: boolean): void {
    this.metronomeOn = on;
    if (on && !this.metroLoop) {
      this.metroSynth = new Tone.Synth({
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 },
        volume: -8,
      }).connect(this.master);
      this.metroLoop = new Tone.Loop((time) => {
        const t = Tone.getTransport();
        const beat = Math.round(t.getTicksAtTime(time) / t.PPQ) % 4;
        this.metroSynth!.triggerAttackRelease(beat === 0 ? 'C6' : 'C5', '64n', time);
      }, '4n').start(0);
    } else if (!on && this.metroLoop) {
      this.metroLoop.dispose();
      this.metroSynth?.dispose();
      this.metroLoop = null;
      this.metroSynth = null;
    }
  }

  secondsPerBeat(): number {
    return 60 / Tone.getTransport().bpm.value;
  }

  secondsPerStep(): number {
    return this.secondsPerBeat() / 4;
  }
}

export const engine = new AudioEngine();
