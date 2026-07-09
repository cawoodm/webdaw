import * as Tone from '../../core/tone';
import { engine } from '../../core/audio-engine';
import { bus } from '../../core/event-bus';
import type { ArrangeClip, ArrangeTrack } from '../../core/model';
import { MAX_BARS, uid } from '../../core/model';
import { store } from '../../core/project-store';
import { uiState, updateUi } from '../../core/ui-state';
import { connectChain, PluginChainEl } from '../../plugins/chain';
import type { DawPlugin } from '../../plugins/api';
import { knob } from '../../ui/knob';
import { transportButton } from '../../ui/transport-buttons';
import {
  clipSpanBars,
  createOfflineProvider,
  resolveSong,
  scheduleSong,
  type NodeProvider,
  type SongPlaybackHandles,
} from './song-graph';
import { floorSnapBar, gridBackgroundBars, pickBarTick, PX_PER_BAR_STEPS, SNAP_BEATS, visibleBarRange } from './timeline-math';

const HEAD_W = 150;
const RULER_H = 22;

const ICONS = {
  mute: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/></svg>`,
  solo: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`,
  fx: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  zoomIn: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/></svg>`,
  zoomOut: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M8 11h6"/></svg>`,
};

export class ArrangeTab extends HTMLElement {
  private palette = '';
  private activeSong: SongPlaybackHandles | null = null;
  private liveTrackNodes = new Map<string, { inGain: Tone.Gain; chain: PluginChainEl }>();
  private ephemeralClipFx: DawPlugin[] = [];
  // ---- view state (rebuilt by render, consumed by the rAF loop) ----
  private rows = new Map<string, HTMLElement>();
  private clipEls = new Map<string, HTMLElement>();
  private selectedClipId: string | null = null;
  private viewDirty = true;

  connectedCallback(): void {
    this.className = 'tab-panel arrange-tab';
    bus.on('ui:loaded', () => {
      this.palette = uiState().arrange.palette;
      this.render();
    });
    bus.on('project:loaded', () => this.render());
    // absolute-time playback survives tab switches; yield when another
    // module claims playback
    bus.on('transport:claim', ({ owner }) => {
      if (owner !== 'arrange') this.stop();
    });
    bus.on('transport:join', () => this.stop());
    bus.on('transport:play', () => {
      if (this.classList.contains('active-tab')) void this.play();
    });
    bus.on('transport:stop', () => this.stop());
    document.addEventListener('keydown', (e) => this.onKeydown(e));
    const tick = (): void => {
      this.syncView();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    this.render();
  }

  // ---- prefs ----

  private pxPerBar(): number {
    return uiState().arrange.pxPerBar;
  }

  private snapBeats(): number {
    return uiState().arrange.snapBeats;
  }

  private songBarsCount(): number {
    return store.data.arrangement.bars;
  }

  private barSeconds(): number {
    return engine.secondsPerBeat() * 4;
  }

  // ---- audio graph (unchanged from Phase A) ----

  private trackBus(track: ArrangeTrack, songBus: Tone.ToneAudioNode): Tone.Gain {
    let nodes = this.liveTrackNodes.get(track.id);
    if (!nodes) {
      const inGain = new Tone.Gain(track.gain);
      const chain = document.createElement('plugin-chain') as PluginChainEl;
      chain.bind(inGain, songBus, track.plugins, () => store.scheduleSave());
      nodes = { inGain, chain };
      this.liveTrackNodes.set(track.id, nodes);
    }
    nodes.inGain.gain.value = track.gain; // refresh in case the knob changed it since last play
    return nodes.inGain;
  }

  private liveProvider(): NodeProvider {
    return {
      trackBus: (track, songBus) => this.trackBus(track, songBus),
      clipBus: (clip, trackBus) => {
        const g = new Tone.Gain(clip.gain);
        this.ephemeralClipFx.push(...connectChain(clip.plugins, g, trackBus));
        return g;
      },
    };
  }

  private async play(): Promise<void> {
    await engine.ensureStarted();
    this.stop();
    engine.claimTransport('arrange');
    const tracks = store.data.arrangement.tracks;
    const resolved = await resolveSong(tracks);
    this.activeSong = scheduleSong(tracks, resolved, {
      songBus: engine.master,
      startSeconds: Tone.now() + 0.15,
      barSeconds: this.barSeconds(),
      secondsPerStep: engine.secondsPerStep(),
      provider: this.liveProvider(),
    });
    engine.play();
  }

  private stop(): void {
    this.activeSong?.dispose();
    this.activeSong = null;
    for (const p of this.ephemeralClipFx) {
      p.output.disconnect();
      p.dispose();
    }
    this.ephemeralClipFx = [];
  }

  private async exportSong(): Promise<void> {
    const tracks = store.data.arrangement.tracks;
    const resolved = await resolveSong(tracks);
    const barSeconds = this.barSeconds();
    let endBar = 1;
    for (const t of tracks) for (const c of t.clips) endBar = Math.max(endBar, c.bar + clipSpanBars(c, barSeconds));
    const seconds = Math.min(endBar, MAX_BARS) * barSeconds + 1;
    const masterPlugins = store.data.arrangement.masterPlugins;

    const rendered = await Tone.Offline(() => {
      const dest = Tone.getDestination();
      const masterBus = new Tone.Gain(0.9);
      connectChain(masterPlugins, masterBus, dest);
      scheduleSong(tracks, resolved, {
        songBus: masterBus,
        startSeconds: 0,
        barSeconds,
        secondsPerStep: engine.secondsPerStep(),
        provider: createOfflineProvider(),
      });
    }, seconds);
    const path = `exports/${store.data.name.replace(/[^\w-]+/g, '_')}-song.wav`;
    const written = await store.saveWav(path, rendered.get() as AudioBuffer);
    this.flash(written ? `Exported ${path}` : `Rendered ${path} in memory — connect a project folder to write files`);
  }

  // ---- interactions (Tasks 5-7) ----

  private onKeydown(_e: KeyboardEvent): void {
    /* Task 6 */
  }

  private clipLabel(ref: ArrangeClip['ref']): string {
    if (ref.type === 'sequence') return store.data.sequences.find((s) => s.id === ref.id)?.name ?? '?';
    if (ref.type === 'pad') return store.data.pads[ref.index]?.name ?? '?';
    return ref.file.split('/').pop() ?? '?';
  }

  private buildClip(_track: ArrangeTrack, clip: ArrangeClip, _row: HTMLElement): HTMLElement {
    const el = document.createElement('div');
    el.className = `arrange-clip ${clip.ref.type === 'sequence' ? 'seq' : clip.ref.type}`;
    el.classList.toggle('selected', this.selectedClipId === clip.id);
    el.classList.toggle('has-fx', clip.plugins.length > 0);
    el.textContent = this.clipLabel(clip.ref);
    el.title = `${this.clipLabel(clip.ref)} — drag: move · double-click: FX · Delete: remove`;
    if (clip.ref.type !== 'sequence') {
      const handle = document.createElement('div');
      handle.className = 'clip-resize';
      handle.title = 'Drag to trim';
      el.appendChild(handle);
    }
    el.onclick = (e): void => {
      e.stopPropagation();
      this.selectClip(clip.id);
    };
    return el;
  }

  private selectClip(id: string | null): void {
    this.selectedClipId = id;
    for (const [cid, cel] of this.clipEls) cel.classList.toggle('selected', cid === id);
  }

  private openTrackFx(_track: ArrangeTrack): void {
    /* Task 7 */
  }

  // not yet called within this file — Task 6 wires it into a clip double-click.
  openClipFx(_track: ArrangeTrack, _clip: ArrangeClip): void {
    /* Task 7 */
  }

  // ---- rAF-driven view sync (ruler, virtualized clips, playhead) ----

  private syncView(): void {
    if (!this.isConnected) return;
    if (this.viewDirty) {
      this.viewDirty = false;
      this.drawRuler();
      this.syncClips();
    }
    this.updatePlayhead();
  }

  private drawRuler(): void {
    const canvas = this.querySelector<HTMLCanvasElement>('.arrange-ruler');
    const scroll = this.querySelector<HTMLElement>('.arrange-scroll');
    if (!canvas || !scroll) return;
    const w = Math.max(1, scroll.clientWidth - HEAD_W);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== RULER_H) canvas.height = RULER_H;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, w, RULER_H);
    const px = this.pxPerBar();
    const step = pickBarTick(px);
    const bars = this.songBarsCount();
    ctx.fillStyle = 'rgb(148 163 184 / 80%)';
    ctx.strokeStyle = 'rgb(148 163 184 / 50%)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const first = Math.max(0, Math.floor(scroll.scrollLeft / (step * px)) * step);
    for (let b = first; b <= bars; b += step) {
      const x = b * px - scroll.scrollLeft;
      if (x > w) break;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_H - 6);
      ctx.lineTo(x + 0.5, RULER_H);
      ctx.stroke();
      ctx.fillText(String(b + 1), x + 3, 4);
    }
  }

  private syncClips(): void {
    const scroll = this.querySelector<HTMLElement>('.arrange-scroll');
    if (!scroll) return;
    const px = this.pxPerBar();
    const barSeconds = this.barSeconds();
    const range = visibleBarRange(scroll.scrollLeft, scroll.clientWidth, px, this.songBarsCount());
    const wanted = new Set<string>();
    for (const track of store.data.arrangement.tracks) {
      const row = this.rows.get(track.id);
      if (!row) continue;
      for (const clip of track.clips) {
        const span = clipSpanBars(clip, barSeconds);
        if (clip.bar + span < range.from || clip.bar > range.to) continue;
        wanted.add(clip.id);
        let el = this.clipEls.get(clip.id);
        if (!el) {
          el = this.buildClip(track, clip, row);
          this.clipEls.set(clip.id, el);
          row.appendChild(el);
        }
        el.style.left = `${clip.bar * px}px`;
        el.style.width = `${Math.max(4, span * px)}px`;
      }
    }
    for (const [id, el] of this.clipEls) {
      if (wanted.has(id)) continue;
      el.remove();
      this.clipEls.delete(id);
    }
  }

  private updatePlayhead(): void {
    const playhead = this.querySelector<HTMLElement>('.arrange-playhead');
    const scroll = this.querySelector<HTMLElement>('.arrange-scroll');
    if (!playhead || !scroll) return;
    const active = engine.started && engine.playing && this.activeSong !== null;
    playhead.classList.toggle('hidden', !active);
    if (!active) return;
    const barsPos = engine.positionBeats / 4;
    const x = HEAD_W + barsPos * this.pxPerBar();
    playhead.style.left = `${x}px`;
    const viewWidth = scroll.clientWidth;
    const margin = viewWidth * 0.2;
    const vx = x - scroll.scrollLeft;
    if (vx < HEAD_W + margin) scroll.scrollLeft = Math.max(0, x - HEAD_W - margin);
    else if (vx > viewWidth - margin) scroll.scrollLeft = x - viewWidth + margin;
    this.viewDirty = true; // auto-scroll moves the window → ruler/clips refresh
  }

  // ---- render ----

  private render(): void {
    this.innerHTML = '';
    this.rows.clear();
    // innerHTML='' destroys any clip DOM tracked by clipEls (from a previous
    // render) — drop the stale references so syncClips() rebuilds them fresh.
    this.clipEls.clear();
    const arr = store.data.arrangement;
    const px = this.pxPerBar();
    const bars = this.songBarsCount();

    this.appendChild(this.buildToolbar());

    const scroll = document.createElement('div');
    scroll.className = 'arrange-scroll';
    scroll.addEventListener('scroll', () => (this.viewDirty = true));

    // sticky ruler row: corner (sticky left) + viewport-wide canvas (sticky left, redrawn on scroll)
    const rulerRow = document.createElement('div');
    rulerRow.className = 'arrange-ruler-row';
    rulerRow.style.width = `${HEAD_W + bars * px}px`;
    const corner = document.createElement('div');
    corner.className = 'arrange-corner';
    const ruler = document.createElement('canvas');
    ruler.className = 'arrange-ruler';
    ruler.title = 'Bars';
    rulerRow.append(corner, ruler);
    scroll.appendChild(rulerRow);

    const grid = gridBackgroundBars(px, this.snapBeats());
    const anySolo = arr.tracks.some((t) => t.solo && !t.muted);
    for (const track of arr.tracks) {
      scroll.appendChild(this.buildTrackRow(track, bars, px, grid, anySolo));
    }

    const playhead = document.createElement('div');
    playhead.className = 'arrange-playhead hidden';
    scroll.appendChild(playhead);

    this.appendChild(scroll);
    this.viewDirty = true;
  }

  private buildToolbar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'toolbar';
    const iconBtn = (title: string, svg: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.title = title;
      b.innerHTML = svg;
      b.onclick = fn;
      return b;
    };

    const palette = document.createElement('select');
    palette.title = 'Pick an item, then click a lane to place it';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— place… —';
    palette.appendChild(none);
    const group = (label: string): HTMLOptGroupElement => {
      const g = document.createElement('optgroup');
      g.label = label;
      palette.appendChild(g);
      return g;
    };
    const seqGroup = group('Sequences');
    for (const seq of store.data.sequences) {
      const opt = document.createElement('option');
      opt.value = `seq:${seq.id}`;
      opt.textContent = seq.name;
      opt.selected = this.palette === opt.value;
      seqGroup.appendChild(opt);
    }
    const padGroup = group('Pads');
    for (const [index, pad] of store.data.pads.entries()) {
      if (!pad) continue;
      const opt = document.createElement('option');
      opt.value = `pad:${index}`;
      opt.textContent = pad.name;
      opt.selected = this.palette === opt.value;
      padGroup.appendChild(opt);
    }
    const files = new Set<string>();
    for (const p of store.data.patches) if (p.wavFile) files.add(p.wavFile);
    for (const pad of store.data.pads) if (pad?.file) files.add(pad.file);
    const fileGroup = group('Files');
    for (const f of files) {
      const opt = document.createElement('option');
      opt.value = `file:${f}`;
      opt.textContent = f.split('/').pop() ?? f;
      opt.selected = this.palette === opt.value;
      fileGroup.appendChild(opt);
    }
    palette.onchange = (): void => {
      this.palette = palette.value;
      updateUi((s) => (s.arrange.palette = palette.value));
    };

    const snap = document.createElement('select');
    snap.title = 'Placing/moving/resizing snaps to this grid';
    for (const { beats, label } of SNAP_BEATS) {
      const opt = document.createElement('option');
      opt.value = String(beats);
      opt.textContent = label;
      opt.selected = this.snapBeats() === beats;
      snap.appendChild(opt);
    }
    snap.onchange = (): void => {
      updateUi((s) => (s.arrange.snapBeats = Number(snap.value)));
      this.render();
    };

    const lengthWrap = document.createElement('label');
    lengthWrap.className = 'arrange-length';
    lengthWrap.title = `Song length in bars (1–${MAX_BARS})`;
    lengthWrap.textContent = 'Bars ';
    const length = document.createElement('input');
    length.type = 'number';
    length.min = '1';
    length.max = String(MAX_BARS);
    length.value = String(this.songBarsCount());
    length.onchange = (): void => {
      const v = Math.max(1, Math.min(MAX_BARS, Math.round(Number(length.value) || 1)));
      store.update((d) => (d.arrangement.bars = v));
      this.render();
    };
    lengthWrap.appendChild(length);

    const zoom = (dir: 1 | -1): void => {
      const i = PX_PER_BAR_STEPS.indexOf(this.pxPerBar());
      const next = PX_PER_BAR_STEPS[Math.max(0, Math.min(PX_PER_BAR_STEPS.length - 1, (i < 0 ? 4 : i) + dir))];
      updateUi((s) => (s.arrange.pxPerBar = next));
      this.render();
    };

    const addTrack = document.createElement('button');
    addTrack.textContent = '+ Track';
    addTrack.title = 'Add a track';
    addTrack.onclick = (): void => {
      store.update((d) =>
        d.arrangement.tracks.push({
          id: uid(),
          name: `Track ${d.arrangement.tracks.length + 1}`,
          gain: 0.9,
          plugins: [],
          clips: [],
        }),
      );
      this.render();
    };

    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export song WAV';
    exportBtn.title = 'Render the whole song offline and write it to exports/';
    exportBtn.onclick = (): void => void this.exportSong();

    bar.append(
      transportButton('play', 'Play the song (Space)', () => void this.play()),
      transportButton('stop', 'Stop (Space)', () => {
        this.stop();
        if (engine.started) engine.stop();
      }),
      palette,
      snap,
      lengthWrap,
      iconBtn('Zoom out (fewer px per bar)', ICONS.zoomOut, () => zoom(-1)),
      iconBtn('Zoom in (more px per bar)', ICONS.zoomIn, () => zoom(1)),
      addTrack,
      exportBtn,
    );
    return bar;
  }

  private buildTrackRow(
    track: ArrangeTrack,
    bars: number,
    px: number,
    grid: { image: string; size: string },
    anySolo: boolean,
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'arrange-track';
    wrap.classList.toggle('muted', !!track.muted);
    wrap.classList.toggle('soloed', !!track.solo);
    wrap.classList.toggle('other-solo', anySolo && !track.solo && !track.muted);
    wrap.style.width = `${HEAD_W + bars * px}px`;

    const head = document.createElement('div');
    head.className = 'arrange-head';
    const name = document.createElement('span');
    name.className = 'arrange-track-name';
    name.textContent = track.name;
    name.title = 'Click to rename';
    name.onclick = (): void => {
      const next = prompt('Track name', track.name);
      if (!next) return;
      store.update(() => (track.name = next));
      this.render();
    };

    const iconBtn = (title: string, svg: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.title = title;
      b.innerHTML = svg;
      b.onclick = fn;
      return b;
    };
    const muteBtn = iconBtn('Mute track', ICONS.mute, () => {
      store.update(() => (track.muted = !track.muted));
      this.render();
    });
    muteBtn.classList.add('mute-btn');
    muteBtn.classList.toggle('active', !!track.muted);
    const soloBtn = iconBtn('Solo track — only soloed tracks play', ICONS.solo, () => {
      store.update(() => (track.solo = !track.solo));
      this.render();
    });
    soloBtn.classList.add('solo-btn');
    soloBtn.classList.toggle('active', !!track.solo);
    const fxBtn = iconBtn('Track effects', ICONS.fx, () => {
      void engine.ensureStarted().then(() => this.openTrackFx(track));
    });
    fxBtn.classList.add('fx-btn');
    fxBtn.classList.toggle('has-fx', track.plugins.length > 0);
    const dupBtn = iconBtn('Duplicate track', ICONS.copy, () => {
      store.update((d) => {
        const copy: ArrangeTrack = JSON.parse(JSON.stringify(track)) as ArrangeTrack;
        copy.id = uid();
        copy.name = `${track.name} copy`;
        for (const p of copy.plugins) p.id = uid();
        for (const c of copy.clips) {
          c.id = uid();
          for (const p of c.plugins) p.id = uid();
        }
        d.arrangement.tracks.splice(d.arrangement.tracks.indexOf(track) + 1, 0, copy);
      });
      this.render();
    });
    const delBtn = iconBtn('Remove track', '✕', () => {
      this.liveTrackNodes.get(track.id)?.chain.teardown();
      this.liveTrackNodes.delete(track.id);
      store.update((d) => {
        d.arrangement.tracks = d.arrangement.tracks.filter((t) => t.id !== track.id);
      });
      this.render();
    });

    const controls = document.createElement('div');
    controls.className = 'arrange-head-controls';
    controls.append(
      muteBtn,
      soloBtn,
      fxBtn,
      knob({ label: 'Gain', min: 0, max: 1.2, step: 0.01, value: track.gain }, (v) => {
        track.gain = v;
        const nodes = this.liveTrackNodes.get(track.id);
        if (nodes) nodes.inGain.gain.value = v;
        store.scheduleSave();
      }),
      dupBtn,
      delBtn,
    );
    head.append(name, controls);

    const row = document.createElement('div');
    row.className = 'arrange-row';
    row.style.width = `${bars * px}px`;
    row.style.backgroundImage = grid.image;
    row.style.backgroundSize = grid.size;
    row.title = 'Click: place the palette item · drag a clip: move · right edge: resize · double-click: clip FX · Delete: remove selected';
    this.rows.set(track.id, row);
    row.onclick = (e): void => {
      if (e.target !== row || !this.palette) return;
      const bar = floorSnapBar((e.clientX - row.getBoundingClientRect().left) / px, this.snapBeats());
      if (bar >= bars) return;
      const ref = this.palette.startsWith('seq:')
        ? { type: 'sequence' as const, id: this.palette.slice(4) }
        : this.palette.startsWith('pad:')
          ? { type: 'pad' as const, index: Number(this.palette.slice(4)) }
          : { type: 'file' as const, file: this.palette.slice(5) };
      store.update(() => track.clips.push({ id: uid(), bar, ref, gain: 1, plugins: [] }));
      this.viewDirty = true;
    };

    wrap.append(head, row);
    return wrap;
  }

  private flash(msg: string): void {
    const el = document.createElement('div');
    el.className = 'flash';
    el.textContent = msg;
    this.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }
}

customElements.define('arrange-tab', ArrangeTab);
