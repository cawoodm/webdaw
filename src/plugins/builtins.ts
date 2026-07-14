import * as Tone from '../core/tone';
import { magnitudeSpectrum } from '../core/dsp';
import { knob } from '../ui/knob';
import type { DawPlugin, ParamSpec, PluginFactory, PluginMeta, PluginUiContext } from './api';
import { drawDbBins, liveToggle, startPluginCanvasLoop } from './spectrum-view';
import { SpectrumAverager } from './eq-math';
import { EQ_FACTORY } from './equalizer';

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
  private stopLoop: (() => void) | null = null;
  /** Checked = live FFT of the playing signal; unchecked (default) = the source's static average. */
  private liveView = false;
  private averager = new SpectrumAverager();
  /** dB per bin of the pre-FX source, Tone-tab style — set once renderSource resolves. */
  private staticDb: Float32Array | null = null;

  createUI(ctx?: PluginUiContext): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'spectrum-wrap';
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 120;
    canvas.className = 'spectrum-canvas';
    wrap.appendChild(canvas);
    if (ctx?.renderSource) {
      void ctx.renderSource().then((buffer) => {
        if (!buffer || this.analyser.disposed) return;
        const { mags } = magnitudeSpectrum(buffer.getChannelData(0));
        this.staticDb = Float32Array.from(mags, (m) => 20 * Math.log10(m + 1e-12));
      });
    }
    this.stopLoop?.();
    this.stopLoop = startPluginCanvasLoop(canvas, () => !this.analyser.disposed, () => {
      if (this.liveView) {
        drawDbBins(canvas, this.analyser.getValue() as Float32Array);
      } else if (this.staticDb) {
        drawDbBins(canvas, this.staticDb);
      } else {
        // no known source (e.g. Master FX): fall back to a running average
        this.averager.update(this.analyser.getValue() as Float32Array);
        drawDbBins(canvas, this.averager.current() ?? []);
      }
    });
    wrap.appendChild(liveToggle(() => this.liveView, (v) => (this.liveView = v)));
    return wrap;
  }

  getState(): Record<string, number> {
    return {};
  }

  setState(): void {}

  dispose(): void {
    this.stopLoop?.();
    this.analyser.dispose();
  }
}

export const PLUGIN_REGISTRY: PluginFactory[] = [
  { meta: { id: 'spectrum', name: 'Spectrum' }, create: () => new SpectrumPlugin() },
  EQ_FACTORY,
  delayFactory,
  reverbFactory,
  chorusFactory,
  phaserFactory,
  distortionFactory,
];

export function createPlugin(pluginId: string): DawPlugin | null {
  return PLUGIN_REGISTRY.find((f) => f.meta.id === pluginId)?.create() ?? null;
}
