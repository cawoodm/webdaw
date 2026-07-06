import * as Tone from './tone';
import metronomeMp3 from '../assets/metronome-85688.mp3';
import { extractClick } from './click-trim';
import { bus } from './event-bus';
import type { TabId } from './model';

/**
 * Wraps Tone.js: transport, metronome, master bus.
 *
 * No audio node (and hence no AudioContext) is created until the first
 * user gesture — Chrome logs an autoplay warning for any AudioContext
 * created before one. Boot-time audio work goes through whenReady(),
 * which flushes once the context starts (a window-level one-time gesture
 * listener triggers ensureStarted automatically).
 */
class AudioEngine {
  private _master: Tone.Gain | null = null;
  private _started = false;
  private offlineStub = false;
  private exclusiveChain: Promise<unknown> = Promise.resolve();
  private readyQueue: (() => void)[] = [];
  private bpmValue = 120;
  private metroGain: Tone.Gain | null = null;
  private metroLoop: Tone.Loop | null = null;
  private metroClock: Tone.Clock | null = null;
  private clockBeat = 0;
  private clickBuffer: Tone.ToneAudioBuffer | null = null;
  metronomeOn = false;

  constructor() {
    const onFirstGesture = (): void => {
      void this.ensureStarted();
    };
    window.addEventListener('pointerdown', onFirstGesture, { once: true });
    window.addEventListener('keydown', onFirstGesture, { once: true });
  }

  get master(): Tone.Gain {
    if (!this._master) this._master = new Tone.Gain(0.9).toDestination();
    return this._master;
  }

  get started(): boolean {
    return this._started;
  }

  /** Run now if the context is live, otherwise once the first gesture starts it. */
  whenReady(fn: () => void): void {
    if (this._started) fn();
    else this.readyQueue.push(fn);
  }

  /**
   * Serialize Tone.Offline renders against the first-gesture context swap:
   * Tone.Offline restores whatever global context it started with, so a
   * render still in flight during the swap would clobber the live context.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.exclusiveChain.then(fn, fn);
    this.exclusiveChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Make Tone.Offline renders possible before the first gesture: point the
   * global Tone context at a throwaway OfflineContext — creating one does
   * NOT trigger Chrome's autoplay warning, unlike a live AudioContext.
   * ensureStarted swaps in the real context on the first gesture.
   */
  allowOfflineRender(): void {
    if (this._started || this.offlineStub) return;
    Tone.setContext(new Tone.OfflineContext(1, 0.01, 44100));
    this.offlineStub = true;
  }

  async ensureStarted(): Promise<void> {
    if (this._started) return;
    await this.runExclusive(async () => this.start());
  }

  private async start(): Promise<void> {
    if (this._started) return; // concurrent caller won the race
    // Until the real AudioContext exists, Tone's global context is a
    // DummyContext (or the pre-gesture offline render stub) and Tone.start()
    // would "resume" that no-op. Materialize the real context now, inside
    // the user gesture, then resume it.
    if (this.offlineStub) {
      Tone.setContext(new Tone.Context());
      this.offlineStub = false;
    } else {
      Tone.getContext();
    }
    await Tone.start();
    this._started = true;
    Tone.getTransport().bpm.value = this.bpmValue;
    for (const fn of this.readyQueue.splice(0)) fn();
  }

  get bpm(): number {
    return Math.round(this.bpmValue);
  }

  set bpm(value: number) {
    this.bpmValue = value;
    if (this._started) Tone.getTransport().bpm.value = value;
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

  /**
   * All transport starts/stops go through here so the metronome can switch
   * mode at the right moment: the transport-synced loop must be created
   * BEFORE transport.start() — Tone's 'start' event fires from the clock
   * tick loop after playback has begun, too late for the beat-0 click.
   */
  play(): void {
    if (this.metronomeOn && !this.playing) this.startTicker(true);
    Tone.getTransport().start();
  }

  stop(): void {
    const t = Tone.getTransport();
    t.stop();
    t.position = 0;
    // back to the free-running clock so a standalone metronome keeps ticking
    if (this.metronomeOn) this.startTicker(false);
  }

  /**
   * Take over playback for one module: every other module releases its
   * scheduled parts (via the bus event) without touching the transport,
   * then the transport is stopped and rewound so the claimer starts clean.
   * Call at the top of any play path.
   */
  claimTransport(owner: TabId): void {
    bus.emit('transport:claim', { owner });
    if (this._started) this.stop();
  }

  /**
   * Configure transport looping over `bars` (4/4). Pass 0 to disable.
   * `offsetBars` shifts the loop region (used for a count-in: the transport
   * plays 0..offset once, then loops offset..offset+bars).
   */
  setLoop(bars: number, offsetBars = 0): void {
    const t = Tone.getTransport();
    if (bars > 0) {
      t.loop = true;
      t.loopStart = `${offsetBars}m`;
      t.loopEnd = `${offsetBars + bars}m`;
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

  /**
   * Enable the metronome WITHOUT ticking yet: click buffer loaded, gain
   * ready, metronomeOn set — the transport 'start' hook then begins the
   * synced loop exactly at beat 0. Await this before starting the
   * transport (count-in), otherwise the first accented click is missed.
   */
  async armMetronome(): Promise<void> {
    if (this.metronomeOn) return;
    await this.loadClick();
    if (this.metronomeOn) return;
    this.metronomeOn = true;
    if (!this.metroGain) this.metroGain = new Tone.Gain(0.8).connect(this.master);
    if (this.playing) this.startTicker();
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
   * transportMode true (or transport running): transport-synced Loop so
   * clicks land on beats — pass true explicitly BEFORE transport.start().
   * Otherwise: free-running Clock so a standalone metronome is audible
   * immediately when toggled on.
   */
  private startTicker(transportMode = this.playing): void {
    this.stopTicker();
    if (transportMode) {
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
    this.whenReady(() => {
      const mute = new Tone.Gain(0).toDestination();
      const src = new Tone.ToneBufferSource(new Tone.ToneAudioBuffer(buffer)).connect(mute);
      src.onended = (): void => {
        src.dispose();
        mute.dispose();
      };
      src.start(Tone.now(), 0, Math.min(0.05, buffer.duration));
    });
  }

  secondsPerBeat(): number {
    return 60 / this.bpmValue;
  }

  secondsPerStep(): number {
    return this.secondsPerBeat() / 4;
  }
}

export const engine = new AudioEngine();
