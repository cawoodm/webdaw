import * as Tone from '../../core/tone';
import { engine } from '../../core/audio-engine';
import { bus } from '../../core/event-bus';
import type { PadConfig, PadEvent, PadLoop, TonePatch } from '../../core/model';
import { defaultLoop, defaultPatch, PAD_COUNT, STEPS_PER_BAR, toneBufferKey, uid } from '../../core/model';
import { renderPatch } from '../../core/patch-voice';
import { uniqueName } from '../../core/project-names';
import { store } from '../../core/project-store';
import { beatsToTransportTime } from '../../core/time';
import { uiState, updateUi } from '../../core/ui-state';
import { encodeWav } from '../../core/wav';
import { knob } from '../../ui/knob';

/** Trigger a browser download of a generated file. */
function download(filename: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Portable .json form of a sample: loop definition + the pad kit it uses. */
interface SampleFile {
  format: 'webdaw-sample';
  name: string;
  bars: number;
  events: PadEvent[];
  pads: Record<string, SamplePadEntry>;
}

interface SamplePadEntry {
  name: string;
  gain: number;
  trimStart: number;
  trimEnd: number;
  color?: string;
  file?: string;
  tone?: Partial<TonePatch>;
}

export class SampleTab extends HTMLElement {
  private selected = 0;
  private recording = false;
  private loopPart: Tone.Part | null = null;
  /** Beats of count-in preceding the loop region (0 when none). */
  private countInBeats = 0;
  private transportEvents: number[] = [];
  private metroForced = false;
  private lastIndicatorBar = -2;
  private lastPlayState = false;

  connectedCallback(): void {
    this.className = 'tab-panel sample-tab';
    bus.on('ui:loaded', () => {
      this.selected = Math.min(PAD_COUNT - 1, Math.max(0, uiState().sample.selectedPad));
      this.render();
    });
    // playback survives tab switches; release only when another module claims it
    bus.on('transport:claim', ({ owner }) => {
      if (owner === 'sample') return;
      const wasActive = this.loopPart !== null || this.recording;
      this.releaseLoop();
      if (wasActive) this.render();
    });
    window.addEventListener('keydown', this.onKeyDown);
    const indicatorTick = (): void => {
      this.updateBarIndicator();
      this.syncPlayToggle();
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
    // drag a .json sample (Export's sidecar) here to import it
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
      void this.importSampleFiles([...e.dataTransfer.files]);
    });
    this.render();
  }

  /** The active loop ("sample"); guarantees one exists. */
  private loop(): PadLoop {
    const loops = store.data.padLoops;
    const found = loops.find((l) => l.id === uiState().sample.loopId);
    if (found) return found;
    if (loops.length === 0) loops.push(defaultLoop());
    this.selectLoop(loops[0].id);
    return loops[0];
  }

  private selectLoop(id: string): void {
    updateUi((s) => (s.sample.loopId = id));
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

  /** A pad's trimmed sample length in seconds, when its buffer is known. */
  private padSeconds(pad: PadConfig): number | undefined {
    const buffer = this.padBuffer(pad);
    if (!buffer) return undefined;
    const end = pad.trimEnd > 0 ? Math.min(pad.trimEnd, buffer.duration) : buffer.duration;
    return Math.max(0.01, end - pad.trimStart);
  }

  /**
   * Play a pad now (or at a scheduled time on the transport).
   * `durationBeats` (grid clips) caps the playback length.
   */
  private playPad(index: number, time?: number, durationBeats?: number): void {
    const pad = store.data.pads[index];
    if (!pad) return;
    const buffer = this.padBuffer(pad);
    if (!buffer) return;
    const gainNode = new Tone.Gain(pad.gain).connect(engine.master);
    const src = new Tone.ToneBufferSource(new Tone.ToneAudioBuffer(buffer)).connect(gainNode);
    let duration = pad.trimEnd > 0 ? Math.max(0.01, pad.trimEnd - pad.trimStart) : undefined;
    if (durationBeats !== undefined) {
      const cap = durationBeats * engine.secondsPerBeat();
      duration = duration === undefined ? cap : Math.min(duration, cap);
    }
    src.onended = (): void => {
      src.dispose();
      gainNode.dispose();
    };
    // live hits start without the ~100ms scheduling look-ahead
    src.start(time ?? Tone.immediate(), pad.trimStart, duration);
    if (time !== undefined) this.flashPad(index, time); // scheduled loop hits
  }

  private loopBeats(): number {
    return this.loop().bars * 4;
  }

  private onPadHit(index: number): void {
    this.flashPad(index); // immediate visual feedback, even on empty pads
    void engine.ensureStarted().then(() => this.playPad(index));
    if (this.recording && engine.playing) {
      // during a count-in the position is still before the loop region
      const posBeats = engine.positionBeats - this.countInBeats;
      if (posBeats < 0) return;
      // round to the nearest quantize step (may wrap past the loop end)
      const time = this.nearestSnap(posBeats % this.loopBeats()) % this.loopBeats();
      store.update(() => this.loop().events.push({ pad: index, time }));
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
    engine.claimTransport('sample');
    const bars = this.loop().bars;
    const countBars = countIn ? 1 : 0;
    this.countInBeats = countBars * 4;
    engine.setLoop(bars, countBars);
    if (withExisting && this.loop().events.length > 0) {
      this.loopPart = this.makeLoopPart(countBars);
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

  /**
   * Schedule all pad events on the transport. Musical time, not seconds:
   * the transport (= metronome) is the clock, so BPM changes keep pad
   * hits and clicks locked together.
   */
  private makeLoopPart(countBars: number): Tone.Part {
    const part = new Tone.Part(
      (time, ev: PadEvent) => this.playPad(ev.pad, time, ev.duration),
      this.loop().events.map((e) => [beatsToTransportTime(e.time), e] as [string, PadEvent]),
    );
    part.loop = true;
    part.loopEnd = `${this.loop().bars}m`;
    part.start(`${countBars}m`);
    return part;
  }

  /** Re-schedule after grid edits so changes are audible mid-playback. */
  private rebuildLoopPartIfPlaying(): void {
    if (!engine.started || !engine.playing) return;
    this.loopPart?.dispose();
    this.loopPart = this.makeLoopPart(this.countInBeats / 4);
  }

  private stopLoop(): void {
    this.releaseLoop();
    engine.stop();
    engine.setLoop(0);
  }

  /** Drop everything we scheduled on the transport, without touching it. */
  private releaseLoop(): void {
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
    this.recording = false;
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
        bar = Math.floor(inLoop / 4) % this.loop().bars;
        beat = Math.floor(inLoop % 4);
        fraction = inLoop / this.loopBeats();
      }
    }
    // playhead moves every frame; block/beat classes only on change
    const playhead = this.querySelector<HTMLElement>('.event-playhead');
    if (playhead) {
      const lane = this.querySelector<HTMLElement>('.event-lane');
      if (fraction < 0 || !lane) {
        playhead.classList.add('hidden');
      } else {
        playhead.classList.remove('hidden');
        playhead.style.left = `${lane.offsetLeft + fraction * lane.offsetWidth}px`;
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

  /** One button toggling loop playback: green Play when stopped, red Stop while playing. */
  private buildPlayToggle(): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'play-toggle';
    button.onclick = async (): Promise<void> => {
      if (engine.started && engine.playing) {
        this.recording = false;
        this.stopLoop();
        this.render();
      } else {
        await engine.ensureStarted();
        await this.startLoop(true);
      }
    };
    this.paintPlayToggle(button, engine.started && engine.playing);
    return button;
  }

  private paintPlayToggle(button: HTMLButtonElement, playing: boolean): void {
    button.classList.toggle('playing', playing);
    button.title = playing ? 'Stop the loop' : 'Play the loop';
    button.innerHTML = playing
      ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg> Stop'
      : '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg> Play';
  }

  /** Keep the play toggle in sync with the transport (rAF-driven). */
  private syncPlayToggle(): void {
    const button = this.querySelector<HTMLButtonElement>('.play-toggle');
    if (!button) return;
    const playing = engine.started && engine.playing;
    if (playing === this.lastPlayState) return;
    this.lastPlayState = playing;
    this.paintPlayToggle(button, playing);
  }

  /** Current quantization in beats (from the Quantize dropdown). */
  private quantize(): number {
    return uiState().sample.quantize || 0.25;
  }

  /** Round DOWN to the quantize grid — placing/dragging clips. */
  private floorSnap(beats: number): number {
    const q = this.quantize();
    return Math.floor(beats / q + 1e-6) * q;
  }

  /** Round to the NEAREST quantize step — recorded hits. */
  private nearestSnap(beats: number): number {
    const q = this.quantize();
    return Math.round(beats / q) * q;
  }

  /** After direct mutations of padEvents: persist, re-render, re-schedule. */
  private commitGridEdit(): void {
    store.update(() => {});
    this.rebuildLoopPartIfPlaying();
  }

  /**
   * Editable clip grid of pad events: one lane per loaded pad (or pad
   * with data), clips colored by pad. Click empty space = create a
   * 1-beat clip; drag = move (across lanes too); right edge = resize;
   * double-click = delete.
   */
  private buildEventGrid(): HTMLElement {
    const loopBeats = this.loopBeats();
    const grid = document.createElement('div');
    grid.className = 'event-grid';

    const rowPads: number[] = [];
    store.data.pads.forEach((pad, i) => {
      if (pad || this.loop().events.some((e) => e.pad === i)) rowPads.push(i);
    });
    if (rowPads.length === 0) {
      grid.classList.add('hidden');
      return grid;
    }

    const lanes = new Map<number, HTMLElement>();
    for (const padIndex of rowPads) {
      const pad = store.data.pads[padIndex];
      const color = pad?.color ?? '#4fd1c5';
      const row = document.createElement('div');
      row.className = 'event-row';
      const label = document.createElement('span');
      label.className = 'event-label';
      label.textContent = pad?.name ?? `Pad ${padIndex + 1}`;
      label.style.borderRightColor = color;
      row.appendChild(label);

      const lane = document.createElement('div');
      lane.className = 'event-lane';
      lane.title = 'Click: add a clip (quantize length) · drag: move · right edge: resize · double-click: delete';
      // beat + bar gridlines sized to the loop
      lane.style.backgroundImage =
        'linear-gradient(90deg, var(--text-dim) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)';
      lane.style.backgroundSize = `${100 / this.loop().bars}% 100%, ${100 / loopBeats}% 100%`;
      lane.onclick = (e): void => {
        if (e.target !== lane) return; // clicks on clips are handled there
        const q = this.quantize();
        const fraction = (e.clientX - lane.getBoundingClientRect().left) / lane.offsetWidth;
        const time = Math.min(loopBeats - q, Math.max(0, this.floorSnap(fraction * loopBeats)));
        // new clips are one quantize step long
        this.loop().events.push({ pad: padIndex, time, duration: q });
        this.commitGridEdit();
      };
      row.appendChild(lane);
      lanes.set(padIndex, lane);
      grid.appendChild(row);
    }

    for (const ev of this.loop().events) {
      const lane = lanes.get(ev.pad);
      if (lane) this.buildClip(ev, lane, lanes, loopBeats);
    }

    const playhead = document.createElement('div');
    playhead.className = 'event-playhead hidden';
    grid.appendChild(playhead);
    return grid;
  }

  /** Visible clip length in beats: explicit duration or the sample's natural length. */
  private clipBeats(ev: PadEvent, loopBeats: number): number {
    if (ev.duration !== undefined) return ev.duration;
    const pad = store.data.pads[ev.pad];
    const seconds = pad ? this.padSeconds(pad) : undefined;
    const natural = seconds !== undefined ? seconds / engine.secondsPerBeat() : 0.25;
    return Math.max(0.25, Math.min(natural, loopBeats - ev.time));
  }

  private buildClip(ev: PadEvent, lane: HTMLElement, lanes: Map<number, HTMLElement>, loopBeats: number): void {
    const pad = store.data.pads[ev.pad];
    const color = pad?.color ?? '#4fd1c5';
    const clip = document.createElement('div');
    clip.className = 'event-clip';
    clip.style.background = color;
    const place = (): void => {
      clip.style.left = `${(ev.time / loopBeats) * 100}%`;
      clip.style.width = `${(this.clipBeats(ev, loopBeats) / loopBeats) * 100}%`;
    };
    place();
    const handle = document.createElement('div');
    handle.className = 'event-clip-resize';
    clip.appendChild(handle);

    clip.ondblclick = (): void => {
      const idx = this.loop().events.indexOf(ev);
      if (idx >= 0) this.loop().events.splice(idx, 1);
      this.commitGridEdit();
    };

    clip.onpointerdown = (e): void => {
      // no preventDefault here — it would suppress the dblclick used for delete
      e.stopPropagation();
      const resizing = e.target === handle;
      const laneRect = lane.getBoundingClientRect();
      const beatsPerPx = loopBeats / lane.offsetWidth;
      const start = { x: e.clientX, y: e.clientY, time: ev.time, duration: this.clipBeats(ev, loopBeats), pad: ev.pad };
      let moved = false;
      clip.setPointerCapture(e.pointerId);
      clip.onpointermove = (m): void => {
        if (Math.abs(m.clientX - start.x) + Math.abs(m.clientY - start.y) < 3 && !moved) return;
        moved = true;
        const q = this.quantize();
        const deltaBeats = (m.clientX - start.x) * beatsPerPx;
        if (resizing) {
          ev.duration = Math.min(loopBeats - ev.time, Math.max(q, this.nearestSnap(start.duration + deltaBeats)));
        } else {
          // drag snaps DOWN to the quantize grid
          ev.time = Math.min(loopBeats - q, Math.max(0, this.floorSnap(start.time + deltaBeats)));
          // vertical drag moves the clip to another pad's lane
          for (const [padIndex, otherLane] of lanes) {
            const r = otherLane.getBoundingClientRect();
            if (m.clientY >= r.top && m.clientY <= r.bottom) {
              ev.pad = padIndex;
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
        if (moved) this.commitGridEdit();
      };
    };
    lane.appendChild(clip);
  }

  private async exportLoop(): Promise<void> {
    const spb = engine.secondsPerBeat();
    const seconds = this.loopBeats() * spb;
    const events = this.loop().events;
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
        let duration = pad.trimEnd > 0 ? Math.max(0.01, pad.trimEnd - pad.trimStart) : undefined;
        if (ev.duration !== undefined) {
          const cap = ev.duration * spb;
          duration = duration === undefined ? cap : Math.min(duration, cap);
        }
        src.start(ev.time * spb, pad.trimStart, duration);
      }
    }, seconds);
    const loop = this.loop();
    const base = loop.name.replace(/[^\w-]+/g, '_');
    download(`${base}.wav`, new Blob([encodeWav(rendered.get() as AudioBuffer)], { type: 'audio/wav' }));
    download(`${base}.json`, new Blob([JSON.stringify(this.serializeLoop(loop), null, 2)], { type: 'application/json' }));
    this.flash(`Downloaded ${base}.wav + ${base}.json`);
  }

  /** Portable sample definition: loop + the pad kit it uses (tone settings embedded). */
  private serializeLoop(loop: PadLoop): SampleFile {
    const padEntries: Record<string, SamplePadEntry> = {};
    for (const index of new Set(loop.events.map((e) => e.pad))) {
      const pad = store.data.pads[index];
      if (!pad) continue;
      const entry: SamplePadEntry = {
        name: pad.name,
        gain: pad.gain,
        trimStart: pad.trimStart,
        trimEnd: pad.trimEnd,
        color: pad.color,
      };
      if (pad.toneId) {
        const patch = store.data.patches.find((p) => p.id === pad.toneId);
        if (patch) {
          const { id, wavFile, ...settings } = patch;
          entry.tone = settings;
        }
      } else if (pad.file) {
        entry.file = pad.file;
      }
      padEntries[String(index)] = entry;
    }
    return { format: 'webdaw-sample', name: loop.name, bars: loop.bars, events: loop.events, pads: padEntries };
  }

  /** Import dropped .json samples; name clashes prompt overwrite-or-rename. */
  private async importSampleFiles(files: File[]): Promise<void> {
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith('.json')) continue;
      let parsed: Partial<SampleFile>;
      try {
        parsed = JSON.parse(await file.text()) as Partial<SampleFile>;
      } catch {
        this.flash(`${file.name}: not valid JSON`);
        continue;
      }
      if (!Array.isArray(parsed.events) || typeof parsed.bars !== 'number') {
        this.flash(`${file.name}: not a sample`);
        continue;
      }
      let name = (parsed.name ?? file.name.replace(/\.json$/i, '')).trim() || 'Sample';
      const existing = store.data.padLoops.find((l) => l.name.toLowerCase() === name.toLowerCase());
      let target: PadLoop | null = null;
      if (existing) {
        if (confirm(`A sample named "${name}" already exists.\nOK: overwrite it — Cancel: import under a new name`)) {
          target = existing;
        } else {
          const suggestion = uniqueName(name, store.data.padLoops.map((l) => l.name));
          const renamed = prompt('New sample name', suggestion);
          if (renamed === null) continue; // aborted
          name = uniqueName(renamed.trim() || suggestion, store.data.padLoops.map((l) => l.name));
        }
      }
      this.importPads(parsed.pads ?? {});
      store.update((d) => {
        if (target) {
          target.bars = parsed.bars!;
          target.events = parsed.events!;
        } else {
          target = { id: uid(), name, bars: parsed.bars!, events: parsed.events! };
          d.padLoops.push(target);
        }
      });
      this.selectLoop(target!.id);
      this.flash(`Imported "${target!.name}"`);
    }
    this.render();
    void this.ensureToneBuffers();
  }

  /** Restore the sample's pad kit into empty pad slots (occupied pads win). */
  private importPads(entries: Record<string, SamplePadEntry>): void {
    for (const [key, entry] of Object.entries(entries)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= PAD_COUNT) continue;
      if (store.data.pads[index]) continue;
      const pad: PadConfig = {
        name: entry.name ?? `Pad ${index + 1}`,
        gain: entry.gain ?? 1,
        trimStart: entry.trimStart ?? 0,
        trimEnd: entry.trimEnd ?? 0,
        color: entry.color,
      };
      if (entry.tone) {
        const patch: TonePatch = { ...defaultPatch(), ...entry.tone, id: uid() };
        delete patch.wavFile;
        patch.name = uniqueName(patch.name || pad.name, store.data.patches.map((p) => p.name));
        store.data.patches.push(patch);
        pad.toneId = patch.id;
      } else if (entry.file) {
        pad.file = entry.file;
      }
      store.data.pads[index] = pad;
    }
  }

  private editInSequencer(): void {
    const bars = this.loop().bars;
    const usedPads = [...new Set(this.loop().events.map((e) => e.pad))].sort((a, b) => a - b);
    const seqId = uid();
    store.update((d) => {
      d.sequences.push({
        id: seqId,
        name: uniqueName(this.loop().name, d.sequences.map((s) => s.name)),
        bars,
        tracks: usedPads.map((padIndex) => ({
          id: uid(),
          name: d.pads[padIndex]?.name ?? `Pad ${padIndex + 1}`,
          kind: 'audio' as const,
          gain: 1,
          source: { pad: padIndex },
          steps: [
            ...new Set(
              this.loop()
                .events.filter((e) => e.pad === padIndex)
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
    for (let b = 0; b < this.loop().bars; b++) {
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
    const loop = this.loop();
    const loopSel = document.createElement('select');
    loopSel.title = 'Switch sample';
    for (const l of store.data.padLoops) {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = l.name;
      opt.selected = l.id === loop.id;
      loopSel.appendChild(opt);
    }
    loopSel.onchange = (): void => {
      this.stopLoop();
      this.recording = false;
      this.selectLoop(loopSel.value);
      this.render();
    };

    const barsSel = document.createElement('select');
    for (const n of [1, 2, 4, 8]) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = `${n} bar${n > 1 ? 's' : ''}`;
      opt.selected = loop.bars === n;
      barsSel.appendChild(opt);
    }
    barsSel.onchange = (): void => {
      store.update(() => (loop.bars = Number(barsSel.value)));
    };
    const quantSel = document.createElement('select');
    quantSel.title = 'Quantize: recording rounds to the nearest step, grid edits snap down to it';
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
      opt.selected = uiState().sample.quantize === value;
      quantSel.appendChild(opt);
    }
    quantSel.onchange = (): void => {
      updateUi((s) => (s.sample.quantize = Number(quantSel.value)));
    };
    const quantWrap = document.createElement('label');
    quantWrap.className = 'hint check-toggle';
    quantWrap.append(document.createTextNode('Quantize '), quantSel);
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
    const exportBtn = document.createElement('button');
    exportBtn.className = 'export-btn';
    exportBtn.title = 'Download this sample as .wav + .json (drop the .json back in to import)';
    exportBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export';
    exportBtn.onclick = (): void => void this.exportLoop();

    bar.append(
      loopSel,
      btn('New', () => {
        const l: PadLoop = {
          id: uid(),
          name: uniqueName(`Loop ${store.data.padLoops.length + 1}`, store.data.padLoops.map((x) => x.name)),
          bars: 2,
          events: [],
        };
        store.update((d) => d.padLoops.push(l));
        this.selectLoop(l.id);
        this.render();
      }),
      btn('Rename', () => {
        const name = prompt('Sample name', loop.name);
        if (!name?.trim()) return;
        store.update(() => {
          loop.name = uniqueName(name.trim(), store.data.padLoops.filter((l) => l.id !== loop.id).map((l) => l.name));
        });
        this.render();
      }),
      btn('Delete', () => {
        this.stopLoop();
        this.recording = false;
        store.update((d) => (d.padLoops = d.padLoops.filter((l) => l.id !== loop.id)));
        this.selectLoop('');
        this.render();
      }),
      barsSel,
      quantWrap,
      check('Count-in', 'One bar of metronome clicks before recording starts', uiState().sample.countIn, (v) =>
        updateUi((s) => (s.sample.countIn = v)),
      ),
      check('Overdub', 'Keep recording every pass; unchecked stops recording after one pass', uiState().sample.overdub, (v) =>
        updateUi((s) => (s.sample.overdub = v)),
      ),
      btn(this.recording ? '⏺ Stop rec' : '⏺ Record', () => void this.toggleRecord(), this.recording ? 'recording' : ''),
      this.buildPlayToggle(),
      btn('Clear events', () => {
        store.update(() => (this.loop().events = []));
        this.updateStatus();
      }),
      exportBtn,
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
    if (el) el.textContent = `${this.loop().events.length} recorded hits`;
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
