import type { TabId } from './model';

/**
 * Transient UI state (selections, toggles) — part of a project: persisted
 * to the project's IndexedDB mirror and its ui.json on disk (both handled
 * by the persister the project manager registers), so a project folder
 * restores the exact UI on any machine.
 */
export interface UiState {
  activeTab: TabId;
  metronomeOn: boolean;
  tone: { patchId: string; live: boolean; loop: boolean };
  sample: { selectedPad: number; countIn: boolean; overdub: boolean; quantize: number; loopId: string };
  sequence: { seqId: string; quantize: number };
  arrange: { palette: string; openFx: string[] };
}

function defaults(): UiState {
  return {
    activeTab: 'tone',
    metronomeOn: false,
    tone: { patchId: '', live: false, loop: false },
    sample: { selectedPad: 0, countIn: false, overdub: false, quantize: 0.25, loopId: '' },
    sequence: { seqId: '', quantize: 0.25 },
    arrange: { palette: '', openFx: [] },
  };
}

let state: UiState = defaults();
let saveTimer: number | undefined;
let persister: (snapshot: UiState) => Promise<void> | void = () => {};

/** The project manager registers where UI state gets persisted. */
export function setUiStatePersister(fn: (snapshot: UiState) => Promise<void> | void): void {
  persister = fn;
}

/** Replace the in-memory UI state (project load); missing fields get defaults. */
export function applyUiState(stored?: Partial<UiState>): UiState {
  const d = defaults();
  state = stored
    ? {
        ...d,
        ...stored,
        tone: { ...d.tone, ...stored.tone },
        sample: { ...d.sample, ...stored.sample },
        sequence: { ...d.sequence, ...stored.sequence },
        arrange: { ...d.arrange, ...stored.arrange },
      }
    : d;
  return state;
}

export function uiState(): UiState {
  return state;
}

export function serializeUiState(): UiState {
  return JSON.parse(JSON.stringify(state)) as UiState;
}

/** Mutate UI state; persists debounced via the registered persister. */
export function updateUi(mutate: (s: UiState) => void): void {
  mutate(state);
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void persister(serializeUiState()), 300);
}

/** Cancel the debounce and persist immediately (manual save / project switch). */
export async function flushUiState(): Promise<void> {
  clearTimeout(saveTimer);
  await persister(serializeUiState());
}
