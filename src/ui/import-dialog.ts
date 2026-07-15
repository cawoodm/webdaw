import { DEFAULT_IMPORT_URL, IMPORT_URL_STORAGE_KEY } from '../core/import-url';
import { idbGet } from '../core/persistence';
import { projects } from '../core/project-manager';

/** Modal for importing a project from a remote project.json URL. */
export function openImportDialog(): void {
  const existing = document.querySelector('dialog.import-dialog');
  existing?.remove();

  const dialog = document.createElement('dialog');
  dialog.className = 'import-dialog';
  dialog.innerHTML = `
    <h3>Import project from URL</h3>
    <p class="hint">Paste a project.json URL (e.g. a GitHub link) to import it as a new project.</p>
    <input type="text" class="import-url" style="width: 100%">
    <p class="warn import-error hidden"></p>
    <div class="toolbar">
      <button class="import-confirm">Import</button>
      <button class="import-cancel">Cancel</button>
    </div>`;
  document.body.appendChild(dialog);

  const input = dialog.querySelector<HTMLInputElement>('.import-url')!;
  const errorEl = dialog.querySelector<HTMLElement>('.import-error')!;
  const confirmBtn = dialog.querySelector<HTMLButtonElement>('.import-confirm')!;

  void (async (): Promise<void> => {
    input.value = (await idbGet<string>(IMPORT_URL_STORAGE_KEY)) ?? DEFAULT_IMPORT_URL;
  })();

  dialog.querySelector<HTMLButtonElement>('.import-cancel')!.onclick = (): void => dialog.close();

  confirmBtn.onclick = async (): Promise<void> => {
    errorEl.classList.add('hidden');
    confirmBtn.disabled = true;
    try {
      const result = await projects.importFromUrl(input.value);
      if (!result.ok) {
        errorEl.textContent = result.error;
        errorEl.classList.remove('hidden');
        return;
      }
      dialog.close();
      if (result.warnings.length > 0) {
        alert(`Imported, but couldn't resolve: ${result.warnings.join(', ')}`);
      }
    } finally {
      confirmBtn.disabled = false;
    }
  };

  dialog.showModal();
}
