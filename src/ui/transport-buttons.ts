/** Shared transport icons + button factory so play/stop/record look the same in every tab. */

export const PLAY_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
export const STOP_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>';
export const RECORD_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="6"/></svg>';

const ICONS = { play: PLAY_ICON, stop: STOP_ICON, record: RECORD_ICON } as const;

export type TransportKind = keyof typeof ICONS;

export function transportButton(kind: TransportKind, title: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `icon-btn transport-btn transport-${kind}`;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = ICONS[kind];
  b.onclick = fn;
  return b;
}
