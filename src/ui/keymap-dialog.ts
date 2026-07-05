import { getKeyMap, resetKeyMap, setKeyMapping } from '../midi/keymap';

/** Modal for user-defined computer-keyboard note mapping. */
export function openKeymapDialog(): void {
  const existing = document.querySelector('dialog.keymap-dialog');
  existing?.remove();

  const dialog = document.createElement('dialog');
  dialog.className = 'keymap-dialog';

  const render = (): void => {
    const map = getKeyMap();
    const byNote = new Map<string, string>();
    for (const [code, note] of Object.entries(map)) byNote.set(note, code);
    const notes = [...byNote.keys()].sort(
      (a, b) => noteValue(a) - noteValue(b),
    );
    dialog.innerHTML = `<h3>Keyboard → note mapping</h3>
      <p class="hint">Click "Set", then press the key you want for that note.</p>`;
    const table = document.createElement('table');
    for (const note of notes) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${note}</td><td><code>${byNote.get(note)?.replace('Key', '') ?? ''}</code></td>`;
      const td = document.createElement('td');
      const setBtn = document.createElement('button');
      setBtn.textContent = 'Set';
      setBtn.onclick = (): void => {
        setBtn.textContent = 'Press a key…';
        const onKey = async (e: KeyboardEvent): Promise<void> => {
          e.preventDefault();
          e.stopPropagation();
          window.removeEventListener('keydown', onKey, true);
          await setKeyMapping(e.code, note);
          render();
        };
        window.addEventListener('keydown', onKey, true);
      };
      td.appendChild(setBtn);
      tr.appendChild(td);
      table.appendChild(tr);
    }
    dialog.appendChild(table);

    const footer = document.createElement('div');
    footer.className = 'toolbar';
    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset to default';
    resetBtn.onclick = async (): Promise<void> => {
      await resetKeyMap();
      render();
    };
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.onclick = (): void => dialog.close();
    footer.append(resetBtn, closeBtn);
    dialog.appendChild(footer);
  };

  render();
  document.body.appendChild(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

const NOTE_ORDER = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function noteValue(note: string): number {
  const octave = Number(note.slice(-1));
  const name = note.slice(0, -1);
  return octave * 12 + NOTE_ORDER.indexOf(name);
}
