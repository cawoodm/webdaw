import type { TabId } from './model';
import { idbGet, idbSet } from './persistence';

/**
 * Transient UI state (selections, toggles) persisted to IndexedDB so a
 * page reload restores the session. Project content lives in project.json;
 * this is everything that is not project content.
 */
export interface UiState {
  activeTab: TabId;
  metronomeOn: boolean;
  tone: { patchId: string; live: boolean; loop: boolean };
  sample: { selectedPad: number };
  sequence: { seqId: string; trackId: string };
  arrange: { palette: string; openFx: string[] };
}

function defaults(): UiState {
  return {
    activeTab: 'tone',
    metronomeOn: false,
    tone: { patchId: '', live: false, loop: false },
    sample: { selectedPad: 0 },
    sequence: { seqId: '', trackId: '' },
    arrange: { palette: '', openFx: [] },
  };
}

const KEY = 'uiState';
let state: UiState = defaults();
let saveTimer: number | undefined;

export async function loadUiState(): Promise<UiState> {
  const stored = await idbGet<Partial<UiState>>(KEY);
  if (stored) {
    const d = defaults();
    state = {
      ...d,
      ...stored,
      tone: { ...d.tone, ...stored.tone },
      sample: { ...d.sample, ...stored.sample },
      sequence: { ...d.sequence, ...stored.sequence },
      arrange: { ...d.arrange, ...stored.arrange },
    };
  }
  return state;
}

export function uiState(): UiState {
  return state;
}

/** Mutate UI state; persists to IndexedDB debounced. */
export function updateUi(mutate: (s: UiState) => void): void {
  mutate(state);
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void idbSet(KEY, state), 300);
}
