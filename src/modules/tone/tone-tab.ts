import * as Tone from 'tone';
import { engine } from '../../core/audio-engine';
import { bus } from '../../core/event-bus';
import type { PatchFilter, TonePatch } from '../../core/model';
import { defaultFilter, defaultPatch, toneBufferKey, uid } from '../../core/model';
import { store } from '../../core/project-store';
import { uiState, updateUi } from '../../core/ui-state';
import { knob } from '../../ui/knob';
import { PatchVoice, renderPatch } from '../../core/patch-voice';
import {
  drawEnvelopeOverlay,
  drawFft,
  drawFilterOverlay,
  drawScope,
  drawSpectrumStatic,
  drawWaveformStatic,
  HPF_TRACE,
  LPF_TRACE,
} from './scope-view';

const OSC_TYPES = ['sine', 'sawtooth', 'triangle', 'square'] as const;
const LFO_TARGETS = ['off', 'pitch', 'volume'] as const;

export class ToneTab extends HTMLElement {
  private patchId = '';
  private active = false;
  private voices = new Map<string, PatchVoice>();
  // sum of all voices (and their layers) — analysed for the live scope views
  private tap = new Tone.Gain(1);
  private waveAnalyser = new Tone.Analyser('waveform', 1024);
  private fftAnalyser = new Tone.Analyser('fft', 1024);
  private live = false;
  private staticTimer: number | undefined;
  private staticSeq = 0;
  private looping = false;
  private previewTimers: number[] = [];

  connectedCallback(): void {
    this.className = 'tab-panel tone-tab';
    this.tap.connect(engine.master);
    this.tap.connect(this.waveAnalyser);
    this.tap.connect(this.fftAnalyser);
    bus.on('project:loaded', () => this.render());
    bus.on('ui:loaded', () => {
      const s = uiState().tone;
      this.patchId = s.patchId;
      this.live = s.live;
      this.looping = s.loop;
      this.render();
    });
    bus.on('tab:activate', (tab) => {
      this.active = tab === 'tone';
    });
    bus.on('midi:noteon', ({ note, velocity }) => {
      if (this.active) void this.noteOn(note, velocity);
    });
    bus.on('midi:noteoff', ({ note }) => {
      if (this.active) this.noteOff(note);
    });
    this.render();
  }

  private patch(): TonePatch {
    const found = store.data.patches.find((p) => p.id === this.patchId);
    if (found) return found;
    if (store.data.patches.length === 0) store.data.patches.push(defaultPatch());
    this.selectPatch(store.data.patches[0].id);
    return store.data.patches[0];
  }

  private selectPatch(id: string): void {
    this.patchId = id;
    updateUi((s) => (s.tone.patchId = id));
  }

  private async noteOn(note: string, velocity: number): Promise<void> {
    await engine.ensureStarted();
    this.noteOff(note);
    const voice = new PatchVoice(this.patch(), this.tap);
    this.voices.set(note, voice);
    voice.triggerAttack(note, undefined, velocity);
  }

  private noteOff(note: string): void {
    const voice = this.voices.get(note);
    if (!voice) return;
    this.voices.delete(note);
    voice.triggerRelease();
    setTimeout(() => voice.dispose(), (this.patch().env.release + 0.3) * 1000);
  }

  /** Preview C4: 1s hold + release; retriggers while loop is on. */
  private async playPreview(): Promise<void> {
    await engine.ensureStarted();
    this.stopPreview();
    const cycle = (): void => {
      void this.noteOn('C4', 0.9);
      const holdMs = 1000;
      this.previewTimers.push(window.setTimeout(() => this.noteOff('C4'), holdMs));
      if (this.looping) {
        const gapMs = holdMs + this.patch().env.release * 1000 + 150;
        this.previewTimers.push(window.setTimeout(cycle, gapMs));
      }
    };
    cycle();
  }

  private stopPreview(): void {
    for (const t of this.previewTimers) clearTimeout(t);
    this.previewTimers = [];
    this.noteOff('C4');
  }

  private save(): void {
    store.scheduleSave();
    // patch parameters changed — refresh render (static views + linked pads) once edits settle
    clearTimeout(this.staticTimer);
    this.staticTimer = window.setTimeout(() => void this.updateStatic(), 400);
  }

  /**
   * Offline-render the current patch: publish the buffer so linked sampler
   * pads play the latest version, and draw the static time/freq views.
   */
  private async updateStatic(): Promise<void> {
    const patch = this.patch();
    const seq = ++this.staticSeq;
    const buffer = await renderPatch(patch);
    if (seq !== this.staticSeq) return; // superseded by a newer edit
    store.setBuffer(toneBufferKey(patch.id), buffer);
    const timeCanvas = this.querySelector<HTMLCanvasElement>('canvas.scope-static-time');
    const freqCanvas = this.querySelector<HTMLCanvasElement>('canvas.scope-static-freq');
    if (!timeCanvas || !freqCanvas) return;
    const data = buffer.getChannelData(0);
    drawWaveformStatic(timeCanvas, data, buffer.sampleRate);
    drawEnvelopeOverlay(timeCanvas, patch.env, buffer.duration);
    drawSpectrumStatic(freqCanvas, data, buffer.sampleRate);
    drawFilterOverlay(freqCanvas, this.filter(patch));
  }

  /** Patch filter settings, materialized for patches predating the field. */
  private filter(patch: TonePatch): PatchFilter {
    if (!patch.filter) patch.filter = defaultFilter();
    return patch.filter;
  }

  private render(): void {
    const patch = this.patch();
    this.innerHTML = '';

    // --- scope views: static patch render by default, live analysers on demand ---
    const scopesBlock = document.createElement('div');
    scopesBlock.className = 'tone-scopes-block';
    const scopesHead = document.createElement('div');
    scopesHead.className = 'tone-scopes-head';

    const transport = document.createElement('div');
    transport.className = 'tone-transport';
    const iconBtn = (title: string, svg: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = 'icon-btn';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML = svg;
      b.onclick = fn;
      return b;
    };
    const loopBtn = iconBtn(
      'Loop preview',
      `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>
        <polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
      () => {
        this.looping = !this.looping;
        updateUi((s) => (s.tone.loop = this.looping));
        loopBtn.classList.toggle('active', this.looping);
        if (!this.looping) {
          for (const t of this.previewTimers) clearTimeout(t);
          this.previewTimers = [];
        }
      },
    );
    loopBtn.classList.toggle('active', this.looping);
    transport.append(
      iconBtn(
        'Play preview (C4)',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`,
        () => void this.playPreview(),
      ),
      iconBtn(
        'Stop preview',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`,
        () => this.stopPreview(),
      ),
      loopBtn,
    );
    scopesHead.appendChild(transport);

    const liveToggle = document.createElement('label');
    liveToggle.className = 'hint live-toggle';
    const liveCheck = document.createElement('input');
    liveCheck.type = 'checkbox';
    liveCheck.checked = this.live;
    liveCheck.onchange = (): void => {
      this.live = liveCheck.checked;
      updateUi((s) => (s.tone.live = this.live));
      this.render();
    };
    liveToggle.append(liveCheck, document.createTextNode(' Live'));
    scopesHead.appendChild(liveToggle);
    const scopes = document.createElement('div');
    scopes.className = 'tone-scopes';
    const isActive = (): boolean => this.classList.contains('active-tab');
    const scope = (label: string, cls: string, start?: (canvas: HTMLCanvasElement) => void): HTMLDivElement => {
      const wrap = document.createElement('div');
      wrap.className = 'scope-wrap';
      const cap = document.createElement('div');
      cap.className = 'scope-label';
      cap.textContent = label;
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 120;
      canvas.className = `scope-canvas ${cls}`;
      wrap.append(cap, canvas);
      start?.(canvas);
      return wrap;
    };
    if (this.live) {
      scopes.append(
        scope('Time (live)', 'scope-live-time', (c) => drawScope(c, this.waveAnalyser, isActive)),
        scope('Freq (live)', 'scope-live-freq', (c) => drawFft(c, this.fftAnalyser, isActive)),
      );
    } else {
      scopes.append(
        scope('Amplitude / time', 'scope-static-time'),
        scope('Energy / frequency', 'scope-static-freq'),
      );
    }
    scopesBlock.append(scopesHead, scopes);
    this.appendChild(scopesBlock);
    if (!this.live) void this.updateStatic();

    // --- patch selector row ---
    const bar = document.createElement('div');
    bar.className = 'toolbar';
    const select = document.createElement('select');
    for (const p of store.data.patches) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      opt.selected = p.id === patch.id;
      select.appendChild(opt);
    }
    select.onchange = (): void => {
      this.selectPatch(select.value);
      this.render();
    };
    const btn = (label: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = fn;
      return b;
    };
    bar.append(
      select,
      btn('New', () => {
        const p = defaultPatch();
        p.id = uid();
        p.name = `Patch ${store.data.patches.length + 1}`;
        store.update((d) => d.patches.push(p));
        this.selectPatch(p.id);
        this.render();
      }),
      btn('Rename', () => {
        const name = prompt('Patch name', patch.name);
        if (name) {
          store.update(() => (patch.name = name));
          this.render();
        }
      }),
      btn('Delete', () => {
        store.update((d) => {
          d.patches = d.patches.filter((p) => p.id !== patch.id);
        });
        this.selectPatch('');
        this.render();
      }),
    );
    this.appendChild(bar);

    // --- layers ---
    const layers = document.createElement('div');
    layers.className = 'tone-layers';
    patch.layers.forEach((layer, i) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.classList.toggle('muted', !!layer.muted);
      const head = document.createElement('div');
      head.className = 'card-head';
      const typeSel = document.createElement('select');
      for (const t of OSC_TYPES) {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        opt.selected = layer.type === t;
        typeSel.appendChild(opt);
      }
      typeSel.onchange = (): void => {
        layer.type = typeSel.value as typeof OSC_TYPES[number];
        this.save();
      };
      const muteBtn = iconBtn(
        'Mute layer',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M11 5 6 9H2v6h4l5 4V5z"/></svg>`,
        () => {
          layer.muted = !layer.muted;
          muteBtn.classList.toggle('active', !!layer.muted);
          card.classList.toggle('muted', !!layer.muted);
          this.save();
        },
      );
      muteBtn.classList.add('mute-btn');
      muteBtn.classList.toggle('active', !!layer.muted);
      head.append(
        Object.assign(document.createElement('span'), { textContent: `Layer ${i + 1}`, className: 'card-title' }),
        typeSel,
        muteBtn,
        btn('Duplicate', () => {
          store.update(() => patch.layers.splice(i + 1, 0, { ...layer, phase: (layer.phase + 90) % 360 }));
          this.render();
        }),
        btn('✕', () => {
          if (patch.layers.length <= 1) return;
          store.update(() => patch.layers.splice(i, 1));
          this.render();
        }),
      );
      card.appendChild(head);
      const knobs = document.createElement('div');
      knobs.className = 'knob-row';
      knobs.append(
        knob({ label: 'Gain', min: 0, max: 1, step: 0.01, value: layer.gain }, (v) => {
          layer.gain = v;
          this.save();
        }),
        knob({ label: 'Detune', min: -100, max: 100, step: 1, value: layer.detune, unit: 'ct' }, (v) => {
          layer.detune = v;
          this.save();
        }),
        knob({ label: 'Phase', min: 0, max: 360, step: 1, value: layer.phase, unit: '°' }, (v) => {
          layer.phase = v;
          this.save();
        }),
      );
      card.appendChild(knobs);
      layers.appendChild(card);
    });
    this.appendChild(layers);

    // --- envelope + LFO ---
    const row = document.createElement('div');
    row.className = 'tone-mod-row';
    const envCard = document.createElement('div');
    envCard.className = 'card';
    envCard.innerHTML = '<div class="card-head"><span class="card-title">Envelope</span></div>';
    const envKnobs = document.createElement('div');
    envKnobs.className = 'knob-row';
    const envParams = [
      ['attack', 'Attack', 0.001, 2],
      ['decay', 'Decay', 0.01, 2],
      ['sustain', 'Sustain', 0, 1],
      ['release', 'Release', 0.01, 4],
    ] as const;
    for (const [key, label, min, max] of envParams) {
      envKnobs.appendChild(
        knob({ label, min, max, step: 0.01, value: patch.env[key], unit: key === 'sustain' ? '' : 's' }, (v) => {
          patch.env[key] = v;
          this.save();
        }),
      );
    }
    envCard.appendChild(envKnobs);

    const lfoCard = document.createElement('div');
    lfoCard.className = 'card';
    const lfoHead = document.createElement('div');
    lfoHead.className = 'card-head';
    lfoHead.innerHTML = '<span class="card-title">LFO</span>';
    const targetSel = document.createElement('select');
    for (const t of LFO_TARGETS) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      opt.selected = patch.lfo.target === t;
      targetSel.appendChild(opt);
    }
    targetSel.onchange = (): void => {
      patch.lfo.target = targetSel.value as typeof LFO_TARGETS[number];
      this.save();
    };
    lfoHead.appendChild(targetSel);
    lfoCard.appendChild(lfoHead);
    const lfoKnobs = document.createElement('div');
    lfoKnobs.className = 'knob-row';
    lfoKnobs.append(
      knob({ label: 'Rate', min: 0.1, max: 20, step: 0.1, value: patch.lfo.rate, log: true, unit: 'Hz' }, (v) => {
        patch.lfo.rate = v;
        this.save();
      }),
      knob({ label: 'Depth', min: 0, max: 1, step: 0.01, value: patch.lfo.depth }, (v) => {
        patch.lfo.depth = v;
        this.save();
      }),
    );
    lfoCard.appendChild(lfoKnobs);

    const filterCard = document.createElement('div');
    filterCard.className = 'card';
    filterCard.innerHTML = '<div class="card-head"><span class="card-title">Filter</span></div>';
    const filterKnobs = document.createElement('div');
    filterKnobs.className = 'knob-row';
    const filter = this.filter(patch);
    filterKnobs.append(
      knob(
        { label: 'HPF', min: 20, max: 10000, step: 1, value: filter.hpf, log: true, unit: 'Hz', color: HPF_TRACE },
        (v) => {
          filter.hpf = v;
          this.save();
        },
      ),
      knob(
        { label: 'LPF', min: 100, max: 20000, step: 1, value: filter.lpf, log: true, unit: 'Hz', color: LPF_TRACE },
        (v) => {
          filter.lpf = v;
          this.save();
        },
      ),
    );
    filterCard.appendChild(filterKnobs);
    row.append(envCard, lfoCard, filterCard);
    this.appendChild(row);

    // --- actions ---
    const actions = document.createElement('div');
    actions.className = 'toolbar';
    actions.append(
      btn('Export WAV', async () => {
        const buffer = await renderPatch(patch);
        const path = `tones/${patch.name.replace(/[^\w-]+/g, '_')}.wav`;
        await store.saveWav(path, buffer);
        store.update(() => (patch.wavFile = path));
        this.flash(`Saved ${path}`);
      }),
      btn('Send to pad →', async () => {
        const buffer = await renderPatch(patch);
        bus.emit('tone:sendToPad', { patchId: patch.id, name: patch.name, buffer });
        bus.emit('tab:activate', 'sample');
        this.flash('Sent to sample pad');
      }),
    );
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Play with keys A W S E D F T G Y H U J K (or a MIDI keyboard)';
    actions.appendChild(hint);
    this.appendChild(actions);
  }

  private flash(msg: string): void {
    const el = document.createElement('div');
    el.className = 'flash';
    el.textContent = msg;
    this.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }
}

customElements.define('tone-tab', ToneTab);
