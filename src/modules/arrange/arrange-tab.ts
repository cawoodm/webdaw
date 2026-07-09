import * as Tone from '../../core/tone';
import { engine } from '../../core/audio-engine';
import { bus } from '../../core/event-bus';
import type { ArrangeTrack } from '../../core/model';
import { uid } from '../../core/model';
import { store } from '../../core/project-store';
import { uiState, updateUi } from '../../core/ui-state';
import { connectChain, PluginChainEl } from '../../plugins/chain';
import type { DawPlugin } from '../../plugins/api';
import { knob } from '../../ui/knob';
import { transportButton } from '../../ui/transport-buttons';
import {
  clipBars,
  clipSpanBars,
  createOfflineProvider,
  resolveSong,
  scheduleSong,
  songBars,
  type NodeProvider,
  type SongPlaybackHandles,
} from './song-graph';

const MIN_BARS = 32;

export class ArrangeTab extends HTMLElement {
  private palette = '';
  private openFx = new Set<string>();
  private fxRenderQueued = false;
  private activeSong: SongPlaybackHandles | null = null;
  private liveTrackNodes = new Map<string, { inGain: Tone.Gain; chain: PluginChainEl }>();
  private ephemeralClipFx: DawPlugin[] = [];

  connectedCallback(): void {
    this.className = 'tab-panel arrange-tab';
    bus.on('ui:loaded', () => {
      this.palette = uiState().arrange.palette;
      this.openFx = new Set(uiState().arrange.openFx);
      this.render();
    });
    bus.on('project:loaded', () => this.render());
    // absolute-time playback survives tab switches; yield when another
    // module claims playback
    bus.on('transport:claim', ({ owner }) => {
      if (owner !== 'arrange') this.stop();
    });
    // a shareable owner (sample/sequence) is joining playback — song
    // playback is exclusive, so it must yield just like on transport:claim
    bus.on('transport:join', () => this.stop());
    // global play/stop (Space / shell button)
    bus.on('transport:play', () => {
      if (this.classList.contains('active-tab')) void this.play();
    });
    bus.on('transport:stop', () => this.stop());
    this.render();
  }

  private barSeconds(): number {
    return engine.secondsPerBeat() * 4;
  }

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
    const barSeconds = this.barSeconds();
    this.activeSong = scheduleSong(tracks, resolved, {
      songBus: engine.master, // carries Master FX eagerly now (see app-shell.ts fix)
      startSeconds: Tone.now() + 0.15,
      barSeconds,
      secondsPerStep: engine.secondsPerStep(),
      provider: this.liveProvider(),
    });
    // clips run on absolute time, but starting the transport keeps the
    // metronome ticking and lets the global play/stop button see the state
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
    const seconds = Math.min(endBar, 800) * barSeconds + 1;
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
    for (const [index, pad] of store.data.pads.entries()) {
      if (!pad) continue;
      const opt = document.createElement('option');
      opt.value = `pad:${index}`;
      opt.textContent = `Pad: ${pad.name}`;
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
      transportButton('play', 'Play the song (Space)', () => void this.play()),
      transportButton('stop', 'Stop (Space)', () => {
        this.stop();
        if (engine.started) engine.stop();
      }),
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
      btn('Export song WAV', () => void this.exportSong()),
    );
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Pick an item, then click a cell to place it. Click a clip to remove it.';
    bar.appendChild(hint);
    this.appendChild(bar);

    const barSeconds = this.barSeconds();
    const bars = songBars(arr.tracks, MIN_BARS, barSeconds);
    const lanes = document.createElement('div');
    lanes.className = 'arrange-lanes';

    for (const track of arr.tracks) {
      const lane = document.createElement('div');
      lane.className = 'arrange-track card';
      lane.classList.toggle('muted', !!track.muted);

      const head = document.createElement('div');
      head.className = 'seq-track-head';
      const title = document.createElement('span');
      title.className = 'card-title';
      title.textContent = track.name;
      head.append(
        title,
        btn(track.muted ? 'Muted' : 'Mute', () => {
          store.update(() => (track.muted = !track.muted));
          this.render();
        }),
        btn(track.solo ? 'Soloed' : 'Solo', () => {
          store.update(() => (track.solo = !track.solo));
          this.render();
        }),
        knob({ label: 'Gain', min: 0, max: 1.2, step: 0.01, value: track.gain }, (v) => {
          track.gain = v;
          const nodes = this.liveTrackNodes.get(track.id);
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
          this.liveTrackNodes.get(track.id)?.chain.teardown();
          this.liveTrackNodes.delete(track.id);
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
        const span = clipBars(clip.ref, barSeconds);
        for (let b = clip.bar; b < clip.bar + span; b++) covered.add(b);
      }
      for (let b = 0; b < bars; b++) {
        const clip = track.clips.find((c) => c.bar === b);
        if (clip) {
          const span = clipBars(clip.ref, barSeconds);
          const el = document.createElement('div');
          el.className =
            'arrange-clip' + (clip.ref.type === 'sequence' ? ' seq' : clip.ref.type === 'pad' ? ' pad' : ' smp');
          el.style.gridColumn = `${b + 1} / span ${span}`;
          el.textContent =
            clip.ref.type === 'sequence'
              ? store.data.sequences.find((s) => s.id === (clip.ref as { id: string }).id)?.name ?? '?'
              : clip.ref.type === 'pad'
                ? store.data.pads[(clip.ref as { index: number }).index]?.name ?? '?'
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
              : this.palette.startsWith('pad:')
                ? { type: 'pad' as const, index: Number(this.palette.slice(4)) }
                : { type: 'file' as const, file: this.palette.slice(5) };
            store.update(() => track.clips.push({ id: uid(), bar: b, ref, gain: 1, plugins: [] }));
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
          this.trackBus(track, engine.master); // ensures liveTrackNodes has this track's chain
          lane.appendChild(this.liveTrackNodes.get(track.id)!.chain);
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
