/**
 * Drag a non-modal, position:fixed dialog by a handle element (its header).
 * Clicks on buttons inside the handle (e.g. Close) are left alone. The first
 * move pins the dialog to explicit left/top px, overriding any centering
 * transform/margin from CSS; the handle is kept within the viewport.
 */
export function makeDialogDraggable(dialog: HTMLDialogElement, handle: HTMLElement): void {
  handle.style.cursor = 'move';
  handle.onpointerdown = (e): void => {
    if (e.target instanceof HTMLElement && e.target.closest('button')) return;
    e.preventDefault(); // don't start a text selection on the title
    const rect = dialog.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-released pointer — drag still works via bubbling moves */
    }
    handle.onpointermove = (m): void => {
      const x = Math.min(Math.max(m.clientX - offX, 80 - rect.width), window.innerWidth - 80);
      const y = Math.min(Math.max(m.clientY - offY, 0), window.innerHeight - 40);
      dialog.style.left = `${x}px`;
      dialog.style.top = `${y}px`;
      dialog.style.transform = 'none';
      dialog.style.margin = '0';
    };
    const end = (): void => {
      handle.onpointermove = null;
      handle.onpointerup = null;
      handle.onpointercancel = null;
    };
    handle.onpointerup = end;
    handle.onpointercancel = end;
  };
}
