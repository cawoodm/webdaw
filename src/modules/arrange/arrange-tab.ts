import * as Tone from 'tone';
import { engine } from '../../core/audio-engine';
import { bus } from '../../core/event-bus';
import type { ArrangeTrack, Sequence } from '../../core/model';
import { uid } from '../../core/model';
import { store } from '../../core/project-store';
import { uiState, updateUi } from '../../core/ui-state';
import { connectChain, PluginChainEl } from '../../plugins/chain';
import { knob } from '../../ui/knob';
import { renderSequence } from '../sequence/sequence-playback';

const MIN_BARS = 32;

export class ArrangeTab extends HTMLElement {
  private palette = '';
  private openFx = new Set<string>();
  private fxRenderQueued = false;
  private playing: Tone.ToneBufferSource[] = [];
  private seqRenderCache = new Map<string, AudioBuffer>();
  private liveChains = new Map<string, { inGain: Tone.Gain; chain: PluginChainEl }>();

  connectedCallback(): void {
    this.className = 'tab-panel arrange-tab';
    bus.on('ui:loaded', () => {
      this.palette = uiState().arrange.palette;
      this.openFx = new Set(uiState().arrange.openFx);
      this.render();
    });
    bus.on('project:loaded', () => {
      this.seqRenderCache.clear();
      this.render();
    });
    bus.on('project:changed', () => this.seqRenderCache.clear());
    this.render();
  }

  private songBars(): number {
    let end = MIN_BARS;
    for (const t of store.data.arrangement.tracks) {
      for (const c of t.clips) end = Math.max(end, c.bar + this.clipBars(c.ref) + 4);
    }
    return end;
  }

  private clipBars(ref: { type: 'sequence'; id: string } | { type: 'file'; file: string }): number {
    const barSeconds = engine.secondsPerBeat() * 4;
    if (ref.type === 'sequence') {
      return store.data.sequences.find((s) => s.id === ref.id)?.bars ?? 1;
    }
    const buffer = store.getBuffer(ref.file);
    return buffer ? Math.max(1, Math.ceil(buffer.duration / barSeconds)) : 1;
  }

  private async sequenceBuffer(seq: Sequence): Promise<AudioBuffer | null> {
    if (seq.wavFile) {
      const b = store.getBuffer(seq.wavFile);
      if (b) return b;
    }
    const cached = this.seqRenderCache.get(seq.id);
    if (cached) return cached;
    const rendered = await renderSequence(seq);
    this.seqRenderCache.set(seq.id, rendered);
    return rendered;
  }

  /** Pre-resolve every clip's buffer in the live context. */
  private async resolveClips(): Promise<Map<string, AudioBuffer>> {
    const map = new Map<string, AudioBuffer>();
    for (const track of store.data.arrangement.tracks) {
      for (const clip of track.clips) {
        const ref = clip.ref;
        if (ref.type === 'sequence') {
          const seq = store.data.sequences.find((s) => s.id === ref.id);
          if (!seq) continue;
          const buffer = await this.sequenceBuffer(seq);
          if (buffer) map.set(clip.id, buffer);
        } else {
          const buffer = store.getBuffer(ref.file) ?? (await store.loadBuffer(ref.file));
          if (buffer) map.set(clip.id, buffer);
        }
      }
    }
    return map;
  }

  private trackNodes(track: ArrangeTrack): { inGain: Tone.Gain; chain: PluginChainEl } {
    let nodes = this.liveChains.get(track.id);
    if (!nodes) {
      const inGain = new Tone.Gain(track.gain);
      const chain = document.createElement('plugin-chain') as PluginChainEl;
      chain.bind(inGain, engine.master, track.plugins, () => store.scheduleSave());
      nodes = { inGain, chain };
      this.liveChains.set(track.id, nodes);
    }
    return nodes;
  }

  private async play(): Promise<void> {
    await engine.ensureStarted();
    this.stop();
    const buffers = await this.resolveClips();
    const barSeconds = engine.secondsPerBeat() * 4;
    const startAt = Tone.now() + 0.15;
    for (const track of store.data.arrangement.tracks) {
      const { inGain } = this.trackNodes(track);
      inGain.gain.value = track.gain;
      for (const clip of track.clips) {
        const buffer = buffers.get(clip.id);
        if (!buffer) continue;
        const src = new Tone.ToneBufferSource(new Tone.ToneAudioBuffer(buffer)).connect(inGain);
        src.start(startAt + clip.bar * barSeconds);
        this.playing.push(src);
      }
    }
  }

  private stop(): void {
    for (const src of this.playing) {
      try {
        src.stop();
        src.dispose();
      } catch {
        /* already stopped */
      }
    }
    this.playing = [];
  }

  private async exportSong(): Promise<void> {
    const buffers = await this.resolveClips();
    const barSeconds = engine.secondsPerBeat() * 4;
    const tracks = store.data.arrangement.tracks;
    let endBar = 1;
    for (const t of tracks) for (const c of t.clips) endBar = Math.max(endBar, c.bar + this.clipBars(c.ref));
    const seconds = endBar * barSeconds + 1;
    const masterPlugins = store.data.arrangement.masterPlugins;

    const rendered = await Tone.Offline(() => {
      const dest = Tone.getDestination();
      const masterBus = new Tone.Gain(0.9);
      connectChain(masterPlugins, masterBus, dest);
      for (const track of tracks) {
        const inGain = new Tone.Gain(track.gain);
        connectChain(track.plugins, inGain, masterBus);
        for (const clip of track.clips) {
          const buffer = buffers.get(clip.id);
          if (!buffer) continue;
          const src = new Tone.ToneBufferSource(new Tone.ToneAudioBuffer(buffer)).connect(inGain);
          src.start(clip.bar * barSeconds + 0.01);
        }
      }
    }, seconds);
    const path = `exports/${store.data.name.replace(/[^\w-]+/g, '_')}-song.wav`;
    await store.saveWav(path, rendered.get() as AudioBuffer);
    this.flash(`Exported ${path}`);
  }

  private render(): void {
    this.innerHTML = '';
    const arr = store.data.arrangement;

    const bar = document.createElement('div');
    bar.className = 'toolbar';
    const btn = (label: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = fn;
      return b;
    };

    const palette = document.createElement('select');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— place… —';
    palette.appendChild(none);
    for (const seq of store.data.sequences) {
      const opt = document.createElement('option');
      opt.value = `seq:${seq.id}`;
      opt.textContent = `Sequence: ${seq.name}`;
      opt.selected = this.palette === opt.value;
      palette.appendChild(opt);
    }
    const files = new Set<string>();
    for (const p of store.data.patches) if (p.wavFile) files.add(p.wavFile);
    for (const pad of store.data.pads) if (pad?.file) files.add(pad.file);
    for (const f of files) {
      const opt = document.createElement('option');
      opt.value = `file:${f}`;
      opt.textContent = `Sample: ${f.split('/').pop()}`;
      opt.selected = this.palette === opt.value;
      palette.appendChild(opt);
    }
    palette.onchange = (): void => {
      this.palette = palette.value;
      updateUi((s) => (s.arrange.palette = palette.value));
    };

    bar.append(
      palette,
      btn('+ Track', () => {
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
      }),
      btn('▶ Play song', () => void this.play()),
      btn('⏹ Stop', () => this.stop()),
      btn('Export song WAV', () => void this.exportSong()),
    );
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Pick an item, then click a cell to place it. Click a clip to remove it.';
    bar.appendChild(hint);
    this.appendChild(bar);

    const bars = this.songBars();
    const lanes = document.createElement('div');
    lanes.className = 'arrange-lanes';

    for (const track of arr.tracks) {
      const lane = document.createElement('div');
      lane.className = 'arrange-track card';

      const head = document.createElement('div');
      head.className = 'seq-track-head';
      const title = document.createElement('span');
      title.className = 'card-title';
      title.textContent = track.name;
      head.append(
        title,
        knob({ label: 'Gain', min: 0, max: 1.2, step: 0.01, value: track.gain }, (v) => {
          track.gain = v;
          const nodes = this.liveChains.get(track.id);
          if (nodes) nodes.inGain.gain.value = v;
          store.scheduleSave();
        }),
        btn(this.openFx.has(track.id) ? 'Hide FX' : 'FX', () => {
          if (this.openFx.has(track.id)) this.openFx.delete(track.id);
          else this.openFx.add(track.id);
          updateUi((s) => (s.arrange.openFx = [...this.openFx]));
          this.render();
        }),
        btn('✕', () => {
          this.liveChains.get(track.id)?.chain.teardown();
          this.liveChains.delete(track.id);
          store.update((d) => {
            d.arrangement.tracks = d.arrangement.tracks.filter((t) => t.id !== track.id);
          });
          this.render();
        }),
      );
      lane.appendChild(head);

      const row = document.createElement('div');
      row.className = 'arrange-row';
      row.style.gridTemplateColumns = `repeat(${bars}, 34px)`;
      const covered = new Set<number>();
      for (const clip of track.clips) {
        const span = this.clipBars(clip.ref);
        for (let b = clip.bar; b < clip.bar + span; b++) covered.add(b);
      }
      for (let b = 0; b < bars; b++) {
        const clip = track.clips.find((c) => c.bar === b);
        if (clip) {
          const span = this.clipBars(clip.ref);
          const el = document.createElement('div');
          el.className = 'arrange-clip' + (clip.ref.type === 'sequence' ? ' seq' : ' smp');
          el.style.gridColumn = `${b + 1} / span ${span}`;
          el.textContent =
            clip.ref.type === 'sequence'
              ? store.data.sequences.find((s) => s.id === (clip.ref as { id: string }).id)?.name ?? '?'
              : (clip.ref as { file: string }).file.split('/').pop() ?? '?';
          el.onclick = (): void => {
            store.update(() => track.clips.splice(track.clips.indexOf(clip), 1));
            this.render();
          };
          row.appendChild(el);
        } else if (!covered.has(b)) {
          const cell = document.createElement('div');
          cell.className = 'arrange-cell' + (b % 4 === 0 ? ' bar-start' : '');
          cell.style.gridColumn = `${b + 1}`;
          cell.onclick = (): void => {
            if (!this.palette) return;
            const ref = this.palette.startsWith('seq:')
              ? { type: 'sequence' as const, id: this.palette.slice(4) }
              : { type: 'file' as const, file: this.palette.slice(5) };
            store.update(() => track.clips.push({ id: uid(), bar: b, ref }));
            this.render();
          };
          row.appendChild(cell);
        }
      }
      lane.appendChild(row);

      if (this.openFx.has(track.id)) {
        // plugin chains need the audio context — defer mounting until the
        // first gesture when FX panels are restored at boot
        if (engine.started) {
          lane.appendChild(this.trackNodes(track).chain);
        } else if (!this.fxRenderQueued) {
          this.fxRenderQueued = true;
          engine.whenReady(() => {
            this.fxRenderQueued = false;
            this.render();
          });
        }
      }
      lanes.appendChild(lane);
    }
    this.appendChild(lanes);
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
