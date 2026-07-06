import * as Tone from '../../core/tone';
import { engine } from '../../core/audio-engine';
import { bus } from '../../core/event-bus';
import type { PadConfig } from '../../core/model';
import { PAD_COUNT, STEPS_PER_BAR, toneBufferKey, uid } from '../../core/model';
import { renderPatch } from '../../core/patch-voice';
import { store } from '../../core/project-store';
import { beatsToTransportTime } from '../../core/time';
import { uiState, updateUi } from '../../core/ui-state';
import { knob } from '../../ui/knob';

export class SampleTab extends HTMLElement {
  private selected = 0;
  private recording = false;
  private loopPart: Tone.Part | null = null;
  /** Beats of count-in preceding the loop region (0 when none). */
  private countInBeats = 0;
  private transportEvents: number[] = [];
  private metroForced = false;
  private lastIndicatorBar = -2;

  connectedCallback(): void {
    this.className = 'tab-panel sample-tab';
    bus.on('ui:loaded', () => {
      this.selected = Math.min(PAD_COUNT - 1, Math.max(0, uiState().sample.selectedPad));
      this.render();
    });
    window.addEventListener('keydown', this.onKeyDown);
    const indicatorTick = (): void => {
      this.updateBarIndicator();
      requestAnimationFrame(indicatorTick);
    };
    requestAnimationFrame(indicatorTick);
    bus.on('project:loaded', () => {
      this.render();
      void this.ensureToneBuffers();
    });
    // reflect model edits from other tabs (e.g. renaming a tone patch)
    bus.on('project:changed', () => this.render());
    bus.on('tone:sendToPad', ({ patchId, name, buffer }) => this.receiveTone(patchId, name, buffer));
    this.render();
  }

  /** Keypad 1-8 fire pads 1-8; Shift+1-8 fire pads 9-16 (sample tab only). */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (!this.classList.contains('active-tab')) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    const match = /^(?:Digit|Numpad)([1-8])$/.exec(e.code);
    if (!match) return;
    e.preventDefault();
    const index = Number(match[1]) - 1 + (e.shiftKey ? 8 : 0);
    this.selected = index;
    updateUi((s) => (s.sample.selectedPad = index));
    this.onPadHit(index);
    this.refreshSelection();
  };

  /** Update pad selection highlight + editor without a full re-render. */
  private refreshSelection(): void {
    this.querySelectorAll('.pad').forEach((p, j) => p.classList.toggle('selected', j === this.selected));
    const editor = this.querySelector<HTMLElement>('.pad-editor');
    if (editor) this.renderEditor(editor);
  }

  /** Flash a pad at (or near) its scheduled play time. */
  private flashPad(index: number, time?: number): void {
    const delayMs = time !== undefined && engine.started ? Math.max(0, (time - Tone.immediate()) * 1000) : 0;
    window.setTimeout(() => {
      const el = this.querySelectorAll<HTMLElement>('.pad')[index];
      if (!el) return;
      el.classList.remove('hit');
      void el.offsetWidth; // restart the CSS animation
      el.classList.add('hit');
      window.setTimeout(() => el.classList.remove('hit'), 200);
    }, delayMs);
  }

  /** Link a pad to the patch — it will always play the latest render. */
  private receiveTone(patchId: string, name: string, buffer: AudioBuffer): void {
    store.setBuffer(toneBufferKey(patchId), buffer);
    const existing = store.data.pads.findIndex((p) => p?.toneId === patchId);
    const free = store.data.pads.findIndex((p) => p === null);
    const index = existing !== -1 ? existing : free !== -1 ? free : 0;
    store.update((d) => {
      const prev = d.pads[index];
      d.pads[index] = { name, toneId: patchId, color: prev?.color, gain: prev?.gain ?? 1, trimStart: 0, trimEnd: 0 };
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
      if (!pad?.toneId) continue;
      // re-render buffers made pre-gesture against the 44.1 kHz stub context
      const cached = store.getBuffer(toneBufferKey(pad.toneId));
      if (cached && cached.sampleRate === Tone.getContext().sampleRate) continue;
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
    // live hits start without the ~100ms scheduling look-ahead
    src.start(time ?? Tone.immediate(), pad.trimStart, duration);
    if (time !== undefined) this.flashPad(index, time); // scheduled loop hits
  }

  private loopBeats(): number {
    return store.data.padLoopBars * 4;
  }

  private onPadHit(index: number): void {
    this.flashPad(index); // immediate visual feedback, even on empty pads
    void engine.ensureStarted().then(() => this.playPad(index));
    if (this.recording && engine.playing) {
      // during a count-in the position is still before the loop region
      const posBeats = engine.positionBeats - this.countInBeats;
      if (posBeats < 0) return;
      const time = posBeats % this.loopBeats();
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
      await this.startLoop(true, uiState().sample.countIn);
    }
    this.render();
  }

  private async startLoop(withExisting: boolean, countIn = false): Promise<void> {
    this.loopPart?.dispose();
    const bars = store.data.padLoopBars;
    const countBars = countIn ? 1 : 0;
    this.countInBeats = countBars * 4;
    engine.setLoop(bars, countBars);
    if (withExisting && store.data.padEvents.length > 0) {
      // musical time, not seconds: the transport (= metronome) is the clock,
      // so BPM changes keep pad hits and clicks locked together
      this.loopPart = new Tone.Part(
        (time, ev: { pad: number }) => this.playPad(ev.pad, time),
        store.data.padEvents.map((e) => [beatsToTransportTime(e.time), { pad: e.pad }] as [string, { pad: number }]),
      );
      this.loopPart.loop = true;
      this.loopPart.loopEnd = `${bars}m`;
      this.loopPart.start(`${countBars}m`);
    }
    const transport = Tone.getTransport();
    if (countIn && !engine.metronomeOn) {
      // the count-in IS metronome clicks — force it on and keep it ticking
      // through the recording; stopLoop restores the user's toggle state.
      // Armed (not started) BEFORE the transport starts, so the very first
      // accented beat-0 click is scheduled too.
      this.metroForced = true;
      await engine.armMetronome();
    }
    if (this.recording && !uiState().sample.overdub) {
      // no overdub: disarm recording after exactly one pass (playback continues).
      // Integer ticks — decimal measures like "2.98m" are not valid notation
      // and silently degrade to seconds, firing far too early.
      const disarmTicks = Math.round(((countBars + bars) * 4 - 0.05) * transport.PPQ);
      this.transportEvents.push(
        transport.scheduleOnce(() => {
          this.recording = false;
          this.render();
        }, `${disarmTicks}i`),
      );
    }
    engine.play();
  }

  private stopLoop(): void {
    this.loopPart?.dispose();
    this.loopPart = null;
    const transport = Tone.getTransport();
    for (const id of this.transportEvents) transport.clear(id);
    this.transportEvents = [];
    if (this.metroForced) {
      this.metroForced = false;
      void engine.setMetronome(false);
    }
    this.countInBeats = 0;
    engine.stop();
    engine.setLoop(0);
  }

  /** Highlight the current bar (or count-in) while the transport runs. */
  private updateBarIndicator(): void {
    const blocks = this.querySelectorAll<HTMLElement>('.bar-block');
    if (blocks.length === 0) return;
    let bar = -1;
    let beat = -1;
    let counting = false;
    let fraction = -1; // playhead position 0..1 across the loop
    if (engine.started && engine.playing) {
      const posBeats = engine.positionBeats - this.countInBeats;
      if (posBeats < 0) {
        counting = true;
      } else {
        const inLoop = posBeats % this.loopBeats();
        bar = Math.floor(inLoop / 4) % store.data.padLoopBars;
        beat = Math.floor(inLoop % 4);
        fraction = inLoop / this.loopBeats();
      }
    }
    // playhead moves every frame; block/beat classes only on change
    const playhead = this.querySelector<HTMLElement>('.event-playhead');
    if (playhead) {
      const cells = this.querySelector<HTMLElement>('.event-cells');
      if (fraction < 0 || !cells) {
        playhead.classList.add('hidden');
      } else {
        playhead.classList.remove('hidden');
        playhead.style.left = `${cells.offsetLeft + fraction * cells.offsetWidth}px`;
      }
    }
    const key = counting ? -1 : bar * 4 + beat;
    if (key === this.lastIndicatorBar && !counting) return;
    this.lastIndicatorBar = key;
    blocks.forEach((b, i) => {
      b.classList.toggle('active', i === bar);
      b.classList.toggle('counting', counting);
      b.querySelectorAll('i').forEach((dot, j) => dot.classList.toggle('on', i === bar && j === beat));
    });
  }

  /** Grid of recorded hits: one row per pad with data, colored by pad color. */
  private buildEventGrid(): HTMLElement {
    const bars = store.data.padLoopBars;
    const steps = bars * STEPS_PER_BAR;
    const byPad = new Map<number, Set<number>>();
    for (const e of store.data.padEvents) {
      const step = Math.round(e.time * 4) % steps;
      if (!byPad.has(e.pad)) byPad.set(e.pad, new Set());
      byPad.get(e.pad)!.add(step);
    }
    const grid = document.createElement('div');
    grid.className = 'event-grid';
    if (byPad.size === 0) {
      grid.classList.add('hidden');
      return grid;
    }
    for (const padIndex of [...byPad.keys()].sort((a, b) => a - b)) {
      const pad = store.data.pads[padIndex];
      const color = pad?.color ?? '#4fd1c5';
      const row = document.createElement('div');
      row.className = 'event-row';
      const label = document.createElement('span');
      label.className = 'event-label';
      label.textContent = pad?.name ?? `Pad ${padIndex + 1}`;
      label.style.borderRightColor = color;
      row.appendChild(label);
      const cells = document.createElement('div');
      cells.className = 'event-cells';
      cells.style.gridTemplateColumns = `repeat(${steps}, 1fr)`;
      const hits = byPad.get(padIndex)!;
      for (let s = 0; s < steps; s++) {
        const cell = document.createElement('div');
        cell.className =
          'event-cell' + (s % STEPS_PER_BAR === 0 ? ' bar-start' : s % 4 === 0 ? ' beat-start' : '');
        if (hits.has(s)) {
          cell.classList.add('on');
          cell.style.background = color;
        }
        cells.appendChild(cell);
      }
      row.appendChild(cells);
      grid.appendChild(row);
    }
    const playhead = document.createElement('div');
    playhead.className = 'event-playhead hidden';
    grid.appendChild(playhead);
    return grid;
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
    this.lastIndicatorBar = -2;

    // --- bar indicator (bar number + one dot per beat) + recorded-event grid ---
    const indicator = document.createElement('div');
    indicator.className = 'bar-indicator';
    for (let b = 0; b < store.data.padLoopBars; b++) {
      const block = document.createElement('div');
      block.className = 'bar-block';
      const num = document.createElement('span');
      num.className = 'bar-num';
      num.textContent = String(b + 1);
      block.appendChild(num);
      for (let beat = 0; beat < 4; beat++) block.appendChild(document.createElement('i'));
      indicator.appendChild(block);
    }
    this.appendChild(indicator);
    this.appendChild(this.buildEventGrid());

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
    const check = (label: string, title: string, value: boolean, onChange: (v: boolean) => void): HTMLLabelElement => {
      const wrap = document.createElement('label');
      wrap.className = 'hint check-toggle';
      wrap.title = title;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = value;
      box.onchange = (): void => onChange(box.checked);
      wrap.append(box, document.createTextNode(` ${label}`));
      return wrap;
    };
    bar.append(
      barsSel,
      check('Count-in', 'One bar of metronome clicks before recording starts', uiState().sample.countIn, (v) =>
        updateUi((s) => (s.sample.countIn = v)),
      ),
      check('Overdub', 'Keep recording every pass; unchecked stops recording after one pass', uiState().sample.overdub, (v) =>
        updateUi((s) => (s.sample.overdub = v)),
      ),
      btn(this.recording ? '⏺ Stop rec' : '⏺ Record', () => void this.toggleRecord(), this.recording ? 'recording' : ''),
      btn('▶ Play loop', async () => {
        await engine.ensureStarted();
        await this.startLoop(true);
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
      const key = i < 8 ? `${i + 1}` : `⇧${i - 7}`;
      el.innerHTML = `<span class="pad-key">${key}</span>${pad?.name ?? ''}`;
      el.title = i < 8 ? `Play with key ${i + 1}` : `Play with Shift+${i - 7}`;
      if (pad?.color) {
        el.style.borderColor = pad.color;
        el.style.background = `${pad.color}2e`; // translucent fill of the pad color
      }
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
        const prev = d.pads[index];
        d.pads[index] = { name: patch.name, toneId: patch.id, color: prev?.color, gain: prev?.gain ?? 1, trimStart: 0, trimEnd: 0 };
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
          const prev = d.pads[index];
          d.pads[index] = { name, file: path, color: prev?.color, gain: prev?.gain ?? 1, trimStart: 0, trimEnd: 0 };
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

    const colorRow = document.createElement('label');
    colorRow.className = 'hint check-toggle';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = pad.color ?? '#4fd1c5';
    colorInput.title = 'Pad color';
    colorInput.oninput = (): void => {
      pad.color = colorInput.value;
      store.scheduleSave();
      this.paintPad(index);
    };
    colorRow.append(colorInput, document.createTextNode(' Pad color'));
    editor.appendChild(colorRow);

    const clear = document.createElement('button');
    clear.textContent = 'Clear pad';
    clear.onclick = (): void => {
      store.update((d) => (d.pads[index] = null));
      this.render();
    };
    editor.appendChild(clear);
  }

  /** Apply a pad's color to its button without a full re-render. */
  private paintPad(index: number): void {
    const el = this.querySelectorAll<HTMLElement>('.pad')[index];
    const pad = store.data.pads[index];
    if (!el || !pad?.color) return;
    el.style.borderColor = pad.color;
    el.style.background = `${pad.color}2e`;
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
