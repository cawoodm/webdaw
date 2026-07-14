/**
 * Standard dialog chrome: a thin accent-colored title bar, flush with the
 * dialog's top edge, holding a collapse (_) and a close (✕) button. Collapse
 * toggles the `collapsed` class on the dialog — CSS hides everything but the
 * bar. The bar doubles as the drag handle where the dialog is draggable.
 */
export function dialogTitlebar(title: string | HTMLElement, dialog: HTMLDialogElement): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'dialog-titlebar';
  const h = typeof title === 'string' ? document.createElement('h3') : title;
  if (typeof title === 'string') h.textContent = title;
  const btns = document.createElement('span');
  btns.className = 'dialog-titlebar-btns';
  const collapse = document.createElement('button');
  collapse.textContent = '_';
  collapse.title = 'Collapse/expand';
  collapse.onclick = (e): void => {
    e.stopPropagation();
    dialog.classList.toggle('collapsed');
  };
  const close = document.createElement('button');
  close.textContent = '✕';
  close.title = 'Close';
  close.onclick = (e): void => {
    e.stopPropagation();
    dialog.close();
  };
  btns.append(collapse, close);
  bar.append(h, btns);
  return bar;
}
