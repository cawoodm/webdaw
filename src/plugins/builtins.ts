import * as Tone from '../core/tone';
import { knob } from '../ui/knob';
import type { DawPlugin, ParamSpec, PluginFactory, PluginMeta } from './api';
import { drawSpectrum } from './spectrum-view';

/** Generic wrapper: a Tone effect + knob per parameter. */
class EffectPlugin implements DawPlugin {
  readonly input: Tone.ToneAudioNode;
  readonly output: Tone.ToneAudioNode;
  private state: Record<string, number> = {};

  constructor(
    readonly meta: PluginMeta,
    private node: Tone.ToneAudioNode,
    private params: ParamSpec[],
    private apply: (node: Tone.ToneAudioNode, key: string, value: number) => void,
  ) {
    this.input = node;
    this.output = node;
    for (const p of params) this.state[p.key] = p.defaultValue;
    this.pushAll();
  }

  private pushAll(): void {
    for (const p of this.params) this.apply(this.node, p.key, this.state[p.key]);
  }

  createUI(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'plugin-params';
    for (const p of this.params) {
      row.appendChild(
        knob({ ...p, value: this.state[p.key] }, (v) => {
          this.state[p.key] = v;
          this.apply(this.node, p.key, v);
          row.dispatchEvent(new CustomEvent('plugin-state-changed', { bubbles: true }));
        }),
      );
    }
    return row;
  }

  getState(): Record<string, number> {
    return { ...this.state };
  }

  setState(state: Record<string, number>): void {
    Object.assign(this.state, state);
    this.pushAll();
  }

  dispose(): void {
    this.node.dispose();
  }
}

function setParam(node: Tone.ToneAudioNode, key: string, value: number): void {
  const target = (node as unknown as Record<string, unknown>)[key];
  if (target instanceof Tone.Param || target instanceof Tone.Signal) {
    target.value = value;
  } else {
    (node as unknown as Record<string, unknown>)[key] = value;
  }
}

const delayFactory: PluginFactory = {
  meta: { id: 'delay', name: 'Delay' },
  create: () =>
    new EffectPlugin(
      { id: 'delay', name: 'Delay' },
      new Tone.FeedbackDelay({ delayTime: 0.25, feedback: 0.4, wet: 0.3 }),
      [
        { key: 'delayTime', label: 'Time', min: 0.02, max: 1, step: 0.01, defaultValue: 0.25, unit: 's' },
        { key: 'feedback', label: 'Feedback', min: 0, max: 0.9, step: 0.01, defaultValue: 0.4 },
        { key: 'wet', label: 'Wet', min: 0, max: 1, step: 0.01, defaultValue: 0.3 },
      ],
      setParam,
    ),
};

const reverbFactory: PluginFactory = {
  meta: { id: 'reverb', name: 'Reverb' },
  create: () =>
    new EffectPlugin(
      { id: 'reverb', name: 'Reverb' },
      new Tone.Reverb({ decay: 2, wet: 0.35 }),
      [
        { key: 'decay', label: 'Decay', min: 0.1, max: 10, step: 0.1, defaultValue: 2, unit: 's' },
        { key: 'wet', label: 'Wet', min: 0, max: 1, step: 0.01, defaultValue: 0.35 },
      ],
      setParam,
    ),
};

const chorusFactory: PluginFactory = {
  meta: { id: 'chorus', name: 'Chorus' },
  create: () =>
    new EffectPlugin(
      { id: 'chorus', name: 'Chorus' },
      new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.7, wet: 0.5 }).start(),
      [
        { key: 'frequency', label: 'Rate', min: 0.1, max: 10, step: 0.1, defaultValue: 1.5, log: true, unit: 'Hz' },
        { key: 'depth', label: 'Depth', min: 0, max: 1, step: 0.01, defaultValue: 0.7 },
        { key: 'wet', label: 'Wet', min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      ],
      setParam,
    ),
};

const phaserFactory: PluginFactory = {
  meta: { id: 'phaser', name: 'Phaser' },
  create: () =>
    new EffectPlugin(
      { id: 'phaser', name: 'Phaser' },
      new Tone.Phaser({ frequency: 0.5, octaves: 3, baseFrequency: 350, wet: 0.5 }),
      [
        { key: 'frequency', label: 'Rate', min: 0.05, max: 10, step: 0.05, defaultValue: 0.5, log: true, unit: 'Hz' },
        { key: 'octaves', label: 'Octaves', min: 1, max: 6, step: 1, defaultValue: 3 },
        { key: 'wet', label: 'Wet', min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      ],
      setParam,
    ),
};

const distortionFactory: PluginFactory = {
  meta: { id: 'distortion', name: 'Distortion' },
  create: () =>
    new EffectPlugin(
      { id: 'distortion', name: 'Distortion' },
      new Tone.Distortion({ distortion: 0.4, wet: 0.5 }),
      [
        { key: 'distortion', label: 'Drive', min: 0, max: 1, step: 0.01, defaultValue: 0.4 },
        { key: 'wet', label: 'Wet', min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      ],
      setParam,
    ),
};

/** FFT spectrum viewer — pass-through analyser, works on any bus. */
class SpectrumPlugin implements DawPlugin {
  readonly meta: PluginMeta = { id: 'spectrum', name: 'Spectrum' };
  private analyser = new Tone.Analyser('fft', 1024);
  readonly input = this.analyser;
  readonly output = this.analyser;

  createUI(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'spectrum-wrap';
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 120;
    canvas.className = 'spectrum-canvas';
    wrap.appendChild(canvas);
    drawSpectrum(canvas, this.analyser);
    return wrap;
  }

  getState(): Record<string, number> {
    return {};
  }

  setState(): void {}

  dispose(): void {
    this.analyser.dispose();
  }
}

/** 3-band EQ (high-pass, peak, low-pass) drawn over a live spectrum. */
class EqPlugin implements DawPlugin {
  readonly meta: PluginMeta = { id: 'eq', name: 'EQ' };
  private hp = new Tone.Filter(40, 'highpass');
  private peak = new Tone.Filter({ frequency: 1000, type: 'peaking', Q: 1 });
  private lp = new Tone.Filter(18000, 'lowpass');
  private analyser = new Tone.Analyser('fft', 1024);
  readonly input: Tone.ToneAudioNode = this.hp;
  readonly output: Tone.ToneAudioNode = this.analyser;
  private state: Record<string, number> = { hpFreq: 40, peakFreq: 1000, peakGain: 0, lpFreq: 18000 };

  constructor() {
    this.hp.connect(this.peak);
    this.peak.connect(this.lp);
    this.lp.connect(this.analyser);
  }

  private apply(): void {
    this.hp.frequency.value = this.state.hpFreq;
    this.peak.frequency.value = this.state.peakFreq;
    (this.peak as unknown as { gain: Tone.Param<'decibels'> }).gain.value = this.state.peakGain;
    this.lp.frequency.value = this.state.lpFreq;
  }

  createUI(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'eq-wrap';
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 100;
    canvas.className = 'spectrum-canvas';
    wrap.appendChild(canvas);
    drawSpectrum(canvas, this.analyser);
    const row = document.createElement('div');
    row.className = 'plugin-params';
    const mk = (key: string, label: string, min: number, max: number, unit: string): void => {
      row.appendChild(
        knob({ label, min, max, step: 1, value: this.state[key], log: min > 0, unit }, (v) => {
          this.state[key] = v;
          this.apply();
          row.dispatchEvent(new CustomEvent('plugin-state-changed', { bubbles: true }));
        }),
      );
    };
    mk('hpFreq', 'HighPass', 20, 2000, 'Hz');
    mk('peakFreq', 'Peak', 100, 10000, 'Hz');
    row.appendChild(
      knob({ label: 'Gain', min: -24, max: 24, step: 0.5, value: this.state.peakGain, unit: 'dB' }, (v) => {
        this.state.peakGain = v;
        this.apply();
        row.dispatchEvent(new CustomEvent('plugin-state-changed', { bubbles: true }));
      }),
    );
    mk('lpFreq', 'LowPass', 200, 20000, 'Hz');
    wrap.appendChild(row);
    return wrap;
  }

  getState(): Record<string, number> {
    return { ...this.state };
  }

  setState(state: Record<string, number>): void {
    Object.assign(this.state, state);
    this.apply();
  }

  dispose(): void {
    for (const n of [this.hp, this.peak, this.lp, this.analyser]) n.dispose();
  }
}

export const PLUGIN_REGISTRY: PluginFactory[] = [
  { meta: { id: 'spectrum', name: 'Spectrum' }, create: () => new SpectrumPlugin() },
  { meta: { id: 'eq', name: 'EQ' }, create: () => new EqPlugin() },
  delayFactory,
  reverbFactory,
  chorusFactory,
  phaserFactory,
  distortionFactory,
];

export function createPlugin(pluginId: string): DawPlugin | null {
  return PLUGIN_REGISTRY.find((f) => f.meta.id === pluginId)?.create() ?? null;
}
