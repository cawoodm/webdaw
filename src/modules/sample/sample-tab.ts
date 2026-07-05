import * as Tone from '../../core/tone';
import { engine } from '../../core/audio-engine';
import { bus } from '../../core/event-bus';
import type { PadConfig } from '../../core/model';
import { PAD_COUNT, STEPS_PER_BAR, toneBufferKey, uid } from '../../core/model';
import { renderPatch } from '../../core/patch-voice';
import { store } from '../../core/project-store';
import { uiState, updateUi } from '../../core/ui-state';
import { knob } from '../../ui/knob';

export class SampleTab extends HTMLElement {
  private selected = 0;
  private recording = false;
  private loopPart: Tone.Part | null = null;

  connectedCallback(): void {
    this.className = 'tab-panel sample-tab';
    bus.on('ui:loaded', () => {
      this.selected = Math.min(PAD_COUNT - 1, Math.max(0, uiState().sample.selectedPad));
      this.render();
    });
    bus.on('project:loaded', () => {
      this.render();
      void this.ensureToneBuffers();
    });
    // reflect model edits from other tabs (e.g. renaming a tone patch)
    bus.on('project:changed', () => this.render());
    bus.on('tone:sendToPad', ({ patchId, name, buffer }) => this.receiveTone(patchId, name, buffer));
    this.render();
  }

  /** Link a pad to the patch — it will always play the latest render. */
  private receiveTone(patchId: string, name: string, buffer: AudioBuffer): void {
    store.setBuffer(toneBufferKey(patchId), buffer);
    const existing = store.data.pads.findIndex((p) => p?.toneId === patchId);
    const free = store.data.pads.findIndex((p) => p === null);
    const index = existing !== -1 ? existing : free !== -1 ? free : 0;
    store.update((d) => {
      d.pads[index] = { name, toneId: patchId, gain: 1, trimStart: 0, trimEnd: 0 };
    });
    this.selected = index;
    updateUi((s) => (s.sample.selectedPad = index));
    this.render();
  }

  /** Render buffers for tone-linked pads that don't have one yet (project load). */
  private async ensureToneBuffers(): Promise<void> {
    // renderPatch (Tone.Offline) would create the audio context — wait for
    // the first gesture instead of triggering Chrome's autoplay warning
    if (!engine.started) {
      engine.whenReady(() => void this.ensureToneBuffers());
      return;
    }
    let rendered = false;
    for (const pad of store.data.pads) {
      if (!pad?.toneId || store.getBuffer(toneBufferKey(pad.toneId))) continue;
      const patch = store.data.patches.find((p) => p.id === pad.toneId);
      if (!patch) continue;
      store.setBuffer(toneBufferKey(pad.toneId), await renderPatch(patch));
      rendered = true;
    }
    if (rendered) this.render();
  }

  private padBuffer(pad: PadConfig): AudioBuffer | null {
    if (pad.toneId) return store.getBuffer(toneBufferKey(pad.toneId));
    return pad.file ? store.getBuffer(pad.file) : null;
  }

  /** Play a pad now (or at a scheduled time on the transport). */
  private playPad(index: number, time?: number): void {
    const pad = store.data.pads[index];
    if (!pad) return;
    const buffer = this.padBuffer(pad);
    if (!buffer) return;
    const gainNode = new Tone.Gain(pad.gain).connect(engine.master);
    const src = new Tone.ToneBufferSource(new Tone.ToneAudioBuffer(buffer)).connect(gainNode);
    const duration = pad.trimEnd > 0 ? Math.max(0.01, pad.trimEnd - pad.trimStart) : undefined;
    src.onended = (): void => {
      src.dispose();
      gainNode.dispose();
    };
    src.start(time ?? Tone.now(), pad.trimStart, duration);
  }

  private loopBeats(): number {
    return store.data.padLoopBars * 4;
  }

  private onPadHit(index: number): void {
    void engine.ensureStarted().then(() => this.playPad(index));
    if (this.recording && engine.playing) {
      const time = engine.positionBeats % this.loopBeats();
      store.update((d) => d.padEvents.push({ pad: index, time }));
      this.updateStatus();
    }
  }

  private async toggleRecord(): Promise<void> {
    await engine.ensureStarted();
    if (this.recording) {
      this.recording = false;
      this.stopLoop();
    } else {
      this.recording = true;
      this.startLoop(true);
    }
    this.render();
  }

  private startLoop(withExisting: boolean): void {
    this.loopPart?.dispose();
    const spb = engine.secondsPerBeat();
    engine.setLoop(store.data.padLoopBars);
    if (withExisting && store.data.padEvents.length > 0) {
      this.loopPart = new Tone.Part(
        (time, ev: { pad: number }) => this.playPad(ev.pad, time),
        store.data.padEvents.map((e) => [e.time * spb, { pad: e.pad }] as [number, { pad: number }]),
      );
      this.loopPart.loop = true;
      this.loopPart.loopEnd = this.loopBeats() * spb;
      this.loopPart.start(0);
    }
    engine.play();
  }

  private stopLoop(): void {
    this.loopPart?.dispose();
    this.loopPart = null;
    engine.stop();
    engine.setLoop(0);
  }

  private async exportLoop(): Promise<void> {
    const spb = engine.secondsPerBeat();
    const seconds = this.loopBeats() * spb;
    const events = store.data.padEvents;
    const pads = store.data.pads;
    const buffers = new Map<number, AudioBuffer>();
    pads.forEach((pad, i) => {
      const b = pad ? this.padBuffer(pad) : null;
      if (b) buffers.set(i, b);
    });
    const rendered = await Tone.Offline(() => {
      for (const ev of events) {
        const pad = pads[ev.pad];
        const buffer = buffers.get(ev.pad);
        if (!pad || !buffer) continue;
        const g = new Tone.Gain(pad.gain).connect(Tone.getDestination());
        const src = new Tone.ToneBufferSource(new Tone.ToneAudioBuffer(buffer)).connect(g);
        const duration = pad.trimEnd > 0 ? Math.max(0.01, pad.trimEnd - pad.trimStart) : undefined;
        src.start(ev.time * spb, pad.trimStart, duration);
      }
    }, seconds);
    const path = `exports/pad-loop-${uid()}.wav`;
    const written = await store.saveWav(path, rendered.get() as AudioBuffer);
    this.flash(written ? `Exported ${path}` : `Rendered ${path} in memory — connect a project folder to write files`);
  }

  private editInSequencer(): void {
    const bars = store.data.padLoopBars;
    const usedPads = [...new Set(store.data.padEvents.map((e) => e.pad))].sort((a, b) => a - b);
    const seqId = uid();
    store.update((d) => {
      d.sequences.push({
        id: seqId,
        name: `Pad loop ${d.sequences.length + 1}`,
        bars,
        tracks: usedPads.map((padIndex) => ({
          id: uid(),
          name: d.pads[padIndex]?.name ?? `Pad ${padIndex + 1}`,
          kind: 'audio' as const,
          gain: 1,
          source: { pad: padIndex },
          steps: [
            ...new Set(
              d.padEvents
                .filter((e) => e.pad === padIndex)
                .map((e) => Math.round(e.time * 4) % (bars * STEPS_PER_BAR)),
            ),
          ].sort((a, b) => a - b),
        })),
      });
    });
    bus.emit('sample:editInSequencer', { sequenceId: seqId });
    bus.emit('tab:activate', 'sequence');
  }

  private render(): void {
    this.innerHTML = '';
    const pads = store.data.pads;

    // --- controls ---
    const bar = document.createElement('div');
    bar.className = 'toolbar';
    const btn = (label: string, fn: () => void, cls = ''): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = cls;
      b.onclick = fn;
      return b;
    };
    const barsSel = document.createElement('select');
    for (const n of [1, 2, 4, 8]) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = `${n} bar${n > 1 ? 's' : ''}`;
      opt.selected = store.data.padLoopBars === n;
      barsSel.appendChild(opt);
    }
    barsSel.onchange = (): void => {
      store.update((d) => (d.padLoopBars = Number(barsSel.value)));
    };
    bar.append(
      barsSel,
      btn(this.recording ? '⏺ Stop rec' : '⏺ Record', () => void this.toggleRecord(), this.recording ? 'active' : ''),
      btn('▶ Play loop', async () => {
        await engine.ensureStarted();
        this.startLoop(true);
      }),
      btn('⏹ Stop', () => this.stopLoop()),
      btn('Clear events', () => {
        store.update((d) => (d.padEvents = []));
        this.updateStatus();
      }),
      btn('Export loop WAV', () => void this.exportLoop()),
      btn('Edit in sequencer →', () => this.editInSequencer()),
    );
    const status = document.createElement('span');
    status.className = 'hint pad-status';
    bar.appendChild(status);
    this.appendChild(bar);
    this.updateStatus();

    // --- pad grid + editor ---
    const main = document.createElement('div');
    main.className = 'sample-main';
    const grid = document.createElement('div');
    grid.className = 'pad-grid';
    for (let i = 0; i < PAD_COUNT; i++) {
      const pad = pads[i];
      const el = document.createElement('button');
      el.className = 'pad' + (pad ? ' loaded' : '') + (i === this.selected ? ' selected' : '');
      el.textContent = pad?.name ?? String(i + 1);
      el.onpointerdown = (): void => {
        this.selected = i;
        updateUi((s) => (s.sample.selectedPad = i));
        this.onPadHit(i);
        grid.querySelectorAll('.pad').forEach((p, j) => p.classList.toggle('selected', j === i));
        this.renderEditor(editor);
      };
      grid.appendChild(el);
    }
    main.appendChild(grid);

    const editor = document.createElement('div');
    editor.className = 'pad-editor card';
    this.renderEditor(editor);
    main.appendChild(editor);
    this.appendChild(main);
  }

  private renderEditor(editor: HTMLElement): void {
    editor.innerHTML = '';
    const index = this.selected;
    const pad = store.data.pads[index];
    const title = document.createElement('div');
    title.className = 'card-head';
    title.innerHTML = `<span class="card-title">Pad ${index + 1}${pad ? ` — ${pad.name}` : ''}</span>`;
    editor.appendChild(title);

    // link a tone patch — the pad follows the patch's latest render
    const toneSel = document.createElement('select');
    toneSel.title = 'Load a tone onto this pad (always plays its latest version)';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '— load tone —';
    toneSel.appendChild(noneOpt);
    for (const patch of store.data.patches) {
      const opt = document.createElement('option');
      opt.value = patch.id;
      opt.textContent = patch.name;
      opt.selected = pad?.toneId === patch.id;
      toneSel.appendChild(opt);
    }
    toneSel.onchange = async (): Promise<void> => {
      const patch = store.data.patches.find((p) => p.id === toneSel.value);
      if (!patch) return;
      if (!store.getBuffer(toneBufferKey(patch.id))) {
        store.setBuffer(toneBufferKey(patch.id), await renderPatch(patch));
      }
      store.update((d) => {
        d.pads[index] = { name: patch.name, toneId: patch.id, gain: 1, trimStart: 0, trimEnd: 0 };
      });
      this.render();
    };
    editor.appendChild(toneSel);

    const fileBtn = document.createElement('button');
    fileBtn.textContent = 'Load audio file…';
    fileBtn.onclick = (): void => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.onchange = async (): Promise<void> => {
        const file = input.files?.[0];
        if (!file) return;
        await engine.ensureStarted();
        const name = file.name.replace(/\.[^.]+$/, '');
        const path = `samples/${name.replace(/[^\w-]+/g, '_')}-${uid()}.wav`;
        await store.importAudioFile(file, path);
        store.update((d) => {
          d.pads[index] = { name, file: path, gain: 1, trimStart: 0, trimEnd: 0 };
        });
        this.render();
      };
      input.click();
    };
    editor.appendChild(fileBtn);

    if (!pad) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = 'Empty pad. Load a file or send a tone from the Tone tab.';
      editor.appendChild(hint);
      return;
    }

    const knobs = document.createElement('div');
    knobs.className = 'knob-row';
    const buffer = this.padBuffer(pad);
    const maxLen = buffer ? buffer.duration : 10;
    knobs.append(
      knob({ label: 'Gain', min: 0, max: 1.5, step: 0.01, value: pad.gain }, (v) => {
        pad.gain = v;
        store.scheduleSave();
      }),
      knob({ label: 'Trim in', min: 0, max: maxLen, step: 0.01, value: pad.trimStart, unit: 's' }, (v) => {
        pad.trimStart = v;
        store.scheduleSave();
      }),
      knob({ label: 'Trim out', min: 0, max: maxLen, step: 0.01, value: pad.trimEnd, unit: 's' }, (v) => {
        pad.trimEnd = v;
        store.scheduleSave();
      }),
    );
    editor.appendChild(knobs);
    if (buffer === null && (pad.file || pad.toneId)) {
      const warn = document.createElement('p');
      warn.className = 'warn';
      warn.textContent = pad.toneId
        ? 'Linked tone patch not found or not rendered yet'
        : `Missing audio file: ${pad.file}`;
      editor.appendChild(warn);
    }

    const clear = document.createElement('button');
    clear.textContent = 'Clear pad';
    clear.onclick = (): void => {
      store.update((d) => (d.pads[index] = null));
      this.render();
    };
    editor.appendChild(clear);
  }

  private updateStatus(): void {
    const el = this.querySelector('.pad-status');
    if (el) el.textContent = `${store.data.padEvents.length} recorded hits`;
  }

  private flash(msg: string): void {
    const el = document.createElement('div');
    el.className = 'flash';
    el.textContent = msg;
    this.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }
}

customElements.define('sample-tab', SampleTab);
