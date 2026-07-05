import { idbGet, idbSet } from '../core/persistence';

/** Map of KeyboardEvent.code -> note name. Piano-style default on QWERTY home row. */
export type KeyMap = Record<string, string>;

export const DEFAULT_KEYMAP: KeyMap = {
  KeyA: 'C4', KeyW: 'C#4', KeyS: 'D4', KeyE: 'D#4', KeyD: 'E4',
  KeyF: 'F4', KeyT: 'F#4', KeyG: 'G4', KeyY: 'G#4', KeyH: 'A4',
  KeyU: 'A#4', KeyJ: 'B4', KeyK: 'C5', KeyO: 'C#5', KeyL: 'D5',
};

const KEY = 'keymap';
let current: KeyMap = { ...DEFAULT_KEYMAP };

export async function loadKeyMap(): Promise<KeyMap> {
  const stored = await idbGet<KeyMap>(KEY);
  if (stored) current = stored;
  return current;
}

export function getKeyMap(): KeyMap {
  return current;
}

export async function setKeyMapping(code: string, note: string): Promise<void> {
  // one key per note
  for (const [k, n] of Object.entries(current)) {
    if (n === note && k !== code) delete current[k];
  }
  current[code] = note;
  await idbSet(KEY, current);
}

export async function resetKeyMap(): Promise<void> {
  current = { ...DEFAULT_KEYMAP };
  await idbSet(KEY, current);
}

export function noteForKey(code: string): string | undefined {
  return current[code];
}
