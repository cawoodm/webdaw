import * as Tone from '../core/tone';
import { engine } from '../core/audio-engine';
import { bus } from '../core/event-bus';
import type { TabId } from '../core/model';
import { idbGet, idbSet } from '../core/persistence';
import { projects } from '../core/project-manager';
import { NEW_PROJECT_SENTINEL } from '../core/project-names';
import { store } from '../core/project-store';
import { uiState, updateUi } from '../core/ui-state';
import { midiInput } from '../midi/midi-input';
import type { PluginChainEl } from '../plugins/chain';
import { makeDialogDraggable } from '../ui/draggable-dialog';
import { openKeymapDialog } from '../ui/keymap-dialog';
import { knob } from '../ui/knob';
import { PLAY_ICON, STOP_ICON } from '../ui/transport-buttons';

const TABS: { id: TabId; label: string }[] = [
  { id: 'tone', label: 'Tone' },
  { id: 'sample', label: 'Sample' },
  { id: 'sequence', label: 'Sequence' },
  { id: 'arrange', label: 'Arrange' },
  { id: 'produce', label: 'Produce' },
];

export class AppShell extends HTMLElement {
  private masterChain: PluginChainEl | null = null;

  connectedCallback(): void {
    this.innerHTML = `
      <header class="app-header">
        <span class="logo">Web<b>DAW</b></span>
        <nav class="tab-bar"></nav>
        <div class="transport">
          <label>BPM <input type="number" class="bpm" min="40" max="240" value="120"></label>
          <button class="metro icon-btn" title="Metronome" aria-label="Toggle metronome">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M9.2 3.5h5.6L19 20.5H5L9.2 3.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
              <g class="pendulum">
                <line x1="12" y1="17" x2="12" y2="6.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                <circle cx="12" cy="6.5" r="1.5" fill="currentColor"/>
              </g>
            </svg>
          </button>
          <button class="midi-btn icon-btn" title="Enable/disable MIDI input" aria-label="Enable/disable MIDI input">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
              <circle cx="12" cy="12" r="9"/>
              <circle cx="7.5" cy="13.5" r="1" fill="currentColor"/>
              <circle cx="16.5" cy="13.5" r="1" fill="currentColor"/>
              <circle cx="8.5" cy="9" r="1" fill="currentColor"/>
              <circle cx="15.5" cy="9" r="1" fill="currentColor"/>
              <circle cx="12" cy="15.5" r="1" fill="currentColor"/>
            </svg>
          </button>
          <button class="play-all icon-btn" title="Play/stop everything (Space)" aria-label="Play or stop everything"></button>
        </div>
        <div class="project-menu">
          <button class="master-fx">Master FX</button>
          <button class="keys">Keys</button>
          <button class="reconnect hidden">Reconnect folder</button>
          <button class="folder icon-btn" title="Pick the root folder that holds one subdirectory per project" aria-label="Pick root folder">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
          <select class="project-select" title="Switch project"></select>
          <button class="save-btn icon-btn" title="Save project now (Ctrl+S)" aria-label="Save project">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
              <path d="M5 3h11l4 4v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>
              <path d="M8 3v5h7V3"/>
              <rect x="7" y="13" width="10" height="8" rx="0.5"/>
            </svg>
          </button>
          <button class="reload-btn icon-btn" title="Reload project from disk (discards unsaved changes)" aria-label="Reload project from disk">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20 11a8 8 0 1 0-2.34 5.66"/>
              <path d="M20 5v6h-6"/>
            </svg>
          </button>
          <span class="project-name hint"></span>
        </div>
      </header>
      <main class="tab-panels"></main>
      <dialog class="master-dialog"><h3>Master FX</h3><div class="master-chain-slot"></div>
        <div class="toolbar"><button class="close-master">Close</button></div></dialog>`;

    const nav = this.querySelector('.tab-bar')!;
    for (const tab of TABS) {
      const b = document.createElement('button');
      b.textContent = tab.label;
      b.dataset.tab = tab.id;
      b.onclick = (): void => bus.emit('tab:activate', tab.id);
      // spring-loaded tabs: dragging files over a tab name switches to it,
      // and dropping on the name forwards the files to that tab's handler
      b.ondragover = (e): void => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        if (!b.classList.contains('drag-over')) {
          b.classList.add('drag-over');
          bus.emit('tab:activate', tab.id);
        }
      };
      b.ondragleave = (): void => b.classList.remove('drag-over');
      b.ondrop = (e): void => {
        b.classList.remove('drag-over');
        if (!e.dataTransfer?.files.length) return;
        e.preventDefault();
        this.querySelector(`${tab.id}-tab`)?.dispatchEvent(new DragEvent('drop', { dataTransfer: e.dataTransfer }));
      };
      nav.appendChild(b);
    }

    const main = this.querySelector('.tab-panels')!;
    for (const tab of TABS) {
      main.appendChild(document.createElement(`${tab.id}-tab`));
    }

    const bpm = this.querySelector<HTMLInputElement>('.bpm')!;
    bpm.onchange = (): void => {
      const value = Math.min(240, Math.max(40, Number(bpm.value) || 120));
      engine.bpm = value;
      store.update((d) => (d.bpm = value));
    };
    // master volume: bare mutation + scheduleSave, like other knobs
    const volKnob = knob({ label: 'Vol', min: 0, max: 1, step: 0.01, value: engine.volume }, (v) => {
      engine.volume = v;
      store.data.masterVolume = v;
      store.scheduleSave();
    });
    volKnob.classList.add('master-vol');
    volKnob.title = 'Master volume';
    this.querySelector('.transport')!.appendChild(volKnob);
    // level gauge next to the volume knob: green = level, red = clipping
    const meterEl = document.createElement('div');
    meterEl.className = 'level-meter';
    meterEl.title = 'Master level (red = clipping)';
    meterEl.innerHTML = '<div class="level-fill"></div>';
    this.querySelector('.transport')!.appendChild(meterEl);
    const metro = this.querySelector<HTMLButtonElement>('.metro')!;
    metro.onclick = async (): Promise<void> => {
      await engine.ensureStarted();
      await engine.setMetronome(!engine.metronomeOn);
      metro.classList.toggle('active', engine.metronomeOn);
      updateUi((s) => (s.metronomeOn = engine.metronomeOn));
    };
    const midiBtn = this.querySelector<HTMLButtonElement>('.midi-btn')!;
    midiBtn.onclick = async (): Promise<void> => {
      if (midiInput.enabled) {
        midiInput.disable();
      } else {
        await midiInput.enable();
      }
      midiBtn.classList.toggle('active', midiInput.enabled);
      await idbSet('midiEnabled', midiInput.enabled);
    };
    void (async (): Promise<void> => {
      if (await idbGet<boolean>('midiEnabled')) {
        await midiInput.enable();
        midiBtn.classList.add('active');
      }
    })();

    // --- global play/stop: play starts the ACTIVE tab, stop halts everything ---
    const playAll = this.querySelector<HTMLButtonElement>('.play-all')!;
    const togglePlayback = async (): Promise<void> => {
      if (engine.started && engine.playing) {
        bus.emit('transport:stop');
        engine.stop();
      } else {
        await engine.ensureStarted();
        bus.emit('transport:play');
      }
    };
    playAll.onclick = (): void => void togglePlayback();
    let lastPlaying: boolean | null = null;
    const paintPlayAll = (): void => {
      const playing = engine.started && engine.playing;
      if (playing === lastPlaying) return;
      lastPlaying = playing;
      playAll.classList.toggle('active', playing);
      playAll.innerHTML = playing ? STOP_ICON : PLAY_ICON;
    };
    paintPlayAll();
    // meter maps -60..0 dB onto the bar; clipping (>= 0 dB) holds red briefly
    const meterFill = meterEl.querySelector<HTMLElement>('.level-fill')!;
    let clipUntil = 0;
    const paintMeter = (): void => {
      const db = engine.masterLevelDb();
      const norm = Math.max(0, Math.min(1, (db + 60) / 60));
      meterFill.style.height = `${(norm * 100).toFixed(1)}%`;
      const now = performance.now();
      if (db >= 0) clipUntil = now + 400;
      meterEl.classList.toggle('clip', now < clipUntil);
    };
    const playAllTick = (): void => {
      paintPlayAll();
      paintMeter();
      requestAnimationFrame(playAllTick);
    };
    requestAnimationFrame(playAllTick);
    // Space = play/stop. Capture + stopPropagation keeps it away from the
    // piano keymap (midi-input) and from activating whichever button has focus.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        const target = e.target as HTMLElement;
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable
        )
          return;
        e.preventDefault();
        e.stopPropagation();
        void togglePlayback();
      },
      { capture: true },
    );
    this.querySelector<HTMLButtonElement>('.keys')!.onclick = (): void => openKeymapDialog();
    this.querySelector<HTMLButtonElement>('.folder')!.onclick = async (): Promise<void> => {
      await projects.chooseRoot();
    };
    this.querySelector<HTMLButtonElement>('.reconnect')!.onclick = async (): Promise<void> => {
      await projects.reconnect();
    };

    // --- project dropdown + save ---
    const projectSelect = this.querySelector<HTMLSelectElement>('.project-select')!;
    projectSelect.onchange = async (): Promise<void> => {
      const value = projectSelect.value;
      if (value === NEW_PROJECT_SENTINEL) {
        const name = prompt('Project name');
        const created = name ? await projects.createProject(name) : false;
        if (!created) await this.refreshProjects(); // reset selection
      } else {
        await projects.open(value);
      }
    };

    const saveBtn = this.querySelector<HTMLButtonElement>('.save-btn')!;
    const doSave = async (): Promise<void> => {
      saveBtn.classList.add('saving');
      saveBtn.disabled = true;
      try {
        await projects.saveAll();
      } finally {
        saveBtn.classList.remove('saving');
        saveBtn.disabled = false;
      }
    };
    saveBtn.onclick = (): void => void doSave();
    window.addEventListener(
      'keydown',
      (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void doSave();
        }
      },
      { capture: true },
    );

    const reloadBtn = this.querySelector<HTMLButtonElement>('.reload-btn')!;
    reloadBtn.onclick = async (): Promise<void> => {
      if (store.dirty && !confirm('Discard unsaved changes and reload the project from disk?')) return;
      reloadBtn.classList.add('saving');
      reloadBtn.disabled = true;
      try {
        await projects.reloadFromDisk();
      } finally {
        reloadBtn.classList.remove('saving');
        reloadBtn.disabled = false;
      }
    };

    bus.on('project:diskDirty', (dirty) => saveBtn.classList.toggle('dirty', dirty));

    const masterDialog = this.querySelector<HTMLDialogElement>('.master-dialog')!;
    makeDialogDraggable(masterDialog, masterDialog.querySelector<HTMLElement>('h3')!);
    this.querySelector<HTMLButtonElement>('.master-fx')!.onclick = async (): Promise<void> => {
      await engine.ensureStarted();
      this.ensureMasterChain();
      masterDialog.show();
    };
    this.querySelector<HTMLButtonElement>('.close-master')!.onclick = (): void => masterDialog.close();
    // bind Master FX into the live graph as soon as audio exists — previously
    // this only happened the first time the user opened the Master FX dialog,
    // so masterPlugins silently did nothing live (it was still applied
    // correctly during WAV export, which built its own separate graph)
    engine.whenReady(() => this.ensureMasterChain());

    bus.on('tab:activate', (tab) => {
      this.activate(tab);
      updateUi((s) => (s.activeTab = tab));
    });
    bus.on('ui:loaded', () => {
      // emit (not just activate) so modules tracking the active tab via the
      // bus — e.g. the tone tab's note routing — are correct from boot
      bus.emit('tab:activate', uiState().activeTab);
      if (uiState().metronomeOn) {
        metro.classList.add('active');
        // clicking starts once the first gesture unlocks the audio context
        engine.whenReady(() => void engine.setMetronome(true));
      }
    });
    bus.on('project:loaded', () => {
      engine.bpm = store.data.bpm;
      bpm.value = String(store.data.bpm);
      engine.volume = store.data.masterVolume ?? 0.9;
      volKnob.value = engine.volume;
      this.updateProjectUi();
      void this.refreshProjects();
      saveBtn.classList.toggle('dirty', store.diskDirty);
      if (this.masterChain) this.ensureMasterChain(true);
    });
    // Keep the header BPM in sync with programmatic tempo changes (e.g. MIDI
    // import applying a file's tempo). Skip while the field is being edited.
    bus.on('project:changed', () => {
      if (document.activeElement !== bpm) bpm.value = String(store.data.bpm);
    });

    this.activate('tone');
    this.updateProjectUi();
  }

  /** Repopulate the project dropdown (projects + '- new project -'). */
  private async refreshProjects(): Promise<void> {
    const select = this.querySelector<HTMLSelectElement>('.project-select');
    if (!select) return;
    const names = await projects.listProjects();
    select.innerHTML = '';
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      opt.selected = name === projects.activeName;
      select.appendChild(opt);
    }
    const newOpt = document.createElement('option');
    newOpt.value = NEW_PROJECT_SENTINEL;
    newOpt.textContent = '- new project -';
    select.appendChild(newOpt);
  }

  private ensureMasterChain(rebind = false): void {
    const slot = this.querySelector('.master-chain-slot')!;
    if (this.masterChain && rebind) {
      this.masterChain.teardown();
      this.masterChain.remove();
      this.masterChain = null;
    }
    if (!this.masterChain) {
      this.masterChain = document.createElement('plugin-chain') as PluginChainEl;
      slot.appendChild(this.masterChain);
      this.masterChain.bind(engine.master, Tone.getDestination(), store.data.arrangement.masterPlugins, () =>
        store.scheduleSave(),
      );
    }
  }

  private activate(tab: TabId): void {
    this.querySelectorAll<HTMLButtonElement>('.tab-bar button').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === tab),
    );
    this.querySelectorAll<HTMLElement>('.tab-panels > *').forEach((el) => {
      const isActive = el.tagName.toLowerCase() === `${tab}-tab`;
      el.classList.toggle('active-tab', isActive);
      el.classList.toggle('hidden', !isActive);
    });
  }

  private updateProjectUi(): void {
    const name = this.querySelector('.project-name')!;
    const reconnect = this.querySelector('.reconnect')!;
    reconnect.classList.toggle('hidden', !projects.needsPermission);
    this.querySelector('.reload-btn')!.classList.toggle('hidden', projects.root === null);
    name.textContent = projects.root
      ? projects.needsPermission
        ? `${projects.root.name} (permission needed)`
        : `${projects.root.name} / ${projects.activeName}`
      : 'no folder — changes saved in browser only';
  }
}

customElements.define('app-shell', AppShell);
