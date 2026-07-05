import * as Tone from '../core/tone';
import { engine } from '../core/audio-engine';
import { bus } from '../core/event-bus';
import type { TabId } from '../core/model';
import { store } from '../core/project-store';
import { uiState, updateUi } from '../core/ui-state';
import type { PluginChainEl } from '../plugins/chain';
import { openKeymapDialog } from '../ui/keymap-dialog';

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
          <button class="stop-all">⏹ Stop</button>
        </div>
        <div class="project-menu">
          <button class="master-fx">Master FX</button>
          <button class="keys">Keys</button>
          <button class="reconnect hidden">Reconnect project</button>
          <button class="folder" title="Pick the folder where this project (project.json, tones/, samples/, exports/) is stored on disk">Project folder…</button>
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
    this.querySelector<HTMLButtonElement>('.stop-all')!.onclick = (): void => engine.stop();
    this.querySelector<HTMLButtonElement>('.keys')!.onclick = (): void => openKeymapDialog();
    this.querySelector<HTMLButtonElement>('.folder')!.onclick = async (): Promise<void> => {
      await store.chooseFolder();
    };
    this.querySelector<HTMLButtonElement>('.reconnect')!.onclick = async (): Promise<void> => {
      await store.reconnect();
    };

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
      if (this.masterChain) this.ensureMasterChain(true);
    });

    this.activate('tone');
    this.updateProjectUi();
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
    reconnect.classList.toggle('hidden', !store.needsPermission);
    name.textContent = store.dir
      ? store.needsPermission
        ? `${store.dir.name} (permission needed)`
        : store.dir.name
      : 'no folder — changes not saved';
  }
}

customElements.define('app-shell', AppShell);
