# Import Project From URL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user import a WebDAW project from a remote `project.json` URL via a cloud icon in the header, auto-resolving its `_instruments`/`_tones` references, saved as a new local project.

**Architecture:** A new pure-logic module (`src/core/import-url.ts`) handles URL math (GitHub blob→raw rewriting, library-base derivation, candidate URLs, name-collision decisions) with no side effects, fully unit-tested. `project-manager.ts` gains `importFromUrl()`, which fetches, validates via the existing `normalizeProject()`, resolves instrument/tone refs over `fetch()`, and reuses a newly-extracted `commitProject()` helper (also used by the existing `createProject()`) to land the result. A new dialog module (`src/ui/import-dialog.ts`) follows the exact pattern of the existing `keymap-dialog.ts`. `app-shell.ts` gets one new icon button.

**Tech Stack:** TypeScript, vanilla Web Components, Vitest, native `fetch`, File System Access API, IndexedDB (via existing `src/core/persistence.ts`).

## Global Constraints

- Strict TS build: `npm run build` runs `tsc --noEmit` with `noUnusedLocals`/`noUnusedParameters` on — no unused imports/params.
- Tone import rule: never import from `'tone'` directly (not touched by this feature, no Tone.js usage needed here).
- Anything touching `fetch()` or `FileSystemDirectoryHandle` cannot run under Vitest — isolate pure logic into testable helpers; verify the rest manually in the browser.
- No new CSS needed — `dialog`, `.toolbar`, `.hint`, `.warn`, `.hidden`, `.icon-btn` all already exist in `src/style.css` and cover every UI need here.
- New persisted IndexedDB key: `importUrl` (plain string), via the existing `idbGet`/`idbSet` from `src/core/persistence.ts`.
- Follow existing patterns exactly: `keymap-dialog.ts` for the dialog shape, `importInstrument()`/`loadInstrument()` in `project-manager.ts` for instrument-library conventions.

---

### Task 1: Pure URL helpers (`import-url.ts`)

**Files:**
- Create: `src/core/import-url.ts`
- Test: `src/core/import-url.test.ts`

**Interfaces:**
- Produces (consumed by Task 3):
  - `IMPORT_URL_STORAGE_KEY: string`
  - `DEFAULT_IMPORT_URL: string`
  - `normalizeProjectUrl(url: string): string`
  - `deriveLibraryBase(projectUrl: string): string`
  - `candidateInstrumentDefUrls(libraryBase: string, name: string): string[]`
  - `instrumentAssetUrl(libraryBase: string, name: string, filename: string): string`
  - `toneUrl(libraryBase: string, id: string): string`
  - `fallbackNameFromUrl(url: string): string`
  - `nameCollisionAction(name: string, existing: string[]): 'use' | 'ask-overwrite'`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/core/import-url.test.ts
import { describe, expect, it } from 'vitest';
import {
  candidateInstrumentDefUrls,
  DEFAULT_IMPORT_URL,
  deriveLibraryBase,
  fallbackNameFromUrl,
  instrumentAssetUrl,
  nameCollisionAction,
  normalizeProjectUrl,
  toneUrl,
} from './import-url';

describe('normalizeProjectUrl', () => {
  it('rewrites a GitHub blob URL to raw.githubusercontent.com', () => {
    expect(normalizeProjectUrl('https://github.com/cawoodm/webdaw/blob/main/projects/_instruments/piano/piano.json')).toBe(
      'https://raw.githubusercontent.com/cawoodm/webdaw/main/projects/_instruments/piano/piano.json',
    );
  });

  it('leaves a raw.githubusercontent.com URL untouched', () => {
    expect(normalizeProjectUrl(DEFAULT_IMPORT_URL)).toBe(DEFAULT_IMPORT_URL);
  });

  it('leaves an unrelated URL untouched', () => {
    expect(normalizeProjectUrl('https://example.com/project.json')).toBe('https://example.com/project.json');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeProjectUrl('  https://example.com/project.json  ')).toBe('https://example.com/project.json');
  });
});

describe('deriveLibraryBase', () => {
  it('drops the project.json filename and its parent project directory', () => {
    expect(deriveLibraryBase(DEFAULT_IMPORT_URL)).toBe(
      'https://raw.githubusercontent.com/cawoodm/webdaw/refs/heads/main/projects/',
    );
  });
});

describe('candidateInstrumentDefUrls', () => {
  it('tries .inst.json then .json, URL-encoding the name', () => {
    expect(candidateInstrumentDefUrls('https://example.com/projects/', 'piano')).toEqual([
      'https://example.com/projects/_instruments/piano/piano.inst.json',
      'https://example.com/projects/_instruments/piano/piano.json',
    ]);
  });

  it('URL-encodes names with spaces', () => {
    expect(candidateInstrumentDefUrls('https://example.com/projects/', 'mellow keys')).toEqual([
      'https://example.com/projects/_instruments/mellow%20keys/mellow%20keys.inst.json',
      'https://example.com/projects/_instruments/mellow%20keys/mellow%20keys.json',
    ]);
  });
});

describe('instrumentAssetUrl', () => {
  it('builds a sample-file URL inside the instrument folder', () => {
    expect(instrumentAssetUrl('https://example.com/projects/', 'piano', 'A0.ogg')).toBe(
      'https://example.com/projects/_instruments/piano/A0.ogg',
    );
  });
});

describe('toneUrl', () => {
  it('assumes filename equals the tone id', () => {
    expect(toneUrl('https://example.com/projects/', 'f2f3f3a1b2c3d4e5')).toBe(
      'https://example.com/projects/_tones/f2f3f3a1b2c3d4e5.tone.json',
    );
  });
});

describe('fallbackNameFromUrl', () => {
  it('uses the URL-decoded project directory segment', () => {
    expect(fallbackNameFromUrl(DEFAULT_IMPORT_URL)).toBe('demo 1');
  });
});

describe('nameCollisionAction', () => {
  it('allows straight through when no name matches (case-insensitive)', () => {
    expect(nameCollisionAction('Demo 1', ['Other Song'])).toBe('use');
  });

  it('flags a collision regardless of case', () => {
    expect(nameCollisionAction('demo 1', ['Demo 1'])).toBe('ask-overwrite');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/import-url.test.ts`
Expected: FAIL — `Cannot find module './import-url'` (file doesn't exist yet).

- [ ] **Step 3: Implement the pure helpers**

```typescript
// src/core/import-url.ts

/** IndexedDB key remembering the last-used (or last-attempted) import URL. */
export const IMPORT_URL_STORAGE_KEY = 'importUrl';

export const DEFAULT_IMPORT_URL =
  'https://raw.githubusercontent.com/cawoodm/webdaw/refs/heads/main/projects/demo%201/project.json';

const BLOB_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/;

/** Rewrite a GitHub "blob" UI URL to its raw.githubusercontent.com equivalent; any other URL passes through unchanged. */
export function normalizeProjectUrl(url: string): string {
  const trimmed = url.trim();
  const m = BLOB_URL_RE.exec(trimmed);
  if (!m) return trimmed;
  const [, owner, repo, ref, path] = m;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
}

/** The "projects root" a project.json lives under — its own directory's parent — where `_instruments`/`_tones` live as siblings of every project directory. */
export function deriveLibraryBase(projectUrl: string): string {
  const url = new URL(projectUrl);
  const segments = url.pathname.split('/');
  segments.pop(); // filename, e.g. project.json
  segments.pop(); // the project's own directory
  url.pathname = `${segments.join('/')}/`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Both known `<name>.inst.json` / `<name>.json` naming conventions seen in the real instrument library, in try-order. */
export function candidateInstrumentDefUrls(libraryBase: string, name: string): string[] {
  const enc = encodeURIComponent(name);
  return [`${libraryBase}_instruments/${enc}/${enc}.inst.json`, `${libraryBase}_instruments/${enc}/${enc}.json`];
}

/** A sample file inside a resolved instrument's own folder. */
export function instrumentAssetUrl(libraryBase: string, name: string, filename: string): string {
  return `${libraryBase}_instruments/${encodeURIComponent(name)}/${encodeURIComponent(filename)}`;
}

/** A `_tones` library entry, assuming (as the real repo does) the filename equals the tone id. */
export function toneUrl(libraryBase: string, id: string): string {
  return `${libraryBase}_tones/${encodeURIComponent(id)}.tone.json`;
}

/** Fallback project name when the fetched JSON has no usable `name` field: the URL's own project-directory segment. */
export function fallbackNameFromUrl(url: string): string {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  const dir = segments[segments.length - 2] ?? 'Imported';
  return decodeURIComponent(dir);
}

/** Whether an import should proceed straight through or ask the user to overwrite/rename (case-insensitive match). */
export function nameCollisionAction(name: string, existing: string[]): 'use' | 'ask-overwrite' {
  const lower = new Set(existing.map((n) => n.toLowerCase()));
  return lower.has(name.toLowerCase()) ? 'ask-overwrite' : 'use';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/import-url.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/import-url.ts src/core/import-url.test.ts
git commit -m "Add pure URL helpers for importing a project from a remote URL"
```

---

### Task 2: Extract `commitProject` in `project-manager.ts`

Refactor-only task: pull the shared "switch to this project's data and flush it" tail out of `createProject()` into a private helper, with no behavior change. This lets Task 3 reuse it instead of duplicating five lines of state-machine code.

**Files:**
- Modify: `src/core/project-manager.ts:311-336` (the `createProject` method)

**Interfaces:**
- Consumes: existing `store.setDir`, `store.resetTo`, `applyUiState`, `idbSet`, `bus.emit`, `engine.stop`, `this.saveAll()`, `this.projectDir()` — all already present in the file.
- Produces (consumed by Task 3): `private async commitProject(name: string, data: ProjectData): Promise<void>`

- [ ] **Step 1: Add the helper and call it from `createProject`**

Replace the body of `createProject` (currently `src/core/project-manager.ts:312-336`):

```typescript
  /** Create a new empty project and switch to it. Returns false on invalid/duplicate name. */
  async createProject(rawName: string): Promise<boolean> {
    const name = sanitizeProjectName(rawName);
    if (!name) {
      alert('Invalid project name.');
      return false;
    }
    const existing = (await this.listProjects()).map((n) => n.toLowerCase());
    if (existing.includes(name.toLowerCase())) {
      alert(`A project named "${name}" already exists.`);
      return false;
    }
    const data = defaultProject();
    data.name = name;
    await this.commitProject(name, data);
    return true;
  }

  /**
   * Switch the active project to `name`/`data`: flush whatever's currently
   * active, swap in the new data, and flush again so the new project is
   * portable from birth. Shared by createProject() and importFromUrl().
   */
  private async commitProject(name: string, data: ProjectData): Promise<void> {
    await this.saveAll();
    engine.stop();
    this.activeName = name;
    store.setDir(await this.projectDir(name, true));
    store.resetTo(data);
    applyUiState();
    await idbSet(ACTIVE_KEY, name);
    await this.saveAll(); // the new dir is valid/portable from birth
    bus.emit('ui:loaded');
    bus.emit('project:loaded');
  }
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: succeeds with no TypeScript errors (this is a pure refactor — `applyUiState` and `engine` are already imported in this file).

- [ ] **Step 3: Manual regression check**

Run: `npm run dev`, open the app, use the project dropdown's "- new project -" option to create a project with a fresh name. Confirm it's created, becomes active, and the header's project name updates — identical to pre-refactor behavior.

- [ ] **Step 4: Commit**

```bash
git add src/core/project-manager.ts
git commit -m "Extract commitProject helper from createProject for reuse by URL import"
```

---

### Task 3: `importFromUrl` + instrument/tone resolution

**Files:**
- Modify: `src/core/project-manager.ts`

**Interfaces:**
- Consumes:
  - From Task 1 (`./import-url`): `IMPORT_URL_STORAGE_KEY`, `normalizeProjectUrl`, `deriveLibraryBase`, `candidateInstrumentDefUrls`, `instrumentAssetUrl`, `toneUrl`, `fallbackNameFromUrl`, `nameCollisionAction`.
  - From Task 2: `private commitProject(name: string, data: ProjectData): Promise<void>`.
  - Already in file: `sanitizeProjectName`, `defaultProject`, `normalizeProject`, `type ProjectData`, `type TonePatch`, `idbSet`, `instrumentCache`, `isFileRef`, `parseInstrumentDef`, `type InstrumentDef`, `store.decodeExternal`, `this.projectDir(name, create)`.
- Produces (consumed by Task 4): `async importFromUrl(rawUrl: string): Promise<{ ok: true; warnings: string[] } | { ok: false; error: string }>` on `projects` (the exported `ProjectManager` singleton).

- [ ] **Step 1: Add the import-url import**

At the top of `src/core/project-manager.ts`, add:

```typescript
import {
  candidateInstrumentDefUrls,
  deriveLibraryBase,
  fallbackNameFromUrl,
  IMPORT_URL_STORAGE_KEY,
  instrumentAssetUrl,
  nameCollisionAction,
  normalizeProjectUrl,
  toneUrl,
} from './import-url';
```

- [ ] **Step 2: Add `importFromUrl` and its private helpers**

Add these methods to the `ProjectManager` class (after `createProject`/`commitProject`):

```typescript
  /**
   * Fetch a project.json from a URL, resolve its `_instruments`/`_tones`
   * references from the sibling library, and land it as a new project.
   */
  async importFromUrl(rawUrl: string): Promise<{ ok: true; warnings: string[] } | { ok: false; error: string }> {
    const url = normalizeProjectUrl(rawUrl);
    await idbSet(IMPORT_URL_STORAGE_KEY, rawUrl);

    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      return { ok: false, error: 'Network error fetching that URL.' };
    }
    if (!res.ok) return { ok: false, error: `Fetch failed: ${res.status} ${res.statusText}` };

    let parsed: unknown;
    try {
      parsed = JSON.parse(await res.text());
    } catch {
      return { ok: false, error: 'That URL did not return valid JSON.' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, error: 'Not a valid project.json.' };
    }
    const raw = parsed as Partial<ProjectData>;

    let name = sanitizeProjectName(raw.name ?? '') ?? sanitizeProjectName(fallbackNameFromUrl(url)) ?? 'Imported';
    const existing = await this.listProjects();
    if (nameCollisionAction(name, existing) === 'ask-overwrite') {
      const overwrite = confirm(`A project named "${name}" already exists. Overwrite?`);
      if (!overwrite) {
        const renamed = prompt('New project name', name);
        const sanitized = renamed ? sanitizeProjectName(renamed) : null;
        if (!sanitized) return { ok: false, error: 'Import cancelled.' };
        name = sanitized;
      }
    }

    const data: ProjectData = { ...defaultProject(), ...raw };
    data.name = name;
    const normalized = normalizeProject(data);

    const libraryBase = deriveLibraryBase(url);
    const warnings = await this.resolveImportedInstruments(normalized, libraryBase, name);

    await this.commitProject(name, normalized);
    return { ok: true, warnings };
  }

  /** Resolve every `{type:'instrument', name}` ref in `data.sequences`, caching + (if a folder is connected) saving each into the new project's own instruments/ library. Returns names/ids that couldn't be resolved. */
  private async resolveImportedInstruments(data: ProjectData, libraryBase: string, projectName: string): Promise<string[]> {
    const names = new Set<string>();
    for (const seq of data.sequences) {
      if (seq.instrument?.type === 'instrument') names.add(seq.instrument.name);
    }
    if (names.size === 0) return [];

    const warnings: string[] = [];
    const destDir = await this.projectDir(projectName, true); // null with no folder connected
    for (const name of names) {
      const fetched = await this.fetchInstrumentDef(libraryBase, name);
      if (!fetched) {
        warnings.push(name);
        continue;
      }
      const { def, rawText } = fetched;
      const envelope = { attack: def.envelope?.attack ?? 0, release: def.envelope?.release ?? 1 };

      if (def.type === 'audio') {
        const samples = new Map<string, ArrayBuffer>();
        for (const ref of new Set(Object.values(def.notes))) {
          if (!isFileRef(ref)) continue;
          try {
            const sampleRes = await fetch(instrumentAssetUrl(libraryBase, name, ref));
            if (!sampleRes.ok) throw new Error(String(sampleRes.status));
            samples.set(ref, await sampleRes.arrayBuffer());
          } catch (err) {
            console.warn(`[import] failed to fetch ${name}/${ref}`, err);
          }
        }
        const audio = new Map<string, AudioBuffer>();
        for (const [note, ref] of Object.entries(def.notes)) {
          const raw = samples.get(ref);
          if (!raw) continue;
          audio.set(note, await store.decodeExternal(raw));
        }
        instrumentCache.set(name, { name: def.name, type: 'audio', envelope, gain: def.gain ?? 1, audio });
        if (destDir) await this.writeImportedInstrument(destDir, name, rawText, samples);
      } else {
        const tones = new Map<string, TonePatch>();
        const missing: string[] = [];
        for (const [note, id] of Object.entries(def.notes)) {
          const patch = data.patches.find((p) => p.id === id) ?? (await this.fetchRemoteTone(libraryBase, id));
          if (!patch) {
            missing.push(id);
            warnings.push(`${name}: tone ${id}`);
            continue;
          }
          tones.set(note, patch);
        }
        instrumentCache.set(name, {
          name: def.name,
          type: 'tone',
          envelope,
          gain: def.gain ?? 1,
          tones,
          missingTones: missing.length > 0 ? missing : undefined,
        });
        if (destDir) await this.writeImportedInstrument(destDir, name, rawText, new Map());
      }
    }
    return warnings;
  }

  /** Try both known instrument-def filename conventions at `libraryBase`; returns the first that resolves and parses. */
  private async fetchInstrumentDef(libraryBase: string, name: string): Promise<{ def: InstrumentDef; rawText: string } | null> {
    for (const candidate of candidateInstrumentDefUrls(libraryBase, name)) {
      try {
        const res = await fetch(candidate);
        if (!res.ok) continue;
        const rawText = await res.text();
        const def = parseInstrumentDef(JSON.parse(rawText));
        if (def) return { def, rawText };
      } catch {
        continue;
      }
    }
    return null;
  }

  /** A `_tones/<id>.tone.json` lookup, by filename-equals-id convention (no directory listing is possible over a static file host). */
  private async fetchRemoteTone(libraryBase: string, id: string): Promise<TonePatch | null> {
    try {
      const res = await fetch(toneUrl(libraryBase, id));
      if (!res.ok) return null;
      const patch = JSON.parse(await res.text()) as TonePatch;
      return patch.id ? patch : null;
    } catch {
      return null;
    }
  }

  /** Write a resolved instrument's def + sample files into the new project's own instruments/ library, mirroring importInstrument()'s on-disk layout. */
  private async writeImportedInstrument(
    destDir: FileSystemDirectoryHandle,
    name: string,
    defRawText: string,
    samples: Map<string, ArrayBuffer>,
  ): Promise<void> {
    const instrumentsDir = await destDir.getDirectoryHandle('instruments', { create: true });
    const instrumentDir = await instrumentsDir.getDirectoryHandle(name, { create: true });
    const defFh = await instrumentDir.getFileHandle(`${name}.inst.json`, { create: true });
    const defWritable = await defFh.createWritable();
    await defWritable.write(defRawText);
    await defWritable.close();
    for (const [filename, raw] of samples) {
      const fh = await instrumentDir.getFileHandle(filename, { create: true });
      const writable = await fh.createWritable();
      await writable.write(raw);
      await writable.close();
    }
  }
```

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: succeeds with no TypeScript errors. Double-check no unused imports (`noUnusedLocals` is on) — every name imported from `./import-url` in Step 1 is used above.

- [ ] **Step 4: Commit**

```bash
git add src/core/project-manager.ts
git commit -m "Add importFromUrl: fetch, validate, and resolve instruments/tones for a remote project"
```

---

### Task 4: Import dialog (`import-dialog.ts`)

**Files:**
- Create: `src/ui/import-dialog.ts`

**Interfaces:**
- Consumes: `projects.importFromUrl` (Task 3), `idbGet` (`src/core/persistence.ts`), `IMPORT_URL_STORAGE_KEY` + `DEFAULT_IMPORT_URL` (Task 1, `../core/import-url`).
- Produces (consumed by Task 5): `export function openImportDialog(): void`

- [ ] **Step 1: Write the dialog module**

```typescript
// src/ui/import-dialog.ts
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
```

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/import-dialog.ts
git commit -m "Add import-from-URL dialog"
```

---

### Task 5: Wire the cloud icon into the header

**Files:**
- Modify: `src/shell/app-shell.ts:55-73` (the `.project-menu` block and its handler wiring)

**Interfaces:**
- Consumes: `openImportDialog` (Task 4, `../ui/import-dialog`).

- [ ] **Step 1: Add the import statement**

Near the top of `src/shell/app-shell.ts`, alongside the existing `openKeymapDialog` import:

```typescript
import { openImportDialog } from '../ui/import-dialog';
import { openKeymapDialog } from '../ui/keymap-dialog';
```

- [ ] **Step 2: Add the cloud icon button to the header markup**

In the `.project-menu` div (`src/shell/app-shell.ts:55-73`), add a new button right before the existing `.folder` button:

```html
          <button class="import-btn icon-btn" title="Import project from URL" aria-label="Import project from URL">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
              <path d="M7 18a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17.4 8.5 4.5 4.5 0 0 1 17 18H7z"/>
            </svg>
          </button>
          <button class="folder icon-btn" title="Pick the root folder that holds one subdirectory per project" aria-label="Pick root folder">
```

(Leave the rest of that button and everything after it unchanged.)

- [ ] **Step 3: Wire the click handler**

Next to the existing `.folder` handler in `connectedCallback` (`src/shell/app-shell.ts:214-216`):

```typescript
    this.querySelector<HTMLButtonElement>('.import-btn')!.onclick = (): void => openImportDialog();
    this.querySelector<HTMLButtonElement>('.folder')!.onclick = async (): Promise<void> => {
      await projects.chooseRoot();
    };
```

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/shell/app-shell.ts
git commit -m "Add cloud icon to the header for importing a project from a URL"
```

---

### Task 6: Manual browser verification

Nothing in this feature beyond Task 1's pure helpers can run under Vitest (network + File System Access API). Verify end-to-end against the real demo project.

- [ ] **Step 1: Run the full test suite and build**

Run: `npm test && npm run build`
Expected: all tests pass (including the new `import-url.test.ts`), build succeeds.

- [ ] **Step 2: Start the dev server**

Run: `npm run dev`
Open the printed local URL in Chrome.

- [ ] **Step 3: Import without a connected folder**

Click the new cloud icon. Confirm the URL field is prefilled with the demo URL. Click Import. Confirm:
- A new project named "Demo 1" (or whatever the fetched `name` field is) becomes active.
- The Sequence tab shows sequences using the "piano" and "mellow-keys" instruments; the piano ones play back samples (per-note `.ogg` decode via `store.decodeExternal`).
- Since `_tones` doesn't yet exist in the real repo, the "mellow-keys" instrument logs a `missingTones` warning to the console and the post-import `alert()` mentions it — expected given today's repo state, not a bug.
- The header still reads "no folder — changes saved in browser only" (no disk writes attempted).

- [ ] **Step 4: Import again to hit the name-collision path**

Click the cloud icon again, Import the same URL again. Confirm the browser's native confirm() dialog appears ("A project named ... already exists. Overwrite?"). Try both Cancel (should prompt for a new name) and OK (should overwrite in place).

- [ ] **Step 5: Import with a folder connected**

Click the folder icon, pick any empty local directory. Click the cloud icon, Import the demo URL as a fresh name. Confirm:
- A new subdirectory is created under the picked root, containing `project.json`, `ui.json`, `keymap.json`.
- An `instruments/piano/` subdirectory exists containing `piano.inst.json` and the fetched `.ogg` sample files.

- [ ] **Step 6: Try a bad URL**

Open the dialog, clear the field, type `https://example.com/does-not-exist.json`, click Import. Confirm the dialog stays open and shows an inline error (not a native alert, not a silent failure).

- [ ] **Step 7: Report results**

If everything in Steps 3–6 matches, the feature is done — no commit needed for this task (verification-only).

---

## Self-Review Notes

- **Spec coverage:** UI entry point (Task 5), URL normalization (Task 1), import flow incl. name collision (Task 3), instrument/tone resolution incl. both filename conventions and the tone-id-as-filename convention (Task 3), disk-vs-memory caching (Task 3's `destDir` branch), error handling for fetch/parse/collision/partial-failure (Task 3 + Task 4's inline error rendering), testing split between unit (Task 1) and manual (Task 6) — all covered.
- **Type consistency:** `importFromUrl`'s return type (`{ok:true; warnings:string[]} | {ok:false; error:string}`) is defined once in Task 3 and consumed identically in Task 4. `LoadedInstrument` fields (`name`, `type`, `envelope`, `gain`, `audio`/`tones`/`missingTones`) match `src/core/instruments.ts`'s existing interface exactly. `InstrumentDef`/`parseInstrumentDef`/`isFileRef` are reused unchanged from `src/core/instruments.ts`.
- **No placeholders:** every step has complete, runnable code.
