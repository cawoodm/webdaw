import * as Tone from '../core/tone';
import { engine } from '../core/audio-engine';
import { bus } from '../core/event-bus';
import type { TabId } from '../core/model';
import { projects } from '../core/project-manager';
import { NEW_PROJECT_SENTINEL } from '../core/project-names';
import { store } from '../core/project-store';
import { uiState, updateUi } from '../core/ui-state';
import type { PluginChainEl } from '../plugins/chain';
import { openKeymapDialog } from '../ui/keymap-dialog';
import { PLAY_ICON, STOP_ICON } from '../ui/transport-icons';

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
          <button class="play-all icon-btn" title="Play (Space)" aria-label="Play">${PLAY_ICON}</button>
          <button class="stop-all icon-btn" title="Stop everything (Space)" aria-label="Stop">${STOP_ICON}</button>
          <button class="metro icon-btn" title="Metronome" aria-label="Toggle metronome">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M9.2 3.5h5.6L19 20.5H5L9.2 3.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
              <g class="pendulum">
                <line x1="12" y1="17" x2="12" y2="6.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                <circle cx="12" cy="6.5" r="1.5" fill="currentColor"/>
              </g>
            </svg>
          </button>
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
    const metro = this.querySelector<HTMLButtonElement>('.metro')!;
    metro.onclick = async (): Promise<void> => {
      await engine.ensureStarted();
      await engine.setMetronome(!engine.metronomeOn);
      metro.classList.toggle('active', engine.metronomeOn);
      updateUi((s) => (s.metronomeOn = engine.metronomeOn));
    };
    this.querySelector<HTMLButtonElement>('.play-all')!.onclick = async (): Promise<void> => {
      await engine.ensureStarted();
      bus.emit('transport:play', {});
    };
    this.querySelector<HTMLButtonElement>('.stop-all')!.onclick = (): void => {
      bus.emit('transport:stop', {});
      engine.stop();
    };
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
          return;
        }
        if (e.code === 'Space') {
          const target = e.target as HTMLElement;
          if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
            return;
          e.preventDefault();
          if (engine.playing) {
            bus.emit('transport:stop', {});
            engine.stop();
          } else {
            void engine.ensureStarted().then(() => bus.emit('transport:play', {}));
          }
        }
      },
      { capture: true },
    );

    const masterDialog = this.querySelector<HTMLDialogElement>('.master-dialog')!;
    this.querySelector<HTMLButtonElement>('.master-fx')!.onclick = async (): Promise<void> => {
      await engine.ensureStarted();
      this.ensureMasterChain();
      masterDialog.show();
    };
    this.querySelector<HTMLButtonElement>('.close-master')!.onclick = (): void => masterDialog.close();

    bus.on('tab:activate', (tab) => {
      this.activate(tab);
      updateUi((s) => (s.activeTab = tab));
    });
    bus.on('ui:loaded', () => {
      this.activate(uiState().activeTab);
      if (uiState().metronomeOn) {
        metro.classList.add('active');
        // clicking starts once the first gesture unlocks the audio context
        engine.whenReady(() => void engine.setMetronome(true));
      }
    });
    bus.on('project:loaded', () => {
      engine.bpm = store.data.bpm;
      bpm.value = String(store.data.bpm);
      this.updateProjectUi();
      void this.refreshProjects();
      if (this.masterChain) this.ensureMasterChain(true);
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
    name.textContent = projects.root
      ? projects.needsPermission
        ? `${projects.root.name} (permission needed)`
        : `${projects.root.name} / ${projects.activeName}`
      : 'no folder — changes saved in browser only';
  }
}

customElements.define('app-shell', AppShell);
