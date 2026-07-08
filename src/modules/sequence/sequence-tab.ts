import {engine} from '../../core/audio-engine';
import {bus} from '../../core/event-bus';
import {clearInstrumentCache} from '../../core/instruments';
import type {NoteEvent, SeqInstrument, Sequence, SynthKind} from '../../core/model';
import {pianoNotes, sortedByName, STEPS_PER_BAR, uid} from '../../core/model';
import {projects} from '../../core/project-manager';
import {uniqueName} from '../../core/project-names';
import {store} from '../../core/project-store';
import {buildSeqFile, parseSeqFile} from '../../core/sequence-file';
import {uiState, updateUi} from '../../core/ui-state';
import {buildMidiFile, parseMidiFile, type MidiImportResult} from '../../midi/midi-file';
import {PLAY_ICON, STOP_ICON, transportButton} from '../../ui/transport-buttons';
import {makeMonitor, playSequenceLive, resolveInstrument, type LivePlayback, type Monitor} from './sequence-playback';

/** Trigger a browser download of a generated file. */
function download(filename: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Round DOWN to the quantize grid (16th-note steps) — placing/dragging notes. */
export function floorSnapSteps(steps: number, qSteps: number): number {
  return Math.floor(steps / qSteps + 1e-6) * qSteps;
}

/** Round to the NEAREST quantize step — recorded/resized notes. */
export function nearestSnapSteps(steps: number, qSteps: number): number {
  return Math.round(steps / qSteps) * qSteps;
}

/**
 * Hierarchical gridlines down to the quantize step: bar heaviest, then
 * halving levels, progressively thinner/fainter — the step-unit twin of
 * sample-tab's beat-based gridBackground.
 */
export function gridBackgroundSteps(totalSteps: number, qSteps: number): {image: string; size: string} {
  const style = (level: number): {w: number; a: number} =>
    [
      {w: 2, a: 0.6}, // bar
      {w: 2, a: 0.32}, // 1/2 bar
      {w: 1, a: 0.32}, // beat
      {w: 1, a: 0.2}, // 1/8
      {w: 1, a: 0.12}, // 1/16 and finer
    ][Math.min(level, 4)];
  const images: string[] = [];
  const sizes: string[] = [];
  for (let s = STEPS_PER_BAR, level = 0; s >= qSteps - 1e-6; s /= 2, level++) {
    const {w, a} = style(level);
    images.push(`linear-gradient(90deg, rgb(148 163 184 / ${a * 100}%) ${w}px, transparent ${w}px)`);
    sizes.push(`${100 / (totalSteps / s)}% 100%`);
  }
  return {image: images.join(', '), size: sizes.join(', ')};
}

/** Hue per natural note — blue at A sweeping to red at G; sharps are the light variant. */
const NOTE_HUES: Record<string, number> = {A: 220, B: 183, C: 147, D: 110, E: 73, F: 37, G: 0};

export function noteColor(note: string): string {
  const hue = NOTE_HUES[note[0]] ?? 0;
  const sharp = note[1] === '#';
  return `hsl(${hue} 70% ${sharp ? 68 : 48}%)`;
}

const ROW_HEIGHT = 18;

export class SequenceTab extends HTMLElement {
  private seqId = '';
  /** Sequence id painted by the last render() — distinguishes a load from an edit re-render. */
  private renderedSeqId = '';
  /** A fresh load rendered while the panel was hidden (0 viewport); apply the initial scroll once visible. */
  private scrollPending = false;
  private playback: LivePlayback | null = null;
  private recording = false;
  private monitor: Monitor | null = null;
  private monitorKey = '';
  private recordStarts = new Map<string, {beat: number; velocity: number}>();
  private lastPlayState = false;
  /** Instrument-library catalog (global `_instruments` + the active project's `instruments/`). */
  private instruments: {name: string; source: 'global' | 'project'}[] = [];

  connectedCallback(): void {
    this.className = 'tab-panel sequence-tab';
    void this.refreshInstruments();
    bus.on('project:loaded', () => {
      clearInstrumentCache();
      void this.refreshInstruments();
      this.render();
    });
    bus.on('project:changed', () => this.render());
    bus.on('ui:loaded', () => {
      this.seqId = uiState().sequence.seqId;
      void this.refreshInstruments();
      this.render();
    });
    // playback survives tab switches; release only when another module claims it
    bus.on('transport:claim', ({owner}) => {
      if (owner === 'sequence') return;
      this.playback?.dispose();
      this.playback = null;
      if (this.recording) {
        this.recording = false;
        this.render();
      }
    });
    // global play/stop (Space / shell button)
    bus.on('transport:play', () => {
      if (this.isActive()) void this.play();
    });
    bus.on('transport:stop', () => {
      if (!this.playback && !this.recording) return;
      this.stop();
    });
    bus.on('midi:noteon', ({note, velocity}) => {
      if (this.isActive()) this.noteOnInternal(note, velocity);
    });
    bus.on('midi:noteoff', ({note}) => {
      if (this.isActive()) this.noteOffInternal(note);
    });
    const tick = (): void => {
      this.applyPendingScroll();
      this.updatePlayhead();
      this.updateBarIndicator();
      this.syncPlayToggle();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // drag a .mid/.midi file here to import it
    this.addEventListener('dragover', e => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      this.classList.add('drag-over');
    });
    this.addEventListener('dragleave', () => this.classList.remove('drag-over'));
    this.addEventListener('drop', e => {
      this.classList.remove('drag-over');
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      const files = [...e.dataTransfer.files];
      const seqFiles = files.filter(f => /\.seq\.json$/i.test(f.name));
      const midiFiles = files.filter(f => /\.(mid|midi)$/i.test(f.name));
      if (seqFiles.length > 0) void this.importSeqFiles(seqFiles);
      if (midiFiles.length > 0) void this.importMidiFiles(midiFiles);
    });
    this.render();
  }

  private isActive(): boolean {
    return this.classList.contains('active-tab');
  }

  private async refreshInstruments(): Promise<void> {
    this.instruments = await projects.listInstruments();
    this.render();
  }

  private selectSeq(id: string): void {
    this.seqId = id;
    updateUi(s => (s.sequence.seqId = id));
  }

  private seq(): Sequence | null {
    return store.data.sequences.find(s => s.id === this.seqId) ?? store.data.sequences[0] ?? null;
  }

  /** Current quantization in 16th-note steps (from the Quantize dropdown, stored in beats). */
  private qSteps(): number {
    return (uiState().sequence.quantize || 0.25) * 4;
  }

  // ---- live note input (monitor + record) ----

  private async ensureMonitor(): Promise<Monitor | null> {
    const seq = this.seq();
    if (!seq) return null;
    // no instrument picked yet: fall back to a plain synth so the keyboard
    // always sounds the sequencer on this tab (never the tone tab's patch)
    const instrument: SeqInstrument = seq.instrument ?? {type: 'synth', kind: 'synth'};
    const key = `${seq.id}:${JSON.stringify(instrument)}`;
    if (this.monitor && this.monitorKey === key) return this.monitor;
    await engine.ensureStarted();
    const resolved = seq.instrument ? await resolveInstrument(seq) : {instrument};
    if (!resolved) return null;
    if (this.monitorKey !== key) {
      this.monitor?.dispose();
      this.monitor = makeMonitor(resolved, engine.master);
      this.monitorKey = key;
    }
    return this.monitor;
  }

  private lightKey(note: string, on: boolean): void {
    this.querySelector(`.roll-key[data-note="${note}"]`)?.classList.toggle('lit', on);
  }

  private noteOnInternal(note: string, velocity: number): void {
    this.lightKey(note, true);
    void this.ensureMonitor().then(m => m?.attack(note, velocity));
    if (this.recording && engine.playing) {
      this.recordStarts.set(note, {beat: engine.positionBeats, velocity});
    }
  }

  private noteOffInternal(note: string): void {
    this.lightKey(note, false);
    this.monitor?.release(note);
    const start = this.recordStarts.get(note);
    if (!start) return;
    this.recordStarts.delete(note);
    const seq = this.seq();
    if (!seq) return;
    const totalSteps = seq.bars * STEPS_PER_BAR;
    const q = this.qSteps();
    const startStep = nearestSnapSteps(start.beat * 4, q) % totalSteps;
    const duration = Math.max(q, nearestSnapSteps((engine.positionBeats - start.beat) * 4, q));
    store.update(() => seq.notes.push({step: startStep, note, duration, velocity: start.velocity}));
    this.rebuildLivePartIfPlaying();
  }

  /** Audible feedback when a note is placed — plays the monitor directly so it never records. */
  private previewNote(note: string, durationSteps: number): void {
    this.lightKey(note, true);
    const ms = Math.max(120, durationSteps * engine.secondsPerStep() * 1000);
    void this.ensureMonitor().then(m => {
      m?.attack(note, 0.8);
      window.setTimeout(() => {
        m?.release(note);
        this.lightKey(note, false);
      }, ms);
    });
  }

  // ---- playback ----

  private async play(): Promise<void> {
    const seq = this.seq();
    if (!seq) return;
    await engine.ensureStarted();
    this.playback?.dispose();
    this.playback = null;
    engine.joinTransport('sequence');
    const resolved = await resolveInstrument(seq);
    if (resolved) {
      this.playback = playSequenceLive(seq, engine.master, resolved);
      engine.requestLoop('sequence', seq.bars);
      engine.play();
    }
    this.render();
  }

  private stop(): void {
    this.playback?.dispose();
    this.playback = null;
    engine.releaseTransport('sequence');
    this.recording = false;
    this.render();
  }

  private async toggleRecord(): Promise<void> {
    const seq = this.seq();
    if (!seq?.instrument) return;
    if (this.recording) {
      this.recording = false;
      this.stop();
    } else {
      this.recording = true;
      await this.play();
    }
  }

  // ---- MIDI file import/export ----

  /** Import .mid/.midi files: each MIDI track with notes becomes a new Sequence. */
  private async importMidiFiles(files: File[]): Promise<void> {
    let firstId: string | null = null;
    for (const file of files) {
      if (!/\.(mid|midi)$/i.test(file.name)) continue;
      let result: MidiImportResult;
      try {
        result = parseMidiFile(await file.arrayBuffer());
      } catch (err) {
        console.warn(`[sequence] failed to parse ${file.name}`, err);
        continue;
      }
      if (result.sequences.length === 0) continue;
      const created: Sequence[] = [];
      store.update(d => {
        for (const imp of result.sequences) {
          const seq: Sequence = {
            id: uid(),
            name: uniqueName(
              imp.name,
              d.sequences.map(s => s.name),
            ),
            bars: imp.bars,
            instrument: {type: 'synth', kind: 'synth'},
            notes: imp.notes,
          };
          d.sequences.push(seq);
          created.push(seq);
        }
      });
      if (created.length > 0) firstId ??= created[0].id;
      if (result.bpm !== null && Math.abs(result.bpm - engine.bpm) > 0.5) {
        const bpm = result.bpm;
        if (confirm(`Set project tempo to ${bpm} BPM (from ${file.name})? Currently ${engine.bpm} BPM.`)) {
          engine.bpm = bpm;
          store.update(d => (d.bpm = bpm));
        }
      }
    }
    if (firstId) {
      this.selectSeq(firstId);
      this.render();
    }
  }

  /** Export the current sequence as a Standard MIDI File. */
  private exportMidi(): void {
    const seq = this.seq();
    if (!seq) return;
    const bytes = buildMidiFile([seq], engine.bpm);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    download(`${seq.name}.mid`, new Blob([buffer], {type: 'audio/midi'}));
  }

  /** Export the current sequence as a portable `.seq.json` file. */
  private exportSeqFile(): void {
    const seq = this.seq();
    if (!seq) return;
    download(`${seq.name}.seq.json`, new Blob([buildSeqFile(seq)], {type: 'application/json'}));
  }

  /** Import `.seq.json` files: name collisions prompt to overwrite or import as a renamed copy. */
  private async importSeqFiles(files: File[]): Promise<void> {
    let lastId: string | null = null;
    for (const file of files) {
      const data = parseSeqFile(JSON.parse(await file.text()));
      if (!data) {
        console.warn(`[sequence] failed to parse ${file.name}`);
        continue;
      }
      const existing = store.data.sequences.find(s => s.name === data.name);
      if (existing) {
        const overwrite = confirm(`A sequence named "${data.name}" already exists.\n\nOK = overwrite it\nCancel = import as a renamed copy`);
        if (overwrite) {
          store.update(() => {
            existing.bars = data.bars;
            existing.instrument = data.instrument;
            existing.notes = data.notes;
          });
          lastId = existing.id;
        } else {
          const name = uniqueName(
            data.name,
            store.data.sequences.map(s => s.name),
          );
          const seq: Sequence = {id: uid(), name, bars: data.bars, instrument: data.instrument, notes: data.notes};
          store.update(d => d.sequences.push(seq));
          lastId = seq.id;
        }
      } else {
        const seq: Sequence = {id: uid(), name: data.name, bars: data.bars, instrument: data.instrument, notes: data.notes};
        store.update(d => d.sequences.push(seq));
        lastId = seq.id;
      }
    }
    if (lastId) {
      this.selectSeq(lastId);
      this.render();
    }
  }

  // ---- instrument file import/export ----

  /** Export the current sequence's library instrument as a `.inst.json` file. */
  private async exportInstrument(): Promise<void> {
    const seq = this.seq();
    if (seq?.instrument?.type !== 'instrument') return;
    const text = await projects.readInstrumentJson(seq.instrument.name);
    if (text) download(`${seq.instrument.name}.inst.json`, new Blob([text], {type: 'application/json'}));
  }

  /** Import a `.inst.json` file into the project's instrument library and select it. */
  private importInstrumentFile(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.inst.json,application/json';
    input.onchange = async (): Promise<void> => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      const res = await projects.importInstrument(text);
      if (res.ok) {
        await this.refreshInstruments();
        const seq = this.seq();
        if (seq) store.update(() => (seq.instrument = {type: 'instrument', name: res.name}));
        this.rebuildLivePartIfPlaying();
      } else {
        alert(res.error);
      }
    };
    input.click();
  }

  /** Re-schedule after note edits so changes are audible mid-playback. */
  private rebuildLivePartIfPlaying(): void {
    if (!engine.started || !engine.playing || !this.playback) return;
    const seq = this.seq();
    if (!seq) return;
    this.playback.dispose();
    this.playback = null;
    void resolveInstrument(seq).then(resolved => {
      if (!resolved) return;
      this.playback = playSequenceLive(seq, engine.master, resolved);
    });
  }

  /** Delete every note in the current sequence (after confirming). */
  private clearNotes(): void {
    const seq = this.seq();
    if (!seq || seq.notes.length === 0) return;
    if (!confirm(`Delete all ${seq.notes.length} notes in "${seq.name}"?`)) return;
    seq.notes = [];
    this.commitNotes();
  }

  /** After direct mutations of seq.notes: persist (triggers a re-render) + re-schedule. */
  private commitNotes(): void {
    store.update(() => {});
    this.rebuildLivePartIfPlaying();
  }

  // ---- rAF-driven playhead / indicator / toggle ----

  private updatePlayhead(): void {
    const seq = this.seq();
    const playhead = this.querySelector<HTMLElement>('.roll-playhead');
    const body = this.querySelector<HTMLElement>('.roll-body');
    const scroll = this.querySelector<HTMLElement>('.roll-scroll');
    if (!seq || !playhead || !body || !scroll) return;
    const active = engine.started && engine.playing && (this.playback !== null || this.recording);
    if (!active) {
      playhead.classList.add('hidden');
      return;
    }
    playhead.classList.remove('hidden');
    const totalBeats = seq.bars * 4;
    const fraction = (engine.positionBeats % totalBeats) / totalBeats;
    const x = fraction * body.offsetWidth;
    playhead.style.left = `${x}px`;
    if (seq.bars > 4) {
      const viewWidth = scroll.clientWidth;
      const margin = viewWidth * 0.2; // keep the playhead within the middle 60%
      if (x < scroll.scrollLeft + margin) scroll.scrollLeft = Math.max(0, x - margin);
      else if (x > scroll.scrollLeft + viewWidth - margin) scroll.scrollLeft = x - viewWidth + margin;
    }
  }

  private updateBarIndicator(): void {
    const seq = this.seq();
    if (!seq) return;
    const active = engine.started && engine.playing && (this.playback !== null || this.recording);
    let bar = -1;
    let beat = -1;
    if (active) {
      const totalBeats = seq.bars * 4;
      const posBeats = engine.positionBeats % totalBeats;
      bar = Math.floor(posBeats / 4);
      beat = Math.floor(posBeats % 4);
    }
    const readout = this.querySelector<HTMLElement>('.bar-readout');
    if (readout) {
      readout.textContent = `bar ${(bar >= 0 ? bar : 0) + 1}/${seq.bars}`;
      return;
    }
    const blocks = this.querySelectorAll<HTMLElement>('.bar-block');
    blocks.forEach((b, i) => {
      b.classList.toggle('active', i === bar);
      b.querySelectorAll('i').forEach((dot, j) => dot.classList.toggle('on', i === bar && j === beat));
    });
  }

  private syncPlayToggle(): void {
    const button = this.querySelector<HTMLButtonElement>('.transport-play');
    if (!button) return;
    const playing = !!this.playback && engine.started && engine.playing;
    if (playing === this.lastPlayState) return;
    this.lastPlayState = playing;
    this.paintPlayToggle(button, playing);
  }

  private paintPlayToggle(button: HTMLButtonElement, playing: boolean): void {
    button.classList.toggle('active', playing);
    button.innerHTML = playing ? STOP_ICON : PLAY_ICON;
    button.title = playing ? 'Stop the sequence (Space)' : 'Play the sequence (Space)';
  }

  // ---- rendering ----

  private iconBtn(title: string, svg: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = svg;
    b.onclick = fn;
    return b;
  }

  private instrumentValue(instr: SeqInstrument | undefined): string {
    if (!instr) return '';
    if (instr.type === 'patch') return `patch:${instr.patchId}`;
    if (instr.type === 'wav') return `wav:${instr.file}`;
    if (instr.type === 'instrument') return `instrument:${instr.name}`;
    return `synth:${instr.kind}`;
  }

  private buildInstrumentSelect(seq: Sequence): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.title = 'Instrument this sequence plays';
    const current = this.instrumentValue(seq.instrument);

    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '— instrument —';
    noneOpt.selected = current === '';
    sel.appendChild(noneOpt);

    const instrumentsGroup = document.createElement('optgroup');
    instrumentsGroup.label = 'Instruments';
    for (const instr of sortedByName(this.instruments)) {
      const opt = document.createElement('option');
      opt.value = `instrument:${instr.name}`;
      opt.textContent = instr.name;
      opt.selected = current === opt.value;
      instrumentsGroup.appendChild(opt);
    }
    if (instrumentsGroup.children.length > 0) sel.appendChild(instrumentsGroup);

    const tonesGroup = document.createElement('optgroup');
    tonesGroup.label = 'Tones';
    for (const patch of sortedByName(store.data.patches)) {
      const opt = document.createElement('option');
      opt.value = `patch:${patch.id}`;
      opt.textContent = patch.name;
      opt.selected = current === opt.value;
      tonesGroup.appendChild(opt);
    }
    if (tonesGroup.children.length > 0) sel.appendChild(tonesGroup);

    const samplesGroup = document.createElement('optgroup');
    samplesGroup.label = 'Samples';
    const files = new Set<string>();
    for (const pad of store.data.pads) if (pad?.file) files.add(pad.file);
    if (seq.instrument?.type === 'wav') files.add(seq.instrument.file);
    for (const file of files) {
      const opt = document.createElement('option');
      opt.value = `wav:${file}`;
      opt.textContent = file.split('/').pop() ?? file;
      opt.selected = current === opt.value;
      samplesGroup.appendChild(opt);
    }
    const loadOpt = document.createElement('option');
    loadOpt.value = 'wav:load';
    loadOpt.textContent = '— load audio file… —';
    samplesGroup.appendChild(loadOpt);
    sel.appendChild(samplesGroup);

    const synthGroup = document.createElement('optgroup');
    synthGroup.label = 'Synth';
    for (const [kind, label] of [
      ['synth', 'Synth'],
      ['fm', 'FM Synth'],
      ['am', 'AM Synth'],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = `synth:${kind}`;
      opt.textContent = label;
      opt.selected = current === opt.value;
      synthGroup.appendChild(opt);
    }
    sel.appendChild(synthGroup);

    sel.onchange = (): void => {
      const v = sel.value;
      if (v === 'wav:load') {
        sel.value = current;
        this.loadInstrumentWav(seq);
        return;
      }
      if (v === '') {
        store.update(() => (seq.instrument = undefined));
      } else if (v.startsWith('instrument:')) {
        store.update(() => (seq.instrument = {type: 'instrument', name: v.slice(11)}));
      } else if (v.startsWith('patch:')) {
        store.update(() => (seq.instrument = {type: 'patch', patchId: v.slice(6)}));
      } else if (v.startsWith('wav:')) {
        store.update(() => (seq.instrument = {type: 'wav', file: v.slice(4)}));
      } else if (v.startsWith('synth:')) {
        store.update(() => (seq.instrument = {type: 'synth', kind: v.slice(6) as SynthKind}));
      }
      this.monitorKey = '';
      this.rebuildLivePartIfPlaying();
    };
    return sel;
  }

  private loadInstrumentWav(seq: Sequence): void {
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
      this.monitorKey = '';
      store.update(() => (seq.instrument = {type: 'wav', file: path}));
      this.rebuildLivePartIfPlaying();
    };
    input.click();
  }

  private buildBarIndicator(seq: Sequence): HTMLElement {
    const indicator = document.createElement('div');
    indicator.className = 'bar-indicator';
    if (seq.bars <= 8) {
      for (let b = 0; b < seq.bars; b++) {
        const block = document.createElement('div');
        block.className = 'bar-block';
        const num = document.createElement('span');
        num.className = 'bar-num';
        num.textContent = String(b + 1);
        block.appendChild(num);
        for (let beat = 0; beat < 4; beat++) block.appendChild(document.createElement('i'));
        indicator.appendChild(block);
      }
    } else {
      const readout = document.createElement('span');
      readout.className = 'bar-readout hint';
      readout.textContent = `bar 1/${seq.bars}`;
      indicator.appendChild(readout);
    }
    return indicator;
  }

  private buildClip(seq: Sequence, n: NoteEvent, lane: HTMLElement, lanes: Map<string, HTMLElement>, totalSteps: number): void {
    const clip = document.createElement('div');
    clip.className = 'roll-clip';
    clip.style.background = noteColor(n.note);
    const place = (): void => {
      clip.style.left = `${(n.step / totalSteps) * 100}%`;
      clip.style.width = `${(n.duration / totalSteps) * 100}%`;
      clip.style.opacity = String(0.35 + 0.65 * n.velocity);
    };
    place();
    const handle = document.createElement('div');
    handle.className = 'event-clip-resize';
    clip.appendChild(handle);

    clip.ondblclick = (): void => {
      const idx = seq.notes.indexOf(n);
      if (idx >= 0) seq.notes.splice(idx, 1);
      this.commitNotes();
    };

    clip.oncontextmenu = (e): void => {
      e.preventDefault();
      this.showVelocityPopover(e, n, clip);
    };

    clip.onpointerdown = (e): void => {
      // no preventDefault here — it would suppress the dblclick used for delete
      e.stopPropagation();
      const resizing = e.target === handle;
      const laneRect = lane.getBoundingClientRect();
      const stepsPerPx = totalSteps / lane.offsetWidth;
      const start = {x: e.clientX, y: e.clientY, step: n.step, duration: n.duration};
      let moved = false;
      clip.setPointerCapture(e.pointerId);
      clip.onpointermove = (m): void => {
        if (!moved && Math.abs(m.clientX - start.x) + Math.abs(m.clientY - start.y) < 3) return;
        moved = true;
        const q = this.qSteps();
        const deltaSteps = (m.clientX - start.x) * stepsPerPx;
        if (resizing) {
          n.duration = Math.min(totalSteps - n.step, Math.max(q, nearestSnapSteps(start.duration + deltaSteps, q)));
        } else {
          n.step = Math.min(totalSteps - n.duration, Math.max(0, floorSnapSteps(start.step + deltaSteps, q)));
          for (const [note, otherLane] of lanes) {
            const r = otherLane.getBoundingClientRect();
            if (m.clientY >= r.top && m.clientY <= r.bottom) {
              n.note = note;
              clip.style.background = noteColor(note);
              clip.style.transform = `translateY(${r.top - laneRect.top}px)`;
              break;
            }
          }
        }
        place();
      };
      clip.onpointerup = (): void => {
        clip.onpointermove = null;
        clip.onpointerup = null;
        if (moved) this.commitNotes();
      };
    };
    lane.appendChild(clip);
  }

  private showVelocityPopover(e: MouseEvent, n: NoteEvent, clip: HTMLElement): void {
    document.querySelector('.vel-pop')?.remove();
    const pop = document.createElement('div');
    pop.className = 'vel-pop';
    pop.style.left = `${e.clientX}px`;
    pop.style.top = `${e.clientY}px`;
    const label = document.createElement('span');
    label.textContent = 'Velocity';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '5';
    input.max = '100';
    input.value = String(Math.round(n.velocity * 100));
    input.oninput = (): void => {
      n.velocity = Number(input.value) / 100;
      clip.style.opacity = String(0.35 + 0.65 * n.velocity);
      store.scheduleSave();
    };
    pop.append(label, input);
    document.body.appendChild(pop);
    const close = (ev: PointerEvent): void => {
      if (pop.contains(ev.target as Node)) return;
      pop.remove();
      document.removeEventListener('pointerdown', close);
      this.rebuildLivePartIfPlaying();
    };
    window.setTimeout(() => document.addEventListener('pointerdown', close), 0);
  }

  private buildPianoRoll(seq: Sequence): HTMLElement {
    const totalSteps = seq.bars * STEPS_PER_BAR;
    const grid = gridBackgroundSteps(totalSteps, this.qSteps());
    const scroll = document.createElement('div');
    scroll.className = 'roll-scroll';
    // Vertical wheel scrolls the keyboard (overflow-y is hidden by design);
    // leave horizontal wheel/trackpad gestures to the native overflow-x.
    scroll.addEventListener(
      'wheel',
      e => {
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        scroll.scrollTop += e.deltaY;
        e.preventDefault();
      },
      {passive: false},
    );
    const body = document.createElement('div');
    body.className = 'roll-body';
    body.style.width = `${Math.max(1, seq.bars / 4) * 100}%`;

    const notes = [...pianoNotes()].reverse(); // C8 top -> A0 bottom
    const lanes = new Map<string, HTMLElement>();
    for (const note of notes) {
      const row = document.createElement('div');
      row.className = 'roll-row';
      const isSharp = note.includes('#');

      const key = document.createElement('div');
      key.className = 'roll-key' + (isSharp ? ' black' : '');
      key.dataset.note = note;
      key.style.borderLeft = `3px solid ${noteColor(note)}`;
      key.textContent = note;
      key.title = `Play ${note}`;
      key.onpointerdown = (e): void => {
        e.preventDefault();
        key.setPointerCapture(e.pointerId);
        void engine.ensureStarted().then(() => this.noteOnInternal(note, 0.8));
      };
      const releaseKey = (): void => this.noteOffInternal(note);
      key.onpointerup = releaseKey;
      key.onpointerleave = releaseKey;
      row.appendChild(key);

      const lane = document.createElement('div');
      lane.className = 'roll-lane';
      lane.dataset.note = note;
      lane.style.backgroundImage = grid.image;
      lane.style.backgroundSize = grid.size;
      lane.title = 'Click: add a note (plays it) · drag: move/retarget pitch · right edge: resize · double-click: delete · right-click: velocity';
      let downAt: {x: number; y: number} | null = null;
      lane.onpointerdown = (e): void => {
        downAt = {x: e.clientX, y: e.clientY};
      };
      lane.onclick = (e): void => {
        if (e.target !== lane) return; // clicks on clips are handled there
        const dragged = downAt && Math.abs(e.clientX - downAt.x) + Math.abs(e.clientY - downAt.y) >= 3;
        downAt = null;
        if (dragged) return; // a drag across the lane places nothing
        const q = this.qSteps();
        const fraction = (e.clientX - lane.getBoundingClientRect().left) / lane.offsetWidth;
        const step = Math.min(totalSteps - q, Math.max(0, floorSnapSteps(fraction * totalSteps, q)));
        seq.notes.push({step, note, duration: q, velocity: 0.8});
        this.commitNotes();
        this.previewNote(note, q);
      };
      row.appendChild(lane);
      lanes.set(note, lane);
      body.appendChild(row);
    }

    for (const n of seq.notes) {
      const lane = lanes.get(n.note);
      if (lane) this.buildClip(seq, n, lane, lanes, totalSteps);
    }

    const playhead = document.createElement('div');
    playhead.className = 'roll-playhead hidden';
    body.appendChild(playhead);

    scroll.appendChild(body);

    const wrap = document.createElement('div');
    wrap.className = 'roll-wrap';
    wrap.appendChild(scroll);
    const HALF_OCTAVE = 6 * ROW_HEIGHT;
    const scrollBtn = (dir: -1 | 1): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = `icon-btn roll-scroll-btn ${dir < 0 ? 'up' : 'down'}`;
      const title = dir < 0 ? 'Scroll up half an octave' : 'Scroll down half an octave';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.innerHTML =
        dir < 0
          ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 15 12 9 18 15"/></svg>'
          : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
      b.onclick = (): void => scroll.scrollBy({top: dir * HALF_OCTAVE, behavior: 'smooth'});
      return b;
    };
    wrap.append(scrollBtn(-1), scrollBtn(1));
    return wrap;
  }

  private render(): void {
    const prevScroll = this.querySelector<HTMLElement>('.roll-scroll');
    const savedTop = prevScroll?.scrollTop;
    const savedLeft = prevScroll?.scrollLeft;
    this.innerHTML = '';
    const seq = this.seq();
    if (seq) this.seqId = seq.id;

    const bar = document.createElement('div');
    bar.className = 'toolbar';

    const select = document.createElement('select');
    select.title = 'Switch sequence';
    for (const s of sortedByName(store.data.sequences)) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      opt.selected = seq?.id === s.id;
      select.appendChild(opt);
    }
    select.onchange = (): void => {
      this.stop();
      this.selectSeq(select.value);
      this.monitorKey = '';
      this.render();
    };

    bar.append(
      select,
      this.iconBtn(
        'New sequence',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
        () => {
          const s: Sequence = {
            id: uid(),
            name: uniqueName(
              `Sequence ${store.data.sequences.length + 1}`,
              store.data.sequences.map(x => x.name),
            ),
            bars: 2,
            notes: [],
          };
          this.selectSeq(s.id);
          store.update(d => d.sequences.push(s));
        },
      ),
      this.iconBtn(
        'Duplicate sequence',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
        () => {
          if (!seq) return;
          const copy = structuredClone(seq);
          copy.id = uid();
          copy.name = uniqueName(
            `${seq.name} copy`,
            store.data.sequences.map(x => x.name),
          );
          delete copy.wavFile;
          this.selectSeq(copy.id);
          store.update(d => d.sequences.push(copy));
        },
      ),
      this.iconBtn(
        'Rename sequence',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
          <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>`,
        () => {
          if (!seq) return;
          const name = prompt('Sequence name', seq.name);
          if (!name?.trim()) return;
          store.update(() => {
            seq.name = uniqueName(
              name.trim(),
              store.data.sequences.filter(s => s.id !== seq.id).map(s => s.name),
            );
          });
        },
      ),
      this.iconBtn(
        'Delete sequence',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
        () => {
          if (!seq) return;
          this.stop();
          this.selectSeq('');
          store.update(d => (d.sequences = d.sequences.filter(s => s.id !== seq.id)));
        },
      ),
      this.iconBtn(
        'Clear all notes',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M7 21h10"/><path d="M5 15l6-6 5 5-6 6H8z"/><path d="M11 9l4-4a2 2 0 0 1 3 0l2 2a2 2 0 0 1 0 3l-4 4"/></svg>`,
        () => this.clearNotes(),
      ),
      this.iconBtn(
        'Import MIDI file',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
        () => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.mid,.midi,audio/midi';
          input.onchange = (): void => {
            if (input.files?.length) void this.importMidiFiles([...input.files]);
          };
          input.click();
        },
      ),
      this.iconBtn(
        'Export sequence as MIDI file',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
        () => this.exportMidi(),
      ),
      this.iconBtn(
        'Export sequence (.seq.json)',
        `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
        () => this.exportSeqFile(),
      ),
    );

    if (seq) {
      const barsInput = document.createElement('input');
      barsInput.type = 'number';
      barsInput.min = '1';
      barsInput.max = '64';
      barsInput.value = String(seq.bars);
      barsInput.title = 'Bars';
      barsInput.onchange = (): void => {
        const v = Math.min(64, Math.max(1, Math.round(Number(barsInput.value) || 1)));
        barsInput.value = String(v);
        store.update(() => (seq.bars = v));
      };
      const barsLabel = document.createElement('label');
      barsLabel.className = 'hint check-toggle';
      barsLabel.append(document.createTextNode('Bars '), barsInput);
      bar.appendChild(barsLabel);

      const quantSel = document.createElement('select');
      quantSel.title = 'Quantize: recording rounds to the nearest step, note edits snap down to it';
      for (const [value, label] of [
        [1, '1 beat'],
        [0.5, '1/2'],
        [0.25, '1/4'],
        [0.125, '1/8'],
        [0.0625, '1/16'],
        [0.03125, '1/32'],
      ] as const) {
        const opt = document.createElement('option');
        opt.value = String(value);
        opt.textContent = label;
        opt.selected = uiState().sequence.quantize === value;
        quantSel.appendChild(opt);
      }
      quantSel.onchange = (): void => {
        updateUi(s => (s.sequence.quantize = Number(quantSel.value)));
        this.render();
      };
      const quantWrap = document.createElement('label');
      quantWrap.className = 'hint check-toggle';
      quantWrap.append(document.createTextNode('Quantize '), quantSel);
      bar.appendChild(quantWrap);

      bar.appendChild(this.buildInstrumentSelect(seq));
      bar.appendChild(
        this.iconBtn(
          'Import instrument (.inst.json)',
          `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
          () => this.importInstrumentFile(),
        ),
      );
      bar.appendChild(
        this.iconBtn(
          'Export instrument (.inst.json)',
          `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
          () => void this.exportInstrument(),
        ),
      );

      const playBtn = transportButton('play', 'Play the sequence (Space)', () => {
        if (this.playback && engine.started && engine.playing) {
          this.stop();
        } else {
          void this.play();
        }
      });
      this.lastPlayState = !!this.playback && engine.started && engine.playing;
      this.paintPlayToggle(playBtn, this.lastPlayState);
      const recBtn = transportButton(
        'record',
        seq.instrument ? (this.recording ? 'Stop recording' : 'Record MIDI — plays the sequence and captures note input') : 'Set an instrument first',
        () => void this.toggleRecord(),
      );
      recBtn.classList.toggle('recording', this.recording);
      recBtn.disabled = !seq.instrument;
      // transport row first — play/rec sit top-left, above the toolbar
      const transport = document.createElement('div');
      transport.className = 'toolbar sequence-transport';
      transport.append(playBtn, recBtn);
      this.appendChild(transport);
    }
    this.appendChild(bar);

    if (!seq) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = 'No sequences yet. Create one to start recording notes.';
      this.appendChild(hint);
      return;
    }

    this.appendChild(this.buildBarIndicator(seq));
    const roll = this.buildPianoRoll(seq);
    this.appendChild(roll);
    const scroll = roll.querySelector<HTMLElement>('.roll-scroll')!;

    const sameSeq = seq.id === this.renderedSeqId;
    if (sameSeq && savedTop !== undefined && !this.scrollPending) {
      // Re-render of the same sequence (e.g. an edit): keep the user's scroll.
      // (Skip while a scroll is still pending — the saved value is from a
      // hidden 0-height render at boot and would strand the wrong octave.)
      scroll.scrollTop = savedTop;
      scroll.scrollLeft = savedLeft ?? 0;
      this.scrollPending = false;
    } else {
      // A sequence just loaded: frame it at bar 1. Empty -> center C3;
      // otherwise center the pitches in bar 1 so most notes are in view.
      scroll.scrollLeft = 0;
      // At boot the tab can render while still hidden (0 height) — the centering
      // math needs a real viewport, so defer to the tick loop once it's visible.
      if (scroll.clientHeight > 0) {
        scroll.scrollTop = this.initialScrollTop(seq, scroll.clientHeight);
        this.scrollPending = false;
      } else {
        this.scrollPending = true;
      }
    }
    if (!sameSeq) void this.reportMissingRefs(seq);
    this.renderedSeqId = seq.id;
  }

  /**
   * When a sequence is loaded, warn (via a flash) if its instrument references
   * a tone/patch/instrument that isn't present — naming the missing id/name so
   * the user knows what to restore.
   */
  private async reportMissingRefs(seq: Sequence): Promise<void> {
    const instr = seq.instrument;
    if (!instr) return;
    if (instr.type === 'patch') {
      if (!store.data.patches.some(p => p.id === instr.patchId)) {
        this.flash(`"${seq.name}": tone not found — id ${instr.patchId}`);
      }
    } else if (instr.type === 'instrument') {
      const loaded = await projects.loadInstrument(instr.name);
      if (!loaded) {
        this.flash(`"${seq.name}": instrument not found — "${instr.name}"`);
      } else if (loaded.missingTones?.length) {
        this.flash(`Instrument "${instr.name}": unknown tone id ${loaded.missingTones.join(', ')}`);
      }
    }
  }

  private flash(msg: string): void {
    const el = document.createElement('div');
    el.className = 'flash';
    el.textContent = msg;
    this.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  /**
   * Vertical scroll for a freshly-loaded sequence: center C3 when it has no
   * notes, otherwise center the average pitch of bar-1 notes (falling back to
   * all notes) so the bulk of them sit in view.
   */
  private initialScrollTop(seq: Sequence, viewHeight: number): number {
    const notes = [...pianoNotes()].reverse(); // C8 top -> A0 bottom
    const rowIndex = (note: string): number => notes.indexOf(note);
    const center = (idx: number): number => Math.max(0, idx * ROW_HEIGHT + ROW_HEIGHT / 2 - viewHeight / 2);

    if (seq.notes.length === 0) return center(rowIndex('C3'));

    const bar1 = seq.notes.filter(n => n.step < STEPS_PER_BAR);
    const source = bar1.length > 0 ? bar1 : seq.notes;
    const indices = source.map(n => rowIndex(n.note)).filter(i => i >= 0);
    if (indices.length === 0) return center(rowIndex('C3'));
    const avg = indices.reduce((a, b) => a + b, 0) / indices.length;
    return center(avg);
  }

  /** Apply the deferred initial scroll once the panel has a real viewport (post-boot visibility). */
  private applyPendingScroll(): void {
    if (!this.scrollPending) return;
    const scroll = this.querySelector<HTMLElement>('.roll-scroll');
    if (!scroll || scroll.clientHeight === 0) return;
    const seq = this.seq();
    if (seq) scroll.scrollTop = this.initialScrollTop(seq, scroll.clientHeight);
    this.scrollPending = false;
  }
}

customElements.define('sequence-tab', SequenceTab);
