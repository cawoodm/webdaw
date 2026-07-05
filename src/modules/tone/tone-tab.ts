import { engine } from '../../core/audio-engine';
import { bus } from '../../core/event-bus';
import type { TonePatch } from '../../core/model';
import { defaultPatch, uid } from '../../core/model';
import { store } from '../../core/project-store';
import { knob } from '../../ui/knob';
import { PatchVoice, renderPatch } from './patch-voice';

const OSC_TYPES = ['sine', 'sawtooth', 'triangle', 'square'] as const;
const LFO_TARGETS = ['off', 'pitch', 'volume'] as const;

export class ToneTab extends HTMLElement {
  private patchId = '';
  private active = false;
  private voices = new Map<string, PatchVoice>();

  connectedCallback(): void {
    this.className = 'tab-panel tone-tab';
    bus.on('project:loaded', () => this.render());
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
    this.patchId = store.data.patches[0].id;
    return store.data.patches[0];
  }

  private async noteOn(note: string, velocity: number): Promise<void> {
    await engine.ensureStarted();
    this.noteOff(note);
    const voice = new PatchVoice(this.patch(), engine.master);
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

  private save(): void {
    store.scheduleSave();
  }

  private render(): void {
    const patch = this.patch();
    this.innerHTML = '';

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
      this.patchId = select.value;
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
        this.patchId = p.id;
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
        this.patchId = '';
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
      head.append(
        Object.assign(document.createElement('span'), { textContent: `Layer ${i + 1}`, className: 'card-title' }),
        typeSel,
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
    row.append(envCard, lfoCard);
    this.appendChild(row);

    // --- actions ---
    const actions = document.createElement('div');
    actions.className = 'toolbar';
    actions.append(
      btn('▶ Preview C4', async () => {
        await engine.ensureStarted();
        void this.noteOn('C4', 0.9);
        setTimeout(() => this.noteOff('C4'), 600);
      }),
      btn('Export WAV', async () => {
        const buffer = await renderPatch(patch);
        const path = `tones/${patch.name.replace(/[^\w-]+/g, '_')}.wav`;
        await store.saveWav(path, buffer);
        store.update(() => (patch.wavFile = path));
        this.flash(`Saved ${path}`);
      }),
      btn('Send to pad →', async () => {
        const buffer = await renderPatch(patch);
        bus.emit('tone:sendToPad', { name: patch.name, buffer });
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
