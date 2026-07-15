import { engine } from './audio-engine';
import { bus } from './event-bus';
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
import { clearInstrumentCache, instrumentCache, isFileRef, parseInstrumentDef, type InstrumentDef, type LoadedInstrument } from './instruments';
import { defaultProject, normalizeProject, type ProjectData, type TonePatch } from './model';
import { idbDel, idbGet, idbKeys, idbSet } from './persistence';
import { projectDataKey, projectNameFromKey, projectUiKey, sanitizeProjectName } from './project-names';
import { store } from './project-store';
import { applyUiState, flushUiState, setUiStatePersister, type UiState } from './ui-state';
import { applyKeyMap, getKeyMap, type KeyMap } from '../midi/keymap';

const ROOT_KEY = 'rootDir';
const ACTIVE_KEY = 'activeProject';
const DEFAULT_NAME = 'default';

/** True when `value` is absent (fine — normalizeProject fills defaults) or actually an array. */
function hasArrayShape(value: unknown): boolean {
  return value === undefined || Array.isArray(value);
}

/**
 * Owns the ROOT folder (one subdirectory per project) and the active
 * project's lifecycle: restore at boot, switch, create, and full flush
 * (Save / Ctrl+S). Each project directory is self-contained and portable:
 * project.json + ui.json + keymap.json + all WAVs. Everything is also
 * mirrored to IndexedDB so the app works with no folder connected.
 */
class ProjectManager {
  root: FileSystemDirectoryHandle | null = null;
  /** True when a stored root handle exists but needs a user gesture to re-grant. */
  needsPermission = false;
  activeName = DEFAULT_NAME;

  private saving: Promise<void> | null = null;
  private saveQueued = false;

  private dirAvailable(): boolean {
    return this.root !== null && !this.needsPermission;
  }

  /** Boot: migrate legacy keys, restore root handle, load the active project. */
  async restore(): Promise<void> {
    await this.migrateLegacy();
    const handle = await idbGet<FileSystemDirectoryHandle>(ROOT_KEY);
    if (handle) {
      this.root = handle;
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      this.needsPermission = perm !== 'granted';
      if (this.dirAvailable()) store.setRootDir(this.root);
      if (this.needsPermission) {
        alert(`Project folder "${handle.name}" is disconnected — the browser dropped access after a restart. You are working on the browser copy; files on disk (e.g. samples/) are invisible until you reconnect via the Reload button.`);
      }
    }
    this.activeName = (await idbGet<string>(ACTIVE_KEY)) ?? DEFAULT_NAME;
    store.setMirrorKey(() => projectDataKey(this.activeName));
    // Cross-tab sync: a save in one tab refreshes every other tab showing the
    // same project (unless that tab has its own unsaved edits — then last
    // writer still wins, as before).
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('webdaw-project-sync');
      store.setOnSaved(() => channel.postMessage({ name: this.activeName }));
      channel.onmessage = (e: MessageEvent<{ name: string }>): void => {
        if (e.data.name !== this.activeName || store.dirty) return;
        void this.refreshFromMirror();
      };
    }
    setUiStatePersister(async (snapshot) => {
      await idbSet(projectUiKey(this.activeName), snapshot);
      await store.writeJson('ui.json', snapshot);
    });
    await this.load(this.activeName);
  }

  /** Pick (or change) the root folder; the in-memory project is written into it. */
  async chooseRoot(): Promise<void> {
    this.root = await window.showDirectoryPicker({ id: 'webdaw-root', mode: 'readwrite' });
    this.needsPermission = false;
    await idbSet(ROOT_KEY, this.root);
    store.setRootDir(this.root);
    store.setDir(await this.projectDir(this.activeName, true));
    await this.saveAll();
    bus.emit('project:loaded');
  }

  /** Re-grant permission for the stored root handle (needs a user gesture). */
  async reconnect(): Promise<void> {
    if (!this.root) return;
    const perm = await this.root.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return;
    this.needsPermission = false;
    store.setRootDir(this.root);
    // The session so far ran on the IndexedDB mirror — keep it authoritative
    // and write it through to disk, exactly like connecting a fresh root.
    store.setDir(await this.projectDir(this.activeName, true));
    await this.saveAll();
    bus.emit('project:loaded');
  }

  /** Names of all projects: subdirectories of the root plus IndexedDB mirrors. */
  async listProjects(): Promise<string[]> {
    const names = new Set<string>([this.activeName]);
    if (this.dirAvailable()) {
      for await (const handle of this.root!.values()) {
        if (handle.kind === 'directory' && !handle.name.startsWith('.') && !handle.name.startsWith('_')) names.add(handle.name);
      }
    }
    for (const key of await idbKeys('project:')) {
      const name = projectNameFromKey(key);
      if (name) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  /** Instrument names from the global `_instruments` library and the active project's `instruments/` dir (project shadows global). */
  async listInstruments(): Promise<{ name: string; source: 'global' | 'project' }[]> {
    const bySource = new Map<string, 'global' | 'project'>();
    const globalDir = await this.instrumentsDir('global');
    if (globalDir) {
      for await (const handle of globalDir.values()) {
        if (handle.kind === 'directory') bySource.set(handle.name, 'global');
      }
    }
    const projectDir = await this.instrumentsDir('project');
    if (projectDir) {
      for await (const handle of projectDir.values()) {
        if (handle.kind === 'directory') bySource.set(handle.name, 'project');
      }
    }
    return [...bySource.entries()]
      .map(([name, source]) => ({ name, source }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Audio files in the active project's `samples/` dir and the global `_samples/` dir (project entries first, each alphabetical). */
  async listSamples(): Promise<{ path: string; source: 'project' | 'global' }[]> {
    if (!this.dirAvailable()) {
      console.warn('[samples] root folder not connected — samples/ scan skipped');
      return [];
    }
    const isAudio = (name: string): boolean => /\.(wav|mp3|ogg|flac|m4a|aiff)$/i.test(name);
    const scan = async (dir: FileSystemDirectoryHandle | null, prefix: string, source: 'project' | 'global'): Promise<{ path: string; source: 'project' | 'global' }[]> => {
      if (!dir) return [];
      const names: string[] = [];
      for await (const handle of dir.values()) {
        if (handle.kind === 'file' && isAudio(handle.name)) names.push(handle.name);
      }
      names.sort((a, b) => a.localeCompare(b));
      return names.map((name) => ({ path: `${prefix}${name}`, source }));
    };
    let projectSamples: FileSystemDirectoryHandle | null = null;
    try {
      const dir = await this.projectDir(this.activeName, false);
      projectSamples = dir ? await dir.getDirectoryHandle('samples') : null;
    } catch {
      projectSamples = null;
    }
    let globalSamples: FileSystemDirectoryHandle | null = null;
    try {
      globalSamples = await this.root!.getDirectoryHandle('_samples');
    } catch {
      globalSamples = null;
    }
    const project = await scan(projectSamples, 'samples/', 'project');
    const global = await scan(globalSamples, '_samples/', 'global');
    return [...project, ...global];
  }

  /** Resolve and cache a library instrument by name (project copy shadows a global one of the same name). */
  async loadInstrument(name: string): Promise<LoadedInstrument | null> {
    const cached = instrumentCache.get(name);
    if (cached) return cached;
    const folder = await this.instrumentFolder(name);
    if (!folder) return null;
    const def = await this.readInstrumentDef(folder, name);
    if (!def) return null;

    const loaded: LoadedInstrument = {
      name: def.name,
      type: def.type,
      envelope: { attack: def.envelope?.attack ?? 0, release: def.envelope?.release ?? 1 },
      gain: def.gain ?? 1,
    };
    if (def.type === 'audio') {
      const audio = new Map<string, AudioBuffer>();
      for (const [note, ref] of Object.entries(def.notes)) {
        if (!isFileRef(ref)) {
          console.warn(`[instruments] shared-sample refs aren't supported yet: ${name} ${note} -> ${ref}`);
          continue;
        }
        try {
          const fh = await folder.getFileHandle(ref);
          const raw = await (await fh.getFile()).arrayBuffer();
          audio.set(note, await store.decodeExternal(raw));
        } catch (err) {
          console.warn(`[instruments] failed to load ${name}/${ref}`, err);
        }
      }
      loaded.audio = audio;
    } else {
      const tones = new Map<string, TonePatch>();
      const missing: string[] = [];
      for (const [note, id] of Object.entries(def.notes)) {
        const patch = await this.findTone(id);
        if (!patch) {
          console.warn(`[instruments] tone id not found: ${name} ${note} -> ${id}`);
          if (!missing.includes(id)) missing.push(id);
          continue;
        }
        tones.set(note, patch);
      }
      loaded.tones = tones;
      if (missing.length > 0) loaded.missingTones = missing;
    }
    instrumentCache.set(name, loaded);
    return loaded;
  }

  /** Raw text of an instrument's `.inst.json` file, for export (preserves the original file verbatim). */
  async readInstrumentJson(name: string): Promise<string | null> {
    const folder = await this.instrumentFolder(name);
    if (!folder) return null;
    try {
      const fh = await folder.getFileHandle(`${name}.inst.json`);
      return await (await fh.getFile()).text();
    } catch {
      for await (const handle of folder.values()) {
        if (handle.kind !== 'file' || !handle.name.endsWith('.inst.json')) continue;
        try {
          const fh = handle as FileSystemFileHandle;
          return await (await fh.getFile()).text();
        } catch {
          continue;
        }
      }
      return null;
    }
  }

  /** Import a `.inst.json` file into the active project's `instruments/` library. */
  async importInstrument(jsonText: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
    let def: InstrumentDef | null;
    try {
      def = parseInstrumentDef(JSON.parse(jsonText));
    } catch {
      def = null;
    }
    if (!def) return { ok: false, error: 'not a valid .inst.json' };
    const dir = await this.projectDir(this.activeName, true);
    if (!dir) return { ok: false, error: 'no folder — pick a root folder first' };
    const safeName = def.name.replace(/[^\w -]+/g, '').trim();
    if (!safeName) return { ok: false, error: 'not a valid .inst.json' };
    const instrumentsDir = await dir.getDirectoryHandle('instruments', { create: true });
    const instrumentDir = await instrumentsDir.getDirectoryHandle(safeName, { create: true });
    const fh = await instrumentDir.getFileHandle(`${safeName}.inst.json`, { create: true });
    const writable = await fh.createWritable();
    await writable.write(jsonText);
    await writable.close();
    clearInstrumentCache();
    return { ok: true, name: safeName };
  }

  /** The `_instruments` (global) or active project's `instruments/` directory, if available. */
  private async instrumentsDir(scope: 'global' | 'project'): Promise<FileSystemDirectoryHandle | null> {
    if (!this.dirAvailable()) return null;
    try {
      if (scope === 'global') return await this.root!.getDirectoryHandle('_instruments');
      const dir = await this.projectDir(this.activeName, false);
      return dir ? await dir.getDirectoryHandle('instruments') : null;
    } catch {
      return null;
    }
  }

  /** An instrument's own folder — project copy first, else the global library. */
  private async instrumentFolder(name: string): Promise<FileSystemDirectoryHandle | null> {
    const project = await this.instrumentsDir('project');
    if (project) {
      try {
        return await project.getDirectoryHandle(name);
      } catch {
        /* fall through to global */
      }
    }
    const global = await this.instrumentsDir('global');
    if (!global) return null;
    try {
      return await global.getDirectoryHandle(name);
    } catch {
      return null;
    }
  }

  /** Read `<name>.inst.json`, falling back to scanning for any `*.inst.json` if the names differ. */
  private async readInstrumentDef(folder: FileSystemDirectoryHandle, name: string): Promise<InstrumentDef | null> {
    try {
      const fh = await folder.getFileHandle(`${name}.inst.json`);
      return parseInstrumentDef(JSON.parse(await (await fh.getFile()).text()));
    } catch {
      for await (const handle of folder.values()) {
        if (handle.kind !== 'file' || !handle.name.endsWith('.inst.json')) continue;
        try {
          const fh = handle as FileSystemFileHandle;
          return parseInstrumentDef(JSON.parse(await (await fh.getFile()).text()));
        } catch {
          continue;
        }
      }
      return null;
    }
  }

  /** Find a TonePatch by id: the active project's in-memory patches, then the global then project tone libraries. */
  private async findTone(id: string): Promise<TonePatch | null> {
    const local = store.data.patches.find((p) => p.id === id);
    if (local) return local;
    const globalTones = await this.toneDir('global');
    const fromGlobal = globalTones ? await this.searchToneDir(globalTones, id) : null;
    if (fromGlobal) return fromGlobal;
    const projectTones = await this.toneDir('project');
    return projectTones ? await this.searchToneDir(projectTones, id) : null;
  }

  /** The global `_tones` dir or the active project's `tones/` dir, if available. */
  private async toneDir(scope: 'global' | 'project'): Promise<FileSystemDirectoryHandle | null> {
    if (!this.dirAvailable()) return null;
    try {
      if (scope === 'global') return await this.root!.getDirectoryHandle('_tones');
      const dir = await this.projectDir(this.activeName, false);
      return dir ? await dir.getDirectoryHandle('tones') : null;
    } catch {
      return null;
    }
  }

  private async searchToneDir(dir: FileSystemDirectoryHandle, id: string): Promise<TonePatch | null> {
    for await (const handle of dir.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.tone.json')) continue;
      try {
        const fh = handle as FileSystemFileHandle;
        const patch = JSON.parse(await (await fh.getFile()).text()) as TonePatch;
        if (patch.id === id) return patch;
      } catch {
        continue;
      }
    }
    return null;
  }

  /** Switch to another project (flushes the current one first). */
  async open(name: string): Promise<void> {
    if (name === this.activeName) return;
    await this.saveAll();
    engine.stop();
    await this.load(name);
  }

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
    const finalUrl = res.url || url;

    try {
      if (!hasArrayShape(raw.patches) || !hasArrayShape(raw.pads) || !hasArrayShape(raw.sequences)) {
        return { ok: false, error: 'Not a valid project.json.' };
      }
      if (raw.arrangement !== undefined && (typeof raw.arrangement !== 'object' || raw.arrangement === null || Array.isArray(raw.arrangement))) {
        return { ok: false, error: 'Not a valid project.json.' };
      }

      let name = sanitizeProjectName(String(raw.name ?? '')) ?? sanitizeProjectName(fallbackNameFromUrl(finalUrl)) ?? 'Imported';
      const existing = await this.listProjects();
      while (nameCollisionAction(name, existing) === 'ask-overwrite') {
        const overwrite = confirm(`A project named "${name}" already exists. Overwrite?`);
        if (overwrite) break;
        const renamed = prompt('New project name', name);
        const sanitized = renamed ? sanitizeProjectName(renamed) : null;
        if (!sanitized) return { ok: false, error: 'Import cancelled.' };
        name = sanitized;
      }

      const data: ProjectData = { ...defaultProject(), ...raw };
      data.name = name;
      const normalized = normalizeProject(data);

      const libraryBase = deriveLibraryBase(finalUrl);
      const { warnings, instruments } = await this.resolveImportedInstruments(normalized, libraryBase, name);

      await this.commitProject(name, normalized);
      // Re-insert after commitProject: commitProject's project:loaded emit runs
      // sequence-tab's handler, which unconditionally clearInstrumentCache()s.
      for (const [instName, loaded] of instruments) instrumentCache.set(instName, loaded);
      return { ok: true, warnings };
    } catch {
      return { ok: false, error: 'Not a valid project.json.' };
    }
  }

  /** Resolve every `{type:'instrument', name}` ref in `data.sequences`, and (if a folder is connected) save each into the new project's own instruments/ library. Returns names/ids that couldn't be resolved plus the resolved instruments themselves (caller caches these after commitProject, since commitProject's project:loaded clears the cache). */
  private async resolveImportedInstruments(
    data: ProjectData,
    libraryBase: string,
    projectName: string,
  ): Promise<{ warnings: string[]; instruments: Map<string, LoadedInstrument> }> {
    const names = new Set<string>();
    for (const seq of data.sequences) {
      if (seq.instrument?.type === 'instrument') names.add(seq.instrument.name);
    }
    const instruments = new Map<string, LoadedInstrument>();
    if (names.size === 0) return { warnings: [], instruments };

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
          try {
            audio.set(note, await store.decodeExternal(raw));
          } catch (err) {
            console.warn(`[import] failed to decode ${name}/${ref}`, err);
            warnings.push(`${name}: failed to decode ${ref}`);
          }
        }
        instruments.set(name, { name: def.name, type: 'audio', envelope, gain: def.gain ?? 1, audio });
        if (destDir) {
          try {
            await this.writeImportedInstrument(destDir, name, rawText, samples);
          } catch (err) {
            console.warn(`[import] failed to save ${name} to disk`, err);
            warnings.push(`${name}: failed to save to disk`);
          }
        }
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
        instruments.set(name, {
          name: def.name,
          type: 'tone',
          envelope,
          gain: def.gain ?? 1,
          tones,
          missingTones: missing.length > 0 ? missing : undefined,
        });
        if (destDir) {
          try {
            await this.writeImportedInstrument(destDir, name, rawText, new Map());
          } catch (err) {
            console.warn(`[import] failed to save ${name} to disk`, err);
            warnings.push(`${name}: failed to save to disk`);
          }
        }
      }
    }
    return { warnings, instruments };
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

  /**
   * Full flush: tone WAVs, project.json, ui.json, keymap.json, pending
   * WAVs, and all IndexedDB mirrors. Single-flight — calls during a save
   * collapse into one trailing save.
   */
  saveAll(): Promise<void> {
    if (this.saving) {
      this.saveQueued = true;
      return this.saving;
    }
    this.saving = this.doSave().finally(() => {
      this.saving = null;
      if (this.saveQueued) {
        this.saveQueued = false;
        void this.saveAll();
      }
    });
    return this.saving;
  }

  private async doSave(): Promise<void> {
    await store.saveTones(); // before save() so updated wavFile refs persist
    await store.save();
    await flushUiState();
    await store.writeJson('keymap.json', getKeyMap());
    await store.flushPendingWavs();
  }

  private async projectDir(name: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
    if (!this.dirAvailable()) return null;
    try {
      return await this.root!.getDirectoryHandle(name, { create });
    } catch {
      return null;
    }
  }

  /** Re-read the active project's mirror after another tab saved it. */
  private async refreshFromMirror(): Promise<void> {
    const data = await idbGet<ProjectData>(projectDataKey(this.activeName));
    if (!data) return;
    const resolved: ProjectData = { ...defaultProject(), ...data };
    resolved.name = this.activeName;
    store.resetTo(normalizeProject(resolved));
    void store.preloadBuffers();
    bus.emit('ui:loaded');
    bus.emit('project:loaded');
  }

  /** Load a project (newer of folder copy and IndexedDB mirror, unless `preferDisk`) and notify the UI. */
  private async load(name: string, opts?: { preferDisk?: boolean }): Promise<void> {
    this.activeName = name;
    const dir = await this.projectDir(name, this.dirAvailable());
    store.setDir(dir);

    // Two copies can exist (folder + IndexedDB mirror); when both do, take
    // the newer one — a tab without folder permission saves only the mirror.
    // `preferDisk` (explicit reload) takes the folder copy whenever it exists,
    // even if the mirror looks newer.
    const diskData = dir ? await store.readJson<ProjectData>('project.json') : null;
    const mirrorData = (await idbGet<ProjectData>(projectDataKey(name))) ?? null;
    let data = diskData;
    if (opts?.preferDisk) {
      if (!diskData) data = mirrorData;
    } else if (mirrorData && (!diskData || (mirrorData.savedAt ?? 0) > (diskData.savedAt ?? 0))) {
      data = mirrorData;
    }
    const resolved: ProjectData = { ...defaultProject(), ...(data ?? {}) };
    resolved.name = name;
    store.resetTo(normalizeProject(resolved));
    if (opts?.preferDisk && diskData) await idbSet(projectDataKey(name), store.data);

    let ui = dir ? await store.readJson<Partial<UiState>>('ui.json') : null;
    ui ??= (await idbGet<Partial<UiState>>(projectUiKey(name))) ?? null;
    applyUiState(ui ?? undefined);

    const keymap = dir ? await store.readJson<KeyMap>('keymap.json') : null;
    if (keymap && Object.keys(keymap).length > 0) await applyKeyMap(keymap);

    await store.preloadBuffers();
    await idbSet(ACTIVE_KEY, name);
    // same order as boot always used — modules re-apply UI state, then render
    bus.emit('ui:loaded');
    bus.emit('project:loaded');
  }

  /** Discard in-memory and mirror state and re-read the active project from disk. */
  async reloadFromDisk(): Promise<void> {
    if (this.root && this.needsPermission) {
      const perm = await this.root.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        this.needsPermission = false;
        store.setRootDir(this.root);
      } else {
        alert('Folder access was denied — still working on the browser copy; disk files stay hidden.');
      }
    }
    engine.stop();
    await this.load(this.activeName, { preferDisk: true });
  }

  /** One-time move from the single-project keys to the per-project layout. */
  private async migrateLegacy(): Promise<void> {
    if ((await idbKeys('project:')).length > 0) return;
    const legacy = await idbGet<ProjectData>('projectData');
    if (!legacy) return;
    const name = sanitizeProjectName(legacy.name ?? '') ?? DEFAULT_NAME;
    await idbSet(projectDataKey(name), legacy);
    const ui = await idbGet<UiState>('uiState');
    if (ui) await idbSet(projectUiKey(name), ui);
    await idbSet(ACTIVE_KEY, name);
    await idbDel('projectData');
    await idbDel('uiState');
    await idbDel('projectDir');
  }
}

export const projects = new ProjectManager();
