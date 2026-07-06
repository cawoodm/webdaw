import * as Tone from '../../core/tone';
import { engine } from '../../core/audio-engine';
import { bus } from '../../core/event-bus';
import type { FilterSlope, LfoConfig, PatchFilter, TonePatch } from '../../core/model';
import {
  defaultFilter,
  defaultPatch,
  resolveLfos,
  pianoNotes,
  SAMPLE_FREQ_DEFAULT,
  SAMPLE_NOTE_DEFAULT,
  SAMPLE_SECONDS_DEFAULT,
  sampleHold,
  toneBufferKey,
  uid,
} from '../../core/model';
import { store } from '../../core/project-store';
import { beatsToTransportTime } from '../../core/time';
import { uiState, updateUi } from '../../core/ui-state';
import { knob } from '../../ui/knob';
import { PatchVoice, renderPatch } from '../../core/patch-voice';
import { encodeWav } from '../../core/wav';
import {
  drawEnvelopeOverlay,
  drawFft,
  drawFilterOverlay,
  drawLfoOverlay,
  drawScope,
  drawSpectrumStatic,
  drawWaveformStatic,
  BPF_TRACE,
  ENV_TRACE,
  HPF_TRACE,
  LFO_PITCH_TRACE,
  LFO_TRACE,
  LPF_TRACE,
} from './scope-view';

/** Trigger a browser download of a generated file. */
function download(filename: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Chromatic keyboard rows for the tone tab, by PHYSICAL key position
 * (KeyboardEvent.code, layout-independent): the home row plays the current
 * sample and walks up in semitones, the row above plays below it, the
 * bottom row continues above the home row's top.
 */
const KEY_SEMITONES: Record<string, number> = {};
['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'] // -10 … -1
  .forEach((c, i) => (KEY_SEMITONES[c] = i - 10));
['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL'] // 0 … +8
  .forEach((c, i) => (KEY_SEMITONES[c] = i));
['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM'] // +9 … +15
  .forEach((c, i) => (KEY_SEMITONES[c] = i + 9));

const OSC_TYPES = ['sine', 'sawtooth', 'triangle', 'square', 'noise'] as const;

/** One waveform cycle per oscillator type, drawn as a 24x24 stroke icon. */
const WAVE_ICONS: Record<typeof OSC_TYPES[number], string> = {
  sine: '<path d="M2 12 Q 7 3 12 12 T 22 12"/>',
  sawtooth: '<path d="M2 18 L 12 6 V 18 L 22 6"/>',
  triangle: '<path d="M2 18 L 7 6 L 17 18 L 22 12"/>',
  square: '<path d="M2 18 V 6 H 12 V 18 H 22 V 6"/>',
  noise: '<path d="M2 12 L 4 7 L 6 15 L 8 5 L 10 17 L 12 9 L 14 14 L 16 6 L 18 16 L 20 10 L 22 12"/>',
};

export class ToneTab extends HTMLElement {
  private patchId = '';
  private active = false;
  private voices = new Map<string, PatchVoice>();
  // sum of all voices (and their layers) — analysed for the live scope views;
  // created lazily so no AudioContext exists before the first user gesture
  private tap: Tone.Gain | null = null;
  private waveAnalyser: Tone.Analyser | null = null;
  private fftAnalyser: Tone.Analyser | null = null;
  private live = false;
  private staticTimer: number | undefined;
  private staticSeq = 0;
  private looping = false;
  private previewTimers: number[] = [];
  private previewLoop: Tone.Loop | null = null;
  private previewStartedTransport = false;
  private lastRender: { data: Float32Array; sampleRate: number } | null = null;

  connectedCallback(): void {
    this.className = 'tab-panel tone-tab';
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
    // loop preview survives tab switches; yield when another module claims
    // the transport (which now belongs to the claimer — don't stop it)
    bus.on('transport:claim', ({ owner }) => {
      if (owner === 'tone') return;
      this.previewStartedTransport = false;
      this.stopPreview();
    });
    bus.on('midi:noteoff', ({ note }) => {
      if (this.active) this.noteOff(note);
    });
    // hotkey "1": play the sample preview (tone tab only)
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (!this.classList.contains('active-tab')) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if (e.code === 'Digit1' || e.code === 'Numpad1') {
        e.preventDefault();
        void this.playPreview();
      }
    });
    // chromatic rows: play the current sample transposed in semitones.
    // Capture phase + preventDefault so the global piano keymap
    // (midi-input's keyboard fallback) skips these keys.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
        if (!this.classList.contains('active-tab')) return;
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        const semis = KEY_SEMITONES[e.code];
        if (semis === undefined) return;
        e.preventDefault();
        void this.noteOn(this.keyFrequency(semis), 0.8, e.code);
      },
      true,
    );
    window.addEventListener(
      'keyup',
      (e) => {
        if (KEY_SEMITONES[e.code] === undefined) return;
        this.noteOff(e.code);
      },
      true,
    );
    // drag a .json patch (Export WAV's settings sidecar) here to import it
    this.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      this.classList.add('drag-over');
    });
    this.addEventListener('dragleave', () => this.classList.remove('drag-over'));
    this.addEventListener('drop', (e) => {
      this.classList.remove('drag-over');
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      void this.importPatchFiles([...e.dataTransfer.files]);
    });
    this.render();
  }

  /** Import dropped .json patch files as new tones. */
  private async importPatchFiles(files: File[]): Promise<void> {
    let lastId = '';
    let imported = 0;
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith('.json')) continue;
      let parsed: Partial<TonePatch>;
      try {
        parsed = JSON.parse(await file.text()) as Partial<TonePatch>;
      } catch {
        this.flash(`${file.name}: not valid JSON`);
        continue;
      }
      if (!Array.isArray(parsed.layers) || parsed.layers.length === 0 || !parsed.env) {
        this.flash(`${file.name}: not a tone patch`);
        continue;
      }
      const base = defaultPatch();
      const patch: TonePatch = { ...base, ...parsed, id: uid() };
      delete patch.wavFile; // file refs never survive an import
      const wanted = parsed.name?.trim() || file.name.replace(/\.json$/i, '');
      const existing = store.data.patches.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
      if (existing) {
        const overwrite = confirm(`A patch named "${wanted}" already exists.\n\nOK = overwrite it, Cancel = keep both`);
        if (overwrite) {
          // keep the existing id so pad links stay intact
          store.update(() => Object.assign(existing, patch, { id: existing.id, name: existing.name }));
          // linked pads always play the latest render
          store.setBuffer(toneBufferKey(existing.id), await renderPatch(existing));
          lastId = existing.id;
          imported++;
          continue;
        }
        const rename = prompt('Name for the imported patch', this.uniquePatchName(wanted));
        if (rename === null) continue; // skip this file
        patch.name = this.uniquePatchName(rename.trim() || wanted);
      } else {
        patch.name = wanted;
      }
      store.update((d) => d.patches.push(patch));
      lastId = patch.id;
      imported++;
    }
    if (imported > 0) {
      this.selectPatch(lastId);
      this.render();
      this.flash(imported === 1 ? `Imported "${this.patch().name}"` : `Imported ${imported} patches`);
    }
  }

  private uniquePatchName(wanted: string): string {
    const names = new Set(store.data.patches.map((p) => p.name.toLowerCase()));
    if (!names.has(wanted.toLowerCase())) return wanted;
    let n = 2;
    while (names.has(`${wanted} ${n}`.toLowerCase())) n++;
    return `${wanted} ${n}`;
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

  private getTap(): Tone.Gain {
    if (!this.tap) {
      this.tap = new Tone.Gain(1).connect(engine.master);
      this.waveAnalyser = new Tone.Analyser('waveform', 1024);
      this.fftAnalyser = new Tone.Analyser('fft', 1024);
      this.tap.connect(this.waveAnalyser);
      this.tap.connect(this.fftAnalyser);
    }
    return this.tap;
  }

  /** Frequency of the current sample's pitch shifted by `semis` semitones. */
  private keyFrequency(semis: number): number {
    const base = Tone.Frequency(this.patch().sampleNote ?? SAMPLE_NOTE_DEFAULT).toFrequency();
    return base * Math.pow(2, semis / 12);
  }

  private async noteOn(note: string | number, velocity: number, key = String(note)): Promise<void> {
    await engine.ensureStarted();
    this.noteOff(key);
    const voice = new PatchVoice(this.patch(), this.getTap());
    this.voices.set(key, voice);
    voice.triggerAttack(note, undefined, velocity);
  }

  private noteOff(key: string): void {
    const voice = this.voices.get(key);
    if (!voice) return;
    this.voices.delete(key);
    voice.triggerRelease();
    setTimeout(() => voice.dispose(), (this.patch().env.release + 0.3) * 1000);
  }

  /**
   * Preview at C4 (each layer at its base freq). With loop on, retriggers
   * ride the transport on a whole-beat interval — the metronome is the
   * clock, so clicks and retriggers stay locked through BPM changes.
   */
  private async playPreview(): Promise<void> {
    await engine.ensureStarted();
    this.stopPreview();
    const patch = this.patch();
    const hold = sampleHold(patch);
    if (this.looping) {
      engine.claimTransport('tone');
      const intervalBeats = Math.max(1, Math.ceil(hold / engine.secondsPerBeat()));
      this.previewLoop = new Tone.Loop((time) => {
        const p = this.patch();
        const holdNow = sampleHold(p);
        const voice = new PatchVoice(p, this.getTap());
        voice.triggerAttackRelease(p.sampleNote ?? SAMPLE_NOTE_DEFAULT, holdNow, time);
        this.previewTimers.push(
          window.setTimeout(() => voice.dispose(), (holdNow + p.env.release + 0.5) * 1000),
        );
      }, beatsToTransportTime(intervalBeats)).start(0);
      this.previewStartedTransport = !engine.playing;
      engine.play();
    } else {
      void this.noteOn(patch.sampleNote ?? SAMPLE_NOTE_DEFAULT, 0.9, 'preview');
      this.previewTimers.push(window.setTimeout(() => this.noteOff('preview'), hold * 1000));
    }
  }

  private stopPreview(): void {
    for (const t of this.previewTimers) clearTimeout(t);
    this.previewTimers = [];
    this.noteOff('preview');
    this.previewLoop?.dispose();
    this.previewLoop = null;
    if (this.previewStartedTransport) {
      engine.stop(); // only stop the transport if the preview started it
      this.previewStartedTransport = false;
    }
  }

  private save(): void {
    store.scheduleSave();
    // overlays track the dial instantly from the cached render; the audio
    // re-render (and its fresh waveform/spectrum) follows once edits settle
    this.redrawStatic();
    clearTimeout(this.staticTimer);
    this.staticTimer = window.setTimeout(() => void this.updateStatic(), 400);
  }

  /**
   * Offline-render the current patch: publish the buffer so linked sampler
   * pads play the latest version, and draw the static time/freq views.
   */
  private async updateStatic(): Promise<void> {
    // pre-gesture renders run against an offline stub context, so the
    // views are populated at startup without an autoplay warning
    if (!engine.started) engine.allowOfflineRender();
    const patch = this.patch();
    const seq = ++this.staticSeq;
    const buffer = await renderPatch(patch);
    if (seq !== this.staticSeq) return; // superseded by a newer edit
    store.setBuffer(toneBufferKey(patch.id), buffer);
    this.lastRender = { data: buffer.getChannelData(0), sampleRate: buffer.sampleRate };
    this.redrawStatic();
  }

  /** Draw the static views from the cached render with current dial values. */
  private redrawStatic(): void {
    if (!this.lastRender) return;
    const timeCanvas = this.querySelector<HTMLCanvasElement>('canvas.scope-static-time');
    const freqCanvas = this.querySelector<HTMLCanvasElement>('canvas.scope-static-freq');
    if (!timeCanvas || !freqCanvas) return;
    const patch = this.patch();
    const { data, sampleRate } = this.lastRender;
    // the time axis follows the CURRENT sample length while dragging:
    // truncate or zero-pad the cached render until the real one arrives
    const seconds = patch.sampleSeconds ?? SAMPLE_SECONDS_DEFAULT;
    const wanted = Math.max(1, Math.round(seconds * sampleRate));
    let view = data;
    if (wanted <= data.length) {
      view = data.subarray(0, wanted);
    } else {
      view = new Float32Array(wanted);
      view.set(data);
    }
    drawWaveformStatic(timeCanvas, view, sampleRate);
    drawEnvelopeOverlay(timeCanvas, patch.env, seconds, sampleHold(patch));
    const lfos = this.lfos(patch);
    drawLfoOverlay(timeCanvas, lfos.pitch, 'pitch', seconds);
    drawLfoOverlay(timeCanvas, lfos.volume, 'volume', seconds);
    drawSpectrumStatic(freqCanvas, data, sampleRate);
    drawFilterOverlay(freqCanvas, this.filter(patch));
  }

  /** Patch filter settings, materialized for patches predating the field. */
  private filter(patch: TonePatch): PatchFilter {
    if (!patch.filter) patch.filter = defaultFilter();
    return patch.filter;
  }

  /** Pitch + volume LFOs, materialized so knobs mutate the persisted objects. */
  private lfos(patch: TonePatch): { pitch: LfoConfig; volume: LfoConfig } {
    const resolved = resolveLfos(patch);
    patch.lfoPitch ??= resolved.pitch;
    patch.lfoVolume ??= resolved.volume;
    return { pitch: patch.lfoPitch, volume: patch.lfoVolume };
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
        if (!this.looping) this.stopPreview();
      },
    );
    loopBtn.classList.toggle('active', this.looping);
    transport.append(
      iconBtn(
        'Play the sample (hotkey: 1)',
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
      // analysers need the audio context — start the draw loops on first gesture
      scopes.append(
        scope('Time (live)', 'scope-live-time', (c) =>
          engine.whenReady(() => {
            this.getTap();
            if (c.isConnected) drawScope(c, this.waveAnalyser!, isActive);
          }),
        ),
        scope('Freq (live)', 'scope-live-freq', (c) =>
          engine.whenReady(() => {
            this.getTap();
            if (c.isConnected) drawFft(c, this.fftAnalyser!, isActive);
          }),
        ),
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
      iconBtn(
        'New patch',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
        () => {
          const p = defaultPatch();
          p.id = uid();
          p.name = this.uniquePatchName(`Patch ${store.data.patches.length + 1}`);
          store.update((d) => d.patches.push(p));
          this.selectPatch(p.id);
          this.render();
        },
      ),
      iconBtn(
        'Duplicate patch',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
        () => {
          const copy = structuredClone(patch);
          copy.id = uid();
          copy.name = this.uniquePatchName(`${patch.name} copy`);
          delete copy.wavFile;
          store.update((d) => d.patches.push(copy));
          this.selectPatch(copy.id);
          this.render();
        },
      ),
      iconBtn(
        'Rename patch',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
          <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>`,
        () => {
          const name = prompt('Patch name', patch.name);
          if (name) {
            store.update((d) => {
              patch.name = name;
              // pads linked to this tone carry a copy of its name
              for (const pad of d.pads) if (pad?.toneId === patch.id) pad.name = name;
            });
            this.render();
          }
        },
      ),
      iconBtn(
        'Delete patch',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
        () => {
          store.update((d) => {
            d.patches = d.patches.filter((p) => p.id !== patch.id);
            // a deleted tone disappears from the sampler pads too
            d.pads = d.pads.map((p) => (p?.toneId === patch.id ? null : p));
          });
          this.selectPatch('');
          this.render();
        },
      ),
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
      const wavePicker = document.createElement('span');
      wavePicker.className = 'wave-picker';
      for (const t of OSC_TYPES) {
        const b = iconBtn(
          t,
          `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            ${WAVE_ICONS[t]}</svg>`,
          () => {
            layer.type = t;
            // the seed IS the persisted random signal — assigned once, kept forever
            if (t === 'noise') layer.noiseSeed ??= Math.floor(Math.random() * 0x7fffffff);
            for (const sib of wavePicker.children) sib.classList.toggle('active', sib === b);
            this.save();
          },
        );
        b.classList.toggle('active', layer.type === t);
        wavePicker.appendChild(b);
      }
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
      const soloBtn = iconBtn(
        'Solo layer — only soloed layers play',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 18v-6a9 9 0 0 1 18 0v6"/>
          <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`,
        () => {
          layer.solo = !layer.solo;
          soloBtn.classList.toggle('active', !!layer.solo);
          this.save();
        },
      );
      soloBtn.classList.add('solo-btn');
      soloBtn.classList.toggle('active', !!layer.solo);
      head.append(
        Object.assign(document.createElement('span'), { textContent: `Layer ${i + 1}`, className: 'card-title' }),
        wavePicker,
        muteBtn,
        soloBtn,
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
        knob(
          {
            label: 'Freq',
            min: 27.5,
            max: 3520,
            step: 0.5,
            value: layer.freq ?? patch.sampleFreq ?? SAMPLE_FREQ_DEFAULT,
            log: true,
            unit: 'Hz',
          },
          (v) => {
            layer.freq = v;
            this.save();
          },
        ),
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

    // --- envelope + LFO (shown ABOVE the layers) ---
    const row = document.createElement('div');
    row.className = 'tone-mod-row';
    const envCard = document.createElement('div');
    envCard.className = 'card';
    const legendDot = (color: string): string => `<span class="legend-dot" style="background:${color}"></span>`;
    envCard.innerHTML = `<div class="card-head">${legendDot(ENV_TRACE)}<span class="card-title">Envelope</span></div>`;
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

    // small enable/disable checkbox for a card section (LFO, HPF, LPF)
    const onToggle = (title: string, isOn: boolean, apply: (on: boolean) => void): HTMLLabelElement => {
      const l = document.createElement('label');
      l.className = 'check-toggle hint';
      l.title = title;
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = isOn;
      c.onchange = (): void => {
        apply(c.checked);
        this.save();
      };
      l.appendChild(c);
      return l;
    };

    const lfoCard = (title: string, trace: string, lfo: LfoConfig): HTMLDivElement => {
      const card = document.createElement('div');
      card.className = 'card';
      const head = document.createElement('div');
      head.className = 'card-head';
      head.innerHTML = `${legendDot(trace)}<span class="card-title">${title}</span>`;
      head.appendChild(onToggle(`Enable/disable the ${title.toLowerCase()}`, lfo.on !== false, (on) => (lfo.on = on)));
      card.appendChild(head);
      const knobs = document.createElement('div');
      knobs.className = 'knob-row';
      knobs.append(
        knob({ label: 'Rate', min: 0.1, max: 20, step: 0.1, value: lfo.rate, log: true, unit: 'Hz' }, (v) => {
          lfo.rate = v;
          this.save();
        }),
        knob({ label: 'Depth', min: 0, max: 1, step: 0.01, value: lfo.depth }, (v) => {
          lfo.depth = v;
          this.save();
        }),
      );
      card.appendChild(knobs);
      return card;
    };
    const lfos = this.lfos(patch);
    const lfoPitchCard = lfoCard('Pitch LFO', LFO_PITCH_TRACE, lfos.pitch);
    const lfoVolCard = lfoCard('Vol LFO', LFO_TRACE, lfos.volume);

    const filterCard = document.createElement('div');
    filterCard.className = 'card';
    filterCard.innerHTML = `<div class="card-head">${legendDot(HPF_TRACE)}${legendDot(BPF_TRACE)}${legendDot(LPF_TRACE)}<span class="card-title">Filter</span></div>`;
    const filterKnobs = document.createElement('div');
    filterKnobs.className = 'knob-row';
    const filter = this.filter(patch);
    const slopeSel = document.createElement('select');
    slopeSel.title = 'Filter steepness (dB per octave) for both filters';
    for (const s of [-12, -24, -48] as const) {
      const opt = document.createElement('option');
      opt.value = String(s);
      opt.textContent = `${-s} dB`;
      opt.selected = (filter.slope ?? -12) === s;
      slopeSel.appendChild(opt);
    }
    slopeSel.onchange = (): void => {
      filter.slope = Number(slopeSel.value) as FilterSlope;
      this.save();
    };
    filterCard.querySelector('.card-head')!.append(
      onToggle('Enable/disable the high-pass filter', filter.hpfOn !== false, (on) => (filter.hpfOn = on)),
      onToggle('Enable/disable the band-pass filter', filter.bpfOn === true, (on) => (filter.bpfOn = on)),
      onToggle('Enable/disable the low-pass filter', filter.lpfOn !== false, (on) => (filter.lpfOn = on)),
      slopeSel,
    );
    filterKnobs.append(
      knob(
        { label: 'HPF', min: 20, max: 10000, step: 1, value: filter.hpf, log: true, unit: 'Hz', color: HPF_TRACE },
        (v) => {
          filter.hpf = v;
          this.save();
        },
      ),
      knob(
        { label: 'BPF', min: 50, max: 15000, step: 1, value: filter.bpf ?? 1000, log: true, unit: 'Hz', color: BPF_TRACE },
        (v) => {
          filter.bpf = v;
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

    const sampleCard = document.createElement('div');
    sampleCard.className = 'card';
    sampleCard.innerHTML = '<div class="card-head"><span class="card-title">Sample</span></div>';
    const noteSel = document.createElement('select');
    noteSel.title = 'Note the sample is rendered and previewed at (C4 = layer frequencies as set)';
    for (const n of pianoNotes()) {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      opt.selected = n === (patch.sampleNote ?? SAMPLE_NOTE_DEFAULT);
      noteSel.appendChild(opt);
    }
    noteSel.onchange = (): void => {
      patch.sampleNote = noteSel.value;
      this.save();
    };
    sampleCard.querySelector('.card-head')!.appendChild(noteSel);
    const sampleKnobs = document.createElement('div');
    sampleKnobs.className = 'knob-row';
    sampleKnobs.append(
      knob(
        { label: 'Length', min: 0.1, max: 4, step: 0.05, value: patch.sampleSeconds ?? SAMPLE_SECONDS_DEFAULT, unit: 's' },
        (v) => {
          patch.sampleSeconds = v;
          this.save();
        },
      ),
    );
    sampleCard.appendChild(sampleKnobs);
    row.append(envCard, lfoPitchCard, lfoVolCard, filterCard, sampleCard);
    this.insertBefore(row, layers);

    // --- actions ---
    const actions = document.createElement('div');
    actions.className = 'toolbar';
    const exportBtn = document.createElement('button');
    exportBtn.title = 'Download this tone as .wav + .json';
    exportBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export`;
    exportBtn.onclick = async (): Promise<void> => {
      const buffer = await renderPatch(patch);
      const base = patch.name.replace(/[^\w-]+/g, '_');
      download(`${base}.wav`, new Blob([encodeWav(buffer)], { type: 'audio/wav' }));
      // settings sidecar (internal id and file refs stripped)
      const { id, wavFile, ...settings } = patch;
      download(`${base}.json`, new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' }));
      this.flash(`Downloaded ${base}.wav + ${base}.json`);
    };
    exportBtn.className = 'btn-with-icon';
    actions.appendChild(exportBtn);
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Drop a .json patch here to import it';
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
