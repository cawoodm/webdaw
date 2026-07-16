import * as Tone from '../../core/tone';
import { engine } from '../../core/audio-engine';
import { bus } from '../../core/event-bus';
import type { ArrangeClip, ArrangeTrack, ClipLoopMode, ProjectData } from '../../core/model';
import { MAX_BARS, uid } from '../../core/model';
import { projects } from '../../core/project-manager';
import { store } from '../../core/project-store';
import { encodeWav } from '../../core/wav';
import { SnapshotHistory } from '../../core/history';
import { uiState, updateUi } from '../../core/ui-state';
import { connectChain, PluginChainEl } from '../../plugins/chain';
import type { DawPlugin } from '../../plugins/api';
import { knob } from '../../ui/knob';
import { dialogTitlebar } from '../../ui/dialog-titlebar';
import { makeDialogDraggable } from '../../ui/draggable-dialog';
import { transportButton } from '../../ui/transport-buttons';
import {
  clipSpanBars,
  createOfflineProvider,
  resolveSong,
  scheduleSong,
  type NodeProvider,
  type ResolvedSong,
  type SongPlaybackHandles,
} from './song-graph';
import {
  floorSnapBar,
  gridBackgroundBars,
  minSpanBars,
  nearestSnapBar,
  pickBarTick,
  PX_PER_BAR_STEPS,
  SNAP_BEATS,
  visibleBarRange,
} from './timeline-math';

const HEAD_W = 180;
const RULER_H = 22;

const ICONS = {
  mute: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/></svg>`,
  solo: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`,
  fx: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  zoomIn: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/></svg>`,
  zoomOut: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M8 11h6"/></svg>`,
  loop: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>`,
  toStart: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="2" height="14"/><path d="M19 5 9 12l10 7z"/></svg>`,
  stepBack: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>`,
  stepForward: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>`,
  download: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
};

/** Trigger a browser download of a generated file. */
function download(filename: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export class ArrangeTab extends HTMLElement {
  private palette = '';
  private sampleFiles: { path: string; source: 'project' | 'global' }[] = [];
  private samplesScanned = false;
  private activeSong: SongPlaybackHandles | null = null;
  /** Live cycle handles with the audio-clock second their content ends (loop scheduling). */
  private songCycles: { handle: SongPlaybackHandles; until: number }[] = [];
  private loopTimer: number | null = null;
  // playhead anchor: the current cycle's start, rolled forward at each loop-back
  private cycleStartBeats = 0;
  private cycleFromBar = 0;
  /** Beats in the current cycle; 0 = playback doesn't loop (no clips, or cursor past the end). */
  private cycleLenBeats = 0;
  // where the playhead lands after a loop-back, and how long those cycles are
  private wrapFromBar = 0;
  private wrapLenBeats = 0;
  /** Clip-loop toggle: the selected clip plays solo on repeat. */
  private clipLoopOn = false;
  private loopBtn: HTMLButtonElement | null = null;
  private liveTrackNodes = new Map<string, { inGain: Tone.Gain; chain: PluginChainEl }>();
  private ephemeralClipFx: DawPlugin[] = [];
  // ---- view state (rebuilt by render, consumed by the rAF loop) ----
  private rows = new Map<string, HTMLElement>();
  private clipEls = new Map<string, HTMLElement>();
  private selectedClipId: string | null = null;
  private viewDirty = true;
  // ---- undo/redo ----
  private history = new SnapshotHistory<ProjectData['arrangement']>();
  private historyTimer: number | undefined;
  private undoBtn: HTMLButtonElement | null = null;
  private redoBtn: HTMLButtonElement | null = null;
  private static readonly HISTORY_KEY = 'arrangement';

  connectedCallback(): void {
    this.className = 'tab-panel arrange-tab';
    bus.on('ui:loaded', () => {
      this.palette = uiState().arrange.palette;
      this.render();
    });
    bus.on('project:loaded', () => {
      this.closeAllFxDialogs(); // dialogs reference the previous project's tracks/clips
      this.history.seed(ArrangeTab.HISTORY_KEY, store.data.arrangement);
      this.samplesScanned = false;
      void this.refreshSamples();
      this.render();
    });
    bus.on('tab:activate', (tab) => {
      if (tab === 'arrange') void this.refreshSamples();
    });
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

  /** Rescan samples/ (project) and _samples/ (root) for the palette; re-renders only when the list actually changed. */
  private async refreshSamples(): Promise<void> {
    const next = await projects.listSamples();
    const changed = JSON.stringify(next) !== JSON.stringify(this.sampleFiles);
    const firstScan = !this.samplesScanned;
    this.samplesScanned = true;
    if (changed || firstScan) {
      this.sampleFiles = next;
      this.render();
    }
  }

  // ---- undo/redo ----

  /** Debounced history commit: 500ms of no further arrange edits = one undo step. */
  private scheduleHistoryCommit(): void {
    clearTimeout(this.historyTimer);
    this.historyTimer = window.setTimeout(() => this.flushHistoryCommit(), 500);
  }

  /** Commit any pending edit immediately (before undo/redo read the stack). */
  private flushHistoryCommit(): void {
    if (this.historyTimer === undefined) return;
    clearTimeout(this.historyTimer);
    this.historyTimer = undefined;
    this.history.commit(ArrangeTab.HISTORY_KEY, store.data.arrangement);
    this.refreshHistoryButtons();
  }

  /** Sync Undo/Redo disabled state without a full re-render. */
  private refreshHistoryButtons(): void {
    if (this.undoBtn) this.undoBtn.disabled = !this.history.canUndo(ArrangeTab.HISTORY_KEY);
    if (this.redoBtn) this.redoBtn.disabled = !this.history.canRedo(ArrangeTab.HISTORY_KEY);
  }

  private undoArrange(): void {
    this.flushHistoryCommit();
    const restored = this.history.undo(ArrangeTab.HISTORY_KEY);
    if (!restored) return;
    store.update((d) => {
      d.arrangement = restored;
    });
    this.render();
  }

  private redoArrange(): void {
    this.flushHistoryCommit();
    const restored = this.history.redo(ArrangeTab.HISTORY_KEY);
    if (!restored) return;
    store.update((d) => {
      d.arrangement = restored;
    });
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

  private cursorBar(): number {
    return uiState().arrange.cursorBar;
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
      chain.bind(inGain, songBus, track.plugins, () => {
        store.scheduleSave();
        this.scheduleHistoryCommit();
      }, { renderSource: () => this.renderTrackSource(track) });
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
    const fromBar = this.cursorBar();
    const barSeconds = this.barSeconds();
    let endBar = 0;
    for (const t of tracks) for (const c of t.clips) endBar = Math.max(endBar, c.bar + clipSpanBars(c, barSeconds));
    const startSeconds = Tone.now() + 0.15;
    this.activeSong = scheduleSong(tracks, resolved, {
      songBus: engine.master,
      startSeconds,
      barSeconds,
      secondsPerStep: engine.secondsPerStep(),
      provider: this.liveProvider(),
      fromBar,
    });
    const cycle0End = startSeconds + (endBar - fromBar) * barSeconds;
    this.cycleStartBeats = 0;
    this.cycleFromBar = fromBar;
    this.wrapFromBar = 0;
    this.wrapLenBeats = endBar * 4;
    // the song always loops back to bar 0 when the last clip ends
    this.cycleLenBeats = endBar > fromBar + 1e-9 ? (endBar - fromBar) * 4 : 0;
    this.songCycles = [{ handle: this.activeSong, until: this.cycleLenBeats > 0 ? cycle0End : Infinity }];
    if (this.cycleLenBeats > 0) this.chainNextCycle(tracks, resolved, cycle0End, 0, endBar);
    engine.play();
  }

  /**
   * Keep upcoming loop cycles ([fromBar, fromBar+cycleBars)) scheduled at
   * their exact absolute start times — gapless, no drift. A 3s horizon is
   * committed ahead because hidden browser tabs clamp setTimeout to >=1s; a
   * cycle is disposed only 1s after its content ends so tails ring out.
   */
  private chainNextCycle(
    tracks: ArrangeTrack[],
    resolved: ResolvedSong,
    cycleStartSeconds: number,
    fromBar: number,
    cycleBars: number,
  ): void {
    const HORIZON = 3;
    this.loopTimer = window.setTimeout(() => {
      this.loopTimer = null;
      if (this.songCycles.length === 0) return; // stopped in the meantime
      const barSeconds = this.barSeconds();
      const cycleSeconds = cycleBars * barSeconds;
      let next = cycleStartSeconds;
      while (next < Tone.now() + HORIZON) {
        const handle = scheduleSong(tracks, resolved, {
          songBus: engine.master,
          startSeconds: next,
          barSeconds,
          secondsPerStep: engine.secondsPerStep(),
          provider: this.liveProvider(),
          fromBar,
        });
        this.songCycles.push({ handle, until: next + cycleSeconds });
        this.activeSong = handle;
        next += cycleSeconds;
      }
      const cutoff = Tone.now() - 1;
      for (const c of this.songCycles) if (c.until < cutoff) c.handle.dispose();
      this.songCycles = this.songCycles.filter((c) => c.until >= cutoff);
      this.chainNextCycle(tracks, resolved, next, fromBar, cycleBars);
    }, Math.max(0, (cycleStartSeconds - HORIZON - Tone.now()) * 1000));
  }

  /** Bars into the song for the moving playhead, rolling the anchor forward at each loop-back. */
  private playheadBar(): number {
    let beats = engine.positionBeats - this.cycleStartBeats;
    while (this.cycleLenBeats > 0 && beats >= this.cycleLenBeats) {
      this.cycleStartBeats += this.cycleLenBeats;
      this.cycleFromBar = this.wrapFromBar;
      this.cycleLenBeats = this.wrapLenBeats;
      beats = engine.positionBeats - this.cycleStartBeats;
    }
    return this.cycleFromBar + beats / 4;
  }

  /** Toggle solo-looping of the selected clip (the blue loop button). */
  private async toggleClipLoop(): Promise<void> {
    if (this.clipLoopOn) {
      this.stop();
      if (engine.started) engine.stop();
      return;
    }
    await this.startClipLoop();
  }

  private findSelectedClip(): { track: ArrangeTrack; clip: ArrangeClip } | null {
    if (!this.selectedClipId) return null;
    for (const track of store.data.arrangement.tracks) {
      const clip = track.clips.find((c) => c.id === this.selectedClipId);
      if (clip) return { track, clip };
    }
    return null;
  }

  /** Play the selected clip solo (through its clip + track FX), looping from its start. */
  private async startClipLoop(): Promise<void> {
    const sel = this.findSelectedClip();
    if (!sel) {
      this.flash('Select a clip to loop');
      return;
    }
    await engine.ensureStarted();
    this.stop();
    engine.claimTransport('arrange');
    const { track, clip } = sel;
    const soloTracks: ArrangeTrack[] = [{ ...track, muted: false, solo: false, clips: [clip] }];
    const resolved = await resolveSong(soloTracks);
    const barSeconds = this.barSeconds();
    const span = clipSpanBars(clip, barSeconds);
    const startSeconds = Tone.now() + 0.15;
    this.activeSong = scheduleSong(soloTracks, resolved, {
      songBus: engine.master,
      startSeconds,
      barSeconds,
      secondsPerStep: engine.secondsPerStep(),
      provider: this.liveProvider(),
      fromBar: clip.bar,
    });
    this.songCycles = [{ handle: this.activeSong, until: startSeconds + span * barSeconds }];
    this.cycleStartBeats = 0;
    this.cycleFromBar = clip.bar;
    this.cycleLenBeats = span * 4;
    this.wrapFromBar = clip.bar;
    this.wrapLenBeats = span * 4;
    this.chainNextCycle(soloTracks, resolved, startSeconds + span * barSeconds, clip.bar, span);
    this.clipLoopOn = true;
    this.loopBtn?.classList.add('loop-on');
    engine.play();
  }

  /** True while this tab's song is actually sounding — the moving playhead only applies then. */
  private transportActive(): boolean {
    return engine.started && engine.playing && this.activeSong !== null;
  }

  /** Restart playback from the cursor's current value — used by every cursor-moving action while playing. */
  private restartIfPlaying(): void {
    if (!this.transportActive()) return;
    this.stop();
    if (engine.started) engine.stop();
    void this.play();
  }

  /** Move the play cursor, persist it, and restart playback from there if currently playing. */
  private setCursor(bar: number): void {
    const clamped = Math.max(0, Math.min(this.songBarsCount(), bar));
    updateUi((s) => (s.arrange.cursorBar = clamped));
    this.viewDirty = true;
    this.restartIfPlaying();
  }

  /** The bar to step from: the live playhead while playing, else the parked cursor. */
  private currentBar(): number {
    return this.transportActive() ? this.playheadBar() : this.cursorBar();
  }

  private toStart(): void {
    this.setCursor(0);
  }

  private stepBack(): void {
    this.setCursor(Math.max(0, Math.floor(this.currentBar() - 1)));
  }

  private stepForward(): void {
    const bars = this.songBarsCount();
    this.setCursor(Math.min(Math.max(0, bars - 1), Math.floor(this.currentBar()) + 1));
  }

  private onRulerClick(e: MouseEvent): void {
    const scroll = this.querySelector<HTMLElement>('.arrange-scroll');
    if (!scroll) return;
    const px = this.pxPerBar();
    const bar = (e.offsetX + scroll.scrollLeft) / px;
    const snapped = floorSnapBar(bar, this.snapBeats());
    this.setCursor(Math.max(0, Math.min(this.songBarsCount() - 1e-9, snapped)));
  }

  private stop(): void {
    this.clipLoopOn = false;
    this.loopBtn?.classList.remove('loop-on');
    if (this.loopTimer !== null) {
      window.clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    for (const c of this.songCycles) c.handle.dispose();
    this.songCycles = [];
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
    const base = store.data.name.replace(/[^\w-]+/g, '_');
    const path = `exports/${base}-song.wav`;
    const buffer = rendered.get() as AudioBuffer;
    const written = await store.saveWav(path, buffer);
    const filename = `${base}-song.wav`;
    download(filename, new Blob([encodeWav(buffer)], { type: 'audio/wav' }));
    this.flash(`Downloaded ${filename}${written ? ` and wrote ${path}` : ' — connect a project folder to also write exports/'}`);
  }

  // ---- interactions (Tasks 5-7) ----

  private onKeydown(e: KeyboardEvent): void {
    if (!this.classList.contains('active-tab')) return;
    const target = e.target as HTMLElement;
    const isTextInput = target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      if (isTextInput) return;
      e.preventDefault();
      if (e.shiftKey) this.redoArrange();
      else this.undoArrange();
      return;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (isTextInput) return;
    const id = this.selectedClipId;
    if (!id) return;
    e.preventDefault();
    store.update((d) => {
      for (const t of d.arrangement.tracks) {
        const i = t.clips.findIndex((c) => c.id === id);
        if (i >= 0) t.clips.splice(i, 1);
      }
    });
    this.scheduleHistoryCommit();
    this.selectedClipId = null;
    this.clipEls.get(id)?.remove();
    this.clipEls.delete(id);
    this.viewDirty = true;
  }

  private clipLabel(ref: ArrangeClip['ref']): string {
    if (ref.type === 'sequence') return store.data.sequences.find((s) => s.id === ref.id)?.name ?? '?';
    if (ref.type === 'pad') return store.data.pads[ref.index]?.name ?? '?';
    if (ref.type === 'loop') return store.data.padLoops.find((l) => l.id === ref.id)?.name ?? '?';
    return ref.file.split('/').pop() ?? '?';
  }

  private buildClip(track: ArrangeTrack, clip: ArrangeClip, row: HTMLElement): HTMLElement {
    const el = document.createElement('div');
    el.className = `arrange-clip ${clip.ref.type === 'sequence' ? 'seq' : clip.ref.type}`;
    el.classList.toggle('selected', this.selectedClipId === clip.id);
    el.classList.toggle('has-fx', clip.plugins.length > 0);
    el.textContent = this.clipLabel(clip.ref);
    el.title = `${this.clipLabel(clip.ref)} — drag: move · double-click: remove · right-click: FX · Delete: remove selected`;
    const handle = document.createElement('div');
    handle.className = 'clip-resize';
    handle.title = 'Drag to resize — a clip stretched past its length repeats';
    el.appendChild(handle);
    const handleL = document.createElement('div');
    handleL.className = 'clip-resize-l';
    handleL.title = 'Drag to resize from the start — the clip end stays put';
    el.appendChild(handleL);
    el.appendChild(this.buildClipActions(track, clip, el));
    this.attachClipPointer(track, clip, el, row);
    return el;
  }

  private buildClipActions(track: ArrangeTrack, clip: ArrangeClip, el: HTMLElement): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'clip-actions';
    // don't let the icons start a clip drag or clear the selection
    actions.onpointerdown = (e): void => e.stopPropagation();
    actions.ondblclick = (e): void => e.stopPropagation();
    const btn = (title: string, svg: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.title = title;
      b.innerHTML = svg;
      b.onclick = (e): void => {
        e.stopPropagation();
        fn();
      };
      return b;
    };
    actions.append(
      btn('Clip effects (right-click)', ICONS.fx, () => this.openClipFx(track, clip)),
      btn('Duplicate the clip to its right', ICONS.copy, () => this.duplicateClip(track, clip)),
      btn('Delete the clip (double-click / Delete)', ICONS.trash, () => this.deleteClip(track, clip, el)),
    );
    return actions;
  }

  private duplicateClip(track: ArrangeTrack, clip: ArrangeClip): void {
    const span = clipSpanBars(clip, this.barSeconds());
    const copy: ArrangeClip = structuredClone(clip);
    copy.id = uid();
    copy.plugins = copy.plugins.map((p) => ({ ...p, id: uid() }));
    copy.bar = Math.max(0, Math.min(this.songBarsCount() - span, clip.bar + span));
    store.update(() => track.clips.push(copy));
    this.scheduleHistoryCommit();
    this.viewDirty = true; // syncClips builds the new clip's DOM
  }

  private deleteClip(track: ArrangeTrack, clip: ArrangeClip, el: HTMLElement): void {
    this.fxDialogs.get(`clip:${clip.id}`)?.close();
    store.update(() => {
      const i = track.clips.indexOf(clip);
      if (i >= 0) track.clips.splice(i, 1);
    });
    this.scheduleHistoryCommit();
    if (this.selectedClipId === clip.id) {
      this.selectedClipId = null;
      if (this.clipLoopOn) {
        this.stop(); // the looped clip is gone
        if (engine.started) engine.stop();
      }
    }
    el.remove();
    this.clipEls.delete(clip.id);
    this.viewDirty = true;
  }

  private attachClipPointer(track: ArrangeTrack, clip: ArrangeClip, el: HTMLElement, row: HTMLElement): void {
    el.ondblclick = (): void => this.deleteClip(track, clip, el);
    el.oncontextmenu = (e): void => {
      e.preventDefault();
      this.openClipFx(track, clip);
    };
    el.onpointerdown = (e): void => {
      e.stopPropagation();
      const resizing = e.target === el.querySelector('.clip-resize');
      const resizingLeft = e.target === el.querySelector('.clip-resize-l');
      const px = this.pxPerBar();
      const snap = this.snapBeats();
      const barSeconds = this.barSeconds();
      const startSpan = clipSpanBars(clip, barSeconds);
      const start = { x: e.clientX, y: e.clientY, bar: clip.bar, span: startSpan };
      const bars = this.songBarsCount();
      let moved = false;
      let targetTrack = track;
      const origBars = clip.bars;
      el.onpointercancel = (): void => {
        el.onpointermove = null;
        el.onpointerup = null;
        el.onpointercancel = null;
        el.style.transform = '';
        clip.bar = start.bar;
        clip.bars = origBars;
        el.style.left = `${clip.bar * px}px`;
        el.style.width = `${Math.max(4, clipSpanBars(clip, barSeconds) * px)}px`;
      };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic or already-released pointer — moves still bubble to el */
      }
      el.onpointermove = (m): void => {
        if (!moved && Math.abs(m.clientX - start.x) + Math.abs(m.clientY - start.y) < 4) return;
        moved = true;
        const deltaBars = (m.clientX - start.x) / px;
        if (resizing) {
          const span = Math.max(minSpanBars(snap), nearestSnapBar(start.span + deltaBars, snap));
          clip.bars = Math.min(bars - clip.bar, span);
          el.style.width = `${Math.max(4, clip.bars * px)}px`;
        } else if (resizingLeft) {
          // the end stays put; the start moves
          const end = start.bar + start.span;
          const newBar = Math.max(0, Math.min(end - minSpanBars(snap), nearestSnapBar(start.bar + deltaBars, snap)));
          clip.bar = newBar;
          clip.bars = end - newBar;
          el.style.left = `${clip.bar * px}px`;
          el.style.width = `${Math.max(4, clip.bars * px)}px`;
        } else {
          clip.bar = Math.max(0, Math.min(bars - startSpan, floorSnapBar(start.bar + deltaBars, snap)));
          el.style.left = `${clip.bar * px}px`;
          const rowRect = row.getBoundingClientRect();
          for (const [tid, otherRow] of this.rows) {
            const r = otherRow.getBoundingClientRect();
            if (m.clientY >= r.top && m.clientY <= r.bottom) {
              targetTrack = store.data.arrangement.tracks.find((t) => t.id === tid) ?? track;
              el.style.transform = `translateY(${r.top - rowRect.top}px)`;
              break;
            }
          }
        }
      };
      el.onpointerup = (): void => {
        el.onpointermove = null;
        el.onpointerup = null;
        el.onpointercancel = null;
        el.style.transform = '';
        if (!moved) {
          this.selectClip(clip.id);
          return;
        }
        store.update(() => {
          if (targetTrack !== track) {
            track.clips.splice(track.clips.indexOf(clip), 1);
            targetTrack.clips.push(clip);
          }
        });
        this.scheduleHistoryCommit();
        this.render(); // re-parents the clip element into the target row + refreshes maps
        // playback keeps running through edits — the next loop cycle reads the
        // updated clips. Only an active clip-loop of THIS clip must restart,
        // because its cycle anchor (fromBar) was captured from the old position.
        if (this.clipLoopOn && this.selectedClipId === clip.id) void this.startClipLoop();
      };
    };
  }

  private selectClip(id: string | null): void {
    const changed = id !== this.selectedClipId;
    this.selectedClipId = id;
    for (const [cid, cel] of this.clipEls) cel.classList.toggle('selected', cid === id);
    // while the loop toggle is on, selecting another clip moves the loop to it
    if (this.clipLoopOn && changed && id) void this.startClipLoop();
  }

  /** One FX dialog per target so chains can be compared side by side. Keys: `track:<id>` / `clip:<id>`. */
  private fxDialogs = new Map<string, HTMLDialogElement>();

  /**
   * Create a new FX dialog for `key` (title bar, drag, cascade position).
   * `teardown` runs when it closes; the dialog element is removed and the
   * timeline re-rendered (has-fx dots).
   */
  private buildFxDialog(key: string, titleText: string, teardown: () => void): { dialog: HTMLDialogElement; extra: HTMLElement; slot: HTMLElement } {
    const dialog = document.createElement('dialog');
    dialog.className = 'fx-dialog';
    const h = document.createElement('h3');
    h.className = 'fx-title';
    h.textContent = titleText;
    const bar = dialogTitlebar(h, dialog);
    const extra = document.createElement('div');
    extra.className = 'fx-extra';
    const slot = document.createElement('div');
    slot.className = 'fx-slot';
    dialog.append(bar, extra, slot);
    // cascade so simultaneous dialogs don't cover each other
    const n = this.fxDialogs.size % 8;
    dialog.style.top = `calc(15vh + ${n * 32}px)`;
    dialog.style.left = `calc(50% + ${n * 32}px)`;
    makeDialogDraggable(dialog, bar);
    dialog.onclose = (): void => {
      this.fxDialogs.delete(key);
      teardown();
      dialog.remove();
      this.render(); // refresh has-fx dots
    };
    this.fxDialogs.set(key, dialog);
    this.appendChild(dialog);
    return { dialog, extra, slot };
  }

  /** Re-focus an already-open dialog for this target; true if one existed. */
  private focusFxDialog(key: string): boolean {
    const dialog = this.fxDialogs.get(key);
    if (!dialog) return false;
    dialog.classList.remove('collapsed');
    this.appendChild(dialog); // last sibling paints on top
    return true;
  }

  private closeAllFxDialogs(): void {
    for (const dialog of [...this.fxDialogs.values()]) dialog.close();
  }

  /**
   * Offline-render a synthetic solo track (max 30s) — the pre-FX "source"
   * plugin UIs visualize. Resolved in the LIVE context first, then one
   * Tone.Offline (never nested), serialized via runExclusive.
   */
  private async renderFxSource(srcTrack: ArrangeTrack): Promise<AudioBuffer | null> {
    const barSeconds = this.barSeconds();
    const endBar = srcTrack.clips.reduce((m, c) => Math.max(m, c.bar + clipSpanBars(c, barSeconds)), 0);
    if (endBar <= 0) return null;
    const resolved = await resolveSong([srcTrack]);
    const seconds = Math.min(30, endBar * barSeconds + 0.5);
    return engine.runExclusive(async () => {
      const rendered = await Tone.Offline(() => {
        scheduleSong([srcTrack], resolved, {
          songBus: Tone.getDestination(),
          startSeconds: 0,
          barSeconds,
          secondsPerStep: engine.secondsPerStep(),
          provider: createOfflineProvider(),
        });
      }, seconds);
      return rendered.get() as AudioBuffer;
    });
  }

  /** Pre-track-FX source: the track's clips (with their own gain/FX), shifted to start at 0. */
  private renderTrackSource(track: ArrangeTrack): Promise<AudioBuffer | null> {
    if (track.clips.length === 0) return Promise.resolve(null);
    const minBar = Math.min(...track.clips.map((c) => c.bar));
    return this.renderFxSource({
      ...track,
      gain: 1,
      muted: false,
      solo: false,
      plugins: [],
      clips: track.clips.map((c) => ({ ...c, bar: c.bar - minBar })),
    });
  }

  private openTrackFx(track: ArrangeTrack): void {
    // runExclusive: see openClipFx — live nodes can't be built mid-offline-render
    void engine.runExclusive(async () => {
      if (this.focusFxDialog(`track:${track.id}`)) return;
      // a track's chain element stays alive when its dialog closes (audio keeps
      // running) — closing only unmounts the DOM, so teardown is a no-op
      const { dialog, slot } = this.buildFxDialog(`track:${track.id}`, `${track.name} — track FX`, () => {});
      this.trackBus(track, engine.master); // ensure the live chain exists
      slot.appendChild(this.liveTrackNodes.get(track.id)!.chain);
      dialog.show();
    });
  }

  private openClipFx(track: ArrangeTrack, clip: ArrangeClip): void {
    // runExclusive: the live Gain/chain must not be constructed while a
    // Tone.Offline render (e.g. boot-time patch renders right after the first
    // gesture) has swapped the global context — nodes would bind to the wrong
    // context and connect() throws.
    void engine.ensureStarted().then(() =>
      engine.runExclusive(async () => {
      if (this.focusFxDialog(`clip:${clip.id}`)) return;
      // throwaway audio pair: the chain edits clip.plugins in place; audible on the clip's next play
      const inGain = new Tone.Gain(0).connect(engine.master);
      const chain = document.createElement('plugin-chain') as PluginChainEl;
      const { dialog, extra, slot } = this.buildFxDialog(
        `clip:${clip.id}`,
        `${this.clipLabel(clip.ref)} (${track.name}) — clip FX`,
        () => {
          chain.teardown();
          inGain.dispose();
        },
      );
      extra.appendChild(
        knob({ label: 'Clip gain', min: 0, max: 1.5, step: 0.01, value: clip.gain }, (v) => {
          clip.gain = v;
          store.scheduleSave();
          this.scheduleHistoryCommit();
        }),
      );
      if (clip.ref.type === 'file' || clip.ref.type === 'pad') {
        const label = document.createElement('label');
        label.className = 'fx-repeat';
        label.title = "Repeat mode when the clip is stretched past the sample's length";
        label.append('Repeat ');
        const sel = document.createElement('select');
        sel.append(
          new Option('Back-to-back', 'gapless'),
          new Option('Bar-aligned', 'bar'),
          new Option('Re-sample', 'resample'),
        );
        sel.value = clip.loopMode ?? 'gapless';
        sel.onchange = (): void => {
          clip.loopMode = sel.value as ClipLoopMode;
          store.scheduleSave();
          this.scheduleHistoryCommit();
        };
        label.appendChild(sel);
        extra.appendChild(label);
      }
      // pre-FX source for plugin UIs: the clip alone, at bar 0, without its gain/FX
      const renderSource = (): Promise<AudioBuffer | null> =>
        this.renderFxSource({
          id: 'fx-src',
          name: 'fx-src',
          gain: 1,
          plugins: [],
          clips: [{ ...clip, bar: 0, gain: 1, plugins: [] }],
        });
      chain.bind(inGain, engine.master, clip.plugins, () => {
        store.scheduleSave();
        this.scheduleHistoryCommit();
      }, { renderSource });
      slot.appendChild(chain);
      dialog.show();
      }),
    );
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
    const active = this.transportActive();
    // stopped: still show the (dimmed) line at the parked cursor instead of hiding it
    playhead.classList.toggle('cursor', !active);
    const barsPos = active ? this.playheadBar() : this.cursorBar();
    const x = HEAD_W + barsPos * this.pxPerBar();
    playhead.style.left = `${x}px`;
    if (!active) return;
    const viewWidth = scroll.clientWidth;
    const margin = viewWidth * 0.2;
    const vx = x - scroll.scrollLeft;
    if (vx < HEAD_W + margin) scroll.scrollLeft = Math.max(0, x - HEAD_W - margin);
    else if (vx > viewWidth - margin) scroll.scrollLeft = x - viewWidth + margin;
    this.viewDirty = true; // auto-scroll moves the window → ruler/clips refresh
  }

  // ---- render ----

  private render(): void {
    // the FX dialog is non-modal — mute/solo/rename/duplicate/delete/drag can all
    // trigger render() while it's open. Preserve it (and any mounted plugin-chain,
    // which is now safe to reparent — see PluginChainEl) instead of recreating it,
    // so an open FX editing session survives unrelated re-renders.
    const existingDialogs = [...this.fxDialogs.values()];
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
    ruler.title = 'Click: move the play cursor to the nearest bar (snapped)';
    ruler.onclick = (e): void => this.onRulerClick(e);
    rulerRow.append(corner, ruler);
    scroll.appendChild(rulerRow);

    const grid = gridBackgroundBars(px, this.snapBeats());
    const anySolo = arr.tracks.some((t) => t.solo && !t.muted);
    for (const track of arr.tracks) {
      scroll.appendChild(this.buildTrackRow(track, bars, px, grid, anySolo));
    }

    const playhead = document.createElement('div');
    playhead.className = 'arrange-playhead';
    scroll.appendChild(playhead);

    this.appendChild(scroll);

    // re-append preserves each dialog's `open` attribute, mounted chain DOM,
    // title, and wired handlers; dialogs are created on demand by buildFxDialog
    for (const dialog of existingDialogs) this.appendChild(dialog);

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
    const beatGroup = group('Beats');
    for (const l of store.data.padLoops) {
      const opt = document.createElement('option');
      opt.value = `loop:${l.id}`;
      opt.textContent = l.name;
      opt.selected = this.palette === opt.value;
      beatGroup.appendChild(opt);
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
    for (const s of this.sampleFiles) if (s.source === 'project') files.add(s.path);
    const fileGroup = group('Files');
    for (const f of [...files].sort((a, b) => a.localeCompare(b))) {
      const opt = document.createElement('option');
      opt.value = `file:${f}`;
      opt.textContent = f.split('/').pop() ?? f;
      opt.selected = this.palette === opt.value;
      fileGroup.appendChild(opt);
    }
    const globalFiles = this.sampleFiles.filter((s) => s.source === 'global');
    if (globalFiles.length > 0) {
      const globalGroup = group('Global samples');
      for (const s of globalFiles) {
        const opt = document.createElement('option');
        opt.value = `file:${s.path}`;
        opt.textContent = s.path.split('/').pop() ?? s.path;
        opt.selected = this.palette === opt.value;
        globalGroup.appendChild(opt);
      }
    }
    // A `file:` palette value may point at a scanned-only sample — don't clear it before the async scan completes.
    const canValidate = this.samplesScanned || !this.palette.startsWith('file:');
    if (this.palette && canValidate && !Array.from(palette.options).some((o) => o.value === this.palette)) {
      this.palette = '';
      updateUi((s) => (s.arrange.palette = ''));
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

    const undoBtn = iconBtn(
      'Undo (Ctrl+Z)',
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
      () => this.undoArrange(),
    );
    const redoBtn = iconBtn(
      'Redo (Ctrl+Shift+Z)',
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>',
      () => this.redoArrange(),
    );
    this.undoBtn = undoBtn;
    this.redoBtn = redoBtn;
    this.refreshHistoryButtons();

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
      this.scheduleHistoryCommit();
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
      this.scheduleHistoryCommit();
      this.render();
    };

    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn-with-icon';
    exportBtn.innerHTML = `${ICONS.download} .wav`;
    exportBtn.title = 'Export song: render the whole song offline, download it as .wav and write it to exports/';
    exportBtn.onclick = (): void => void this.exportSong();

    bar.append(
      iconBtn('Play cursor to start (bar 1)', ICONS.toStart, () => this.toStart()),
      iconBtn('Play cursor back one bar', ICONS.stepBack, () => this.stepBack()),
      transportButton('play', 'Play the song (Space)', () => void this.play()),
      transportButton('stop', 'Stop (Space)', () => {
        this.stop();
        if (engine.started) engine.stop();
      }),
      this.buildLoopButton(iconBtn),
      iconBtn('Play cursor forward one bar', ICONS.stepForward, () => this.stepForward()),
      palette,
      snap,
      undoBtn,
      redoBtn,
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
      this.scheduleHistoryCommit();
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
      this.scheduleHistoryCommit();
      this.render();
    });
    muteBtn.classList.add('mute-btn');
    muteBtn.classList.toggle('active', !!track.muted);
    const soloBtn = iconBtn('Solo track — only soloed tracks play', ICONS.solo, () => {
      store.update(() => (track.solo = !track.solo));
      this.scheduleHistoryCommit();
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
      this.scheduleHistoryCommit();
      this.render();
    });
    const delBtn = iconBtn('Remove track', '✕', () => {
      this.fxDialogs.get(`track:${track.id}`)?.close();
      for (const clip of track.clips) this.fxDialogs.get(`clip:${clip.id}`)?.close();
      this.liveTrackNodes.get(track.id)?.chain.teardown();
      this.liveTrackNodes.delete(track.id);
      store.update((d) => {
        d.arrangement.tracks = d.arrangement.tracks.filter((t) => t.id !== track.id);
      });
      this.scheduleHistoryCommit();
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
        this.scheduleHistoryCommit();
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
    row.title = 'Click: place the palette item · drag a clip: move · right edge: resize · double-click a clip: remove · right-click a clip: FX · Delete: remove selected';
    this.rows.set(track.id, row);
    row.onclick = (e): void => {
      if (e.target !== row || !this.palette) return;
      const bar = floorSnapBar((e.clientX - row.getBoundingClientRect().left) / px, this.snapBeats());
      if (bar >= bars) return;
      const ref = this.palette.startsWith('seq:')
        ? { type: 'sequence' as const, id: this.palette.slice(4) }
        : this.palette.startsWith('loop:')
          ? { type: 'loop' as const, id: this.palette.slice(5) }
          : this.palette.startsWith('pad:')
            ? { type: 'pad' as const, index: Number(this.palette.slice(4)) }
            : { type: 'file' as const, file: this.palette.slice(5) };
      store.update(() => track.clips.push({ id: uid(), bar, ref, gain: 1, plugins: [] }));
      this.scheduleHistoryCommit();
      this.viewDirty = true;
    };

    wrap.append(head, row);
    return wrap;
  }

  private buildLoopButton(iconBtn: (title: string, svg: string, fn: () => void) => HTMLButtonElement): HTMLButtonElement {
    const b = iconBtn('Loop the selected clip — plays it solo on repeat', ICONS.loop, () => void this.toggleClipLoop());
    b.classList.add('clip-loop-btn');
    b.classList.toggle('loop-on', this.clipLoopOn);
    this.loopBtn = b;
    return b;
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
