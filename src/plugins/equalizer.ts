import * as Tone from '../core/tone';
import { magnitudeSpectrum } from '../core/dsp';
import type { DawPlugin, PluginFactory, PluginMeta, PluginUiContext } from './api';
import { liveToggle, startPluginCanvasLoop } from './spectrum-view';
import {
  BAND_LABELS, bandsFromState, bandsToState, combineDb, defaultEqBands, EQ_FMAX, EQ_FMIN,
  freqToX, gainToY, hitTest, isLegacyEqState, migrateLegacyEqState, neutralBandValues, qToY,
  responseFreq, SpectrumAverager, xToFreq, yToGain, yToQ,
  type EqBand, type EqBandType, type EqHandle,
} from './eq-math';

const W = 360;
const H = 160;
const RESPONSE_LEN = 256;
const SLOPES = [12, 24, 48];
const BAND_COLORS: Record<EqBandType, string> = { 0: '#4da6ff', 1: '#ffd24d', 2: '#6ee7a0', 3: '#ff5c5c' };
const TONE_TYPES: Record<EqBandType, BiquadFilterType> = { 0: 'highpass', 1: 'peaking', 2: 'notch', 3: 'lowpass' };
const GRID = '#3d3d3d';
const LABEL = '#8a8f98';
const FREQ_LINES = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const FREQ_LABELS: Record<number, string> = { 100: '100', 1000: '1k', 10000: '10k' };

/** Visual parametric EQ: dynamic HPF/BPF/BSF/LPF bands, curves + averaged spectrum. */
class EqualizerPlugin implements DawPlugin {
  readonly meta: PluginMeta = { id: 'eq', name: 'EQ' };
  private inGain = new Tone.Gain(1);
  private analyser = new Tone.Analyser('fft', 1024);
  readonly input: Tone.ToneAudioNode = this.inGain;
  readonly output: Tone.ToneAudioNode = this.analyser;
  private bands: EqBand[] = defaultEqBands();
  private filters: Tone.Filter[] = [];
  /** Cached per-band response magnitudes (RESPONSE_LEN samples), recomputed on edits. */
  private curves: Float32Array[] = [];
  private averager = new SpectrumAverager();
  private staticSpectrum: { mags: Float32Array; size: number; sampleRate: number } | null = null;
  /** Checked = show the playing signal; unchecked (default) = the source's static average spectrum. */
  private liveView = false;
  private redrawUi: (() => void) | null = null;
  private stopLoop: (() => void) | null = null;

  constructor() {
    this.rebuild();
  }

  /** Tear down and rebuild the filter chain to match this.bands. */
  private rebuild(): void {
    this.inGain.disconnect();
    for (const f of this.filters) f.dispose();
    this.filters = this.bands.map((b) => new Tone.Filter({ frequency: b.freq, type: TONE_TYPES[b.type], Q: b.q }));
    let prev: Tone.ToneAudioNode = this.inGain;
    for (const f of this.filters) {
      prev.connect(f);
      prev = f;
    }
    prev.connect(this.analyser);
    this.bands.forEach((_, i) => this.applyBand(i));
    this.recomputeCurves();
  }

  /** Push one band's (possibly neutralized) values into its live filter. */
  private applyBand(i: number): void {
    const b = this.bands[i];
    const f = this.filters[i];
    if (!f) return;
    const v = b.on ? b : { ...b, ...neutralBandValues(b.type) };
    f.frequency.value = v.freq;
    f.Q.value = v.q;
    if (b.type === 1) (f as unknown as { gain: Tone.Param<'decibels'> }).gain.value = v.gain;
    if (b.type === 0 || b.type === 3) f.rolloff = -b.slope as Tone.FilterRollOff;
  }

  /** Exact response per band from a scratch filter built from the band MODEL (so off bands still preview). */
  private recomputeCurves(): void {
    this.curves = this.bands.map((b) => {
      const scratch = new Tone.Filter({ frequency: b.freq, type: TONE_TYPES[b.type], Q: b.q });
      try {
        if (b.type === 1) (scratch as unknown as { gain: Tone.Param<'decibels'> }).gain.value = b.gain;
        if (b.type === 0 || b.type === 3) scratch.rolloff = -b.slope as Tone.FilterRollOff;
        return scratch.getFrequencyResponse(RESPONSE_LEN);
      } finally {
        scratch.dispose();
      }
    });
    this.redrawUi?.();
  }

  private edited(target: HTMLElement): void {
    this.recomputeCurves();
    target.dispatchEvent(new CustomEvent('plugin-state-changed', { bubbles: true }));
  }

  getState(): Record<string, number> {
    return bandsToState(this.bands);
  }

  setState(state: Record<string, number>): void {
    this.bands = isLegacyEqState(state) ? migrateLegacyEqState(state) : bandsFromState(state);
    if (this.bands.length === 0) this.bands = defaultEqBands();
    this.rebuild();
  }

  dispose(): void {
    this.stopLoop?.();
    for (const f of this.filters) f.dispose();
    this.inGain.dispose();
    this.analyser.dispose();
  }

  createUI(ctx?: PluginUiContext): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'eq2-wrap';
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.className = 'eq2-canvas';
    wrap.appendChild(canvas);
    const strip = document.createElement('div');
    strip.className = 'eq2-strip';
    wrap.appendChild(strip);

    // pre-FX source spectrum, when the host knows what audio this chain carries
    if (ctx?.renderSource) {
      void ctx.renderSource().then((buffer) => {
        if (!buffer || this.analyser.disposed) return;
        this.staticSpectrum = { ...magnitudeSpectrum(buffer.getChannelData(0)), sampleRate: buffer.sampleRate };
      });
    }

    const cx = canvas.getContext('2d')!;
    let handles: EqHandle[] = [];

    const dbY = (db: number): number => ((0 - db) / 100) * H; // FFT −100..0 scale
    const drawSpectrumBg = (): void => {
      cx.strokeStyle = 'rgb(79 209 197 / 45%)';
      cx.lineWidth = 1;
      cx.beginPath();
      if (!this.liveView && this.staticSpectrum) {
        const { mags, size, sampleRate } = this.staticSpectrum;
        let started = false;
        for (let k = 1; k < mags.length; k++) {
          const f = (k * sampleRate) / size;
          if (f < EQ_FMIN || f > EQ_FMAX) continue;
          const db = 20 * Math.log10(mags[k] + 1e-12);
          const y = Math.min(H, Math.max(0, dbY(db)));
          if (!started) { cx.moveTo(freqToX(f, W), y); started = true; }
          else cx.lineTo(freqToX(f, W), y);
        }
      } else {
        const avg = this.averager.current();
        if (!avg) return;
        const nyquist = Tone.getContext().sampleRate / 2;
        let started = false;
        for (let i = 1; i < avg.length; i++) {
          const f = (i / avg.length) * nyquist;
          if (f < EQ_FMIN || f > EQ_FMAX) continue;
          const y = Math.min(H, Math.max(0, dbY(avg[i])));
          if (!started) { cx.moveTo(freqToX(f, W), y); started = true; }
          else cx.lineTo(freqToX(f, W), y);
        }
      }
      cx.stroke();
    };

    const drawCurve = (mags: Float32Array, color: string, dim: boolean, width = 1.5): void => {
      cx.strokeStyle = color;
      cx.globalAlpha = dim ? 0.35 : 1;
      cx.lineWidth = width;
      cx.beginPath();
      for (let i = 1; i < mags.length; i++) {
        const x = freqToX(responseFreq(i, mags.length), W);
        const y = gainToY(20 * Math.log10(Math.max(1e-6, mags[i])), H);
        if (i === 1) cx.moveTo(x, Math.min(H, Math.max(0, y)));
        else cx.lineTo(x, Math.min(H, Math.max(0, y)));
      }
      cx.stroke();
      cx.globalAlpha = 1;
    };

    const draw = (): void => {
      cx.fillStyle = '#000';
      cx.fillRect(0, 0, W, H);
      // grid: freq lines + 0/±12 dB lines
      cx.strokeStyle = GRID;
      cx.lineWidth = 1;
      cx.beginPath();
      for (const f of FREQ_LINES) {
        const x = Math.round(freqToX(f, W)) + 0.5;
        cx.moveTo(x, 0);
        cx.lineTo(x, H);
      }
      for (const db of [-12, 0, 12]) {
        const y = Math.round(gainToY(db, H)) + 0.5;
        cx.moveTo(0, y);
        cx.lineTo(W, y);
      }
      cx.stroke();
      cx.fillStyle = LABEL;
      cx.font = '10px sans-serif';
      for (const f of FREQ_LINES) {
        const label = FREQ_LABELS[f];
        if (label) cx.fillText(label, freqToX(f, W) + 3, H - 4);
      }
      cx.fillText('+12', 2, gainToY(12, H) - 2);
      cx.fillText('-12', 2, gainToY(-12, H) - 2);
      if (this.liveView || !this.staticSpectrum) this.averager.update(this.analyser.getValue() as Float32Array);
      drawSpectrumBg();
      handles = [];
      this.bands.forEach((b, i) => {
        drawCurve(this.curves[i], BAND_COLORS[b.type], !b.on);
        const hx = freqToX(b.freq, W);
        const hy = b.type === 1 ? gainToY(b.gain, H) : qToY(b.q, H);
        const handle: EqHandle = { band: i, x: hx, y: hy };
        cx.beginPath();
        cx.arc(hx, hy, 5, 0, Math.PI * 2);
        cx.strokeStyle = BAND_COLORS[b.type];
        cx.lineWidth = 1.5;
        if (b.on) {
          cx.fillStyle = BAND_COLORS[b.type];
          cx.fill();
        }
        cx.stroke();
        cx.fillStyle = LABEL;
        cx.fillText(String(i + 1), hx + 7, hy - 6);
        if (b.type === 0 || b.type === 3) {
          const badge = { x: hx - 11, y: hy + 8, w: 22, h: 12 };
          cx.strokeStyle = GRID;
          cx.strokeRect(badge.x + 0.5, badge.y + 0.5, badge.w, badge.h);
          cx.fillText(String(b.slope), badge.x + 4, badge.y + 10);
          handle.badge = badge;
        }
        handles.push(handle);
      });
      const onCurves = this.bands.map((b, i) => (b.on ? this.curves[i] : null)).filter((c): c is Float32Array => c !== null);
      if (onCurves.length > 0) {
        const combined = combineDb(onCurves);
        cx.strokeStyle = '#fff';
        cx.lineWidth = 2;
        cx.beginPath();
        for (let i = 1; i < combined.length; i++) {
          const x = freqToX(responseFreq(i, combined.length), W);
          const y = Math.min(H, Math.max(0, gainToY(combined[i], H)));
          if (i === 1) cx.moveTo(x, y);
          else cx.lineTo(x, y);
        }
        cx.stroke();
      }
    };
    this.stopLoop?.();
    this.stopLoop = startPluginCanvasLoop(canvas, () => !this.analyser.disposed, draw);
    this.redrawUi = (): void => this.renderStrip(strip, wrap);

    // ---- interactions ----
    const canvasPos = (e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
    };
    let dragging = -1;
    canvas.onpointerdown = (e): void => {
      const { x, y } = canvasPos(e);
      const hit = hitTest(handles, x, y);
      if (!hit) return;
      const b = this.bands[hit.band];
      if (hit.part === 'badge') {
        b.slope = SLOPES[(SLOPES.indexOf(b.slope) + 1) % SLOPES.length];
        this.applyBand(hit.band);
        this.edited(wrap);
        return;
      }
      dragging = hit.band;
      canvas.setPointerCapture(e.pointerId);
    };
    canvas.onpointermove = (e): void => {
      if (dragging < 0) return;
      const { x, y } = canvasPos(e);
      const b = this.bands[dragging];
      b.freq = Math.round(xToFreq(x, W));
      if (b.type === 1) b.gain = Math.round(yToGain(y, H) * 2) / 2;
      else b.q = yToQ(y, H);
      this.applyBand(dragging);
      this.edited(wrap);
    };
    canvas.onpointerup = (): void => {
      dragging = -1;
    };
    canvas.onpointercancel = (): void => {
      dragging = -1;
    };
    canvas.ondblclick = (e): void => {
      const { x, y } = canvasPos(e);
      const hit = hitTest(handles, x, y);
      if (!hit) return;
      const b = this.bands[hit.band];
      b.on = !b.on;
      this.applyBand(hit.band);
      this.edited(wrap);
    };
    canvas.onwheel = (e): void => {
      const { x, y } = canvasPos(e);
      const hit = hitTest(handles, x, y, 16);
      if (!hit) return;
      e.preventDefault();
      const b = this.bands[hit.band];
      b.q = Math.min(30, Math.max(0.1, b.q * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      this.applyBand(hit.band);
      this.edited(wrap);
    };

    this.renderStrip(strip, wrap);
    return wrap;
  }

  /** Band chips (color dot, label, freq, on/off, remove) + add-band buttons. */
  private renderStrip(strip: HTMLElement, wrap: HTMLElement): void {
    strip.innerHTML = '';
    this.bands.forEach((b, i) => {
      const chip = document.createElement('span');
      chip.className = 'eq2-chip' + (b.on ? '' : ' off');
      const dot = document.createElement('span');
      dot.className = 'eq2-dot';
      dot.style.background = BAND_COLORS[b.type];
      const label = document.createElement('span');
      label.textContent = `${i + 1} ${BAND_LABELS[b.type]} ${b.freq >= 1000 ? `${(b.freq / 1000).toFixed(1)}k` : Math.round(b.freq)}`;
      const on = document.createElement('input');
      on.type = 'checkbox';
      on.checked = b.on;
      on.title = 'Band on/off';
      on.onchange = (): void => {
        b.on = on.checked;
        this.applyBand(i);
        this.edited(wrap);
      };
      const rm = document.createElement('button');
      rm.textContent = '✕';
      rm.title = 'Remove band';
      rm.onclick = (): void => {
        this.bands.splice(i, 1);
        this.rebuild();
        this.edited(wrap);
      };
      chip.append(dot, label, on, rm);
      strip.appendChild(chip);
    });
    for (const t of [0, 1, 2, 3] as EqBandType[]) {
      const add = document.createElement('button');
      add.className = 'eq2-add';
      add.textContent = `+${BAND_LABELS[t]}`;
      add.title = `Add a ${BAND_LABELS[t]} band`;
      add.onclick = (): void => {
        const fresh: EqBand = { type: t, on: true, freq: t === 0 ? 80 : t === 3 ? 8000 : 1000, q: t === 2 ? 4 : 1, gain: 0, slope: 12 };
        this.bands.push(fresh);
        this.rebuild();
        this.edited(wrap);
      };
      strip.appendChild(add);
    }
    strip.appendChild(liveToggle(() => this.liveView, (v) => (this.liveView = v)));
  }
}

export const EQ_FACTORY: PluginFactory = { meta: { id: 'eq', name: 'EQ' }, create: () => new EqualizerPlugin() };
